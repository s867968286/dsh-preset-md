/**
 * dsh-preset-md 的 Client 半：在官方设置页里注册一个「伙伴设置」页面。
 *
 * - 只用一个官方 slot：`settings.section`（一个注册 = 一个设置页，导航行由官方渲染）；
 * - 不引任何 UI 组件库：React.createElement + 原生 input/textarea/button；
 * - 数据全部走 Host 半的 `/preset-md/api/*`（同源 fetch）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-preset-md',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Modal, Button, IconBrowseOutline16, IconCopyOutline16, IconTrashOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives')
    const API = '/preset-md/api'
    const SECTION_ID = 'preset-md'

    const MD_TABS = [
      { file: 'SYSTEM.md', label: '提示词' },
      { file: 'SOUL.md', label: '个性' },
      { file: 'IDENTITY.md', label: '身份' },
      { file: 'USER.md', label: '用户' },
      { file: 'AGENTS.md', label: '准则' },
      { file: 'MEMORY.md', label: '记忆' },
    ]

    const CSS = [
      '.pmd-root{font-size:13px;color:var(--dsw-alias-label-primary,#1f1f1f);display:flex;flex-direction:column;gap:12px}',
      '.pmd-tabs{display:flex;align-items:flex-end;gap:22px;margin-top:2px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}',
      '.pmd-tab{cursor:pointer;background:none;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8c8c8c);position:relative}',
      '.pmd-tab:hover{color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.pmd-tab[data-on="1"]{color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.pmd-tab[data-on="1"]:after{background:var(--dsw-alias-label-primary,#1f1f1f);content:"";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}',
      '.pmd-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a7dff);outline-offset:2px;color:var(--dsw-alias-label-primary,#1f1f1f);border-radius:2px}',
      '.pmd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));grid-auto-rows:1fr;gap:12px}',
      '.pmd-card{border:.5px solid var(--dsw-alias-border-l4,#e0e0e0);border-radius:20px;padding:0;display:flex;flex-direction:column;gap:0;background:transparent;overflow:hidden}',
      '.pmd-card:hover{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}',
      '.pmd-card-main{display:flex;flex-direction:column;flex:1;gap:8px;padding:14px 16px 12px}',
      '.pmd-card-head{display:flex;align-items:center;gap:8px}',
      '.pmd-card-name{font-size:15px;font-weight:600;line-height:1.4}',
      '.pmd-card-desc{color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:13px;line-height:1.55;min-height:42px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical}',
      '.pmd-card-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary,#8c8c8c);font-size:11px;margin-top:auto}',
      '.pmd-card-foot{border-top:.5px solid var(--dsw-alias-border-l2,#e5e5e5);display:flex;justify-content:flex-end;gap:2px;padding:6px 10px}',
      '.pmd-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:7px;color:var(--dsw-alias-label-tertiary,#8c8c8c);background:transparent;cursor:pointer;position:relative}',
      '.pmd-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,#f2f2f2);color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.pmd-icon-btn:disabled{opacity:.4;cursor:default}',
      '.pmd-icon-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,#fdecea);color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.pmd-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.pmd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.pmd-btn{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;border:1px solid var(--dsw-alias-border-l2,#d9d9d9);border-radius:16px;padding:0 14px;color:var(--dsw-alias-label-primary,#1f1f1f);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;white-space:nowrap}',
      '.pmd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}',
      '.pmd-btn-primary{border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,#1f1f1f)}',
      '.pmd-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#333)}',
      '.pmd-text-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:28px;border:0;border-radius:14px;padding:0 10px;color:var(--dsw-alias-label-secondary,#6b6b6b);background:transparent;cursor:pointer;font:inherit;font-size:12.5px;line-height:18px}',
      '.pmd-text-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,#1f1f1f);background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}',
      '.pmd-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);padding:9px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:13px}',
      '.pmd-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.pmd-input::placeholder{color:var(--dsw-alias-label-dimmed,#9a9a9a)}',
      '.pmd-textarea{width:100%;box-sizing:border-box;min-height:360px;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.6;resize:vertical}',
      '.pmd-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.pmd-hint{color:var(--dsw-alias-label-tertiary,#6b6b6b)}',
      '.pmd-err{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.pmd-field{display:flex;flex-direction:column;gap:6px}',
      '.pmd-field-label{color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:12px;font-weight:500}',
      '.pmd-set-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;min-width:0;min-height:52px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,#e5e5e5);color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}',
      '.pmd-set-label{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.pmd-set-label b{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#1f1f1f);line-height:21px}',
      '.pmd-set-label span{font-size:11px;color:var(--dsw-alias-label-tertiary,#8c8c8c);line-height:17px}',
      '.pmd-perm{display:flex;flex-direction:column}',
      '.pmd-perm>.pmd-set-row{padding:10px 0 8px}',
      '.pmd-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 0 14px;max-width:420px}',
      '.pmd-fields label{display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:12px;line-height:16px}',
      '.pmd-fields input{width:100%;box-sizing:border-box;height:34px;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);border-radius:9px;padding:0 10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:13px}',
      '.pmd-fields input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.pmd-fields input:disabled{opacity:.45;cursor:default}',
      '.pmd-switch{box-sizing:border-box;background:var(--dsw-alias-border-l3,#b8b8b8);cursor:pointer;border:0;border-radius:10px;flex:none;width:36px;height:20px;padding:2px;position:relative;transition:background-color .14s}',
      '.pmd-switch-on{background:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.pmd-switch:disabled{cursor:default;opacity:.5}',
      '.pmd-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a7dff);outline-offset:2px}',
      '.pmd-thumb{background:var(--dsw-alias-label-primary-foreground,#fff);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}',
      '.pmd-switch-on .pmd-thumb{transform:translate(16px)}',
      '.pmd-journal{display:flex;flex-direction:column;gap:6px;min-height:360px}',
      '.pmd-journal-foot{margin-top:auto;padding-top:6px}',
      '.pmd-journal-row{display:flex;gap:12px;align-items:center;width:100%;box-sizing:border-box;text-align:left;font:inherit;color:inherit;background:transparent;cursor:pointer;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}',
      '.pmd-journal-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}',
      '.pmd-journal-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a7dff);outline-offset:-1px}',
      '.pmd-journal-date{flex:none;width:108px;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:500;font-size:12.5px;color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.pmd-journal-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#6b6b6b)}',
      '.pmd-viewer-dialog{width:min(640px,100%)}',
      '.pmd-viewer{border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);background:var(--dsw-alias-bg-layer-2,#f7f7f7);max-height:min(52vh,480px);color:var(--dsw-alias-label-secondary,#6b6b6b);font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;margin:0;padding:12px;font-size:12.5px;line-height:1.6;overflow:auto}',
      '.pmd-sep{height:1px;background:var(--dsw-alias-border-l2,#eee);margin:4px 0}',
      '.pmd-dialog{width:min(480px,100%)}',
      '.pmd-dialog-fields{display:flex;flex-direction:column;gap:12px}',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-preset-md-css]')) return
      const style = document.createElement('style')
      style.setAttribute('data-preset-md-css', '1')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function call(path, options) {
      const response = await fetch(`${API}${path}`, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      return payload
    }

    const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    function TabBar({ tabs, value, onChange }) {
      return h('div', { className: 'pmd-tabs' }, tabs.map((item) => h(
        'button',
        {
          key: item.key,
          type: 'button',
          className: 'pmd-tab',
          'data-on': item.key === value ? '1' : '0',
          onClick: () => onChange(item.key),
        },
        item.label,
      )))
    }

    /* ────────────────────────── 参数 TAB ────────────────────────── */

    function ParamsTab() {
      const [settings, setSettings] = React.useState(null)
      const [message, setMessage] = React.useState('')

      React.useEffect(() => {
        call('/settings').then((data) => setSettings(data.settings)).catch((error) => setMessage(String(error.message)))
      }, [])

      if (!settings) return h('div', { className: 'pmd-hint' }, message || '加载中…')

      const set = (key) => (event) => {
        const value = event.target.type === 'checkbox' ? event.target.checked : Number(event.target.value)
        setSettings({ ...settings, [key]: value })
      }

      const toggle = (key) => h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': Boolean(settings[key]),
        className: 'pmd-switch' + (settings[key] ? ' pmd-switch-on' : ''),
        onClick: () => setSettings({ ...settings, [key]: !settings[key] }),
      }, h('span', { className: 'pmd-thumb' }))

      const num = (key, label, min, step, unit = '轮') => {
        const disabled = !settings.autoMemory
        return h('label', { key },
          `${label}（${unit}）`,
          h('input', {
            type: 'number',
            min,
            step,
            value: settings[key],
            disabled,
            onChange: set(key),
          }))
      }

      const save = async () => {
        try {
          const data = await call('/settings', json('PUT', settings))
          setSettings(data.settings)
          setMessage('已保存。新会话生效。')
        } catch (error) {
          setMessage(`保存失败：${error.message}`)
        }
      }

      const setRow = (key, title, desc) => h('div', { className: 'pmd-set-row', key },
        h('span', { className: 'pmd-set-label' },
          h('b', null, title),
          desc ? h('span', null, desc) : null),
        toggle(key))

      return h('div', { className: 'pmd-root' },
        h('div', { className: 'pmd-hint' }, '这些开关影响此后新建的会话（预设是「创建时组装」的）。'),
        h('div', { className: 'pmd-perm' },
          setRow('autoMemory', '自动记忆',
            '开：后台自动整理日记、更新记忆。关：不写日记也不动记忆，只有手动检索可用。'),
          h('div', { className: 'pmd-fields' },
            num('reviewTurns', '触发轮数', 1, undefined),
            num('reviewChars', '触发字符数', 200, 200, '字符'))),
        setRow('freeze', '会话内冻结提示词',
          '开：同一会话只读一次文件，改动需新开对话。关：每一步都重新读文件，改完立即生效。'),
        setRow('complete', '独占系统提示词',
          '开：系统提示词只保留本插件的 MD 内容，官方内置提示和其它插件注入的提示全部丢弃。关：都保留，一起生效。'),
        setRow('suppressRuntimeContext', '抑制运行时上下文快照',
          '开：禁用运行时上下文快照注入（也包含第三方插件的快照注入，但部分插件可能不失效）。关：允许注入。'),
        h('div', { className: 'pmd-row' },
          h('button', { className: 'pmd-btn pmd-btn-primary', type: 'button', onClick: save }, '保存'),
          h('span', { className: 'pmd-hint' }, message)),
      )
    }

    /* ────────────────────────── 伙伴卡片 ────────────────────────── */

    function AgentList({ onOpen }) {
      const [agents, setAgents] = React.useState([])
      const [message, setMessage] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [copyFrom, setCopyFrom] = React.useState(null)   // 正在复制的源伙伴
      const [copyName, setCopyName] = React.useState('')
      const [copying, setCopying] = React.useState(false)
      const [copyError, setCopyError] = React.useState('')

      const load = React.useCallback(() => {
        call('/agents').then((data) => setAgents(data.agents)).catch((error) => setMessage(String(error.message)))
      }, [])
      React.useEffect(() => { load() }, [load])

      const create = async () => {
        if (!newName.trim()) return setMessage('请输入昵称')
        try {
          const data = await call('/agents', json('POST', { name: newName.trim() }))
          setNewName('')
          setMessage(`已创建「${data.agent.name}」，新会话即可选用。`)
          load()
        } catch (error) {
          setMessage(`创建失败：${error.message}`)
        }
      }

      const remove = async (agent) => {
        const ok = typeof window !== 'undefined' && window.confirm
          ? window.confirm(`删除「${agent.name}」？\n\n只是移动到备份目录，不会真的删除；旧对话仍可查看，新会话不再出现。`)
          : true
        if (!ok) return
        try {
          const data = await call(`/agents/${agent.id}`, { method: 'DELETE' })
          setMessage(`已移动到备份：${data.archived}`)
          load()
        } catch (error) {
          setMessage(`删除失败：${error.message}`)
        }
      }

      const openCopy = (agent) => {
        setCopyFrom(agent)
        setCopyName(agent.name)
        setCopyError('')
        setCopying(false)
      }
      const closeCopy = () => setCopyFrom(null)

      const confirmCopy = async () => {
        if (!copyName.trim()) return setCopyError('请输入新伙伴的昵称')
        if (copying) return
        setCopying(true)
        setCopyError('')
        try {
          const data = await call(`/agents/${copyFrom.id}/copy`, json('POST', { name: copyName.trim() }))
          setMessage(`已复制为「${data.agent.name}」，新会话即可选用。`)
          setCopyFrom(null)
          load()
        } catch (error) {
          setCopyError(String(error.message))
          setCopying(false)
        }
      }

      const copyDialog = copyFrom ? h(Modal, {
        open: true,
        onClose: closeCopy,
        title: '复制伙伴',
        closeLabel: '关闭',
        className: 'pmd-dialog',
        description: `以「${copyFrom.name}」为模板复制一个新伙伴，保留性格与内容，不带历史日记。`,
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: copying, onClick: closeCopy }, '取消'),
          h(Button, { disabled: copying || !copyName.trim(), onClick: confirmCopy }, copying ? '复制中…' : '复制')),
      }, h('div', { className: 'pmd-dialog-fields' },
        h('label', { className: 'pmd-field' },
          h('span', { className: 'pmd-field-label' }, '新伙伴昵称'),
          h('input', {
            className: 'pmd-input',
            value: copyName,
            autoFocus: true,
            spellCheck: false,
            placeholder: '新伙伴的昵称',
            onChange: (event) => { setCopyName(event.target.value); setCopyError('') },
            onKeyDown: (event) => { if (event.key === 'Enter') confirmCopy() },
          })),
        copyError ? h('p', { className: 'pmd-err', role: 'alert' }, copyError) : null)) : null

      return h('div', { className: 'pmd-root' },
        h('div', { className: 'pmd-row' },
          h('input', {
            className: 'pmd-input',
            style: { maxWidth: '220px' },
            placeholder: '新伙伴的昵称',
            value: newName,
            onChange: (event) => setNewName(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') create() },
          }),
          h('button', { className: 'pmd-btn pmd-btn-primary', type: 'button', onClick: create }, '新建伙伴')),
        h('div', { className: 'pmd-hint' }, message || '新建后请刷新 DSH，新会话里即可选择该伙伴。'),
        h('div', { className: 'pmd-sep' }),
        h('div', { className: 'pmd-cards' }, agents.map((agent) => h('article', { className: 'pmd-card', key: agent.id },
          h('div', { className: 'pmd-card-main' },
            h('div', { className: 'pmd-card-head' },
              h('span', { className: 'pmd-card-name' }, agent.name)),
            h('div', { className: 'pmd-card-desc' }, agent.description || '（还没有个性签名）'),
            h('div', { className: 'pmd-card-id' }, agent.id)),
          h('footer', { className: 'pmd-card-foot' },
            h('button', {
              className: 'pmd-icon-btn',
              type: 'button',
              title: '查看',
              'aria-label': `查看：${agent.name}`,
              onClick: () => onOpen(agent.id),
            }, h(IconBrowseOutline16)),
            h('button', {
              className: 'pmd-icon-btn',
              type: 'button',
              title: '复制',
              'aria-label': `复制：${agent.name}`,
              onClick: () => openCopy(agent),
            }, h(IconCopyOutline16)),
            h('button', {
              className: 'pmd-icon-btn pmd-icon-btn-danger',
              type: 'button',
              title: '删除',
              'aria-label': `删除：${agent.name}`,
              onClick: () => remove(agent),
            }, h(IconTrashOutline16)))))),
        copyDialog,
      )
    }

    /* ────────────────────────── 详情 ────────────────────────── */

    /** 日记默认只显示最近这些天，其余折叠，避免越积越长。 */
    const JOURNAL_VISIBLE_DAYS = 7

    function JournalTab({ id }) {
      const [rows, setRows] = React.useState([])
      const [loaded, setLoaded] = React.useState(false)
      const [viewing, setViewing] = React.useState(null)
      const [text, setText] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [expanded, setExpanded] = React.useState(false)

      React.useEffect(() => {
        setLoaded(false)
        setExpanded(false)
        call(`/agents/${id}/journal`)
          .then((data) => setRows(data.journal))
          .catch(() => setRows([]))
          .finally(() => setLoaded(true))
      }, [id])

      const view = async (date) => {
        setViewing(date)
        setLoading(true)
        setText('')
        try {
          const data = await call(`/agents/${id}/journal/${date}`)
          setText(data.text || '（这天没有内容）')
        } catch (error) {
          setText(`读取失败：${error.message}`)
        } finally {
          setLoading(false)
        }
      }

      if (!loaded) {
        return h('div', { className: 'pmd-journal' },
          h('div', { className: 'pmd-hint' }, '加载中…'))
      }
      if (rows.length === 0) {
        return h('div', { className: 'pmd-journal' },
          h('div', { className: 'pmd-hint' }, '还没有日记。'))
      }

      const shown = expanded ? rows : rows.slice(0, JOURNAL_VISIBLE_DAYS)
      const hidden = rows.length - shown.length

      const viewer = h(Modal, {
        open: viewing !== null,
        onClose: () => setViewing(null),
        title: viewing ? `日记 · ${viewing}` : '',
        closeLabel: '关闭',
        className: 'pmd-viewer-dialog',
        description: '这一天的日记内容，只读。',
        footer: h(Button, { variant: 'outline', autoFocus: true, onClick: () => setViewing(null) }, '关闭'),
      }, h('pre', { className: 'pmd-viewer' }, loading ? '读取中…' : text))

      return h('div', { className: 'pmd-journal' },
        shown.map((row) => h('button', {
          key: row.date,
          type: 'button',
          className: 'pmd-journal-row',
          onClick: () => view(row.date),
        },
        h('span', { className: 'pmd-journal-date' }, row.date),
        h('span', { className: 'pmd-journal-preview' }, row.preview || '（空）'))),
        hidden > 0 || expanded
          ? h('div', { className: 'pmd-row pmd-journal-foot' },
            h('button', {
              className: 'pmd-text-btn',
              type: 'button',
              onClick: () => setExpanded(!expanded),
            }, expanded ? '收起，只看最近 7 天' : `展开更早的 ${hidden} 天`))
          : null,
        viewer)
    }

    function AgentDetail({ id, onBack }) {
      const [agent, setAgent] = React.useState(null)
      const [name, setName] = React.useState('')
      const [description, setDescription] = React.useState('')
      const [tab, setTab] = React.useState(MD_TABS[0].file)
      const [draft, setDraft] = React.useState('')
      const [message, setMessage] = React.useState('')

      const load = React.useCallback(() => {
        call(`/agents/${id}`).then((data) => {
          setAgent(data.agent)
          setName(data.agent.name)
          setDescription(data.agent.description || '')
          setDraft(data.agent.files[MD_TABS[0].file] || '')
        }).catch((error) => setMessage(String(error.message)))
      }, [id])
      React.useEffect(() => { load() }, [load])

      if (!agent) return h('div', { className: 'pmd-hint' }, message || '加载中…')

      const pickTab = (file) => {
        setTab(file)
        setDraft(agent.files[file] || '')
        setMessage('')
      }

      const saveMeta = async () => {
        try {
          const data = await call(`/agents/${id}/meta`, json('PUT', { name, description }))
          setAgent(data.agent)
          setMessage('昵称/签名已保存。')
        } catch (error) {
          setMessage(`保存失败：${error.message}`)
        }
      }

      const saveFile = async () => {
        try {
          await call(`/agents/${id}/file`, json('PUT', { file: tab, content: draft }))
          setAgent({ ...agent, files: { ...agent.files, [tab]: draft } })
          setMessage(`${tab} 已保存。新会话生效。`)
        } catch (error) {
          setMessage(`保存失败：${error.message}`)
        }
      }

      const tabs = MD_TABS.map((item) => ({ key: item.file, label: item.label }))
      tabs.push({ key: 'journal', label: '日记' })

      return h('div', { className: 'pmd-root' },
        h('div', { className: 'pmd-row' },
          h('button', { className: 'pmd-text-btn', type: 'button', onClick: onBack }, '← 返回'),
          h('span', { className: 'pmd-hint' }, id)),
        h('label', { className: 'pmd-field' },
          h('span', { className: 'pmd-field-label' }, '昵称'),
          h('input', { className: 'pmd-input', value: name, onChange: (event) => setName(event.target.value) })),
        h('label', { className: 'pmd-field' },
          h('span', { className: 'pmd-field-label' }, '个性签名'),
          h('input', { className: 'pmd-input', value: description, onChange: (event) => setDescription(event.target.value) })),
        h('div', { className: 'pmd-row' },
          h('button', { className: 'pmd-btn pmd-btn-primary', type: 'button', onClick: saveMeta }, '保存昵称/签名'),
          h('span', { className: 'pmd-hint' }, message)),
        h('div', { className: 'pmd-sep' }),
        h(TabBar, { tabs, value: tab, onChange: pickTab }),
        tab === 'journal'
          ? h(JournalTab, { id })
          : h('div', { className: 'pmd-root' },
            h('textarea', { className: 'pmd-textarea', value: draft, onChange: (event) => setDraft(event.target.value) }),
            h('div', { className: 'pmd-row' },
              h('button', { className: 'pmd-btn pmd-btn-primary', type: 'button', onClick: saveFile }, '保存'),
              h('button', {
                className: 'pmd-text-btn',
                type: 'button',
                onClick: () => {
                  setDraft(agent.files[tab] || '')
                  setMessage('')
                },
              }, '取消'))),
      )
    }

    /* ────────────────────────── 入口 ────────────────────────── */

    function PartnerSettings() {
      const [tab, setTab] = React.useState('agents')
      const [openId, setOpenId] = React.useState(null)

      return h('div', { className: 'pmd-root' },
        h(TabBar, {
          tabs: [{ key: 'agents', label: '伙伴' }, { key: 'params', label: '参数' }],
          value: tab,
          onChange: (key) => {
            setTab(key)
            if (key !== 'agents') setOpenId(null)
          },
        }),
        tab === 'params'
          ? h(ParamsTab)
          : (openId
            ? h(AgentDetail, { id: openId, onBack: () => setOpenId(null) })
            : h(AgentList, { onOpen: setOpenId })),
      )
    }

    function apply(ctx) {
      ensureStyles()
      const slots = ctx.slots !== undefined ? ctx.slots : ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: SECTION_ID, order: 21, label: '伙伴设置' },
        PartnerSettings,
      ))
    }

    return { apply, inject: ['slots'], name: 'preset-md-client' }
  },
})
