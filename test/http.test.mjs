/**
 * HTTP 路由层测试（src/index.js 的 registerRoutes / guard / readBody / readJson /
 * sendJson / statusOfError / isSameOriginRequest）。
 *
 * ## 为什么必须用真实 server，而不是直接调 handler
 *
 * 这一层此前的盲区正是「状态码到底有没有发出去」——413 那条 bug 的成因就是
 * `req.destroy()` 把 socket 拆了，`sendJson` 写不进去，客户端拿到的是
 * `UND_ERR_SOCKET` 而不是 413。任何 mock 掉 res 的测法都测不出这种问题，
 * 所以这里统一起一个真的 `node:http` server，用 `fetch` 打过去。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_BODY_BYTES, ROUTE_PREFIX, isSameOriginRequest, registerRoutes, statusOfError } from '../src/index.js'
import { readBindings, resolvePaths } from '../src/settings.mjs'

/**
 * 模拟官方的 scope carrier —— 即 `agent/created` 里那个 `this`。
 *
 * 真的 carrier 是 `scopeTarget(agent, agent)` 的产物，**只有一个成员**
 * `Symbol(cordis.filter)`（见 `dsh-scope/lib/index.js:327-338`）。这里逐字复刻：
 * 除该符号外没有任何 Context 成员。于是任何"从 this 上取 systemPrompt"的写法
 * 都会在这里现形，而不是在生产上被 catch 静默吞掉。
 */
function scopeCarrierStub() {
  return { [Symbol('cordis.filter')]: () => true }
}

/**
 * 起一个只挂了本插件路由的 server，返回请求工具与清理函数。
 *
 * ctx 只实现 registerRoutes 真正用到的东西（webServer.register / logger），
 * 不引入 Cordis——这一层要验的是 HTTP 语义，不是插件装配。
 */
