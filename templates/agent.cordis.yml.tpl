# 由「伙伴设置」生成的预设
#
# 这是**人格类**预设：只保留对话真正需要的基础工具，不挂官方 `standard` 里那套
# 编码 agent 的重型机械（plan mode / compaction / 委派与工作流 / goal / jobs）。
# 人格由本预设的 SYSTEM.md / IDENTITY.md 承载，不挂官方 `persona` 行——
# 它的 "You are a coding agent ..." 会与人格打架。
#
# 需要官方人格时，在「身份」段补一条即可：
#   - id: persona
#     name: '@deepseek-ai/dsh-persona'
#     config:
#       text: >-
#         You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
#
# 想把它当编码 agent 用时，从官方 standard preset 拷回所需的行即可。
#
# 注意：带 `isolate` 的行必须保持 `cordis:group` 结构，不能平铺成顶层行，
# 否则服务会发布到 root realm，`dsh-agent-presets` 在挂载时直接拒绝。

# ── 提示词注入与自动记忆（自研 preset-md） ──
- id: preset-md
  name: dsh-preset-md/preset
  config:
    tools:
      # 收窄全局工具：本插件自带 Markdown 记忆，关掉第三方记忆插件的工具，
      # 避免两套记忆系统互相干扰。没装 mnemon 时这条只会打一条 warn，不影响加载。
      deny:
        - 'mnemon*'        # 前缀

# ── shell ───────────────────────────────────────────────────────────────────

# `shell-env` stays in the HOST composition: `apps/cli/src/web.ts` injects it to
# publish `DSH_WEB_URL`/`DSH_WEB_MODE`, and a host row that injects a service is
# the criterion for host-plane ownership — injection resolves before any session
# exists, so there is no agent to key by. Behind a preset realm those variables
# never reached the model's shell at all. Both shell tools consume the host
# registry from here; their executors (`bash-sandbox`/`pwsh-sandbox`) are
# host-plane too.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

# ── filesystem ──────────────────────────────────────────────────────────────

# Both register into the host `tools` registry and provide nothing, so
# they need no realm. The `fs` service and its policy stay in the host.
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

# ── skills ──────────────────────────────────────────────────────────────────

# The skill REGISTRY lives in the host composition and is layered per scope:
# these rows register into THIS preset's layer of it, so they need no realm.
# `skill-filesystem` contributes local-root discovery for agents on this preset, and
# `tool-skill` gives them the catalog and loader; the merged catalog also
# carries whatever the deployment registered globally (repository plugins).
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'

# ── remaining model-facing rows ─────────────────────────────────────────────

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

# The `web` service and its search provider stay in the host composition; only
# the model-facing tool is per-session.
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000

- id: present
  name: '@deepseek-ai/dsh-tool-present'
