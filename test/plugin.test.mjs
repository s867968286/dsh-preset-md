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

import { apply, inject, localTimestamp, MAX_REVIEW_ATTEMPTS, name } from '../src/preset.js'
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
    /*
     * 事件监听：同一个事件可能被挂多个处理器（本插件现在既听 agent/disposed
     * 又听 session/event 与 agent/created），所以按事件名累积成数组，
     * 而不是只保留最后一个。
     */
    listeners,
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    /** 取某个事件的第一个处理器（多数用例只关心单个）。 */
    first(event) {
      return (listeners.get(event) ?? [])[0]
    },
    registered,
    restricted,
    logs,
    stats,
    llm,
    effect(fn) {
      return fn()
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
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

/*
 * 真人发言夹具**必须带 `source.kind`**：官方契约里 `Message.source` 是必填字段，
 * 而 `user/message` 不区分来源（真人 / 官方运行时快照 / 插件注入都落成它）。
 * 不带 source 的裸事件在真实会话里并不存在，拿它做夹具等于测不到来源过滤——
 * 此前正是因此漏掉了「注入消息被当真人发言」这个缺陷。
 */
const agentWith = (text) => ({
  id: 'a1',
  session: {
    id: 's1',
    events: [{ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }],
  },
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
  const turnStopping = ctx.first('agent/turn-stopping')
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

  const disposed = ctx.first('agent/disposed')
  disposed({ agent: agentWith('y'.repeat(200)) })
  await tick()

  assert.equal(ctx.stats.streams, 1)
  assert.equal(read({ agent: { session: { id: 's1' } } }), '第二版')
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：上下文压缩前强制归档（否则那段内容压缩后再无机会总结）', async () => {
  /*
   * 压缩会把老对话摘要掉。若某段工作还没被回顾总结，压缩后就再也没有机会——
   * 内容已不在事件窗口内。所以在 compaction/start 时强制跑一次回顾。
   *
   * 监听口径：session/event 给的是 session，schedule() 需要 agent，
   * 故本插件从 agent/created 建映射表。
   */
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-compact-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  assert.equal(typeof ctx.first('session/event'), 'function', '必须监听 session/event')

  // 真人几乎没说话 + 阈值远未达到：正常绝不会触发
  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 99, reviewChars: 999999 })
  const session = { id: 's1', snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'z'.repeat(200) }], source: { kind: 'user' } } }] }
  const agent = { id: 'a1', session, inject: () => {} }

  // 先让 agent 被登记（真实环境里 agent/created 先于任何 session/event）
  ctx.emit('agent/created', { agent })

  // 压缩开始 → 必须强制触发一次
  ctx.emit('session/event', session, { type: 'compaction/start', data: { compactionId: 'c1', turn: 1 } })
  await tick()
  assert.equal(ctx.stats.streams, 1, '压缩开始必须强制归档，绕过阈值与防抖')

  // 其他会话的事件不能误触发
  ctx.emit('session/event', { id: 'other', snapshotEvents: () => [] }, { type: 'compaction/start', data: {} })
  await tick()
  assert.equal(ctx.stats.streams, 1, '别的会话的压缩不该触发本会话')

  // 非 compaction 事件不该触发
  ctx.emit('session/event', session, { type: 'turn/start', data: {} })
  await tick()
  assert.equal(ctx.stats.streams, 1, '与压缩无关的事件不该触发回顾')

  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 3, reviewChars: 2000 })
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：关闭 autoMemory 时压缩不触发归档', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-compact-off-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  writeSettings(resolvePaths(), { autoMemory: false })

  const session = { id: 's1', snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'z'.repeat(200) }], source: { kind: 'user' } } }] }
  ctx.emit('agent/created', { agent: { id: 'a1', session } })
  ctx.emit('session/event', session, { type: 'compaction/start', data: {} })
  await tick()
  assert.equal(ctx.stats.streams, 0, '开关关闭时压缩也不该写')

  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 3, reviewChars: 2000 })
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：会话结束绕过防抖（刚触发过也要归档最后一段）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-force-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  const turnStopping = ctx.first('agent/turn-stopping')
  const disposed = ctx.first('agent/disposed')
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
  const turnStopping = ctx.first('agent/turn-stopping')
  const disposed = ctx.first('agent/disposed')
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
  ctx.first('agent/disposed')({ agent: agentWith('hi') })
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
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'z'.repeat(200) }], source: { kind: 'user' } } }]
  const agent = { id: 'a1', session: { id: 's1', snapshotEvents: () => events } }

  ctx.first('agent/disposed')({ agent })
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
  const disposed = ctx.first('agent/disposed')

  // 阈值远小于 minChars(80) 时，旧实现会把窗口压到同等大小 → 转写不足 80 → 永远跳过。
  // 现在窗口有下限：只放大、不回缩，所以照样能取到完整转写。
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: '开头标志' + 'x'.repeat(1000) }], source: { kind: 'user' } } }]
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
  ctx.first('agent/disposed')({ agent: agentWith('z'.repeat(200)) })
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

  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
  const agent = {
    id: 'a1',
    session: {
      id: 's1',
      snapshotEvents: () => events,
      // 会话实际使用的模型（与全局默认 mock 的 p/m 不同）
      requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }),
    },
  }
  ctx.first('agent/disposed')({ agent })
  await tick()

  assert.deepEqual(seen, { provider: 'session-provider', model: 'session-model' }, '回顾必须跟会话用同一个模型')
  rmSync(dir, { recursive: true, force: true })
})

