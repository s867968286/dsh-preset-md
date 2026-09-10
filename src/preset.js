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
  contextBudgetNotice,
  measureContext,
  normalizeConfig,
  registerPrompt,
  sessionKeyOf,
} from './core.js'
import { readSettings, resolvePaths } from './settings.mjs'
import { createSearchTool } from './search.mjs'
import { createJournalTool, createMemoryTool } from './tools.mjs'
import { runReview } from './review.mjs'

/** 触发防抖（毫秒），写死。 */
const REVIEW_DEBOUNCE_MS = 5000

/** running 标志的最长有效期（毫秒）；超过即视为卡死并强制解锁。 */
const RUNNING_STALE_MS = 5 * 60 * 1000

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
    budgetChars: settings.contextBudget,
    budgetNotice: settings.budgetNotice,
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

  /* 注入体积：整体预算与各文件占比，一次量清 */
  logContextUsage(prompt.dir, settings, logger)

  /* 记忆工具：读（检索历史日志）+ 写（日志 / 长期记忆） */
  if (typeof ctx.tools?.register === 'function') {
    const toolFactories = [
      [createSearchTool, 'preset_md_search'],
      [createJournalTool, 'preset_md_journal'],
      [createMemoryTool, 'preset_md_memory'],
    ]
    const ok = []
    for (const [factory, toolName] of toolFactories) {
      try {
        ctx.tools.register(factory(prompt.dir))
        ok.push(toolName)
      } catch (error) {
        logger.warn?.(
          `[preset-md] ${toolName} 注册失败（不影响其余功能）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (ok.length > 0) logger.info?.(`[preset-md] 已注册记忆工具：${ok.join(', ')}`)
  }

  if (settings.autoMemory) registerAutoMemory(ctx, prompt, settings, logger)
}

/**
 * 量一遍注入体积并打日志。
 *
 * 只关心**整体**：六个文件加起来有没有越过预算线。单个文件偏大但整体没超，
 * 不报任何东西——各文件按 FILE_WEIGHTS 天然瓜分预算，不需要逐个设限。
 */
function logContextUsage(dir, settings, logger) {
  const measure = measureContext(dir, { budgetChars: settings.contextBudget })
  const percent = Math.round(measure.ratio * 100)
  const detail = measure.files
    .filter((row) => row.chars > 0)
    .map((row) => `${row.file.replace(/\.md$/, '')} ${row.chars}(${Math.round(row.share * 100)}%)`)
    .join(' ')
  logger.info?.(
    `[preset-md] 注入体积 ${measure.totalChars} 字符 ≈ ${measure.totalTokens} token，` +
      `预算 ${measure.budgetChars}（占 ${percent}%）| ${detail}`,
  )
  if (measure.over) {
    logger.warn?.(
      `[preset-md] 注入体积已超出预算（${measure.totalChars}/${measure.budgetChars}，占 ${percent}%）。` +
        `偏重：${measure.heaviest.map((row) => row.file).join('、') || '（无单文件明显偏重）'}。` +
        '已把「请收敛」提醒注入给模型。',
    )
  }
}

/**
 * 自动记忆：回合结束按阈值触发，会话结束必触发；全部后台异步，不阻塞主对话。
 */
function registerAutoMemory(ctx, prompt, settings, logger) {
  /** sessionKey -> { turns, markChars, lastAt, running, runningSince, pending } */
  const states = new Map()

  const stateOf = (key) => {
    let state = states.get(key)
    if (!state) {
      state = { turns: 0, markChars: 0, lastAt: 0, running: false, runningSince: 0, pending: '' }
      states.set(key, state)
    }
    return state
  }

  const resolveModel = () => {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    return selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : null
  }

  /**
   * 触发一次回顾。
   *
   * @param {boolean} force - 会话结束时传 true：绕过防抖（README 承诺「会话结束必触发」，
   *   被 5 秒防抖吞掉就等于最后一段对话永不归档）。若此时正好有回顾在跑，
   *   不并发第二次，而是记一个 pending，等它结束后补跑。
   */
  const schedule = (agent, key, reason, force = false) => {
    const state = stateOf(key)

    // 陈旧锁兜底：正常情况下 callText 自带超时，running 一定会在 finally 复位；
    // 但若真有别的挂起路径，超过 RUNNING_STALE_MS 后允许再次触发，避免该会话
    // 的自动记忆从此永久静默失效。
    if (state.running) {
      if (Date.now() - state.runningSince < RUNNING_STALE_MS) {
        if (force) state.pending = reason
        return
      }
      logger.warn?.('[preset-md] 上一次自动记忆疑似卡死，强制解锁后重试')
      state.running = false
    }

    const now = Date.now()
    if (!force && now - state.lastAt < REVIEW_DEBOUNCE_MS) return
    state.lastAt = now
    state.running = true
    state.runningSince = now
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
          // 转写窗口跟随触发阈值：阈值调大后回顾间隔变长，窗口必须同步放大
          transcriptChars: settings.reviewChars,
          onWarn: (message) => logger.warn?.(`[preset-md] ${message}`),
        })
        if (result.skipped) logger.info?.(`[preset-md] 自动记忆跳过（${result.skipped}，触发=${reason}）`)
        else logger.info?.(`[preset-md] 自动记忆完成（触发=${reason}）：${(result.applied ?? []).join(', ') || '无改动'}`)
      } catch (error) {
        logger.warn?.(`[preset-md] 自动记忆失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        state.running = false
        state.runningSince = 0
        // 会话结束时被 running 挡下的那次补跑
        const queued = state.pending
        state.pending = ''
        if (queued) schedule(agent, key, queued, true)
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
    // 会话结束必触发：force 绕过防抖
    schedule(agent, key, '会话结束', true)
    // 提示词缓存按会话键存放，会话结束一并清掉，避免 Map 增长
    prompt.cache.clear(key)
    // 留足时间给可能正在跑的回顾（含补跑），之后才清状态
    setTimeout(() => states.delete(key), RUNNING_STALE_MS).unref?.()
  })
}
