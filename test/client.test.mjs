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
    "return { apply, inject: ['slots'], name: 'companion-client' }",
    "return { apply, inject: ['slots'], name: 'companion-client', __test: { Dialog, CSS, ParamsTab, AgentDetail, TabBar, CompanionPicker } }",
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
  let rendering = false
  /** effect 回调排队：真实 React 在 commit 之后跑，不能在渲染过程中同步跑。 */
  const pendingEffects = []
  const rerender = () => {
    if (!component) return
    const tree = render()
    drain()
    return tree
  }
  const drain = () => {
    while (pendingEffects.length > 0) {
      const fn = pendingEffects.shift()
      fn()
    }
  }
  const render = () => {
    cursor = 0
    rendering = true
    try {
      return component(props)
    } finally {
      rendering = false
    }
  }
  const React = {
    createElement: (type, p, ...children) => ({ type, props: p || {}, children }),
    useState: (init) => {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      const set = (value) => {
        slots[i] = typeof value === 'function' ? value(slots[i]) : value
        /*
         * 渲染过程中调用 setState 只更新槽位、不重入渲染——
         * 否则 effect 里的 setState 会在首次渲染的栈里递归渲染，
         * 而那时游标尚未复位，后续 hook 会读到错位的槽。
         */
        if (!rendering) rerender()
      }
      return [slots[i], set]
    },
    useEffect: (fn) => {
      const i = cursor++
      if (!(i in slots)) {
        slots[i] = true
        // 排队到本次渲染结束之后执行（模拟 commit 后的 effect）
        pendingEffects.push(fn)
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
    pendingEffects.length = 0
    const tree = render()
    drain()
    return tree
  }
  /** 重渲染并把排队的 effect 跑完，直到没有任何待处理状态变更。 */
  const flush = () => {
    for (let i = 0; i < 50; i += 1) {
      if (pendingEffects.length === 0) break
      drain()
    }
    return render()
  }
  return { React, mount, rerender, flush }
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

/** 用指定的 React 桩取内部件。`windowStub` 用于注入 / 观测 `window.confirm`。 */
function introspectWith(ReactImpl, windowStub = {}) {
  const probe = SOURCE.replace(
    "return { apply, inject: ['slots'], name: 'companion-client' }",
    "return { apply, inject: ['slots'], name: 'companion-client', __test: { Dialog, CSS, ParamsTab, AgentDetail, TabBar, CompanionPicker } }",
  )
  assert.notEqual(probe, SOURCE, '未能在 client.js 里定位 return 语句，测试探针需要同步更新')
  let registration = null
  /*
   * client 走 `new Function(..., 'window', ...)`，模块体内引用的是这个**参数**，
   * 不是 globalThis.window。所以要观测 confirm 就得换掉这里的桩。
   */
  const window = { __ModuleLoader__: { load: (reg) => { registration = reg } }, ...windowStub }
  const document = { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }
  new Function('require', 'window', 'document', 'globalThis', probe)((s) => (s === 'react' ? ReactImpl : (() => { throw new Error(s) })()), window, document, globalThis)
  return registration.factory((s) => (s === 'react' ? ReactImpl : (() => { throw new Error(s) })())).__test
}

/** 表单里的数字输入框（按渲染顺序：触发轮数 / 触发字符数 / 注入预算）。 */
const numInputs = (tree) => findAll(tree, (n) => n.type === 'input' && n.props.type === 'number')
const saveButton = (tree) => findAll(tree, (n) => n.type === 'button' && textOf(n).join('').includes('保存'))[0]
const treeText = (tree) => textOf(tree).join('')


test('client bundle 注册了 dsh-companion', () => {
  const { registration } = load()
  assert.ok(registration, 'factory 未通过 __ModuleLoader__.load 注册')
  assert.equal(registration.id, 'dsh-companion')
})

/*
 * 这条锁的是「官方包取不到也不能拖垮整页」，不是「一个字都不许提官方包」。
 *
 * 原判据是「源码里除 react 外不得出现任何 require 包名」，但那个判据与事故脱节：
 * 真正让整页变裸 HTML 的是 **factory 顶层解构官方包 → 抛错 → apply 从不执行**，
 * 而不是「提到了官方包」。按包名扫源码既误伤安全用法，又放过了危险用法
 * （顶层 require 一个名字没变过但会抛错的包同样拦不住）。
 *
 * 现行做法：官方图标 require 包在 try/catch 内并带内联 SVG 回退。所以这里改为
 * 断言该 require 被 try/catch 包住 —— 这才是与事故等价的判据。
 */
test('client 对官方包的 require 必须被 try/catch 包住（取不到也不得抛错）', () => {
  const official = [...SOURCE.matchAll(/require\(\s*['"]((?!react['"])[^'"]+)['"]\s*\)/g)].map((m) => m[1])
  for (const name of new Set(official)) {
    // 取该 require 出现处往前一小段，确认它落在 try 块内。
    const index = SOURCE.indexOf(`require('${name}')`) >= 0
      ? SOURCE.indexOf(`require('${name}')`)
      : SOURCE.indexOf(`require("${name}")`)
    const before = SOURCE.slice(Math.max(0, index - 240), index)
    assert.ok(
      /try\s*\{[^]*$/.test(before),
      `client 半在 try/catch 之外 require 了官方包 ${name}；` +
      '取不到时会在 factory 顶层抛错 → apply 从不执行 → 整页裸样式',
    )
  }
})

test('官方图标包取不到时，三个图标回退到内联 SVG（不抛错）', () => {
  // load() 的 require 桩对非 react 一律抛错，正好模拟「官方包不存在」。
  const { registration } = load()
  const plugin = registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })()))
  assert.equal(typeof plugin.apply, 'function', '官方包取不到时 factory 仍应返回可用 plugin')
})

test('factory 能跑完并返回可用 plugin（不再因顶层解构抛错）', () => {
  const { registration } = load()
  const plugin = registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })()))
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'companion-client')
  assert.deepEqual(plugin.inject, ['slots'])
})

