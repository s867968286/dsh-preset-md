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

import { atomicWrite, enqueue, readText } from './memory-store.mjs'
import { DEFAULT_SETTINGS, readSettings, resolvePaths, writeSettings } from './settings.mjs'
import { PRESET_FILES, agentCordisTemplate, renderAllTemplates } from './templates.mjs'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/preset-md'

export { DEFAULT_SETTINGS, readSettings, resolvePaths, writeSettings }

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const EDITABLE = new Set(PRESET_FILES.map((item) => item.file))

/* ────────────────────────── preset.yml 读写 ──────────────────────────
 * 不引 YAML 库（保持零依赖），只支持 name / description / order 三个标量字段，
 * 但把「引号转义」和「缺失字段」两件事做对：
 * - 写：值里出现 YAML 特殊字符时才加双引号，且**同时转义 \ 与 "**（不对称转义会篡改数据）；
 *       换行一律转成 \n 转义序列，不让它破坏文件结构。
 * - 读：双引号值走与写对称的反转义；**缺失字段返回 undefined 而不是 0**
 *       （`Number('') === 0` 会让所有没有 order 的伙伴排到最前面）。
 * ------------------------------------------------------------------ */

/** 该值能否不加引号直接写（保守：只放行安全字符）。 */
function isPlainSafe(text) {
  if (text === '') return false
  if (/^[\s]|[\s]$/.test(text)) return false
  if (/[:#'"\n\r\t\\]/.test(text)) return false
  if (/^[-?*&!|>%@`{}[\]]/.test(text)) return false
  return true
}

/** 序列化成 preset.yml 里的一行标量。 */
function quote(value) {
  const text = String(value ?? '')
  if (isPlainSafe(text)) return text
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, '\\n')
  return `"${escaped}"`
}

/** 解析一行标量（与 quote 对称）。 */
function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\(u[0-9a-fA-F]{4}|.)/g, (match, token) => {
        if (token === 'n') return '\n'
        if (token === 't') return '\t'
        if (token === 'r') return '\r'
        if (token === '\\') return '\\'
        if (token === '"') return '"'
        if (token.startsWith('u')) return String.fromCharCode(Number.parseInt(token.slice(1), 16))
        return match
      })
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/**
 * 读 preset.yml 的三个字段。
 *
 * - 字段缺失 → `undefined`（不回落 0 / ''），由调用方决定兜底；
 * - 支持 `key: "带: 冒号和引号"` 的引号值；
 * - 不支持 YAML 块标量（`key: |`）——读到会当成字面值 `|`，但不会污染别的字段。
 */
export function readPresetMeta(dir) {
  const text = readText(join(dir, 'preset.yml'))
  const pick = (key) => {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)
    return match ? unquote(match[1]) : undefined
  }
  const orderText = pick('order')
  const order = orderText === undefined ? undefined : Number(orderText)
  const name = pick('name')
  const description = pick('description')
  return {
    name: name === undefined ? '' : name,
    description: description === undefined ? '' : description,
    order: Number.isFinite(order) ? order : undefined,
  }
}

/**
 * 写 preset.yml（原子写）。
 *
 * 三个字段**始终写全**：空值写成 `""` / `0`，避免「字段行整条消失」导致
 * order 永久丢失（preset.yml 不在 changelog 留痕范围内，丢了无法回溯）。
 */
export function writePresetMeta(dir, { name, description, order }) {
  const lines = [
    `name: ${quote(name ?? '')}`,
    `description: ${quote(description ?? '')}`,
    `order: ${Number.isFinite(order) ? order : 0}`,
  ]
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

/**
 * 下一个可用的 order。
 *
 * 只统计**真实存在且有限**的 order（跳过缺字段的伙伴），不用 listAgents 的行值——
 * 那里的 `Number.MAX_SAFE_INTEGER` 是排序哨兵，拿来做 max+1 会算出无意义的巨大序号。
 */
export function nextOrder(paths) {
  if (!existsSync(paths.presetsRoot)) return 0
  let max = -1
  for (const entry of readdirSync(paths.presetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PRESET_ID.test(entry.name)) continue
    const { order } = readPresetMeta(join(paths.presetsRoot, entry.name))
    if (Number.isFinite(order) && order > max && order < Number.MAX_SAFE_INTEGER) max = order
  }
  return max + 1
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
    files,
  }
}

/** 写一个 MD 文件（白名单内）。走 memory-store 的写队列，避免与后台自动记忆
 *  形成「读-改-写」竞态（后台走 enqueue，这里直写会互相覆盖）。
 *  参数校验保持同步抛错，只有真正的写盘是异步的。 */
export function writeAgentFile(paths, id, file, content) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  if (!EDITABLE.has(file)) throw new Error(`不允许写 ${file}`)
  const dir = join(paths.presetsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  const target = join(dir, file)
  const text = String(content ?? '')
  return enqueue(target, () => atomicWrite(target, text)).then(() => ({ ok: true }))
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

  const order = nextOrder(paths)
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

  const order = nextOrder(paths)
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

/** 日记列表（日期倒序）。id 与日期都做校验，避免路径穿越。 */
export function listJournal(paths, id) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
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
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  if (!DATE_KEY.test(date)) throw new Error(`非法日期：${date}`)
  return readText(join(paths.presetsRoot, id, 'memory', `${date}.md`))
}

/* ────────────────────────────── HTTP ────────────────────────────── */

/** 请求体上限（字节）：超过即拒绝，避免无上限累积导致内存膨胀。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** 带 status 的错误：业务错误（4xx）与内部错误（500）要分开报，便于排查。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, `请求体超过上限 ${limit} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 读 JSON 请求体。体积超限（HttpError）要原样抛出，不能被当成「非法 JSON」吞掉。 */
async function readJson(req) {
  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    if (error instanceof HttpError) throw error
    return null
  }
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

/** 把领域函数抛出的错误映射成合适的 HTTP 状态：业务校验错误不该报成 500。 */
function statusOfError(error) {
  if (error instanceof HttpError) return error.status
  const message = error instanceof Error ? error.message : String(error)
  if (/非法 id|不允许写|请输入昵称|昵称不能为空|请求体/.test(message)) return 400
  if (/伙伴不存在/.test(message)) return 404
  return 500
}

/** 注册 `/preset-md` 前缀路由。 */
export function registerRoutes(ctx, home) {
  const paths = resolvePaths(home)
  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = statusOfError(error)
      // 未知异常才是 500：这时才值得记一条 warn，业务错误不必刷日志
      if (status >= 500) ctx.logger?.warn?.(`[preset-md] 请求处理失败：${message}`)
      sendJson(res, status, { error: message })
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
        // 昵称不允许清空：静默把 name 行写没会让 preset.yml 丢字段，
        // 这里显式拒绝，把决定权交回用户。
        if (body.name !== undefined && String(body.name).trim() === '') {
          return sendJson(res, 400, { error: '昵称不能为空' })
        }
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
        await writeAgentFile(paths, id, body.file, body.content)
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
