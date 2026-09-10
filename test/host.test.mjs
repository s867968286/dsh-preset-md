/**
 * Host 半（src/index.js）单测：preset.yml 读写、伙伴增删查、备份、日记、设置。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SETTINGS,
  archiveAgent,
  copyAgent,
  createAgent,
  generateId,
  listAgents,
  listJournal,
  readAgent,
  readJournal,
  readPresetMeta,
  readSettings,
  resolvePaths,
  writeAgentFile,
  writePresetMeta,
  writeSettings,
} from '../src/index.js'
import { PRESET_FILES } from '../src/templates.mjs'

/** 建一个临时的 dshHome 并返回 paths。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'preset-md-home-'))
  return { home, paths: resolvePaths(home) }
}

test('resolvePaths：显式 home 优先，DSH_HOME 次之', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:/fake-dsh-home'
  const paths = resolvePaths()
  assert.equal(paths.dshHome, 'C:/fake-dsh-home')
  assert.equal(paths.presetsRoot, join('C:/fake-dsh-home', '.agent-presets'))
  assert.equal(paths.backupRoot, join('C:/fake-dsh-home', '.agent-presets-backup'))
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  assert.equal(resolvePaths('D:/explicit').dshHome, 'D:/explicit')
})

test('preset.yml 往返：写入 name/description/order，读回一致', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.presetsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  writePresetMeta(dir, { name: '小花', description: '温柔但直接', order: 3 })
  const meta = readPresetMeta(dir)
  assert.deepEqual(meta, { name: '小花', description: '温柔但直接', order: 3 })
  rmSync(home, { recursive: true, force: true })
})

test('generateId：ASCII 名转 slug，中文名回落 presetmd-', () => {
  assert.match(generateId('Little Cat', new Set()), /^little-cat-[0-9a-f]{4}$/)
  assert.match(generateId('小花', new Set()), /^presetmd-[0-9a-f]{4}$/)
  const existing = new Set()
  const first = generateId('a', existing)
  existing.add(first)
  assert.notEqual(generateId('a', existing), first)
})

test('createAgent：生成 6 个 MD + agent.cordis.yml + preset.yml + memory 目录', () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: '小花', description: '温柔但直接' })
  assert.equal(agent.name, '小花')
  assert.equal(agent.description, '温柔但直接')
  for (const { file } of PRESET_FILES) {
    assert.equal(typeof agent.files[file], 'string', `${file} 应有内容`)
    assert.ok(existsSync(join(paths.presetsRoot, agent.id, file)), `${file} 应落盘`)
  }
  assert.ok(existsSync(join(paths.presetsRoot, agent.id, 'memory')))
  const cordis = readFileSync(join(paths.presetsRoot, agent.id, 'agent.cordis.yml'), 'utf8')
  assert.ok(cordis.includes('name: dsh-preset-md/preset'))
  assert.ok(agent.files['IDENTITY.md'].includes('小花'))
  rmSync(home, { recursive: true, force: true })
})

test('createAgent：空昵称拒绝', () => {
  const { home, paths } = makeHome()
  assert.throws(() => createAgent(paths, { name: '   ' }), /请输入昵称/)
  rmSync(home, { recursive: true, force: true })
})

test('listAgents：按 order 升序', () => {
  const { home, paths } = makeHome()
  const a = createAgent(paths, { name: 'A' })
  const b = createAgent(paths, { name: 'B' })
  const rows = listAgents(paths)
  assert.deepEqual(rows.map((row) => row.id), [a.id, b.id])
  rmSync(home, { recursive: true, force: true })
})

test('writeAgentFile：白名单内可写，白名单外拒绝', () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'X' })
  writeAgentFile(paths, agent.id, 'SOUL.md', '# 个性\n\n- 新内容\n')
  assert.equal(readAgent(paths, agent.id).files['SOUL.md'], '# 个性\n\n- 新内容\n')
  assert.throws(() => writeAgentFile(paths, agent.id, 'secrets.txt', 'x'), /不允许写/)
  assert.throws(() => writeAgentFile(paths, agent.id, '../evil.md', 'x'), /不允许写/)
  rmSync(home, { recursive: true, force: true })
})

test('archiveAgent：移动到备份目录，原目录消失、备份保留内容', () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'Y' })
  const result = archiveAgent(paths, agent.id, new Date(2026, 8, 9, 10, 30, 5))
  assert.ok(result.archived.startsWith(paths.backupRoot))
  assert.ok(result.archived.endsWith(`${agent.id}-20260909-103005`))
  assert.ok(!existsSync(join(paths.presetsRoot, agent.id)))
  assert.ok(existsSync(join(result.archived, 'SOUL.md')))
  assert.deepEqual(listAgents(paths), [])
  rmSync(home, { recursive: true, force: true })
})

test('copyAgent：克隆伙伴内容、替换名字、不带历史日记、order 排末尾', () => {
  const { home, paths } = makeHome()
  const source = createAgent(paths, { name: '莉莉', description: '温柔但直接' })
  // 制造差异内容与日记，验证「复制内容、不复制日记」
  writeAgentFile(paths, source.id, 'SOUL.md', '# 个性\n\n你是莉莉的专属灵魂，话少直接。\n')
  writeAgentFile(paths, source.id, 'IDENTITY.md', '# 身份\n\n你是 莉莉，{user} 的个人助手。\n')
  const dir = join(paths.presetsRoot, source.id, 'memory')
  writeFileSync(join(dir, '2026-09-08.md'), '私密日记', 'utf8')

  const copy = copyAgent(paths, source.id, { name: '莉莉二号' })
  assert.equal(copy.name, '莉莉二号')
  assert.equal(copy.description, '温柔但直接')
  assert.notEqual(copy.id, source.id)
  assert.ok(copy.files['SOUL.md'].includes('莉莉二号'), '复制内容应替换源名字')
  assert.ok(copy.files['IDENTITY.md'].includes('莉莉二号'))
  assert.ok(!copy.files['IDENTITY.md'].includes('你是 莉莉，'), '不应残留源名字')

  // 不带历史日记（新建的 memory 目录为空）
  assert.ok(existsSync(join(paths.presetsRoot, copy.id, 'memory')))
  assert.deepEqual(listJournal(paths, copy.id), [])

  // order 排在源之后
  const rows = listAgents(paths)
  assert.deepEqual(rows.map((row) => row.id), [source.id, copy.id])
  rmSync(home, { recursive: true, force: true })
})

test('copyAgent：空昵称回落「xxx 的副本」、源不存在拒绝', () => {
  const { home, paths } = makeHome()
  const source = createAgent(paths, { name: '原版' })
  const copy = copyAgent(paths, source.id, {})
  assert.equal(copy.name, '原版 的副本')
  assert.throws(() => copyAgent(paths, 'nope', { name: 'x' }), /伙伴不存在/)
  assert.throws(() => copyAgent(paths, '../x', { name: 'x' }), /非法 id/)
  rmSync(home, { recursive: true, force: true })
})

test('listJournal / readJournal：按日期倒序，非法日期拒绝', () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'Z' })
  const dir = join(paths.presetsRoot, agent.id, 'memory')
  writeFileSync(join(dir, '2026-09-08.md'), '# 2026-09-08\n\n## 09:00\n\n聊了 A\n', 'utf8')
  writeFileSync(join(dir, '2026-09-09.md'), '# 2026-09-09\n\n## 10:00\n\n聊了 B\n', 'utf8')
  writeFileSync(join(dir, 'notes.md'), '忽略我', 'utf8')

  const rows = listJournal(paths, agent.id)
  assert.deepEqual(rows.map((row) => row.date), ['2026-09-09', '2026-09-08'])
  assert.ok(rows[0].preview.includes('聊了 B'))
  assert.ok(readJournal(paths, agent.id, '2026-09-08').includes('聊了 A'))
  assert.throws(() => readJournal(paths, agent.id, '../etc'), /非法日期/)
  rmSync(home, { recursive: true, force: true })
})

test('设置：缺失回落默认、部分更新只改给到的键', () => {
  const { home, paths } = makeHome()
  assert.deepEqual(readSettings(paths), DEFAULT_SETTINGS)

  const next = writeSettings(paths, { reviewTurns: 20, autoMemory: false })
  assert.equal(next.reviewTurns, 20)
  assert.equal(next.autoMemory, false)
  assert.equal(next.reviewChars, DEFAULT_SETTINGS.reviewChars)
  assert.deepEqual(readSettings(paths), next)

  writeSettings(paths, { reviewTurns: 5 })
  assert.equal(readSettings(paths).autoMemory, false)
  rmSync(home, { recursive: true, force: true })
})

test('readAgent：非法 id / 不存在的 id 报错', () => {
  const { home, paths } = makeHome()
  assert.throws(() => readAgent(paths, '../x'), /非法 id/)
  assert.throws(() => readAgent(paths, 'nope'), /伙伴不存在/)
  rmSync(home, { recursive: true, force: true })
})
