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
  nextOrder,
  readAgent,
  readJournal,
  readPresetMeta,
  readSettings,
  resolvePaths,
  writeAgentFile,
  writePresetMeta,
  writeSettings,
} from '../src/index.js'
import { PRESET_FILES, agentCordisTemplate, renderAllTemplates, renderTemplate } from '../src/templates.mjs'
import { DEFAULT_FILES } from '../src/core.js'

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

test('preset.yml：缺失 order 读成 undefined，不是 0', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.presetsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'name: 小花\ndescription: 无 order\n', 'utf8')
  const meta = readPresetMeta(dir)
  assert.equal(meta.order, undefined, 'Number("") === 0 会让无 order 的伙伴插到最前面')
  assert.equal(meta.name, '小花')

  // 文件完全不存在时同样是 undefined
  const empty = join(paths.presetsRoot, 'empty')
  mkdirSync(empty, { recursive: true })
  assert.equal(readPresetMeta(empty).order, undefined)
  rmSync(home, { recursive: true, force: true })
})

test('preset.yml：无 order 的伙伴排序不应被当成 0 插到最前', () => {
  const { home, paths } = makeHome()
  const withOrder = createAgent(paths, { name: '有序号' })       // order 0
  const dir = join(paths.presetsRoot, 'no-order')
  mkdirSync(dir, { recursive: true })
  writePresetMeta(dir, { name: '无序号', order: undefined })      // 写入 order: 0 是刻意的（写全字段）
  writeFileSync(join(dir, 'preset.yml'), 'name: 无序号\n', 'utf8') // 再抹掉 order 模拟外部创建

  const rows = listAgents(paths)
  assert.equal(rows[0].id, withOrder.id, '有明确 order 的排前面')
  assert.equal(rows[1].id, 'no-order')
  assert.equal(rows[1].order, Number.MAX_SAFE_INTEGER, '无 order 用哨兵值排到末尾')
  rmSync(home, { recursive: true, force: true })
})

test('preset.yml：值含冒号/引号/反斜杠/换行都能原样往返', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.presetsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  const cases = [
    '莉莉: 副手',
    'a"b',
    'a:b\\c',          // 单个反斜杠
    'a:b\\\\c',        // 两个反斜杠：曾经会被 unquote 吃掉一个
    'C:\\path\\to',
    '第一行\n第二行',    // 换行曾经会破坏文件结构
    '带 # 井号',
    ' 前后有空格 ',
    '# 井号开头',
    '- 短横开头',
    '空字符串测试以外的普通文本',
  ]
  for (const value of cases) {
    writePresetMeta(dir, { name: value, description: value, order: 1 })
    const meta = readPresetMeta(dir)
    assert.equal(meta.name, value, `name 往返失败：${JSON.stringify(value)}`)
    assert.equal(meta.description, value, `description 往返失败：${JSON.stringify(value)}`)
    assert.equal(meta.order, 1)
    // 单行文件：换行必须被转义，不能真的断行
    const lines = readFileSync(join(dir, 'preset.yml'), 'utf8').trimEnd().split('\n')
    assert.equal(lines.length, 3, `preset.yml 应始终是 3 行：${JSON.stringify(value)}`)
  }
  rmSync(home, { recursive: true, force: true })
})

test('preset.yml：有值的字段照常写，order 0 也保留', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.presetsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  writePresetMeta(dir, { name: 'x', description: '', order: 0 })
  const text = readFileSync(join(dir, 'preset.yml'), 'utf8')
  assert.ok(text.includes('name: x'))
  /*
   * 空的 description **不新增该行**（与官方 renderPresetMetadata 的
   * 「省略而非写空」一致）；但原文里已有该行时仍会更新成 `""`。
   * 见 writePresetMeta 的注释。
   */
  assert.ok(!text.includes('description:'), '原文没有 description 时不该凭空补一行空值')
  assert.ok(text.includes('order: 0'))
  assert.equal(readPresetMeta(dir).order, 0, 'order 0 必须保留，不能回落 undefined')
  rmSync(home, { recursive: true, force: true })
})

