# dsh-preset-md

> 给 DSH 助手赋予**人格、灵魂与长期记忆**——用 Markdown 定义伙伴的身份、性格、准则与记忆，
> 自动写日记、自动更新记忆，并在官方设置页里可视化管理。

> Give your DSH assistant a **soul, personality, and long-term memory** — define a companion's
> identity, character, and memory in Markdown, with automatic journals and memory updates.

> **本项目由 AI 生成**：代码与文档均由 AI 编码代理产出并迭代，人类负责需求、设计与实机验证。

DSH 的 agent preset 是一份插件行列表（`<dshHome>/.agent-presets/<id>/agent.cordis.yml`）。
本插件让一个 preset 从**自己的目录**读取几个约定好的 Markdown 文件，拼成该会话**唯一**的系统提示词；
同时在后台按天写日志、按条目更新记忆文件。

提示词按会话冻结：改文件后新开一个对话即可生效，运行中的会话不受影响。

## 预览

| 伙伴列表 | 参数设置 | 提示词编辑 |
| :---: | :---: | :---: |
| ![伙伴列表](docs/screenshots/companion-list.png) | ![参数设置](docs/screenshots/companion-params.png) | ![提示词编辑](docs/screenshots/companion-edit-prompt.png) |

## 文件约定

```
<dshHome>/.agent-presets/<id>/
├── agent.cordis.yml     ← 加一行 preset-md
├── preset.yml           ← 昵称与个性签名
├── SYSTEM.md            ┐
├── SOUL.md              │
├── IDENTITY.md          ├─ 按此顺序拼成唯一系统提示词
├── USER.md              │
├── AGENTS.md            │
├── MEMORY.md            ┘
├── memory/              ← 按天日志（YYYY-MM-DD.md）
└── changelog/           ← 记忆文件的改动留痕
```

| 文件 | 用途 | 后台回顾可改 |
|---|---|---|
| `SYSTEM.md` | 系统级指令 | ❌ |
| `SOUL.md` | 人格 | ✅ |
| `IDENTITY.md` | 自我认知 | ✅ |
| `USER.md` | 用户上下文 | ✅ |
| `AGENTS.md` | 工作方式 | ❌ |
| `MEMORY.md` | 持久记忆 | ✅ |

文件不存在或内容为空 → 该段跳过，不会留下空标题。
标题由文件自己写，插件不额外加：最终提示词就是各文件正文按顺序用空行连接。

### 占位符

正文里可以写下面三个占位符，在会话冻结时替换一次（同一会话内恒定）：

| 占位符 | 替换为 |
|---|---|
| `{{cwd}}` | 当前会话的工作目录 |
| `{{preset}}` | 当前 preset id |
| `{{session}}` | 当前会话 id |

其余 `{{…}}` 原样保留，便于看出没生效。

## 安装

尚未发布到 npm，请从 GitHub 安装：

```sh
# 装进某个 profile（推荐：可用完整的「伙伴设置」页面）
dsh plugin --profile <profile> add github:s867968286/dsh-preset-md
```

装完**重启 dsh**：bundle 不热重载，已挂载的组合不会热替换模块。

本地开发时改用 link：

```sh
dsh plugin --profile <profile> add link:/绝对路径/dsh-preset-md
```

也可以不安装，直接在 preset 里用绝对路径引用 preset 行入口，此时只有提示词注入与自动记忆，没有设置页。

在目标 preset 的 `agent.cordis.yml` 里加一行：

```yaml
- id: preset-md
  name: dsh-preset-md/preset
```

目录取 `ctx.baseUrl`——preset 加载器会把它指向 `agent.cordis.yml` 所在目录，
所以**插件行与那几个 Markdown 必须放在同一个 preset 目录里**。取不到时提示词为空并打一条 warn。

> 从 GitHub 装的插件会走 `prepare` 脚本构建，pnpm 默认拦截该脚本；
> 若安装后提示被拦，按它打印的 key 在 profile 目录的 `pnpm-workspace.yaml` 里加进 `allowBuilds` 再重跑。

## 收窄工具

agent 能看到的工具 = 全局层（profile 里装的插件）＋ preset 层（`agent.cordis.yml` 挂的行）＋ agent 层。
「preset 没挂某个插件」并不会让它的工具消失，要收窄得显式声明：

```yaml
- id: preset-md
  name: dsh-preset-md/preset
  config:
    tools:
      deny:
        - 'mnemon*'        # 前缀
        - '*_recall'       # 后缀
        - '*mcp*'          # 包含
        - 'read_page'      # 精确
      # allow: ['read_page', 'x_search']   # 白名单：只保留这些全局工具
```

只支持上面四种写法，中间通配（如 `a*b`）一律不命中。
`deny` 是黑名单，`allow` 是白名单（两者同时给时都生效）。

插件会先把写法展开成精确的工具名再下发，因此**没命中任何工具的条目只会打一条 warn**，
不会让插件加载失败——升级第三方插件后名单失效时你能从日志里看到。

## 自动记忆

后台异步执行，不阻塞对话，也不需要子代理。

**触发时机**

| 时机 | 条件 |
|---|---|
| 会话结束 | 必触发 |
| 回合结束 | 未总结轮数或新增字符数达到阈值 |
| 防抖 | 短时间内不重复触发 |

