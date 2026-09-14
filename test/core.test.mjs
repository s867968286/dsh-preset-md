/**
 * dsh-preset-md 核心逻辑单测（零依赖，node --test）。
 * 不需要 dsh 进程：用假 ctx 驱动 registerPrompt。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_FILES,
  FILE_WEIGHTS,
  PLACEHOLDERS,
  PROMPT_SECTION,
  PROMPT_VARIABLE,
  applyToolRestriction,
  contextBudgetNotice,
  contextFacts,
  createSessionFreeze,
  estimateTokens,
  expandHome,
  matchToolName,
  measureContext,
  normalizeConfig,
  normalizeToolFilter,
  readAggregateText,
  readSectionText,
  registerPrompt,
  resolvePresetDir,
  sessionEvents,
  sessionKeyOf,
  substitutePlaceholders,
  toDirectoryPath,
} from '../src/core.js'

/** 建一个临时预设目录。 */
function makePresetDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8')
  return dir
}

/** 假 ctx：记录 section / variable 注册，effect 立即执行。 */
function makeCtx(baseUrl) {
  const sections = []
  const variables = new Map()
  return {
    baseUrl,
    sections,
    variables,
    effect(fn) {
      return fn()
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        // 真实注册表是「按名字唯一」的：disposer 必须真的撤掉，
        // 否则测不出「撤旧建新」是否正确（同名重复注册在真实环境会抛错）。
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      variable(name, provider) {
        variables.set(name, provider)
        return () => {}
      },
    },
  }
}

const asSession = (id) => ({ agent: { id, session: { id } } })

test('expandHome：~ 与 ~/x 展开，其余原样', () => {
  assert.ok(expandHome('~').length > 1)
  assert.ok(expandHome('~/a/b').endsWith(join('a', 'b')))
  assert.equal(expandHome('C:/x'), 'C:/x')
})

test('toDirectoryPath：file URL 与绝对路径都能解析，相对路径返回空', () => {
  const dir = makePresetDir()
  assert.equal(toDirectoryPath(pathToFileURL(dir).href), dir)
  assert.equal(toDirectoryPath(dir), dir)
  assert.equal(toDirectoryPath('./rel'), '')
  assert.equal(toDirectoryPath(''), '')
  rmSync(dir, { recursive: true, force: true })
})

test('默认清单与占位符', () => {
  assert.deepEqual(DEFAULT_FILES, ['SYSTEM.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md'])
  assert.deepEqual(PLACEHOLDERS, ['cwd', 'preset', 'presetDir', 'session'])
})

test('normalizeConfig：只认 tools，其余字段忽略', () => {
  const config = normalizeConfig({ dir: 'C:/x', files: ['a.md'], maxBytes: 10, tools: { deny: ['mnemon*'] } })
  assert.deepEqual(config, { tools: { allow: [], deny: ['mnemon*'] } })
  assert.deepEqual(normalizeConfig(undefined), { tools: { allow: [], deny: [] } })
})

test('normalizeToolFilter：去重、丢弃非字符串', () => {
  assert.deepEqual(normalizeToolFilter(undefined), { allow: [], deny: [] })
  assert.deepEqual(normalizeToolFilter({ allow: ['a', 'a', '', 3], deny: ['b'] }), { allow: ['a'], deny: ['b'] })
})

test('resolvePresetDir：只认 ctx.baseUrl', () => {
  const dir = makePresetDir()
  assert.equal(resolvePresetDir({ baseUrl: pathToFileURL(dir).href }), dir)
  assert.equal(resolvePresetDir({}), '')
  assert.equal(resolvePresetDir(undefined), '')
  rmSync(dir, { recursive: true, force: true })
})

test('readSectionText / readAggregateText：原样读取、按序拼接、跳过空', () => {
  const dir = makePresetDir({ 'SOUL.md': '  人格  \n', 'IDENTITY.md': '身份', 'USER.md': '   ' })
  assert.equal(readSectionText(join(dir, 'SOUL.md')), '人格')
  assert.equal(readSectionText(join(dir, 'USER.md')), '')
  assert.equal(readSectionText(join(dir, 'MISSING.md')), '')
  assert.equal(readSectionText(''), '')
  assert.equal(readAggregateText(dir), '人格\n\n身份')
  assert.equal(readAggregateText(''), '')
  rmSync(dir, { recursive: true, force: true })
})

