/**
 * 一次性迁移脚本：把伙伴从旧位置搬到新位置。
 *
 *   旧：<dshHome>/.agent-presets/<id>/          ← rc2 起官方已完全不再读取
 *   新：<dshHome>/companion/companions/<id>/    ← 本插件自己的数据目录
 *
 * 为什么必须搬：官方 0.1.7-rc.2 起预设改由 bundle patch 声明，`.agent-presets/`
 * 全树 0 命中。伙伴留在那儿会让人误以为"它是官方预设、官方会读"，排查时极易误判。
 *
 * 迁移**只移动不改内容**：六个 MD、memory/、changelog/、preset.yml 原样过去。
 *
 * 用法：
 *   node scripts/migrate-presets.mjs           # 预演（只报告，不写盘）
 *   node scripts/migrate-presets.mjs --apply   # 实际迁移
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { listLegacyAgents, migrateAgent, resolvePaths } from '../src/index.js'

const apply = process.argv.includes('--apply')
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const paths = resolvePaths(home)

console.log(`DSH_HOME : ${home}`)
console.log(`旧位置   : ${paths.legacyPresetsRoot}`)
console.log(`新位置   : ${paths.companionsRoot}`)
console.log(`模式     : ${apply ? '实际迁移 (--apply)' : '预演（不写盘）'}`)
console.log('')

const legacy = listLegacyAgents(paths)
if (legacy.length === 0) {
  console.log('没有需要迁移的伙伴。')
  process.exit(0)
}

console.log(`待迁移 ${legacy.length} 个：${legacy.join(', ')}`)
console.log('')

for (const id of legacy) {
  const dir = join(paths.legacyPresetsRoot, id)
  const metaFile = join(dir, 'preset.yml')
  const meta = existsSync(metaFile) ? readFileSync(metaFile, 'utf8').trim().split('\n')[0] : '(无 preset.yml)'
  const mdCount = readdirSync(dir).filter((name) => name.endsWith('.md')).length
  const journalDir = join(dir, 'memory')
  const journalCount = existsSync(journalDir) ? readdirSync(journalDir).length : 0

  console.log(`── ${id}  (${meta})`)
  console.log(`   ${mdCount} 个 .md，日记 ${journalCount} 篇`)

  if (!apply) {
    console.log('   [预演] 将移动到新位置')
    continue
  }
  const result = migrateAgent(paths, id)
  console.log(result.migrated ? `   ✔ 已迁移 -> ${result.target}` : `   – 跳过：${result.reason}`)
}

console.log('')
if (!apply) {
  console.log('预演结束。加 --apply 实际执行。')
} else {
  const remaining = listLegacyAgents(paths)
  console.log(remaining.length === 0 ? '迁移结束：旧位置已无待迁移伙伴。' : `注意：仍有 ${remaining.length} 个未迁移：${remaining.join(', ')}`)
}
