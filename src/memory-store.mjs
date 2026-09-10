/**
 * 记忆存储层（零依赖）：按天日志追加、MD 条目级更新、每个文件一份 changelog。
 *
 * 纪律：
 * - 所有写盘走原子写（临时文件 + rename）；
 * - 同一路径的写操作串行（enqueue），避免并发覆盖；
 * - 改 MD 之前先写 changelog（留痕），changelog 按「块」裁剪，绝不切断一条记录。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/** 日志目录（相对 preset 目录）。 */
export const MEMORY_DIR = 'memory'
/** changelog 目录：与 memory 同级，每个被改的 MD 一个文件。 */
export const CHANGELOG_DIR = 'changelog'
/** 单个 changelog 文件的字节上限（按块裁剪，保留最新的块）。 */
export const CHANGELOG_MAX_BYTES = 32 * 1024
/** 允许 AI 修改的文件（SYSTEM.md / AGENTS.md 不在其中）。 */
export const EDITABLE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md']

const queues = new Map()

/** 同一路径串行写。 */
export function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(key, next.then(() => {}, () => {}))
  return next
}

/** 原子写文本。 */
export function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
}

/** 读文本，失败返回 ''。 */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 本地日期 YYYY-MM-DD。 */
export function dateKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 本地时间 HH:MM。 */
export function timeKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/* ────────────────────────────── 日志 ────────────────────────────── */

/** 某天的日志文件路径。 */
export function journalPath(dir, key) {
  return join(dir, MEMORY_DIR, `${key}.md`)
}

/**
 * 追加一段日志到当天文件（文件不存在则创建，带 `# 日期` 头）。
 * @param {string} dir - preset 目录
 * @param {string} body - markdown 正文（不含 `## 时间` 标题）
 * @returns {Promise<{ok: boolean, file?: string, key?: string, error?: string}>}
 */
export function appendJournal(dir, body, now = new Date()) {
  const text = String(body || '').trim()
  if (!text) return Promise.resolve({ ok: false, error: '日志正文为空' })
  const key = dateKey(now)
  const file = journalPath(dir, key)
  return enqueue(file, () => {
    const prev = readText(file)
    const head = prev.trim() ? prev.replace(/\s+$/, '') : `# ${key}`
    const block = `## ${timeKey(now)}\n\n${text}`
    atomicWrite(file, `${head}\n\n${block}\n`)
    return { ok: true, file, key }
  })
}

/** 列出最近 days 天的日志文件（倒序），用于检索。 */
export function listJournalFiles(dir, days = 7) {
  const today = new Date()
  const out = []
  for (let i = 0; i < Math.max(1, days); i += 1) {
    const key = dateKey(new Date(today.getTime() - i * 86400000))
    const file = journalPath(dir, key)
    if (existsSync(file)) out.push({ key, file })
  }
  return out
}

/* ─────────────────────────── MD 条目级更新 ─────────────────────────── */

/** 把一次操作应用到文件文本上。 */
export function applyOp(prev, op, content, oldText) {
  const text = String(prev || '').replace(/\r\n/g, '\n')
  if (op === 'add') {
    const block = String(content || '').trim()
    if (!block) return { ok: false, error: 'content 为空' }
    const body = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${block}\n` : `${block}\n`
    return { ok: true, text: body }
  }
  const key = String(oldText || '').replace(/^\n+|\n+$/g, '')
  if (!key.trim()) return { ok: false, error: 'old_text 为空' }
  const first = text.indexOf(key)
  if (first < 0) return { ok: false, error: 'old_text 未在文件中找到' }
  if (text.indexOf(key, first + key.length) >= 0) return { ok: false, error: 'old_text 在文件中出现多次，请给出更长的唯一片段' }
  if (op === 'replace') {
    const next = String(content || '').trim()
    if (!next) return { ok: false, error: 'replace 的 content 为空' }
    return { ok: true, text: `${text.slice(0, first)}${next}${text.slice(first + key.length)}` }
  }
  if (op === 'remove') {
    const lineStart = text.lastIndexOf('\n', first - 1) + 1
    let lineEnd = text.indexOf('\n', first + key.length)
    if (lineEnd < 0) lineEnd = text.length
    const line = text.slice(lineStart, lineEnd)
    // 整行就是目标 → 连行一起删；否则只删片段
    const next = line.trim() === key
      ? `${text.slice(0, lineStart)}${text.slice(lineEnd + 1)}`
      : `${text.slice(0, first)}${text.slice(first + key.length)}`
    return { ok: true, text: next }
  }
  return { ok: false, error: `未知操作 ${op}` }
}

/**
 * 应用一次文件更新：白名单校验 → 先写 changelog → 原子写文件。
 * @returns {Promise<{ok: boolean, file?: string, op?: string, error?: string}>}
 */
export function applyUpdate(dir, file, op, content, oldText, now = new Date()) {
  const target = String(file || '').trim()
  if (!EDITABLE_FILES.includes(target)) {
    return Promise.resolve({ ok: false, error: `不允许修改 ${target || '(空文件名)'}（只允许 ${EDITABLE_FILES.join(' / ')}）` })
  }
  const action = String(op || '').trim()
  const path = join(dir, target)
  return enqueue(path, () => {
    const prev = readText(path)
    const result = applyOp(prev, action, content, oldText)
    if (!result.ok) return { ok: false, error: result.error }
    appendChangelog(dir, target, { op: action, oldText, content, now })
    atomicWrite(path, result.text)
    return { ok: true, file: target, op: action }
  })
}

/* ────────────────────────────── changelog ────────────────────────────── */

/** 某个 MD 文件对应的 changelog 路径：`memory/changelog/SOUL.changelog.md`。 */
export function changelogPath(dir, file) {
  const base = String(file || '').replace(/\.md$/i, '')
  return join(dir, CHANGELOG_DIR, `${base}.changelog.md`)
}

function oneLine(text, max = 200) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 按「块」裁剪 changelog：块以 `## ` 开头，从最旧的整块开始丢，
 * 直到总长度不超过 maxBytes——绝不切断一条记录。
 */
export function trimChangelog(text, maxBytes = CHANGELOG_MAX_BYTES) {
  const blocks = String(text || '')
    .split(/\n(?=## )/)
    .map((block) => block.replace(/\s+$/, ''))
    .filter((block) => block.trim())
  if (blocks.length === 0) return ''
  while (blocks.length > 1 && Buffer.byteLength(`${blocks.join('\n\n')}\n`, 'utf8') > maxBytes) blocks.shift()
  return `${blocks.join('\n\n')}\n`
}

/** 追加一条变更记录（同步；调用方已在串行队列里）。 */
export function appendChangelog(dir, file, { op, oldText, content, now = new Date() }) {
  const path = changelogPath(dir, file)
  const lines = [`## ${dateKey(now)} ${timeKey(now)}`, '', `- file: ${file}`, `- op: ${op}`]
  if (oldText) lines.push(`- old: ${oneLine(oldText)}`)
  if (content) lines.push(`- new: ${oneLine(content)}`)
  const prev = readText(path)
  const merged = `${prev.trimEnd()}${prev.trim() ? '\n\n' : ''}${lines.join('\n')}\n`
  atomicWrite(path, trimChangelog(merged))
  return path
}
