/**
 * 入口（src/preset.js）装配测试：提示词注册、工具收窄、
 * 检索工具注册与自动记忆触发。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply, inject, localTimestamp, name } from '../src/preset.js'
import { dateKey } from '../src/memory-store.mjs'
import { resolvePaths, writeSettings } from '../src/settings.mjs'

/*
 * 隔离 DSH_HOME：apply() 会读 `<DSH_HOME>/preset-md/settings.json`。
 * 不隔离就会读真实用户的设置——本机 reviewTurns 被改成 1 时，
 * 「轮数不足不触发」这类依赖默认阈值的用例会直接失败（结果随本机配置漂移）。
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'preset-md-home-'))
process.env.DSH_HOME = TEST_HOME

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function makeCtx(dir) {
  const sections = []
  const variables = new Map()
  const listeners = new Map()
  const registered = []
  const restricted = []
  const logs = { info: [], warn: [] }
  const stats = { suppressed: 0, streams: 0 }
  /*
   * 模型服务：`ctx.get('llm')` 与 `ctx.llm` 返回**同一个对象**。
   * 真实运行只走 ctx.get（属性访问会被 preset 的 isolate 边界拦下），
   * 而用例习惯直接替换 `ctx.llm.stream` —— 同一个对象才能让替换真正生效。
   */
  const llm = {
    stream() {
      stats.streams += 1
      return (async function* () {
        yield { type: 'text-delta', text: '{"journal":"### 讨论与解决\\n\\n聊了插件设计","updates":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return {
    baseUrl: dir ? pathToFileURL(dir).href : undefined,
    sections,
    variables,
    listeners,
    registered,
    restricted,
    logs,
    stats,
    llm,
    effect(fn) {
      return fn()
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => {}
    },
    get(service) {
      if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (service === 'llm') return llm
      return undefined
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      variable(variableName, provider) {
        variables.set(variableName, provider)
        return () => {}
      },
      suppressRuntimeContext() {
        stats.suppressed += 1
      },
    },
    tools: {
      register(definition) {
        registered.push(definition)
      },
      schemas: () => [{ name: 'mnemon_recall' }],
      restrict(filter) {
        restricted.push(filter)
      },
    },
    llm,
    logger: {
      info(message) {
        logs.info.push(String(message))
      },
      warn(message) {
        logs.warn.push(String(message))
      },
    },
  }
}

const agentWith = (text) => ({
  id: 'a1',
  session: { id: 's1', events: [{ type: 'user/message', data: { content: [{ type: 'text', text }] } }] },
})

test('导出：name / inject', () => {
  assert.equal(name, 'preset-md')
  // llm 是硬依赖：回顾最后一步要调 ctx.llm.stream。不声明 inject 会被 Cordis
  // 的属性访问守卫拦下（cannot get property "llm" without inject）。
  assert.deepEqual(inject, ['systemPrompt', 'tools'])
})

test('localTimestamp：带本地时区偏移，不用 UTC（日志时间要能跟日记对上）', () => {
  // UTC 的 12:03 在东八区是 20:03；旧实现直接 toISOString() 落成 …12:03:31Z，
  // 与日记段落、changelog 的本地时间差 8 小时，看日志还得自己换算。
  const text = localTimestamp(new Date('2026-09-11T12:03:31.650Z'))
  assert.match(text, /^2026-09-11T\d{2}:03:31\.650[+-]\d{2}:\d{2}$/)
  assert.ok(!text.endsWith('Z'), '不能是 UTC 的 Z 结尾')
  assert.match(text.slice(-6), /^[+-]\d{2}:\d{2}$/, '必须带时区偏移')
})

test('防回归：源码里用到的 ctx 服务都必须在 inject 里声明', () => {
  /*
   * 为什么需要这条静态校验：单测的假 ctx 是个普通对象，`ctx.get('x')` 直接就能取到，
   * 不受 Cordis 的属性访问守卫约束。于是「属性访问被 isolate 边界拦下」这类问题
   * 在单测里永远看不见，只在真实运行到那一步时才炸（而且是在后台、日志还看不到）。
   * 这里改成扫源码：凡是 `ctx.<标识符>` 的属性访问，要么在 inject 里，要么明确属于
   * Cordis / DSH 挂在 ctx 上的非服务成员。需要服务的读取请显式用 ctx.get()。
   */
  const NOT_SERVICES = new Set([
    // Cordis 上下文自身的方法
    'get', 'on', 'effect', 'provide',
    // DSH 挂到 ctx 上的属性与 accessor（不经过 inject 守卫）
    'logger', 'baseUrl', 'agent', 'fiber', 'reflect', 'root', 'scope', 'events', 'ctx',
  ])
  const declared = new Set(inject)
  const seen = new Set()
  for (const file of ['../src/preset.js', '../src/core.js', '../src/review.mjs', '../src/tools.mjs', '../src/search.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    // 先剥掉注释：说明文字里会出现 `ctx.llm` 这类写法，不能当成真实访问
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const match of code.matchAll(/\bctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      if (!NOT_SERVICES.has(match[1])) seen.add(match[1])
    }
  }
  const missing = [...seen].filter((name) => !declared.has(name)).sort()
  assert.deepEqual(missing, [], `这些 ctx.<服务> 属性访问没写进 inject，或应改用 ctx.get()：${missing.join(', ')}`)
})

test('apply：注册唯一 complete section + 承载内容的变量（不再抑制运行时上下文）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-entry-'))
  writeFileSync(join(dir, 'SOUL.md'), '人格', 'utf8')
  const ctx = makeCtx(dir)
  apply(ctx, {})

  assert.deepEqual(ctx.sections, [{ name: 'preset-md', order: 0, text: '{{preset_md}}', complete: true }])
  assert.equal(ctx.variables.get('preset_md')({ agent: { session: { id: 's1' } } }), '人格')
  // 抑制运行时上下文整块已按需求移除：实际收益很小（skill 目录、审批通知都是对话消息，抑制不了）
  assert.equal(ctx.stats.suppressed, 0, '不应再调用 suppressRuntimeContext')
  // 装配信息已合并成一行（目录 / 参数 / section / 文件清单），不再逐项刷屏
  assert.ok(ctx.logs.info.join('\n').includes('[preset-md] 装配 目录='))
  assert.equal(ctx.logs.warn.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('apply：注册三个记忆工具，tools.deny 下发收窄', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-tools-'))
  const ctx = makeCtx(dir)
  apply(ctx, { tools: { deny: ['mnemon*'] } })

  assert.deepEqual(
    ctx.registered.map((tool) => tool.name),
    ['preset_md_search', 'preset_md_journal', 'preset_md_memory'],
  )
  assert.deepEqual(ctx.restricted, [{ deny: ['mnemon_recall'] }])
  rmSync(dir, { recursive: true, force: true })
})

test('apply：目录未知时只 warn，不注册记忆工具、不挂自动记忆', () => {
  const ctx = makeCtx(undefined)
  apply(ctx, {})
  assert.equal(ctx.registered.length, 0)
  assert.equal(ctx.listeners.size, 0)
  assert.ok(ctx.logs.warn.join('').includes('无法确定预设目录'))
})

test('apply：单个工具注册失败不影响其余工具', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-partial-'))
  const ctx = makeCtx(dir)
  let calls = 0
  ctx.tools.register = (definition) => {
    calls += 1
    if (definition.name === 'preset_md_journal') throw new Error('模拟注册失败')
    ctx.registered.push(definition)
  }
  apply(ctx, {})

  assert.equal(calls, 3)
  assert.deepEqual(
    ctx.registered.map((tool) => tool.name),
    ['preset_md_search', 'preset_md_memory'],
  )
  assert.ok(ctx.logs.warn.join('\n').includes('preset_md_journal 注册失败'))
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：轮数不足不触发，达到阈值触发一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-auto-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  const turnStopping = ctx.listeners.get('agent/turn-stopping')
  assert.equal(typeof turnStopping, 'function')

  const agent = agentWith('x'.repeat(200))
  // 默认阈值 reviewTurns=3：前 2 轮不该触发
  for (let i = 0; i < 2; i += 1) turnStopping({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 0)

  turnStopping({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 1)
  assert.ok(ctx.logs.info.join('\n').includes('自动记忆完成'))
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：会话结束必触发，并清掉该会话的冻结缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-disposed-'))
  writeFileSync(join(dir, 'SOUL.md'), '第一版', 'utf8')
  const ctx = makeCtx(dir)
  apply(ctx, {})
  const read = ctx.variables.get('preset_md')
  assert.equal(read({ agent: { session: { id: 's1' } } }), '第一版')

  writeFileSync(join(dir, 'SOUL.md'), '第二版', 'utf8')
  assert.equal(read({ agent: { session: { id: 's1' } } }), '第一版')

  const disposed = ctx.listeners.get('agent/disposed')
  disposed({ agent: agentWith('y'.repeat(200)) })
  await tick()

  assert.equal(ctx.stats.streams, 1)
  assert.equal(read({ agent: { session: { id: 's1' } } }), '第二版')
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：会话结束绕过防抖（刚触发过也要归档最后一段）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-force-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  const turnStopping = ctx.listeners.get('agent/turn-stopping')
  const disposed = ctx.listeners.get('agent/disposed')
  const agent = agentWith('x'.repeat(200))

  // 攒够阈值触发一次
  for (let i = 0; i < 10; i += 1) turnStopping({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 1)

  // 紧接着（5 秒防抖窗口内）结束会话：仍必须归档
  disposed({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 2, '会话结束不能被防抖吞掉')
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：回顾进行中结束会话，结束后补跑一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-pending-'))
  const ctx = makeCtx(dir)
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  ctx.llm.stream = () => {
    ctx.stats.streams += 1
    return (async function* () {
      await gate
      yield { type: 'text-delta', text: '{"journal":"### 讨论与解决\\n\\n补跑","updates":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  apply(ctx, {})
  const turnStopping = ctx.listeners.get('agent/turn-stopping')
  const disposed = ctx.listeners.get('agent/disposed')
  const agent = agentWith('x'.repeat(200))

  for (let i = 0; i < 10; i += 1) turnStopping({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 1)

  // 回顾还卡在 gate 上时结束会话 → 应排队而不是丢弃
  disposed({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 1, '不能并发跑第二次')

  release()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(ctx.stats.streams, 2, '排队的那次要在回顾结束后补跑')
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：短对话被跳过（turn_too_short）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-short-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  ctx.listeners.get('agent/disposed')({ agent: agentWith('hi') })
  await tick()
  assert.ok(ctx.logs.info.join('\n').includes('turn_too_short'))
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：会话只提供 snapshotEvents() 时也能取到转写并落盘（线上回归）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-snapshot-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})

  // 真实 dsh Session 的形态：**没有 events 属性**，事件只能通过 snapshotEvents() 取。
  // 曾经代码读 session.events → 恒为 undefined → 转写为空 → 每次回顾都被
  // turn_too_short 跳过，日记永远写不出来（改轮数/重启都无效）。
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'z'.repeat(200) }] } }]
  const agent = { id: 'a1', session: { id: 's1', snapshotEvents: () => events } }

  ctx.listeners.get('agent/disposed')({ agent })
  await tick()

  assert.equal(ctx.stats.streams, 1, '必须真的发起回顾调用，而不是被 turn_too_short 跳过')
  const text = readFileSync(join(dir, 'memory', `${dateKey()}.md`), 'utf8')
  assert.ok(text.includes('聊了插件设计'), 'snapshotEvents 形态下日记必须落盘')
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：转写窗口不因 reviewChars 调小而回缩（阈值与窗口解耦）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-window-'))
  const ctx = makeCtx(dir)
  let seenPrompt = ''
  ctx.llm.stream = (options) => {
    ctx.stats.streams += 1
    seenPrompt = options.messages[0].content[0].text
    return (async function* () {
      yield { type: 'text-delta', text: '{"journal":"j","updates":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  apply(ctx, {})
  const disposed = ctx.listeners.get('agent/disposed')

  // 阈值远小于 minChars(80) 时，旧实现会把窗口压到同等大小 → 转写不足 80 → 永远跳过。
  // 现在窗口有下限：只放大、不回缩，所以照样能取到完整转写。
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: '开头标志' + 'x'.repeat(1000) }] } }]
  const agent = { id: 'a1', session: { id: 's1', snapshotEvents: () => events } }
  disposed({ agent })
  await tick()

  assert.equal(ctx.stats.streams, 1, '阈值很小时也必须能正常回顾')
  assert.ok(seenPrompt.includes('开头标志'), '窗口不该随小阈值缩到丢掉正文')
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：拿不到任何模型时跳过并 warn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-nomodel-'))
  const ctx = makeCtx(dir)
  ctx.get = () => undefined
  apply(ctx, {})
  ctx.listeners.get('agent/disposed')({ agent: agentWith('z'.repeat(200)) })
  await tick()
  assert.ok(ctx.logs.warn.join('\n').includes('拿不到会话模型与默认模型'))
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：优先用当前会话正在跑的模型（requestHeader），而不是全局默认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-model-'))
  const ctx = makeCtx(dir)
  let seen = null
  ctx.llm.stream = (options) => {
    ctx.stats.streams += 1
    seen = { provider: options.provider, model: options.model }
    return (async function* () {
      yield { type: 'text-delta', text: '{"journal":"j","updates":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  apply(ctx, {})

  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }]
  const agent = {
    id: 'a1',
    session: {
      id: 's1',
      snapshotEvents: () => events,
      // 会话实际使用的模型（与全局默认 mock 的 p/m 不同）
      requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }),
    },
  }
  ctx.listeners.get('agent/disposed')({ agent })
  await tick()

  assert.deepEqual(seen, { provider: 'session-provider', model: 'session-model' }, '回顾必须跟会话用同一个模型')
  rmSync(dir, { recursive: true, force: true })
})

test('参数实时生效：改设置文件后无需重启/新会话即改变触发行为', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-live-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  const turnStopping = ctx.listeners.get('agent/turn-stopping')
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }]
  const agent = { id: 'a1', session: { id: 's1', snapshotEvents: () => events } }

  // 关掉自动记忆（写真实 settings 文件，路径已由 TEST_HOME 隔离）→ 立即不再触发
  writeSettings(resolvePaths(), { autoMemory: false })
  for (let i = 0; i < 5; i += 1) turnStopping({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 0, '关掉开关必须实时生效')

  // 重新打开并把轮数阈值降到 1 → 下一轮立刻触发
  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 1 })
  turnStopping({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 1, '阈值改动必须实时生效')

  // 收尾：恢复默认，避免污染同文件后续用例
  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 3, reviewChars: 2000 })
  rmSync(dir, { recursive: true, force: true })
})

