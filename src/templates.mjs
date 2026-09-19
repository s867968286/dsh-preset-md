/**
 * 新建伙伴时写入的内置模板。
 *
 * 正文放在包根 `templates/*.tpl`，运行时读入内存；改模板内容不用动代码。
 * 用 `.tpl` 后缀是为了避免 `AGENTS.md` 这类文件名被 DSH 当成工作区指令自动加载。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates')

/** 六个 MD 的顺序（同时也是界面 TAB 顺序）。 */
export const PRESET_FILES = [
  { file: 'SYSTEM.md', label: '提示词' },
  { file: 'SOUL.md', label: '个性' },
  { file: 'IDENTITY.md', label: '身份' },
  { file: 'USER.md', label: '用户' },
  { file: 'AGENTS.md', label: '准则' },
  { file: 'MEMORY.md', label: '记忆' },
]

/** 读一个模板文件原文。 */
function readTemplate(name) {
  return readFileSync(join(TEMPLATE_DIR, `${name}.tpl`), 'utf8')
}

/**
 * 渲染某个 MD 的初始内容。
 *
 * 用「函数式替换」而不是字符串替换：`String.replaceAll(pattern, string)` 的替换串里
 * `$&`、`$1`、`` $` `` 有特殊含义，昵称/用户名含这些字符时会被就地展开成 `{name}`
 * 之类的字面量，模板直接被污染。
 */
export function renderTemplate(file, { name, userName = '用户' }) {
  return readTemplate(file)
    .replaceAll('{name}', () => name)
    .replaceAll('{user}', () => userName)
}

/** 渲染整套 MD（file -> content）。 */
export function renderAllTemplates({ name, userName = '用户' }) {
  const out = {}
  for (const { file } of PRESET_FILES) out[file] = renderTemplate(file, { name, userName })
  return out
}

/**
 * 渲染 `agent.cordis.yml`。
 *
 * **不接收昵称**：这个文件是**插件行清单**，昵称不写进组合配置——
 * 它由 `preset.yml` 的 `name` 与 `IDENTITY.md` 承载（前者是官方预设选择器
 * 读的显示名，后者是模型看到的自我认知）。模板里因此没有任何 `{name}` 占位符，
 * 早先那个 `name` 参数是彻头彻尾的空操作（`replaceAll('{name}', name)` 永远匹配不到），
 * 留着只会让人误以为昵称进了 manifest。
 */
export function agentCordisTemplate() {
  return readTemplate('agent.cordis.yml')
}