async function withServer() {
  const home = mkdtempSync(join(tmpdir(), 'companion-http-'))
  const warns = []
  const listeners = new Map()
  const ctx = {
    logger: { warn: (message) => warns.push(String(message)), info: () => {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    /*
     * 事件分发支持"带 scope 的 this"。
     *
     * ⚠️ 但那个 `this` **不是** Context。官方把 `agent/created` 的 `this` 标为
     * `Scoped<Agent>`（`dsh-agent/lib/types/runtime-types.d.ts:227`），而 `Scoped<T>`
     * 的定义是 `object & { readonly [ScopedBrand]: T }`
     * （`dsh-scope/lib/types/index.d.ts:18`）—— 它只是**作用域路由标记**。
     * 运行期由 `scopeTarget(agent, agent)` 构造（`dsh-agent/lib/index.js:231`），
     * 实测只有 `Symbol(cordis.filter)` 一个成员：`systemPrompt` / `effect` / `get`
     * 全是 `undefined`。
     *
     * 真正的 per-agent scope 是 `agent.ctx`。所以这个桩按真实形态只挂一个
     * filter 符号 —— 谁要是又去 `this.systemPrompt`，这里就会立刻炸出来。
     */
    emit(event, payload, scopeCtx) {
      for (const handler of listeners.get(event) ?? []) handler.call(scopeCtx, payload)
    },
    webServer: {
      register: (route) => {
        handler = route.handler
        return () => {}
      },
    },
  }
  let handler
  registerRoutes(ctx, home)
  assert.ok(handler, 'registerRoutes 应注册一个 handler')

  const server = createServer((req, res) => {
    handler(req, res).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}/api`

  /** 发一个请求，返回 { status, headers, json }。 */
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }
    return { status: response.status, headers: response.headers, json, text }
  }

  const close = () => {
    server.closeAllConnections?.()
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
  return { home, base, call, close, warns, ctx }
}

/** 从 base URL 取出 origin，用于构造「真正同源」的请求头。 */
function originOf(base) {
  return new URL(base).origin
}

/* ───────────────────────── 来源校验（CSRF） ───────────────────────── */

test('isSameOriginRequest：跨站、异源、null 来源一律拒绝', () => {
  const same = (headers) => isSameOriginRequest({ headers })
  // 浏览器给出的、页面脚本无法伪造的信号
  assert.equal(same({ 'sec-fetch-site': 'cross-site', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), false)
  // Origin 与 Host 不同源
  assert.equal(same({ host: '127.0.0.1:3080', origin: 'https://evil.example' }), false)
  // 不可信来源：沙箱 iframe / data: 页面
  assert.equal(same({ host: '127.0.0.1:3080', origin: 'null' }), false)
  // 同源放行
  assert.equal(same({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), true)
  assert.equal(same({ 'sec-fetch-site': 'same-origin', host: '127.0.0.1:3080' }), true)
  // 非浏览器客户端（curl）：两个头都拿不到 → 放行
  assert.equal(same({}), true)
  // Origin 非空但 Host 缺失 → 无法判定同源，拒绝
  assert.equal(same({ origin: 'http://127.0.0.1:3080' }), false)
})

test('路由：跨站写请求被拒（含 CORS 简单请求这条真实链路）', async () => {
  const { home, base, call, close } = await withServer()
  try {
    /*
     * 这是最危险的一条：POST + text/plain 属于 CORS「简单请求」，**不触发预检**，
     * 任意网页都能发出来。不设防时它会在用户预设目录里凭空造出伙伴。
     */
    const created = await call('/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '攻击者注入的名字' }),
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    })
    assert.equal(created.status, 403, '跨站 POST 必须被拒')

    // 目录里必须什么都没被造出来
    const presetsRoot = join(home, 'companion', 'companions')
    const dirs = existsSync(presetsRoot) ? readdirSync(presetsRoot) : []
    assert.deepEqual(dirs, [], `跨站请求不该写盘，实际造出了：${dirs.join(', ')}`)

    // PUT 同样拒绝（此前只是被「服务器不应答 OPTIONS」偶然挡住）
    const put = await call('/settings', {
      method: 'PUT',
      body: { autoMemory: false },
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(put.status, 403)

    // 同源请求必须照常放行——校验不能把正常功能一起挡掉
    const created2 = await call('/agents', {
      method: 'POST',
      body: { name: '正常创建的伙伴' },
      headers: { origin: originOf(base), 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(created2.status, 201, '同源 POST 必须放行')
    assert.equal(created2.json.agent.name, '正常创建的伙伴')
  } finally {
    close()
  }
})

test('路由：同源写请求放行，且真的落盘', async () => {
  const { home, call, close } = await withServer()
  try {
    const response = await call('/agents', {
      method: 'POST',
      body: { name: '小花', description: '温柔' },
      // 不带 Origin / Sec-Fetch-*（curl 形态）：非浏览器客户端放行
    })
    assert.equal(response.status, 201)
    assert.equal(response.json.agent.name, '小花')

    const dirs = readdirSync(join(home, 'companion', 'companions'))
    assert.equal(dirs.length, 1)
    assert.ok(existsSync(join(home, 'companion', 'companions', dirs[0], 'IDENTITY.md')))
  } finally {
    close()
  }
})

/* ───────────────────────── 错误映射 ───────────────────────── */

test('路由：未知路径 404、非法 JSON 400、非法 id 400', async () => {
  const { call, close } = await withServer()
  try {
    assert.equal((await call('/nope')).status, 404)
    assert.equal((await call('/agents/../etc', { method: 'GET' })).status, 404)

    // 非法 JSON 要报 400，不能 500
    const bad = await call('/agents', { method: 'POST', body: '{ 不是 JSON' })
    assert.equal(bad.status, 400)
    assert.match(bad.json.error, /合法 JSON/)

    // 业务校验错误（空昵称）→ 400 而不是 500
    const empty = await call('/agents', { method: 'POST', body: { name: '  ' } })
    assert.equal(empty.status, 400)
    assert.match(empty.json.error, /昵称/)

    // 不存在的伙伴 → 404
    assert.equal((await call('/agents/nope-x/')).status, 404)
  } finally {
    close()
  }
})

test('路由：未知异常才是 500，且会记一条 warn', async () => {
  const { call, close, warns } = await withServer()
  try {
    /*
     * 触发一个真正的未知异常：`/api/agents/<id>` 的 id 形态合法但目录名是**文件**时，
     * readAgent 内部的 readText 会吞掉 EISDIR，所以这条路不会 500。
     * 改用「id 合法但 presetsRoot 本身是个文件」——existsSync(dir) 为 false，
     * 会走业务错误（404）。真正能稳定拿 500 的是 `listJournal` 的 statSync：
     * 让 memory/ 下存在一个同名目录，statSync 仍能成功，因此也拿不到。
     *
     * 结论：当前实现里**没有**能从 HTTP 层稳定触发的 500 路径，所以这条测试
     * 改为直接验证映射函数本身，而不是硬造一个不存在的场景。
     */
    assert.equal(statusOfError(new Error('随便什么内部错误')), 500, '未知错误映射成 500')
    assert.equal(statusOfError(new Error('伙伴不存在：x')), 404)
    assert.equal(statusOfError(new Error('非法 id：../x')), 400)
    assert.equal(statusOfError(new Error('昵称过长（上限 60 字符，当前 200）')), 400)
    void call
    void warns
  } finally {
    close()
  }
})

/* ───────────────────────── 请求体上限 ───────────────────────── */

test('路由：超大请求体回 413（而不是连接被拆掉的网络错误）', async () => {
  const { call, close } = await withServer()
  try {
    /*
     * 这条锁的是一个真实 bug：早先 readBody 判超限后立刻 req.destroy()，
     * 把 socket 一起拆了，等 catch 里写响应时连接已经死了——
     * 客户端拿到的是 UND_ERR_SOCKET，用户体感是「网络错误，未知原因」。
     * 修法是「标记超限但把流读完」，让 413 能正常写出。
     */
    const huge = JSON.stringify({ name: 'x', description: 'y'.repeat(MAX_BODY_BYTES + 1024) })
    const response = await call('/agents', { method: 'POST', body: huge })
    assert.equal(response.status, 413, `应回 413，实际 ${response.status}`)
    assert.match(response.json.error, /超过上限/)
  } finally {
    close()
  }
})

test('路由：正常大小的请求体不受影响（边界内不误拒）', async () => {
  const { call, close } = await withServer()
  try {
    // 远小于上限，必须正常通过——上限不能误伤正常请求
    const response = await call('/agents', { method: 'POST', body: { name: '甲' } })
    assert.equal(response.status, 201)
  } finally {
    close()
  }
})

/* ───────────────────────── 长度上限 ───────────────────────── */

test('路由：昵称/签名过长回 400', async () => {
  const { call, close } = await withServer()
  try {
    const longName = await call('/agents', { method: 'POST', body: { name: '长'.repeat(200) } })
    assert.equal(longName.status, 400)
    assert.match(longName.json.error, /过长/)

    const longDesc = await call('/agents', { method: 'POST', body: { name: '甲', description: '签'.repeat(500) } })
    assert.equal(longDesc.status, 400)
    assert.match(longDesc.json.error, /过长/)
  } finally {
    close()
  }
})

/* ───────────────────────── 编辑冲突检测 ───────────────────────── */

test('路由：/file 带过期 baseVersion 回 409，带当前版本则成功', async () => {
  const { call, close } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '小花' } })
    const id = created.json.agent.id
    const baseVersion = created.json.agent.versions['MEMORY.md']
    assert.equal(typeof baseVersion, 'string')

    // 第一次保存：版本匹配 → 成功，并返回新版本
    const first = await call(`/agents/${id}/file`, {
      method: 'PUT',
      body: { file: 'MEMORY.md', content: '第一条\n', baseVersion },
    })
    assert.equal(first.status, 200)
    const nextVersion = first.json.version
    assert.equal(typeof nextVersion, 'string')
    assert.notEqual(nextVersion, baseVersion)

    /*
     * 模拟「后台自动记忆在此期间追加了内容」：用**当前**版本再写一次（等价于
     * 磁盘内容又变了），此后拿**旧** baseVersion 保存必须被拒——
     * 否则那次追加会被静默覆盖，这正是评估点名的「丢更新」场景。
     */
    const stale = await call(`/agents/${id}/file`, {
      method: 'PUT',
      body: { file: 'MEMORY.md', content: '后台追加\n', baseVersion: nextVersion },
    })
    assert.equal(stale.status, 200)

    const conflicting = await call(`/agents/${id}/file`, {
      method: 'PUT',
      body: { file: 'MEMORY.md', content: '用户的旧草稿\n', baseVersion },
    })
    assert.equal(conflicting.status, 409, '过期版本必须回 409')
    assert.match(conflicting.json.error, /已被后台修改/)

    // 被拒后磁盘上必须还是「后台追加」，用户草稿不能覆盖它
    const read = await call(`/agents/${id}`)
    assert.ok(read.json.agent.files['MEMORY.md'].includes('后台追加'), '被拒的写入不能覆盖后台内容')
    assert.ok(!read.json.agent.files['MEMORY.md'].includes('用户的旧草稿'))
  } finally {
    close()
  }
})

test('路由：不带 baseVersion 时保持旧行为（不校验）', async () => {
  const { call, close } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '小花' } })
    const id = created.json.agent.id
    const first = await call(`/agents/${id}/file`, { method: 'PUT', body: { file: 'SOUL.md', content: 'a' } })
    assert.equal(first.status, 200)
    // 第二次仍不带版本：照常覆盖（给脚本 / 命令行留后路）
    const second = await call(`/agents/${id}/file`, { method: 'PUT', body: { file: 'SOUL.md', content: 'b' } })
    assert.equal(second.status, 200)
  } finally {
    close()
  }
})

/* ───────────────────────── 读写往返 ───────────────────────── */

test('路由：GET /agents/:id 带回各文件版本指纹', async () => {
  const { call, close } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '小花' } })
    const id = created.json.agent.id
    const read = await call(`/agents/${id}`)
    assert.equal(read.status, 200)
    for (const file of ['SYSTEM.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md']) {
      assert.equal(typeof read.json.agent.files[file], 'string', `${file} 应返回内容`)
      assert.equal(typeof read.json.agent.versions[file], 'string', `${file} 应返回版本`)
    }
  } finally {
    close()
  }
})

test('路由：/file 只接受六个已知 MD 名，其余（含路径穿越）拒绝', async () => {
  const { home, call, close } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '小花' } })
    const id = created.json.agent.id

    /*
     * 注意两个白名单不是一回事，别把它们当成同一个：
     * - 设置页可编辑**全部六个** MD（含 SYSTEM.md），这是有意的
     *   （见 README 的页签说明与 client 的 MD_TABS）。
     * - `memory-store` 的 EDITABLE_FILES 只有四个，那限制的是 **AI 自动记忆**
     *   能改哪些文件，跟设置页无关。
     * 所以这里不该断言 SYSTEM.md 被拒——真正该守住的是「不能写到六个名字之外」。
     */
    for (const file of ['..%2F..%2Fetc%2Fpasswd', 'evil.md', '', 'SOUL.md.bak', 'memory/2026-09-13.md']) {
      const response = await call(`/agents/${id}/file`, {
        method: 'PUT',
        body: { file, content: '不该落盘' },
      })
      assert.equal(response.status, 400, `${JSON.stringify(file)} 应被拒绝，实际 ${response.status}`)
      assert.match(response.json.error, /不允许写/)
    }

    // 六个已知文件都能写（含 SYSTEM.md，这是设计而非漏洞）
    for (const file of ['SYSTEM.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md']) {
      const response = await call(`/agents/${id}/file`, { method: 'PUT', body: { file, content: `# ${file}\n` } })
      assert.equal(response.status, 200, `${file} 应可写`)
    }

    // 目录里不该出现白名单外的文件
    const dir = join(home, 'companion', 'companions', id)
    const names = readdirSync(dir).sort()
    assert.deepEqual(
      names.filter((name) => name.endsWith('.md') && !['SYSTEM.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md'].includes(name)),
      [],
      `不该有白名单外的 .md：${names.join(', ')}`,
    )
  } finally {
    close()
  }
})

