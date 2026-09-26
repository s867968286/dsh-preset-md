/**
 * 伙伴模式预设（src/companion-preset.mjs）的形状锁。
 *
 * 背景：rc2 起官方不再读 .agent-presets/<id>/agent.cordis.yml，伙伴的轻量工具
 * 清单此前从未生效（实测伙伴会话跑的是 standard-gitbash 的 51 个工具）。
 * 唯一官方通道是 ctx.agentPresets.register(...)，plugins 为声明式行数组。
 * 这里锁三件事：① 行清单不挂重型机械；② 必备基础行齐全；③ 注册形态合法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { companionPresetPlugins, companionPresetMeta, COMPANION_PRESET_ID } from '../src/companion-preset.mjs'

const FORBIDDEN = [
  'plan-mode',            // 计划模式
  'compaction-basic',     // 压缩
  'tool-result-pruner',
  'command-compact',
  'workflow',             // 委派/工作流
  'subagent',
  'tool-goal',            // goal
  'command-goal',
  'tool-jobs',            // 定时任务
  'agent-instructions',   // 官方编码骨架（与伙伴人设打架）
]

test('伙伴模式：不挂任何编码重型机械行', () => {
  const ids = companionPresetPlugins().map((row) => row.id)
  const hit = ids.filter((id) => FORBIDDEN.some((bad) => id.includes(bad)))
  assert.deepEqual(hit, [], `伙伴模式不得出现这些行：${hit.join(', ')}`)
})

test('伙伴模式：对话基础能力齐全', () => {
  const ids = new Set(companionPresetPlugins().map((row) => row.id))
  for (const required of ['tool-fs', 'tool-fs-search', 'tool-skill', 'tool-ask-user', 'tool-todo', 'tool-web', 'present']) {
    assert.ok(ids.has(required), `缺基础行 ${required}`)
  }
  /*
   * shell 二选一：**两行都保留**，非当前平台那行标 disabled ——
   * 与参考 agent.cordis.yml 一致（官方 off() 的惯例，gitbash-shell 同款），
   * 行集稳定，切换平台不用增删行。
   */
  const win = Object.fromEntries(companionPresetPlugins({ win: true }).map((row) => [row.id, row.disabled === true]))
  const posix = Object.fromEntries(companionPresetPlugins({ win: false }).map((row) => [row.id, row.disabled === true]))
  assert.equal(win['tool-bash'], true, 'Windows 下 bash 应禁用')
  assert.notEqual(win['tool-pwsh'], true, 'Windows 下 pwsh 应启用')
  assert.equal(posix['tool-pwsh'], true, '非 Windows 下 pwsh 应禁用')
  assert.notEqual(posix['tool-bash'], true, '非 Windows 下 bash 应启用')
})

test('伙伴模式：shell 平台行没有被意外禁用', () => {
  const win = companionPresetPlugins({ win: true }).find((row) => row.id === 'tool-pwsh')
  const posix = companionPresetPlugins({ win: false }).find((row) => row.id === 'tool-bash')
  assert.equal(win?.disabled, undefined, '当前平台的 shell 行不得 disabled')
  assert.equal(posix?.disabled, undefined, '当前平台的 shell 行不得 disabled')
})

test('伙伴模式：注册信息完整且 id 稳定', () => {
  const meta = companionPresetMeta()
  assert.equal(meta.id, COMPANION_PRESET_ID)
  assert.ok(meta.name, '应有可读名称')
  assert.ok(meta.description, '应有描述')
  assert.equal(typeof meta.order, 'number')
  // 官方 register 要求 id 全小写字母数字连字符
  assert.match(meta.id, /^[a-z0-9][a-z0-9-]*$/)
})

test('伙伴模式：host 半 inject 含 agentPresets 并完成注册', async () => {
  const calls = []
  const unregistered = []
  const scope = {
    agentPresets: {
      register: (definition) => {
        calls.push(definition)
        return () => { unregistered.push(definition.id) }
      },
    },
    effect: (_disposer, label) => { scope.labels = scope.labels || []; scope.labels.push(label) },
  }
  const injected = []
  const ctx = {
    logger: { warn: (msg) => { ctx.warns = ctx.warns || []; ctx.warns.push(String(msg)) } },
    // apply 同时会注册 HTTP 路由：webServer 只需可调用即可，路由行为另有 http.test.mjs 管
    webServer: { register: () => {} },
    inject: (names, fn) => { injected.push(names); fn(scope) },
  }
  // 只跑 apply 的注册部分：直接 import 会连带路由注册，这里走真 apply 但 webServer 缺省也不炸
  const mod = await import('../src/index.js')
  // apply 需要 paths 相关 config；用假 home 避免碰真实数据
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'companion-preset-'))
  mod.apply(ctx, { dshHome: home })

  assert.deepEqual(injected, [['agentPresets']], '应通过 ctx.inject 等待 agentPresets')
  assert.equal(calls.length, 1, '应恰好注册一个预设')
  assert.equal(calls[0].id, COMPANION_PRESET_ID)
  assert.ok(Array.isArray(calls[0].plugins) && calls[0].plugins.length > 0, 'plugins 应为非空行数组')
  const ids = calls[0].plugins.map((row) => row.id)
  assert.ok(!ids.some((id) => FORBIDDEN.some((bad) => id.includes(bad))), '注册进官方的行也不得含重型机械')
})