test('preset.yml：只替换三个已知键，注释与其余字段原样保留', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.presetsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  /*
   * preset.yml 归官方 dsh-agent-presets 管理，用户可以在里面放官方当前不读的键
   * （id / model / tools）与注释。整文件重写会把这些静默抹掉——这条锁住「不抹」。
   */
  writeFileSync(join(dir, 'preset.yml'), [
    '# 手工注释',
    'name: 莉莉',
    'description: 温柔但直接',
    'order: 3',
    'id: lili-personal',
    'model: deepseek-v4',
    'tools:',
    '  deny:',
    '    - bash',
    '',
  ].join('\n'), 'utf8')

  writePresetMeta(dir, { name: '莉莉2', description: '温柔但直接', order: 3 })
  const text = readFileSync(join(dir, 'preset.yml'), 'utf8')
  assert.ok(text.includes('name: 莉莉2'), '昵称应被替换')
  assert.ok(text.includes('# 手工注释'), '注释必须保留')
  assert.ok(text.includes('id: lili-personal'), '未知字段必须保留')
  assert.ok(text.includes('model: deepseek-v4'), '未知字段必须保留')
  assert.ok(text.includes('    - bash'), '嵌套结构必须保留')
  rmSync(home, { recursive: true, force: true })
})

test('preset.yml：会被 YAML 隐式类型化的值强制加引号', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.presetsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  /*
   * 官方用 js-yaml 读这个文件，未加引号的 123 / true / null / 2026-09-13
   * 会被读成 number / boolean / null / Date，而官方对非字符串的 name 是
   * **静默降级成 undefined**（回落显示 id）——不报错，只丢昵称。
   */
  for (const value of ['123', 'true', 'null', '~', '2026-09-13', '1.5']) {
    writePresetMeta(dir, { name: value, description: value, order: 1 })
    const text = readFileSync(join(dir, 'preset.yml'), 'utf8')
    assert.ok(
      text.includes(`name: "${value}"`),
      `${JSON.stringify(value)} 必须加引号写出，实际：${text.split('\n')[0]}`,
    )
    // 本插件的读法本身对称，改引号不影响它
    assert.equal(readPresetMeta(dir).name, value)
  }
  rmSync(home, { recursive: true, force: true })
})

test('preset.yml：缺 order 的伙伴改名后不该被写成 order: 0', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.presetsRoot, 'manual')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'name: 手工\n', 'utf8')

  const current = readPresetMeta(dir)
  assert.equal(current.order, undefined, '缺 order 应读成 undefined')
  writePresetMeta(dir, { name: '手工2', description: current.description, order: current.order })

  const text = readFileSync(join(dir, 'preset.yml'), 'utf8')
  assert.ok(!text.includes('order:'), 'order 为 undefined 时不该补一行（写 0 会排到最前）')
  assert.equal(readPresetMeta(dir).order, undefined)
  // 排序哨兵：没有 order 的排最后（与官方 order ?? Infinity 一致）
  const rows = listAgents(paths)
  assert.equal(rows[rows.length - 1].id, 'manual', '缺 order 应排在最后')
  rmSync(home, { recursive: true, force: true })
})

test('preset.yml：CRLF 文件改写后仍是 CRLF', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.presetsRoot, 'crlf')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), 'name: 甲\r\norder: 1\r\n', 'utf8')
  writePresetMeta(dir, { name: '乙', order: 1 })
  const raw = readFileSync(join(dir, 'preset.yml'), 'utf8')
  assert.ok(raw.includes('\r\n'), '必须保留 CRLF，否则 Windows 上整文件 diff 爆炸')
  assert.ok(!/[^\r]\n/.test(raw), '不该混入裸 LF')
  assert.equal(readPresetMeta(dir).name, '乙')
  rmSync(home, { recursive: true, force: true })
})

test('nextOrder：跳过缺 order 的伙伴，不产生巨大序号', () => {
  const { home, paths } = makeHome()
  const a = createAgent(paths, { name: 'A' })   // order 0
  const b = createAgent(paths, { name: 'B' })   // order 1
  const orphan = join(paths.presetsRoot, 'orphan')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, 'preset.yml'), 'name: 外部创建\n', 'utf8') // 无 order

  assert.equal(nextOrder(paths), 2, '不能被无 order 的伙伴顶成 MAX_SAFE_INTEGER 级别')
  const c = createAgent(paths, { name: 'C' })
  assert.equal(readPresetMeta(join(paths.presetsRoot, c.id)).order, 2)
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