/* ───────────────────── 伙伴下拉：列表与绑定读写 ───────────────────── */

test('GET /companions：列出伙伴（供下拉渲染）', async () => {
  const { call, close } = await withServer()
  try {
    const empty = await call('/companions')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json.companions, [])

    await call('/agents', { method: 'POST', body: { name: '莉莉', description: '爱笑' } })
    const list = await call('/companions')
    assert.equal(list.json.companions.length, 1)
    assert.equal(list.json.companions[0].name, '莉莉')
    assert.equal(list.json.companions[0].description, '爱笑')
  } finally {
    close()
  }
})

test('GET /companions?session=：回当前绑定，否则下拉无法显示「正在用哪个」', async () => {
  /*
   * 下拉需要知道两件事：有哪些伙伴、这个会话现在绑的是哪个。
   * 只回列表的话，已经选过伙伴的会话会一直显示「无伙伴」——
   * 用户会以为自己的选择没生效，然后再选一次。
   */
  const { call, close, ctx } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '莉莉' } })
    const id = created.json.agent.id

    // 会话不在索引里：列表照常可用，current 为 null（不是错误）
    const unknown = await call('/companions?session=nope')
    assert.equal(unknown.status, 200)
    assert.equal(unknown.json.current, null)

    /*
     * 替身要真的**记录** append 的事件并能读回来 ——
     * 空实现的 append 会让"绑定后回读"这条路径根本走不到，
     * 测试就变成了假绿。
     */
    const events = []
    const session = {
      id: 's1',
      blank: true,
      append: (type, data) => { events.push({ type, data }) },
      ownEvents: () => events,
    }
    ctx.emit('agent/created', { agent: { session } })

    const before = await call('/companions?session=s1')
    assert.equal(before.json.current, null, '还没绑定时应为 null')

    await call('/companion', { method: 'PUT', body: { companion: id, session: 's1' } })
    const after = await call('/companions?session=s1')
    assert.equal(after.json.current, id, '绑定后应回该伙伴 id')
  } finally {
    close()
  }
})

