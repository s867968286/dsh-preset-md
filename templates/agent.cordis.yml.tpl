# {name}：由「伙伴设置」生成的预设

# ── 提示词注入与自动记忆 ──
- id: preset-md
  name: dsh-preset-md/preset

# ── 工具 ──
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