test('apply 会注入样式，并注册 settings.section 槽位', () => {
  const { registration, injected } = load()
  const plugin = registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })()))

  const registered = []
  const injectedSlots = []
  const slots = {
    inject: (name, cb) => { injectedSlots.push(name); cb() },
    register: (meta, component) => { registered.push({ meta, component }); return {} },
  }
  plugin.apply({ slots })

  // 1) 样式必须真的插进 DOM —— 这正是「裸 HTML」的直接判别点
  assert.equal(injected.length, 1, 'apply 未注入 <style>')
  const css = injected[0].textContent
  assert.ok(css.length > 0, '注入的样式为空')
  // 2) 设置页槽位照旧
  const settings = registered.find((item) => item.meta.name === 'settings.section')
  assert.ok(settings, '未注册设置页槽位')
  assert.equal(settings.meta.id, 'companion')
  assert.equal(settings.meta.label, '伙伴设置')
  assert.equal(typeof settings.component, 'function')
})

test('apply 会把自己 id 的伙伴下拉挂到 conversation.input.left（不顶掉官方项）', () => {
  /*
   * 官方对 `conversation.input.left` 的契约是：
   *   "Use an id of your own: a fresh id is added BESIDE the shipped entries,
   *    while reusing a shipped id puts you in THAT cell and replaces it."
   *
   * 所以这里锁两件事：① 挂到了这个 slot；② 用的是**自有 id** ——
   * 一旦有人把它改成官方已有的 id，就成了"替换官方控件"，必须被挡下。
   */
  const { registration, injected } = load()
  const plugin = registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })()))

  const registered = []
  const injectedSlots = []
  const slots = {
    inject: (name, cb) => { injectedSlots.push(name); cb() },
    register: (meta, component) => { registered.push({ meta, component }); return {} },
  }
  plugin.apply({ slots })

  assert.ok(injectedSlots.includes('conversation.input.left'), '未挂到输入框工具栏 slot')
  const picker = registered.find((item) => item.meta.name === 'conversation.input.left')
  assert.ok(picker, '未注册伙伴下拉')
  assert.equal(picker.meta.id, 'companion-mode', '必须用自有 id，否则会替换官方控件')
  assert.equal(typeof picker.component, 'function')
})