test('PUT /companion：选中伙伴后立刻在其会话 scope 里注册 complete 注入', async () => {
  /*
   * 这条锁的是本插件最核心的机制：**按会话注册提示词注入**。
   *
   * 用户"新建对话 -> 选伙伴 -> 发第一条消息"的路径里，会话已经创建完毕
   * （`agent/created` 已过），所以注入必须在 PUT /companion 时补注册，
   * 且要注册进**该会话自己的 scope**（官方把 agent/created 的 this 标为
   * `Scoped<Agent>`，我们把这中间件持有的 this 存下来复用）。
   *
   * 为什么强调"自己的 scope"：complete 段会丢弃官方全部提示词，若不按会话隔离，
   * 一个会话选了伙伴会污染所有会话。
   */
  const { call, close, ctx } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '莉莉' } })
    const id = created.json.agent.id

    /*
     * 造一个"会话 scope"的假 ctx，记录注册到它身上的东西。
     *
     * ⚠️ 它必须挂在 **`agent.ctx`** 上，不能作为 emit 的 this 传进来。
     * 官方 `agent/created` 的 `this` 是 `scopeTarget(agent, agent)` 构造的
     * **作用域路由 carrier**，实测只有 `Symbol(cordis.filter)` 一个成员，
     * `carrier.systemPrompt === undefined` —— 真实 per-agent scope 是 `agent.ctx`。
     * 早先本测试正是把 ctx 当作 this 传进来，于是和实现犯了同一个错，
     * 两条互补的 bug 互相抵消：测试全绿，生产上提示词一个字都没注入。
     */
    const registered = { sections: [], variables: [] }
    const agentCtx = {
      systemPrompt: {
        section: (section) => { registered.sections.push(section); return () => {} },
        variable: (name) => { registered.variables.push(name); return () => {} },
      },
    }

    const appended = []
    const session = { id: 's1', blank: true, append: (type, data) => appended.push({ type, data }) }
    // 第二个参数是真实的 carrier 形态（没有任何 Context 成员）——故意如此
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, scopeCarrierStub())

    const response = await call('/companion', { method: 'PUT', body: { companion: id, session: 's1' } })
    assert.equal(response.status, 200)

    const complete = registered.sections.filter((section) => section.complete === true)
    assert.equal(complete.length, 1, '选中伙伴后应注册恰好一个 complete 段')
    assert.equal(complete[0].name, 'companion')
    assert.ok(registered.variables.includes('companion_persona'), '应同时注册承载正文的变量')
  } finally {
    close()
  }
})

