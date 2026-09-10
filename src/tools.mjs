/**
 * 写入类工具（零依赖）：让助手能主动写日志、更新长期记忆。
 *
 * 为什么必须走工具、不能让助手用 DSH 的 `write`/`edit` 直写文件：
 *
 * 1. **串行保护**：`memory-store` 的 `enqueue` 是进程内按路径的写队列。后台自动记忆
 *    （`runReview`）走 `appendJournal` / `applyUpdate`，会经过该队列；助手若直写同一文件
 *    则不经过队列，两边形成「读-改-写」竞态，后写的一方覆盖前一方（last-write-wins）。
 * 2. **留痕**：`applyUpdate` 会先写 changelog 再原子写文件；直写没有 changelog。
 * 3. **校验**：`applyOp` 会拒绝找不到或出现多次的 `old_text`；直写不做任何校验。
 *
 * 工具名带 `preset_md_` 前缀，避免与官方/第三方工具冲突。
 */
import { EDITABLE_FILES, appendJournal, applyUpdate } from './memory-store.mjs'

/** 模型可见的工具名。 */
export const JOURNAL_TOOL_NAME = 'preset_md_journal'
export const MEMORY_TOOL_NAME = 'preset_md_memory'

/** 统一的输出 schema / 渲染（工具返回纯文本，供模型阅读）。 */
const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

/**
 * 构造 `preset_md_journal`：把一段内容追加进当天日志。
 * @param {string} dir - preset 目录
 */
export function createJournalTool(dir) {
  return {
    name: JOURNAL_TOOL_NAME,
    description:
      '把一段内容写进今天的记忆日志（memory/YYYY-MM-DD.md）。插件会自动加上日期头与当前时间标题，' +
      '所以 body 只写正文。当用户说「记住这个」、或发生值得留档的事时用它。',
    // parameters 必须是标准 JSON Schema：register() 会原样透传给 provider，
    // 扁平写法（{body:{...}}）会被判非法。
    parameters: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description:
            '日志正文（Markdown）。建议沿用现有格式，三段小标题：### 讨论与解决 / ### 关键信息 / ### 感悟。',
        },
      },
      required: ['body'],
    },
    output: textOutput,
    async execute(args) {
      const body = typeof args?.body === 'string' ? args.body : ''
      if (!body.trim()) return { text: '写入失败：body 为空，没有内容可写。' }
      const result = await appendJournal(dir, body)
      if (!result.ok) return { text: `写入日志失败：${result.error}` }
      return { text: `已写入今天（${result.key}）的记忆日志。` }
    },
  }
}

/**
 * 构造 `preset_md_memory`：条目级更新长期记忆类 MD 文件。
 * @param {string} dir - preset 目录
 */
export function createMemoryTool(dir) {
  return {
    name: MEMORY_TOOL_NAME,
    description:
      `更新长期记忆类文件（只允许 ${EDITABLE_FILES.join(' / ')}）。` +
      'op=add 追加到文件末尾；op=replace 把 old_text 换成 content；op=remove 删除 old_text。' +
      'replace / remove 的 old_text 必须逐字来自文件原文且全文唯一，否则会被拒绝。每次成功写入都会记一条 changelog。',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: [...EDITABLE_FILES],
          description: '要修改的文件：IDENTITY.md（自我认知）、SOUL.md（人格）、USER.md（用户画像）、MEMORY.md（长期记忆）。',
        },
        op: {
          type: 'string',
          enum: ['add', 'replace', 'remove'],
          description: 'add 追加到末尾；replace 替换 old_text；remove 删除 old_text。',
        },
        content: {
          type: 'string',
          description: 'op=add / replace 时要写入的内容（Markdown）。op=remove 时忽略。',
        },
        old_text: {
          type: 'string',
          description: 'op=replace / remove 时必填：要被替换或删除的原文片段，必须逐字且全文唯一。',
        },
      },
      required: ['file', 'op'],
    },
    output: textOutput,
    async execute(args) {
      const file = typeof args?.file === 'string' ? args.file.trim() : ''
      const op = typeof args?.op === 'string' ? args.op.trim() : ''
      const content = typeof args?.content === 'string' ? args.content : ''
      const oldText = typeof args?.old_text === 'string' ? args.old_text : ''

      if (!EDITABLE_FILES.includes(file)) {
        return { text: `写入失败：不允许修改 ${file || '(空文件名)'}，只允许 ${EDITABLE_FILES.join(' / ')}。` }
      }
      if (!['add', 'replace', 'remove'].includes(op)) {
        return { text: `写入失败：未知操作 ${op || '(空)'}，只支持 add / replace / remove。` }
      }
      if (op === 'add' && !content.trim()) return { text: '写入失败：op=add 需要非空的 content。' }
      if (op === 'replace' && !oldText.trim()) return { text: '写入失败：op=replace 需要 old_text。' }
      if (op === 'replace' && !content.trim()) return { text: '写入失败：op=replace 需要非空的 content。' }
      if (op === 'remove' && !oldText.trim()) return { text: '写入失败：op=remove 需要 old_text。' }

      const result = await applyUpdate(dir, file, op, content, oldText)
      if (!result.ok) {
        const hint = /出现多次|未在文件中找到/.test(result.error)
          ? '（请先读取该文件，取一段逐字且唯一的原文）'
          : ''
        return { text: `写入 ${file} 失败：${result.error}${hint}` }
      }
      return { text: `已更新 ${file}（op=${result.op}），并记入 changelog。` }
    },
  }
}