test('conversation.input.left 不存在时不抛错，其余功能照常', () => {
  /*
   * 旧版 dsh 没有这个 slot（或 slots 实现不同）。此时必须静默降级：
   * 设置页照常可用，不能因为下拉挂不上就把整个 client 带崩。
   */
  const { registration, injected } = load()
  const plugin = registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })()))

  const registered = []
  const slots = {
    inject: (name, cb) => {
      if (name === 'conversation.input.left') throw new Error('unknown slot')
      cb()
    },
    register: (meta) => { registered.push(meta); return {} },
  }
  assert.doesNotThrow(() => plugin.apply({ slots }))
  assert.ok(registered.some((meta) => meta.name === 'settings.section'), '设置页仍应注册')
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

test('自建 Dialog 的 className 会与 cmd-dialog-sheet 拼接', () => {
  const { Dialog } = introspect()
  const sheetOf = (props) => Dialog({ open: true, title: 't', ...props }).children[0].props.className

  assert.equal(sheetOf({ className: 'cmd-viewer-dialog' }), 'cmd-dialog-sheet cmd-viewer-dialog')
  assert.equal(sheetOf({ className: 'cmd-dialog' }), 'cmd-dialog-sheet cmd-dialog')
  // 没有 className 时不留尾随空格
  assert.equal(sheetOf({}), 'cmd-dialog-sheet')
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
  for (const selector of ['.cmd-overlay{', '.cmd-dialog-sheet{', '.cmd-dialog-head{', '.cmd-dialog-foot{']) {
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


/* ─────────────── AgentDetail：编辑冲突与未保存改动 ───────────────
 * 这两条对应两个会**静默吃数据**的场景：
 * 1. 后台自动记忆往 MEMORY.md 追加后，用户拿十年前的快照整文件覆盖 → 那条记忆消失；
 * 2. 用户改了半天，切页签时草稿被静默换掉。
 * 前者靠 baseVersion → 409，后者靠 dirty 确认。
 * ------------------------------------------------------------------ */

/** 为 AgentDetail 接一个模拟 host（含 files / versions / 409 语义）。 */
function mountDetail({ tab = 'MEMORY.md', initialContent = '原有内容\n', conflict = false, windowStub = {} } = {}) {
  const files = { 'SYSTEM.md': '', 'SOUL.md': '', 'IDENTITY.md': '', 'USER.md': '', 'AGENTS.md': '', 'MEMORY.md': '' }
  files[tab] = initialContent
  const versions = {}
  for (const key of Object.keys(files)) versions[key] = `v0-${key}`
  const puts = []
  const originalFetch = globalThis.fetch
  /** 置为 true 后所有 /file 写入返回 409（模拟文件已被后台改过）。 */
  let conflicted = conflict

  globalThis.fetch = async (url, options) => {
    if (options?.method === 'PUT' && String(url).endsWith('/file')) {
      const body = JSON.parse(options.body)
      puts.push(body)
      if (conflicted) {
        return {
          ok: false,
          status: 409,
          text: async () => JSON.stringify({ error: `${body.file} 已被后台修改（例如自动记忆写入），请重新载入后再保存` }),
        }
      }
      versions[body.file] = `v1-${body.file}`
      files[body.file] = body.content
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, version: versions[body.file] }) }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        agent: { id: 'demo', name: '小花', description: '温柔', files: { ...files }, versions: { ...versions } },
      }),
    }
  }

  const runtime = makeStatefulReact()
  const { AgentDetail } = introspectWith(runtime.React, windowStub)
  /*
   * 等异步链走完再渲染。
   *
   * 桩里的 effect 是同步排队的，而 effect 内部发的是真 fetch（打桩为 async），
   * `.then` 里的 setState 要等微任务。这里交替「让出微任务」与「渲染」，
   * 直到渲染树不再停在「加载中」为止。
   */
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      runtime.flush()
    }
  }
  return {
    runtime, puts, versions, files, flush,
    /** 运行时切换冲突模式（载入阶段要放行，保存阶段才模拟 409）。 */
    setConflict: (value) => { conflicted = value },
    restore: () => { globalThis.fetch = originalFetch },
    mount: () => runtime.mount(() => AgentDetail({ id: 'demo', onBack: () => {} })),
  }
}

