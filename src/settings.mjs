/**
 * 插件设置（「伙伴设置 → 参数」TAB 读写；preset 行插件启动时读取）。
 *
 * 存放位置：`<dshHome>/preset-md/settings.json`
 * 缺失或损坏时全部回落默认值。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { atomicWrite, readText } from './memory-store.mjs'

/** 默认设置。 */
export const DEFAULT_SETTINGS = {
  autoMemory: true,
  reviewTurns: 10,
  reviewChars: 8000,
  freeze: true,
  complete: true,
  suppressRuntimeContext: true,
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

/** 读设置（缺失字段回落默认值）。 */
export function readSettings(paths) {
  try {
    const parsed = JSON.parse(readText(paths.settingsFile) || '{}')
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 写设置（部分更新）。 */
export function writeSettings(paths, patch) {
  const next = { ...readSettings(paths) }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (patch && patch[key] !== undefined) next[key] = patch[key]
  }
  mkdirSync(dirname(paths.settingsFile), { recursive: true })
  atomicWrite(paths.settingsFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