test('PUT /companion：选「无伙伴」不注册任何 complete 段 —— 官方提示词得以原样生效', async () => {
  /*
   * 退路契约。关键在于**不注册**，而不是"注册一个空文本的 complete 段"：
   * 官方 `dsh-system-prompt/lib/index.js:345` 只看 `complete === true` 就记录，
   * 再在 L359 用它替换掉全部 sections —— 空文本的 complete 段会把系统提示词
   * 清成 ""，比不注册糟糕得多。
   */
  const { call, close, ctx } = await withServer()
  try {
    const registered = { sections: [], variables: [] }
    const agentCtx = {
      systemPrompt: {
        section: (section) => { registered.sections.push(section); return () => {} },
        variable: (name) => { registered.variables.push(name); return () => {} },
      },
    }
    const session = { id: 's1', blank: true, append: () => {} }
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, scopeCarrierStub())

    const response = await call('/companion', { method: 'PUT', body: { companion: null, session: 's1' } })
    assert.equal(response.status, 200)
    assert.deepEqual(
      registered.sections.filter((section) => section.complete === true),
      [],
      '选「无伙伴」不得注册 complete 段',
    )
  } finally {
    close()
  }
})

test('PUT /companion：从伙伴切到「无伙伴」会撤掉注入', async () => {
  /*
   * 反向路径：先选了伙伴（注册），再改成「无伙伴」必须**真的撤掉** section，
   * 否则那个 complete 段会一直挂在会话上，官方提示词永远回不来。
   */
  const { call, close, ctx } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '莉莉' } })
    const id = created.json.agent.id

    const live = { sections: [] }
    // 同前：真正的 per-agent scope 是 agent.ctx，不是 emit 的 this（carrier）
    const agentCtx = {
      systemPrompt: {
        section(section) {
          live.sections.push(section)
          // 模拟官方 effect disposer：从列表里移除
          return () => {
            const at = live.sections.indexOf(section)
            if (at >= 0) live.sections.splice(at, 1)
          }
        },
        variable: () => () => {},
      },
    }
    const session = { id: 's1', blank: true, append: () => {} }
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, scopeCarrierStub())

    await call('/companion', { method: 'PUT', body: { companion: id, session: 's1' } })
    assert.equal(live.sections.length, 1, '选中后应有一个 complete 段')

    await call('/companion', { method: 'PUT', body: { companion: null, session: 's1' } })
    assert.deepEqual(live.sections, [], '改成「无伙伴」后必须撤掉该段')
  } finally {
    close()
  }
})

