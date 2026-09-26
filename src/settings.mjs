/**
 * 插件设置（「伙伴设置 → 参数」TAB 读写；preset 行插件启动时读取）。
 *
 * 存放位置：`<dshHome>/companion/settings.json`
 * 缺失或损坏时全部回落默认值。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONTEXT_BUDGET } from './core.js'
import { atomicWrite, readText } from './memory-store.mjs'

/** 默认设置。 */
export const DEFAULT_SETTINGS = {
  autoMemory: true,
  // 触发阈值（满足其一即触发）：
  // 一次有实质内容的往来通常 2~3 轮就够；2000 字符约等于一次中等长度的往返。
  // 旧默认（10 轮 / 8000 字符）在短会话里几乎不可能达到，只能靠「会话结束」兜底，
  // 而会话结束只在 agent 销毁（关窗口、切会话）时发生，体感就是「根本不触发」。
  reviewTurns: 3,
  reviewChars: 2000,
  contextBudget: DEFAULT_CONTEXT_BUDGET,
  budgetNotice: true,
}

/** 布尔开关的键。 */
const BOOLEAN_KEYS = ['autoMemory', 'budgetNotice']
/** 数值键。 */
export const NUMERIC_KEYS = ['reviewTurns', 'reviewChars', 'contextBudget']

/**
 * 归一化一个设置值：无效值一律回落到默认值。
 *
 * 必须做这层校验的理由：`state.turns < 0` 与 `grown < 0` 恒为假，会让
 * 「未达阈值才跳过」的判断失效，退化成每个回合都跑一次 LLM 回顾；
 * 而字符串 "false" 是真值，会让开关静默失效。
 *
 * 「无效」= 缺失（undefined / null / 空串）、类型不符、非有限数、小于等于 0。
 * 这类值回落默认而不是夹到下限：静默把 0 变成 1 会让回顾变得极其频繁，
 * 用户不会预期这个副作用。
 */
export function normalizeSetting(key, value) {
  const fallback = DEFAULT_SETTINGS[key]
  if (value === undefined || value === null || value === '') return fallback
  if (BOOLEAN_KEYS.includes(key)) return typeof value === 'boolean' ? value : fallback
  if (NUMERIC_KEYS.includes(key)) {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback
    return Math.floor(parsed)
  }
  return value
}

/**
 * 解析 dshHome 与各根目录。
 *
 * ## 伙伴目录为什么从 `.agent-presets` 搬到 `companion/companions`
 *
 * dsh 0.1.7-rc.2 起官方**完全不再读取** `<dshHome>/.agent-presets/<id>/`
 * （全树 0 命中），预设改由 bundle patch 声明。继续把伙伴放那里会有两个问题：
 * ① 语义混淆——看起来像"官方预设"，实际官方根本不看；
 * ② 名字里带 `.`，与官方已废弃的目录同名，将来排查时极容易误判。
 *
 * 所以伙伴数据改住 `companion/` 下（与插件设置同级），它是**本插件自己的数据**：
 * 一个伙伴 = 一个目录，里面是六个 MD + memory/ + changelog/。
 * 预设/提示词的独占不再依赖官方 preset，而由 `complete` section 承担。
 *
 * `legacyPresetsRoot` 仅用于**一次性迁移**（见 migrateCompanions）与读旧数据兜底。
 */
export function resolvePaths(home) {
  const dshHome = home || process.env.DSH_HOME || join(homedir(), '.dsh')
  return {
    dshHome,
    companionsRoot: join(dshHome, 'companion', 'companions'),
    backupRoot: join(dshHome, 'companion', 'companions-backup'),
    settingsFile: join(dshHome, 'companion', 'settings.json'),
    /**
     * 会话 → 伙伴 的绑定表。
     *
     * ## 为什么不写进会话事件流
     *
     * 早期把绑定写成自定义会话事件 `companion/companion-selected`。
     * 但官方 v4 持久化门禁（`dsh-session-persistence/lib/index.js:184`）：
     *   `if (!KNOWN_SESSION_EVENT_TYPES.has(type) && event.ignorable !== true) throw ...`
     * 下游插件事件**不在**白名单里（rc.2 共 59 个官方类型，全是官方自己的），
     * 必须带 `ignorable: true`；而 `Session.append()` 的 opts 只透传
     * `surfaceOp` / `sourceEventSeqs`（`dsh-session/lib/index.js:1401`），
     * **没有给第三方传 ignorable 的入口**，Session 也没有第二个写入 API。
     *
     * 结果：写过绑定的会话在下次打开时整条日志被拒读，
     * 表现为「新建会话失败 / 会话打不开」。
     *
     * 所以绑定改住插件自己的文件，按 sessionId 索引。
     */
    bindingsFile: join(dshHome, 'companion', 'bindings.json'),
    /** rc2 之前的官方预设目录，本插件只在迁移时读它。 */
    legacyPresetsRoot: join(dshHome, '.agent-presets'),
  }
}

/** 读设置（缺失字段回落默认值，越界值也被夹回合法范围）。 */
export function readSettings(paths) {
  try {
    const parsed = JSON.parse(readText(paths.settingsFile) || '{}')
    const input = parsed && typeof parsed === 'object' ? parsed : {}
    const next = {}
    for (const key of Object.keys(DEFAULT_SETTINGS)) next[key] = normalizeSetting(key, input[key])
    return next
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 写设置（部分更新；每个键都过一遍归一化，脏值不会落盘）。 */
export function writeSettings(paths, patch) {
  const next = { ...readSettings(paths) }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (patch && patch[key] !== undefined) next[key] = normalizeSetting(key, patch[key])
  }
  mkdirSync(dirname(paths.settingsFile), { recursive: true })
  atomicWrite(paths.settingsFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/* ─────────── 会话 → 伙伴 绑定表 ───────────
 *
 * 形状：`{ "<sessionId>": "<companionId>" }`。
 *
 * 只记**明确绑定过**的会话：值 `null` 表示用户显式选了「无伙伴」，
 * 与"压根没这个键"（从未选过）是两件事 —— 后者要让 `resolveCompanionDir`
 * 的回落逻辑继续生效。
 */

/** 读整张绑定表（文件缺失/损坏 → 空表，绝不抛）。 */
export function readBindings(paths) {
  try {
    const parsed = JSON.parse(readText(paths.bindingsFile) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== 'string' || key === '') continue
      // 只接受字符串 id 或 null（显式「无伙伴」）
      if (value === null) next[key] = null
      else if (typeof value === 'string' && value !== '') next[key] = value
    }
    return next
  } catch {
    return {}
  }
}

/**
 * 写一个会话的绑定。`companion` 为 null / 空 → 显式「无伙伴」。
 * @returns 写入后的整张表。
 */
export function writeBinding(paths, sessionId, companion) {
  if (typeof sessionId !== 'string' || sessionId === '') return readBindings(paths)
  const next = readBindings(paths)
  next[sessionId] = companion ? String(companion) : null
  mkdirSync(dirname(paths.bindingsFile), { recursive: true })
  atomicWrite(paths.bindingsFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** 删一个会话的绑定（会话销毁时清理，避免无限增长）。 */
export function deleteBinding(paths, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return readBindings(paths)
  const next = readBindings(paths)
  if (!(sessionId in next)) return next
  delete next[sessionId]
  mkdirSync(dirname(paths.bindingsFile), { recursive: true })
  atomicWrite(paths.bindingsFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