test('触发条件满足但执行失败时，把提示注入对话（模型可见）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-notify-'))
  const ctx = makeCtx(dir)
  ctx.llm.stream = () =>
    (async function* () {
      throw new Error('模拟 provider 故障')
      // eslint-disable-next-line no-unreachable
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  apply(ctx, {})

  const injected = []
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }]
  const agent = {
    id: 'a1',
    session: { id: 's1', snapshotEvents: () => events },
    inject: (message) => injected.push(message),
  }
  ctx.listeners.get('agent/disposed')({ agent })
  await tick()

  assert.equal(injected.length, 1, '失败必须让用户在对话里看得见')
  const text = JSON.stringify(injected[0].content)
  assert.ok(text.includes('执行失败'), '提示需说明是「已触发但失败」')
  assert.ok(text.includes('模拟 provider 故障'), '提示需带上失败原因')
  assert.ok(ctx.logs.warn.join('\n').includes('自动记忆失败'))
  rmSync(dir, { recursive: true, force: true })
})

test('正常跳过（对话太短）不注入对话提示，只在日志留痕', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-quiet-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})

  const injected = []
  const agent = {
    id: 'a1',
    session: { id: 's1', snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }] },
    inject: (message) => injected.push(message),
  }
  ctx.listeners.get('agent/disposed')({ agent })
  await tick()

  assert.equal(injected.length, 0, '正常跳过不该打扰用户')
  assert.ok(ctx.logs.info.join('\n').includes('turn_too_short'))
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：回顾结果落到当天日志文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-journal-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  ctx.listeners.get('agent/disposed')({ agent: agentWith('z'.repeat(200)) })
  await tick()
  const text = readFileSync(join(dir, 'memory', `${dateKey()}.md`), 'utf8')
  assert.ok(text.includes('聊了插件设计'))
  rmSync(dir, { recursive: true, force: true })
})
