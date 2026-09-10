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
/** 日志文件名（去掉 .md）的合法日期形态。 */
export const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
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

/**
 * 列出最近 count 个「有内容」的日志文件（按日期倒序），用于检索。
 *
 * 语义是「凑够 count 个文件」，**不是**「最近 count 个自然日」：
 * 日志只在有对话时才生成，空闲几天就会出现空档；按自然日回退可能一个都捞不到，
 * 按文件回退才是真正的「最近 count 次有记录的日子」。不足 count 个就有多少给多少。
 */
export function listJournalFiles(dir, count = 7) {
  if (!dir) return []
  const memoryDir = join(dir, MEMORY_DIR)
  let names
  try {
    names = readdirSync(memoryDir)
  } catch {
    return []
  }
  const limit = Number.isFinite(count) && count > 0 ? Math.floor(count) : 7
  return names
    .filter((name) => name.endsWith('.md') && DATE_KEY_PATTERN.test(name.slice(0, -3)))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .map((name) => ({ key: name.slice(0, -3), file: join(memoryDir, name) }))
}

/* ─────────────────────────── MD 条目级更新 ─────────────────────────── */

/**
 * 探测文本的主换行风格（CRLF / LF）。
 * 归一化只在内存里做，写回时必须还原成原风格，否则一次 `add` 会把整个文件
 * 的换行符换掉——Windows 用户的 git diff 会整文件爆炸。
 */
export function detectEol(text) {
  const source = String(text || '')
  const crlf = (source.match(/\r\n/g) || []).length
  const lf = (source.match(/\n/g) || []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/** 把 LF 文本还原成指定换行风格。 */
export function applyEol(text, eol) {
  return eol === '\r\n' ? String(text).replace(/\n/g, '\r\n') : String(text)
}

/** 把一次操作应用到文件文本上。 */
export function applyOp(prev, op, content, oldText) {
  const source = String(prev || '')
  const eol = detectEol(source)
  // 内部一律按 LF 处理，出口还原；content / old_text 同样先归一化
  const text = source.replace(/\r\n/g, '\n')
  const lf = (value) => String(value ?? '').replace(/\r\n/g, '\n')

  if (op === 'add') {
    const block = lf(content).trim()
    if (!block) return { ok: false, error: 'content 为空' }
    const body = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${block}\n` : `${block}\n`
    return { ok: true, text: applyEol(body, eol) }
  }
  const key = lf(oldText).replace(/^\n+|\n+$/g, '')
  if (!key.trim()) return { ok: false, error: 'old_text 为空' }
  const first = text.indexOf(key)
  if (first < 0) return { ok: false, error: 'old_text 未在文件中找到' }
  if (text.indexOf(key, first + key.length) >= 0) return { ok: false, error: 'old_text 在文件中出现多次，请给出更长的唯一片段' }
  if (op === 'replace') {
    const next = lf(content).trim()
    if (!next) return { ok: false, error: 'replace 的 content 为空' }
    return { ok: true, text: applyEol(`${text.slice(0, first)}${next}${text.slice(first + key.length)}`, eol) }
  }
  if (op === 'remove') {
    let next
    if (key.includes('\n')) {
      // 多行片段：按「整块」删除，并把删除后残留的连续空行收敛掉，
      // 否则 markdown 会逐渐积累空行块，段落结构被撑坏。
      const head = text.slice(0, first).replace(/\n+$/, '')
      const tail = text.slice(first + key.length).replace(/^\n+/, '')
      next = head && tail ? `${head}\n\n${tail}` : `${head}${tail}`
    } else {
      // 单行片段：只在该行内做替换，再判断这一行是否已经「没有内容」
      const lineStart = text.lastIndexOf('\n', first - 1) + 1
      const lineEndRaw = text.indexOf('\n', first + key.length)
      const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw
      const line = text.slice(lineStart, lineEnd)
      const replacement = line.replace(key, '')
      if (isBlankLine(replacement)) {
        // 只剩空白或光秃秃的列表/标题标记（如 `- `）→ 连行带换行一起删
        next = `${text.slice(0, lineStart)}${lineEndRaw < 0 ? '' : text.slice(lineEndRaw + 1)}`
      } else {
        next = `${text.slice(0, lineStart)}${replacement}${text.slice(lineEnd)}`
      }
    }
    return { ok: true, text: applyEol(next, eol) }
  }
  return { ok: false, error: `未知操作 ${op}` }
}

/**
 * 该行是否已「没有内容」：纯空白，或只剩光秃秃的 markdown 标记（`- `、`* `、`1. `、`# `、`> `）。
 * 用于 remove 后判断要不要把残留的空壳行一起收掉。
 */
export function isBlankLine(line) {
  const stripped = String(line ?? '')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s*/, '')
    .trim()
  return stripped === ''
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
