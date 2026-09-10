/**
 * 检索与回顾单测：日志检索（日期=文件名、关键词=全文）与回顾流程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendJournal, changelogPath, journalPath } from '../src/memory-store.mjs'
import { SEARCH_TOOL_NAME, createSearchTool, searchJournal } from '../src/search.mjs'
import { buildReviewInput, buildTranscript, callText, parseReviewJson, runReview } from '../src/review.mjs'

const makeDir = () => mkdtempSync(join(tmpdir(), 'preset-md-search-'))

/* ───────────────────────────── 检索 ───────────────────────────── */

test('searchJournal：没有日志时给出提示', () => {
  const dir = makeDir()
  assert.match(searchJournal(dir, '任意', 7), /没有日志/)
  rmSync(dir, { recursive: true, force: true })
})

test('searchJournal：无 query 返回索引（日期 + 段落标题 + 首句）', async () => {
  const dir = makeDir()
  await appendJournal(dir, '### 讨论与解决\n\n聊了插件设计', new Date(2026, 8, 9, 10, 0))
  const text = searchJournal(dir, '', 3)
  assert.ok(text.includes('# 2026-09-09'))
  assert.ok(text.includes('## 10:00'))
  assert.ok(text.includes('聊了插件设计'))
  rmSync(dir, { recursive: true, force: true })
})

test('searchJournal：关键词命中返回 日期:行号 + 上下文', async () => {
  const dir = makeDir()
  await appendJournal(dir, '### 关键信息\n\n结论：用 memory 目录', new Date(2026, 8, 9, 10, 0))
  const hit = searchJournal(dir, 'memory', 3)
  assert.match(hit, /2026-09-09:\d+/)
  assert.ok(hit.includes('结论：用 memory 目录'))
  assert.match(searchJournal(dir, '不存在的词', 3), /没有匹配/)
  rmSync(dir, { recursive: true, force: true })
})

test('searchJournal：days 限制按文件名生效', async () => {
  const dir = makeDir()
  const old = new Date(Date.now() - 10 * 86400000)
  await appendJournal(dir, '### 讨论与解决\n\n很久以前', old)
  assert.match(searchJournal(dir, '', 3), /没有日志/)
  assert.ok(searchJournal(dir, '', 30).includes('很久以前'))
  rmSync(dir, { recursive: true, force: true })
})

test('createSearchTool：工具名带 preset_md_ 前缀，execute 返回文本', async () => {
  const dir = makeDir()
  await appendJournal(dir, '### 讨论与解决\n\nhello world', new Date())
  const tool = createSearchTool(dir)
  assert.equal(tool.name, SEARCH_TOOL_NAME)
  assert.equal(tool.name.startsWith('preset_md_'), true)
  // parameters 必须是标准 JSON Schema 形态（扁平 DSL 会让 provider 400，见 search.mjs 注释）
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['days', 'query'])
  const result = await tool.execute({ query: 'hello', days: 3 })
  assert.ok(result.text.includes('hello world'))
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: result.text }])
  rmSync(dir, { recursive: true, force: true })
})

/* ───────────────────────────── 回顾 ───────────────────────────── */

test('buildTranscript：只取 user/assistant 文本并截断尾部', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } },
    { type: 'tool/result', data: {} },
  ]
  assert.equal(buildTranscript(events), '用户：你好\n\n助手：在的')
  const long = buildTranscript([{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }] } }], 10)
  assert.equal(long.length, 10)
})

test('parseReviewJson：容错解析，缺字段回落空', () => {
  assert.deepEqual(parseReviewJson('不是 JSON'), { journal: '', updates: [] })
  const parsed = parseReviewJson('```json\n{"journal":"j","updates":[{"file":"MEMORY.md"}]}\n```')
  assert.equal(parsed.journal, 'j')
  assert.equal(parsed.updates.length, 1)
  assert.deepEqual(parseReviewJson('{"updates":"bad"}').updates, [])
})

test('buildReviewInput：包含对话、今日日志与各文件原文', () => {
  const text = buildReviewInput({
    transcript: '用户：hi',
    todayJournal: '## 09:00',
    files: [{ file: 'MEMORY.md', text: '- 旧' }, { file: 'SOUL.md', text: '' }],
  })
  assert.ok(text.includes('# 本轮对话'))
  assert.ok(text.includes('用户：hi'))
  assert.ok(text.includes('# 今天的日志'))
  assert.ok(text.includes('# 文件 MEMORY.md'))
  assert.ok(text.includes('（空文件）'))
})

test('callText：拼接 text-delta，finish=error 抛错', async () => {
  const chunks = [
    { type: 'text-delta', text: '{"journal"' },
    { type: 'text-delta', text: ':"x"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const ctx = { llm: { stream: () => (async function* () { yield* chunks })() } }
  assert.equal(await callText(ctx, { provider: 'p', model: 'm', system: 's', prompt: 'u' }), '{"journal":"x"}')

  const bad = { llm: { stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'error' } } })() } }
  await assert.rejects(() => callText(bad, { provider: 'p', model: 'm', system: 's', prompt: 'u' }), /未正常完成/)
})

test('runReview：写日志 + 应用 updates + 留痕；短对话跳过', async () => {
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: '讨论插件设计'.repeat(20) }] } }]
  const reply = JSON.stringify({
    journal: '### 讨论与解决\n\n聊了插件设计',
    updates: [
      { file: 'MEMORY.md', op: 'add', content: '- 结论：用 memory 目录' },
      { file: 'SYSTEM.md', op: 'add', content: '- 不该写进去' },
    ],
  })
  const ctx = {
    llm: {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
  }

  const result = await runReview({ ctx, dir, session: { events }, provider: 'p', model: 'm', now: new Date(2026, 8, 9, 10, 0) })
  assert.equal(result.journal, true)
  assert.ok(readFileSync(journalPath(dir, '2026-09-09'), 'utf8').includes('聊了插件设计'))
  assert.ok(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('结论：用 memory 目录'))
  assert.ok(result.applied.some((line) => line.startsWith('SYSTEM.md:add 失败')))
  assert.ok(readFileSync(changelogPath(dir, 'MEMORY.md'), 'utf8').includes('- op: add'))

  const skipped = await runReview({ ctx, dir, session: { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }] }, provider: 'p', model: 'm' })
  assert.equal(skipped.skipped, 'turn_too_short')
  rmSync(dir, { recursive: true, force: true })
})