test('sessionKeyOf：兼容 assemble context / agent / 空值', () => {
  assert.equal(sessionKeyOf({ agent: { id: 'a1', session: { id: 's1' } } }), 's1')
  assert.equal(sessionKeyOf({ id: 'a1', session: { id: 's1' } }), 's1')
  assert.equal(sessionKeyOf({ id: 'a1' }), 'a1')
  assert.equal(sessionKeyOf({}), '')
})

test('sessionEvents：ownEvents 优先于 snapshotEvents（fork 前缀不得被当成本会话事件）', () => {
  /*
   * 真事故（2026-09-14 实测）：fork 派生的子代理会话，磁盘上带着父会话的完整历史
   * （本机 7 个 presetmd 子会话 seedLength 4640～68054，事件流前数百条全是父会话内容）。
   *
   * 官方契约（dsh-session/lib/types/index.d.ts）：
   *   snapshotEvents() → 全量，**含 fork 继承前缀**
   *   ownEvents()      → 仅 "after its fork-inherited prefix"
   *
   * 若优先 snapshotEvents()，`grown` 会在会话第一轮就把整个继承前缀算成「新增」——
   * 实测这些子会话的转写有 90%～99% 是父会话内容（仅自有 95～113 字符 vs 全量 4363～7889），
   * 于是每个 fork 子会话第 1 轮必然越线触发，且回顾总结的是"父会话做了什么"。
   */
  const inherited = [{ type: 'user/message', data: { content: [{ type: 'text', text: '父会话的内容' }] } }]
  const own = [{ type: 'user/message', data: { content: [{ type: 'text', text: '子会话自己的内容' }] } }]

  // 两者都有时必须取 ownEvents —— 这正是一条真实 fork Session 的形态
  const forked = { id: 's1', snapshotEvents: () => inherited, ownEvents: () => own }
  assert.deepEqual(sessionEvents(forked), own, 'ownEvents 必须优先，否则父会话内容会灌满阈值')
  assert.notDeepEqual(sessionEvents(forked), inherited)

  // 只有 snapshotEvents 时才用它兜底（非 fork 会话/旧形态）
  const plain = [{ type: 'user/message', data: { content: [{ type: 'text', text: '普通会话' }] } }]
  assert.deepEqual(sessionEvents({ id: 's1', snapshotEvents: () => plain }), plain)

  // 假 ctx / 旧形态：只有 events 数组
  assert.equal(sessionEvents({ events: [{ type: 'x' }] }).length, 1)

  // 什么都没有、或非对象 → 空数组，不抛错
  assert.deepEqual(sessionEvents({}), [])
  assert.deepEqual(sessionEvents(undefined), [])
  assert.deepEqual(sessionEvents(null), [])

  // ownEvents 抛错或返回非数组 → 静默回落到 snapshotEvents
  assert.deepEqual(
    sessionEvents({ ownEvents: () => { throw new Error('boom') }, snapshotEvents: () => plain }),
    plain,
  )
  assert.equal(sessionEvents({ ownEvents: () => undefined, snapshotEvents: () => plain }).length, 1)
  // 两档都不可用 → 落到 events 数组
  const fallback = { ownEvents: () => { throw new Error('a') }, snapshotEvents: () => { throw new Error('b') }, events: [{ type: 'z' }] }
  assert.equal(sessionEvents(fallback).length, 1)
})

