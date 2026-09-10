/**
 * 记忆存储层单测：日志追加、MD 条目级更新、changelog 留痕与按块裁剪。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHANGELOG_DIR,
  CHANGELOG_MAX_BYTES,
  EDITABLE_FILES,
  applyOp,
  applyUpdate,
  appendJournal,
  changelogPath,
  dateKey,
  journalPath,
  listJournalFiles,
  timeKey,
  trimChangelog,
} from '../src/memory-store.mjs'

const makeDir = () => mkdtempSync(join(tmpdir(), 'preset-md-store-'))
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

test('listJournalFiles：只返回存在的日志，按天倒序', async () => {
  const dir = makeDir()
  await appendJournal(dir, '### 讨论与解决\n\nx', new Date(2026, 8, 9, 10, 0))
  const files = listJournalFiles(dir, 3)
  assert.deepEqual(files.map((f) => f.key), ['2026-09-09'])
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
