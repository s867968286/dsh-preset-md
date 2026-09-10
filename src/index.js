/**
 * dsh-preset-md 的 Host 半（bundle 行，host 平面）：给「伙伴设置」页面提供
 * HTTP 接口，读写 `<dshHome>/.agent-presets/<id>/` 下的文件。
 *
 * 设计约束：
 * - 只读/写 preset 目录与自己的设置文件，不碰别处；
 * - 删除 = 移动到 `<dshHome>/.agent-presets-backup/<id>-<时间戳>/`，不真删；
 * - 无第三方依赖：preset.yml 用极简正则读写（只有 name/description/order 三个字段）。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { atomicWrite, readText } from './memory-store.mjs'
import { DEFAULT_SETTINGS, readSettings, resolvePaths, writeSettings } from './settings.mjs'
import { PRESET_FILES, agentCordisTemplate, renderAllTemplates } from './templates.mjs'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/preset-md'

export { DEFAULT_SETTINGS, readSettings, resolvePaths, writeSettings }

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const EDITABLE = new Set(PRESET_FILES.map((item) => item.file))

function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

function quote(value) {
  const text = String(value ?? '')
  return /^[\w\u4e00-\u9fa5][^:#\n]*$/.test(text) && !text.includes('"') ? text : `"${text.replace(/"/g, '\\"')}"`
}

/** 读 preset.yml 的三个字段（不存在返回空）。 */
export function readPresetMeta(dir) {
  const text = readText(join(dir, 'preset.yml'))
  const pick = (key) => {
    const match = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(text)
    return match ? unquote(match[1]) : ''
  }
  const orderText = pick('order')
  const order = Number(orderText)
  return { name: pick('name'), description: pick('description'), order: Number.isFinite(order) ? order : undefined }
}

/** 写 preset.yml（原子写，只写非空字段）。 */
export function writePresetMeta(dir, { name, description, order }) {
  const lines = []
  if (name) lines.push(`name: ${quote(name)}`)
  if (description) lines.push(`description: ${quote(description)}`)
  if (Number.isFinite(order)) lines.push(`order: ${order}`)
  atomicWrite(join(dir, 'preset.yml'), `${lines.join('\n')}\n`)
}

/** 从名字生成合法 id（中文名回落使用 presetmd 前缀，一眼可辨是本插件创建的）。 */
export function generateId(name, existing) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const base = /^[a-z0-9]/.test(slug) ? slug : 'presetmd'
  for (let i = 0; i < 32; i += 1) {
    const id = `${base}-${randomUUID().slice(0, 4)}`
    if (!existing.has(id)) return id
  }
  throw new Error('生成 id 冲突次数过多')
}

/** 该预设是否挂了我们插件的 preset 行（读 agent.cordis.yml 找 `- id: preset-md`）。 */
export function usesPresetMd(dir) {
  const text = readText(join(dir, 'agent.cordis.yml'))
  return /(^|\n)\s*- id:\s*preset-md\s*(\n|$)/.test(text) || /name:\s*dsh-preset-md(\/preset)?\s*(\n|$)/.test(text)
}

