/**
 * Client 半（client/client.js）装配测试。
 *
 * 回归目标：client 半曾 `require('@deepseek-ai/dsh-client-ui-primitives')`，
 * 而该包在此 DSH 版本已不存在 → factory 顶层抛错 → plugin 对象拿不到 →
 * `apply` 从不执行 → `<style>` 从不注入 → 设置页整页裸 HTML。
 *
 * 这类故障在 Node 侧完全静默（浏览器里才炸），所以这里用一个最小桩把
 * `window.__ModuleLoader__` 接起来，直接断言 factory 能跑完、apply 能注入 CSS。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SETTINGS, normalizeSetting } from '../src/settings.mjs'

const SOURCE = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

/** 轻量 React 桩：保留 type/props/children，够断言结构即可。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  Fragment: Symbol('Fragment'),
}

/**
 * 在一个隔离的全局环境里执行 client bundle，并返回注册结果。
 * `extraModules` 用于模拟前端模块系统提供的 seed 表（react 等）。
 */
function load(extraModules = {}) {
  let registration = null
  const injected = []
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild: (el) => injected.push(el) },
  }
  const window = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
  const requireStub = (specifier) => {
    if (specifier === 'react') return React
    if (specifier in extraModules) return extraModules[specifier]
    // 模块系统的真实行为：未知 specifier 抛错（这正是原 BUG 的触发点）。
    throw new Error(`client-modules: cannot resolve external "${specifier}"`)
  }
  new Function('require', 'window', 'document', 'globalThis', SOURCE)(
    requireStub, window, document, globalThis,
  )
  return { registration, injected, requireStub }
}

/** 取出 factory 里的内部件，做单元断言。 */
function introspect() {
  const probe = SOURCE.replace(
    "return { apply, inject: ['slots'], name: 'preset-md-client' }",
    "return { apply, inject: ['slots'], name: 'preset-md-client', __test: { Dialog, CSS, ParamsTab } }",
  )
  assert.notEqual(probe, SOURCE, '未能在 client.js 里定位 return 语句，测试探针需要同步更新')
  let registration = null
  const window = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
  const document = { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }
  new Function('require', 'window', 'document', 'globalThis', probe)((s) => (s === 'react' ? React : (() => { throw new Error(s) })()), window, document, globalThis)
  return registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })())).__test
}

/* ─────────────── 有状态渲染桩：用来断言表单交互 ───────────────
 * 上面的 React 桩 useState 是常量，测不了「草稿 / 未保存 / 清空」。
 * 这里实现一套最小 hook 运行时：状态按调用序号存槽，setState 触发重渲染，
 * 组件函数被重新调用后据此重新求值——足够断言 dirty 提示与提交载荷。
 * ------------------------------------------------------------------ */

function makeStatefulReact() {
  let slots = []
  let cursor = 0
  let component = null
  let props = null
  const rerender = () => { if (component) render() }
  const render = () => {
    cursor = 0
    return component(props)
  }
  const React = {
    createElement: (type, p, ...children) => ({ type, props: p || {}, children }),
    useState: (init) => {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      const set = (value) => {
        slots[i] = typeof value === 'function' ? value(slots[i]) : value
        rerender()
      }
      return [slots[i], set]
    },
    useEffect: (fn) => {
      const i = cursor++
      if (!(i in slots)) {
        slots[i] = true
        fn() // 立即执行（本例的 effect 只做一次加载请求）
      }
    },
    useCallback: (fn) => {
      const i = cursor++
      if (!(i in slots)) slots[i] = fn
      return slots[i]
    },
    Fragment: Symbol('Fragment'),
  }
  const mount = (Component) => {
    component = Component
    slots = []
    props = {}
    return render()
  }
  return { React, mount, rerender: () => render() }
}

/** 在渲染树里深度查找满足条件的节点。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

/** 收集树里的纯文本。 */
function textOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) textOf(c, out); return out }
  for (const c of node.children ?? []) textOf(c, out)
  return out
}

