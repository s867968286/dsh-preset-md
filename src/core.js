/**
 * dsh-preset-md 核心逻辑（零依赖、可单测）。
 *
 * 职责：把「预设目录」下约定好的 Markdown 文件拼成一段文本，作为**唯一**的
 * systemPrompt section（complete）注入；文本按会话冻结，只在会话第一次渲染时读盘。
 *
 * 不含任何 dsh 服务访问，全部通过传入的 ctx 完成，因此可以在没有 dsh 进程的
 * 情况下用 node --test 验证。
 *
 * 关键设计：
 * - 内容放在**变量值**里、section 文本只写 `{{preset_md}}`：变量值不会再被插值，
 *   因此 MD 正文里出现 `{{xxx}}` 也不会触发严格解析抛错。
 * - 冻结：变量 provider 每步都会被官方调用，但首次求值后缓存，之后每步返回
 *   **同一份文本**（改文件要新开会话）。我们不做任何「文件是否变了」的探测 ——
 *   见下方 registerPrompt 里 read / cacheKeyOf 的说明。
 * - 目录取 ctx.baseUrl（预设组合所在目录）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件名（与包名 dsh-preset-md 对应，但 dsh 里用短名）。 */
export const PLUGIN_NAME = 'preset-md'

/** 承载全部 MD 内容的变量名（内部固定，不做配置项）。 */
export const PROMPT_VARIABLE = 'preset_md'

/** 唯一 section 名与 order。 */
export const PROMPT_SECTION = 'preset-md'
export const PROMPT_ORDER = 0

/**
 * 默认文件清单与拼接顺序：
 * SYSTEM（系统级，用户自己写官方那套内容）→ SOUL（人格）→ IDENTITY（自我认知）
 * → USER（用户上下文）→ AGENTS（工作方式）→ MEMORY（持久记忆）。
 * 文件不存在或为空 → 该段跳过；标题由文件自己写，插件不额外加。
 */
export const DEFAULT_FILES = ['SYSTEM.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md']

/**
 * 可在 MD 正文里使用的占位符（会话冻结时替换一次）。
 *
 * - `cwd`：会话的工作目录（`session.header.cwd`）
 * - `preset`：预设的 id（如 `agent-1bd5`），不是路径
 * - `presetDir`：预设目录的绝对路径（`ctx.baseUrl` 解析而来），即本助手六个 MD 与 memory/ 所在目录
 * - `session`：会话 id
 */
export const PLACEHOLDERS = ['cwd', 'preset', 'presetDir', 'session']

/** 展开开头的 ~（支持 ~ 与 ~/xxx）。 */
export function expandHome(input) {
  const text = String(input ?? '')
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

/** 把可能为 file URL 或普通路径的字符串统一成绝对路径；无法解析返回 ''。 */
export function toDirectoryPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const raw = value.trim()
  try {
    if (raw.startsWith('file:')) return fileURLToPath(raw)
  } catch {
    return ''
  }
  const expanded = expandHome(raw)
  return isAbsolute(expanded) ? resolve(expanded) : ''
}

/** 归一化配置：目前只认 tools，其余全部硬编码。 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return { tools: normalizeToolFilter(input.tools) }
}

/** 归一化工具过滤名单：只保留非空字符串并去重。 */
export function normalizeToolFilter(raw) {
  if (!raw || typeof raw !== 'object') return { allow: [], deny: [] }
  const pick = (value) => Array.isArray(value)
    ? [...new Set(value.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))]
    : []
  return { allow: pick(raw.allow), deny: pick(raw.deny) }
}

/**
 * 解析预设目录：用 ctx.baseUrl（dsh 的 preset 组合会把该上下文的 baseUrl
 * 重写为 agent.cordis.yml 所在目录）。
 */
export function resolvePresetDir(ctx) {
  return toDirectoryPath(ctx?.baseUrl)
}

/**
 * 从多种入参形态里取会话键（assemble context、agent 对象、事件 payload 都兼容）。
 * 优先 session.id，回退 agent.id；取不到返回 ''。
 */
export function sessionKeyOf(input) {
  if (input === null || typeof input !== 'object') return ''
  const agent = input.agent ?? input
  const session = agent?.session ?? input.session
  const id = session?.id ?? agent?.id
  return typeof id === 'string' && id.length > 0 ? id : ''
}

