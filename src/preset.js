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
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  PLUGIN_NAME,
  PROMPT_ORDER,
  PROMPT_SECTION,
  PROMPT_VARIABLE,
  applyToolRestriction,
  measureContext,
  normalizeConfig,
  registerPrompt,
  sessionEvents,
  sessionKeyOf,
} from './core.js'
import { readSettings, resolvePaths } from './settings.mjs'
import { createSearchTool } from './search.mjs'
import { createJournalTool, createMemoryTool } from './tools.mjs'
import { isHumanMessage, runReview } from './review.mjs'

/** 触发防抖（毫秒），写死。 */
const REVIEW_DEBOUNCE_MS = 5000

/** running 标志的最长有效期（毫秒）；超过即视为卡死并强制解锁。 */
const RUNNING_STALE_MS = 5 * 60 * 1000

/** 同一条会话的「失败提示」最短重复间隔（毫秒）：失败要看得见，但不能刷屏。 */
const NOTICE_THROTTLE_MS = 60 * 1000

/**
 * 连续失败上限：失败不推进水位是为了让下一轮重试同一段，但不能无限重试——
 * 一段坏内容（例如模型持续吐非法 JSON）会让水位永久卡死，后面的内容再也轮不到。
 * 达到上限就放弃这一段强制推进，与 `dsh-memory-md` 的 `MAX_SUMMARY_ATTEMPTS` 同一做法。
 */
export const MAX_REVIEW_ATTEMPTS = 3

/** 日志文件上限（字节）：超过就只保留后半，避免无限增长。 */
const LOG_MAX_BYTES = 256 * 1024

/**
 * 带本地时区偏移的 ISO 时间戳，例如 `2026-09-11T20:03:31.650+08:00`。
 *
 * 不用 `toISOString()`：那给的是 UTC（`…T12:03:31.650Z`），跟日记段落、changelog
 * 里的本地时间对不上，看日志还得自己心算时差。
 */