/** 编辑区文本域与保存/取消按钮。 */
const textarea = (tree) => findAll(tree, (n) => n.type === 'textarea')[0]
/** 按文案找按钮。默认**精确匹配**——详情页顶部还有一个「保存昵称/签名」，模糊匹配会拿错。 */
const buttonByText = (tree, label, { exact = true } = {}) => findAll(tree, (n) => {
  if (n.type !== 'button') return false
  const text = textOf(n).join('')
  return exact ? text === label : text.includes(label)
})[0]
/** 详情页的页签栏（用 tabs 数组里是否含目标页签来识别）。 */
const tabBarOf = (tree, key) => findAll(tree, (n) => (
  n.props && typeof n.props.onChange === 'function'
  && Array.isArray(n.props.tabs) && n.props.tabs.some((t) => t.key === key)
))[0]

/**
 * 挂载详情页并切到指定页签。
 *
 * 详情页默认停在第一个页签（SYSTEM.md），所以要断言某个文件的编辑行为，
 * 必须先切过去——这正是 pickTab 的真实用法。
 */
async function mountDetailAt(target) {
  const detail = mountDetail({ tab: target })
  detail.mount()
  await detail.flush()
  let tree = detail.runtime.rerender()
  if (target !== 'SYSTEM.md') {
    const bar = tabBarOf(tree, target)
    assert.ok(bar, `应能找到页签栏（切到 ${target}）`)
    bar.props.onChange(target)
    tree = detail.runtime.rerender()
  }
  return { detail, tree }
}

test('AgentDetail：载入后无改动 → 保存按钮禁用、不显示未保存提示', async () => {
  const { detail, tree } = await mountDetailAt('MEMORY.md')
  try {
    assert.equal(textarea(tree).props.value, '原有内容\n', '应载入文件内容')
    assert.equal(buttonByText(tree, '保存').props.disabled, true, '无改动时保存应禁用')
    assert.ok(!treeText(tree).includes('有未保存的改动'))
  } finally {
    detail.restore()
  }
})

test('AgentDetail：改了草稿 → 提示未保存、保存按钮可用，且能提交', async () => {
  const { detail, tree: initial } = await mountDetailAt('MEMORY.md')
  try {
    let tree = initial
    textarea(tree).props.onChange({ target: { value: '改后的内容' } })
    tree = detail.runtime.rerender()

    assert.ok(treeText(tree).includes('有未保存的改动'), '改一下就该提示')
    assert.equal(buttonByText(tree, '保存').props.disabled, false, '有改动时保存应可用')

    await buttonByText(tree, '保存').props.onClick()
    await detail.flush()
    assert.equal(detail.puts.length, 1, '应提交一次')
    assert.equal(detail.puts[0].content, '改后的内容')
    assert.equal(detail.puts[0].file, 'MEMORY.md')
  } finally {
    detail.restore()
  }
})