/**
 * 读取会话事件列表。
 *
 * dsh 的 `Session` 类**不暴露 `events` 属性**（事件日志是私有字段，公开读取方法是
 * `snapshotEvents(fromSeq?, toSeqExclusive?)` 与 `ownEvents()`）。
 * 直接读 `session.events` 永远得到 `undefined`：转写恒为空，
 * 回顾每次都判定 `turn_too_short` 跳过，自动日记永远写不出来。
 *
 * ## 为什么 `ownEvents()` 优先，而不是 `snapshotEvents()`
 *
 * 官方契约（`dsh-session/lib/types/index.d.ts`）：
 * - `snapshotEvents()` —— **全量，含 fork 继承前缀**（"a full current snapshot"）
 * - `ownEvents()` —— "this Session's events **after its fork-inherited prefix**"，
 *   即只含本会话自己产生的事件
 *
 * 子代理（subagent）会话是通过 fork 派生的，磁盘上**确实带着父会话的完整历史**
 * （实测本机 7 个 presetmd 子会话，`seedLength` 4640～68054，其事件流前数百条
 * 全是父会话内容）。用 `snapshotEvents()` 会把这些当成"本会话发生的事"：
 *
 * - **触发阈值被灌满**：`grown` 在会话第一轮就把整个继承前缀算成「新增」，
 *   于是每个 fork 出来的子会话**第 1 轮必然越线触发**回顾。实测这些子会话的
 *   转写有 **90%～99%** 是父会话内容（仅自有段 95～113 字符，全量 4363～7889）。
 * - **回顾内容失真**：总结的是"父会话做了什么"，而不是本会话做了什么。
 *
 * 所以取用顺序为：`ownEvents()`（只含自有）→ `snapshotEvents()`（全量兜底）
 * → `events` 数组（兼容假 ctx / 旧形态）。
 * 任何一步失败都静默落到下一档，最终返回空数组而不是抛错。
 */
export function sessionEvents(session) {
  if (!session || typeof session !== 'object') return []
  try {
    if (typeof session.ownEvents === 'function') {
      const events = session.ownEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    /* 落到兜底 */
  }
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    /* 落到兜底 */
  }
  if (Array.isArray(session.events)) return session.events
  return []
}

/**
 * 会话级文本缓存：首次取值后冻结，直到显式清理。
 *
 * ## 为什么是 `Map` + 字符串键，而不是官方的 `WeakMap` + 会话对象
 *
 * 官方同类缓存用 `WeakMap` 以**会话对象**为键（如 `dsh-agent-instructions`
 * 的 `instructionVersions`），好处是会话销毁后自动回收、无需手工清理。
 * 我们没这么做，有两个具体原因：
 *
 * 1. **要支持「拿不到会话」的兜底键**。`cacheKeyOf` 在取不到会话 id 时会退化
 *    成 `__no_session__:<cwd>:<presetDir>`（避免不同工作区的 `{{cwd}}` 串味）。
 *    那是**字符串**键，`WeakMap` 只接受对象，做不到。
 * 2. **清理时机由我们掌握**。会话结束时（`agent/disposed`）显式 `clear(key)`，
 *    与 `states`、提示词缓存用同一套生命周期，行为可预期、可单测。
 *
 * 代价是必须记得清理，否则 Map 会随会话数增长。清理点见 `preset.js` 的
 * `agent/disposed` 处理（`prompt.cache.clear(key)`）。
 */
export function createSessionFreeze() {
  const cache = new Map()
  return {
    get(key, factory) {
      if (cache.has(key)) return cache.get(key)
      const value = factory()
      cache.set(key, value)
      return value
    },
    clear(key) {
      cache.delete(key)
    },
    clearAll() {
      cache.clear()
    },
    get size() {
      return cache.size
    },
  }
}

/**
 * 读取一个文件并原样返回（标题由文件自己写，插件不加）。
 * 文件不存在、读取失败、内容为空 → 返回 ''（该段跳过）。
 */
