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

/** 可在 MD 正文里使用的占位符（会话冻结时替换一次）。 */
export const PLACEHOLDERS = ['cwd', 'preset', 'session']

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

/** 从会话上下文里取可用于占位符替换的事实。 */
export function contextFacts(input) {
  const agent = input?.agent ?? input
  const session = agent?.session ?? input?.session
  const header = session?.header ?? {}
  return {
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    preset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
    session: typeof session?.id === 'string' ? session.id : '',
  }
}

/**
 * 替换 MD 正文里的占位符：`{{cwd}}` / `{{preset}}` / `{{session}}`。
 * 未识别的 `{{…}}` 与取不到值的占位符**原样保留**（便于看出没生效）。
 * 替换发生在会话冻结之前，所以同一会话内恒定。
 */
export function substitutePlaceholders(text, facts) {
  if (!text) return text
  return text.replace(/\{\{\s*(cwd|preset|session)\s*\}\}/g, (match, key) => {
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
 * @param {{freeze?: boolean, complete?: boolean, variable?: string, sectionName?: string, order?: number}} [options]
 * @returns {{dir: string, files: Array<object>, cache: object, freeze: boolean, variable: string, sectionName: string, order: number, complete: boolean}}
 */
export function registerPrompt(ctx, options = {}) {
  const dir = resolvePresetDir(ctx)
  const freeze = options.freeze !== false
  const variable = options.variable ?? PROMPT_VARIABLE
  const sectionName = options.sectionName ?? PROMPT_SECTION
  const order = Number.isFinite(options.order) ? options.order : PROMPT_ORDER
  const complete = options.complete === true
  const cache = createSessionFreeze()

  /** 变量 provider：每步被调用；冻结开启时同一会话只读盘一次。 */
  const read = (context) => {
    if (!dir) return ''
    const produce = () => substitutePlaceholders(readAggregateText(dir), contextFacts(context))
    if (!freeze) return produce()
    return cache.get(sessionKeyOf(context) || '__preset__', produce)
  }
  ctx.systemPrompt.variable(variable, read)

  // section 文本只引用变量：MD 正文里的 {{…}} 不会被插值解析。
  const section = { name: sectionName, order, text: `{{${variable}}}` }
  if (complete) section.complete = true
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => ctx.systemPrompt.section(section), `preset-md.section(${sectionName})`)
  } else {
    ctx.systemPrompt.section(section)
  }

  const files = DEFAULT_FILES.map((file) => {
    const filePath = dir ? join(dir, file) : ''
    return { file, filePath, exists: filePath ? existsSync(filePath) : false }
  })

  return { dir, files, cache, freeze, variable, sectionName, order, complete }
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

  let known = []
  try {
    const schemas = typeof registry.schemas === 'function' ? registry.schemas(ctx.agent) : []
    known = [...new Set((schemas ?? []).map((schema) => schema?.name).filter(Boolean))]
  } catch {
    return { applied: false, reason: '读取可见工具名单失败，无法展开模式' }
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
