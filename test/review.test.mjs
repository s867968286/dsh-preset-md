/**
 * 检索与回顾单测：日志检索（日期=文件名、关键词=全文）与回顾流程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendJournal, changelogPath, journalPath } from '../src/memory-store.mjs'
import { INDEX_CLIP_CHARS, SEARCH_TOOL_NAME, clip, createSearchTool, searchJournal } from '../src/search.mjs'
import { buildReviewInput, buildTranscript, callText, parseReviewJson, REVIEW_SYSTEM_PROMPT, runReview } from '../src/review.mjs'

const makeDir = () => mkdtempSync(join(tmpdir(), 'preset-md-search-'))

/**
 * 假 ctx：模型服务只能通过 `ctx.get('llm')` 取。
 *
 * 真实环境里 `ctx.llm` 属性访问会撞上 preset 的 isolate 边界并抛
 * `cannot get property "llm" without inject`；假 ctx 若只挂一个 llm 属性，
 * 就会把这条真实约束彻底掩盖（单测绿、线上炸）。
 */
const llmCtx = (stream) => ({ get: (name) => (name === 'llm' ? { stream } : undefined) })

/* ───────────────────────────── 检索 ───────────────────────────── */

test('searchJournal：没有日志时给出提示', () => {
  const dir = makeDir()
  assert.match(searchJournal(dir, '任意', 7), /没有内容/)
  rmSync(dir, { recursive: true, force: true })
})

test('searchJournal：无 query 返回索引（日期 + 段落标题 + 摘要行）', async () => {
  const dir = makeDir()
  // 按约定正文以「> 摘要」开头：索引应取摘要行，跳过 ### 小标题
  await appendJournal(
    dir,
    '> 摘要：聊了插件设计\n\n### 讨论与解决\n\n细节过程\n\n### 关键信息\n\n结论 B',
    new Date(2026, 8, 9, 10, 0),
  )
  const text = searchJournal(dir, '', 3)
  assert.ok(text.includes('# 2026-09-09'))
  assert.ok(text.includes('## 10:00'))
  assert.ok(text.includes('> 摘要：聊了插件设计'))
  assert.ok(!text.includes('细节过程'), '索引只露首行，不透出正文')
  assert.ok(!text.includes('结论 B'), '三段正文不进索引')
  rmSync(dir, { recursive: true, force: true })
})

test('searchJournal：无摘要的旧格式日志回退取首个非标题行', async () => {
  const dir = makeDir()
  await appendJournal(dir, '### 讨论与解决\n\n聊了插件设计', new Date(2026, 8, 9, 10, 0))
  const text = searchJournal(dir, '', 3)
  assert.ok(text.includes('聊了插件设计'))
  rmSync(dir, { recursive: true, force: true })
})

test('searchJournal：索引行超长截断补省略号', () => {
  assert.equal(clip('短行'), '短行')
  const long = '长'.repeat(100)
  const clipped = clip(long)
  assert.equal(clipped.length, INDEX_CLIP_CHARS + 1)
  assert.ok(clipped.endsWith('…'), '截断必须带省略号')
})

test('REVIEW_SYSTEM_PROMPT：段落可省、寒暄与测试不记、当天已有日志仍要写', () => {
  const prompt = REVIEW_SYSTEM_PROMPT
  assert.ok(prompt.includes('> 摘要：'), '要给出摘要行格式示例')
  assert.ok(prompt.includes('50'), '摘要要有长度约束')
  // 摘要与各段落都允许为空：判据是「有没有值得留存的新内容」，不是「格式填满」
  assert.ok(prompt.includes('省略它'), '摘要允许省略')
  assert.ok(prompt.includes('不要求写满'), '段落不要求写满')
  // 不需要记录的情形（判据的核心）
  assert.ok(prompt.includes('不要记录'))
  for (const scene of ['无意义寒暄', '简单问题', '测试性对话', '操作确认', '重复内容']) {
    assert.ok(prompt.includes(scene), `排除清单应包含：${scene}`)
  }
  // 与「当天已有日志」的措辞配套：不重复旧的，但新内容照写
  assert.ok(prompt.includes('不要因为它们存在就留空'))
})

test('searchJournal：关键词命中返回 日期:行号 + 上下文', async () => {
  const dir = makeDir()
  await appendJournal(dir, '### 关键信息\n\n结论：用 memory 目录', new Date(2026, 8, 9, 10, 0))
  const hit = searchJournal(dir, 'memory', 3)
  assert.match(hit, /2026-09-09:\d+/)
  assert.ok(hit.includes('结论：用 memory 目录'))
  assert.match(searchJournal(dir, '不存在的词', 3), /没有匹配/)
  rmSync(dir, { recursive: true, force: true })
})