/** 把一次 ParamsTab 渲染接上真实的 /settings 接口语义（含服务端归一化）。 */
function mountParams({ initial = {}, failPut = false } = {}) {
  const state = { ...DEFAULT_SETTINGS, ...initial }
  const puts = []
  /** 统计 GET 次数：用来断言「保存失败后会重新拉一次」。 */
  const gets = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'PUT') {
      if (failPut) {
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: '模拟保存失败' }) }
      }
      const patch = JSON.parse(options.body)
      puts.push(patch)
      // 与 host 半一致：逐键归一化（null / 空串 → 回落默认）
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (patch[key] !== undefined) state[key] = normalizeSetting(key, patch[key])
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ settings: { ...state } }) }
    }
    gets.push({ url, state: { ...state } })
    return { ok: true, status: 200, text: async () => JSON.stringify({ settings: { ...state } }) }
  }
  const runtime = makeStatefulReact()
  const { ParamsTab } = introspectWith(runtime.React)
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  return {
    runtime, puts, gets, flush, state,
    restore: () => { globalThis.fetch = originalFetch },
    mount: () => runtime.mount(ParamsTab),
  }
}

/** 用指定的 React 桩取内部件。 */
function introspectWith(ReactImpl) {
  const probe = SOURCE.replace(
    "return { apply, inject: ['slots'], name: 'preset-md-client' }",
    "return { apply, inject: ['slots'], name: 'preset-md-client', __test: { Dialog, CSS, ParamsTab } }",
  )
  assert.notEqual(probe, SOURCE, '未能在 client.js 里定位 return 语句，测试探针需要同步更新')
  let registration = null
  const window = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
  const document = { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }
  new Function('require', 'window', 'document', 'globalThis', probe)((s) => (s === 'react' ? ReactImpl : (() => { throw new Error(s) })()), window, document, globalThis)
  return registration.factory((s) => (s === 'react' ? ReactImpl : (() => { throw new Error(s) })())).__test
}

/** 表单里的数字输入框（按渲染顺序：触发轮数 / 触发字符数 / 注入预算）。 */
const numInputs = (tree) => findAll(tree, (n) => n.type === 'input' && n.props.type === 'number')
const saveButton = (tree) => findAll(tree, (n) => n.type === 'button' && textOf(n).join('').includes('保存'))[0]
const treeText = (tree) => textOf(tree).join('')


test('client bundle 注册了 dsh-preset-md', () => {
  const { registration } = load()
  assert.ok(registration, 'factory 未通过 __ModuleLoader__.load 注册')
  assert.equal(registration.id, 'dsh-preset-md')
})

test('factory 不 require 任何官方 UI 包（只依赖 react）', () => {
  const required = [...SOURCE.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(required)].sort(),
    ['react'],
    'client 半出现了 react 以外的 require；官方包名在 DSH 版本间会变，必须先验证其存在',
  )
})

test('factory 能跑完并返回可用 plugin（不再因顶层解构抛错）', () => {
  const { registration } = load()
  const plugin = registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })()))
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'preset-md-client')
  assert.deepEqual(plugin.inject, ['slots'])
})

test('apply 会注入样式，并注册 settings.section 槽位', () => {
  const { registration, injected } = load()
  const plugin = registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })()))

  const registered = []
  let injectedSlot = null
  const slots = {
    inject: (name, cb) => { injectedSlot = name; cb() },
    register: (meta, component) => { registered.push({ meta, component }); return {} },
  }
  plugin.apply({ slots })

  // 1) 样式必须真的插进 DOM —— 这正是「裸 HTML」的直接判别点
  assert.equal(injected.length, 1, 'apply 未注入 <style>')
  const css = injected[0].textContent
  assert.ok(css.length > 0, '注入的样式为空')
  // 2) 槽位注册照旧
  assert.equal(injectedSlot, 'settings.section')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].meta.id, 'preset-md')
  assert.equal(registered[0].meta.label, '伙伴设置')
  assert.equal(typeof registered[0].component, 'function')
})

test('apply 在 ctx.get("slots") 形态下同样工作，且在缺失时不抛错', () => {
  const { registration, injected } = load()
  const plugin = registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })()))
  const slots = { inject: (n, cb) => cb(), register: () => ({}) }
  plugin.apply({ get: () => slots })
  assert.equal(injected.length, 1)
  // slots 缺失：静默返回，不能把设置页整体带崩
  assert.doesNotThrow(() => plugin.apply({}))
})

