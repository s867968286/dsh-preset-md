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
import { buildReviewInput, buildTranscript, callText, isHumanMessage, parseReviewJson, REVIEW_SYSTEM_PROMPT, runReview, TRANSCRIPT_TRUNCATED_MARK } from '../src/review.mjs'

const makeDir = () => mkdtempSync(join(tmpdir(), 'companion-search-'))

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

test('buildTranscript：只取 user/assistant 文本，超长保留尾部并标记省略', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的' }] } } },
    { type: 'tool/result', data: {} },
  ]
  assert.equal(buildTranscript(events), '用户：你好\n\n助手：在的')

  // 超长：保留**尾部**（本轮结论比开头更值得总结），并显式标记前文被省略。
  // 静默 slice 会让人以为「这轮就这么点内容」，排查窗口截断时看不出来。
  const long = buildTranscript(
    [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(50) }], source: { kind: 'user' } } }],
    10,
  )
  assert.ok(long.startsWith(TRANSCRIPT_TRUNCATED_MARK), '超长必须带「前文略」标记')
  assert.ok(long.endsWith('x'.repeat(10)), '正文必须是尾部（保留最新的内容）')

  // 恰好不超限时不该加标记（避免每次回顾都带一条噪音）
  const fits = '用户：' + 'x'.repeat(10)
  const exact = buildTranscript(
    [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(10) }], source: { kind: 'user' } } }],
    fits.length,
  )
  assert.equal(exact, fits)
  assert.ok(!exact.includes(TRANSCRIPT_TRUNCATED_MARK))
})

test('buildTranscript / isHumanMessage：只有 source.kind=user 才算真人发言（回归）', () => {
  /*
   * 这条锁的是「注入消息被当真人发言」这个缺陷。
   *
   * 夹具必须带**真实来源**：`user/message` 不区分来源，真人发言、官方运行时快照、
   * 其他插件注入、技能目录全部以它落盘。官方 `MessageSourceMap` 是 merge-extensible，
   * 非真人来源除 `plugin` 外还有 `skill-catalog` / `agent-instructions` /
   * `subagent-settled` / `agent-message` 等多种独立 kind（真实会话里都出现过），
   * 所以必须白名单匹配 `=== 'user'`，不能「排除 plugin」。
   */
  const snapshot = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
  const events = [
    // 官方运行时快照：也是 user/message，但来源是插件
    { type: 'user/message', data: {
      content: [{ type: 'text', text: snapshot }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
    } },
    // 其余几种非 plugin 的非真人来源（都是独立 kind）
    { type: 'user/message', data: { content: [{ type: 'text', text: '技能目录内容' }], source: { kind: 'skill-catalog', form: 'catalog' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '工作区指令' }], source: { kind: 'agent-instructions', form: 'instructions' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '子代理完成通知' }], source: { kind: 'subagent-settled', form: 'notice' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '另一个代理的消息' }], source: { kind: 'agent-message', form: 'relay' } } },
    // 真人发言
    { type: 'user/message', data: { content: [{ type: 'text', text: '真实发言' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
  ]

  const text = buildTranscript(events)

  assert.ok(text.includes('真实发言'), '真人发言必须进转写')
  assert.ok(!text.includes(snapshot), '官方运行时快照不该进转写（否则会自我喂养）')
  assert.ok(!text.includes('技能目录内容'), 'skill-catalog 不该进转写')
  assert.ok(!text.includes('工作区指令'), 'agent-instructions 不该进转写')
  assert.ok(!text.includes('子代理完成通知'), 'subagent-settled 不该进转写')
  assert.ok(!text.includes('另一个代理的消息'), 'agent-message 不该进转写')
  assert.ok(text.includes('好的'), '助手发言照常进转写')

  // 判定函数本身：三种非真人 kind 都不能算真人
  assert.equal(isHumanMessage({ type: 'user/message', data: { source: { kind: 'user' } } }), true)
  assert.equal(isHumanMessage({ type: 'user/message', data: { source: { kind: 'plugin' } } }), false)
  assert.equal(isHumanMessage({ type: 'user/message', data: { source: { kind: 'skill-catalog' } } }), false)
  assert.equal(isHumanMessage({ type: 'user/message', data: {} }), false, '缺 source 不能当真人（官方契约里 source 必填）')
  assert.equal(isHumanMessage({ type: 'assistant/message', data: { source: { kind: 'user' } } }), false)
})

test('回归：本插件写出的 source 必须通过官方 V4 准入（kind:plugin 已被退役）', async () => {
  /*
   * 锁的是 dsh 0.1.7-rc.2 的破坏性变更：会话格式 v4 的 `MessageSourceMap` 里
   * **不再有** `plugin` 兜底 kind，官方注释明写
   * 「there is no shared catch-all `plugin` kind」。
   *
   * 于是新事件带 `{ kind: 'plugin', plugin: 'dsh-companion' }` 会被门禁硬拒：
   *   `assertV4MessageSources` / `assertV4RowAdmission`（dsh-session-format-v3-to-v4）
   *   -> `SessionFormatError: format v4 message requires a producer-owned source kind`
   *
   * 断言**直接调用官方真包**的准入函数，而不是复刻一份判据——复刻出来的判据
   * 只能证明「我按自己的理解写对了」，证不了官方接受它（这正是此前 185 条
   * 全绿、却漏掉这个变更的原因：夹具自己造 source，从不校验插件写出的那条）。
   */
  const admission = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
  const assertV4RowAdmission = admission.assertV4RowAdmission ?? admission.default?.assertV4RowAdmission
  assert.equal(typeof assertV4RowAdmission, 'function', '官方准入函数必须可用（真包，不是桩）')

  const rowFor = (source) => ({
    type: 'user/message',
    seq: 1,
    data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'x' }], source },
  })

  // 先证明这条门禁本身是活的：退役写法必须被拒。
  // 没有这一步，下面「新写法通过」可能只是因为函数根本没校验。
  assert.throws(
    () => assertV4RowAdmission(rowFor({ kind: 'plugin', plugin: 'dsh-companion' }), new Set(['user/message'])),
    /producer-owned source kind/,
    '退役的 kind:plugin 必须被官方拒绝（否则这条回归锁是空转的）',
  )

  // 插件真实写出的那个 source：回顾调用里交给 llm.stream 的 user 消息
  let sent = null
  const captureCtx = {
    get: (name) => (name === 'llm'
      ? { stream: (options) => { sent = options; return (async function* () {})() } }
      : undefined),
  }
  await callText(captureCtx, { provider: 'p', model: 'm', system: 's', prompt: 'p' })

  const message = sent?.messages?.[0]
  assert.ok(message, 'callText 必须把消息交给 llm.stream')
  assert.notEqual(message.source?.kind, 'plugin', '不能再写退役的 kind:plugin')
  assert.doesNotThrow(
    () => assertV4RowAdmission({ type: 'user/message', seq: 1, data: message }, new Set(['user/message'])),
    `插件写出的 source 必须过官方 V4 准入，实际是 ${JSON.stringify(message.source)}`,
  )
})