test('searchJournal：days 是「日志文件个数」上限，不是自然日', async () => {
  const dir = makeDir()
  // 五个日志彼此相隔 10 天：按自然日回退 days=3 一个都捞不到；按文件个数应返回最新 3 个
  for (const day of [1, 11, 21, 31, 41]) {
    await appendJournal(dir, `### 讨论与解决\n\n第 ${day} 天`, new Date(Date.now() - day * 86400000))
  }
  const three = searchJournal(dir, '', 3)
  assert.ok(three.includes('第 1 天'))
  assert.ok(three.includes('第 11 天'))
  assert.ok(three.includes('第 21 天'))
  assert.ok(!three.includes('第 31 天'), '超出个数上限的不返回')

  assert.ok(searchJournal(dir, '', 30).includes('第 41 天'), '上限够大时最早的一条也能返回')
  rmSync(dir, { recursive: true, force: true })
})

test('createSearchTool：工具名带 preset_md_ 前缀，execute 返回文本', async () => {
  const dir = makeDir()
  await appendJournal(dir, '### 讨论与解决\n\nhello world', new Date())
  const tool = createSearchTool(dir)
  assert.equal(tool.name, SEARCH_TOOL_NAME)
  assert.equal(tool.name.startsWith('preset_md_'), true)
  // parameters 必须是标准 JSON Schema 形态（扁平 DSL 会让 provider 400，见 search.mjs 注释）
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['days', 'query'])
  const result = await tool.execute({ query: 'hello', days: 3 })
  assert.ok(result.text.includes('hello world'))
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: result.text }])
  rmSync(dir, { recursive: true, force: true })
})

/* ───────────────────────────── 回顾 ───────────────────────────── */

test('buildTranscript：只取 user/assistant 文本并截断尾部', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } },
    { type: 'tool/result', data: {} },
  ]
  assert.equal(buildTranscript(events), '用户：你好\n\n助手：在的')
  const long = buildTranscript([{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }] } }], 10)
  assert.equal(long.length, 10)
})

