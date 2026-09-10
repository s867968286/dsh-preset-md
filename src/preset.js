/**
 * dsh-preset-md —— preset 行插件：把预设目录下的 Markdown 拼成唯一系统提示词，
 * 并在后台自动整理日志与记忆。
 *
 * 用法（preset 的 agent.cordis.yml 里加一行）：
 *
 *   - id: preset-md
 *     name: dsh-preset-md/preset      # 主入口是 Host 半，preset 行走子路径
 *
 * 行为参数由 `<dshHome>/preset-md/settings.json` 决定，
 * 可在「设置 → 伙伴设置 → 参数」里改。
 */
import {
  PLUGIN_NAME,
  PROMPT_ORDER,
  PROMPT_SECTION,
  PROMPT_VARIABLE,
  applyToolRestriction,
  normalizeConfig,
  registerPrompt,
  sessionKeyOf,
} from './core.js'
import { readSettings, resolvePaths } from './settings.mjs'
import { createSearchTool } from './search.mjs'
import { runReview } from './review.mjs'

/** 触发防抖（毫秒），写死。 */
const REVIEW_DEBOUNCE_MS = 5000

/** Cordis 插件名。 */
export const name = PLUGIN_NAME

/** 硬依赖：提示词注册表与工具注册表。 */
export const inject = ['systemPrompt', 'tools']

/** 统计一段 content 的文本长度。 */
function textLength(content) {
  if (!Array.isArray(content)) return 0
  return content.reduce(
    (total, block) => total + (block?.type === 'text' && typeof block.text === 'string' ? block.text.length : 0),
    0,
  )
}

/** 会话累计文本长度（用于判断「新增了多少」）。 */
function transcriptChars(events) {
  let total = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'user/message') total += textLength(event.data?.content)
    else if (event?.type === 'assistant/message') total += textLength(event.data?.message?.content)
  }
  return total
}

/**
 * 装配：提示词 → 运行时上下文抑制 → 工具收窄 → 检索工具 → 自动记忆。
 * @param {object} ctx - dsh 上下文。
 * @param {unknown} rawConfig - preset 行的 config（目前只认 tools）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger ?? console
  const settings = readSettings(resolvePaths())

  /* 提示词：变量承载内容 + 唯一 section（可 complete）+ 会话冻结 */
  const prompt = registerPrompt(ctx, {
    freeze: settings.freeze,
    complete: settings.complete,
    variable: PROMPT_VARIABLE,
    sectionName: PROMPT_SECTION,
    order: PROMPT_ORDER,
  })

  /* 抑制本 scope 的全部运行时上下文快照 */
  if (settings.suppressRuntimeContext) {
    try {
      ctx.systemPrompt?.suppressRuntimeContext?.()
      logger.info?.('[preset-md] 已抑制本 scope 的全部运行时上下文快照')
    } catch (error) {
      logger.warn?.(
        `[preset-md] 抑制运行时上下文失败（不影响其余功能）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /* 工具收窄：把模式展开成精确名单后交给 tools.restrict */
  if (config.tools.allow.length > 0 || config.tools.deny.length > 0) {
    const result = applyToolRestriction(ctx, config.tools)
    if (result.applied) {
      const bits = []
      if (result.filter?.allow?.length) bits.push(`allow=${result.filter.allow.join(',')}`)
      if (result.filter?.deny?.length) bits.push(`deny=${result.filter.deny.join(',')}`)
      logger.info?.(`[preset-md] 工具收窄已生效：${bits.join(' ')}`)
    } else if (result.reason) {
      logger.warn?.(`[preset-md] 工具收窄未生效：${result.reason}`)
    }
    if (result.unmatched?.length) {
      logger.warn?.(`[preset-md] 以下工具模式未匹配到任何可见工具：${result.unmatched.join(', ')}`)
    }
  }

  if (!prompt.dir) {
    logger.warn?.(
      '[preset-md] 无法确定预设目录（ctx.baseUrl 为空），提示词与自动记忆都不会生效；' +
        '请确认插件行与 MD 文件在同一个 preset 目录里',
    )
    return
  }
  logger.info?.(`[preset-md] 预设目录 = ${prompt.dir}`)
  logger.info?.(
    `[preset-md] section ${prompt.sectionName} (order ${prompt.order}, complete=${prompt.complete}, 冻结=${prompt.freeze}, 变量 {{${prompt.variable}}})`,
  )
  for (const item of prompt.files) {
    logger.info?.(`[preset-md] ${item.exists ? '✓' : '·'} ${item.file}`)
  }

  /* 检索工具：让模型能翻自己的历史日志 */
  if (typeof ctx.tools?.register === 'function') {
    try {
      ctx.tools.register(createSearchTool(prompt.dir))
      logger.info?.('[preset-md] 已注册检索工具 preset_md_search')
    } catch (error) {
      logger.warn?.(
        `[preset-md] 检索工具注册失败（不影响其余功能）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (settings.autoMemory) registerAutoMemory(ctx, prompt, settings, logger)
}

/**
 * 自动记忆：回合结束按阈值触发，会话结束必触发；全部后台异步，不阻塞主对话。
 */
function registerAutoMemory(ctx, prompt, settings, logger) {
  /** sessionKey -> { turns, markChars, lastAt, running } */
  const states = new Map()

  const stateOf = (key) => {
    let state = states.get(key)
    if (!state) {
      state = { turns: 0, markChars: 0, lastAt: 0, running: false }
      states.set(key, state)
    }
    return state
  }

  const resolveModel = () => {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    return selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null
  }

  const schedule = (agent, key, reason) => {
    const state = stateOf(key)
    if (state.running) return
    const now = Date.now()
    if (now - state.lastAt < REVIEW_DEBOUNCE_MS) return
    state.lastAt = now
    state.running = true
    state.turns = 0
    state.markChars = transcriptChars(agent?.session?.events)

    void (async () => {
      try {
        const model = resolveModel()
        if (!model) {
          logger.warn?.('[preset-md] 自动记忆跳过：拿不到默认模型（agentDefaultModel）')
          return
        }
        const result = await runReview({
          ctx,
          dir: prompt.dir,
          session: agent?.session,
          provider: model.provider,
          model: model.model,
        })
        if (result.skipped) logger.info?.(`[preset-md] 自动记忆跳过（${result.skipped}，触发=${reason}）`)
        else logger.info?.(`[preset-md] 自动记忆完成（触发=${reason}）：${(result.applied ?? []).join(', ') || '无改动'}`)
      } catch (error) {
        logger.warn?.(`[preset-md] 自动记忆失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        state.running = false
      }
    })()
  }

  ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload?.agent
    const key = sessionKeyOf(agent)
    if (!key) return
    const state = stateOf(key)
    state.turns += 1
    const total = transcriptChars(agent?.session?.events)
    const grown = total - state.markChars
    if (state.turns < settings.reviewTurns && grown < settings.reviewChars) return
    schedule(agent, key, `轮数${state.turns}/新增${grown}字符`)
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload
    const key = sessionKeyOf(agent)
    if (!key) return
    schedule(agent, key, '会话结束')
    // 提示词缓存按会话键存放，会话结束一并清掉，避免 Map 增长
    prompt.cache.clear(key)
    setTimeout(() => states.delete(key), REVIEW_DEBOUNCE_MS * 4).unref?.()
  })
}
