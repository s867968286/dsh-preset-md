/**
 * 校验用脚本：确认「插件模板」的工具行清单与官方 standard 一致。
 * 只做静态检查（解析 + 对比 + 包存在性），不启动 host。
 *
 * 路径全部**动态解析**，不硬编码任何绝对路径：
 * - 官方包目录：从 `@deepseek-ai/dsh` 的 package.json 反查（借 host 自带的 yaml），
 *   换机器 / 换 node 版本都不用改脚本。
 * - 默认只校验 `templates/agent.cordis.yml.tpl`（结果确定，可进 CI）。
 * - 想额外校验某个本机预设，把路径作为命令行参数传入：
 *     node scripts/verify-cordis.mjs ~/.dsh/.agent-presets/companion-e4d0/agent.cordis.yml
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

/*
 * 官方 standard 预设的位置随 dsh 版本变过，两个都试：
 *  - 0.1.7-rc.2 起：`dsh-web-app/presets/standard.patch.yml`，行清单嵌在该 patch
 *    insert 的那条 `@deepseek-ai/dsh-agent-preset` 的 `config.plugins` 里
 *    （见 dsh-web-app/package.json 的 `dsh.bundle.patch` 列表）。
 *  - 更早：`dsh-agent-presets/presets/standard/agent.cordis.yml`，顶层就是行清单。
 * 找不到就报错退出，而不是静默比较空清单——那会把「官方行全对不上」伪装成通过。
 */
const STANDARD_FILE = [
  join(NM, 'dsh-web-app', 'presets', 'standard.patch.yml'),
  join(NM, 'dsh-agent-presets', 'presets', 'standard', 'agent.cordis.yml'),
].find((file) => existsSync(file))
if (!STANDARD_FILE) {
  console.error(
    '[ERROR] 找不到官方 standard 预设（dsh-web-app/presets/standard.patch.yml 与 '
    + 'dsh-agent-presets/presets/standard/agent.cordis.yml 都不存在），无法比对行清单',
  )
  process.exit(1)
}

const FILES = {
  standard: STANDARD_FILE,
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

/**
 * 取出「预设声明的行清单」。
 *
 * 两种官方形态：
 *  - 老版：`agent.cordis.yml` 顶层就是行清单，直接用。
 *  - 0.1.7-rc.2：`presets/standard.patch.yml` 顶层是 patch 行，真正的预设行
 *    嵌在 `insert` 里那条 `@deepseek-ai/dsh-agent-preset` 的 `config.plugins`。
 *    用 `insert` 里的 id 找（`preset-standard`），不硬编码顺序。
 */
function presetRowsOf(docs) {
  for (const row of docs ?? []) {
    for (const candidate of row?.insert ?? []) {
      if (candidate?.name === '@deepseek-ai/dsh-agent-preset' && Array.isArray(candidate.config?.plugins)) {
        return candidate.config.plugins
      }
    }
  }
  return docs
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
  const rows = presetRowsOf(merged)
  parsed[key] = { rows: collectRows(rows), groups: collectGroups(rows), errors }
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

/*
 * 2. 行清单：模板是**人格类**预设，有意不含官方 standard 的重型机械，
 *    所以不能要求「官方行齐备」。改成校验几条真正的意图：
 *    - 不许挂 persona（人格由 MD 承载，官方 persona 会覆盖它）；
 *    - 模板的行必须能在官方 standard 里找到同名行（防止拼错 name/id）；
 *    - 有意省略的那批行不许偷偷跑回来。
 * 本机预设（命令行传入）同样按这套口径校验。
 */
const INTENTIONALLY_OMITTED = new Set(['persona'])
/** 人格类预设有意不挂的重型机械（改了这里就要同步模板注释）。 */
const HEAVY_ROWS = new Set([
  'tool-jobs',
  'command-goal',
  'tool-goal',
  'planning',
  'plan-mode',
  'compaction',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
  'delegation',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-codex',
  'tool-subagent-claude-code',
  'workflow-worker-thread',
  'tool-workflow',
  'tool-ralph',
])
const stdMap = new Map(parsed.standard.rows.map((r) => [r.id, r]))

for (const key of ['preset', 'tpl'].filter((k) => parsed[k])) {
  const rows = parsed[key].rows
  const ids = new Set(rows.map((r) => r.id))

  // persona 必须缺席
  for (const id of INTENTIONALLY_OMITTED) {
    if (ids.has(id)) say('ERROR', `${key} 不该挂 ${id}（人格由 SYSTEM.md / IDENTITY.md 承载）`)
  }
  if ([...INTENTIONALLY_OMITTED].every((id) => !ids.has(id))) {
    say('INFO', `${key} 未挂 persona（符合人格类预设预期）`)
  }

  // 重型机械不该出现
  const heavy = [...ids].filter((id) => HEAVY_ROWS.has(id))
  if (heavy.length) say('WARN', `${key} 挂了重型机械行（若是有意的，请更新本脚本与模板注释）：${heavy.join(', ')}`)
  else say('INFO', `${key} 未挂 plan/compaction/委派 等重型机械行`)

  // 模板里出现的官方行，name/config 应与官方一致
  for (const row of rows) {
    if (row.id === 'companion' || row.id === 'mnemon') continue
    const s = stdMap.get(row.id)
    if (!s) {
      say('WARN', `${key}/${row.id} 在官方 standard 里没有同名行（自研或拼错？）`)
      continue
    }
    if (s.name !== row.name) say('ERROR', `${key}/${row.id} name 不一致：${row.name} != ${s.name}`)
    if (JSON.stringify(s.config ?? null) !== JSON.stringify(row.config ?? null) && row.config !== undefined) {
      say('WARN', `${key}/${row.id} config 与官方不同`)
    }
  }
  say('INFO', `${key} 共 ${rows.length} 行，其中自研/额外行：${[...ids].filter((id) => !stdMap.has(id)).join(', ') || '（无）'}`)
}

// 2b. 模板与「本机预设」的行清单应保持一致（同步过的两份不该漂移）
if (parsed.preset && parsed.tpl) {
  const tplIds = new Set(parsed.tpl.rows.map((r) => r.id))
  const presetIds = new Set(parsed.preset.rows.map((r) => r.id))
  const onlyTpl = [...tplIds].filter((id) => !presetIds.has(id))
  const onlyPreset = [...presetIds].filter((id) => !tplIds.has(id))
  if (onlyTpl.length || onlyPreset.length) {
    say('WARN', `tpl 与本机预设行清单不同：仅 tpl 有 [${onlyTpl.join(', ')}]，仅预设 有 [${onlyPreset.join(', ')}]`)
  } else {
    say('INFO', 'tpl 与本机预设行清单一致')
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
    // disabled 的行不会被启动，官方也不对它做存在性校验（见 dsh-agent-presets
    // 的 unresolvableRows：`if (Boolean(row.disabled)) continue`）
    if (row.disabled !== undefined && Boolean(row.disabled)) continue
    const m = /^@deepseek-ai\/([^/]+)/.exec(row.name ?? '')
    if (!m) continue
    if (!existsSync(join(NM, m[1]))) missing.push(`${row.id}->${row.name}`)
  }
  if (missing.length) say('ERROR', `${key} 引用了不存在的包：${missing.join(', ')}`)
  else say('INFO', `${key} 引用的官方包全部存在于 host node_modules`)
}

console.log(fail === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${fail})`)
process.exit(fail === 0 ? 0 : 1)
