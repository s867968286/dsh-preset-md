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
    "return { apply, inject: ['slots'], name: 'preset-md-client', __test: { Dialog, CSS } }",
  )
  assert.notEqual(probe, SOURCE, '未能在 client.js 里定位 return 语句，测试探针需要同步更新')
  let registration = null
  const window = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
  const document = { querySelector: () => null, createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} } }
  new Function('require', 'window', 'document', 'globalThis', probe)((s) => (s === 'react' ? React : (() => { throw new Error(s) })()), window, document, globalThis)
  return registration.factory((s) => (s === 'react' ? React : (() => { throw new Error(s) })())).__test
}

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
