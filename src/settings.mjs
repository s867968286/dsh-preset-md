/**
 * 插件设置（「伙伴设置 → 参数」TAB 读写；preset 行插件启动时读取）。
 *
 * 存放位置：`<dshHome>/preset-md/settings.json`
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
  reviewTurns: 10,
  reviewChars: 8000,
  freeze: true,
  complete: true,
  suppressRuntimeContext: true,
  contextBudget: DEFAULT_CONTEXT_BUDGET,
  budgetNotice: true,
}

/** 布尔开关的键。 */
const BOOLEAN_KEYS = ['autoMemory', 'freeze', 'complete', 'suppressRuntimeContext', 'budgetNotice']
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

/** 解析 dshHome 与各根目录。 */
export function resolvePaths(home) {
  const dshHome = home || process.env.DSH_HOME || join(homedir(), '.dsh')
  return {
    dshHome,
    presetsRoot: join(dshHome, '.agent-presets'),
    backupRoot: join(dshHome, '.agent-presets-backup'),
    settingsFile: join(dshHome, 'preset-md', 'settings.json'),
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