export function localTimestamp(now = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}${offset}`
  )
}

/**
 * 包一层 logger：既走 dsh 原生日志，也**落盘**到 `<dshHome>/preset-md/preset-md.log`。
 *
 * 落盘的理由很实际：dsh 以无控制台的方式启动时 stdout 完全看不到，
 * 而后台回顾的成败只打日志——出问题时用户根本无从得知（这正是此前
 * 「日记不写、又看不到任何报错」卡住排查的原因）。落盘失败绝不影响主流程。
 */
function createLogger(ctx, paths) {
  const base = ctx.logger ?? console
  const file = join(paths.dshHome, 'preset-md', 'preset-md.log')
  const write = (level, message) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      try {
        if (statSync(file).size > LOG_MAX_BYTES) {
          const prev = readFileSync(file, 'utf8')
          writeFileSync(file, prev.slice(Math.floor(prev.length / 2)), 'utf8')
        }
      } catch {
        /* 文件还不存在 */
      }
      // 落盘时剥掉 `[preset-md]` 前缀：整个文件都属于本插件，前缀纯属噪音。
      // stdout 那边保留前缀，因为 dsh 的日志里混着别的插件。
      const line = String(message).replace(/^\[preset-md\]\s*/, '')
      appendFileSync(file, `${localTimestamp()} [${level}] ${line}\n`, 'utf8')
    } catch {
      /* 落盘失败不影响功能 */
    }
  }
  const call = (fn, message) => {
    try {
      fn?.(message)
    } catch {
      /* 底层日志失败不影响功能 */
    }
  }
  return {
    info: (message) => {
      call(base.info?.bind(base), message)
      write('info', message)
    },
    warn: (message) => {
      call(base.warn?.bind(base), message)
      write('warn', message)
    },
  }
}

/** Cordis 插件名。 */
export const name = PLUGIN_NAME

/**
 * 硬依赖：提示词注册表与工具注册表。
 *
 * 注意 `llm` **不在这里声明**：preset 组合里存在 isolate 组，
 * `ctx.llm` 这种属性访问会撞上隔离边界而抛 `cannot get property "llm" without inject`；
 * 往 inject 里加也不能修好——属性解析顺序是「先查本 fiber 的 store，再查本 fiber 的 inject」，
 * 声明之后反而更早抛错。所以回顾调用统一走 `ctx.get('llm')`，见 review.mjs 的 callText。
 */
export const inject = ['systemPrompt', 'tools']

/** 统计一段 content 的文本长度。 */
function textLength(content) {
  if (!Array.isArray(content)) return 0
  return content.reduce(
    (total, block) => total + (block?.type === 'text' && typeof block.text === 'string' ? block.text.length : 0),
    0,
  )
}

/**
 * 会话累计文本长度（用于判断「新增了多少」）。
 *
 * 只计**真人**发言与助手回复：官方运行时快照、其他插件的注入消息一律不计入。
 * 否则注入文本会撑大 `grown`，让回顾在真人几乎没说话时就被触发——
 * 实测某工作区的会话里 user/message 字符有 96% 来自注入而非真人。
 */
function transcriptChars(events) {
  let total = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (isHumanMessage(event)) total += textLength(event.data?.content)
    else if (event?.type === 'assistant/message') total += textLength(event.data?.message?.content)
  }
  return total
}

/** 当前会话累计转写字符数（走 Session 的公开事件读取 API）。 */
function transcriptCharsOf(agent) {
  return transcriptChars(sessionEvents(agent?.session))
}

/**
 * 装配：提示词 → 工具收窄 → 检索工具 → 自动记忆。
 * @param {object} ctx - dsh 上下文。
 * @param {unknown} rawConfig - preset 行的 config（目前只认 tools）。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const paths = resolvePaths()
  // dsh 无控制台启动时 stdout 看不到，所有日志同时落盘（见 createLogger）
  const logger = createLogger(ctx, paths)

  /*
   * 参数实时生效：设置**每次使用**时才读盘，而不是在 apply 时读一次就冻结。
   * 这样在「伙伴设置 → 参数」里改完立即对新会话与运行中的会话都生效，
   * 不必重启 dsh、也不必重开会话。
   */
  const getSettings = () => readSettings(paths)

  /* 提示词：变量承载内容 + 唯一 section（可 complete）+ 会话冻结 */
  const prompt = registerPrompt(ctx, {
    variable: PROMPT_VARIABLE,
    sectionName: PROMPT_SECTION,
    order: PROMPT_ORDER,
    getSettings,
  })

  /* 工具收窄：把模式展开成精确名单后交给 tools.restrict */
  if (config.tools.allow.length > 0 || config.tools.deny.length > 0) {
    const result = applyToolRestriction(ctx, config.tools)
    if (result.applied) {
      const bits = []
      if (result.filter?.allow?.length) bits.push(`allow=${result.filter.allow.join(',')}`)
      if (result.filter?.deny?.length) bits.push(`deny=${result.filter.deny.join(',')}`)
      logger.info?.(`[preset-md] 工具收窄已生效：${bits.join(' ')}`)
    } else if (result.reason) {
      /*
       * 把真实异常一并打出来：早先只写一句固定文案，升级到 dsh 0.1.5-rc.2 后这条 warn
       * 连刷十几次都看不出根因，只能靠读 dsh 源码猜。真实原因（读 `ctx.agent` 撞隔离
       * 边界）就是这样逼出来的，之后不要再把异常吞成散文。
       */
      const detail = result.error ? ` | 错误=${result.error}` : ''
      logger.warn?.(`[preset-md] 工具收窄未生效：${result.reason}${detail}`)
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
  /*
   * 装配信息合并成一条：早先每样打一行（目录 / 参数 / section / 六个文件各一行），
   * 每次重启就刷 10 行噪音，真正要看的「回顾成败」反而被埋掉。
   * 现在只留一行，缺文件单独点名（全都在就只列名字）。
   */
  const startup = getSettings()
  const present = prompt.files.filter((item) => item.exists).map((item) => item.file.replace(/\.md$/, ''))
  const missing = prompt.files.filter((item) => !item.exists).map((item) => item.file)
  logger.info?.(
    `[preset-md] 装配 目录=${prompt.dir} | 参数 autoMemory=${startup.autoMemory} ` +
      `reviewTurns=${startup.reviewTurns} reviewChars=${startup.reviewChars} ` +
      `freeze=${startup.freeze} complete=${startup.complete} | ` +
      `section=${prompt.sectionName}(order ${prompt.order}, 变量 {{${prompt.variable}}}) | ` +
      `文件=${present.join('/') || '（无）'}${missing.length > 0 ? ` 缺:${missing.join(',')}` : ''}`,
  )

  /* 注入体积：整体预算与各文件占比，一次量清 */
  logContextUsage(prompt.dir, getSettings(), logger)

  /* 记忆工具：读（检索历史日志）+ 写（日志 / 长期记忆） */
  if (typeof ctx.tools?.register === 'function') {
    const toolFactories = [
      [createSearchTool, 'preset_md_search'],
      [createJournalTool, 'preset_md_journal'],
      [createMemoryTool, 'preset_md_memory'],
    ]
    for (const [factory, toolName] of toolFactories) {
      try {
        ctx.tools.register(factory(prompt.dir))
      } catch (error) {
        // 成功不打日志：三个工具每次都一样，写进去只是噪音；失败才值得说。
        logger.warn?.(
          `[preset-md] ${toolName} 注册失败（不影响其余功能）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  // 始终挂上自动记忆：开关改为在每次触发时实时判断，
  // 这样「关掉自动记忆」对运行中的会话也立即生效（不必等新会话）。
  registerAutoMemory(ctx, prompt, getSettings, logger)
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
 * 会话键缩写：日志里带上它，才能分辨「哪个会话触发的回顾」。
 * 多个会话共用一个 preset（standing 组合是共享的），光看时间无法区分。
 */