test('PUT /companion：会话未开始时写入绑定表', async () => {
  /*
   * 绑定值必须落到**插件自己的绑定表**里（`bindings.json`，按 sessionId 索引）。
   *
   * ⚠️ 这里**绝不能**再断言"写进会话事件流"：官方 v4 持久化门禁
   * （`dsh-session-persistence/lib/index.js:184`）会拒绝解读含未知事件类型且
   * 未标 `ignorable` 的日志，而 `Session.append()` 没给第三方传该标记的入口。
   * 后果是写过绑定的会话下次**打不开 / 新建会话失败**。
   * 见 companion.mjs 顶部说明。
   */
  const { home, call, close, ctx } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '莉莉' } })
    const id = created.json.agent.id

    // session.append 若被调用就是回归：绑定绝不能再进事件流
    const appended = []
    const session = { id: 's1', blank: true, append: (type, data) => appended.push({ type, data }) }
    ctx.emit('agent/created', { agent: { session } })

    const response = await call('/companion', { method: 'PUT', body: { companion: id, session: 's1' } })
    assert.equal(response.status, 200)
    assert.equal(response.json.current, id)
    assert.deepEqual(appended, [], '绑定不得再写进会话事件流（会让会话打不开）')
    assert.equal(readBindings(resolvePaths(home))['s1'], id, '应写进绑定表')
  } finally {
    close()
  }
})

