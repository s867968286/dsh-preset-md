/**
 * 一次性迁移：dsh-preset-md 时代的数据 → dsh-companion。
 *
 * - `~/.dsh/preset-md/`          → `~/.dsh/companion/`
 * - 伙伴目录 `presetmd-<id>`     → `companion-<id>`（目录与其中 preset.yml 的 id 同步改）
 * - `bindings.json` 的伙伴 id 值同步映射
 *
 * 不做的事（用户明确要求）：不写历史兼容层。旧目录直接搬走（保留在原地的情况仅限
 * 新目录已存在这类冲突），历史会话日志里的旧事件不再读取。
 *
 * 幂等：新目录已存在时跳过（不合并、不覆盖），并把决定打出来。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const oldRoot = join(home, 'preset-md')
const newRoot = join(home, 'companion')

const log = (msg) => console.log(`[migrate] ${msg}`)

if (!existsSync(oldRoot)) {
  log(`源目录不存在：${oldRoot} —— 无需迁移`)
  process.exit(0)
}

if (existsSync(newRoot)) {
  log(`目标目录已存在：${newRoot} —— 跳过（避免覆盖）。如需强制迁移请先手动处理。`)
  process.exit(1)
}

// 1. 整体搬迁
mkdirSync(newRoot, { recursive: true })
for (const entry of readdirSync(oldRoot)) {
  renameSync(join(oldRoot, entry), join(newRoot, entry))
  log(`搬移 ${entry}`)
}

// 2. 伙伴目录改名 presetmd-<id> → companion-<id>
const companionsDir = join(newRoot, 'companions')
const idMap = new Map()
if (existsSync(companionsDir)) {
  for (const dir of readdirSync(companionsDir)) {
    if (!dir.startsWith('presetmd-')) continue
    const newId = `companion-${dir.slice('presetmd-'.length)}`
    renameSync(join(companionsDir, dir), join(companionsDir, newId))
    idMap.set(dir, newId)
    log(`伙伴目录 ${dir} → ${newId}`)
  }
}

// 3. 每个伙伴的 preset.yml 里 id 同步改（官方 dsh-agent-presets 读它）
if (existsSync(companionsDir)) {
  for (const [oldId, newId] of idMap) {
    const meta = join(companionsDir, newId, 'preset.yml')
    if (!existsSync(meta)) continue
    const text = readFileSync(meta, 'utf8')
    const updated = text.replace(/^id:\s*.*$/m, `id: ${newId}`)
    if (updated !== text) {
      writeFileSync(meta, updated, 'utf8')
      log(`preset.yml id: ${oldId} → ${newId}`)
    }
  }
}

// 4. bindings.json 的值映射
const bindingsFile = join(newRoot, 'bindings.json')
if (existsSync(bindingsFile) && idMap.size > 0) {
  try {
    const bindings = JSON.parse(readFileSync(bindingsFile, 'utf8'))
    for (const [sessionId, companionId] of Object.entries(bindings)) {
      if (typeof companionId === 'string' && idMap.has(companionId)) {
        bindings[sessionId] = idMap.get(companionId)
      }
    }
    writeFileSync(bindingsFile, `${JSON.stringify(bindings, null, 2)}\n`, 'utf8')
    log(`bindings.json 已映射 ${idMap.size} 个 id`)
  } catch (error) {
    log(`bindings.json 解析失败（保留原样）：${error.message}`)
  }
}

// 5. 收尾：旧目录空了就删
try { rmSync(oldRoot, { recursive: true }) ; log(`旧目录已删除：${oldRoot}`) } catch { log(`旧目录未能删除（可能有文件占用），请手动处理`) }

log('迁移完成')
