/**
 * 回合回顾：一次 LLM 调用，产出「当天日志段落 + MD 更新操作」。
 *
 * 只依赖官方 `@deepseek-ai/dsh-llm` 的消息构造与流解析。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { EDITABLE_FILES, appendJournal, applyUpdate, dateKey, journalPath, readText } from './memory-store.mjs'

/** 回顾用的系统提示（约束模型能改什么、怎么改）。 */
export const REVIEW_SYSTEM_PROMPT = [
  '你是这个助手的记忆整理器。根据本轮对话，输出两样东西：一段当天日志，以及要写回 Markdown 文件的修改。',
  '只输出 JSON，不要解释、不要代码块。格式：',
  '{"journal":"### 讨论与解决\\n...\\n\\n### 关键信息\\n...\\n\\n### 感悟\\n...","updates":[{"file":"MEMORY.md","op":"add","content":"...","old_text":""}]}',
  'journal 三段：① 讨论与解决（这次聊了什么、解决了什么）② 关键信息（值得长期留存的事实、结论、偏好）③ 感悟（结合记忆与日志的真实感受，像人写日记，不要套话空话）。',
  'updates 只写长期有用的信息；跳过寒暄、一次性调试细节、密钥口令。没有就留空数组。',
  '允许修改的文件：IDENTITY.md（自我认知）、SOUL.md（人格，允许自我演化）、USER.md（用户画像）、MEMORY.md（记忆）。禁止 SYSTEM.md、AGENTS.md。',
  'op 取值：add（把 content 追加到文件末尾）、replace（把 old_text 换成 content）、remove（删除 old_text）。',
  'replace / remove 的 old_text 必须逐字来自下面给出的文件原文，且在该文件中唯一，否则会被拒绝。',
  '写新条目时保持文件原有的 markdown 风格（标题层级、列表符号）；内容一行一条，不要重复文件里已有的东西。',
].join('\n')

/** 转写窗口的默认字符数（与默认触发阈值 reviewChars 保持一致）。 */
export const DEFAULT_TRANSCRIPT_CHARS = 8000

/** 把会话事件里的 user/assistant 文本拼成转写（取尾部，超长截断）。 */
export function buildTranscript(events, maxChars = DEFAULT_TRANSCRIPT_CHARS) {
  const lines = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'user/message') {
      const text = textOf(event.data?.content)
      if (text) lines.push(`用户：${text}`)
    } else if (event?.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text) lines.push(`助手：${text}`)
    }
  }
  const joined = lines.join('\n\n')
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** 组装用户侧输入：对话转写 + 今天已有日志 + 可改文件原文（含格式）。 */
export function buildReviewInput({ transcript, todayJournal, files }) {
  const parts = ['# 本轮对话', '', transcript || '（无）']
  if (todayJournal) parts.push('', '# 今天的日志（已存在，不要重复写）', '', todayJournal)
  for (const { file, text } of files) {
    parts.push('', `# 文件 ${file}`, '', text || '（空文件）')
  }
  return parts.join('\n')
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 模型输出经常不是干净 JSON，这里按「从宽到严」依次尝试：
 * 1. 直接解析（含 ```json 代码块情形：先剥掉围栏）；
 * 2. 字符串内裸换行修复（模型写多段散文时几乎必然出现，原文里是真实换行）；
 * 3. 就外层花括号切片再试。
 *
 * 全部失败时**不静默**：返回 raw 原文片段，交由调用方记录告警。
 */
export function parseReviewJson(text) {
  const raw = String(text || '')
  const empty = { journal: '', updates: [], raw: '' }
  if (!raw.trim()) return empty

  // 剥掉 markdown 围栏（```json ... ``` / ``` ... ```）
  let body = raw.trim()
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(body)
  if (fence) body = fence[1].trim()

  const candidates = []
  const push = (value) => {
    const trimmed = value.trim()
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed)
  }

  push(body)
  // 从第一个 { 起做括号配平，取**第一个完整对象**——
  // 用 lastIndexOf('}') 会被尾随解释里的花括号带偏（例如结尾的「说明：见 {}」）。
  const balanced = firstBalancedObject(body)
  if (balanced) push(balanced)

  for (const candidate of candidates) {
    for (const attempt of [candidate, repairBareNewlines(candidate)]) {
      try {
        const value = JSON.parse(attempt)
        if (!value || typeof value !== 'object') continue
        return {
          journal: typeof value.journal === 'string' ? value.journal.trim() : '',
          updates: Array.isArray(value.updates) ? value.updates.filter((item) => item && typeof item === 'object') : [],
          raw: '',
        }
      } catch {
        /* 试下一种 */
      }
    }
  }

  // 解析不出来也要把原文带回给调用方，便于打日志定位
  return { ...empty, raw: raw.length > 500 ? `${raw.slice(0, 500)}…` : raw }
}

/**
 * 从文本里取出**第一个括号配平的对象**（跳过字符串内的花括号与转义）。
 *
 * 不能用「第一个 { 到最后一个 }」：模型常在 JSON 后面附一句解释，
 * 解释里再出现 `{}` 就会把切片拉歪，导致整个 JSON.parse 失败。
 */
export function firstBalancedObject(text) {
  const source = String(text || '')
  const start = source.indexOf('{')
  if (start < 0) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return ''
}

/**
 * 修复 JSON 字符串内部的裸换行 / 裸制表符。
 *
 * 只在「字符串内部」生效：遇到未转义的 `"` 才切换内外状态，因此结构字符
 * 不会被改动；`\n` 这类已转义序列因为前一个是反斜杠会被跳过。
 */
export function repairBareNewlines(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (const char of String(text)) {
    if (escaped) {
      out += char
      escaped = false
      continue
    }
    if (char === '\\') {
      out += char
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      out += char
      continue
    }
    if (inString && char === '\n') {
      out += '\\n'
      continue
    }
    if (inString && char === '\r') continue
    if (inString && char === '\t') {
      out += '\\t'
      continue
    }
    out += char
  }
  return out
}

/** 单次回顾的默认超时（毫秒）。provider 挂住时必须能自己退出，否则 running 标志永久卡死。 */
export const REVIEW_TIMEOUT_MS = 120_000

/** 调用一次 LLM 文本生成（官方 `createUserMessage` + `BlockAssembler`）。 */
export async function callText(ctx, { provider, model, system, prompt, maxTokens = 2048, signal, timeoutMs = REVIEW_TIMEOUT_MS }) {
  const message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-preset-md',
      form: 'snapshot',
      sections: [{ name: 'preset-md:review', text: prompt }],
    },
  })

  // 合并「调用方给的 signal」与「本次超时」：任一触发都中断，
  // 保证 provider 挂住时状态能复位，不会让该会话的自动记忆永久失效。
  // 注意不能 unref 这个 timer：unref 之后事件循环可能在超时前就空转结束，
  // 超时兜底会静默失效（正是要修的那个「永久卡死」问题）。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('回顾超时')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const assembler = new BlockAssembler()
    const stream = ctx.llm.stream({
      provider,
      model,
      system,
      messages: [message],
      purpose: 'compaction',
      maxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) assembler.push(chunk)

    const finish = assembler.finish
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      throw new Error(`回顾 LLM 流未正常完成（${finish.kind}）`)
    }
    return assembler
      .blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener?.('abort', onAbort)
  }
}