test('PUT /companion：对话已开始后锁定，拒绝修改', async () => {
  /*
   * 用户明确要求：开对话前可选，**开对话后不可选**。
   * 判据取官方 SessionSnapshot 的 blank / promptAttempted 语义。
   */
  const { call, close, ctx } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '莉莉' } })
    const id = created.json.agent.id

    for (const [label, session] of [
      ['blank=false（会话已开始）', { id: 's1', blank: false, append: () => { throw new Error('不该写入') } }],
      ['promptAttempted（已提交过消息）', { id: 's1', promptAttempted: true, append: () => { throw new Error('不该写入') } }],
    ]) {
      ctx.emit('agent/created', { agent: { session } })
      const response = await call('/companion', { method: 'PUT', body: { companion: id, session: 's1' } })
      assert.equal(response.status, 409, `${label} 应被拒`)
      assert.match(response.json.error, /伙伴不可更改/)
    }
  } finally {
    close()
  }
})

test('PUT /companion：不存在的伙伴要报错，不能静默接受', async () => {
  /*
   * 静默接受一个不存在的 id，会让该会话"看起来选好了伙伴、实际什么都不注入"——
   * 这种失败完全不可见，是最难排查的一类。所以必须显式 404。
   */
  const { call, close, ctx } = await withServer()
  try {
    const session = { id: 's1', blank: true, append: () => {} }
    ctx.emit('agent/created', { agent: { session } })
    const response = await call('/companion', { method: 'PUT', body: { companion: 'never-existed', session: 's1' } })
    assert.equal(response.status, 404)
    assert.match(response.json.error, /伙伴不存在/)
  } finally {
    close()
  }
})

test('PUT /companion：绑定「无伙伴」（null）是合法的退路', async () => {
  /*
   * 选择「无伙伴」= 用官方提示词。这必须是**合法写入**而不是错误，
   * 否则用户就没有"我不想用伙伴"这个选项了。
   */
  const { home, call, close, ctx } = await withServer()
  try {
    const appended = []
    const session = { id: 's1', blank: true, append: (type, data) => appended.push({ type, data }) }
    ctx.emit('agent/created', { agent: { session } })

    const response = await call('/companion', { method: 'PUT', body: { companion: null, session: 's1' } })
    assert.equal(response.status, 200)
    assert.equal(response.json.current, null)
    assert.deepEqual(appended, [], '绑定不得再写进会话事件流')
    // 显式「无伙伴」= 表里记 null，与"从未选过"（无此键）是两回事
    assert.equal(readBindings(resolvePaths(home))['s1'], null, '应选「无伙伴」记 null')
  } finally {
    close()
  }
})

test('PUT /companion：会话已不在运行时报 409，不静默丢弃', async () => {
  const { call, close } = await withServer()
  try {
    const response = await call('/companion', { method: 'PUT', body: { companion: null, session: 'ghost' } })
    assert.equal(response.status, 409)
    assert.match(response.json.error, /已不在运行/)
  } finally {
    close()
  }
})