export function readSectionText(filePath) {
  if (!filePath) return ''
  let body
  try {
    body = readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
  return body.replace(/^\uFEFF/, '').trim()
}

/** 把默认清单里的文件按顺序拼成一段文本；空段跳过，全空返回 ''。 */
export function readAggregateText(dir, files = DEFAULT_FILES) {
  if (!dir) return ''
  const parts = files.map((file) => readSectionText(join(dir, file))).filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : ''
}

/* ────────────────────────── 上下文预算与体积度量 ──────────────────────────
 * 只管「整体」：六个 MD 拼起来的总长度是否越过预算线。单个文件偏大但整体
 * 没超，不算问题——各文件按下面的比例天然瓜分预算，不需要逐个设限。
 * -------------------------------------------------------------------- */

/** 六个文件瓜分预算的权重（合计 1.0），按「该文件天然该有多少内容」分配。 */
export const FILE_WEIGHTS = {
  'SYSTEM.md': 0.12,
  'SOUL.md': 0.20,
  'IDENTITY.md': 0.13,
  'USER.md': 0.08,
  'AGENTS.md': 0.22,
  'MEMORY.md': 0.25,
}

/**
 * 系统提示词的默认预算（字符）。
 *
 * DeepSeek 官方口径：1 个汉字 ≈ 0.6 token。莉莉实例实测 6041 字符 ≈ 2866 token，
 * 约合 0.47 token/字符（中文为主、混少量 ASCII）。
 * 10000 token ÷ 0.47 ≈ 21000 字符，取 20000 —— 留一点余量，不让它刚好卡在线上。
 */
export const DEFAULT_CONTEXT_BUDGET = 20000

/** 实测的混合文本折算比（token / 字符），用于把预算换算成 token 展示。 */
export const CHARS_PER_TOKEN = 0.47

/**
 * 估算一段文本的 token 数（DeepSeek 口径）。
 *
 * 分三类加权：汉字/CJK 标点 0.6、ASCII 0.28、空白 0.2。
 * 仅供体积提示用，不参与任何功能判断。
 */
export function estimateTokens(text) {
  const source = String(text || '')
  if (!source) return 0
  const cjk = (source.match(/[\u4e00-\u9fff]/g) || []).length
  const cjkPunct = (source.match(/[\u3000-\u303f\uff00-\uffef]/g) || []).length
  const whitespace = (source.match(/\s/g) || []).length
  const ascii = source.length - cjk - cjkPunct - whitespace
  return Math.round(cjk * 0.6 + cjkPunct * 0.6 + ascii * 0.28 + whitespace * 0.2)
}

/**
 * 量一遍预设目录的体积。
 *
 * @returns {{
 *   files: Array<{file: string, chars: number, tokens: number, weight: number, share: number}>,
 *   totalChars: number, totalTokens: number,
 *   budgetChars: number, budgetTokens: number,
 *   ratio: number, over: boolean,
 *   heaviest: Array<{file: string, chars: number, ratio: number}>
 * }}
 */
export function measureContext(dir, { budgetChars = DEFAULT_CONTEXT_BUDGET, files = DEFAULT_FILES } = {}) {
  const budget = Number.isFinite(budgetChars) && budgetChars > 0 ? budgetChars : DEFAULT_CONTEXT_BUDGET
  const rows = []
  let totalChars = 0

  for (const file of files) {
    const text = dir ? readSectionText(join(dir, file)) : ''
    const chars = text.length
    totalChars += chars
    rows.push({ file, chars, tokens: estimateTokens(text), weight: FILE_WEIGHTS[file] ?? 0, share: 0 })
  }

  // 每个文件「应得」的预算份额 + 当前占总额的比例
  for (const row of rows) {
    row.share = totalChars > 0 ? row.chars / totalChars : 0
  }

  const ratio = budget > 0 ? totalChars / budget : 0
  // 超预算才提示；同时列出超过自己那份份额最明显的文件，供模型参考
  const heaviest = rows
    .filter((row) => row.weight > 0)
    .map((row) => ({ file: row.file, chars: row.chars, ratio: row.weight > 0 ? row.chars / (budget * row.weight) : 0 }))
    .filter((row) => row.ratio > 1)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 3)

  return {
    files: rows,
    totalChars,
    totalTokens: estimateTokens(readAggregateText(dir, files)),
    budgetChars: budget,
    // 预算本身只是个字符数，按实测的混合比例折算成 token 供参考
    budgetTokens: Math.round(budget * CHARS_PER_TOKEN),
    ratio,
    over: totalChars > budget,
    heaviest,
  }
}

/**
 * 生成注入体积的告警文本；未超预算返回 ''。
 *
 * 只在**整体**超预算时才提醒，并且是交给模型的「请收敛」提示，
 * 不做硬截断——截断会把记忆切碎，比超一点更糟。
 */
