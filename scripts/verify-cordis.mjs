/**
 * 校验用脚本：确认「莉莉预设」与「插件模板」的工具行清单与官方 standard 一致。
 * 只做静态检查（解析 + 对比 + 包存在性），不启动 host。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// yaml 不是本插件依赖，直接借用 host dsh 自带的副本（不污染插件依赖树）
const require = createRequire(
  'D:/soft/node/node-v22.23.2/node_modules/@deepseek-ai/dsh/node_modules/yaml/package.json',
)
const YAML = require('yaml')

const NM = 'D:/soft/node/node-v22.23.2/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const FILES = {
  standard: 'D:/soft/node/node-v22.23.2/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml',
  lil: 'C:/Users/kosei/.dsh/.agent-presets/presetmd-e4d0/agent.cordis.yml',
  tpl: 'D:/workspaces/ai/dsh-preset-md/templates/agent.cordis.yml.tpl',
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
for (const key of ['lil', 'tpl']) {
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