test('runReview：注入消息不计入触发阈值（只算真人与助手）', async () => {
  /*
   * 阈值必须只由真人发言 + 助手回复撑起。否则注入文本会撑大 grown，
   * 让回顾在真人几乎没说话时就被触发——真实数据里某个工作区的会话
   * user/message 字符有 96% 来自注入而非真人。
   */
  const dir = makeDir()
  const events = [
    // 一大段注入，真人几乎没说话：合计远超 minChars，但不该算进「新增」
    { type: 'user/message', data: {
      content: [{ type: 'text', text: 'x'.repeat(5000) }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
    } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '短' }], source: { kind: 'user' } } },
  ]
  let seenPrompt = ''
  const ctx = llmCtx(() => (async function* () {
    yield { type: 'text-delta', text: '{"journal":"","updates":[]}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())

  const result = await runReview({ ctx, dir, session: { events }, provider: 'p', model: 'm' })
  // 只算真人那 1 个字 → 低于 minChars(80) → 跳过，而不是被 5000 字注入骗过门槛
  assert.equal(result.skipped, 'turn_too_short', '注入文本不该把转写撑过最低门槛')

  rmSync(dir, { recursive: true, force: true })
})

test('runReview：转写窗口跟随触发阈值，不丢两次回顾之间的内容', async () => {
  const dir = makeDir()
  // 造一段比默认 8000 更长的转写，开头放一个标志词
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: `开头标志 ${'x'.repeat(9000)}` }], source: { kind: 'user' } } },
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
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
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

