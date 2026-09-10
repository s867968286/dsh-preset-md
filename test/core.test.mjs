/**
 * dsh-preset-md 核心逻辑单测（零依赖，node --test）。
 * 不需要 dsh 进程：用假 ctx 驱动 registerPrompt。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_FILES,
  PLACEHOLDERS,
  PROMPT_SECTION,
  PROMPT_VARIABLE,
  applyToolRestriction,
  contextFacts,
  createSessionFreeze,
  expandHome,
  matchToolName,
  normalizeConfig,
  normalizeToolFilter,
  readAggregateText,
  readSectionText,
  registerPrompt,
  resolvePresetDir,
  sessionKeyOf,
  substitutePlaceholders,
  toDirectoryPath,
} from '../src/core.js'

/** 建一个临时预设目录。 */
function makePresetDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preset-md-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8')
  return dir
}

/** 假 ctx：记录 section / variable 注册，effect 立即执行。 */
function makeCtx(baseUrl) {
  const sections = []
  const variables = new Map()
  return {
    baseUrl,
    sections,
    variables,
    effect(fn) {
      return fn()
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      variable(name, provider) {
        variables.set(name, provider)
        return () => {}
      },
    },
  }
}

const asSession = (id) => ({ agent: { id, session: { id } } })

test('expandHome：~ 与 ~/x 展开，其余原样', () => {
  assert.ok(expandHome('~').length > 1)
  assert.ok(expandHome('~/a/b').endsWith(join('a', 'b')))
  assert.equal(expandHome('C:/x'), 'C:/x')
})

test('toDirectoryPath：file URL 与绝对路径都能解析，相对路径返回空', () => {
  const dir = makePresetDir()
  assert.equal(toDirectoryPath(pathToFileURL(dir).href), dir)
  assert.equal(toDirectoryPath(dir), dir)
  assert.equal(toDirectoryPath('./rel'), '')
  assert.equal(toDirectoryPath(''), '')
  rmSync(dir, { recursive: true, force: true })
})

test('默认清单与占位符', () => {
  assert.deepEqual(DEFAULT_FILES, ['SYSTEM.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md'])
  assert.deepEqual(PLACEHOLDERS, ['cwd', 'preset', 'session'])
})

test('normalizeConfig：只认 tools，其余字段忽略', () => {
  const config = normalizeConfig({ dir: 'C:/x', files: ['a.md'], maxBytes: 10, tools: { deny: ['mnemon*'] } })
  assert.deepEqual(config, { tools: { allow: [], deny: ['mnemon*'] } })
  assert.deepEqual(normalizeConfig(undefined), { tools: { allow: [], deny: [] } })
})

test('normalizeToolFilter：去重、丢弃非字符串', () => {
  assert.deepEqual(normalizeToolFilter(undefined), { allow: [], deny: [] })
  assert.deepEqual(normalizeToolFilter({ allow: ['a', 'a', '', 3], deny: ['b'] }), { allow: ['a'], deny: ['b'] })
})

test('resolvePresetDir：只认 ctx.baseUrl', () => {
  const dir = makePresetDir()
  assert.equal(resolvePresetDir({ baseUrl: pathToFileURL(dir).href }), dir)
  assert.equal(resolvePresetDir({}), '')
  assert.equal(resolvePresetDir(undefined), '')
  rmSync(dir, { recursive: true, force: true })
})

test('readSectionText / readAggregateText：原样读取、按序拼接、跳过空', () => {
  const dir = makePresetDir({ 'SOUL.md': '  人格  \n', 'IDENTITY.md': '身份', 'USER.md': '   ' })
  assert.equal(readSectionText(join(dir, 'SOUL.md')), '人格')
  assert.equal(readSectionText(join(dir, 'USER.md')), '')
  assert.equal(readSectionText(join(dir, 'MISSING.md')), '')
  assert.equal(readSectionText(''), '')
  assert.equal(readAggregateText(dir), '人格\n\n身份')
  assert.equal(readAggregateText(''), '')
  rmSync(dir, { recursive: true, force: true })
})

test('sessionKeyOf：兼容 assemble context / agent / 空值', () => {
  assert.equal(sessionKeyOf({ agent: { id: 'a1', session: { id: 's1' } } }), 's1')
  assert.equal(sessionKeyOf({ id: 'a1', session: { id: 's1' } }), 's1')
  assert.equal(sessionKeyOf({ id: 'a1' }), 'a1')
  assert.equal(sessionKeyOf({}), '')
})

test('createSessionFreeze：只算一次、可清理', () => {
  const freeze = createSessionFreeze()
  let calls = 0
  const factory = () => `v${(calls += 1)}`
  assert.equal(freeze.get('s1', factory), 'v1')
  assert.equal(freeze.get('s1', factory), 'v1')
  assert.equal(freeze.get('s2', factory), 'v2')
  assert.equal(calls, 2)
  freeze.clear('s1')
  assert.equal(freeze.size, 1)
  freeze.clearAll()
  assert.equal(freeze.size, 0)
})

test('contextFacts / substitutePlaceholders', () => {
  const facts = contextFacts({ agent: { session: { id: 's1', header: { cwd: 'D:/ws', agentPreset: 'demo' } } } })
  assert.deepEqual(facts, { cwd: 'D:/ws', preset: 'demo', session: 's1' })
  assert.deepEqual(contextFacts(undefined), { cwd: '', preset: '', session: '' })
  assert.equal(substitutePlaceholders('目录 {{cwd}}', facts), '目录 D:/ws')
  assert.equal(substitutePlaceholders('{{ preset }}', facts), 'demo')
  assert.equal(substitutePlaceholders('{{unknown}}', facts), '{{unknown}}')
  assert.equal(substitutePlaceholders('{{cwd}}', { cwd: '' }), '{{cwd}}')
})