export function contextBudgetNotice(measure, { warnAt = 1 } = {}) {
  if (!measure || !measure.over || measure.ratio < warnAt) return ''
  const bits = [
    `## 上下文预算提醒`,
    '',
    `六个文件拼起来共 ${measure.totalChars} 字符（约 ${measure.totalTokens} token），` +
      `已超出预算 ${measure.budgetChars} 字符（${Math.round(measure.ratio * 100)}%）。`,
  ]
  if (measure.heaviest.length > 0) {
    const list = measure.heaviest.map((row) => `\`${row.file}\`（超出应得份额 ${Math.round(row.ratio * 100)}%）`).join('、')
    bits.push('', `偏重的是：${list}。`)
  }
  bits.push(
    '',
    '请在下次更新记忆时主动收敛：合并重复条目、把细节移进日志只留一条线索、删掉已经过期的内容。',
    '不要整段删除仍在生效的约定——精炼，不是清空。',
  )
  return bits.join('\n')
}

/**
 * 从会话上下文里取可用于占位符替换的事实。
 * @param {object} input - 会话上下文（assemble context / agent / session 都兼容）。
 * @param {string} [presetDir] - 预设目录绝对路径，来自 `ctx.baseUrl`（会话上下文里没有）。
 */
export function contextFacts(input, presetDir = '') {
  const agent = input?.agent ?? input
  const session = agent?.session ?? input?.session
  const header = session?.header ?? {}
  return {
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    preset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
    presetDir: typeof presetDir === 'string' ? presetDir : '',
    session: typeof session?.id === 'string' ? session.id : '',
  }
}

/**
 * 替换 MD 正文里的占位符：`{{cwd}}` / `{{preset}}` / `{{presetDir}}` / `{{session}}`。
 * 未识别的 `{{…}}` 与取不到值的占位符**原样保留**（便于看出没生效）。
 * 替换发生在会话冻结之前，所以同一会话内恒定。
 *
 * 注意：`presetDir` 必须排在 `preset` 之前 —— 正则的选择分支是从左到右匹配的，
 * 让更长的名字先试，避免 `{{presetDir}}` 被 `preset` 抢先匹配。
 */
export function substitutePlaceholders(text, facts) {
  if (!text) return text
  return text.replace(/\{\{\s*(cwd|presetDir|preset|session)\s*\}\}/g, (match, key) => {
    const value = facts?.[key]
    return typeof value === 'string' && value.length > 0 ? value : match
  })
}

/**
 * 注册提示词：变量承载内容 + 唯一 complete section + 会话内冻结。
 *
 * 文件清单、目录、截断策略全部硬编码；只有 tools 是配置项。
 *
 * **两个开关已移除**（原本是设置项）：`complete`（独占系统提示词）与
 * `freeze`（会话内冻结）。它们只是「可切换」，而我们始终只用一种模式 ——
 * 独占（本插件的 MD 就是全部系统提示词）+ 冻结（同一会话读盘一次）。
 * 移除后连带砍掉了整块「运行时撤旧建新 section」的机制：那套存在的原因只是
 * `complete` 会变；固定之后 section 只需注册一次。
 *
 * @param {object} ctx - dsh 上下文（需要 systemPrompt）。
 * @param {{variable?: string, sectionName?: string, order?: number, getSettings?: () => object}} [options]
 * @returns {{dir: string, files: Array<object>, cache: object, variable: string, sectionName: string, order: number, getSettings: () => object}}
 */