test('runReview：截断（max-tokens）时在告警里点明根因与输出长度', async () => {
  /*
   * 这是本次修的核心观测能力：解析失败的原因必须**可判定**。
   * 「被硬截断」与「模型写了非 JSON 的散文」是两种不同故障，
   * 处理方式也不同（前者该提上限/精简表达，后者该改 prompt），
   * 而原来的日志只给一段自带 500 字符截断的原文，判不出来。
   */
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
  const warns = []
  const ctx = llmCtx(() => (async function* () {
    // 缺尾的 JSON —— 正是被硬截断的样子
    yield { type: 'text-delta', text: '{"journal":"> 摘要：写了很长很长的一段，然后被切断了' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })())

  const result = await runReview({
    ctx, dir, session: { events }, provider: 'p', model: 'm',
    onWarn: (m) => warns.push(m),
  })

  assert.equal(result.truncated, true, '必须标记为截断')
  assert.equal(result.finish, 'max-tokens', 'finish 原因要能取到')
  const text = warns.join('\n')
  assert.ok(text.includes('max-tokens'), '告警必须点明 finish=max-tokens')
  assert.ok(text.includes('截断'), '告警要说明是被截断')
  assert.ok(/输出 \d+ 字符/.test(text), '要带输出长度，便于和上限对比')
  rmSync(dir, { recursive: true, force: true })
})

test('runReview：非截断的解析失败不该误报成截断', async () => {
  // 反证：模型写了散文（finish=stop）时，告警里不能出现「截断」——
  // 否则观测数据本身就是脏的，会把人往「提上限」的错误方向带。
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
  const warns = []
  const ctx = llmCtx(() => (async function* () {
    yield { type: 'text-delta', text: '好的，这一轮没什么值得记的。' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())

  const result = await runReview({
    ctx, dir, session: { events }, provider: 'p', model: 'm',
    onWarn: (m) => warns.push(m),
  })

  assert.equal(result.truncated, false)
  assert.equal(result.finish, 'stop')
  const text = warns.join('\n')
  assert.ok(!text.includes('截断'), `非截断不该说成截断：${text}`)
  assert.ok(text.includes('finish=stop'), '仍要报出 finish 便于排查')
  rmSync(dir, { recursive: true, force: true })
})

test('runReview：截断但 JSON 恰好解析成功时也要留痕', async () => {
  /*
   * 危险场景：journal 写完、updates 被截掉，JSON 恰好仍是完整对象。
   * 此时「解析成功」会让人以为一切正常，实际记忆更新丢了。
   */
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
  const warns = []
  const ctx = llmCtx(() => (async function* () {
    // 合法 JSON，但模型是在撞上限前刚好收尾
    yield { type: 'text-delta', text: '{"journal":"### 讨论与解决\\n\\n只有日志","updates":[]}' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })())

  const result = await runReview({
    ctx, dir, session: { events }, provider: 'p', model: 'm',
    onWarn: (m) => warns.push(m),
  })

  assert.equal(result.parseFailed, undefined, '这次确实解析成功了')
  assert.equal(result.truncated, true, '但仍要标记截断')
  assert.ok(warns.join('\n').includes('不完整'), '解析成功也要留痕：内容可能不完整')
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

test('callText：onFinish 报出 finish 原因（max-tokens 是可判定的截断信号）', async () => {
  /*
   * 为什么需要它：`onWarn` 报出的原文片段自带 500 字符截断，光看日志无法判断
   * 解析失败是不是「输出撞上限被硬截断」。把 finish.kind 交出来，根因才可判定。
   *
   * 官方 FinishReasonMap（@deepseek-ai/dsh-llm/lib/types/types.d.ts）：
   * stop / tool-calls / max-tokens / aborted / error —— max-tokens 即被截断。
   */
  const run = async (kind) => {
    let seen = null
    const ctx = llmCtx(() => (async function* () {
      yield { type: 'text-delta', text: '{"journal":"半截' }
      yield { type: 'finish', reason: { kind } }
    })())
    const text = await callText(ctx, {
      provider: 'p', model: 'm', system: 's', prompt: 'u',
      onFinish: (finish) => { seen = finish },
    })
    return { seen, text }
  }

  const stop = await run('stop')
  assert.equal(stop.seen?.kind, 'stop', 'stop 要照常报出')
  assert.equal(stop.text, '{"journal":"半截"'.slice(0, -1), '截断的文本照样返回（交给调用方决定）')

  // 关键：max-tokens 不抛错，但必须报出来（此时文本是缺尾的）
  const cut = await run('max-tokens')
  assert.equal(cut.seen?.kind, 'max-tokens', 'max-tokens 必须报出（这是可判定的截断信号）')
  assert.ok(cut.text.startsWith('{"journal"'), '截断的输出仍要返回，不能丢')

  // 没传 onFinish 时不能因为回调缺失而炸
  const bare = llmCtx(() => (async function* () {
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })())
  await assert.doesNotReject(() => callText(bare, { provider: 'p', model: 'm', system: 's', prompt: 'u' }))
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
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: '讨论插件设计'.repeat(20) }], source: { kind: 'user' } } }]
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

  const skipped = await runReview({ ctx, dir, session: { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }] }, provider: 'p', model: 'm' })
  assert.equal(skipped.skipped, 'turn_too_short')
  rmSync(dir, { recursive: true, force: true })
})

test('runReview：解析失败时通过 onWarn 报出，不再静默', async () => {
  const dir = makeDir()
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
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
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }], source: { kind: 'user' } } }]
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
