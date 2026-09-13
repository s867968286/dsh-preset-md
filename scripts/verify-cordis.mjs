/**
 * 校验用脚本：确认「插件模板」的工具行清单与官方 standard 一致。
 * 只做静态检查（解析 + 对比 + 包存在性），不启动 host。
 *
 * 路径全部**动态解析**，不硬编码任何绝对路径：
 * - 官方包目录：从 `@deepseek-ai/dsh` 的 package.json 反查（借 host 自带的 yaml），
 *   换机器 / 换 node 版本都不用改脚本。
 * - 默认只校验 `templates/agent.cordis.yml.tpl`（结果确定，可进 CI）。
 * - 想额外校验某个本机预设，把路径作为命令行参数传入：
 *     node scripts/verify-cordis.mjs ~/.dsh/.agent-presets/presetmd-e4d0/agent.cordis.yml
 *   **不自动探测**：本机可能同时存在多个预设（含实验性的），随便挑一个会产生
 *   误导性的「缺少官方行」报错。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// yaml 不是本插件依赖，直接借用 host dsh 自带的副本（不污染插件依赖树）。
// 从 dsh 主包反查，避免把 node_modules 的绝对路径写死在脚本里。
const require = createRequire(import.meta.url)
function resolveDshRoot() {
  try {
    return dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    /* 回落到下面的候选 */
  }
  const candidates = [
    // 从本仓库向上找 node_modules/@deepseek-ai/dsh
    ...(() => {
      const out = []
      let dir = dirname(fileURLToPath(import.meta.url))
      for (let i = 0; i < 6; i += 1) {
        out.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh'))
        dir = dirname(dir)
      }
      return out
    })(),
    // 全局安装形态：<node prefix>/node_modules/@deepseek-ai/dsh
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'),
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return ''
}

const DSH_ROOT = resolveDshRoot()
if (!DSH_ROOT) {
  console.error('[ERROR] 找不到 @deepseek-ai/dsh，无法定位官方包与 yaml；请先安装依赖')
  process.exit(1)
}
const NM = join(DSH_ROOT, 'node_modules', '@deepseek-ai')

