/**
 * 回合回顾：一次 LLM 调用，产出「当天日志段落 + MD 更新操作」。
 *
 * 只依赖官方 `@deepseek-ai/dsh-llm` 的消息构造与流解析。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { EDITABLE_FILES, appendJournal, applyUpdate, listJournalFiles, readText } from './memory-store.mjs'

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

/** 把会话事件里的 user/assistant 文本拼成转写（取尾部，超长截断）。 */
export function buildTranscript(events, maxChars = 8000) {
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

/** 从模型输出里抠出 JSON（容错：允许前后有杂字符）。 */
export function parseReviewJson(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const empty = { journal: '', updates: [] }
  if (start < 0 || end <= start) return empty
  try {
    const value = JSON.parse(raw.slice(start, end + 1))
    return {
      journal: typeof value.journal === 'string' ? value.journal.trim() : '',
      updates: Array.isArray(value.updates) ? value.updates.filter((item) => item && typeof item === 'object') : [],
    }
  } catch {
    return empty
  }
}

/** 调用一次 LLM 文本生成（官方 `createUserMessage` + `BlockAssembler`）。 */
export async function callText(ctx, { provider, model, system, prompt, maxTokens = 2048, signal }) {
  const message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-preset-md',
      form: 'snapshot',
      sections: [{ name: 'preset-md:review', text: prompt }],
    },
  })

  const assembler = new BlockAssembler()
  const stream = ctx.llm.stream({ provider, model, system, messages: [message], purpose: 'compaction', maxTokens, signal })
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
}

/**
 * 跑一次回顾：拼输入 → 调模型 → 写日志 → 应用 updates。
 * @returns {Promise<{skipped?: string, journal?: boolean, applied?: string[], error?: string}>}
 */
export async function runReview({ ctx, dir, session, provider, model, now = new Date(), signal, minChars = 80 }) {
  const transcript = buildTranscript(session?.events)
  if (transcript.trim().length < minChars) return { skipped: 'turn_too_short' }

  const files = EDITABLE_FILES.map((file) => ({ file, text: readText(join(dir, file)) }))
  const today = listJournalFiles(dir, 1)[0]
  const todayJournal = today ? readText(today.file) : ''

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

  if (parsed.journal) {
    const written = await appendJournal(dir, parsed.journal, now)
    applied.push(written.ok ? 'journal' : `journal 失败(${written.error})`)
  }
  for (const update of parsed.updates) {
    const result = await applyUpdate(dir, update.file, update.op, update.content, update.old_text, now)
    applied.push(result.ok ? `${result.file}:${result.op}` : `${update.file}:${update.op} 失败(${result.error})`)
  }
  return { journal: Boolean(parsed.journal), applied }
}