export function registerPrompt(ctx, options = {}) {
  const dir = resolvePresetDir(ctx)
  const variable = options.variable ?? PROMPT_VARIABLE
  const sectionName = options.sectionName ?? PROMPT_SECTION
  const order = Number.isFinite(options.order) ? options.order : PROMPT_ORDER
  // 实时读取设置：只有注入预算与超限提醒还留在设置页，它们每次渲染取最新值。
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({})
  const cache = createSessionFreeze()

  /**
   * 变量 provider：**每步都会被官方调用**，但我们只让它读一次盘。
   *
   * ## 为什么需要缓存（而不是「第一次注入后就完事」）
   *
   * 官方装配流程是：`assemble()` → 收集所有变量的 provider → 渲染 section →
   * 作为**请求的第一个 message** 发给模型。`assemble()` 在**每个 pre-step**
   * 都会跑（`dsh-agent-loop` 的 `preStep`），所以 provider 是「每步都问一次
   * 『你现在要注入什么』」，而不是「只问一次、之后不再需要」。
   *
   * 既然每步都问，就必须保证**答案逐字节一致**：系统提示词是请求前缀，
   * 它一变，后面所有内容都失去 KV 缓存命中（实测：MD 若每次重读，改动会让
   * 36.8k 字符里仅 50 字符可复用）。所以这里冻结成「同一会话只读一次盘」。
   *
   * ## 我们不做变化检测
   *
   * 官方同类实现（如 `dsh-agent-instructions`）会缓存文件版本元数据、主动比对
   * 是否变化，以便**感知**改动。我们的意图相反：**会话内故意不感知变化**——
   * 改 Markdown 要新开对话才生效（见 README「固定行为」）。我们只负责返回恒定
   * 文本，是否重发、如何复用缓存全部交给官方判断，自己不做任何变更探测。
   *
   * 缓存键：优先用会话 id。取不到 id 时**不能退化成单一常量键** ——
   * 那样所有拿不到 id 的会话会共用第一份渲染结果，`{{cwd}}` 之类的替换值会串味。
   * 改为把 cwd 一并编进键：同一会话稳定命中，不同工作目录互不污染。
   */
  const cacheKeyOf = (context) => {
    const session = sessionKeyOf(context)
    if (session) return session
    const facts = contextFacts(context, dir)
    return `__no_session__:${facts.cwd || '-'}:${facts.presetDir || '-'}`
  }

  /*
   * 注册唯一 section：`complete: true` 表示「系统提示词只保留本段」，
   * 文本只引用变量 —— MD 正文放在变量右值里，官方 interpolate() 不二次扫描，
   * 所以正文里的 `{{…}}` 不会被当真变量解析（见 substitutePlaceholders 的说明）。
   *
   * 只注册一次：complete 不再可切换，没有「撤旧建新」的需要。
   */
  ctx.systemPrompt.section({ name: sectionName, order, text: `{{${variable}}}`, complete: true })

  /**
   * 渲染正文。
   *
   * **缓存边界**：`cache.get` 包住的是「读 MD + 占位符替换 + 超限提醒」**整段**。
   * 也就是说注入预算与「超限提醒」开关**也**被冻结 —— 同一会话内改了它们，
   * 要新开会话才生效。这么做是为了让系统提示词在会话内**逐字节恒定**
   * （它是请求前缀，一变则后面全部丢失 KV 缓存命中），代价写进了 README。
   *
   * `getSettings()` 仍留在缓存外：它每步都会被调用（实测缓存命中时每步同步读
   * 一次 `settings.json`），但结果只用于决定**是否重新渲染**——命中时该值不参与
   * 输出。保留这次读盘是为了让「新会话」立刻取到最新设置，而不必等插件重启。
   */
  const read = (context) => {
    if (!dir) return ''
    const s = getSettings() || {}
    const budgetChars = Number.isFinite(s.contextBudget) && s.contextBudget > 0 ? s.contextBudget : DEFAULT_CONTEXT_BUDGET
    const budgetNotice = s.budgetNotice !== false
    return cache.get(cacheKeyOf(context), () => {
      const body = substitutePlaceholders(readAggregateText(dir), contextFacts(context, dir))
      // 整体超预算时追加一段「请收敛」提示；超限判断发生在替换之后，
      // 因为 {{presetDir}} 之类的替换值也会占体积。
      // budgetNotice 关掉后只度量、不注入，方便想看日志但不想让模型被提醒的场景。
      if (!budgetNotice) return body
      const notice = contextBudgetNotice(measureContext(dir, { budgetChars }), { warnAt: Number.isFinite(options.warnAt) ? options.warnAt : 1 })
      return notice ? `${body}\n\n${notice}` : body
    })
  }
  ctx.systemPrompt.variable(variable, read)

  const files = DEFAULT_FILES.map((file) => {
    const filePath = dir ? join(dir, file) : ''
    return { file, filePath, exists: filePath ? existsSync(filePath) : false }
  })

  return {
    dir,
    files,
    cache,
    variable,
    sectionName,
    order,
    cacheKeyOf,
    getSettings,
  }
}

/**
 * 判断工具名是否匹配一条模式，只支持四种写法：
 * - 前缀：`aa*`
 * - 后缀：`*bb`
 * - 包含：`*cc*`
 * - 精确：`ddd`
 * 其余（例如中间通配 `a*b`）一律不匹配。
 */
