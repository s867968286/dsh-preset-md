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
 * - 冻结：变量 provider 首次求值后缓存，之后每步返回同一份文本（改文件要新开会话）。
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
 * 取用顺序：`snapshotEvents()`（全量，含 fork 继承前缀）→ `events` 数组兜底
 * （兼容假 ctx / 旧形态）→ `ownEvents()`（只含本会话自己的事件）。
 * 任何一步失败都静默落到下一档，最终返回空数组而不是抛错。
 */
export function sessionEvents(session) {
  if (!session || typeof session !== 'object') return []
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    /* 落到兜底 */
  }
  if (Array.isArray(session.events)) return session.events
  try {
    if (typeof session.ownEvents === 'function') {
      const events = session.ownEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    /* 无事件可取 */
  }
  return []
}

/** 会话级文本缓存：首次取值后冻结，直到显式清理。 */
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
 * 注册提示词：变量承载内容 + 唯一 section（可选 complete）+ 会话冻结。
 *
 * 文件清单、目录、截断策略全部硬编码；只有 tools 是配置项。
 *
 * @param {object} ctx - dsh 上下文（需要 systemPrompt；可选 effect / logger）。
 * @param {{freeze?: boolean, complete?: boolean, variable?: string, sectionName?: string, order?: number, budgetChars?: number, budgetNotice?: boolean, getSettings?: () => object, onRender?: (settings: object) => void}} [options]
 * @returns {{dir: string, files: Array<object>, cache: object, freeze: boolean, variable: string, sectionName: string, order: number, complete: boolean, getSettings: () => object, registerSection: (complete: boolean) => () => void, sectionDisposer: () => void}}
 */
export function registerPrompt(ctx, options = {}) {
  const dir = resolvePresetDir(ctx)
  const variable = options.variable ?? PROMPT_VARIABLE
  const sectionName = options.sectionName ?? PROMPT_SECTION
  const order = Number.isFinite(options.order) ? options.order : PROMPT_ORDER
  // 实时读取设置：调用方可传入 getSettings，让 freeze / contextBudget / budgetNotice
  // 在每次渲染时取最新值（参数改动无需重启或新开会话即可生效）。
  // 未提供时回退到 options 上的静态值（保持旧的调用方式与单测兼容）。
  const getSettings = typeof options.getSettings === 'function'
    ? options.getSettings
    : () => ({
        freeze: options.freeze,
        complete: options.complete,
        contextBudget: options.budgetChars,
        budgetNotice: options.budgetNotice,
      })
  const cache = createSessionFreeze()

  /**
   * 变量 provider：每步被调用；冻结开启时同一会话只读盘一次。
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

  /**
   * 注册 section（文本只引用变量：MD 正文里的 {{…}} 不会被插值解析）。
   * complete 是结构性参数：切换时必须先 dispose 旧 section 再注册新的，
   * 否则同名 section 重复注册会抛错。返回 disposer，供 read() 重建。
   */
  const registerSection = (complete) => {
    const section = { name: sectionName, order, text: `{{${variable}}}` }
    if (complete === true) section.complete = true
    if (typeof ctx.effect === 'function') {
      return ctx.effect(() => ctx.systemPrompt.section(section), `preset-md.section(${sectionName})`)
    }
    return ctx.systemPrompt.section(section)
  }

  const initial = getSettings() || {}
  const initialComplete = initial.complete === true
  const initialFreeze = initial.freeze !== false
  const initialBudget = Number.isFinite(initial.contextBudget) && initial.contextBudget > 0 ? initial.contextBudget : DEFAULT_CONTEXT_BUDGET
  const initialBudgetNotice = initial.budgetNotice !== false

  // 当前生效的 section 及其 disposer：complete 变化时由 read() 撤旧建新
  let currentComplete = initialComplete
  let sectionDisposer = registerSection(initialComplete)

  const read = (context) => {
    if (!dir) return ''
    const s = getSettings() || {}
    // 每次渲染实时通知设置快照，让调用方能按需重建结构性参数（complete 等）
    if (typeof options.onRender === 'function') options.onRender(s)
    // complete 是结构性参数：设置变化时必须「先撤旧、再注册新」。
    // 同名 section 在同一 scope 重复注册会直接抛错，不能只注册不撤销。
    // 变量 provider 在 assemble 中先于 section 收集执行，所以这里重建能在本步生效。
    const wantComplete = s.complete === true
    if (wantComplete !== currentComplete) {
      try {
        sectionDisposer?.()
        sectionDisposer = registerSection(wantComplete)
        currentComplete = wantComplete
      } catch {
        /* 重建失败就保持旧 section，不让提示词组装整个挂掉 */
      }
    }
    const freeze = s.freeze !== false
    const budgetChars = Number.isFinite(s.contextBudget) && s.contextBudget > 0 ? s.contextBudget : DEFAULT_CONTEXT_BUDGET
    const budgetNotice = s.budgetNotice !== false
    const produce = () => {
      const body = substitutePlaceholders(readAggregateText(dir), contextFacts(context, dir))
      // 整体超预算时追加一段「请收敛」提示；超限判断发生在替换之后，
      // 因为 {{presetDir}} 之类的替换值也会占体积。
      // budgetNotice 关掉后只度量、不注入，方便想看日志但不想让模型被提醒的场景。
      if (!budgetNotice) return body
      const notice = contextBudgetNotice(measureContext(dir, { budgetChars }), { warnAt: Number.isFinite(options.warnAt) ? options.warnAt : 1 })
      return notice ? `${body}\n\n${notice}` : body
    }
    if (!freeze) return produce()
    return cache.get(cacheKeyOf(context), produce)
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
    freeze: initialFreeze,
    variable,
    sectionName,
    order,
    complete: initialComplete,
    budgetChars: initialBudget,
    budgetNotice: initialBudgetNotice,
    cacheKeyOf,
    getSettings,
    registerSection,
    sectionDisposer,
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

  const scope = ctx?.agent
  const errors = []
  let known = []

  /**
   * 首选 `view(scope).restrictableNames`：它正是 `restrict()` 用来校验名单的那份
   * 集合，且**不做 schema 投影**。dsh 0.1.5-rc.2 起 `schemas()` 在非 native 呈现
   * 模式（进程设了 `DSH_TOOLS_MODE=both|ptc`）下会先 `requireCodeRuntime(mode)`，
   * 缺 `codeRuntime` 就整份名单读不出来，`deny` 随之静默失效。
   */
  try {
    const names = registry.view?.(scope)?.restrictableNames
    if (names) known = [...names].filter((name) => typeof name === 'string')
  } catch (error) {
    errors.push('view: ' + (error instanceof Error ? error.message : String(error)))
  }

  /* 兜底：老版本没有 view() 时仍走 schemas()。 */
  if (known.length === 0) {
    try {
      const schemas = typeof registry.schemas === 'function' ? registry.schemas(scope) : []
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
      scopeKind: scope === undefined ? 'undefined' : scope === null ? 'null' : typeof scope,
      scopeKeys: scope && typeof scope === 'object' ? Object.keys(scope).slice(0, 24) : [],
    }
  }
  if (known.length === 0) {
    return { applied: false, reason: '当前没有可见工具，模式无需展开' }
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