test('AgentDetail：保存时带上载入时的 baseVersion', async () => {
  const { detail, tree: initial } = await mountDetailAt('MEMORY.md')
  try {
    let tree = initial
    textarea(tree).props.onChange({ target: { value: '新内容' } })
    tree = detail.runtime.rerender()
    await buttonByText(tree, '保存').props.onClick()
    await detail.flush()

    /*
     * 不带 baseVersion 就是无条件整文件覆盖：后台自动记忆在此期间追加的内容
     * 会被静默抹掉。这条锁住「必须带上」。
     */
    assert.equal(detail.puts[0].baseVersion, 'v0-MEMORY.md', '必须回传载入时的版本指纹')
  } finally {
    detail.restore()
  }
})

test('AgentDetail：409 冲突时显示可重载的提示，且不吞掉用户草稿', async () => {
  const { detail, tree: initial } = await mountDetailAt('MEMORY.md')
  // 切到这个页签之后再打开冲突模式，避免影响载入
  detail.setConflict(true)
  try {
    let tree = initial
    textarea(tree).props.onChange({ target: { value: '我的草稿' } })
    tree = detail.runtime.rerender()
    await buttonByText(tree, '保存').props.onClick()
    await detail.flush()
    tree = detail.runtime.rerender()

    assert.ok(treeText(tree).includes('已被后台修改'), '应把 409 的原因显示出来')
    assert.ok(buttonByText(tree, '重新载入'), '应给出「重新载入」这条出路')
    // 草稿不能被吞掉——用户还得能复制走
    assert.equal(textarea(tree).props.value, '我的草稿', '失败后草稿必须保留')
  } finally {
    detail.restore()
  }
})

test('AgentDetail：切页签前对未保存改动做确认；取消则留在原页签', async () => {
  let asked = 0
  let answer = false
  const detail = mountDetail({
    windowStub: {
      confirm: (text) => { asked += 1; assert.match(text, /未保存/); return answer },
    },
  })
  try {
    detail.mount()
    await detail.flush()
    let tree = detail.runtime.rerender()

    textarea(tree).props.onChange({ target: { value: '未保存的编辑' } })
    tree = detail.runtime.rerender()

    const tabBar = tabBarOf(tree, 'SOUL.md')
    assert.ok(tabBar, '应能找到页签栏')

    // 用户点「取消」→ 不该切走，草稿必须还在
    answer = false
    tabBar.props.onChange('SOUL.md')
    tree = detail.runtime.rerender()
    assert.equal(asked, 1, '应弹确认')
    assert.equal(textarea(tree).props.value, '未保存的编辑', '取消后草稿不能丢')

    // 用户点「确定」→ 切走并载入新文件
    answer = true
    tabBar.props.onChange('SOUL.md')
    tree = detail.runtime.rerender()
    assert.equal(asked, 2)
    assert.equal(textarea(tree).props.value, '', '应载入目标文件内容')
  } finally {
    detail.restore()
  }
})

test('AgentDetail：无改动时切页签不弹确认（不打扰）', async () => {
  let asked = 0
  const detail = mountDetail({ windowStub: { confirm: () => { asked += 1; return true } } })
  try {
    detail.mount()
    await detail.flush()
    let tree = detail.runtime.rerender()

    tabBarOf(tree, 'SOUL.md').props.onChange('SOUL.md')
    assert.equal(asked, 0, '没有未保存改动时不该弹确认')
  } finally {
    detail.restore()
  }
})


/* ─────────────── 伙伴下拉：为什么"看不见" ───────────────
 * 两个**静默**故障曾经让下拉在界面上完全不出现（既不报错、也没日志）：
 *
 * 1. 请求路径写成了 `/api/companions`，而 `API` 已经含 `/api` 段
 *    （`const API = '/companion/api'`）→ 实际打 `/companion/api/api/companions`
 *    → 404 → catch 把 phase 置 error → `return null`。
 * 2. 会话身份取的是 `props.session`，但官方该 slot 的 props 表里没有这个名字
 *    （声明处为 `renderSlot("conversation.input.left", {})`，传的是空对象），
 *    会话身份由 standard kit 以 `sessionId` / `useSession` 注入。
 *    取不到 session → `canPickCompanion` 判为已锁定 → 退化成只读小标签。
 *
 * 两条都属于「没有断言就一定会复发」的类型，所以这里直接钉住 URL 与取值来源。
 * ------------------------------------------------------------------ */