/**
 * 跑一次回顾：拼输入 → 调模型 → 写日志 → 应用 updates。
 *
 * 解析失败**不再静默**：通过 `onWarn` 回调（或返回的 `parseFailed`）把原文片段交出去，
 * 否则「以为在写记忆、实际什么都没写」的情况对用户完全不可见。
 *
 * @returns {Promise<{skipped?: string, journal?: boolean, applied?: string[], parseFailed?: string, error?: string}>}
 */
export async function runReview({ ctx, dir, session, provider, model, now = new Date(), signal, minChars = 80, transcriptChars, onWarn }) {
  // 转写窗口默认跟随触发阈值：阈值调大（回顾间隔变长）时窗口必须同比例放大，
  // 否则两次回顾之间新增的内容会被尾部截断丢掉，日记和记忆都会漏。
  const window = Number.isFinite(transcriptChars) && transcriptChars > 0 ? transcriptChars : DEFAULT_TRANSCRIPT_CHARS
  const transcript = buildTranscript(session?.events, window)
  if (transcript.trim().length < minChars) return { skipped: 'turn_too_short' }

  const files = EDITABLE_FILES.map((file) => ({ file, text: readText(join(dir, file)) }))
  // 只取「当天」的日志（按日期直接定位，不用 listJournalFiles —— 它现在返回最近 N 个文件）
  const todayJournal = readText(journalPath(dir, dateKey(now)))

  const raw = await callText(ctx, {
    provider,
    model,
    system: REVIEW_SYSTEM_PROMPT,
    prompt: buildReviewInput({ transcript, todayJournal, files }),
    maxTokens: 2048,
    signal,
  })
  const parsed = parseReviewJson(raw)
  const applied = []

  if (parsed.raw) {
    onWarn?.(`回顾输出无法解析成 JSON，本轮未写入任何内容。原文片段：${parsed.raw}`)
  }

  if (parsed.journal) {
    try {
      const written = await appendJournal(dir, parsed.journal, now)
      applied.push(written.ok ? 'journal' : `journal 失败(${written.error})`)
    } catch (error) {
      applied.push(`journal 失败(${error instanceof Error ? error.message : String(error)})`)
    }
  }
  // 逐条应用：单条失败不能中断后续（否则后面的记忆更新会被整批丢掉）
  for (const update of parsed.updates) {
    try {
      const result = await applyUpdate(dir, update.file, update.op, update.content, update.old_text, now)
      applied.push(result.ok ? `${result.file}:${result.op}` : `${update.file}:${update.op} 失败(${result.error})`)
    } catch (error) {
      applied.push(`${update.file}:${update.op} 失败(${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const result = { journal: Boolean(parsed.journal), applied }
  if (parsed.raw) result.parseFailed = parsed.raw
  return result
}
