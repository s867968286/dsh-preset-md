/**
 * 伙伴绑定：记录"这个会话选了哪个伙伴"，并让它与会话事件流一起持久化。
 *
 * ## 为什么用官方的 session projection，而不是自己存映射表
 *
 * 官方记录"这个会话用哪个预设"就是这么做的
 * （`dsh-agent-preset-registry/lib/types/session.js` 的 `agentPresetProjectionDefinition`）：
 * 往会话追加一条事件，再注册一个纯 fold 把它投影成当前值。
 * 官方在源码里写了理由：
 *
 * > Recording the change is what keeps the log honest, and it is required
 * > outright by the repo's model-visible ⟺ logged rule, since the preset
 * > decides the tool schemas and prompt sections the model sees.
 *
 * 伙伴绑定决定**系统提示词**，正是"影响模型所见"的东西 —— 所以它必须进日志，
 * 而不是存在插件自己的文件里。这样也顺带解决两件事：
 * ① 会话重开能读回绑定，无需外部映射表（不会随会话数无限增长）；
 * ② 会话删除/迁移后不会留下对不上的孤儿记录。
 *
 * ## ⚠️ 纠正：绑定**不再**写进会话事件流
 *
 * 早年这里把绑定写成自定义会话事件 `companion/companion-selected`，并断言
 * "官方 v4 门禁对未知类型放行"——**这个判断是错的**，已由真实运行证伪。
 *
 * 实际门禁在 `dsh-session-persistence/lib/index.js:184`：
 *   `if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(...)`
 * 下游插件事件**不在**白名单（rc.2 共 59 个，全是官方自己的类型），
 * 必须带 `ignorable: true`。而 `Session.append()` 的 opts 只透传
 * `surfaceOp` / `sourceEventSeqs`（`dsh-session/lib/index.js:1401`），
 * Session 也没有第二个写入 API —— 第三方**拿不到写 ignorable 的入口**。
 *
 * 后果：写过绑定的会话下次打开时整条日志被拒读，
 * 报 `unknown to this harness and not marked ignorable; refusing to interpret the log`，
 * 表现为「新建会话失败 / 会话打不开」。
 *
 * 现在绑定住插件自己的 `bindings.json`（见 settings.mjs 的 `writeBinding`），
 * 按 sessionId 索引；`companionFromEvents` 仅保留用于读**历史遗留**事件。
 */
import { writeBinding } from './settings.mjs'
import {
  DEFAULT_CONTEXT_BUDGET,
  COMPANION_PERSONA_ORDER,
  COMPANION_PERSONA_SECTION,
  COMPANION_PERSONA_VARIABLE,
  contextBudgetNotice,
  measureContext,
  readAggregateText,
  substitutePlaceholders,
} from './core.js'

/** 会话事件类型：本插件记录伙伴选择用。 */
export const COMPANION_EVENT = 'companion/selected'

/** projection key：客户端与 host 都靠它读当前绑定。 */
export const COMPANION_PROJECTION_KEY = 'companionSelected'

/**
 * 归一化一个绑定值。
 *
 * `null` / `''` / 非法 id 一律视为「不使用伙伴」——这条是**退路**：
 * 用户不选伙伴时，插件不注册 complete section，官方提示词原样生效。
 */
export function normalizeCompanion(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '') return null
  return /^[a-z0-9][a-z0-9-]*$/.test(text) ? text : null
}

/**
 * 生成 projection 定义对象（纯 fold）。
 *
 * 传入 zod 实例而不是直接 import：本插件保持零运行时依赖，
 * 而 `z` 由调用方（host 半）从官方 schemastery/zod 取得。
 *
 * @param {object} z - zod 兼容对象（需要 `z.union` / `z.string` / `z.null`）。
 */
export function companionProjectionDefinition(z) {
  const schema = z.union([z.string(), z.null()])
  return {
    key: COMPANION_PROJECTION_KEY,
    stateSchema: schema,
    // 没有创建头字段可用：伙伴只在会话内选，不随会话创建而固定。
    init: () => null,
    apply: (state, event) => (event.type === COMPANION_EVENT
      ? normalizeCompanion(event.data?.companion)
      : state),
    wire: { viewSchema: schema, view: (state) => state },
    stateVersion: 1,
  }
}

/**
 * 把一条会话事件流折叠成当前绑定的伙伴（不走 projection 时的兜底读法）。
 *
 * 用途：单测与非 projection 场景；真实运行期读的是 projection。
 */
export function companionFromEvents(events) {
  let current = null
  for (const event of events ?? []) {
    if (event?.type === COMPANION_EVENT) current = normalizeCompanion(event.data?.companion)
  }
  return current
}