test('参数表单：每个服务端设置项都必须出现在表单与保存载荷里（防静默漏项）', async () => {
  /*
   * 真风险（实测）：设置项在 client.js 里被枚举了**多遍** —— `form`（初值）、
   * `dirty`（改动判定）、`save` 的提交载荷，各写一次，共 7～9 处。任何一处漏掉
   * 都会**静默失效**，而且现有测试发现不了：
   *   实测把 `save` 载荷里的 `budgetNotice` 删掉 → 用户在 UI 关了它、点保存却不生效，
   *   而 15 条 client 测试**全部通过**。
   *
   * 这条以服务端 `DEFAULT_SETTINGS` 为权威清单，逐个核对三处枚举都齐备。
   */
  const serverKeys = Object.keys(DEFAULT_SETTINGS)

  // 1) 表单初值：每个 key 都要在 `form` 对象里出现
  for (const key of serverKeys) {
    const inForm = new RegExp(`^\\s*${key}: (saved\\.${key}|String\\(saved\\.${key})`, 'm').test(SOURCE)
    assert.ok(inForm, `form 初值缺少 ${key}（该设置不会显示当前值）`)
  }

  // 2) 改动判定：每个 key 都要参与 dirty 比较，否则「改了它」不会提示未保存、保存按钮不亮
  for (const key of serverKeys) {
    const inDirty = SOURCE.includes(`form.${key} !== `)
    assert.ok(inDirty, `dirty 判定缺少 ${key}（改了它不会提示未保存，保存按钮也不会亮）`)
  }

  // 3) 提交载荷：每个 key 都要真的发给服务端，否则改了不生效
  const tree = mountParams({ initial: {} })
  try {
    let t = tree.mount()
    await tree.flush()
    t = tree.runtime.rerender()
    // 随便改一个字段触发 dirty，并连带改所有可改项，确保整份载荷被提交
    for (const input of numInputs(t)) {
      if (!input.props.disabled) input.props.onChange({ target: { value: '7' } })
      t = tree.runtime.rerender()
    }
    saveButton(t).props.onClick()
    await tree.flush()

    assert.equal(tree.puts.length, 1, '应产生一次提交')
    const sent = tree.puts[0]
    for (const key of serverKeys) {
      assert.ok(key in sent, `保存载荷缺少 ${key}（改了它不会生效）`)
    }
  } finally {
    tree.restore()
  }
})

test('自建 Dialog 的 className 会与 pmd-dialog-sheet 拼接', () => {
  const { Dialog } = introspect()
  const sheetOf = (props) => Dialog({ open: true, title: 't', ...props }).children[0].props.className

  assert.equal(sheetOf({ className: 'pmd-viewer-dialog' }), 'pmd-dialog-sheet pmd-viewer-dialog')
  assert.equal(sheetOf({ className: 'pmd-dialog' }), 'pmd-dialog-sheet pmd-dialog')
  // 没有 className 时不留尾随空格
  assert.equal(sheetOf({}), 'pmd-dialog-sheet')
  // 闭合时不渲染
  assert.equal(Dialog({ open: false, title: 't' }), null)
})