test('runReview：转写窗口跟随触发阈值，不丢两次回顾之间的内容', async () => {
  const dir = makeDir()
  // 造一段比默认 8000 更长的转写，开头放一个标志词
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: `开头标志 ${'x'.repeat(9000)}` }] } },
  ]
  let seenPrompt = ''
  const ctx = {
    get: (name) => (name === 'llm' ? {
      stream: (options) => {
        seenPrompt = options.messages[0].content[0].text
        return (async function* () {
          yield { type: 'text-delta', text: '{"journal":"j","updates":[]}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } : undefined),
  }

  // 默认窗口 8000：开头的标志词会被截掉
  await runReview({ ctx, dir, session: { events }, provider: 'p', model: 'm' })
  assert.ok(!seenPrompt.includes('开头标志'), '默认窗口下应被尾部截断')

  // 窗口放大到 16000：标志词应被带进来
  await runReview({ ctx, dir, session: { events }, provider: 'p', model: 'm', transcriptChars: 16000 })
  assert.ok(seenPrompt.includes('开头标志'), '窗口放大后不该再丢内容')
  rmSync(dir, { recursive: true, force: true })
})

test('parseReviewJson：容错解析，缺字段回落空', () => {
  assert.deepEqual(parseReviewJson('不是 JSON'), { journal: '', updates: [], raw: '不是 JSON' })
  const parsed = parseReviewJson('```json\n{"journal":"j","updates":[{"file":"MEMORY.md"}]}\n```')
  assert.equal(parsed.journal, 'j')
  assert.equal(parsed.updates.length, 1)
  assert.deepEqual(parseReviewJson('{"updates":"bad"}').updates, [])
})

test('parseReviewJson：字符串内的裸换行被修复，不再整轮丢弃', () => {
  // 模型写多段散文时几乎必然这么输出
  const raw = '{"journal":"### 讨论与解决\n\n聊了 A\n\n### 关键信息\n\n结论 B","updates":[]}'
  const parsed = parseReviewJson(raw)
  assert.equal(parsed.raw, '', '应解析成功，不该走 raw 回落')
  assert.ok(parsed.journal.includes('聊了 A'))
  assert.ok(parsed.journal.includes('结论 B'))

  // 裸制表符同理
  const tab = parseReviewJson('{"journal":"a\tb","updates":[]}')
  assert.equal(tab.journal, 'a\tb')
})

test('parseReviewJson：带说明前缀 / 尾随花括号也能抠出来', () => {
  const parsed = parseReviewJson('好的，结果如下：{"journal":"j","updates":[]} 说明：见 {}')
  assert.equal(parsed.journal, 'j')

  const fenced = parseReviewJson('```\n{"journal":"j2","updates":[]}\n```')
  assert.equal(fenced.journal, 'j2')
})

test('parseReviewJson：彻底解析不了时带回原文片段（不静默）', () => {
  const parsed = parseReviewJson('{"journal": "x", "updates": [}')
  assert.equal(parsed.journal, '')
  assert.ok(parsed.raw.length > 0, '必须带回原文片段供调用方告警')
})

test('buildReviewInput：当天已有日志时必须说清「别重复旧的、但本轮照常新增」', () => {
  // 这条锁的是一个真实事故：早先只写「今天的日志（已存在，不要重复写）」，
  // 模型读成「今天已经记过了，不用再写」，当天已有日志的轮次全部返回空 journal，
  // 日记就此断掉（20:14 那轮「无改动」就是它）。
  const text = buildReviewInput({ transcript: 't', todayJournal: '## 09:00\n旧段落', files: [] })
  assert.ok(text.includes('今天的日志'))
  assert.ok(text.includes('不要重复'), '要说明别重复旧内容')
  assert.ok(text.includes('照常再写一个新段落'), '必须同时说明本轮照常新增，否则模型会整轮留空')
})

test('runReview：模型没产出日志段落时打上 journalEmpty 标记', async () => {
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }]
  const ctx = llmCtx(() => (async function* () {
    yield { type: 'text-delta', text: '{"journal":"","updates":[]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  const result = await runReview({ ctx, dir, session: { events }, provider: 'p', model: 'm', now: new Date(2026, 8, 9, 10, 0) })
  assert.equal(result.journalEmpty, true, '调用方要能区分「模型没写日志」和「记忆无改动」')
  assert.equal(result.applied.length, 0)
  assert.ok(!existsSync(journalPath(dir, '2026-09-09')))
  rmSync(dir, { recursive: true, force: true })
})

test('buildReviewInput：包含对话、今日日志与各文件原文', () => {
  const text = buildReviewInput({
    transcript: '用户：hi',
    todayJournal: '## 09:00',
    files: [{ file: 'MEMORY.md', text: '- 旧' }, { file: 'SOUL.md', text: '' }],
  })
  assert.ok(text.includes('# 本轮对话'))
  assert.ok(text.includes('用户：hi'))
  assert.ok(text.includes('# 今天的日志'))
  assert.ok(text.includes('# 文件 MEMORY.md'))
  assert.ok(text.includes('（空文件）'))
})

test('callText：拼接 text-delta，finish=error 抛错', async () => {
  const chunks = [
    { type: 'text-delta', text: '{"journal"' },
    { type: 'text-delta', text: ':"x"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const ctx = llmCtx(() => (async function* () { yield* chunks })())
  assert.equal(await callText(ctx, { provider: 'p', model: 'm', system: 's', prompt: 'u' }), '{"journal":"x"}')

  const bad = llmCtx(() => (async function* () { yield { type: 'finish', reason: { kind: 'error' } } })())
  await assert.rejects(() => callText(bad, { provider: 'p', model: 'm', system: 's', prompt: 'u' }), /未正常完成/)
})

test('callText：把超时 signal 传给 provider（挂住时能自己退出）', async () => {
  let seen = null
  const ctx = {
    get: (name) => (name === 'llm' ? {
      stream: (options) => {
        seen = options.signal
        return (async function* () {
          yield { type: 'text-delta', text: 'x' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } : undefined),
  }
  await callText(ctx, { provider: 'p', model: 'm', system: 's', prompt: 'u', timeoutMs: 50 })
  assert.ok(seen instanceof AbortSignal, 'provider 应收到 AbortSignal')

  // 流不结束 → 超时后 abort 生效，调用方拿到 rejected 而不是永久挂起
  const hanging = {
    get: (name) => (name === 'llm' ? {
      stream: (options) => (async function* () {
        await new Promise((resolve) => {
          if (options.signal.aborted) return resolve()
          options.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        // 已中止：抛错让 for await 终止，模拟真实 provider 的行为
        throw new Error('aborted')
      })(),
    } : undefined),
  }
  await assert.rejects(() => callText(hanging, { provider: 'p', model: 'm', system: 's', prompt: 'u', timeoutMs: 30 }))
})

test('callText：调用方 signal 也能中断', async () => {
  const controller = new AbortController()
  const ctx = {
    get: (name) => (name === 'llm' ? {
      stream: (options) => (async function* () {
        controller.abort()
        await new Promise((resolve) => {
          if (options.signal.aborted) return resolve()
          options.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('aborted')
      })(),
    } : undefined),
  }
  await assert.rejects(() => callText(ctx, { provider: 'p', model: 'm', system: 's', prompt: 'u', signal: controller.signal }))
})

test('callText：正常结束时会清掉超时定时器（不留悬挂句柄）', async () => {
  const ctx = {
    get: (name) => (name === 'llm' ? {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: 'done' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } : undefined),
  }
  // 给一个很长的超时：若定时器没被清理，进程会被它拖住
  assert.equal(await callText(ctx, { provider: 'p', model: 'm', system: 's', prompt: 'u', timeoutMs: 60_000 }), 'done')
})

test('runReview：写日志 + 应用 updates + 留痕；短对话跳过', async () => {
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: '讨论插件设计'.repeat(20) }] } }]
  const reply = JSON.stringify({
    journal: '### 讨论与解决\n\n聊了插件设计',
    updates: [
      { file: 'MEMORY.md', op: 'add', content: '- 结论：用 memory 目录' },
      { file: 'SYSTEM.md', op: 'add', content: '- 不该写进去' },
    ],
  })
  const ctx = {
    get: (name) => (name === 'llm' ? {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } : undefined),
  }

  const result = await runReview({ ctx, dir, session: { events }, provider: 'p', model: 'm', now: new Date(2026, 8, 9, 10, 0) })
  assert.equal(result.journal, true)
  assert.ok(readFileSync(journalPath(dir, '2026-09-09'), 'utf8').includes('聊了插件设计'))
  assert.ok(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('结论：用 memory 目录'))
  assert.ok(result.applied.some((line) => line.startsWith('SYSTEM.md:add 失败')))
  assert.ok(readFileSync(changelogPath(dir, 'MEMORY.md'), 'utf8').includes('- op: add'))

  const skipped = await runReview({ ctx, dir, session: { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }] }, provider: 'p', model: 'm' })
  assert.equal(skipped.skipped, 'turn_too_short')
  rmSync(dir, { recursive: true, force: true })
})

test('runReview：解析失败时通过 onWarn 报出，不再静默', async () => {
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }]
  const ctx = {
    get: (name) => (name === 'llm' ? {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: '抱歉，我无法输出 JSON' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } : undefined),
  }
  const warnings = []
  const result = await runReview({
    ctx,
    dir,
    session: { events },
    provider: 'p',
    model: 'm',
    now: new Date(2026, 8, 9, 10, 0),
    onWarn: (message) => warnings.push(message),
  })
  assert.equal(result.parseFailed !== undefined, true, '返回值应带上解析失败标记')
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('无法解析'))
  assert.ok(!existsSync(journalPath(dir, '2026-09-09')), '解析失败不写日志')
  rmSync(dir, { recursive: true, force: true })
})

test('runReview：中间一条 update 失败不影响后续 update', async () => {
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }] } }]
  const reply = JSON.stringify({
    journal: '### 讨论与解决\n\n聊了 A',
    updates: [
      // 第 2 条非法（白名单外），第 3 条合法 —— 关键是要被应用
      { file: 'MEMORY.md', op: 'add', content: '- 第一条' },
      { file: 'SYSTEM.md', op: 'add', content: '- 非法' },
      { file: 'USER.md', op: 'add', content: '- 第三条' },
    ],
  })
  const ctx = {
    get: (name) => (name === 'llm' ? {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    } : undefined),
  }
  const result = await runReview({ ctx, dir, session: { events }, provider: 'p', model: 'm', now: new Date(2026, 8, 9, 10, 0) })
  assert.ok(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('第一条'))
  assert.ok(readFileSync(join(dir, 'USER.md'), 'utf8').includes('第三条'), '失败项之后的 update 必须仍然生效')
  // journal + 3 条 update 各记一条
  assert.equal(result.applied.length, 4)
  assert.equal(result.applied[0], 'journal')
  assert.ok(result.applied[2].startsWith('SYSTEM.md:add 失败'))
  rmSync(dir, { recursive: true, force: true })
})