let YAML
try {
  YAML = require(join(DSH_ROOT, 'node_modules', 'yaml'))
} catch {
  try {
    YAML = require('yaml')
  } catch {
    console.error('[ERROR] 找不到 yaml（host 自带副本与本地依赖都不可用）')
    process.exit(1)
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FILES = {
  standard: join(NM, 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
  tpl: join(REPO_ROOT, 'templates', 'agent.cordis.yml.tpl'),
}
// 可选：命令行指定要一并校验的本机预设（不自动探测，见文件头说明）
const presetArg = process.argv[2]
if (presetArg) {
  const file = resolve(presetArg)
  if (!existsSync(file)) {
    console.error(`[ERROR] 指定的预设不存在：${file}`)
    process.exit(1)
  }
  FILES.preset = file
}

/** 递归收集所有插件行（含 group 内嵌 config）。 */
function collectRows(docs, out = [], inGroup = false) {
  for (const row of docs ?? []) {
    if (!row || typeof row !== 'object') continue
    if (row.id) out.push({ ...row, __inGroup: inGroup })
    if (Array.isArray(row.config)) collectRows(row.config, out, true)
  }
  return out
}

/** 递归收集 group 的 isolate 声明，并检查 isolate 是否都带 cordis:group。 */
function collectGroups(docs, out = []) {
  for (const row of docs ?? []) {
    if (!row || typeof row !== 'object') continue
    if (row.name === 'cordis:group') {
      out.push({ id: row.id, isolate: Object.keys(row.isolate ?? {}), isGroup: row.group === true })
      collectGroups(row.config, out)
    }
  }
  return out
}

const parsed = {}
for (const [key, file] of Object.entries(FILES)) {
  const raw = readFileSync(file, 'utf8')
  // 模板里的 {name} 只是渲染占位符，先替换成等价字符串再解析
  const text = raw.replaceAll('{name}', 'lily')
  const docs = YAML.parseAllDocuments(text, { prettyErrors: true })
  const errors = docs.flatMap((d) => d.errors ?? [])
  const merged = docs.flatMap((d) => d.toJS() ?? [])
  parsed[key] = { rows: collectRows(merged), groups: collectGroups(merged), errors }
}

let fail = 0
const say = (level, msg) => {
  if (level === 'ERROR') fail++
  console.log(`[${level}] ${msg}`)
}

// 1. 语法
for (const [key, p] of Object.entries(parsed)) {
  if (p.errors.length) say('ERROR', `${key} YAML 解析失败：${p.errors.map((e) => e.message).join('; ')}`)
  else say('INFO', `${key} YAML 解析通过，顶层+嵌套共 ${p.rows.length} 行插件`)
}

// persona 有意省略：人格由预设的 SYSTEM.md / IDENTITY.md 承载，
// 官方 persona 行会注入 "You are a coding agent ..." 覆盖它。
const INTENTIONALLY_OMITTED = new Set(['persona'])
const stdIds = new Set(parsed.standard.rows.map((r) => r.id).filter((id) => !INTENTIONALLY_OMITTED.has(id)))
// 本机预设是可选对照项：没探测到就不校验它（只校验模板）
for (const key of ['preset', 'tpl'].filter((k) => parsed[k])) {
  const ids = new Set(parsed[key].rows.map((r) => r.id))
  const missing = [...stdIds].filter((id) => !ids.has(id))
  const extra = [...ids].filter((id) => !stdIds.has(id))
  if (missing.length) say('ERROR', `${key} 缺少官方行：${missing.join(', ')}`)
  else say('INFO', `${key} 官方 ${stdIds.size} 行全部齐备`)
  // preset-md 是自研行，允许额外存在
  const unexpected = extra.filter((id) => id !== 'preset-md')
  if (unexpected.length) say('ERROR', `${key} 多出非预期行：${unexpected.join(', ')}`)
  else say('INFO', `${key} 额外行仅 preset-md（自研，符合预期）`)

  // 逐行核对 name / config
  const stdMap = new Map(parsed.standard.rows.map((r) => [r.id, r]))
  for (const row of parsed[key].rows) {
    if (row.id === 'preset-md') continue
    const s = stdMap.get(row.id)
    if (!s) continue
    if (s.name !== row.name) say('ERROR', `${key}/${row.id} name 不一致：${row.name} != ${s.name}`)
    if (JSON.stringify(s.config ?? null) !== JSON.stringify(row.config ?? null) && row.config !== undefined) {
      say('WARN', `${key}/${row.id} config 与官方不同`)
    }
  }
}

// 3. isolate 必须裹在 cordis:group 里
for (const [key, p] of Object.entries(parsed)) {
  const bad = p.groups.filter((g) => !g.isGroup)
  if (bad.length) say('ERROR', `${key} 有 isolate 未裹 cordis:group：${bad.map((b) => b.id).join(', ')}`)
  else say('INFO', `${key} isolate 分组 ${p.groups.length} 个，均带 group: true（${p.groups.map((g) => `${g.id}[${g.isolate.join('+')}]`).join(' ')}）`)
}

// 4. 包存在性（子路径包只校验主包）
for (const [key, p] of Object.entries(parsed)) {
  const missing = []
  for (const row of p.rows) {
    const m = /^@deepseek-ai\/([^/]+)/.exec(row.name ?? '')
    if (!m) continue
    if (!existsSync(join(NM, m[1]))) missing.push(`${row.id}->${row.name}`)
  }
  if (missing.length) say('ERROR', `${key} 引用了不存在的包：${missing.join(', ')}`)
  else say('INFO', `${key} 引用的官方包全部存在于 host node_modules`)
}

console.log(fail === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${fail})`)
process.exit(fail === 0 ? 0 : 1)
