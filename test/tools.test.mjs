/**
 * 写入类工具单测：preset_md_journal（写日志）与 preset_md_memory（更新记忆）。
 *
 * 重点验证「必须走工具」的三条理由是否真的成立：
 * 串行入队、changelog 留痕、old_text 校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { changelogPath, dateKey, journalPath } from '../src/memory-store.mjs'
import { JOURNAL_TOOL_NAME, MEMORY_TOOL_NAME, createJournalTool, createMemoryTool } from '../src/tools.mjs'

const makeDir = () => mkdtempSync(join(tmpdir(), 'preset-md-tools-'))
const read = (file) => readFileSync(file, 'utf8')

/* ─────────────────────────── preset_md_journal ─────────────────────────── */

test('createJournalTool：工具名与 JSON Schema 形态合法', () => {
  const dir = makeDir()
  const tool = createJournalTool(dir)
  assert.equal(tool.name, JOURNAL_TOOL_NAME)
  assert.equal(tool.name.startsWith('preset_md_'), true)
  // parameters 必须是标准 JSON Schema（扁平 DSL 会让 provider 400）
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['body'])
  assert.deepEqual(tool.parameters.required, ['body'])
  assert.deepEqual(tool.output.render({}, { text: 'x' }), [{ type: 'text', text: 'x' }])
  rmSync(dir, { recursive: true, force: true })
})

test('createJournalTool：写进当天日志，自动补日期头与时间标题', async () => {
  const dir = makeDir()
  const tool = createJournalTool(dir)
  const result = await tool.execute({ body: '### 讨论与解决\n\n聊了工具设计' })

  assert.match(result.text, /已写入今天/)
  const text = read(journalPath(dir, dateKey()))
  assert.ok(text.startsWith(`# ${dateKey()}`), '自动补日期头')
  assert.match(text, /## \d{2}:\d{2}/, '自动补时间标题')
  assert.ok(text.includes('聊了工具设计'))
  rmSync(dir, { recursive: true, force: true })
})

test('createJournalTool：body 为空 / 非字符串被拒绝，不落盘', async () => {
  const dir = makeDir()
  const tool = createJournalTool(dir)
  for (const args of [{ body: '   ' }, { body: 3 }, {}, undefined]) {
    const result = await tool.execute(args)
    assert.match(result.text, /写入失败/)
  }
  assert.ok(!existsSync(join(dir, 'memory')), '不应创建 memory 目录')
  rmSync(dir, { recursive: true, force: true })
})

/* ─────────────────────────── preset_md_memory ─────────────────────────── */

test('createMemoryTool：工具名、file 枚举限定为可写白名单', () => {
  const dir = makeDir()
  const tool = createMemoryTool(dir)
  assert.equal(tool.name, MEMORY_TOOL_NAME)
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.properties.file.enum, ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'])
  assert.deepEqual(tool.parameters.properties.op.enum, ['add', 'replace', 'remove'])
  assert.deepEqual(tool.parameters.required, ['file', 'op'])
  rmSync(dir, { recursive: true, force: true })
})

test('createMemoryTool：add 追加并留痕 changelog', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'MEMORY.md'), '- 旧条目\n', 'utf8')
  const tool = createMemoryTool(dir)

  const result = await tool.execute({ file: 'MEMORY.md', op: 'add', content: '- 新条目' })
  assert.match(result.text, /已更新 MEMORY\.md/)
  assert.match(result.text, /changelog/)
  assert.equal(read(join(dir, 'MEMORY.md')), '- 旧条目\n\n- 新条目\n')

  const log = read(changelogPath(dir, 'MEMORY.md'))
  assert.ok(log.includes('- file: MEMORY.md'))
  assert.ok(log.includes('- op: add'))
  assert.ok(log.includes('- new: - 新条目'))
  rmSync(dir, { recursive: true, force: true })
})

test('createMemoryTool：replace / remove 走 old_text 唯一性校验', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'USER.md'), '- 时区：UTC\n- 语言：中文\n', 'utf8')
  const tool = createMemoryTool(dir)

  const replaced = await tool.execute({ file: 'USER.md', op: 'replace', content: '- 时区：CST', old_text: '- 时区：UTC' })
  assert.match(replaced.text, /已更新 USER\.md/)
  assert.ok(read(join(dir, 'USER.md')).includes('- 时区：CST'))

  const removed = await tool.execute({ file: 'USER.md', op: 'remove', old_text: '- 语言：中文' })
  assert.match(removed.text, /已更新 USER\.md/)
  assert.ok(!read(join(dir, 'USER.md')).includes('- 语言：中文'))
  rmSync(dir, { recursive: true, force: true })
})

test('createMemoryTool：old_text 找不到 / 出现多次被拒绝，并给出提示', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'MEMORY.md'), '- a\n- a\n', 'utf8')
  const tool = createMemoryTool(dir)

  const missing = await tool.execute({ file: 'MEMORY.md', op: 'replace', content: 'x', old_text: '- 不存在' })
  assert.match(missing.text, /未在文件中找到/)
  assert.match(missing.text, /请先读取该文件/)

  const dup = await tool.execute({ file: 'MEMORY.md', op: 'remove', old_text: '- a' })
  assert.match(dup.text, /出现多次/)

  assert.equal(read(join(dir, 'MEMORY.md')), '- a\n- a\n', '失败时文件不被改动')
  assert.ok(!existsSync(changelogPath(dir, 'MEMORY.md')), '失败时不写 changelog')
  rmSync(dir, { recursive: true, force: true })
})

test('createMemoryTool：白名单外的文件被拒绝（SYSTEM.md / AGENTS.md）', async () => {
  const dir = makeDir()
  const tool = createMemoryTool(dir)
  for (const file of ['SYSTEM.md', 'AGENTS.md', 'secrets.txt', '']) {
    const result = await tool.execute({ file, op: 'add', content: '- x' })
    assert.match(result.text, /写入失败/, `${file} 应被拒绝`)
  }
  assert.ok(!existsSync(join(dir, 'SYSTEM.md')))
  rmSync(dir, { recursive: true, force: true })
})

test('createMemoryTool：参数缺失或非法 op 被拒绝', async () => {
  const dir = makeDir()
  const tool = createMemoryTool(dir)
  const cases = [
    [{ file: 'MEMORY.md', op: 'add' }, /需要非空的 content/],
    [{ file: 'MEMORY.md', op: 'replace', content: 'x' }, /需要 old_text/],
    [{ file: 'MEMORY.md', op: 'replace', old_text: 'x' }, /需要非空的 content/],
    [{ file: 'MEMORY.md', op: 'remove' }, /需要 old_text/],
    [{ file: 'MEMORY.md', op: 'upsert', content: 'x' }, /未知操作/],
    [{ file: 'MEMORY.md' }, /未知操作/],
    [{}, /不允许修改/],
  ]
  for (const [args, pattern] of cases) {
    const result = await tool.execute(args)
    assert.match(result.text, pattern, `参数 ${JSON.stringify(args)} 应被拒绝`)
  }
  rmSync(dir, { recursive: true, force: true })
})
