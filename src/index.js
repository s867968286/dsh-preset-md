/**
 * dsh-companion 的 Host 半（bundle 行，host 平面）：给「伙伴设置」页面提供
 * HTTP 接口，读写 `<dshHome>/.agent-presets/<id>/` 下的文件。
 *
 * 设计约束：
 * - 只读/写 preset 目录与自己的设置文件，不碰别处；
 * - 删除 = 移动到 `<dshHome>/.agent-presets-backup/<id>-<时间戳>/`，不真删；
 * - 无第三方依赖：preset.yml 用极简正则读写（只有 name/description/order 三个字段）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

import { atomicWrite, enqueue, readText } from './memory-store.mjs'
import {
  companionFromEvents,
  injectCompanionPrompt,
  normalizeCompanion,
  recordCompanionSelection,
} from './companion.mjs'
import {
  DEFAULT_SETTINGS,
  deleteBinding,
  readBindings,
  readSettings,
  resolvePaths,
  writeSettings,
} from './settings.mjs'
import { companionPresetMeta, companionPresetPlugins } from './companion-preset.mjs'
import { PRESET_FILES, renderAllTemplates } from './templates.mjs'
import { sessionEvents } from './core.js'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/companion'

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
 * 于是昵称在预设选择器里悄悄消失、回落显示成 `companion-xxxx`——不报错，只丢数据。
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

/** 从名字生成合法 id（中文名回落使用 companion 前缀，一眼可辨是本插件创建的）。 */
export function generateId(name, existing) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const base = /^[a-z0-9]/.test(slug) ? slug : 'companion'
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
  if (!existsSync(paths.companionsRoot)) return 0
  let max = -1
  for (const entry of readdirSync(paths.companionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PRESET_ID.test(entry.name)) continue
    const { order } = readPresetMeta(join(paths.companionsRoot, entry.name))
    if (Number.isFinite(order) && order > max && order < Number.MAX_SAFE_INTEGER) max = order
  }
  return max + 1
}