test('Dialog 的遮罩关闭 / 内容不关闭行为正确', () => {
  const { Dialog } = introspect()
  const node = Dialog({ open: true, title: 't', onClose: () => { node.closed = true }, children: null })

  let stopped = false
  node.children[0].props.onClick({ stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true, '点弹窗内容没有阻止冒泡（会误触发遮罩关闭）')

  let closed = false
  const node2 = Dialog({ open: true, title: 't', onClose: () => { closed = true }, children: null })
  node2.props.onClick()
  assert.equal(closed, true, '点遮罩未关闭')
  assert.equal(node2.props.role, 'dialog')
  assert.equal(node2.props['aria-modal'], 'true')
})

test('弹窗定位所需的 CSS 规则存在', () => {
  const { CSS } = introspect()
  for (const selector of ['.pmd-overlay{', '.pmd-dialog-sheet{', '.pmd-dialog-head{', '.pmd-dialog-foot{']) {
    assert.ok(CSS.includes(selector), `缺少 ${selector} —— 自建弹窗会退化成无定位的裸 div`)
  }
})

/* ──────────────── 参数表单：草稿 / 未保存 / 清空还原默认 ──────────────── */

test('参数表单：无改动时保存按钮禁用，改一下就提示「有未保存的改动」', async () => {
  const tab = mountParams({ initial: { reviewTurns: 5, reviewChars: 3000 } })
  try {
    let tree = tab.mount()
    await tab.flush()
    tree = tab.runtime.rerender()

    assert.equal(numInputs(tree)[0].props.value, '5', '初始应显示服务端值')
    assert.equal(saveButton(tree).props.disabled, true, '没有改动时保存按钮该禁用')
    assert.ok(!treeText(tree).includes('有未保存的改动'), '没有改动时不该提示')

    // 改一个数字
    numInputs(tree)[0].props.onChange({ target: { value: '9' } })
    tree = tab.runtime.rerender()

    assert.equal(numInputs(tree)[0].props.value, '9', '输入框应显示草稿值')
    assert.ok(treeText(tree).includes('有未保存的改动'), '改完必须提示未保存')
    assert.equal(saveButton(tree).props.disabled, false, '有改动时保存按钮该可点')

    // 改回原值 → dirty 消失、按钮重新禁用
    numInputs(tree)[0].props.onChange({ target: { value: '5' } })
    tree = tab.runtime.rerender()
    assert.ok(!treeText(tree).includes('有未保存的改动'), '改回原值后不该再提示')
    assert.equal(saveButton(tree).props.disabled, true)
  } finally {
    tab.restore()
  }
})

test('参数表单：改动攒在草稿里，点保存才提交（不是边改边生效）', async () => {
  const tab = mountParams({ initial: { reviewTurns: 5, reviewChars: 3000 } })
  try {
    let tree = tab.mount()
    await tab.flush()
    tree = tab.runtime.rerender()

    // 连续改两个字段
    numInputs(tree)[0].props.onChange({ target: { value: '9' } })
    tree = tab.runtime.rerender()
    numInputs(tree)[1].props.onChange({ target: { value: '6000' } })
    tree = tab.runtime.rerender()

    assert.equal(tab.puts.length, 0, '编辑过程中不该打接口（否则会出现「改到一半已生效」）')

    saveButton(tree).props.onClick()
    await tab.flush()
    tree = tab.runtime.rerender()

    assert.equal(tab.puts.length, 1, '保存应只打一次接口')
    assert.deepEqual(
      { reviewTurns: tab.puts[0].reviewTurns, reviewChars: tab.puts[0].reviewChars },
      { reviewTurns: 9, reviewChars: 6000 },
      '草稿里的两个字段要一起提交',
    )
    assert.ok(treeText(tree).includes('已保存'), '保存后要有成功反馈')
    assert.equal(saveButton(tree).props.disabled, true, '保存后不该再有未保存改动')
  } finally {
    tab.restore()
  }
})

test('参数表单：清空数字 = 还原默认（提交 null，不能提交 undefined）', async () => {
  /*
   * 这是「删除即还原默认」的关键：清空必须提交 **null**。
   * 若提交 undefined，JSON.stringify 会把键整个丢掉，服务端收到空对象，
   * 「还原默认」根本不会发生 —— 用户以为重置了，实际没变。
   */
  const tab = mountParams({ initial: { reviewTurns: 20, reviewChars: 9000 } })
  try {
    let tree = tab.mount()
    await tab.flush()
    tree = tab.runtime.rerender()

    // 清空两个数字框
    numInputs(tree)[0].props.onChange({ target: { value: '' } })
    tree = tab.runtime.rerender()
    numInputs(tree)[1].props.onChange({ target: { value: '' } })
    tree = tab.runtime.rerender()

    assert.equal(numInputs(tree)[0].props.value, '', '清空后应保持空（用默认值）')
    assert.ok(treeText(tree).includes('有未保存的改动'), '清空也是改动')

    saveButton(tree).props.onClick()
    await tab.flush()
    tree = tab.runtime.rerender()

    const sent = tab.puts[0]
    assert.ok('reviewTurns' in sent, '清空的键必须出现在请求体里（提交 undefined 会让它消失）')
    assert.equal(sent.reviewTurns, null, '清空应提交 null')
    assert.equal(sent.reviewChars, null, '清空应提交 null')

    // 服务端归一化后回落默认，界面重新显示默认值
    assert.equal(tab.state.reviewTurns, DEFAULT_SETTINGS.reviewTurns)
    assert.equal(numInputs(tree)[0].props.value, String(DEFAULT_SETTINGS.reviewTurns), '保存后应回显默认值')
  } finally {
    tab.restore()
  }
})

test('参数表单：非法值（0 / 负数）由服务端回落默认，不夹成更小的值', async () => {
  const tab = mountParams({ initial: { reviewTurns: 5 } })
  try {
    let tree = tab.mount()
    await tab.flush()
    tree = tab.runtime.rerender()

    numInputs(tree)[0].props.onChange({ target: { value: '0' } })
    tree = tab.runtime.rerender()
    saveButton(tree).props.onClick()
    await tab.flush()

    assert.equal(tab.state.reviewTurns, DEFAULT_SETTINGS.reviewTurns, '0 应回落默认，而不是夹成 1')
  } finally {
    tab.restore()
  }
})

test('参数表单：保存失败要显示错误，重新拉服务端值，且不吞掉用户的编辑', async () => {
  /*
   * 失败时除了报错，还要**重新拉一次服务端值**（与 dsh-memory-md 一致）：
   * 万一后端已写入一部分、或并发的另一次保存成功了，本地基线就是脏的。
   *
   * 关键是不能顺手把 draft 清掉 —— 那样一次失败就把用户输的东西吞了。
   */
  const tab = mountParams({ initial: { reviewTurns: 5 }, failPut: true })
  try {
    let tree = tab.mount()
    await tab.flush()
    tree = tab.runtime.rerender()

    assert.equal(tab.gets.length, 1, '挂载时应拉一次服务端值')

    numInputs(tree)[0].props.onChange({ target: { value: '9' } })
    tree = tab.runtime.rerender()
    saveButton(tree).props.onClick()
    await tab.flush()
    tree = tab.runtime.rerender()

    assert.ok(treeText(tree).includes('保存失败'), '失败必须看得见')
    assert.equal(tab.gets.length, 2, '失败后应重新拉一次服务端值（纠正基线）')
    assert.equal(numInputs(tree)[0].props.value, '9', '用户的编辑不能被吞掉')
    assert.ok(treeText(tree).includes('有未保存的改动'), '失败后改动仍算未保存')
  } finally {
    tab.restore()
  }
})

test('参数表单：保存失败后若另一处已改过设置，基线要被纠正', async () => {
  /*
   * load() 的真正价值：失败后重新读，把本地基线对齐到服务端真实值。
   * 模拟「并发的另一次保存成功了」——服务端值是 8，而本地以为还是 5。
   */
  const tab = mountParams({ initial: { reviewTurns: 5 }, failPut: true })
  try {
    let tree = tab.mount()
    await tab.flush()
    tree = tab.runtime.rerender()

    // 用户把 5 改成 9（草稿），此时外部把服务端改成了 8
    numInputs(tree)[0].props.onChange({ target: { value: '9' } })
    tree = tab.runtime.rerender()
    tab.state.reviewTurns = 8

    saveButton(tree).props.onClick()
    await tab.flush()
    tree = tab.runtime.rerender()

    // 基线纠正为 8，草稿仍是 9 → 仍显示未保存（而不是误判成「没改动」）
    assert.equal(numInputs(tree)[0].props.value, '9', '草稿保留')
    assert.ok(treeText(tree).includes('有未保存的改动'), '相对于新基线 8，草稿 9 仍算改动')
  } finally {
    tab.restore()
  }
})

test('参数表单：数字框不显示默认值（清空即用默认，由服务端兜底）', async () => {
  /*
   * 界面上刻意不出现默认数字：输入框留空即代表「用默认值」。
   * 若把默认值塞进 placeholder 或标签，用户就分不清「空框」到底是
   * 「在用默认」还是「没加载出来」——参考实现同样刻意避开这一点。
   */
  const tab = mountParams({ initial: { reviewTurns: 5, reviewChars: 3000, contextBudget: 15000 } })
  try {
    let tree = tab.mount()
    await tab.flush()
    tree = tab.runtime.rerender()

    const inputs = numInputs(tree)
    assert.equal(inputs.length, 3, '应有三个数字输入（轮数 / 字符数 / 注入预算）')

    for (const input of inputs) {
      assert.equal(input.props.placeholder, undefined, '数字框不该有 placeholder')
      // value 应是服务端值的字符串形式，而不是被替换成「默认 N」之类的文案
      assert.equal(typeof input.props.value, 'string')
      assert.ok(!/默认/.test(input.props.value), 'value 里不该出现默认值文案')
    }
    // 标签里也不该写「默认 N」
    assert.ok(!/默认\s*\d+/.test(treeText(tree)), '标签里不该写死默认值')
  } finally {
    tab.restore()
  }
})