test('renderTemplate：昵称/用户名里的 $ 不被当成替换模式', () => {
  // String.replaceAll 的替换串里 $& / $1 / $` 有特殊含义，会把 {name} 字面量吐回来
  for (const name of ['A$&B', 'A$$B', 'A$1B', "A$'B", 'A$`B']) {
    const text = renderTemplate('IDENTITY.md', { name, userName: '鹏哥' })
    assert.ok(text.includes(`你是 ${name}，鹏哥 的个人助手。`), `昵称 ${name} 应原样写入`)
    assert.ok(!text.includes('{name}'), `昵称 ${name} 不该让 {name} 残留`)
  }
  const user = renderTemplate('USER.md', { name: 'n', userName: 'A$&B' })
  assert.ok(user.includes('A$&B'))
  assert.ok(!user.includes('{user}'))

  // 正常中文昵称不受影响
  const normal = renderTemplate('IDENTITY.md', { name: '莉莉', userName: '鹏哥' })
  assert.ok(normal.includes('你是 莉莉，鹏哥 的个人助手。'))
})

test('renderAllTemplates / agentCordisTemplate：模板都能渲染，不留占位符', () => {
  const all = renderAllTemplates({ name: '测试', userName: '老王' })
  assert.deepEqual(Object.keys(all).sort(), PRESET_FILES.map((item) => item.file).sort())
  for (const [file, text] of Object.entries(all)) {
    assert.ok(!text.includes('{name}'), `${file} 不应残留 {name}`)
    assert.ok(!text.includes('{user}'), `${file} 不应残留 {user}`)
  }
  /*
   * agent.cordis.yml 模板**不带**昵称占位符：昵称由 preset.yml 与 IDENTITY.md 承载，
   * 预设行文件只是插件行清单（与线上预设逐字节一致，便于对照）。
   * 所以这里断言它被完整读出、且同样不含残留占位符。
   */
  const cordis = agentCordisTemplate('测试')
  assert.ok(cordis.includes('- id: preset-md'), 'cordis 模板应含 preset-md 行')
  assert.ok(!cordis.includes('{name}'), 'cordis 模板不应残留 {name}')
  assert.ok(!cordis.includes('{user}'), 'cordis 模板不应残留 {user}')
})

test('agent.cordis.yml 模板是人格类预设：不含编码 agent 的重型机械，也不挂 persona', () => {
  /*
   * 这是**有意的取舍**，不是遗漏：人格类预设只需要对话的基础工具，
   * plan mode / compaction / 委派与工作流 / goal / jobs 那套重型机械会把
   * 工具目录撑大、并诱导模型走工程流程，对陪伴场景是负担。
   *
   * 这条锁住取舍本身——将来有人「顺手对齐官方 standard」时会被挡下，
   * 要改就得先改这里和模板注释（以及 README）。
   */
  const text = agentCordisTemplate('测试')
  const ids = [...text.matchAll(/^- id:[ \t]*(\S+)/gm)].map((m) => m[1])

  // 基础工具必须在
  for (const id of ['preset-md', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-skill', 'tool-ask-user', 'tool-todo', 'tool-web']) {
    assert.ok(ids.includes(id), `人格类预设应保留基础工具 ${id}`)
  }

  // 重型机械不该在
  for (const id of ['planning', 'plan-mode', 'compaction', 'delegation', 'tool-subagent', 'tool-workflow', 'tool-ralph', 'tool-jobs', 'tool-goal', 'command-goal']) {
    assert.ok(!ids.includes(id), `人格类预设不该挂 ${id}（重型机械，见模板注释）`)
  }

  // 不挂 persona：官方 persona 的 "You are a coding agent ..." 会盖掉人格
  assert.ok(!ids.includes('persona'), '人格由 SYSTEM.md / IDENTITY.md 承载，不挂官方 persona 行')

  // preset-md 行要带工具收窄配置（关掉第三方记忆插件的工具）
  assert.match(text, /- id: preset-md[\s\S]{0,200}deny:/, 'preset-md 行应带 tools.deny 收窄')
  assert.match(text, /'mnemon\*'/, '应关掉 mnemon 的工具，避免两套记忆系统打架')
})

test('listAgents：按 order 升序', () => {
  const { home, paths } = makeHome()
  const a = createAgent(paths, { name: 'A' })
  const b = createAgent(paths, { name: 'B' })
  const rows = listAgents(paths)
  assert.deepEqual(rows.map((row) => row.id), [a.id, b.id])
  rmSync(home, { recursive: true, force: true })
})

test('writeAgentFile：白名单内可写，白名单外拒绝', async () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'X' })
  await writeAgentFile(paths, agent.id, 'SOUL.md', '# 个性\n\n- 新内容\n')
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