/** 列出全部伙伴（按 order 升序）。 */
export function listAgents(paths) {
  if (!existsSync(paths.companionsRoot)) return []
  const rows = []
  for (const entry of readdirSync(paths.companionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PRESET_ID.test(entry.name)) continue
    const dir = join(paths.companionsRoot, entry.name)
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
  const dir = join(paths.companionsRoot, id)
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
  const dir = join(paths.companionsRoot, id)
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

/**
 * 新建伙伴：生成 id、目录、六个模板 MD、preset.yml、memory/。
 *
 * **不再生成 bundle 声明**（`cordis.patch.yml` / `package.json`）。
 * rc2 起官方预设只能由已安装的 bundle 声明，那意味着"新建伙伴 = 装包 + 重启"，
 * 与"即插即用"不可兼得。伙伴因此回归成本插件自己的数据（`companion/companions/`），
 * 提示词的独占改由 `complete` section 承担（见 core.js 的 registerPrompt）。
 *
 * 因此新建伙伴**无需重启**：写几个文件即可，下拉框立刻能看到。
 */
export function createAgent(paths, { name, description = '', userName = '用户' }) {
  const clean = assertLength(String(name ?? '').trim(), MAX_NAME_CHARS, '昵称')
  if (!clean) throw new Error('请输入昵称')
  const desc = assertLength(String(description ?? ''), MAX_DESCRIPTION_CHARS, '个性签名')
  const user = assertLength(String(userName ?? '').trim() || '用户', MAX_NAME_CHARS, '用户名')
  const id = generateId(clean, existingIds(paths))
  const dir = join(paths.companionsRoot, id)
  mkdirSync(dir, { recursive: true })

  const order = nextOrder(paths)
  writePresetMeta(dir, { name: clean, description: desc || undefined, order })
  for (const [file, content] of Object.entries(renderAllTemplates({ name: clean, userName: user }))) {
    atomicWrite(join(dir, file), content)
  }
  mkdirSync(join(dir, 'memory'), { recursive: true })
  return readAgent(paths, id)
}

/** 现有伙伴 id 集合（供 generateId 去重）。 */
function existingIds(paths) {
  if (!existsSync(paths.companionsRoot)) return new Set()
  return new Set(
    readdirSync(paths.companionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  )
}

/** 复制伙伴：以某伙伴为模板克隆一个同名性格的新伙伴。
 *  保留源的全部 MD，把其中出现的源名字面替换为新昵称；
 *  不带历史日记（memory/ 新建为空），description 沿用、order 排到末尾。 */
export function copyAgent(paths, sourceId, { name } = {}) {
  if (!PRESET_ID.test(sourceId)) throw new Error(`非法 id：${sourceId}`)
  const srcDir = join(paths.companionsRoot, sourceId)
  if (!existsSync(srcDir)) throw new Error(`伙伴不存在：${sourceId}`)
  const sourceMeta = readPresetMeta(srcDir)
  const oldName = sourceMeta.name || sourceId
  const clean = assertLength(String(name ?? '').trim() || `${oldName} 的副本`, MAX_NAME_CHARS, '昵称')
  const id = generateId(clean, existingIds(paths))
  const dir = join(paths.companionsRoot, id)
  mkdirSync(dir, { recursive: true })

  const renameIn = (text) => (oldName === clean ? text : text.split(oldName).join(clean))

  // 复制六个 MD（preset.yml 由下方按新名字重写）
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'preset.yml') continue
    if (PRESET_FILES.some((item) => item.file === entry.name)) {
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

/**
 * 把一个伙伴目录从**旧位置**（`<dshHome>/.agent-presets/<id>/`）搬到新位置
 * （`<dshHome>/companion/companions/<id>/`）。
 *
 * 为什么要搬：rc2 起官方完全不再读 `.agent-presets/`，继续放那里会让"伙伴"
 * 看起来像官方预设、实际官方不看，排查时极易误判。搬走后该目录是纯粹的本插件数据。
 *
 * **只移动，不改内容**：六个 MD、memory/、changelog/、preset.yml 原样过去；
 * 旧格式遗留的 `agent.cordis.yml` 也一并保留（回滚依据，且现在已无任何作用）。
 *
 * @returns {{migrated: boolean, reason?: string, target?: string}}
 */
export function migrateAgent(paths, id) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const from = join(paths.legacyPresetsRoot, id)
  const to = join(paths.companionsRoot, id)
  if (existsSync(to)) return { migrated: false, reason: '新位置已存在同名伙伴', target: to }
  if (!existsSync(from)) return { migrated: false, reason: '旧位置没有这个伙伴' }
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch {
    // 跨卷时 rename 会失败，退回递归拷贝后删源，保证迁移仍能完成。
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
  return { migrated: true, target: to }
}

/**
 * 列出还留在旧位置、可以迁移过来的伙伴 id。
 *
 * 判据是"目录里有 preset.yml 或六个 MD 之一"——只看目录名会把用户在
 * `.agent-presets/` 下随手建的无关目录也算进来。
 */
export function listLegacyAgents(paths) {
  if (!existsSync(paths.legacyPresetsRoot)) return []
  return readdirSync(paths.legacyPresetsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => PRESET_ID.test(id))
    .filter((id) => !existsSync(join(paths.companionsRoot, id)))
    .filter((id) => {
      const dir = join(paths.legacyPresetsRoot, id)
      return existsSync(join(dir, 'preset.yml'))
        || PRESET_FILES.some((item) => existsSync(join(dir, item.file)))
    })
}

/** 删除 = 移动到备份目录（不真删）。 */
export function archiveAgent(paths, id, now = new Date()) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const dir = join(paths.companionsRoot, id)
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
  const dir = join(paths.companionsRoot, id, 'memory')
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
  return readText(join(paths.companionsRoot, id, 'memory', `${date}.md`))
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
 * **`/api` 那一条 channel** 上。本插件注册的 `/companion` 是独立 route，
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

/** 取会话事件（走官方的公开读取 API，不读私有字段）。 */
function readSessionEvents(session) {
  try {
    return sessionEvents(session) ?? []
  } catch {
    return []
  }
}

/** 把任意异常压成一行可读文本（打日志用）。 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读一个会话当前绑定的伙伴。
 *
 * 两读法并存，顺序有讲究：
 * 1. **绑定表**（`bindings.json`）—— 现在的正道，按 sessionId 索引；
 * 2. **事件流兜底** —— 只为兼容历史上已经写进会话日志的旧绑定事件。
 *
 * 为什么还留兜底：那些旧事件我们已无法再写（见 companion.mjs 的说明），
 * 但它们确实存在于用户磁盘上的历史会话里，直接不认会让"老会话的伙伴"丢失。
 *
 * @returns 伙伴 id，或 null（从未绑定 / 显式选了「无伙伴」）。
 */
function companionBindingOf(paths, session) {
  const fromTable = readBindings(paths)[session?.id]
  if (fromTable !== undefined) return fromTable ? normalizeCompanion(fromTable) : null
  // 兜底：事件流里出现过绑定事件则以最后一次为准
  const events = readSessionEvents(session)
  return events.some((event) => event?.type === 'companion/selected')
    ? companionFromEvents(events)
    : null
}

/**
 * 伙伴绑定是否还允许修改。
 *
 * 规则（用户要求）：**开对话前可选，开对话后锁定**。
 *
 * 判据取官方 `SessionSnapshot` 的同名语义：
 * - `blank === false`：会话已经开始过
 * - `promptAttempted === true`：已经提交过第一条消息
 *
 * 任一成立即视为"已开始"。会话没有这些字段时（老版本 / 极早期）保守地
 * **允许**修改 —— 宁可让用户在极少数情况下多改一次，也不要让所有人都改不了。
 */
function canRebind(session) {
  if (!session) return false
  if (session.blank === false) return false
  if (session.promptAttempted === true) return false
  return true
}

/** 注册 `/companion` 前缀路由。 */
export function registerRoutes(ctx, home) {
  const paths = resolvePaths(home)

  /*
   * 会话索引：sessionId -> Session，供伙伴下拉写入绑定。
   *
   * 由 `agent/created` 维护、`agent/disposed` 清理。这样下拉只需要传一个
   * sessionId，Host 侧就能拿到真正的 Session 对象去追加事件 —— 客户端
   * 不该、也不能直接写会话日志。
   */
  const sessionIndex = new Map()
  /*
   * 每个会话的提示词注入句柄：sessionId -> injectCompanionPrompt 的返回值。
   *
   * 注册发生在**该会话自己的 scope** 里（`agent/created` 监听器的 `this`），
   * 所以每个会话有一套独立的 section/变量，互不干扰 —— 这正是"官方预设 +
   * 伙伴共存"的关键：没绑伙伴的会话根本不注册，官方提示词原样生效。
   */
  const injections = new Map()
  /*
   * sessionId -> **该会话 scope 的 ctx**。
   *
   * 必须在这里存下来：`agent/created` 监听器的 `this` 就是 agent scope，
   * 但监听器只跑一次；用户之后在"新建对话"页选伙伴时（走 /api/companion）
   * 还需要这个 ctx 才能把 section 注册进同一个 scope。
   */
  const agentCtxBySession = new Map()
  const agentCtxOf = (sessionId) => agentCtxBySession.get(sessionId)

  ctx.on?.('agent/created', function (payload) {
    const agent = payload?.agent
    const session = agent?.session
    if (!session?.id) return
    sessionIndex.set(session.id, session)
    /*
     * ⚠️ 这里必须存 **`agent.ctx`**，不能存监听器的 `this`。
     *
     * 官方把 `agent/created` 的 `this` 标为 `Scoped<Agent>`
     * （`dsh-agent/lib/types/runtime-types.d.ts:227`），而 `Scoped<T>` 的定义是
     * `object & { readonly [ScopedBrand]: T }`（`dsh-scope/lib/types/index.d.ts:18`）
     * —— 它只是个**作用域路由标记**，不是 Context。
     *
     * 运行时它由 `scopeTarget(agent, agent)` 构造（`dsh-agent/lib/index.js:231`）。
     * 实测该对象**只有 `Symbol(cordis.filter)` 一个成员**：
     *   carrier.systemPrompt === undefined，carrier.effect === undefined
     * 于是 `this.systemPrompt.section(...)` 必然抛 TypeError，被下面的 catch
     * 吞成一条 warn —— 表现为"伙伴选好了、绑定也写进会话日志了，
     * 但提示词里一个字都没有"。
     *
     * 真正的 per-agent scope 是 `agent.ctx`（见 `dsh-agent-loop/lib/index.js:778-779`
     * 的 `this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx`）；
     * 官方全部示例（file-reference-local / tool-agent-team 等）用的都是它。
     */
    agentCtxBySession.set(session.id, agent?.ctx)

    /*
     * 建会话时若已带绑定（例如恢复旧会话），就直接装上；
     * 否则先不注册 —— 用户可能在"新建对话"页选完伙伴才发第一条消息，
     * 那时由 /api/companion 补上。
     *
     * 读法：先查绑定表，再兜底折叠事件流（兼容历史上写进日志的旧绑定）。
     */
    const bound = companionBindingOf(paths, session)
    if (!bound) return
    const dir = join(paths.companionsRoot, bound)
    if (!existsSync(dir)) return
    const agentCtx = agent?.ctx
    if (!agentCtx) {
      ctx.logger?.warn?.(`[companion] 会话 ${session.id} 取不到 agent.ctx，提示词注入跳过`)
      return
    }
    try {
      // 在 `agent.ctx` 里注册即 per-session。
      injections.set(session.id, injectCompanionPrompt(agentCtx, dir, () => readSettings(paths)))
    } catch (error) {
      ctx.logger?.warn?.(`[companion] 会话 ${session.id} 的提示词注入注册失败：${describeError(error)}`)
    }
  })

  ctx.on?.('agent/disposed', (payload) => {
    const session = payload?.agent?.session
    if (!session?.id) return
    sessionIndex.delete(session.id)
    agentCtxBySession.delete(session.id)
    /*
     * 绑定表按 sessionId 索引，必须随会话销毁清理 ——
     * 否则每开一个会话就多一行，文件无限增长（这正是当初选事件流、
     * 靠"会话删除即日志删除"自动一致的理由）。
     */
    try { deleteBinding(paths, session.id) } catch { /* 清理失败不影响销毁 */ }
    // 会话销毁时撤掉该会话的 section/变量，避免泄漏到别的会话。
    try { injections.get(session.id)?.dispose() } catch { /* 已撤 */ }
    injections.delete(session.id)
  })

  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = statusOfError(error)
      // 未知异常才是 500：这时才值得记一条 warn，业务错误不必刷日志
      if (status >= 500) ctx.logger?.warn?.(`[companion] 请求处理失败：${message}`)
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
        ctx.logger?.warn?.(`[companion] 拒绝跨站写请求：${method} ${rest}`)
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

      /*
       * 伙伴下拉用：列出可用伙伴 + 读/写当前会话的绑定。
       *
       * 绑定住在插件自己的 `bindings.json`（按 sessionId 索引），
       * **不再写进会话事件流** —— 原因见 companion.mjs 的顶部说明：
       * 官方 v4 门禁会拒绝解读带未知事件类型的日志，那会让会话直接打不开。
       */
      if (rest === '/api/companions' && method === 'GET') {
        /*
         * `?session=<id>` 时顺带回当前绑定。
         *
         * 下拉必须知道"这个会话现在用哪个伙伴"才能显示正确的那一项；
         * 会话不在索引里（例如已关闭）就回 null —— 不是错误，
         * 列表本身仍然有效，用户可以看但不能改。
         */
        const wanted = url.searchParams.get('session')
        const live = wanted ? sessionIndex.get(wanted) : undefined
        return sendJson(res, 200, {
          companions: listAgents(paths).map((item) => ({ id: item.id, name: item.name, description: item.description })),
          current: live ? companionBindingOf(paths, live) : readBindings(paths)[wanted] ?? null,
        })
      }
      if (rest === '/api/companion' && method === 'PUT') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        const wanted = normalizeCompanion(body.companion)
        // 选了具体伙伴时必须真实存在，否则会变成"静默不注入"——那太难排查。
        if (wanted && !existsSync(join(paths.companionsRoot, wanted))) {
          return sendJson(res, 404, { error: `伙伴不存在：${wanted}` })
        }
        const sessionId = typeof body.session === 'string' ? body.session : ''
        const session = sessionIndex.get(sessionId)
        if (!session) return sendJson(res, 409, { error: '该会话已不在运行，无法修改伙伴绑定' })
        if (!canRebind(session)) {
          return sendJson(res, 409, { error: '对话已开始，伙伴不可更改（新开一个对话即可重新选择）' })
        }
        recordCompanionSelection(paths, sessionId, wanted)

        /*
         * 立刻把注入换成新绑定 —— 用户选完伙伴就要生效，不能等到下次重启。
         *
         * 三个分支：
         * - 原来没注入、现在选了伙伴 -> 新建注入
         * - 原来有注入、现在换/取消 -> refresh（空串即撤掉全部 section）
         * - 选了「无伙伴」且原本就没有 -> 什么都不做（保持官方提示词）
         *
         * 注意"取消伙伴"必须真的**撤掉 section**，而不是让它渲染成空串：
         * 空文本的 complete 段会把系统提示词清成 ""（见 core.js 的说明）。
         */
        try {
          const dir = wanted ? join(paths.companionsRoot, wanted) : ''
          const existing = injections.get(sessionId)
          if (existing) {
            existing.refresh(dir)
            if (!dir) {
              existing.dispose()
              injections.delete(sessionId)
            }
          } else if (dir) {
            const agentCtx = agentCtxOf(sessionId)
            if (agentCtx) {
              injections.set(sessionId, injectCompanionPrompt(agentCtx, dir, () => readSettings(paths)))
            } else {
              ctx.logger?.warn?.(`[companion] 会话 ${sessionId} 的 agent scope 不可用，注入将在下次装配时缺省`)
            }
          }
        } catch (error) {
          ctx.logger?.warn?.(`[companion] 切换伙伴注入失败：${describeError(error)}`)
        }
        return sendJson(res, 200, { current: wanted })
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
        const dir = join(paths.companionsRoot, id)
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

export const name = 'companion-host'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  registerRoutes(ctx, config.dshHome)

  /*
   * 注册「伙伴模式」预设（声明式，rc2 官方通道）。
   *
   * 为什么必须走这里：rc2 起官方不再读 `.agent-presets/<id>/agent.cordis.yml`，
   * 伙伴的轻量工具清单此前从未生效——实测伙伴会话跑的是 standard-gitbash 的
   * 51 个工具（含 workflow / subagent / plan mode / goal）。唯一官方通道是
   * `ctx.agentPresets.register(...)`（活样本 dsh-gitbash-shell/src/index.js:2031）。
   *
   * 用 `ctx.inject(['agentPresets'], ...)` 而不是直接 `ctx.agentPresets`：
   * 该服务并非处处可用（headless profile 就没有），缺了它顶多少一个预设，
   * 不该把整个 host 半（路由/注入）一起带崩。
   */
  try {
    ctx.inject(['agentPresets'], (scope) => {
      const registry = scope?.agentPresets
      if (!registry || typeof registry.register !== 'function') return
      const unregister = registry.register({
        ...companionPresetMeta(),
        plugins: companionPresetPlugins(),
      })
      scope.effect?.(() => unregister, 'companion: companion preset registration')
    })
  } catch (error) {
    ctx.logger?.warn?.(`[companion] 伙伴模式预设注册失败：${describeError(error)}`)
  }
}