test('registerPrompt：section 只注册一次（complete 固定为 true，不再可切换）', () => {
  /*
   * `complete` 与 `freeze` 两个开关已移除：我们始终只用一种模式
   * （独占系统提示词 + 会话内冻结），没有「运行时撤旧建新 section」的需要。
   * 这条锁住「只注册一次、且始终带 complete」这个简化后的事实 ——
   * 若有人重新引入切换逻辑，这里会因为 section 被重复注册/丢失 complete 而失败。
   */
  const dir = makePresetDir({ 'SOUL.md': 'x' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, { getSettings: () => ({ budgetNotice: false }) })
  const read = ctx.variables.get(PROMPT_VARIABLE)

  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].complete, true, '必须始终独占（否则官方提示词会与我们的 MD 并存）')
  assert.equal(ctx.sections[0].text, `{{${PROMPT_VARIABLE}}}`, '文本只引用变量')

  // 多次渲染不应重复注册，也不应丢掉 complete
  read(asSession('s1'))
  read(asSession('s2'))
  assert.equal(ctx.sections.length, 1, 'section 只注册一次，渲染不该增删')
  assert.equal(ctx.sections[0].complete, true)

  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：budgetNotice 实时开关（关掉后不再注入收敛提醒）', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(3000) })
  const ctx = makeCtx(pathToFileURL(dir).href)
  let budgetNotice = true
  registerPrompt(ctx, { getSettings: () => ({ budgetNotice, contextBudget: 1000 }) })
  const read = ctx.variables.get(PROMPT_VARIABLE)

  // 注意：正文按会话冻结，所以用不同会话 id 取「当前设置下」的渲染结果
  assert.ok(read(asSession('s1')).includes('上下文预算提醒'))
  budgetNotice = false
  assert.ok(!read(asSession('s2')).includes('上下文预算提醒'), '关掉后应实时停止注入')

  rmSync(dir, { recursive: true, force: true })
})

test('createSessionFreeze：只算一次、可清理', () => {
  const freeze = createSessionFreeze()
  let calls = 0
  const factory = () => `v${(calls += 1)}`
  assert.equal(freeze.get('s1', factory), 'v1')
  assert.equal(freeze.get('s1', factory), 'v1')
  assert.equal(freeze.get('s2', factory), 'v2')
  assert.equal(calls, 2)
  freeze.clear('s1')
  assert.equal(freeze.size, 1)
  freeze.clearAll()
  assert.equal(freeze.size, 0)
})

test('contextFacts / substitutePlaceholders', () => {
  const facts = contextFacts({ agent: { session: { id: 's1', header: { cwd: 'D:/ws', agentPreset: 'demo' } } } })
  assert.deepEqual(facts, { cwd: 'D:/ws', preset: 'demo', presetDir: '', session: 's1' })
  assert.deepEqual(contextFacts(undefined), { cwd: '', preset: '', presetDir: '', session: '' })
  assert.equal(substitutePlaceholders('目录 {{cwd}}', facts), '目录 D:/ws')
  assert.equal(substitutePlaceholders('{{ preset }}', facts), 'demo')
  assert.equal(substitutePlaceholders('{{unknown}}', facts), '{{unknown}}')
  assert.equal(substitutePlaceholders('{{cwd}}', { cwd: '' }), '{{cwd}}')
})

test('contextFacts / substitutePlaceholders：presetDir 独立于 preset', () => {
  const facts = contextFacts(
    { agent: { session: { id: 's1', header: { cwd: 'D:/ws', agentPreset: 'agent-1bd5' } } } },
    'C:/Users/x/.dsh/.agent-presets/agent-1bd5',
  )
  assert.equal(facts.preset, 'agent-1bd5', 'preset 仍是 id，不是路径')
  assert.equal(facts.presetDir, 'C:/Users/x/.dsh/.agent-presets/agent-1bd5')

  assert.equal(
    substitutePlaceholders('预设目录（{{presetDir}}），id={{preset}}', facts),
    '预设目录（C:/Users/x/.dsh/.agent-presets/agent-1bd5），id=agent-1bd5',
  )
  // presetDir 排在前：不会被 preset 抢先匹配掉
  assert.equal(substitutePlaceholders('{{presetDir}}', { preset: 'id', presetDir: 'D:/p' }), 'D:/p')
  // 取不到值 → 原样保留
  assert.equal(substitutePlaceholders('{{presetDir}}', { presetDir: '' }), '{{presetDir}}')
  assert.equal(substitutePlaceholders('{{presetDir}}', {}), '{{presetDir}}')
  assert.equal(substitutePlaceholders('{{ presetDir }}', { presetDir: 'D:/p' }), 'D:/p')
})

