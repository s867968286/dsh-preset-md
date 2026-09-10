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
  FILE_WEIGHTS,
  PLACEHOLDERS,
  PROMPT_SECTION,
  PROMPT_VARIABLE,
  applyToolRestriction,
  contextBudgetNotice,
  contextFacts,
  createSessionFreeze,
  estimateTokens,
  expandHome,
  matchToolName,
  measureContext,
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
  assert.deepEqual(PLACEHOLDERS, ['cwd', 'preset', 'presetDir', 'session'])
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
  assert.deepEqual(facts, { cwd: 'D:/ws', preset: 'demo', presetDir: '', session: 's1' })
  assert.deepEqual(contextFacts(undefined), { cwd: '', preset: '', presetDir: '', session: '' })
  assert.equal(substitutePlaceholders('目录 {{cwd}}', facts), '目录 D:/ws')
  assert.equal(substitutePlaceholders('{{ preset }}', facts), 'demo')
  assert.equal(substitutePlaceholders('{{unknown}}', facts), '{{unknown}}')
  assert.equal(substitutePlaceholders('{{cwd}}', { cwd: '' }), '{{cwd}}')
})

test('contextFacts / substitutePlaceholders：presetDir 独立于 preset', () => {
  const facts = contextFacts(
    { agent: { session: { id: 's1', header: { cwd: 'D:/ws', agentPreset: 'agent-1bd5' } } } },
    'C:/Users/x/.dsh/.agent-presets/agent-1bd5',
  )
  assert.equal(facts.preset, 'agent-1bd5', 'preset 仍是 id，不是路径')
  assert.equal(facts.presetDir, 'C:/Users/x/.dsh/.agent-presets/agent-1bd5')

  assert.equal(
    substitutePlaceholders('预设目录（{{presetDir}}），id={{preset}}', facts),
    '预设目录（C:/Users/x/.dsh/.agent-presets/agent-1bd5），id=agent-1bd5',
  )
  // presetDir 排在前：不会被 preset 抢先匹配掉
  assert.equal(substitutePlaceholders('{{presetDir}}', { preset: 'id', presetDir: 'D:/p' }), 'D:/p')
  // 取不到值 → 原样保留
  assert.equal(substitutePlaceholders('{{presetDir}}', { presetDir: '' }), '{{presetDir}}')
  assert.equal(substitutePlaceholders('{{presetDir}}', {}), '{{presetDir}}')
  assert.equal(substitutePlaceholders('{{ presetDir }}', { presetDir: 'D:/p' }), 'D:/p')
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

test('registerPrompt：{{presetDir}} 注入为预设目录绝对路径，与 {{cwd}} 相互独立', () => {
  const dir = makePresetDir({ 'SYSTEM.md': '工作目录：{{cwd}}\n预设目录：{{presetDir}}' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, {})
  const read = ctx.variables.get(PROMPT_VARIABLE)
  const session = (cwd) => ({ agent: { session: { id: 's1', header: { cwd } } } })

  assert.equal(read(session('D:/ws')), `工作目录：D:/ws\n预设目录：${dir}`)
  const other = read(session('D:/other'))
  assert.ok(other.includes(`预设目录：${dir}`), 'presetDir 不随 cwd 变化')
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：模板里未出现的占位符不影响输出', () => {
  const dir = makePresetDir({ 'AGENTS.md': '这个预设目录（{{presetDir}}）就是你的家' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, {})
  assert.equal(ctx.variables.get(PROMPT_VARIABLE)(asSession('s1')), `这个预设目录（${dir}）就是你的家`)
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：取不到会话 id 时按 cwd 分桶，不共用同一份缓存', () => {
  const dir = makePresetDir({ 'SYSTEM.md': '工作目录：{{cwd}}' })
  const ctx = makeCtx(pathToFileURL(dir).href)
  const prompt = registerPrompt(ctx, {})
  const read = ctx.variables.get(PROMPT_VARIABLE)

  // 没有 session.id / agent.id 的上下文
  const noId = (cwd) => ({ session: { header: { cwd } } })
  assert.equal(read(noId('D:/ws-a')), '工作目录：D:/ws-a')
  assert.equal(read(noId('D:/ws-b')), '工作目录：D:/ws-b', '不同 cwd 不能被第一份缓存污染')
  assert.equal(read(noId('D:/ws-a')), '工作目录：D:/ws-a', '同 cwd 仍然命中缓存')

  // 两个不同的缓存键（而不是共用一个常量键）
  const keyA = prompt.cacheKeyOf(noId('D:/ws-a'))
  const keyB = prompt.cacheKeyOf(noId('D:/ws-b'))
  assert.notEqual(keyA, keyB)
  assert.equal(prompt.cache.size, 2)
  assert.equal(prompt.cacheKeyOf(noId('D:/ws-a')), keyA, '同一 cwd 的键要稳定')

  // 有会话 id 时仍然按 id 分桶
  assert.equal(prompt.cacheKeyOf(asSession('s9')), 's9')
  rmSync(dir, { recursive: true, force: true })
})

test('estimateTokens：按 DeepSeek 口径估算（1 汉字 ≈ 0.6 token）', () => {
  assert.equal(estimateTokens(''), 0)
  // 10 个汉字 ≈ 6 token
  assert.equal(estimateTokens('一二三四五六七八九十'), 6)
  // ASCII 权重明显低于汉字
  assert.ok(estimateTokens('a'.repeat(100)) < estimateTokens('一'.repeat(100)))
})

test('measureContext：按比例瓜分整体预算，只在总量超限时报 over', () => {
  const dir = makePresetDir({
    'SYSTEM.md': '一'.repeat(100),
    'MEMORY.md': '二'.repeat(500),
  })
  const measure = measureContext(dir, { budgetChars: 1000 })
  assert.equal(measure.totalChars, 600)
  assert.equal(measure.over, false, '总量没超预算就不该报 over')
  assert.equal(measure.budgetChars, 1000)

  // 各文件占比之和为 1
  const shareSum = measure.files.reduce((n, row) => n + row.share, 0)
  assert.ok(Math.abs(shareSum - 1) < 1e-9, '占比之和应为 1')

  // 权重表合计为 1
  const weightSum = Object.values(FILE_WEIGHTS).reduce((n, w) => n + w, 0)
  assert.ok(Math.abs(weightSum - 1) < 1e-9, '权重合计应为 1')

  rmSync(dir, { recursive: true, force: true })
})

test('measureContext：单文件偏大但总量没超 → over 为假、不提示', () => {
  // MEMORY.md 占 90%，远超它的 25% 份额，但总量仍低于预算
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(900), 'SOUL.md': '二'.repeat(100) })
  const measure = measureContext(dir, { budgetChars: 2000 })
  assert.equal(measure.over, false)
  assert.equal(contextBudgetNotice(measure), '', '总量没超就不该产出提醒')
  rmSync(dir, { recursive: true, force: true })
})

test('contextBudgetNotice：总量超限才产出提醒，并点名偏重文件', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(2000), 'SOUL.md': '二'.repeat(100) })
  const measure = measureContext(dir, { budgetChars: 1000 })
  assert.equal(measure.over, true)
  const notice = contextBudgetNotice(measure)
  assert.ok(notice.includes('上下文预算提醒'))
  assert.ok(notice.includes('MEMORY.md'), '应点名偏重的文件')
  assert.ok(notice.includes('收敛'))
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：总量超预算时把收敛提醒附在提示词末尾', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(3000) })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, { budgetChars: 1000 })
  const text = ctx.variables.get(PROMPT_VARIABLE)(asSession('s1'))
  assert.ok(text.includes('## 上下文预算提醒'))
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：总量没超预算时提示词里没有提醒', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(100) })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, { budgetChars: 1000 })
  const text = ctx.variables.get(PROMPT_VARIABLE)(asSession('s1'))
  assert.ok(!text.includes('上下文预算提醒'))
  rmSync(dir, { recursive: true, force: true })
})

test('registerPrompt：超限提醒可单独关掉（只度量不注入）', () => {
  const dir = makePresetDir({ 'MEMORY.md': '一'.repeat(3000) })
  const ctx = makeCtx(pathToFileURL(dir).href)
  registerPrompt(ctx, { budgetChars: 1000, budgetNotice: false })
  const text = ctx.variables.get(PROMPT_VARIABLE)(asSession('s1'))
  assert.ok(!text.includes('上下文预算提醒'), '关掉后不该注入提醒')
  assert.ok(text.includes('一'), '正文照常注入')
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