test('PUT /companion：跨站写请求被拒（与其余写接口同等对待）', async () => {
  const { call, close, ctx } = await withServer()
  try {
    const appended = []
    ctx.emit('agent/created', { agent: { session: { id: 's1', blank: true, append: (...a) => appended.push(a) } } })
    const response = await call('/companion', {
      method: 'PUT',
      body: { companion: null, session: 's1' },
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(response.status, 403)
    assert.deepEqual(appended, [], '跨站请求不得写入任何绑定')
  } finally {
    close()
  }
})

/* ─────────── 回归：carrier 当 ctx 用会让注入静默失效 ───────────
 * 这是一次真实事故的锁。
 *
 * 症状：用户在界面里选好伙伴、会话日志里也写进了
 * `companion/companion-selected`，但系统提示词里**一个伙伴字都没有**。
 *
 * 成因：`agent/created` 的 `this` 被当成 Context 用了。它其实是
 * `scopeTarget(agent, agent)` 造的**作用域路由 carrier**，只有
 * `Symbol(cordis.filter)` 一个成员。于是 `this.systemPrompt.section(...)`
 * 抛 TypeError，被 catch 吞成一条 warn —— 绑定照写、注入从不发生。
 *
 * 下面两条分别锁住：① 从 `agent.ctx` 注册确实生效；
 * ② 若实现退回从 `this` 取，则必须留下可观测的痕迹而不是静默成功。
 * ------------------------------------------------------------------ */

test('回归：伙伴注入必须注册到 agent.ctx（用 carrier 的 this 会静默失效）', async () => {
  const { call, close, ctx } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '莉莉' } })
    const id = created.json.agent.id

    const registered = { sections: [], variables: [] }
    const agentCtx = {
      systemPrompt: {
        section: (section) => { registered.sections.push(section); return () => {} },
        variable: (name) => { registered.variables.push(name); return () => {} },
      },
    }
    const session = { id: 's1', blank: true, append: () => {} }

    /*
     * 关键：this 传真实 carrier 形态，agent 上带 ctx。
     * 实现若从 this 取 systemPrompt，这里必然抛错并被吞掉 ——
     * 断言随即失败，事故就无法再次悄悄发生。
     */
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, scopeCarrierStub())
    await call('/companion', { method: 'PUT', body: { companion: id, session: 's1' } })

    const complete = registered.sections.filter((section) => section.complete === true)
    assert.equal(complete.length, 1, '注入必须真的落到 agent.ctx 上（而不是被 catch 吞掉）')
    assert.ok(registered.variables.includes('companion_persona'), '变量也要注册到 agent.ctx')
  } finally {
    close()
  }
})

test('回归：取不到 agent.ctx 时不静默 —— 记 warn 且不写坏状态', async () => {
  /*
   * 万一将来官方改了 agent 的形状、`agent.ctx` 拿不到，
   * 必须留下日志线索，而不是像上次那样"看起来一切正常"。
   */
  const { call, close, ctx, warns } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '莉莉' } })
    const id = created.json.agent.id

    // 有绑定事件但 agent 没有 ctx：应在 agent/created 阶段就报出线索
    const events = [{ type: 'companion/selected', data: { companion: id } }]
    const session = { id: 's1', blank: true, append: () => {}, ownEvents: () => events }
    ctx.emit('agent/created', { agent: { session } }, scopeCarrierStub())

    assert.ok(
      warns.some((line) => line.includes('agent.ctx')),
      `应记录取不到 agent.ctx 的告警，实际日志：${JSON.stringify(warns)}`,
    )
  } finally {
    close()
  }
})

test('回归：伙伴绑定绝不写进会话事件流（会让会话打不开）', async () => {
  /*
   * 这条锁的是一次真实事故的根因。
   *
   * 症状：新建会话失败 ——
   *   `SessionQueryError: ... contains event type "companion/companion-selected"
   *    (seq N) unknown to this harness and not marked ignorable;
   *    refusing to interpret the log`
   *
   * 成因：把绑定写成自定义会话事件。官方 v4 持久化门禁
   * （`dsh-session-persistence/lib/index.js:184`）要求白名单外的类型必须带
   * `ignorable: true`，而 `Session.append()` 的 opts 只透传
   * `surfaceOp` / `sourceEventSeqs`（`dsh-session/lib/index.js:1401`），
   * 第三方**没有写入该标记的入口**。
   *
   * 所以绑定只能住插件自己的绑定表。本用例用"append 即失败"的方式钉死它 ——
   * 谁再把绑定写回事件流，这里立刻红。
   */
  const { home, call, close, ctx } = await withServer()
  try {
    const created = await call('/agents', { method: 'POST', body: { name: '莉莉' } })
    const id = created.json.agent.id

    let appendCalled = false
    const session = {
      id: 's1',
      blank: true,
      append: () => { appendCalled = true },
    }
    ctx.emit('agent/created', { agent: { session } }, scopeCarrierStub())

    const response = await call('/companion', { method: 'PUT', body: { companion: id, session: 's1' } })
    assert.equal(response.status, 200)
    assert.equal(appendCalled, false, 'session.append 不得被调用——写进事件流会让会话无法打开')
    assert.equal(readBindings(resolvePaths(home))['s1'], id, '应写入绑定表')
  } finally {
    close()
  }
})
