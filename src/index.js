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
import { randomUUID, createHash } from 'node:crypto'

import { atomicWrite, enqueue, readText } from './memory-store.mjs'
import { DEFAULT_SETTINGS, readSettings, resolvePaths, writeSettings } from './settings.mjs'
import { PRESET_FILES, agentCordisTemplate, renderAllTemplates } from './templates.mjs'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/preset-md'

export { DEFAULT_SETTINGS, readSettings, resolvePaths, writeSettings }

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const EDITABLE = new Set(PRESET_FILES.map((item) => item.file))

/** 带 status 的错误：业务错误（4xx）与内部错误（500）要分开报，便于排查。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * 昵称 / 签名的长度上限（字符）。
 *
 * 存在的理由有两个，都不是「洁癖」：
 * - 昵称会进 `preset.yml` 与 `IDENTITY.md`，签名会进 `preset.yml` 与预设卡片；
 *   而 `listAgents` 每次列表都要整份读每个预设的 `preset.yml`，无上限时
 *   一个超大值就能把设置页拖慢。
 * - 这个接口是暴露在本机 HTTP 上的（来源校验之外的纵深防御），
 *   没有长度上限的写接口等于允许无限膨胀。
 */
export const MAX_NAME_CHARS = 60
export const MAX_DESCRIPTION_CHARS = 200

/** 校验一个文本字段的长度，超限抛 400（HttpError 定义在本文件常量区，可直接用）。 */
function assertLength(value, max, label) {
  const text = String(value ?? '')
  if (text.length > max) throw new HttpError(400, `${label}过长（上限 ${max} 字符，当前 ${text.length}）`)
  return text
}

/* ────────────────────────── preset.yml 读写 ──────────────────────────
 * 不引 YAML 库（保持零依赖），只支持 name / description / order 三个标量字段，
 * 但把「引号转义」和「缺失字段」两件事做对：
 * - 写：值里出现 YAML 特殊字符时才加双引号，且**同时转义 \ 与 "**（不对称转义会篡改数据）；
 *       换行一律转成 \n 转义序列，不让它破坏文件结构。
 * - 读：双引号值走与写对称的反转义；**缺失字段返回 undefined 而不是 0**
 *       （`Number('') === 0` 会让所有没有 order 的伙伴排到最前面）。
 * ------------------------------------------------------------------ */

/**
 * 该值能否不加引号直接写（保守：只放行安全字符）。
 *
 * **必须额外拒绝 YAML 会隐式类型化的形态**——这是本插件最容易踩的坑：
 * 官方用 js-yaml 读这个文件（`dsh-agent-presets` 的 `readPresetMetadata`），
 * 而未加引号的 `123` / `true` / `null` / `~` / `2026-09-13` 会被读成
 * number / boolean / null / Date，而不是字符串。实测：
 *
 *   name: 123          -> typeof 'number'
 *   name: true         -> typeof 'boolean'
 *   name: 2026-09-13   -> Date 实例
 *
 * 官方对类型不符的字段是**静默降级成 undefined**（`text()` 只接受 string），
 * 于是昵称在预设选择器里悄悄消失、回落显示成 `presetmd-xxxx`——不报错，只丢数据。
 * 所以这些形态一律强制加引号，让它作为字符串被读回。
 */