test('参数实时生效：改设置文件后无需重启/新会话即改变触发行为', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-live-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  const turnStopping = ctx.first('agent/turn-stopping')
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
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
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
  const agent = {
    id: 'a1',
    session: { id: 's1', snapshotEvents: () => events },
    inject: (message) => injected.push(message),
  }
  ctx.first('agent/disposed')({ agent })
  await tick()

  assert.equal(injected.length, 1, '失败必须让用户在对话里看得见')
  const text = JSON.stringify(injected[0].content)
  assert.ok(text.includes('执行失败'), '提示需说明是「已触发但失败」')
  assert.ok(text.includes('模拟 provider 故障'), '提示需带上失败原因')
  assert.ok(ctx.logs.warn.join('\n').includes('自动记忆失败'))
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：执行失败不推进水位（下一轮重试同一段）', async () => {
  /*
   * 这条锁的是「水位在执行前推进 → 失败静默丢内容」这个缺陷。
   *
   * 早先 `markChars` / `turns` 在 schedule() 的同步阶段就推进，早于 LLM 调用；
   * 失败分支又只打日志不回滚，那一轮内容的水位被白白消耗——长会话里这段内容
   * 滚出尾部窗口后就再也轮不到，日志与界面都看不出发生过。
   *
   * 为什么必须走 turn-stopping 且用 turns 阈值（而不是 disposed/force）：
   * disposed 走 force，绕过防抖与阈值判断，**测不出水位是否被消费**。
   * 这里把触发权交给「轮数」，水位一旦被错误推进，后续轮次就再也凑不够阈值。
   * 轮数为 3 时第 3 轮触发；失败后若不推进水位，第 4 轮应再次触发。
   */
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-nowater-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 3, reviewChars: 2000 })

  let attempt = 0
  ctx.llm.stream = () => {
    attempt += 1
    ctx.stats.streams += 1
    if (attempt === 1) {
      return (async function* () {
        throw new Error('模拟首次故障')
        // eslint-disable-next-line no-unreachable
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
    return (async function* () {
      yield { type: 'text-delta', text: '{"journal":"### 讨论与解决\\n\\n第二次成功","updates":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }

  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'z'.repeat(300) }], source: { kind: 'user' } } }]
  const agent = { id: 'a1', session: { id: 's1', snapshotEvents: () => events } }
  const turnStopping = ctx.first('agent/turn-stopping')

  // 攒到第 3 轮 → 触发，但这次必然失败
  for (let i = 0; i < 3; i += 1) turnStopping({ agent })
  await tick()
  assert.equal(ctx.stats.streams, 1)
  assert.ok(ctx.logs.warn.join('\n').includes('模拟首次故障'), '首次必须真的失败')

  /*
   * 第二次：等过 5 秒防抖后同一段内容仍在。
   * 修复后 turns 在第 4 轮达到 3 → 再次触发并成功；
   * 若水位/轮数在失败时被推进（旧行为），这里的 grown 与 turns 都归零，
   * 第 4 轮凑不够阈值 → streams 仍是 1，断言失败。
   */
  await new Promise((resolve) => setTimeout(resolve, 5300))
  ctx.logs.info.length = 0
  turnStopping({ agent })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(ctx.stats.streams, 2, '失败后必须重试同一段，不能被水位吞掉')
  assert.ok(
    readFileSync(join(dir, 'memory', `${dateKey()}.md`), 'utf8').includes('第二次成功'),
    '重试成功后内容应落盘（证明失败那轮的水位确实没被推进）',
  )

  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 3, reviewChars: 2000 })
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：连续失败到上限后放弃这一段，避免水位永久卡死', async () => {
  /*
   * 「失败不推进水位」必须有上限：一段坏内容（模型持续吐非法 JSON 等）会让
   * 水位永久卡死，后面的内容再也轮不到。达到 MAX_REVIEW_ATTEMPTS 后强制推进。
   */
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-giveup-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 1, reviewChars: 1 })

  ctx.llm.stream = () => {
    ctx.stats.streams += 1
    return (async function* () {
      throw new Error('模拟持续故障')
      // eslint-disable-next-line no-unreachable
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }

  const agent = {
    id: 'a1',
    inject: () => {},
    session: { id: 's1', snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'z'.repeat(300) }], source: { kind: 'user' } } }] },
  }
  const turnStopping = ctx.first('agent/turn-stopping')

  // 跑满上限次数（每次之间要跨过 5 秒防抖，force 走 disposed 更直接）
  for (let i = 0; i < MAX_REVIEW_ATTEMPTS; i += 1) {
    ctx.first('agent/disposed')({ agent })
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  assert.equal(ctx.stats.streams, MAX_REVIEW_ATTEMPTS)
  assert.ok(
    ctx.logs.warn.join('\n').includes('放弃这一段'),
    '连续失败到上限必须放弃这一段，否则水位永久卡死',
  )

  writeSettings(resolvePaths(), { autoMemory: true, reviewTurns: 3, reviewChars: 2000 })
  rmSync(dir, { recursive: true, force: true })
})

test('正常跳过（对话太短）不注入对话提示，只在日志留痕', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-quiet-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})

  const injected = []
  const agent = {
    id: 'a1',
    session: { id: 's1', snapshotEvents: () => [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }] },
    inject: (message) => injected.push(message),
  }
  ctx.first('agent/disposed')({ agent })
  await tick()

  assert.equal(injected.length, 0, '正常跳过不该打扰用户')
  assert.ok(ctx.logs.info.join('\n').includes('turn_too_short'))
  rmSync(dir, { recursive: true, force: true })
})

test('自动记忆：回顾结果落到当天日志文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-journal-'))
  const ctx = makeCtx(dir)
  apply(ctx, {})
  ctx.first('agent/disposed')({ agent: agentWith('z'.repeat(200)) })
  await tick()
  const text = readFileSync(join(dir, 'memory', `${dateKey()}.md`), 'utf8')
  assert.ok(text.includes('聊了插件设计'))
  rmSync(dir, { recursive: true, force: true })
})