test('copyAgent：克隆伙伴内容、替换名字、不带历史日记、order 排末尾', async () => {
  const { home, paths } = makeHome()
  const source = createAgent(paths, { name: '莉莉', description: '温柔但直接' })
  // 制造差异内容与日记，验证「复制内容、不复制日记」
  await writeAgentFile(paths, source.id, 'SOUL.md', '# 个性\n\n你是莉莉的专属灵魂，话少直接。\n')
  await writeAgentFile(paths, source.id, 'IDENTITY.md', '# 身份\n\n你是 莉莉，鹏哥 的个人助手。\n')
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

test('listJournal / readJournal：非法 id 也拒绝（防路径穿越）', () => {
  const { home, paths } = makeHome()
  for (const bad of ['..', '../x', 'a/../b', 'a b', '']) {
    assert.throws(() => listJournal(paths, bad), /非法 id/, `listJournal 应拒绝 ${JSON.stringify(bad)}`)
    assert.throws(() => readJournal(paths, bad, '2026-09-09'), /非法 id/, `readJournal 应拒绝 ${JSON.stringify(bad)}`)
  }
  rmSync(home, { recursive: true, force: true })
})

test('createAgent：新建的伙伴带 preset-md 注入行', () => {
  // 这条原来通过已删除的 usesPresetMd() 断言，改成直接读文件——
  // 「新建伙伴要能直接生效」这个行为本身仍值得锁住。
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'W' })
  const text = readFileSync(join(paths.presetsRoot, agent.id, 'agent.cordis.yml'), 'utf8')
  assert.match(text, /^[ \t]*-[ \t]*id:[ \t]*preset-md[ \t]*$/m, '新建的伙伴应带 preset 行')
  assert.match(text, /name:[ \t]*dsh-preset-md\/preset/, '行名要指向 preset 子路径入口')
  rmSync(home, { recursive: true, force: true })
})

test('writeAgentFile：写入走串行队列，await 后内容已落盘', async () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'Q' })
  await writeAgentFile(paths, agent.id, 'MEMORY.md', '一')
  await writeAgentFile(paths, agent.id, 'MEMORY.md', '二')
  assert.equal(readAgent(paths, agent.id).files['MEMORY.md'], '二')

  // 并发写同一文件不能互相覆盖成半成品
  await Promise.all([
    writeAgentFile(paths, agent.id, 'MEMORY.md', 'A'),
    writeAgentFile(paths, agent.id, 'MEMORY.md', 'B'),
    writeAgentFile(paths, agent.id, 'MEMORY.md', 'C'),
  ])
  assert.equal(readAgent(paths, agent.id).files['MEMORY.md'], 'C')
  rmSync(home, { recursive: true, force: true })
})

test('writeAgentFile：非法 id / 白名单外仍同步抛错', () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'R' })
  assert.throws(() => writeAgentFile(paths, '../x', 'MEMORY.md', 'x'), /非法 id/)
  assert.throws(() => writeAgentFile(paths, agent.id, 'notes.txt', 'x'), /不允许写/)
  assert.throws(() => writeAgentFile(paths, agent.id, '../evil.md', 'x'), /不允许写/)
  // 设置页有 6 个 TAB，Host 端允许写这 6 个文件（白名单来自 PRESET_FILES）；
  // 只有「AI 自动记忆」才被限制在 4 个文件内（见 memory-store 的 EDITABLE_FILES）
  assert.doesNotThrow(() => writeAgentFile(paths, agent.id, 'SYSTEM.md', 'x'))
  rmSync(home, { recursive: true, force: true })
})