test('registerPrompt：变量承载内容 + 唯一 complete section', () => {
  const dir = makePresetDir({ 'SOUL.md': '人格文本', 'MEMORY.md': '记忆文本' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  const result = registerPrompt(ctx, { freeze: true, complete: true })

  assert.equal(result.dir, dir)
  assert.equal(result.complete, true)
  assert.deepEqual(ctx.sections, [{ name: PROMPT_SECTION, order: 0, text: `{{${PROMPT_VARIABLE}}}`, complete: true }])
  assert.equal(ctx.variables.get(PROMPT_VARIABLE)(asSession('s1')), '人格文本\n\n记忆文本')
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：complete=false 时不带 complete 字段', () => {
  const dir = makePresetDir({ 'SOUL.md': 'x' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, { complete: false })
  assert.equal('complete' in ctx.sections[0], false)
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：会话内冻结，新会话重读；freeze=false 每次重读', () => {
  const dir = makePresetDir({ 'SOUL.md': '第一版' })
  const frozenCtx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(frozenCtx, { freeze: true })
  const frozen = frozenCtx.variables.get(PROMPT_VARIABLE)
  assert.equal(frozen(asSession('s1')), '第一版')
  writeFileSync(join(dir, 'SOUL.md'), '第二版', 'utf8')
  assert.equal(frozen(asSession('s1')), '第一版')
  assert.equal(frozen(asSession('s2')), '第二版')

  const liveCtx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(liveCtx, { freeze: false })
  const live = liveCtx.variables.get(PROMPT_VARIABLE)
  assert.equal(live(asSession('s1')), '第二版')
  writeFileSync(join(dir, 'SOUL.md'), '第三版', 'utf8')
  assert.equal(live(asSession('s1')), '第三版')
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：占位符按会话替换并参与冻结；目录未知返回空串', () => {
  const dir = makePresetDir({ 'SYSTEM.md': 'cwd={{cwd}}' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, {})
  const read = ctx.variables.get(PROMPT_VARIABLE)
  const session = (cwd) => ({ agent: { session: { id: 's1', header: { cwd } } } })
  assert.equal(read(session('D:/ws')), 'cwd=D:/ws')
  assert.equal(read(session('D:/other')), 'cwd=D:/ws')

  const emptyCtx = makeCtx(undefined)
  const empty = registerPrompt(emptyCtx, {})
  assert.equal(empty.dir, '')
  assert.equal(emptyCtx.variables.get(PROMPT_VARIABLE)(asSession('s1')), '')
  rmSync(dir, { recursive: true, force: true })
})

test('matchToolName：前缀 aa* / 后缀 *bb / 包含 *cc* / 精确 ddd', () => {
  assert.equal(matchToolName('mnemon*', 'mnemon_recall'), true)
  assert.equal(matchToolName('mnemon*', 'read_page'), false)
  assert.equal(matchToolName('*_recall', 'mnemon_recall'), true)
  assert.equal(matchToolName('*nem*', 'mnemon_recall'), true)
  assert.equal(matchToolName('*xyz*', 'mnemon_recall'), false)
  assert.equal(matchToolName('mnemon_recall', 'mnemon_recall'), true)
  assert.equal(matchToolName('mnemon_recall', 'mnemon_remember'), false)
  assert.equal(matchToolName('mnemon*recall', 'mnemon_recall'), false)
  assert.equal(matchToolName('*', 'mnemon_recall'), false)
  assert.equal(matchToolName('', 'x'), false)
})

test('applyToolRestriction：展开成精确名单、未命中的单独报告', () => {
  const calls = []
  const ctx = {
    tools: {
      schemas: () => [{ name: 'mnemon_recall' }, { name: 'mnemon_remember' }, { name: 'read_page' }],
      restrict: (filter) => calls.push(filter),
    },
  }
  const result = applyToolRestriction(ctx, { allow: [], deny: ['mnemon*', 'nope*'] })
  assert.equal(result.applied, true)
  assert.deepEqual(calls, [{ deny: ['mnemon_recall', 'mnemon_remember'] }])
  assert.deepEqual(result.unmatched, ['nope*'])
})

test('applyToolRestriction：allow 与 deny 同时给；全不命中不下发；无可见工具不下发', () => {
  const calls = []
  const ctx = {
    tools: {
      schemas: () => [{ name: 'mnemon_recall' }, { name: 'read_page' }],
      restrict: (filter) => calls.push(filter),
    },
  }
  const result = applyToolRestriction(ctx, { allow: ['read_page'], deny: ['*_recall'] })
  assert.deepEqual(calls, [{ allow: ['read_page'], deny: ['mnemon_recall'] }])
  assert.deepEqual(result.unmatched, [])

  assert.equal(applyToolRestriction(ctx, { allow: ['nope'], deny: [] }).applied, false)
  assert.equal(calls.length, 1)

  const empty = applyToolRestriction({ tools: { schemas: () => [], restrict: () => {} } }, { allow: [], deny: ['a'] })
  assert.equal(empty.applied, false)
  assert.match(empty.reason, /没有可见工具/)
})

test('applyToolRestriction：restrict 抛错与 ctx.tools 缺失都降级', () => {
  const throwing = {
    tools: {
      schemas: () => [{ name: 'a' }],
      restrict: () => {
        throw new Error('scope 缺失')
      },
    },
  }
  const failed = applyToolRestriction(throwing, { allow: [], deny: ['a'] })
  assert.equal(failed.applied, false)
  assert.match(failed.reason, /scope 缺失/)

  const missing = applyToolRestriction({}, { allow: [], deny: ['a'] })
  assert.equal(missing.applied, false)
  assert.match(missing.reason, /不可用/)
})