/** 挂载伙伴下拉。`fetch` 被替换成记录请求的桩。 */
function mountPicker({ sessionId = 's1', session = undefined, companions = [], current = null, fail = false, presetId = 'companion-mode' } = {}) {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? 'GET' })
    if (fail) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) }
    return { ok: true, status: 200, text: async () => JSON.stringify({ companions, current }) }
  }
  const runtime = makeStatefulReact()
  const { CompanionPicker } = introspectWith(runtime.React)
  const useSession = (selector) => (selector ? selector(session) : session)
  /*
   * 官方读法（dsh-client-ui-agent-preset/lib/client.js:359-363）：
   * useSessions 的列表投影里 byId[sid].projectionValues.agentPreset。
   * presetId 缺省即伙伴模式 —— 默认走显形分支，旧用例不必逐个改。
   */
  const useSessions = (selector) => selector({ byId: { [sessionId]: { projectionValues: { agentPreset: presetId } } } })
  return {
    runtime, calls, originalFetch,
    mount: () => runtime.mount(() => CompanionPicker({ sessionId, useSession, useSessions })),
    restore: () => { globalThis.fetch = originalFetch },
  }
}

test('伙伴下拉：接口路径不得重复 /api（曾拼成 /companion/api/api/… → 404 静默消失）', async () => {
  const picker = mountPicker({
    companions: [{ id: 'lily', name: '莉莉' }],
    session: { sessionId: 's1', blank: true },
  })
  try {
    picker.mount()
    await new Promise((resolve) => setImmediate(resolve))
    picker.runtime.flush()

    assert.equal(picker.calls.length, 1, '应发出一次列表请求')
    assert.equal(
      picker.calls[0].url, '/companion/api/companions?session=s1',
      'API 常量已含 /api 段，再拼一次就是 404（下拉会静默 return null）',
    )
  } finally {
    picker.restore()
  }
})

test('伙伴下拉：会话身份取自 sessionId/useSession，取不到就不会退化成只读标签', async () => {
  /*
   * blank 会话 = 还没开始，按契约必须**可选**。
   * 修复前 `props.session` 恒为 undefined → locked=true → 渲染成只读 span，
   * 用户看到的就是"没有下拉"。
   */
  const picker = mountPicker({
    companions: [{ id: 'lily', name: '莉莉' }],
    session: { sessionId: 's1', blank: true, promptAttempted: false },
  })
  try {
    picker.mount()
    await new Promise((resolve) => setImmediate(resolve))
    const rendered = picker.runtime.flush()

    const button = findAll(rendered, (n) => n.type === 'button' && n.props.className === 'cmd-chip')[0]
    assert.ok(button, '新建会话里应渲染出可点的下拉按钮，而不是被锁成只读文本')
    assert.ok(textOf(button).join('').includes('无伙伴'), '未绑定时应显示「无伙伴」')

    // 展开后能列出伙伴 + 「无伙伴」选项
    button.props.onClick()
    const opened = picker.runtime.rerender()
    const items = findAll(opened, (n) => n.props && n.props.className === 'cmd-menu-item')
    assert.equal(items.length, 2, '菜单应含「无伙伴」与一个伙伴')
  } finally {
    picker.restore()
  }
})

