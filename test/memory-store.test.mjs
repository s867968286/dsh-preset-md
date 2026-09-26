/**
 * 记忆存储层单测：日志追加、MD 条目级更新、changelog 留痕与按块裁剪。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHANGELOG_DIR,
  CHANGELOG_MAX_BYTES,
  EDITABLE_FILES,
  MEMORY_DIR,
  applyOp,
  applyUpdate,
  appendJournal,
  changelogPath,
  dateKey,
  detectEol,
  journalPath,
  listJournalFiles,
  timeKey,
  trimChangelog,
} from '../src/memory-store.mjs'

const makeDir = () => mkdtempSync(join(tmpdir(), 'companion-store-'))
const read = (file) => readFileSync(file, 'utf8')

test('dateKey / timeKey：本地日期与时间格式', () => {
  const now = new Date(2026, 8, 9, 14, 32)
  assert.equal(dateKey(now), '2026-09-09')
  assert.equal(timeKey(now), '14:32')
})

test('appendJournal：新文件带日期头，再次追加不重复头', async () => {
  const dir = makeDir()
  const first = new Date(2026, 8, 9, 9, 5)
  const second = new Date(2026, 8, 9, 15, 40)
  await appendJournal(dir, '### 讨论与解决\n\n聊了 A', first)
  await appendJournal(dir, '### 关键信息\n\n结论 B', second)

  const text = read(journalPath(dir, '2026-09-09'))
  assert.ok(text.startsWith('# 2026-09-09'))
  assert.equal(text.match(/# 2026-09-09/g).length, 1)
  assert.ok(text.includes('## 09:05'))
  assert.ok(text.includes('## 15:40'))
  assert.ok(text.includes('结论 B'))
  rmSync(dir, { recursive: true, force: true })
})

test('appendJournal：空正文被拒绝', async () => {
  const dir = makeDir()
  const result = await appendJournal(dir, '   ')
  assert.equal(result.ok, false)
  assert.ok(!existsSync(join(dir, 'memory')))
  rmSync(dir, { recursive: true, force: true })
})

test('listJournalFiles：只返回存在的日志，按日期倒序', async () => {
  const dir = makeDir()
  await appendJournal(dir, '### 讨论与解决\n\nx', new Date(2026, 8, 9, 10, 0))
  const files = listJournalFiles(dir, 3)
  assert.deepEqual(files.map((f) => f.key), ['2026-09-09'])
  rmSync(dir, { recursive: true, force: true })
})

test('listJournalFiles：凑够 count 个文件，而不是最近 count 个自然日', async () => {
  const dir = makeDir()
  // 三个日志彼此相隔 10 天：按「自然日回退」只能捞到最后一个，按「文件」应三个都返回
  const days = [1, 11, 21]
  for (const day of days) {
    await appendJournal(dir, `### 讨论与解决\n\n第 ${day} 天`, new Date(Date.now() - day * 86400000))
  }
  const expected = days.map((day) => dateKey(new Date(Date.now() - day * 86400000))).sort().reverse()

  const all = listJournalFiles(dir, 7)
  assert.equal(all.length, 3, '不足 count 个时有多少给多少')
  assert.deepEqual(all.map((f) => f.key), expected, '按日期倒序')

  const two = listJournalFiles(dir, 2)
  assert.equal(two.length, 2, 'count 是文件个数上限')
  assert.deepEqual(two.map((f) => f.key), expected.slice(0, 2), '取最新的两个')
  rmSync(dir, { recursive: true, force: true })
})

test('listJournalFiles：目录不存在 / 非日期文件 / 非法 count', () => {
  assert.deepEqual(listJournalFiles('', 7), [])
  assert.deepEqual(listJournalFiles(join(tmpdir(), 'companion-不存在-目录'), 7), [])

  const dir = makeDir()
  mkdirSync(join(dir, MEMORY_DIR), { recursive: true })
  writeFileSync(join(dir, MEMORY_DIR, 'notes.md'), '忽略我', 'utf8')
  writeFileSync(join(dir, MEMORY_DIR, '2026-9-9.md'), '非补零日期', 'utf8')
  writeFileSync(join(dir, MEMORY_DIR, '2026-09-09.md'), '# 2026-09-09\n', 'utf8')
  assert.deepEqual(listJournalFiles(dir, 7).map((f) => f.key), ['2026-09-09'])
  assert.equal(listJournalFiles(dir, 0).length, 1, 'count<=0 回落默认 7')
  rmSync(dir, { recursive: true, force: true })
})

test('applyOp：add 追加到末尾（空文件不带前导空行）', () => {
  assert.deepEqual(applyOp('', 'add', '- 条目', ''), { ok: true, text: '- 条目\n' })
  assert.deepEqual(applyOp('# 标题\n', 'add', '- 条目', ''), { ok: true, text: '# 标题\n\n- 条目\n' })
  assert.equal(applyOp('# 标题\n', 'add', '  ', '').ok, false)
})

test('applyOp：replace 要求 old_text 唯一', () => {
  const text = '- a\n- b\n'
  assert.deepEqual(applyOp(text, 'replace', '- B', '- b'), { ok: true, text: '- a\n- B\n' })
  assert.match(applyOp(text, 'replace', 'x', '- 没有').error, /未在文件中找到/)
  assert.match(applyOp('- a\n- a\n', 'replace', 'x', '- a').error, /出现多次/)
})

test('applyOp：remove 整行删除，片段则只删片段', () => {
  assert.deepEqual(applyOp('- a\n- b\n', 'remove', '', '- b'), { ok: true, text: '- a\n' })
  assert.deepEqual(applyOp('- keep abc here\n', 'remove', '', 'abc '), { ok: true, text: '- keep here\n' })
})

test('applyOp：CRLF 文件在写回时保留原有换行风格', () => {
  const crlf = '- a\r\n- b\r\n'
  assert.equal(applyOp(crlf, 'add', '- c', '').text, '- a\r\n- b\r\n\r\n- c\r\n')
  assert.equal(applyOp(crlf, 'remove', '', '- a').text, '- b\r\n')
  assert.equal(applyOp(crlf, 'replace', '- B', '- b').text, '- a\r\n- B\r\n')

  // LF 文件不能被塞进 CRLF
  assert.equal(applyOp('- a\n- b\n', 'add', '- c', '').text, '- a\n- b\n\n- c\n')
  // content 里混入 CRLF 也要归一化后再写，不能出现 \r\r\n
  assert.equal(applyOp('- a\n', 'add', '- c\r\n- d', '').text, '- a\n\n- c\n- d\n')
})

test('applyOp：detectEol 判定主换行风格', () => {
  assert.equal(detectEol('a\r\nb\r\nc\r\n'), '\r\n')
  assert.equal(detectEol('a\nb\nc\n'), '\n')
  assert.equal(detectEol(''), '\n')
})

test('applyOp：多行 old_text 的 remove 按整块删除，不留孤立空行', () => {
  const text = '### 讨论\n\n- a\n- b\n- c\n\n### 关键\n\n- d\n'
  assert.equal(applyOp(text, 'remove', '', '- b\n- c').text, '### 讨论\n\n- a\n\n### 关键\n\n- d\n')

  // 片段删除后整行只剩空白 → 连行带换行一起删，不留 `- ` 这种残行
  assert.equal(applyOp('- a\n- xyz\n- b\n', 'remove', '', 'xyz').text, '- a\n- b\n')
  assert.equal(applyOp('- a\n- xyz \n- b\n', 'remove', '', 'xyz ').text, '- a\n- b\n')

  // 行里还有别的内容时只删片段，不动整行
  assert.equal(applyOp('- keep abc here\n', 'remove', '', 'abc ').text, '- keep here\n')

  // 末行（无尾换行）也要能删干净
  assert.equal(applyOp('- a\n- b', 'remove', '', '- b').text, '- a\n')
})

test('applyUpdate：CRLF 文件改动后仍为 CRLF', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'MEMORY.md'), '- 旧\r\n', 'utf8')
  await applyUpdate(dir, 'MEMORY.md', 'add', '- 新', '')
  assert.equal(read(join(dir, 'MEMORY.md')), '- 旧\r\n\r\n- 新\r\n')
  rmSync(dir, { recursive: true, force: true })
})

test('applyUpdate：白名单之外的文件拒绝（SYSTEM.md / AGENTS.md）', async () => {
  const dir = makeDir()
  for (const file of ['SYSTEM.md', 'AGENTS.md', 'unknown.md', '']) {
    const result = await applyUpdate(dir, file, 'add', '- x', '')
    assert.equal(result.ok, false, `${file} 应被拒绝`)
  }
  assert.deepEqual(EDITABLE_FILES, ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'])
  rmSync(dir, { recursive: true, force: true })
})

test('applyUpdate：写入文件并生成对应的 changelog', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'MEMORY.md'), '- 旧条目\n', 'utf8')
  const result = await applyUpdate(dir, 'MEMORY.md', 'add', '- 新条目', '', new Date(2026, 8, 9, 10, 0))
  assert.equal(result.ok, true)
  assert.equal(read(join(dir, 'MEMORY.md')), '- 旧条目\n\n- 新条目\n')

  const log = read(changelogPath(dir, 'MEMORY.md'))
  assert.ok(changelogPath(dir, 'MEMORY.md').endsWith(join(CHANGELOG_DIR, 'MEMORY.changelog.md')))
  assert.ok(log.startsWith('## 2026-09-09 10:00'))
  assert.ok(log.includes('- file: MEMORY.md'))
  assert.ok(log.includes('- op: add'))
  assert.ok(log.includes('- new: - 新条目'))
  rmSync(dir, { recursive: true, force: true })
})

test('applyUpdate：old_text 找不到时不写文件、不写 changelog', async () => {
  const dir = makeDir()
  writeFileSync(join(dir, 'USER.md'), '- 时区：UTC\n', 'utf8')
  const result = await applyUpdate(dir, 'USER.md', 'replace', '- 时区：CST', '- 不存在')
  assert.equal(result.ok, false)
  assert.equal(read(join(dir, 'USER.md')), '- 时区：UTC\n')
  assert.ok(!existsSync(changelogPath(dir, 'USER.md')))
  rmSync(dir, { recursive: true, force: true })
})

test('trimChangelog：按块裁剪，保留最新的块且不切断记录', () => {
  const block = (i) => `## 2026-09-0${i} 10:00\n\n- file: MEMORY.md\n- op: add\n- new: 第 ${i} 条\n`
  const text = [1, 2, 3, 4, 5].map(block).join('\n')
  const kept = trimChangelog(text, 200)
  assert.ok(kept.includes('第 5 条'))
  assert.ok(!kept.includes('第 1 条'))
  // 每条记录都完整（都以 '## ' 开头、以 '- new:' 行结尾）
  for (const chunk of kept.trim().split(/\n(?=## )/)) {
    assert.ok(chunk.startsWith('## '))
    assert.ok(chunk.trimEnd().endsWith(`条`))
  }
  assert.equal(trimChangelog('', CHANGELOG_MAX_BYTES), '')
})

test('trimChangelog：只有一条记录时即使超长也不裁掉', () => {
  const single = `## 2026-09-09 10:00\n\n- new: ${'x'.repeat(500)}\n`
  assert.equal(trimChangelog(single, 10), single)
})