function shortKey(key) {
  const text = String(key ?? '')
  return text.length > 12 ? `${text.slice(0, 12)}…` : text || '?'
}

/**
 * 自动记忆：回合结束按阈值触发，会话结束必触发；全部后台异步，不阻塞主对话。
 *
 * 设置全部实时读取（getSettings），所以阈值、开关改动立即生效。
 * 触发条件满足却没能写入时，除了打日志，还会**往对话里注入一条提示**——
 * 失败发生在后台，日志又只在 dsh 进程的 stdout，用户默认看不到。
 */
function registerAutoMemory(ctx, prompt, getSettings, logger) {
  /** sessionKey -> { turns, markChars, lastAt, running, runningSince, pending, lastNoticeAt, attempts } */
  const states = new Map()

  /**
   * sessionKey -> agent。
   *
   * `session/event` 只给 session，而 schedule() 需要 agent（读 requestHeader 取模型、
   * 用 agent.inject 发提示），所以从 `agent/created` 建一张映射表。
   */
  const agentsBySession = new Map()

  const stateOf = (key) => {
    let state = states.get(key)
    if (!state) {
      state = {
        turns: 0,
        markChars: 0,
        lastAt: 0,
        running: false,
        runningSince: 0,
        pending: '',
        lastNoticeAt: 0,
        // 连续失败次数：失败不推进水位是为了重试，但必须有上限，
        // 否则一段坏内容会让该会话的水位永久卡死。
        attempts: 0,
      }
      states.set(key, state)
    }
    return state
  }

  /**
   * 取本次回顾要用的模型：**直接用当前会话正在用的模型**。
   *
   * `session.requestHeader().config` 就是会话日志里最后一条 request/header 的
   * provider/model——也就是这个会话实际跑着的模型。不再用全局默认模型
   * （`agentDefaultModel`），否则会话换过模型时，回顾会跑到另一个模型上去。
   *
   * 会话还没有任何请求头时（极端情况）才回退到全局默认。
   */
  const resolveModel = (agent) => {
    try {
      const config = agent?.session?.requestHeader?.()?.config
      if (config?.provider && config?.model) {
        return { provider: String(config.provider), model: String(config.model) }
      }
    } catch {
      /* 落到回退 */
    }
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return { provider: String(selection.provider), model: String(selection.model) }
      }
    } catch {
      /* 没有可用模型 */
    }
    return null
  }

  /**
   * 把一条失败提示送进对话（模型可见），带节流，避免同一问题反复刷屏。
   * 注入走 agent.inject，与官方 approval 通知同一路子。
   */
  const notify = (agent, key, text) => {
    const state = stateOf(key)
    const now = Date.now()
    if (now - state.lastNoticeAt < NOTICE_THROTTLE_MS) return
    state.lastNoticeAt = now
    const message = `[preset-md] ${text}`
    try {
      agent?.inject?.(
        createUserMessage({
          content: [{ type: 'text', text: message }],
          source: { kind: 'plugin', plugin: 'dsh-preset-md' },
        }),
      )
    } catch (error) {
      logger.warn?.(`[preset-md] 失败提示未能注入对话：${error instanceof Error ? error.message : String(error)}`)
    }
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
    /*
     * 水位**先算出来但不写回 state**：只有回顾真正成功后才提交（见 finally）。
     *
     * 早先是同步阶段就 `state.markChars = transcriptCharsOf(agent)`，早于 LLM 调用；
     * 失败分支又只打日志不回滚，于是那一轮内容的水位被白白推进——
     * 长会话里这段内容滚出尾部窗口后就**静默丢失**，日志和界面都看不出发生过。
     */
    const marksAt = transcriptCharsOf(agent)

    void (async () => {
      // 是否算「已消费掉这段内容」：失败（含解析失败）一律 false，下一轮重试同一段
      let consumed = false
      try {
        // 实时读设置：阈值可能与触发时不同了，用最新值决定转写窗口
        const settings = getSettings()
        const model = resolveModel(agent)
        if (!model) {
          const detail = '拿不到会话模型与默认模型，本次未执行'
          logger.warn?.(`[preset-md] 自动记忆跳过：${detail}`)
          notify(agent, key, `自动记忆已满足触发条件（${reason}），但${detail}。`)
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
        if (result.skipped) {
          // 正常跳过（例如对话太短）：这是终态，不算失败，照常推进水位。
          consumed = true
          logger.info?.(`[preset-md] 自动记忆跳过（${result.skipped}，触发=${reason}，会话=${shortKey(key)}）`)
        } else if (result.parseFailed) {
          // 解析失败 = 日记与记忆都没写入，这段内容**没被消费**：不推进水位，下轮重试
          const detail = '模型输出解析失败，本轮日记与记忆都没写入'
          logger.warn?.(
            `[preset-md] 自动记忆已触发（${reason}，会话=${shortKey(key)}）但${detail}。原文片段：${result.parseFailed}`,
          )
          notify(agent, key, `自动记忆已满足触发条件（${reason}），但${detail}。`)
        } else {
          consumed = true
          const applied = (result.applied ?? []).join(', ')
          if (applied) {
            logger.info?.(`[preset-md] 自动记忆完成（触发=${reason}，会话=${shortKey(key)}）：${applied}`)
          } else if (result.journalEmpty) {
            // 不一律告警：按规则，寒暄/简单问答/测试本来就该留空，那是正常结果。
            // 这里记 info 并带上转写长度，长度能帮人判断这个「空」是否合理。
            const length = Number.isFinite(result.transcriptLength) ? result.transcriptLength : -1
            logger.info?.(
              `[preset-md] 自动记忆完成（触发=${reason}，会话=${shortKey(key)}）：本轮未追加日志——` +
                `模型判定没有值得记录的新内容（转写 ${length} 字符；若本轮确实只是寒暄 / 简单问答 / 测试则属正常）`,
            )
          } else {
            logger.info?.(`[preset-md] 自动记忆完成（触发=${reason}，会话=${shortKey(key)}）：记忆无改动`)
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        logger.warn?.(`[preset-md] 自动记忆失败：${detail}`)
        notify(agent, key, `自动记忆已满足触发条件（${reason}），但执行失败：${detail}`)
      } finally {
        /*
         * 水位提交策略：成功才推进，失败保留游标让下一轮自然重试同一段。
         *
         * 但不能无限重试——一段坏内容（例如模型持续吐非法 JSON）会让水位永久卡死，
         * 后面的内容再也轮不到。连续失败到 MAX_REVIEW_ATTEMPTS 就放弃这一段强制推进，
         * 与 dsh-memory-md 的 MAX_SUMMARY_ATTEMPTS 同一做法。
         *
         * `turns` 同理：失败时**不清零**，否则「轮数阈值」也被白白消耗掉。
         */
        const attempts = consumed ? 0 : state.attempts + 1
        const giveUp = !consumed && attempts >= MAX_REVIEW_ATTEMPTS
        if (consumed || giveUp) {
          state.turns = 0
          state.markChars = marksAt
        }
        state.attempts = attempts
        if (giveUp) {
          logger.warn?.(
            `[preset-md] 自动记忆连续 ${attempts} 次失败，放弃这一段（触发=${reason}，会话=${shortKey(key)}），` +
              `避免水位永久卡死；后续内容仍会正常回顾`,
          )
        }
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
    const settings = getSettings()
    if (settings.autoMemory !== true) return
    const state = stateOf(key)
    state.turns += 1
    const total = transcriptCharsOf(agent)
    const grown = total - state.markChars
    if (state.turns < settings.reviewTurns && grown < settings.reviewChars) return
    schedule(agent, key, `轮数${state.turns}/新增${grown}字符`)
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload
    const key = sessionKeyOf(agent)
    if (!key) return
    // 会话结束必触发：force 绕过防抖。开关关闭时同样不写。
    if (getSettings().autoMemory === true) schedule(agent, key, '会话结束', true)
    // 提示词缓存按会话键存放，会话结束一并清掉，避免 Map 增长
    prompt.cache.clear(key)
    agentsBySession.delete(key)
    // 留足时间给可能正在跑的回顾（含补跑），之后才清状态
    setTimeout(() => states.delete(key), RUNNING_STALE_MS).unref?.()
  })

  /*
   * ── 压缩前 flush ──
   *
   * 上下文压缩（compaction）会把老对话摘要掉：若某段工作还没被回顾总结，
   * 压缩后就**再也没有机会**总结它——内容已不在事件窗口内。
   *
   * `session/event` 给的是 session，而 schedule() 需要 agent（要读 requestHeader
   * 取模型、要 agent.inject 发提示），所以用 agent/created 维护一张映射表。
   */
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    const key = sessionKeyOf(agent)
    if (key) agentsBySession.set(key, agent)
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'compaction/start') return
    if (getSettings().autoMemory !== true) return
    const key = sessionKeyOf({ session })
    if (!key) return
    const agent = agentsBySession.get(key)
    if (!agent) return
    /*
     * force：压缩是「最后机会」，不能被 5 秒防抖吞掉。
     * 若此时正好有回顾在跑，schedule 会记 pending 并在其结束后补跑。
     *
     * `turn/start` 之外的边界：这里不 await（schedule 本身就是后台异步），
     * 压缩流程不会被这次回顾拖住——即使回顾很慢，压缩照常进行。
     */
    schedule(agent, key, '压缩前归档', true)
  })
}