test('伙伴下拉：选中伙伴走 PUT /companion 并带上 session', async () => {
  const picker = mountPicker({
    companions: [{ id: 'lily', name: '莉莉' }],
    session: { sessionId: 's1', blank: true },
  })
  try {
    picker.mount()
    await new Promise((resolve) => setImmediate(resolve))
    let rendered = picker.runtime.flush()

    findAll(rendered, (n) => n.type === 'button' && n.props.className === 'cmd-chip')[0].props.onClick()
    rendered = picker.runtime.rerender()
    const lily = findAll(rendered, (n) => n.props && n.props.className === 'cmd-menu-item' && textOf(n).join('') === '莉莉')[0]
    assert.ok(lily, '菜单里应能按昵称找到伙伴')

    await lily.props.onClick()
    await new Promise((resolve) => setImmediate(resolve))

    const put = picker.calls.find((item) => item.method === 'PUT')
    assert.ok(put, '应发出 PUT 请求')
    assert.equal(put.url, '/companion/api/companion', '同样不得重复 /api 段')
  } finally {
    picker.restore()
  }
})

test('伙伴下拉：列表为空时不占位置', async () => {
  const empty = mountPicker({ session: { sessionId: 's1', blank: true } })
  try {
    empty.mount()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(empty.runtime.flush(), null, '一个伙伴都没有时不该出现空下拉')
  } finally {
    empty.restore()
  }
})

test('伙伴下拉：拉列表失败时不占位置（静默，但绝不渲染半成品）', async () => {
  /*
   * 这一条同时是本次事故的**教训记录**：失败路径原本就是 `return null`，
   * 配上写错的 URL，表现为"下拉凭空不出现、控制台也没动静"。
   * 保留静默是有意的（不能因为一个可选控件把输入框搞出红字），
   * 但正因如此，URL 与取值来源必须由上面那几条断言钉死 —— 静默失败没有第二次机会被发现。
   */
  const picker = mountPicker({
    companions: [{ id: 'lily', name: '莉莉' }],
    session: { sessionId: 's1', blank: true },
    fail: true,
  })
  try {
    picker.mount()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(picker.runtime.flush(), null, '请求失败时不该渲染出损坏的下拉')
  } finally {
    picker.restore()
  }
})

/* ─────────── 显形闸门：仅「伙伴模式」预设 ───────────
 * 用户要求：选伙伴模式的会话才显示伙伴下拉；其他预设（standard-gitbash 等）
 * **完全不显示**，编码会话与官方原样一致。
 * 读法照抄官方 AgentPresetLabel：useSessions → projectionValues.agentPreset。
 * ------------------------------------------------------------------ */

test('伙伴下拉：仅伙伴模式预设显形，其他预设一个像素都不占', async () => {
  // null = 投影里没有 agentPreset（blank 新会话 / 旧版本），同样不得显形
  for (const presetId of ['standard-gitbash', 'standard', 'code-gitbash', null]) {
    const picker = mountPicker({
      companions: [{ id: 'lily', name: '莉莉' }],
      session: { sessionId: 's1', blank: true },
      presetId,
    })
    try {
      picker.mount()
      await new Promise((resolve) => setImmediate(resolve))
      const tree = picker.runtime.flush()
      assert.equal(tree, null, `预设=${String(presetId)} 时不得渲染任何内容`)
      assert.equal(picker.calls.length, 0, `预设=${String(presetId)} 时不得发请求`)
    } finally {
      picker.restore()
    }
  }
})

test('伙伴下拉：伙伴模式预设下照常显形（闸门不误伤自己）', async () => {
  const picker = mountPicker({
    companions: [{ id: 'lily', name: '莉莉' }],
    session: { sessionId: 's1', blank: true },
    presetId: 'companion-mode',
  })
  try {
    picker.mount()
    await new Promise((resolve) => setImmediate(resolve))
    const tree = picker.runtime.flush()
    const button = findAll(tree, (n) => n.type === 'button' && n.props.className === 'cmd-chip')[0]
    assert.ok(button, '伙伴模式会话应渲染下拉')
    assert.equal(picker.calls.length, 1, '应恰好发一次列表请求')
  } finally {
    picker.restore()
  }
})
