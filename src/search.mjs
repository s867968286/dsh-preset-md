/**
 * 记忆检索（零依赖）：只读 `memory/YYYY-MM-DD.md` 日志文件。
 *
 * - 日期过滤 = 直接按文件名（`YYYY-MM-DD.md`）算区间，不建索引；
 * - 关键词 = 全文逐行子串匹配（大小写不敏感），返回命中行 + 上下文；
 * - 不带 query 时返回最近几天的「索引」（每段 `## HH:MM` + 首句）。
 *
 * 工具名带 `preset_md_` 前缀，避免与官方/第三方工具冲突。
 */
import { listJournalFiles, readText } from './memory-store.mjs'

/** 模型可见的工具名。 */
export const SEARCH_TOOL_NAME = 'preset_md_search'

/** 单次最多返回的命中片段数。 */
export const MAX_HITS = 30

/**
 * 在日志里检索。
 * @param {string} dir - preset 目录
 * @param {string} [query] - 关键词；空则返回索引
 * @param {number} [days] - 最多回溯几个「有内容」的日志文件（不是自然日），默认 7
 * @returns {string} 供模型阅读的文本
 */
export function searchJournal(dir, query, days = 7) {
  const span = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7
  const files = listJournalFiles(dir, span)
  if (files.length === 0) return `（最近 ${span} 个日志文件里没有内容）`

  const keyword = String(query || '').trim()
  if (!keyword) {
    const out = []
    for (const { key, file } of files) {
      out.push(`# ${key}`)
      for (const block of readText(file).split(/\n(?=## )/)) {
        const lines = block.split('\n')
        const head = (lines.find((line) => line.startsWith('## ')) || '').trim()
        if (!head) continue
        const first = (lines.find((line) => line.trim() && !line.startsWith('#')) || '').trim()
        out.push(`- ${head}${first ? ` ${first.slice(0, 80)}` : ''}`)
      }
    }
    return out.join('\n')
  }

  const lower = keyword.toLowerCase()
  const hits = []
  for (const { key, file } of files) {
    const lines = readText(file).split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(lower)) continue
      const from = Math.max(0, index - 2)
      const to = Math.min(lines.length, index + 3)
      hits.push(`${key}:${index + 1}\n${lines.slice(from, to).join('\n')}`)
      if (hits.length >= MAX_HITS) break
    }
    if (hits.length >= MAX_HITS) break
  }
  return hits.length > 0
    ? hits.join('\n\n')
    : `（最近 ${span} 个日志文件里没有匹配「${keyword}」的内容）`
}

/** 构造 `preset_md_search` 的工具定义（parameters 为标准 JSON Schema 形态）。 */
export function createSearchTool(dir) {
  return {
    name: SEARCH_TOOL_NAME,
    description:
      '在助手的记忆日志（memory/YYYY-MM-DD.md）里检索。带 query 时按关键词找原文片段，不带 query 时返回最近几个日志文件的索引。用来回忆过去聊过什么、当时结论是什么。',
    // parameters 必须是标准 JSON Schema：register() 会原样透传给 provider，
    // 扁平写法（{query:{...}}）会被判非法。
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词；不填则返回最近日志的索引' },
        days: {
          type: 'number',
          description: '最多回溯几个「有内容」的日志文件（不是自然日），默认 7。日志只在有对话时生成，所以按文件计数比按天更可靠。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      return { text: searchJournal(dir, args?.query, args?.days) }
    },
  }
}