**一次回顾做两件事**（复用全局默认模型，单次调用）：

1. **当天日志**：追加到 `memory/YYYY-MM-DD.md`，三段式——讨论与解决 / 关键信息 / 感悟；
2. **记忆更新**：只允许改 `SOUL.md` / `IDENTITY.md` / `USER.md` / `MEMORY.md`，
   操作 `add` / `replace` / `remove`。`replace` / `remove` 的目标文本必须逐字来自原文且唯一，
   否则该条被跳过——**永远不整文件覆盖**。

**留痕**：每次改动前先写 `changelog/<文件名>.changelog.md`，一条记录一块，按块滚动裁剪，不切断单条记录。

**检索**：注册只读工具 `preset_md_search`，让模型能翻自己的历史日志。

| 参数 | 行为 |
|---|---|
| `days` | 按文件名算日期区间，默认最近 7 天 |
| `query` | 全文逐行匹配，返回 `日期:行号` 与上下文；不填则返回日志索引 |

## 伙伴设置

装进 profile 后，**官方设置页**里会多一项「伙伴设置」（复用官方 `settings.section`，不自建侧栏入口）。

```
设置 → 伙伴设置
├── 伙伴   卡片列表：昵称 + 个性签名 + 查看 / 复制 / 删除
│   └── 查看   昵称与签名可编辑，另有 7 个页签
│              提示词 / 个性 / 身份 / 用户 / 准则 / 记忆 / 日记
└── 参数   自动记忆开关与阈值、会话冻结、独占提示词、抑制运行时上下文
```

| 行为 | 说明 |
|---|---|
| 编辑 Markdown | 每个文件一个页签，纯文本编辑（不引 Markdown 渲染库） |
| 新建伙伴 | 用内置模板生成 6 个 Markdown + `agent.cordis.yml` + `preset.yml` + `memory/` |
| 复制伙伴 | 克隆内容与组合，不带历史日志 |
| 删除 | 只移动到备份目录，不真删；新会话选不到，旧对话仍可查看 |
| 参数 | 存 `<dshHome>/preset-md/settings.json`，改动对新会话生效 |

## 目录结构

```
├── src/index.js          主入口（Host 半）：/preset-md/api/* 与文件读写
├── src/preset.js         preset 行（子路径 ./preset）：提示词注入 + 自动记忆
├── src/core.js           纯逻辑：目录解析、变量与 section 注册、会话冻结、工具收窄
├── src/memory-store.mjs  日志追加 / 条目级更新 / changelog
├── src/review.mjs        回顾提示词 + 模型调用 + 结果解析
├── src/search.mjs        preset_md_search 工具
├── src/settings.mjs      设置读写
├── src/templates.mjs     模板装载
├── templates/*.tpl       新建伙伴时写入的内置模板
├── client/client.js      Client 半：注册「伙伴设置」页面
├── cordis.patch.yml      bundle 补丁
└── test/*.test.mjs
```

## 开发

```sh
npm install
npm test          # node --test
npm run check     # 语法检查
```

运行时依赖只有官方的 `@deepseek-ai/dsh-llm`（用于构造回顾消息与解析模型输出流），
版本需与 dsh 运行时一致——预发布版本不受 `^` 范围匹配，请写精确版本。

## 注意事项

| 事项 | 说明 |
|---|---|
| 只有一个独占提示词段 | 同一 scope 里再出现一个 `complete` 段会让组装直接失败 |
| 改 Markdown 要新开会话 | 会话冻结的代价；同一会话内改动不生效 |
| 独占提示词的含义 | 官方身份说明与其他插件注册的提示词段都不再进入请求 |
| 抑制上下文快照的含义 | 该 scope 的运行时上下文快照全部不进请求，模型只能从工具报错得知拒绝原因 |
| 改插件代码要重启 dsh | 已挂载的组合不会热替换模块 |

## 关键词

`dsh` · `deepseek-harness` · `persona` · `soul` · `memory` · `companion` · `ai-assistant` ·
`agent-preset` · `markdown` · `system-prompt`

人格 · 灵魂 · 记忆 · 助手 · 伙伴 · 预设 · 提示词

## 致谢与借鉴

本项目参考了以下两个开源项目，**仅借鉴设计思路与文件约定，代码为独立实现**：

| 项目 | 地址 | 借鉴点 |
|---|---|---|
| dsh-claw-suite | https://github.com/xingyingyuzhui/dsh-claw-suite | 用约定的 Markdown（`SOUL` / `IDENTITY` / `AGENTS`）承载人设并注入系统提示词，`USER` / `MEMORY` ＋ `memory/YYYY-MM-DD.md` 日记另行注入与回合后回顾；在设置页里按页签读写这些文件的交互思路 |
| DeepSeek-Harness-Hanako-Memory | https://github.com/moononnn/DeepSeek-Harness-Hanako-Memory | 卡片式伙伴管理界面与预设增删改的交互思路（本项目按官方 UI 规范重写，未照搬其界面代码） |

也感谢官方 `@deepseek-ai/dsh` 提供的 agent-presets / settings / home-paths 机制。

**关于 AI 生成**：本项目的代码、文档与界面实现均由 AI 编码代理生成并多轮迭代，
人类负责需求定义、架构决策与实机验证。使用前请自行审阅，生产环境请谨慎评估。

## 许可

MIT