test('registerPrompt：变量承载内容 + 唯一 complete section', () => {
  const dir = makePresetDir({ 'SOUL.md': '人格文本', 'MEMORY.md': '记忆文本' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  const result = registerPrompt(ctx)

  assert.equal(result.dir, dir)
  assert.deepEqual(ctx.sections, [{ name: PROMPT_SECTION, order: 0, text: `{{${PROMPT_VARIABLE}}}`, complete: true }])
  assert.equal(ctx.variables.get(PROMPT_VARIABLE)(asSession('s1')), '人格文本\n\n记忆文本')
  rmSync(dir, { recursive: true, force: true })
})

test('端到端：MD 正文里的花括号不会被官方插值解析（走真实 interpolate）', async () => {
  /*
   * 这是**协议依赖型安全**，必须用真实渲染链路锁住，不能只测 substitutePlaceholders。
   *
   * 机制：section 的 text 只有 `{{preset_md}}` 一个占位符，MD 正文全在**变量右值**里；
   * 官方 `interpolate()` 明确「替换值不再被扫描」（源码注释
   * "substituted values are not scanned again"），所以正文里的 `{{…}}` 原样保留。
   *
   * 为什么必须端到端：任何把正文挪回 `section.text` 的重构都会立刻破坏这一点——
   * 官方严格校验未知变量名 / 非法名字并**抛错**（实测 `{{hl|}}`、`{{挖空}}`、
   * `{{{triple}}}`、`{{.Server.Version}}` 全部抛错），而局部单测看不出这个回归。
   */
  const renderPrompt = await loadOfficialRenderPrompt()
  if (!renderPrompt) return // 找不到 host 官方包时跳过（不装 host 的 CI 仍能跑其余用例）

  const bodies = [
    '{{cwd}}',           // 已知占位符名：若被当 section 文本会抛 unknown variable
    '{{unknown}}',
    '{{hl|}}',           // wiki 模板语法
    '{{挖空}}',           // 中文
    '{{{triple}}}',      // 三层括号
    '{{我的暗号}}',
    '{{.Server.Version}}',
    '{{ preset }}',
    '{{',               // 无闭合（末尾空白会被 readSectionText trim 掉）
  ]

  for (const body of bodies) {
    const dir = makePresetDir({ 'SOUL.md': body })
    const ctx = makeCtx(pathToFileURL(dir).href)
    registerPrompt(ctx, { freeze: false })

    // 取本插件实际注册的 section 与变量，走官方真实渲染
    const section = ctx.sections[0]
    const rendered = renderPrompt({
      sections: [{ name: section.name, order: section.order, text: section.text }],
      variables: { [PROMPT_VARIABLE]: ctx.variables.get(PROMPT_VARIABLE)(asSession('s1')) },
      contexts: [],
      tools: [],
    })

    assert.ok(rendered.includes(body), `正文 ${JSON.stringify(body)} 应原样保留，实际渲染为 ${JSON.stringify(rendered)}`)
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 从 host 安装位置加载官方 `renderPrompt`。
 *
 * 本仓库的 node_modules 里没有 `@deepseek-ai/dsh-system-prompt`（它是 host 的依赖），
 * 所以要动态解析；找不到就返回 null 让用例跳过——静默 return 会让这条端到端锁
 * 形同虚设，所以这里按「本地 → dsh 自带依赖 → node prefix」逐级尽力去找。
 */
async function loadOfficialRenderPrompt() {
  const { createRequire } = await import('node:module')
  const here = createRequire(import.meta.url)
  const nodePrefix = dirname(process.execPath)

  // 候选 require 锚点：从各自锚点解析 @deepseek-ai/dsh-system-prompt
  const anchors = [
    import.meta.url,
    join(nodePrefix, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(nodePrefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'index.js'),
    join(nodePrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]

  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      // 直接解析入口（package.json 的 exports 可能不暴露 package.json 本身）
      const entry = req.resolve('@deepseek-ai/dsh-system-prompt')
      const mod = await import(pathToFileURL(entry).href)
      if (typeof mod.renderPrompt === 'function') return mod.renderPrompt
    } catch {
      /* 试下一个锚点 */
    }
  }
  return null
}

test('registerPrompt：会话内冻结（同一会话读盘一次，新会话重读）', () => {
  /*
   * 冻结现在是**固定行为**（开关已移除）：同一会话只读一次文件，
   * 改文件要新开对话才生效 —— 这是为 KV 缓存稳定付出的代价，见 README。
   */
  const dir = makePresetDir({ 'SOUL.md': '第一版' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx)
  const read = ctx.variables.get(PROMPT_VARIABLE)
  assert.equal(read(asSession('s1')), '第一版')
  writeFileSync(join(dir, 'SOUL.md'), '第二版', 'utf8')
  assert.equal(read(asSession('s1')), '第一版', '同一会话内必须冻结')
  assert.equal(read(asSession('s2')), '第二版', '新会话要重读')

  // 明确移除的能力：不再有「关掉冻结、每步重读」这条路径
  const liveCtx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(liveCtx, { freeze: false })   // 未知选项应被静默忽略
  const live = liveCtx.variables.get(PROMPT_VARIABLE)
  assert.equal(live(asSession('s1')), '第二版')
  writeFileSync(join(dir, 'SOUL.md'), '第三版', 'utf8')
  assert.equal(live(asSession('s1')), '第二版', 'freeze 选项已移除，传入也不该每步重读')
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：缓存命中后不再读盘（每步返回同一份，且不做变化探测）', () => {
  /*
   * 这是冻结的**机制**锁：官方每个 pre-step 都会调变量 provider 一次，
   * 所以我们必须在缓存命中时**一次盘都不读**，才能保证系统提示词逐字节恒定
   * （它是请求前缀，一变则后面全部丢失 KV 缓存命中）。
   *
   * 做法：删除源文件后仍然命中缓存 —— 若实现里还有「探测文件是否变化」
   * 或「缓存未命中就重读」的逻辑，删文件后必然变成空串或抛错。
   * 同时也证明我们**不做任何变更探测**，是否重发交给官方判断。
   */
  const dir = makePresetDir({ 'SOUL.md': '原始内容' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx)
  const read = ctx.variables.get(PROMPT_VARIABLE)
  const session = asSession('s1')

  assert.equal(read(session), '原始内容', '首次读盘')

  // 把整个预设目录删掉：缓存命中就不该再碰文件系统
  rmSync(dir, { recursive: true, force: true })
  assert.equal(read(session), '原始内容', '缓存命中后即使文件不存在也应返回同一份（没读盘）')

  // 模拟官方每步调用：多次读取必须完全一致
  const values = new Set([read(session), read(session), read(session)])
  assert.equal(values.size, 1, '每步返回值必须逐字节一致')

  // 新会话拿不到文件 → 空串（证明它确实去读盘了，只是旧会话已缓存）
  assert.equal(read(asSession('s2')), '', '新会话要重新读盘；文件已删则得空串')
})

test('registerPrompt：注入预算与超限提醒同样按会话冻结（新会话才取新值）', () => {
  /*
   * 缓存边界：`cache.get` 包住的是「读 MD + 占位符替换 + 超限提醒」**整段**。
   * 所以注入预算与超限提醒开关**也**随会话冻结 —— 同一会话内改了要新开会话才生效。
   *
   * 这是为「系统提示词在会话内逐字节恒定」付出的代价（它是请求前缀，一变则
   * 后面全部丢失 KV 缓存命中）。这条锁住这个既成事实，避免有人误以为它们实时。
   */
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(3000) })
  const ctx = makeCtx(pathToFileURL(dir).href)
  let budgetNotice = true
  registerPrompt(ctx, { getSettings: () => ({ budgetNotice, contextBudget: 1000 }) })
  const read = ctx.variables.get(PROMPT_VARIABLE)
  const s1 = asSession('s1')

  assert.ok(read(s1).includes('上下文预算提醒'), '初始应注入提醒')
  budgetNotice = false
  assert.ok(read(s1).includes('上下文预算提醒'), '同一会话内仍返回旧渲染（被冻结）')
  assert.ok(!read(asSession('s2')).includes('上下文预算提醒'), '新会话取到新设置')
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：占位符按会话替换并参与冻结；目录未知返回空串', () => {
  const dir = makePresetDir({ 'SYSTEM.md': 'cwd={{cwd}}' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, {})
  const read = ctx.variables.get(PROMPT_VARIABLE)
  const session = (cwd) => ({ agent: { session: { id: 's1', header: { cwd } } } })
  assert.equal(read(session('D:/ws')), 'cwd=D:/ws')
  assert.equal(read(session('D:/other')), 'cwd=D:/ws')

  const emptyCtx = makeCtx(undefined)
  const empty = registerPrompt(emptyCtx, {})
  assert.equal(empty.dir, '')
  assert.equal(emptyCtx.variables.get(PROMPT_VARIABLE)(asSession('s1')), '')
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：{{presetDir}} 注入为预设目录绝对路径，与 {{cwd}} 相互独立', () => {
  const dir = makePresetDir({ 'SYSTEM.md': '工作目录：{{cwd}}\n预设目录：{{presetDir}}' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, {})
  const read = ctx.variables.get(PROMPT_VARIABLE)
  const session = (cwd) => ({ agent: { session: { id: 's1', header: { cwd } } } })

  assert.equal(read(session('D:/ws')), `工作目录：D:/ws\n预设目录：${dir}`)
  const other = read(session('D:/other'))
  assert.ok(other.includes(`预设目录：${dir}`), 'presetDir 不随 cwd 变化')
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：模板里未出现的占位符不影响输出', () => {
  const dir = makePresetDir({ 'AGENTS.md': '这个预设目录（{{presetDir}}）就是你的家' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, {})
  assert.equal(ctx.variables.get(PROMPT_VARIABLE)(asSession('s1')), `这个预设目录（${dir}）就是你的家`)
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：取不到会话 id 时按 cwd 分桶，不共用同一份缓存', () => {
  const dir = makePresetDir({ 'SYSTEM.md': '工作目录：{{cwd}}' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  const prompt = registerPrompt(ctx, {})
  const read = ctx.variables.get(PROMPT_VARIABLE)

  // 没有 session.id / agent.id 的上下文
  const noId = (cwd) => ({ session: { header: { cwd } } })
  assert.equal(read(noId('D:/ws-a')), '工作目录：D:/ws-a')
  assert.equal(read(noId('D:/ws-b')), '工作目录：D:/ws-b', '不同 cwd 不能被第一份缓存污染')
  assert.equal(read(noId('D:/ws-a')), '工作目录：D:/ws-a', '同 cwd 仍然命中缓存')

  // 两个不同的缓存键（而不是共用一个常量键）
  const keyA = prompt.cacheKeyOf(noId('D:/ws-a'))
  const keyB = prompt.cacheKeyOf(noId('D:/ws-b'))
  assert.notEqual(keyA, keyB)
  assert.equal(prompt.cache.size, 2)
  assert.equal(prompt.cacheKeyOf(noId('D:/ws-a')), keyA, '同一 cwd 的键要稳定')

  // 有会话 id 时仍然按 id 分桶
  assert.equal(prompt.cacheKeyOf(asSession('s9')), 's9')
  rmSync(dir, { recursive: true, force: true })
})

test('estimateTokens：按 DeepSeek 口径估算（1 汉字 ≈ 0.6 token）', () => {
  assert.equal(estimateTokens(''), 0)
  // 10 个汉字 ≈ 6 token
  assert.equal(estimateTokens('一二三四五六七八九十'), 6)
  // ASCII 权重明显低于汉字
  assert.ok(estimateTokens('a'.repeat(100)) < estimateTokens('一'.repeat(100)))
})

test('measureContext：按比例瓜分整体预算，只在总量超限时报 over', () => {
  const dir = makePresetDir({
    'SYSTEM.md': '一'.repeat(100),
    'MEMORY.md': '二'.repeat(500),
  })
  const measure = measureContext(dir, { budgetChars: 1000 })
  assert.equal(measure.totalChars, 600)
  assert.equal(measure.over, false, '总量没超预算就不该报 over')
  assert.equal(measure.budgetChars, 1000)

  // 各文件占比之和为 1
  const shareSum = measure.files.reduce((n, row) => n + row.share, 0)
  assert.ok(Math.abs(shareSum - 1) < 1e-9, '占比之和应为 1')

  // 权重表合计为 1
  const weightSum = Object.values(FILE_WEIGHTS).reduce((n, w) => n + w, 0)
  assert.ok(Math.abs(weightSum - 1) < 1e-9, '权重合计应为 1')

  rmSync(dir, { recursive: true, force: true })
})

test('measureContext：单文件偏大但总量没超 → over 为假、不提示', () => {
  // MEMORY.md 占 90%，远超它的 25% 份额，但总量仍低于预算
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(900), 'SOUL.md': '二'.repeat(100) })
  const measure = measureContext(dir, { budgetChars: 2000 })
  assert.equal(measure.over, false)
  assert.equal(contextBudgetNotice(measure), '', '总量没超就不该产出提醒')
  rmSync(dir, { recursive: true, force: true })
})

test('contextBudgetNotice：总量超限才产出提醒，并点名偏重文件', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(2000), 'SOUL.md': '二'.repeat(100) })
  const measure = measureContext(dir, { budgetChars: 1000 })
  assert.equal(measure.over, true)
  const notice = contextBudgetNotice(measure)
  assert.ok(notice.includes('上下文预算提醒'))
  assert.ok(notice.includes('MEMORY.md'), '应点名偏重的文件')
  assert.ok(notice.includes('收敛'))
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：总量超预算时把收敛提醒附在提示词末尾', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(3000) })
  const ctx = makeCtx(pathToFileURL(dir).href)
  // 预算/超限提醒现在只能经 getSettings 提供（静态 options 回退已随开关移除）
  registerPrompt(ctx, { getSettings: () => ({ contextBudget: 1000, budgetNotice: true }) })
  const text = ctx.variables.get(PROMPT_VARIABLE)(asSession('s1'))
  assert.ok(text.includes('## 上下文预算提醒'))
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：总量没超预算时提示词里没有提醒', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(100) })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, { getSettings: () => ({ contextBudget: 1000, budgetNotice: true }) })
  const text = ctx.variables.get(PROMPT_VARIABLE)(asSession('s1'))
  assert.ok(!text.includes('上下文预算提醒'))
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：超限提醒可单独关掉（只度量不注入）', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(3000) })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, { getSettings: () => ({ contextBudget: 1000, budgetNotice: false }) })
  const text = ctx.variables.get(PROMPT_VARIABLE)(asSession('s1'))
  assert.ok(!text.includes('上下文预算提醒'), '关掉后不该注入提醒')
  assert.ok(text.includes('一'), '正文照常注入')
  rmSync(dir, { recursive: true, force: true })
})

test('matchToolName：前缀 aa* / 后缀 *bb / 包含 *cc* / 精确 ddd', () => {
  assert.equal(matchToolName('mnemon*', 'mnemon_recall'), true)
  assert.equal(matchToolName('mnemon*', 'read_page'), false)
  assert.equal(matchToolName('*_recall', 'mnemon_recall'), true)
  assert.equal(matchToolName('*nem*', 'mnemon_recall'), true)
  assert.equal(matchToolName('*xyz*', 'mnemon_recall'), false)
  assert.equal(matchToolName('mnemon_recall', 'mnemon_recall'), true)
  assert.equal(matchToolName('mnemon_recall', 'mnemon_remember'), false)
  assert.equal(matchToolName('mnemon*recall', 'mnemon_recall'), false)
  assert.equal(matchToolName('*', 'mnemon_recall'), false)
  assert.equal(matchToolName('', 'x'), false)
})

test('applyToolRestriction：展开成精确名单、未命中的单独报告', () => {
  const calls = []
  const ctx = {
    tools: {
      schemas: () => [{ name: 'mnemon_recall' }, { name: 'mnemon_remember' }, { name: 'read_page' }],
      restrict: (filter) => calls.push(filter),
    },
  }
  const result = applyToolRestriction(ctx, { allow: [], deny: ['mnemon*', 'nope*'] })
  assert.equal(result.applied, true)
  assert.deepEqual(calls, [{ deny: ['mnemon_recall', 'mnemon_remember'] }])
  assert.deepEqual(result.unmatched, ['nope*'])
})

test('applyToolRestriction：allow 与 deny 同时给；全不命中不下发；无可见工具不下发', () => {
  const calls = []
  const ctx = {
    tools: {
      schemas: () => [{ name: 'mnemon_recall' }, { name: 'read_page' }],
      restrict: (filter) => calls.push(filter),
    },
  }
  const result = applyToolRestriction(ctx, { allow: ['read_page'], deny: ['*_recall'] })
  assert.deepEqual(calls, [{ allow: ['read_page'], deny: ['mnemon_recall'] }])
  assert.deepEqual(result.unmatched, [])

  assert.equal(applyToolRestriction(ctx, { allow: ['nope'], deny: [] }).applied, false)
  assert.equal(calls.length, 1)

  const empty = applyToolRestriction({ tools: { schemas: () => [], restrict: () => {} } }, { allow: [], deny: ['a'] })
  assert.equal(empty.applied, false)
  assert.match(empty.reason, /没有可见工具/)
})

test('applyToolRestriction：restrict 抛错与 ctx.tools 缺失都降级', () => {
  const throwing = {
    tools: {
      schemas: () => [{ name: 'a' }],
      restrict: () => {
        throw new Error('scope 缺失')
      },
    },
  }
  const failed = applyToolRestriction(throwing, { allow: [], deny: ['a'] })
  assert.equal(failed.applied, false)
  assert.match(failed.reason, /scope 缺失/)

  const missing = applyToolRestriction({}, { allow: [], deny: ['a'] })
  assert.equal(missing.applied, false)
  assert.match(missing.reason, /不可用/)
})

/*
 * 回归防线：dsh 0.1.5-rc.2 起 `schemas()` 在非 native 呈现模式（进程设了
 * DSH_TOOLS_MODE=both|ptc）下会先 requireCodeRuntime(mode)，缺 codeRuntime 就整份
 * 名单读不出来，deny 静默失效（现象：工具照样出现在模型工具表里）。
 * 因此主路径必须是不做 schema 投影的 view().restrictableNames。
 */
test('applyToolRestriction：schemas 抛错也能靠 view 拿到名单（0.1.5-rc.2 回归）', () => {
  const calls = []
  const viewArgs = []
  /*
   * 同时钉死两件事：
   * 1. 主路径走 view().restrictableNames，与 schemas() 是否可用无关；
   * 2. 绝不读 `ctx.agent`（下面用 getter 陷阱模拟 cordis：读到就抛
   *    `cannot get property "agent" without inject`）。收窄不需要 agent，
   *    restrict() 自己解析 scope。
   */
  const ctx = {
    tools: {
      view: (...args) => {
        viewArgs.push(args.length)
        return { restrictableNames: new Set(['mnemon_recall', 'mnemon_remember', 'read']) }
      },
      schemas: () => {
        throw new Error('mode "both" requires a code runtime')
      },
      restrict: (filter) => calls.push(filter),
    },
  }
  Object.defineProperty(ctx, 'agent', {
    enumerable: true,
    get() {
      throw new Error('cannot get property "agent" without inject')
    },
  })
  const result = applyToolRestriction(ctx, { allow: [], deny: ['mnemon*'] })
  assert.equal(result.applied, true)
  assert.deepEqual(calls, [{ deny: ['mnemon_recall', 'mnemon_remember'] }])
  assert.deepEqual(viewArgs, [0])
})

test('applyToolRestriction：没有 view 时回落 schemas 列举', () => {
  const calls = []
  const ctx = {
    tools: {
      schemas: () => [{ name: 'mnemon_recall' }, { name: 'read' }],
      restrict: (filter) => calls.push(filter),
    },
  }
  const result = applyToolRestriction(ctx, { allow: [], deny: ['mnemon*'] })
  assert.equal(result.applied, true)
  assert.deepEqual(calls, [{ deny: ['mnemon_recall'] }])
})

test('applyToolRestriction：两条路径都抛错时报告真实原因', () => {
  const ctx = {
    tools: {
      view: () => {
        throw new Error('view boom')
      },
      schemas: () => {
        throw new Error('schemas boom')
      },
      restrict: () => {},
    },
  }
  const result = applyToolRestriction(ctx, { allow: [], deny: ['mnemon*'] })
  assert.equal(result.applied, false)
  /*
   * 两条路径的异常都要留在 error 里：这是这次故障最贵的教训——真实原因被吞成一句
   * 散文，排查只能靠读 dsh 源码。
   */
  assert.match(result.error, /view boom/)
  assert.match(result.error, /schemas boom/)
})
