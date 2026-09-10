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

import { apply, inject, name } from '../src/preset.js'
import { dateKey } from '../src/memory-store.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function makeCtx(dir) {
  const sections = []
  const variables = new Map()
  const listeners = new Map()
  const registered = []
  const restricted = []
  const logs = { info: [], warn: [] }
  const stats = { suppressed: 0, streams: 0 }
  return {
    baseUrl: dir ? pathToFileURL(dir).href : undefined,
    sections,
    variables,
    listeners,
    registered,
    restricted,
    logs,
    stats,
    effect(fn) {
      return fn()
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => {}
    },
    get(service) {
      if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
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
    llm: {
      stream() {
        stats.streams += 1
        return (async function* () {
          yield { type: 'text-delta', text: '{"journal":"### 讨论与解决\\n\\n聊了插件设计","updates":[]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
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
  assert.deepEqual(inject, ['systemPrompt', 'tools'])
})

test('apply：注册唯一 complete section + 承载内容的变量 + 抑制运行时上下文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-entry-'))
  writeFileSync(join(dir, 'SOUL.md'), '人格', 'utf8')
  const ctx = makeCtx(dir)
  apply(ctx, {})

  assert.deepEqual(ctx.sections, [{ name: 'preset-md', order: 0, text: '{{preset_md}}', complete: true }])
  assert.equal(ctx.variables.get('preset_md')({ agent: { session: { id: 's1' } } }), '人格')
  assert.equal(ctx.stats.suppressed, 1)
  assert.ok(ctx.logs.info.join('\n').includes('[preset-md] 预设目录 = '))
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
  for (let i = 0; i < 9; i += 1) turnStopping({ agent })
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

test('自动记忆：拿不到默认模型时跳过并 warn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-nomodel-'))
  const ctx = makeCtx(dir)
  ctx.get = () => undefined
  apply(ctx, {})
  ctx.listeners.get('agent/disposed')({ agent: agentWith('z'.repeat(200)) })
  await tick()
  assert.ok(ctx.logs.warn.join('\n').includes('拿不到默认模型'))
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
