/**
 * 「伙伴模式」预设：会话级轻量工具清单 + 独占人设。
 *
 * ## 为什么放在这（而不是 agent.cordis.yml）
 *
 * rc2 起官方**不再读取** `.agent-presets/<id>/agent.cordis.yml`
 * （见 templates.mjs 的说明）。伙伴那份轻量工具清单在 rc2 下从未生效——
 * 实测伙伴会话跑的是 standard-gitbash 的 51 个工具（含 workflow / subagent /
 * plan mode / goal 等全套编码机械）。
 *
 * rc2 的官方通道是声明式预设注册：插件 `inject: ['agentPresets']` 后调
 *   `ctx.agentPresets.register({ id, name, description, order, plugins })`
 * 活样本：dsh-gitbash-shell（src/index.js:2031），`plugins` 是行数组，
 * 与旧 agent.cordis.yml 的行一一对应（含 `cordis:group` / `isolate`）。
 *
 * ## 行清单来源
 *
 * 逐行翻译自用户确认的
 * `.agent-presets-backup-rc2migrate-20260926-001638/companion-e4d0/agent.cordis.yml`：
 * 只保留对话真正需要的基础能力，**不挂** plan mode / compaction /
 * 委派与工作流 / goal / jobs —— 人格类会话用不上这些。
 *
 * 提示词**不在这里**：独占人设仍由 host 半按会话绑定注入
 * （`complete` section，见 companion.mjs），本预设不注册 persona 行，
 * 避免官方 "You are a coding agent ..." 与伙伴人格打架。
 */

const off = (disabled) => (disabled ? { disabled: true } : {})

/**
 * 伙伴模式的模型可控行。
 * @param {object} [options]
 * @param {boolean} [options.win] - 是否 Windows（决定 bash/pwsh 二选一）。
 * @returns {object[]} 行数组。
 */
export function companionPresetPlugins(options = {}) {
  const win = options.win ?? (typeof process !== 'undefined' && process.platform === 'win32')
  return [
    // ── shell ──
    // 与参考清单一致：Windows 用 pwsh、其余用 bash（参考文件是按平台二选一）。
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', ...off(win) },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', ...off(!win) },

    // ── filesystem ──
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },

    // ── skills ──
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },

    // ── remaining model-facing rows ──
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ]
}

/** 伙伴模式预设的注册信息（id / 名称 / 描述 / 排序）。 */
export const COMPANION_PRESET_ID = 'companion-mode'

export function companionPresetMeta() {
  return {
    id: COMPANION_PRESET_ID,
    name: '伙伴模式',
    description: '人格会话专用：独占人设与记忆，只保留对话基础工具（无 plan/工作流/子代理/goal）。',
    order: 20,
  }
}