/** 列出全部伙伴（按 order 升序）。 */
export function listAgents(paths) {
  if (!existsSync(paths.presetsRoot)) return []
  const rows = []
  for (const entry of readdirSync(paths.presetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PRESET_ID.test(entry.name)) continue
    const dir = join(paths.presetsRoot, entry.name)
    const meta = readPresetMeta(dir)
    rows.push({
      id: entry.name,
      name: meta.name || entry.name,
      description: meta.description,
      order: meta.order ?? Number.MAX_SAFE_INTEGER,
      usesPresetMd: usesPresetMd(dir),
      hasMemory: existsSync(join(dir, 'memory')),
    })
  }
  return rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** 读一个伙伴的全部 MD 内容与元信息。 */
export function readAgent(paths, id) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const dir = join(paths.presetsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  const meta = readPresetMeta(dir)
  const files = {}
  for (const { file } of PRESET_FILES) files[file] = readText(join(dir, file))
  return {
    id,
    name: meta.name || id,
    description: meta.description,
    usesPresetMd: usesPresetMd(dir),
    files,
  }
}

/** 给没挂本插件的预设追加 preset 行（B 方案「转成本插件」）。已挂则跳过。 */
export function upgradeToPresetMd(paths, id) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const dir = join(paths.presetsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  if (usesPresetMd(dir)) return { ok: true, already: true }
  const file = join(dir, 'agent.cordis.yml')
  const prev = readText(file)
  const addition = [
    '',
    '# ── 提示词注入与自动记忆（dsh-preset-md preset 行）──',
    '- id: preset-md',
    '  name: dsh-preset-md/preset',
    '',
  ].join('\n')
  atomicWrite(file, `${prev.replace(/\s+$/, '')}\n${addition}`)
  return { ok: true, already: false }
}

/** 写一个 MD 文件（白名单内）。 */
export function writeAgentFile(paths, id, file, content) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  if (!EDITABLE.has(file)) throw new Error(`不允许写 ${file}`)
  const dir = join(paths.presetsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  atomicWrite(join(dir, file), String(content ?? ''))
  return { ok: true }
}

/** 新建伙伴：生成 id、目录、模板文件、agent.cordis.yml、preset.yml。 */
export function createAgent(paths, { name, description = '', userName = '用户' }) {
  const clean = String(name || '').trim()
  if (!clean) throw new Error('请输入昵称')
  const existing = new Set(
    existsSync(paths.presetsRoot)
      ? readdirSync(paths.presetsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [],
  )
  const id = generateId(clean, existing)
  const dir = join(paths.presetsRoot, id)
  mkdirSync(dir, { recursive: true })

  const order = listAgents(paths).reduce((max, row) => Math.max(max, Number.isFinite(row.order) ? row.order : 0), -1) + 1
  atomicWrite(join(dir, 'agent.cordis.yml'), agentCordisTemplate(clean))
  writePresetMeta(dir, { name: clean, description: description || '', order })
  for (const [file, content] of Object.entries(renderAllTemplates({ name: clean, userName }))) {
    atomicWrite(join(dir, file), content)
  }
  mkdirSync(join(dir, 'memory'), { recursive: true })
  return readAgent(paths, id)
}

/** 复制伙伴：以某伙伴为模板克隆一个同名性格的新伙伴。
 *  保留源的全部 MD 与 agent.cordis.yml（含注入行），把其中出现的源名字面替换为新昵称；
 *  不带历史日记（memory/ 新建为空），description 沿用、order 排到末尾。 */
export function copyAgent(paths, sourceId, { name } = {}) {
  if (!PRESET_ID.test(sourceId)) throw new Error(`非法 id：${sourceId}`)
  const srcDir = join(paths.presetsRoot, sourceId)
  if (!existsSync(srcDir)) throw new Error(`伙伴不存在：${sourceId}`)
  const sourceMeta = readPresetMeta(srcDir)
  const oldName = sourceMeta.name || sourceId
  const clean = String(name || '').trim() || `${oldName} 的副本`
  const existing = new Set(
    existsSync(paths.presetsRoot)
      ? readdirSync(paths.presetsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [],
  )
  const id = generateId(clean, existing)
  const dir = join(paths.presetsRoot, id)
  mkdirSync(dir, { recursive: true })

  const renameIn = (text) => (oldName === clean ? text : text.split(oldName).join(clean))

  // 复制六个 MD 与 agent.cordis.yml（preset.yml 由下方按新名字重写）
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'preset.yml') continue
    if (PRESET_FILES.some((item) => item.file === entry.name) || entry.name === 'agent.cordis.yml') {
      atomicWrite(join(dir, entry.name), renameIn(readText(join(srcDir, entry.name))))
    }
  }

  const order = listAgents(paths).reduce((max, row) => Math.max(max, Number.isFinite(row.order) ? row.order : 0), -1) + 1
  writePresetMeta(dir, { name: clean, description: sourceMeta.description, order })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  return readAgent(paths, id)
}

/** 删除 = 移动到备份目录（不真删）。 */
export function archiveAgent(paths, id, now = new Date()) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const dir = join(paths.presetsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const target = join(paths.backupRoot, `${id}-${stamp}`)
  mkdirSync(paths.backupRoot, { recursive: true })
  renameSync(dir, target)
  return { archived: target }
}

/** 日记列表（日期倒序）。 */
export function listJournal(paths, id) {
  const dir = join(paths.presetsRoot, id, 'memory')
  if (!existsSync(dir)) return []
  const rows = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || !DATE_KEY.test(name.slice(0, -3))) continue
    const full = join(dir, name)
    const text = readText(full)
    const first = text.split('\n').find((line) => line.trim() && !line.startsWith('#')) ?? ''
    rows.push({ date: name.slice(0, -3), size: statSync(full).size, preview: first.trim().slice(0, 60) })
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/** 读某天日记全文。 */
export function readJournal(paths, id, date) {
  if (!DATE_KEY.test(date)) throw new Error(`非法日期：${date}`)
  return readText(join(paths.presetsRoot, id, 'memory', `${date}.md`))
}

/* ────────────────────────────── HTTP ────────────────────────────── */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  try {
    const parsed = JSON.parse((await readBody(req)) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

/** 注册 `/preset-md` 前缀路由。 */
export function registerRoutes(ctx, home) {
  const paths = resolvePaths(home)
  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: guard(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rest = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = req.method ?? 'GET'

      if (rest === '/api/agents' && method === 'GET') return sendJson(res, 200, { agents: listAgents(paths) })
      if (rest === '/api/agents' && method === 'POST') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return sendJson(res, 201, { agent: createAgent(paths, body) })
      }
      if (rest === '/api/settings' && method === 'GET') return sendJson(res, 200, { settings: readSettings(paths) })
      if (rest === '/api/settings' && method === 'PUT') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return sendJson(res, 200, { settings: writeSettings(paths, body) })
      }

      const agentMatch = /^\/api\/agents\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(rest)
      if (!agentMatch) return sendJson(res, 404, { error: 'not found' })
      const id = agentMatch[1]
      const sub = agentMatch[2] ?? ''

      if (sub === '' && method === 'GET') return sendJson(res, 200, { agent: readAgent(paths, id) })
      if (sub === '' && method === 'DELETE') return sendJson(res, 200, archiveAgent(paths, id))
      if (sub === '/copy' && method === 'POST') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return sendJson(res, 201, { agent: copyAgent(paths, id, body) })
      }
      if (sub === '/meta' && method === 'PUT') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        const dir = join(paths.presetsRoot, id)
        if (!existsSync(dir)) return sendJson(res, 404, { error: `伙伴不存在：${id}` })
        const current = readPresetMeta(dir)
        writePresetMeta(dir, {
          name: body.name !== undefined ? String(body.name).trim() : current.name,
          description: body.description !== undefined ? String(body.description) : current.description,
          order: current.order,
        })
        return sendJson(res, 200, { agent: readAgent(paths, id) })
      }
      if (sub === '/file' && method === 'PUT') {
        const body = await readJson(req)
        if (!body || typeof body.file !== 'string') return sendJson(res, 400, { error: '需要 { file, content }' })
        writeAgentFile(paths, id, body.file, body.content)
        return sendJson(res, 200, { ok: true })
      }
      if (sub === '/upgrade' && method === 'POST') {
        const result = upgradeToPresetMd(paths, id)
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (sub === '/journal' && method === 'GET') return sendJson(res, 200, { journal: listJournal(paths, id) })
      const journalMatch = /^\/journal\/(\d{4}-\d{2}-\d{2})$/.exec(sub)
      if (journalMatch && method === 'GET') {
        return sendJson(res, 200, { date: journalMatch[1], text: readJournal(paths, id, journalMatch[1]) })
      }
      return sendJson(res, 404, { error: 'not found' })
    }),
  })
}

export const name = 'preset-md-host'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  registerRoutes(ctx, config.dshHome)
}