export function isPlainSafe(text) {
  if (text === '') return false
  if (/^[\s]|[\s]$/.test(text)) return false
  if (/[:#'"\n\r\t\\]/.test(text)) return false
  if (/^[-?*&!|>%@`{}[\]]/.test(text)) return false
  if (looksTyped(text)) return false
  return true
}

/**
 * 该标量是否会被 YAML 隐式解析成非字符串（number / boolean / null / Date）。
 *
 * 覆盖 js-yaml 的核心 schema：十进制（含 `+1`、`.5`、`1.5`、`1e3`）、
 * 八进制 `0o17`、十六进制 `0x10`、`.inf`/`.nan`、布尔与 null 的全套写法
 * （`true|false|yes|no|on|off` 及大小写变体、`null|~|`）、
 * 以及会被读成 Date 的日期/时间戳形态。
 *
 * 宁可多引几个（多一对引号无害），也不要漏——漏一个就是静默丢昵称。
 */
export function looksTyped(text) {
  const value = String(text ?? '')
  if (value === '') return false
  // 布尔与 null 的全套拼写（YAML 1.1 的 yes/no/on/off，js-yaml 默认仍认）
  if (/^(?:true|false|yes|no|on|off|null|~)$/i.test(value)) return true
  // 数值：十进制（含符号、小数点、指数）、八进制、十六进制、无穷与 NaN
  if (/^[-+]?(?:0b[01_]+|0o?[0-7_]+|0x[0-9a-f_]+|\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)$/i.test(value)) return true
  if (/^[-+]?\.(?:inf|nan)$/i.test(value)) return true
  // 日期 / 时间戳：`2026-09-13`、`2026-09-13 10:00:00`、`2026-09-13T10:00:00Z`
  if (/^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d*)?)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::\d{2})?))?)?$/.test(value)) return true
  return false
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
 *
 * 刻意**只读三个字段**：其余键（`id` / `model` / 用户自加的）与本插件无关，
 * 由 `mergePresetMeta` 原样保留即可，这里读不读都不影响它们。
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
 * ## 为什么是「按行合并」而不是整文件重写
 *
 * preset.yml **不是本插件独有的文件**：它归官方 `@deepseek-ai/dsh-agent-presets`
 * 管理（`METADATA_FILE = 'preset.yml'`），官方只在「复制预设」时用 js-yaml 重写它。
 * 用户完全可以手工往里加注释、或加官方当前不读的键（`id` / `model` / `tools.deny` …），
 * 甚至整份手写。
 *
 * 早先这里是「三个字段写全、其余丢弃」的整文件重写，实测改一次昵称就会把
 * 注释与 `id` / `model` / `tools.deny` 全部抹掉——而 `readPresetMeta` 只读三个字段，
 * 看不出这个损失。所以现在改成：**只替换三个已知键的行，其余原样保留**。
 *
 * ## 三条写法规则
 *
 * - **order 为 undefined 时不写该行**（而不是写 0）。官方排序是
 *   `order ?? Infinity`（无 order 排最后），写成 0 会让手工预设从列表末尾
 *   跳到最前——正好与「缺 order 排最后」相反。
 * - **description 为空时同样不新增该行**，与官方 `renderPresetMetadata`
 *   「省略 undefined 而非写空」一致；但**原文里已有该行就照常更新**
 *   （含更新成 `""`）——用户显式清空签名与「从来没设过」是两件事。
 * - **name 始终写**：昵称是必须项。调用方已保证非空（`/meta` 显式拒绝清空），
 *   这里空值也会落一行显式空串，免得「没昵称」和「没这文件」分不清。
 */
export function writePresetMeta(dir, { name, description, order }) {
  const file = join(dir, 'preset.yml')
  const next = mergePresetMeta(readText(file), { name, description, order })
  atomicWrite(file, next)
}

/**
 * 把三个字段合并进原文，返回新的文件文本。
 *
 * 逐行扫描：命中 `name:` / `description:` / `order:` 的**顶层**行就替换掉整行，
 * 其余行（注释、空行、别的键、以及它们的子行）逐字保留。原文里没有的键，
 * 按下面的「按需追加」规则决定是否补到末尾。保留原文的换行风格（CRLF / LF）。
 *
 * 单独导出是为了可单测——它是这个文件里唯一有真实复杂度的逻辑。
 */
export function mergePresetMeta(prev, { name, description, order }) {
  const source = String(prev ?? '')
  const eol = detectPresetEol(source)
  const lines = source.replace(/\r\n/g, '\n').split('\n')

  // 要写入的键 -> { line, append }；append 表示「原文没有时是否补一行」
  const wanted = new Map()
  if (name !== undefined) wanted.set('name', { line: `name: ${quote(name)}`, append: true })
  if (description !== undefined) {
    /*
     * 空的 description **只更新已有行、不新增**：与官方
     * `renderPresetMetadata`（省略 undefined）一致。
     * 有值则允许追加——用户确实设了签名，不该因为原文没这行就丢掉。
     */
    const text = quote(description)
    wanted.set('description', { line: `description: ${text}`, append: String(description) !== '' })
  }
  if (Number.isFinite(order)) wanted.set('order', { line: `order: ${order}`, append: true })

  const written = new Set()
  const out = []
  /*
   * 是否正在跳过「被替换掉的块标量的内容行」。
   *
   * 两个用途都用它，但语义相反，必须分开：
   * - 命中块标量起始行（`description: |`）→ 该行被替换成单行标量，
   *   它原来那些缩进内容行必须**一起丢掉**，否则残留下来就是非法 YAML
   *   （顶层出现缩进行）。所以「替换后」也要继续吞掉后续缩进行。
   * - 没命中块标量起始行（例如我们这次不动 description）→ 内容行里可能出现
   *   长得像 `name: xxx` 的文本，不能被误当成字段替换，同样要跳过。
   */
  let inBlockScalar = false
  /** 当前跳过的块，是不是「正被替换」的那个（决定内容行丢弃还是保留）。 */
  let swallowBlockBody = false
  for (const line of lines) {
    if (inBlockScalar) {
      if (line.trim() === '' || /^\s/.test(line)) {
        // 内容行：若这个块正被替换，就整行丢弃；否则原样保留
        if (!swallowBlockBody) out.push(line)
        continue
      }
      inBlockScalar = false
      swallowBlockBody = false
    }

    const match = /^(name|description|order):[ \t]*(.*)$/.exec(line)
    if (match && wanted.has(match[1]) && !written.has(match[1])) {
      const entry = wanted.get(match[1])
      out.push(entry.line)
      written.add(match[1])
      if (/^[|>]/.test(match[2].trim())) {
        // 块标量起始行被替换：把它原来的内容行也一并吞掉
        inBlockScalar = true
        swallowBlockBody = true
      }
      continue
    }
    out.push(line)
  }

  // 原文里没有的键，按 append 规则补到末尾（先去掉尾部空行，避免越攒越多）
  const appended = [...wanted.entries()]
    .filter(([key, entry]) => !written.has(key) && entry.append)
    .map(([, entry]) => entry.line)
  let body = out.join('\n').replace(/\n+$/, '')
  if (appended.length > 0) body = body ? `${body}\n${appended.join('\n')}` : appended.join('\n')
  return applyPresetEol(`${body}\n`, eol)
}

/** 探测文本的主换行风格（与 memory-store 的 detectEol 同规则，避免循环依赖而本地实现）。 */
function detectPresetEol(text) {
  const source = String(text ?? '')
  const crlf = (source.match(/\r\n/g) || []).length
  const lf = (source.match(/\n/g) || []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/** 把 LF 文本还原成指定换行风格。 */
function applyPresetEol(text, eol) {
  return eol === '\r\n' ? String(text).replace(/\n/g, '\r\n') : String(text)
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

/** 读一个伙伴的全部 MD 内容与元信息。
 *
 *  一并返回每个文件的**版本指纹**（内容哈希），供编辑冲突检测用：
 *  UI 载入时拿到它，保存时原样回传，服务端比对不一致就报 409。 */
export function readAgent(paths, id) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const dir = join(paths.presetsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  const meta = readPresetMeta(dir)
  const files = {}
  const versions = {}
  for (const { file } of PRESET_FILES) {
    const text = readText(join(dir, file))
    files[file] = text
    versions[file] = contentHash(text)
  }
  return {
    id,
    name: meta.name || id,
    description: meta.description,
    files,
    versions,
  }
}

/** 内容指纹（sha256 前 16 位十六进制）：只用于「和载入时是否一致」，不做安全用途。 */
export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 写一个 MD 文件（白名单内）。走 memory-store 的写队列，避免与后台自动记忆
 * 形成「读-改-写」竞态（后台走 enqueue，这里直写会互相覆盖）。
 * 参数校验保持同步抛错，只有真正的写盘是异步的。
 *
 * ## 乐观并发：`baseVersion`
 *
 * 后台自动记忆会往同一个文件追加内容（`runReview` → `applyUpdate`）。
 * 若用户在设置页打开 MEMORY.md 编辑十分钟、期间后台追加了一条记忆，
 * 应用户点保存时若直接整文件覆盖，那条记忆就**静默消失**——两边都不报错。
 *
 * 所以 UI 保存时回传载入时的 `baseVersion`（`readAgent` 给的内容哈希），
 * 这里在写队列**内部**实时比对：不一致就抛 409，让用户重新载入后再决定。
 * 比对必须在队列里做（而不是进队列之前），否则两个并发写会双双读到旧值。
 *
 * 不传 `baseVersion` 时保持旧行为（无校验）——给脚本 / 命令行调用留后路。
 */
export function writeAgentFile(paths, id, file, content, { baseVersion } = {}) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  if (!EDITABLE.has(file)) throw new Error(`不允许写 ${file}`)
  const dir = join(paths.presetsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  const target = join(dir, file)
  const text = String(content ?? '')
  return enqueue(target, () => {
    if (typeof baseVersion === 'string' && baseVersion !== '') {
      const current = contentHash(readText(target))
      if (current !== baseVersion) {
        throw new HttpError(409, `${file} 已被后台修改（例如自动记忆写入），请重新载入后再保存`)
      }
    }
    atomicWrite(target, text)
    return { ok: true, version: contentHash(text) }
  })
}

/** 新建伙伴：生成 id、目录、模板文件、agent.cordis.yml、preset.yml。 */
export function createAgent(paths, { name, description = '', userName = '用户' }) {
  const clean = assertLength(String(name ?? '').trim(), MAX_NAME_CHARS, '昵称')
  if (!clean) throw new Error('请输入昵称')
  const desc = assertLength(String(description ?? ''), MAX_DESCRIPTION_CHARS, '个性签名')
  const user = assertLength(String(userName ?? '').trim() || '用户', MAX_NAME_CHARS, '用户名')
  const existing = new Set(
    existsSync(paths.presetsRoot)
      ? readdirSync(paths.presetsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [],
  )
  const id = generateId(clean, existing)
  const dir = join(paths.presetsRoot, id)
  mkdirSync(dir, { recursive: true })

  const order = nextOrder(paths)
  atomicWrite(join(dir, 'agent.cordis.yml'), agentCordisTemplate())
  // description 为空则不写该行（官方同样省略空字段，见 writePresetMeta 注释）
  writePresetMeta(dir, { name: clean, description: desc || undefined, order })
  for (const [file, content] of Object.entries(renderAllTemplates({ name: clean, userName: user }))) {
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
  const clean = assertLength(String(name ?? '').trim() || `${oldName} 的副本`, MAX_NAME_CHARS, '昵称')
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
  /*
   * description：源有值就沿用，源没有（读成 ''）就**不写这一行**——
   * 与官方 `renderPresetMetadata` 的「省略 undefined 而非写空」一致，
   * 避免把一个从未声明过的字段固化进副本。
   */
  writePresetMeta(dir, {
    name: clean,
    description: sourceMeta.description ? sourceMeta.description : undefined,
    order,
  })
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * 读请求体，超过上限抛 413。
 *
 * **超限时不能立刻 `req.destroy()`**：那会把 socket 一起拆掉，等上层 catch 里
 * 写响应时连接已经死了——客户端拿到的是 `UND_ERR_SOCKET`（「网络错误，未知原因」），
 * 而不是 413。用户体感从「请求体超过上限」退化成看不出原因的连接失败。
 *
 * 正确做法：标记超限、**停止累积**（丢掉后续 chunk 释放引用），但仍把流读完，
 * 让上层能正常写回 413；响应发完由 Node 自己收尾。
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overflowed = false
    req.on('data', (chunk) => {
      if (overflowed) return // 已判超限：不再累积，仅把剩余数据读掉
      size += chunk.length
      if (size > limit) {
        overflowed = true
        chunks.length = 0
        reject(new HttpError(413, `请求体超过上限 ${limit} 字节`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      // 超限后我们已 reject，此后的 socket 错误不该再改变结果
      if (!overflowed) reject(error)
    })
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
export function statusOfError(error) {
  if (error instanceof HttpError) return error.status
  const message = error instanceof Error ? error.message : String(error)
  if (/非法 id|不允许写|请输入昵称|昵称不能为空|请求体|过长/.test(message)) return 400
  if (/伙伴不存在/.test(message)) return 404
  return 500
}

/**
 * 判断一个写请求是不是**同源页面**发来的。
 *
 * ## 为什么必须自己校验
 *
 * 官方没有全局来源校验：`dsh-host-webserver` 的 `handle()` 只做路由分发
 * （`lib/index.js` 的 `Service.init`，唯一中间件是可选 gzip）。官方确实有
 * 一道 fence（`dsh-client-connection` 的 `isTrustedApiRequest`：校验 host 回环 +
 * `sec-fetch-site !== 'cross-site'` + Origin 同源，不给过就 403），但它只挂在
 * **`/api` 那一条 channel** 上。本插件注册的 `/preset-md` 是独立 route，
 * 完全不经过它——这里是唯一防线。
 *
 * 不设防的后果不是「读数据」，而是**在用户的预设目录里凭空造伙伴**：
 * `POST /api/agents` 配 `content-type: text/plain` 属于 CORS「简单请求」，
 * 不需要预检，任意网页都能打通；写进去的昵称会进 `IDENTITY.md` / `USER.md`。
 * （`PUT` / `DELETE` 因为要预检、而我们对 `OPTIONS` 回 404 无 ACAO，
 * 是被**偶然**挡住的，不能当成设计。）实测确认过这条链路可达。
 *
 * ## 判据（照抄官方 `/api` fence 的口径）
 *
 * - `sec-fetch-site: cross-site` → 拒。这是浏览器给出的、页面脚本无法伪造的信号。
 * - 带 `origin` 头时：必须是可解析的、与 `host` 同源的值；
 *   `origin: null`（沙箱 iframe / data: 页面）一律拒。
 * - **两个头都拿不到**（非浏览器客户端，如 curl）→ 放行：
 *   我们防的是「用户浏览器里的恶意页面」，不是本机命令行的使用者。
 */
export function isSameOriginRequest(req) {
  const headers = req?.headers ?? {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false

  const origin = headers.origin
  // 没有 Origin 头：非浏览器客户端（或同源的旧式请求），交给上层
  if (typeof origin !== 'string' || origin === '') return true

  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  // `null` 是不可信来源（沙箱 iframe / data: URL），不能当成「没有 Origin」
  if (origin === 'null') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 读方法不写盘，不参与来源校验。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

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

      /*
       * 来源校验放在最前：写请求一律要过，且要早于读体——
       * 否则跨站请求还能靠超大 body 逼我们读满再拒。
       */
      if (WRITE_METHODS.has(method) && !isSameOriginRequest(req)) {
        ctx.logger?.warn?.(`[preset-md] 拒绝跨站写请求：${method} ${rest}`)
        return sendJson(res, 403, { error: '拒绝来自其他站点的写请求' })
      }

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
          name: assertLength(String(body.name !== undefined ? String(body.name).trim() : current.name), MAX_NAME_CHARS, '昵称'),
          /*
           * description 只有「用户显式提交了这个键」才动它：
           * 提交空串 = 清空签名（写出 `description: ""`，
           * 与「不提交该键」= 保持原样，是两件事）。
           */
          description: assertLength(
            body.description !== undefined ? String(body.description) : current.description,
            MAX_DESCRIPTION_CHARS,
            '个性签名',
          ),
          order: current.order,
        })
        return sendJson(res, 200, { agent: readAgent(paths, id) })
      }
      if (sub === '/file' && method === 'PUT') {
        const body = await readJson(req)
        if (!body || typeof body.file !== 'string') return sendJson(res, 400, { error: '需要 { file, content }' })
        // baseVersion 可选：带上则做乐观并发校验（后台自动记忆可能已改过该文件）
        const result = await writeAgentFile(paths, id, body.file, body.content, { baseVersion: body.baseVersion })
        return sendJson(res, 200, result)
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