test('三条文件清单必须一致：core.DEFAULT_FILES / templates.PRESET_FILES / client.MD_TABS', () => {
  /*
   * 「六个 MD 文件」这份清单在源码里存在**三处**：
   *   src/core.js:37   DEFAULT_FILES    —— 拼系统提示词用（只要文件名）
   *   src/templates.mjs PRESET_FILES    —— 生成模板 + Host 白名单（文件 + 中文标签）
   *   client/client.js  MD_TABS         —— 设置页页签（文件 + 中文标签）
   *
   * 三处各写一份、谁都不锁谁。实测后果：把 client 的 `AGENTS.md` 改成
   * `AGENTS_TYPO.md`，159 条测试**全部通过**——设置页会去读一个不存在的文件，
   * 而没有任何测试能发现。这正是「同一份数据多处硬编码」的典型代价。
   *
   * 这条把三者锁在一起：任一处漂移、增删文件、或顺序错位都会立刻红。
   */
  const clientSource = readFileSync(
    new URL('../client/client.js', import.meta.url), 'utf8',
  )
  const tabs = [...clientSource.matchAll(/\{ file: '([A-Z]+\.md)', label: '([^']+)' \}/g)]
    .map((m) => ({ file: m[1], label: m[2] }))

  assert.deepEqual(
    tabs.map((t) => t.file),
    DEFAULT_FILES,
    'client 的页签文件必须与 core.DEFAULT_FILES 完全一致（含顺序）',
  )
  assert.deepEqual(
    PRESET_FILES.map((item) => item.file),
    DEFAULT_FILES,
    'templates.PRESET_FILES 必须与 core.DEFAULT_FILES 一致',
  )
  assert.deepEqual(
    tabs,
    PRESET_FILES.map((item) => ({ file: item.file, label: item.label })),
    'client 的页签标签必须与 templates.PRESET_FILES 一致（否则设置页与模板文案会打架）',
  )
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

test('设置：越界/错误类型回落到默认值（0 会让每轮都触发回顾）', () => {
  const { home, paths } = makeHome()

  // 阈值 0 / 负数 / 空串 / 非数字 → 回落默认，不能退化成「每轮都跑 LLM」
  for (const bad of [0, -5, '', 'abc', NaN]) {
    assert.equal(writeSettings(paths, { reviewTurns: bad }).reviewTurns, DEFAULT_SETTINGS.reviewTurns, `reviewTurns=${String(bad)}`)
  }
  assert.equal(writeSettings(paths, { reviewChars: 0 }).reviewChars, DEFAULT_SETTINGS.reviewChars)
  assert.equal(writeSettings(paths, { reviewChars: -1 }).reviewChars, DEFAULT_SETTINGS.reviewChars)

  // 布尔键只接受真布尔：字符串 "false" 是真值，会让开关静默失效
  assert.equal(writeSettings(paths, { autoMemory: 'false' }).autoMemory, DEFAULT_SETTINGS.autoMemory)
  assert.equal(writeSettings(paths, { budgetNotice: 'no' }).budgetNotice, DEFAULT_SETTINGS.budgetNotice)

  // 已移除的开关（freeze / complete）不该再出现在设置里 —— 传了也不落盘
  const afterRemoved = writeSettings(paths, { freeze: true, complete: true })
  assert.ok(!('freeze' in afterRemoved), 'freeze 已移除，不该被写入设置')
  assert.ok(!('complete' in afterRemoved), 'complete 已移除，不该被写入设置')

  // 合法值正常生效，小数向下取整
  assert.equal(writeSettings(paths, { reviewTurns: 7.9 }).reviewTurns, 7)
  assert.equal(writeSettings(paths, { reviewTurns: 1 }).reviewTurns, 1)
  assert.equal(writeSettings(paths, { autoMemory: false }).autoMemory, false)

  // 磁盘上被手工写脏的值，读取时也要被夹回来
  writeFileSync(paths.settingsFile, JSON.stringify({ reviewTurns: 0, autoMemory: 'false' }), 'utf8')
  const read = readSettings(paths)
  assert.equal(read.reviewTurns, DEFAULT_SETTINGS.reviewTurns)
  assert.equal(read.autoMemory, DEFAULT_SETTINGS.autoMemory)
  rmSync(home, { recursive: true, force: true })
})

test('readAgent：非法 id / 不存在的 id 报错', () => {
  const { home, paths } = makeHome()
  assert.throws(() => readAgent(paths, '../x'), /非法 id/)
  assert.throws(() => readAgent(paths, 'nope'), /伙伴不存在/)
  rmSync(home, { recursive: true, force: true })
})
