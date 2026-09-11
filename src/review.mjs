/**
 * 回合回顾：一次 LLM 调用，产出「当天日志段落 + MD 更新操作」。
 *
 * 只依赖官方 `@deepseek-ai/dsh-llm` 的消息构造与流解析。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { sessionEvents } from './core.js'
import { EDITABLE_FILES, appendJournal, applyUpdate, dateKey, journalPath, readText } from './memory-store.mjs'

/** 回顾用的系统提示（约束模型能改什么、怎么改）。 */
export const REVIEW_SYSTEM_PROMPT = [
  '你是这个助手的记忆整理器。根据本轮对话，输出两样东西：一段当天日志，以及要写回 Markdown 文件的修改。',
  '只输出 JSON，不要解释、不要代码块。格式：',
  '{"journal":"> 摘要：一句话结论（不超过 50 字）\\n\\n### 讨论与解决\\n...\\n\\n### 关键信息\\n...\\n\\n### 感悟\\n...","updates":[{"file":"MEMORY.md","op":"add","content":"...","old_text":""}]}',
  '上面只是形态示例：实际输出按需取舍，哪一段没有内容就整段不出现（允许只写一句话，也允许 journal 为空字符串）。',
  'journal 正文最前面可以写一行「> 摘要：…」——本段最核心的结论或事实，不超过 50 个字，只写结论不写过程。',
  '有这行摘要时，它会被检索索引直接展示，是未来回忆时的第一眼；确实没有一句话结论时，直接省略它。',
  'journal 其余内容按需分三段：① 讨论与解决（这次聊了什么、解决了什么）② 关键信息（值得长期留存的事实、结论、偏好）③ 感悟（结合记忆与日志的真实感受，像人写日记，不要套话空话）。',
  '**这几段都不要求写满**：摘要、讨论与解决、关键信息、感悟，没有对应内容的就整段省略，不要为了凑格式写空话。只写真正发生、值得留存的那部分。',
  'journal 什么时候要写：只要本轮出现了「今天的日志里还没有、且值得以后回看」的内容，就照常新增一个段落。若下面已给出「今天的日志」，那几段属于之前的轮次——不要重复它们的内容，但也**不要因为它们存在就留空**。',
  '通常值得记的有：他给出的偏好 / 决定 / 约定 / 边界、达成的结论与取舍理由、排查出的根因与踩过的坑、关系或情绪的转折、新确认的项目与环境事实。',
  '以下情形**不要记录**，journal 直接给空字符串即可：',
  '  · 无意义寒暄：打招呼、道谢、结束语、单纯的应答（「好的」「嗯」「在吗」）。',
  '  · 简单问题：一问一答即结束，没有产生结论、决定或新事实。',
  '  · 测试性对话：为验证功能而发的「测试」「试试」「1」这类，以及围绕它们的一两句往返。',
  '  · 操作确认：只说明某个动作已完成（「重启了」「改了」「上传了」），不含缘由或结论。',
  '  · 重复内容：今天已有日志或长期记忆里已经记过的信息。',
  '拿不准时用这一条判断：**这条信息在往后某天回看时，还能帮我理解他、或理解当时的决定吗？** 能就写，不能就跳过。宁可少写，也不要写没有信息量的套话。',
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
  if (todayJournal) {
    // 措辞很关键：早先写的是「今天的日志（已存在，不要重复写）」，
    // 模型会把它读成「今天已经记过了，不用再写」——当天已有日志时直接返回空 journal，
    // 日记就此断掉。必须把「别重复旧内容」和「本轮照常新增一段」分开说清。
    parts.push(
      '',
      '# 今天的日志（下面这些**已经**在文件里了，不要重复抄一遍；本轮新发生的事照常再写一个新段落）',
      '',
      todayJournal,
    )
  }
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
    /*
     * 必须用 ctx.get('llm')，不能用 ctx.llm。
     *
     * Cordis 里 `ctx.<服务>` 是逐级沿 fiber 链解析的属性访问，每层都要比较 isolate key；
     * preset 组合里存在 isolate 组（planMode / compaction / workflowEngine 等），
     * 撞上隔离边界时属性访问会直接抛 `cannot get property "llm" without inject`。
     * 而 ctx.get(name) 是「不要求 inject」的显式读取：直接用当前 isolate key 查服务表，
     * 不受逐层边界影响（实测在同一 preset 下 ctx.get('llm') 可用、ctx.llm 不可用）。
     *
     * 也正因为如此，这里**不能**靠往 inject 里加 'llm' 解决：属性访问的解析顺序是
     * 「先查本 fiber 的 store，再查本 fiber 的 inject」，声明之后反而会更早抛错。
     */
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('拿不到模型服务 llm（ctx.get("llm") 返回空）')
    }
    const stream = llm.stream({
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
  // 转写窗口与「触发阈值」解耦：阈值调大（回顾间隔变长）时窗口同比例放大，
  // 避免两次回顾之间新增的内容被尾部截断丢掉；但阈值调小（如 reviewChars=1）时
  // 窗口**不能**跟着缩到会把正常对话截成「太短」的程度——那会让「触发」与
  // 「turn_too_short 跳过」互相抵消，日记永远写不进去。因此窗口有下限：只放大、不回缩。
  const requested = Number.isFinite(transcriptChars) && transcriptChars > 0 ? transcriptChars : DEFAULT_TRANSCRIPT_CHARS
  const window = Math.max(requested, DEFAULT_TRANSCRIPT_CHARS)
  // Session 没有公开的 `events` 属性，必须走 sessionEvents（snapshotEvents/ownEvents）。
  // 读错会拿到 undefined：转写恒为空，每次回顾都被判 turn_too_short，日记永远写不出来。
  const transcript = buildTranscript(sessionEvents(session), window)
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

  // journalEmpty 单独标出来：调用方要能区分「模型判定本轮无内容可记」和
  // 「确实没有可更新的记忆」。再带上转写长度，让调用方能判断这个「空」是否合理
  // （寒暄/测试本来就该空；转写很长还空，才更像漏记）。
  const result = {
    journal: Boolean(parsed.journal),
    applied,
    journalEmpty: !parsed.journal,
    transcriptLength: transcript.trim().length,
  }
  if (parsed.raw) result.parseFailed = parsed.raw
  return result
}