export function matchToolName(pattern, name) {
  if (typeof pattern !== 'string' || typeof name !== 'string') return false
  const p = pattern.trim()
  if (p.length === 0 || name.length === 0) return false
  const prefix = p.startsWith('*')
  const suffix = p.endsWith('*')
  const key = p.replace(/^\*+|\*+$/g, '')
  if (key.length === 0) return false
  if (prefix && suffix) return name.includes(key)
  if (suffix) return name.startsWith(key)
  if (prefix) return name.endsWith(key)
  return name === key
}

/**
 * 收窄当前 agent scope 继承到的全局工具（preset 行自己注册的工具不受影响）。
 *
 * 流程：先枚举当前可见工具名，把模式展开成精确名单再交给 `ctx.tools.restrict()`——
 * restrict 只接受真实存在的全局工具名，直接传模式会因「未知工具名」抛错。
 * 未匹配到任何工具的条目会被忽略并在结果里报告（只 warn，不让插件加载失败）。
 *
 * @returns {{applied: boolean, filter?: object, unmatched?: string[], reason?: string}}
 */
export function applyToolRestriction(ctx, tools) {
  const registry = ctx?.tools
  if (!registry || typeof registry.restrict !== 'function') {
    return { applied: false, reason: 'ctx.tools.restrict 不可用' }
  }

  const errors = []
  let known = []

  /*
   * 绝不读 `ctx.agent`：在 preset 这一层它是隔离开的 per-agent 服务，直接读属性会抛
   * `cannot get property "agent" without inject`，而这个异常就落在下面同一段 try 里，
   * 被当成「工具名单读不出来」——`deny` 于是静默失效（切预设时那条 loader 报错即此）。
   * 收窄本来也不需要 agent：`restrict()` 自己从它的 ctx 解析 scope。
   */

  /**
   * 首选 `view().restrictableNames`（不传 scope = 全局视图）：它正是 `restrict()` 用来
   * 校验名单的那份集合，且**不做 schema 投影**。dsh 0.1.5-rc.2 起 `schemas()` 在非
   * native 呈现模式（进程设了 `DSH_TOOLS_MODE=both|ptc`）下会先 `requireCodeRuntime`，
   * 缺 `codeRuntime` 就整份名单读不出来。
   */
  try {
    const names = registry.view?.()?.restrictableNames
    if (names) known = [...names].filter((name) => typeof name === 'string')
  } catch (error) {
    errors.push('view: ' + (error instanceof Error ? error.message : String(error)))
  }

  /* 兜底：老版本没有 view() 时仍走 schemas()（同样不传 scope）。 */
  if (known.length === 0) {
    try {
      const schemas = typeof registry.schemas === 'function' ? registry.schemas() : []
      known = [...new Set((schemas ?? []).map((schema) => schema?.name).filter(Boolean))]
    } catch (error) {
      errors.push('schemas: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  if (known.length === 0) {
    /*
     * 名单为空有两种成因，报错必须分开：真读不到（异常）才叫失败；读到了但一条
     * 都没有，说明装配期本来就没有全局工具，收窄无从下手——那不是故障。
     */
    if (errors.length === 0) {
      return { applied: false, reason: '当前没有可见工具，模式无需展开' }
    }
    return {
      applied: false,
      reason: '读取可见工具名单失败，无法展开模式',
      error: errors.join(' | '),
    }
  }

  const expand = (patterns) => {
    const names = new Set()
    const unmatched = []
    for (const pattern of patterns) {
      let hit = false
      for (const name of known) {
        if (matchToolName(pattern, name)) {
          names.add(name)
          hit = true
        }
      }
      if (!hit) unmatched.push(pattern)
    }
    return { names: [...names].sort(), unmatched }
  }

  const allow = tools.allow.length > 0 ? expand(tools.allow) : { names: [], unmatched: [] }
  const deny = tools.deny.length > 0 ? expand(tools.deny) : { names: [], unmatched: [] }
  const unmatched = [...allow.unmatched, ...deny.unmatched]

  const filter = {}
  // 展开后为空就不下发：空的 allow 会屏蔽掉全部全局工具，属于误伤。
  if (allow.names.length > 0) filter.allow = allow.names
  if (deny.names.length > 0) filter.deny = deny.names
  if (filter.allow === undefined && filter.deny === undefined) {
    return { applied: false, reason: '模式没有匹配到任何可见工具', unmatched }
  }

  try {
    registry.restrict(filter)
    return { applied: true, filter, unmatched }
  } catch (error) {
    return {
      applied: false,
      reason: error instanceof Error ? error.message : String(error),
      unmatched,
    }
  }
}