/**
 * 记录一次伙伴选择。
 *
 * ⚠️ **不要**改成往会话事件流 append。
 *
 * 官方 v4 持久化门禁（`dsh-session-persistence/lib/index.js:184`）对白名单外的
 * 事件类型要求 `ignorable === true`，而 `Session.append()` 没有给第三方传该标记的
 * 入口，Session 也没有别的写入 API。早期正是这样写的，导致写过绑定的会话
 * 下次打开时**整条日志被拒读** —— 新建会话直接失败。
 *
 * 所以绑定改由调用方落进插件自己的绑定表（`writeBinding`）。
 *
 * @param {object} paths - `resolvePaths()` 的结果。
 * @param {string} sessionId - 会话 id。
 * @param {string|null} companion - 伙伴 id；null 表示「无伙伴」。
 * @returns {string|null} 归一化后的绑定值。
 */
export function recordCompanionSelection(paths, sessionId, companion) {
  const value = normalizeCompanion(companion)
  writeBinding(paths, sessionId, value)
  return value
}

/**
 * 在**会话自己的 scope** 里按绑定注册提示词注入。
 *
 * ## 为什么必须在 agent scope 里注册
 *
 * `complete: true` 的 section 会**丢弃官方全部提示词段**。所以它只能在
 * "这个会话确实要自定义提示词"时存在；没绑伙伴的会话**一个 section 都不能注册**
 * —— 空文本的 complete 段不等于"未注册"，它会把系统提示词清成 `""`
 * （见 `registerPrompt` 的注释与 `dsh-system-prompt/lib/index.js:345`）。
 *
 * 而"用不用伙伴"是**每个会话各自**的决定，所以注册也必须按会话隔离。
 * 官方给的入口是 `agent/created` 监听器：契约把它标为 `Scoped<Agent>`，
 * 即监听器的 `this` 就是该 agent 的 scope；`systemPrompt.section()` 又明确
 * "Register ... in the calling context's scope"。两者一搭，隔离天然成立。
 *
 * ## 时序
 *
 * 用户在**新建对话时**选伙伴 —— 那时会话可能已经创建（`agent/created` 已过）。
 * 所以这里既在创建时注册，也提供 `refresh()` 供"选完伙伴后补注册"用：
 * 先 dispose 旧 section 再按新绑定注册。dispose 与 register 之间不存在
 * "两个 complete 并存"的窗口（同步完成），不会触发官方的多重 complete 报错。
 *
 * @param {object} ctx - **会话 scope** 的上下文（有 systemPrompt）。
 * @param {string} dir - 伙伴目录；空字符串表示"不注册任何注入"。
 * @param {() => object} getSettings - 实时读设置。
 * @returns {{refresh: (nextDir: string) => void, dispose: () => void, current: () => string}}
 */
export function injectCompanionPrompt(ctx, dir, getSettings) {
  let disposeSection = null
  let disposeVariable = null
  let active = ''

  const clear = () => {
    // 先撤 section 再撤变量：顺序反了会在极短窗口里留下"引用了不存在的变量"的段。
    try { disposeSection?.() } catch { /* 已撤 */ }
    try { disposeVariable?.() } catch { /* 已撤 */ }
    disposeSection = null
    disposeVariable = null
    active = ''
  }

  const install = (nextDir) => {
    if (!nextDir) return
    // 与 core.registerPrompt 一致：正文只在变量右值里，section 只引用变量，
    // 这样正文里的 `{{...}}` 不会被官方 interpolate 二次解析。
    disposeSection = ctx.systemPrompt.section({
      name: COMPANION_PERSONA_SECTION,
      order: COMPANION_PERSONA_ORDER,
      text: `{{${COMPANION_PERSONA_VARIABLE}}}`,
      complete: true,
    })
    disposeVariable = ctx.systemPrompt.variable(
      COMPANION_PERSONA_VARIABLE,
      () => readCompanionPrompt(nextDir, getSettings()),
    )
    active = nextDir
  }

  if (dir) install(dir)

  return {
    refresh(nextDir) {
      if (nextDir === active) return
      clear()
      install(nextDir)
    },
    dispose: clear,
    current: () => active,
  }
}

/**
 * 读一个伙伴目录，拼成提示词正文（含超限提醒）。
 *
 * 与 `core.registerPrompt` 的渲染保持一致：占位符替换 + 预算提醒。
 * 这里独立实现是因为 host 半直接持有目录，不需要 core 那套"按会话解析目录"
 * 的间接层；共享的是同一套 `readAggregateText` / `substitutePlaceholders`。
 */
export function readCompanionPrompt(dir, settings = {}) {
  const body = substitutePlaceholders(readAggregateText(dir), { presetDir: dir })
  if (settings.budgetNotice === false) return body
  const budget = Number.isFinite(settings.contextBudget) && settings.contextBudget > 0
    ? settings.contextBudget
    : DEFAULT_CONTEXT_BUDGET
  const notice = contextBudgetNotice(measureContext(dir, { budgetChars: budget }), { warnAt: 1 })
  return notice ? `${body}\n\n${notice}` : body
}
