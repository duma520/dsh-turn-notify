/**
 * 顶层必须用 var，不能用 const —— 踩过的坑，别改回去。
 *
 * 宿主把几十个插件的客户端 bundle 拼成同一个 classic script（combo 路由）。
 * 在 classic script 顶层用 const/let 声明的名字进的是全局词法环境，
 * 同一个文档里第二次执行同一段拼接脚本（热重载/重新注入）就会在解析阶段抛
 * SyntaxError: Identifier 'X' has already been declared，整段脚本一行都不执行，
 * 所有插槽注册静默失效 —— 界面上就是「插件在跑，但哪儿都找不到它」。
 * var 在 classic script 顶层是重复声明安全的。
 */
/**
 * 本地状态合并：**嵌套对象逐键合并**，不做整体替换。
 *
 * 为什么单独抽出来：设置页所有控件都走同一个 patch()，其中 triggers / quietHours
 * 是嵌套对象。若用 `{ ...prev, ...partial }` 整体替换，点第二张触发卡时
 * partial.triggers 只有 `{ 第二项: true }`，其余七个键当场变 undefined ——
 * 界面上就是「勾了 B，A 自动掉了」，看着像单选按钮。
 * 抽成纯函数后能被 scaffold/test_client_merge.mjs 直接断言，防止再退回去。
 *
 * 标记区间（begin/end）供测试脚本按字面切片，改这段时两行标记要保留。
 */
// <merge-patch:begin>
var mergePatch = function (prev, partial) {
  var base = prev || {}
  var delta = partial || {}
  var next = Object.assign({}, base, delta)
  // 嵌套键一定要走「逐键合并」分支：delta 里若带了 triggers: null 这种脏值，
  // 上面那行整体覆盖会把它写成 null，界面下一帧读 triggers[xxx] 就抛错。
  if (Object.prototype.hasOwnProperty.call(delta, 'triggers')) {
    var dt = delta.triggers
    if (dt && typeof dt === 'object') {
      next.triggers = Object.assign({}, base.triggers || {}, dt)
    } else {
      next.triggers = base.triggers
    }
  }
  if (Object.prototype.hasOwnProperty.call(delta, 'quietHours')) {
    var dq = delta.quietHours
    if (dq && typeof dq === 'object') {
      next.quietHours = Object.assign({}, base.quietHours || {}, dq)
    } else {
      next.quietHours = base.quietHours
    }
  }
  return next
}
// <merge-patch:end>

var CSS_LINES = [
  ".tn-wrap{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.55;color:var(--dsh-text,#1f1f1f);box-sizing:border-box;flex:1 1 auto;min-height:0;max-height:calc(100vh - 88px);overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;padding-bottom:24px;}",
  ".tn-wrap *{box-sizing:border-box;}",
  ".tn-card{border:1px solid var(--dsh-border,#e3e3e3);border-radius:10px;padding:14px;background:var(--dsh-surface,#fff);}",
  ".tn-title{font-weight:600;font-size:14px;margin:0 0 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
  ".tn-hint{opacity:.68;font-size:12px;line-height:1.5;}",
  ".tn-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}",
  ".tn-row > label{min-width:88px;opacity:.75;}",
  ".tn-grow{flex:1 1 220px;min-width:0;}",
  ".tn-num{width:92px;background:var(--dsh-input-bg,transparent);color:inherit;border:1px solid var(--dsh-border,#d9d9d9);border-radius:7px;padding:6px 9px;font:inherit;outline:none;}",
  ".tn-field{width:100%;background:var(--dsh-input-bg,transparent);color:inherit;border:1px solid var(--dsh-border,#d9d9d9);border-radius:7px;padding:7px 9px;font:inherit;outline:none;}",
  ".tn-field:focus,.tn-num:focus{border-color:var(--dsh-accent,#4a7dff);}",
  ".tn-btn{display:inline-flex;align-items:center;gap:6px;background:transparent;color:inherit;border:1px solid var(--dsh-border,#d9d9d9);border-radius:7px;padding:6px 13px;font:inherit;cursor:pointer;}",
  ".tn-btn:hover:not(:disabled){background:var(--dsh-hover,rgba(0,0,0,.05));}",
  ".tn-btn:disabled{opacity:.45;cursor:not-allowed;}",
  ".tn-btn-primary{border-color:var(--dsh-accent,#4a7dff);background:var(--dsh-accent,#4a7dff);color:#fff;}",
  ".tn-btn-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsh-accent,#4a7dff);}",
  ".tn-btn-sm{padding:3px 9px;font-size:12px;}",
  ".tn-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-left:auto;}",
  ".tn-tools .tn-btn{padding:2px 10px;font-size:12px;line-height:1.6;}",
  ".tn-triggers{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;}",
  ".tn-trigger{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--dsh-border,#e3e3e3);border-radius:8px;padding:8px 10px;cursor:pointer;background:transparent;}",
  ".tn-trigger[data-on=\"1\"]{border-color:var(--dsh-accent,#4a7dff);background:rgba(74,125,255,.07);}",
  ".tn-trigger-main{display:flex;flex-direction:column;gap:1px;min-width:0;}",
  ".tn-trigger-name{font-weight:600;}",
  ".tn-trigger-desc{font-size:11px;opacity:.66;line-height:1.35;}",
  ".tn-accounts{display:flex;flex-wrap:wrap;gap:8px;max-height:280px;overflow:auto;padding:2px;}",
  ".tn-acc{display:flex;flex-direction:column;gap:2px;align-items:flex-start;min-width:168px;max-width:100%;text-align:left;border:1px solid var(--dsh-border,#d9d9d9);border-radius:9px;padding:8px 11px;background:transparent;color:inherit;font:inherit;cursor:pointer;}",
  ".tn-acc:hover{background:var(--dsh-hover,rgba(0,0,0,.05));}",
  ".tn-acc[data-on=\"1\"]{border-color:var(--dsh-accent,#4a7dff);background:rgba(74,125,255,.10);box-shadow:0 0 0 2px var(--dsh-accent,#4a7dff) inset;}",
  ".tn-acc[data-off=\"1\"]{opacity:.5;cursor:not-allowed;}",
  ".tn-acc-name{font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".tn-acc-meta{font-size:11px;opacity:.68;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".tn-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:1px 9px;font-size:11px;border:1px solid var(--dsh-border,#d9d9d9);}",
  ".tn-chip-ok{border-color:#3f9c5a;color:#3f9c5a;}",
  ".tn-chip-bad{border-color:#c87b22;color:#c87b22;}",
  ".tn-chip-warn{border-color:#d9534f;color:#d9534f;}",
  ".tn-bar{position:relative;height:8px;border-radius:999px;background:var(--dsh-hover,rgba(0,0,0,.08));overflow:hidden;}",
  ".tn-bar-fill{height:100%;border-radius:999px;background:var(--dsh-accent,#4a7dff);transition:width .22s ease;}",
  ".tn-bar-fill[data-err=\"1\"]{background:#d9534f;}",
  ".tn-bar-fill[data-ok=\"1\"]{background:#3f9c5a;}",
  ".tn-bar-row{display:flex;align-items:center;gap:10px;}",
  ".tn-bar-label{font-size:12px;opacity:.72;white-space:nowrap;}",
  ".tn-log{font-family:Cascadia Mono,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;background:var(--dsh-hover,rgba(0,0,0,.04));border-radius:8px;padding:9px 11px;max-height:220px;overflow:auto;}",
  ".tn-hist{display:flex;flex-direction:column;gap:7px;max-height:320px;overflow:auto;}",
  ".tn-hist-item{display:flex;gap:9px;align-items:flex-start;border-bottom:1px dashed var(--dsh-border,#eee);padding-bottom:7px;}",
  ".tn-hist-main{flex:1 1 auto;min-width:0;}",
  ".tn-hist-when{font-size:11px;opacity:.6;white-space:nowrap;}",
  ".tn-hist-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".tn-empty{opacity:.6;padding:10px 2px;}",
  ".tn-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,300px);gap:14px;align-items:start;}",
  "@media (max-width:900px){.tn-split{grid-template-columns:minmax(0,1fr);}}",
  "@media (max-width:560px){.tn-row > label{min-width:0;width:100%;}.tn-acc{min-width:100%;}}"
]

/**
 * dsh-turn-notify — 浏览器半身（中文界面）。
 *
 * 界面只做三件事：
 *   1. 让人一眼看懂「现在什么情况会发通知」（触发条件 + 发给谁 + 什么时候不发）；
 *   2. 改任何一个开关都**立刻落盘**，不等「保存」按钮（开发规则 g3）；
 *   3. 提供一个「发测试通知」，把「没收到通知」这件事从玄学变成可验证。
 *
 * 三条硬约束：全中文；有真实进度的进度条（不是假动画）；绝不显示/请求任何凭据。
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: '@duma520/dsh-turn-notify',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    /** 与 host 半身一致的 API 前缀。 */
    const API_BASE = '/@duma520/dsh-turn-notify/api'
    /** 侧栏面板 id，main 与 sidebar 必须一致，否则点侧栏切不过去。 */
    const PANEL_ID = 'turn-notify'
    /** 样式表 id，注入一次即可。 */
    const STYLE_ID = 'turn-notify-style'
    /** 本插件声明的插槽依赖。 */
    const inject = ['slots']

    /** 客户端心跳：判断前端半身到底跑没跑起来（与 notify-sender 同一套排错手段）。 */
    const LOAD_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const helloSlots = { settings: false, bundleConfig: false, main: false, panellist: false, panellistActions: false, detailAction: false }

    function reportHello(stage) {
      try {
        const body = JSON.stringify({
          stage,
          loadId: LOAD_ID,
          ua: String(navigator?.userAgent ?? '').slice(0, 300),
          href: String(location?.href ?? '').slice(0, 300),
          visibility: String(document?.visibilityState ?? ''),
          slots: helloSlots,
        })
        fetch(API_BASE + '/hello', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {})
      } catch {
        /* 心跳失败绝不能影响插件 */
      }
    }

    /** 注入样式表（只注入一次）。 */
    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS_LINES.join('\n')
      document.head.appendChild(el)
      return () => { try { el.remove() } catch { /* 忽略 */ } }
    }

    /** 统一的取数封装：网络失败也要给一句人话，不能把异常抛到渲染里。 */
    async function apiGet(path) {
      try {
        const res = await fetch(API_BASE + path, { headers: { accept: 'application/json' } })
        const data = await res.json().catch(() => null)
        if (data === null) return { ok: false, error: '服务端返回的不是 JSON（HTTP ' + res.status + '）' }
        return data
      } catch (error) {
        return { ok: false, error: '请求失败：' + String(error?.message ?? error) }
      }
    }

    async function apiPost(path, payload) {
      try {
        const res = await fetch(API_BASE + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
        const data = await res.json().catch(() => null)
        if (data === null) return { ok: false, error: '服务端返回的不是 JSON（HTTP ' + res.status + '）' }
        return data
      } catch (error) {
        return { ok: false, error: '请求失败：' + String(error?.message ?? error) }
      }
    }

    /** 触发条件的中文说明（与 rules.js 的 TRIGGER_LABELS 一一对应）。 */
    const TRIGGER_ITEMS = [
      { key: 'completed', name: '✅ 回合完成', desc: '正常答完一轮时提醒' },
      { key: 'error', name: '❌ 回合出错', desc: '这一轮报错退出时提醒' },
      { key: 'aborted', name: '⏹ 回合中断', desc: '被用户/父会话打断时提醒' },
      { key: 'maxTokens', name: '✂️ 输出截断', desc: '回复被长度上限截断时提醒' },
      { key: 'timeout', name: '⏰ 任务超时', desc: '一轮跑太久仍未结束时提醒' },
      { key: 'noProgress', name: '😴 长时间无进展', desc: 'N 分钟没有任何新事件时提醒' },
      { key: 'toolFailure', name: '🔧 工具失败', desc: '某次工具调用报错时提醒（较吵，默认关）' },
      { key: 'keyword', name: '🔍 命中关键词', desc: '回复里出现指定词时提醒（默认关）' },
    ]

    /** 一条小进度条：只在有真实阶段时出现，不放假动画。 */
    function ProgressLine(props) {
      const percent = Math.max(0, Math.min(100, Number(props.percent) || 0))
      const state = String(props.state ?? '')
      const fill = state === 'error' ? { 'data-err': '1' } : state === 'done' ? { 'data-ok': '1' } : {}
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('div', { className: 'tn-bar-row' },
          h('div', { className: 'tn-bar', style: { flex: '1 1 auto' } },
            h('div', Object.assign({ className: 'tn-bar-fill', style: { width: percent + '%' } }, fill))
          ),
          h('span', { className: 'tn-bar-label' }, props.label ?? '')
        )
      )
    }

    /**
     * 主界面。
     *
     * compact=true 时用于插件详情页的小卡片（少几块区域），逻辑与整页完全同一份，
     * 避免两套界面行为不一致。
     */
    function TurnNotifyPanel(props) {
      const compact = props?.compact === true
      const [config, setConfig] = useState(null)
      const [meta, setMeta] = useState(null)
      const [accounts, setAccounts] = useState({ list: [], resolved: null, error: '' })
      const [stats, setStats] = useState(null)
      const [history, setHistory] = useState([])
      const [loading, setLoading] = useState(true)
      const [line, setLine] = useState({ percent: 0, label: '正在读取配置…', state: '' })
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [logText, setLogText] = useState('')
      const [selfcheck, setSelfcheck] = useState(null)
      const saveTimer = useRef(null)

      /** 拉一次全量状态（配置 + 账号 + 统计 + 记录）。 */
      const refresh = useCallback(async (showProgress) => {
        if (showProgress === true) setLine({ percent: 15, label: '读取插件信息…', state: '' })
        const info = await apiGet('/info')
        if (showProgress === true) setLine({ percent: 35, label: '读取账号清单…', state: '' })
        const cfg = await apiGet('/config')
        const acc = await apiGet('/accounts')
        if (showProgress === true) setLine({ percent: 70, label: '读取发送记录…', state: '' })
        const st = await apiGet('/stats')
        const hist = await apiGet('/history?limit=30')
        setMeta(info?.ok === true ? info : null)
        setConfig(cfg?.ok === true ? cfg.config : cfg?.config ?? null)
        setAccounts({
          list: Array.isArray(acc?.accounts) ? acc.accounts : [],
          resolved: acc?.resolved ?? null,
          error: String(acc?.error ?? ''),
          hub: acc?.hub ?? null,
        })
        setStats(st?.stats ?? null)
        setHistory(Array.isArray(hist?.entries) ? hist.entries : [])
        setLoading(false)
        if (showProgress === true) setLine({ percent: 100, label: '就绪', state: 'done' })
        // 首次加载若有问题，直接把原因摆在界面上，别让用户去猜
        if (cfg?.ok !== true) setNote('读取配置失败：' + String(cfg?.error ?? '未知原因'))
        else if (acc?.ok !== true && acc?.error) setNote('读取账号失败：' + String(acc.error))
      }, [])

      useEffect(() => { void refresh(true) }, [refresh])

      /**
       * 改任一字段：立刻本地生效 + 防抖 250ms 落盘。
       *
       * 为什么要防抖而不是每次输入都 POST：数字框打字过程中会产生 "3"、"30"、"300"
       * 三次请求，既吵又可能中途落个错误值。250ms 足够合并连续输入，又不影响「实时保存」的体感。
       */
      const patch = useCallback((partial) => {
        setConfig((prev) => {
          const next = mergePatch(prev, partial)
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => {
            void apiPost('/config', partial).then((res) => {
              if (res?.ok !== true) setNote('保存失败：' + String(res?.error ?? '未知原因'))
              else setNote('')
            })
          }, 250)
          return next
        })
      }, [])

      /** 改单个触发开关。 */
      const toggleTrigger = useCallback((key) => {
        const current = config?.triggers ?? {}
        patch({ triggers: { [key]: current[key] !== true } })
      }, [config, patch])

      /** 一键全选 / 全不选触发条件。 */
      const setAllTriggers = useCallback((on) => {
        const next = {}
        for (const item of TRIGGER_ITEMS) next[item.key] = on === true
        patch({ triggers: next })
      }, [patch])

      /** 选/取消一个账号（空数组 = 沿用通知发送器的选择）。 */
      const toggleAccount = useCallback((id) => {
        const list = Array.isArray(config?.targetAccountIds) ? config.targetAccountIds.slice() : []
        const idx = list.indexOf(id)
        if (idx >= 0) list.splice(idx, 1)
        else list.push(id)
        patch({ targetAccountIds: list })
      }, [config, patch])

      /** 一键全选 / 全不选账号。全不选 = 清空 = 回到「跟随通知发送器」。 */
      const setAllAccounts = useCallback((on) => {
        if (on !== true) { patch({ targetAccountIds: [] }); return }
        const ids = (Array.isArray(accounts.list) ? accounts.list : [])
          .filter((item) => item?.usable === true)
          .map((item) => String(item.id ?? ''))
          .filter((id) => id !== '')
        patch({ targetAccountIds: ids })
      }, [accounts.list, patch])

      /** 发测试通知：真的走一遍链路，进度按真实阶段推进。 */
      const runTest = useCallback(async (dryRun) => {
        setBusy(true)
        setNote('')
        setLine({ percent: 20, label: dryRun === true ? '演练中…' : '正在发送测试通知…', state: '' })
        const res = await apiPost('/test', { dryRun: dryRun === true })
        if (res?.ok === true) {
          setLine({ percent: 100, label: dryRun === true ? '演练完成（未真发）' : '发送成功', state: 'done' })
          const okCount = Number(res.sent) || 0
          const fail = Number(res.failed) || 0
          setNote(dryRun === true ? '演练完成：链路与账号都正常，切换成「真发」即会送达。' : '已发出 ' + okCount + ' 条' + (fail > 0 ? '，失败 ' + fail + ' 条（看下面明细）' : ''))
        } else {
          setLine({ percent: 100, label: '发送失败', state: 'error' })
          setNote('发送失败：' + String(res?.error ?? '未知原因'))
        }
        setBusy(false)
        void refresh(false)
      }, [refresh])

      /** 刷新账号（通知发送器那边刚加了账号时用）。 */
      const refreshAccounts = useCallback(async () => {
        setBusy(true)
        setLine({ percent: 40, label: '重新读取账号…', state: '' })
        await apiPost('/accounts/refresh', {})
        await refresh(false)
        setLine({ percent: 100, label: '账号已刷新', state: 'done' })
        setBusy(false)
      }, [refresh])

      /** 自检：把「为什么没收到通知」的每一环摊开。 */
      const runSelfCheck = useCallback(async () => {
        setBusy(true)
        setLine({ percent: 30, label: '检查配置…', state: '' })
        const res = await apiGet('/selfcheck')
        setSelfcheck(res?.ok === true || Array.isArray(res?.steps) ? res : null)
        setLine({ percent: 100, label: res?.ok === true ? '自检通过' : '自检发现问题', state: res?.ok === true ? 'done' : 'error' })
        setBusy(false)
      }, [])

      /** 看日志（只有出错才写，正常是空的）。 */
      const loadLog = useCallback(async () => {
        const res = await apiGet('/log?limit=200')
        const lines = Array.isArray(res?.lines) ? res.lines : []
        setLogText(lines.length > 0 ? lines.join('\n') : String(res?.note ?? '还没有日志（正常运行时不会写日志）'))
      }, [])

      if (loading === true) {
        return h('div', { className: 'tn-wrap' },
          h('div', { className: 'tn-card' },
            h('div', { className: 'tn-title' }, '回合通知'),
            h(ProgressLine, { percent: 40, label: '正在加载…', state: '' })
          )
        )
      }

      const triggers = config?.triggers ?? {}
      const quiet = config?.quietHours ?? { enabled: false, start: '23:00', end: '08:00' }
      const picked = Array.isArray(config?.targetAccountIds) ? config.targetAccountIds : []
      const resolved = accounts.resolved ?? null
      const enabledCount = TRIGGER_ITEMS.filter((it) => triggers[it.key] === true).length

      return h('div', { className: 'tn-wrap' },
        // ── 顶部状态条 ────────────────────────────────────────────────
        h('div', { className: 'tn-card' },
          h('div', { className: 'tn-title' },
            '回合通知',
            h('span', { className: 'tn-chip' }, 'v' + String(meta?.version ?? '?' )),
            h('span', { className: config?.enabled === true ? 'tn-chip tn-chip-ok' : 'tn-chip tn-chip-bad' },
              config?.enabled === true ? '已启用' : '已停用'),
            config?.dryRun === true ? h('span', { className: 'tn-chip tn-chip-warn' }, '试运行') : null,
            h('span', { className: 'tn-chip' }, enabledCount + ' 个触发条件')
          ),
          h('div', { className: 'tn-hint' },
            '每轮对话结束时，如果满足下面勾选的条件，就往「通知发送器」已选好的账号发一条提醒。不用再盯着屏幕等结果。'),
          h('div', { className: 'tn-row', style: { marginTop: '10px' } },
            h('label', null, '总开关'),
            h('button', {
              className: config?.enabled === true ? 'tn-btn tn-btn-primary' : 'tn-btn',
              type: 'button',
              disabled: busy,
              onClick: () => patch({ enabled: config?.enabled !== true }),
            }, config?.enabled === true ? '已启用（点击停用）' : '已停用（点击启用）'),
            h('label', null, '试运行'),
            h('button', {
              className: config?.dryRun === true ? 'tn-btn tn-btn-primary' : 'tn-btn',
              type: 'button',
              disabled: busy,
              onClick: () => patch({ dryRun: config?.dryRun !== true }),
            }, config?.dryRun === true ? '开（只记录不真发）' : '关（真发）'),
            h('div', { className: 'tn-grow' }),
            h('button', { className: 'tn-btn', type: 'button', disabled: busy, onClick: () => { void refresh(true) } }, '刷新'),
            h('button', { className: 'tn-btn', type: 'button', disabled: busy, onClick: () => { void runSelfCheck() } }, '自检')
          ),
          note !== '' ? h('div', { className: 'tn-hint', style: { marginTop: '8px', color: '#c87b22' } }, note) : null
        ),

        // ── 进度条（有动作才动） ───────────────────────────────────────
        line.percent > 0 && line.percent < 100
          ? h('div', { className: 'tn-card' }, h(ProgressLine, { percent: line.percent, label: line.label, state: line.state }))
          : null,

        // ── 触发条件 ─────────────────────────────────────────────────
        h('div', { className: 'tn-card' },
          h('div', { className: 'tn-title' },
            '什么时候发通知',
            h('span', { className: enabledCount === TRIGGER_ITEMS.length ? 'tn-chip tn-chip-ok' : 'tn-chip' },
              '已选 ' + String(enabledCount) + ' / ' + String(TRIGGER_ITEMS.length)),
            h('div', { className: 'tn-tools' },
              h('button', { className: 'tn-btn', type: 'button', disabled: busy, onClick: () => setAllTriggers(true) }, '全选'),
              h('button', { className: 'tn-btn', type: 'button', disabled: busy, onClick: () => setAllTriggers(false) }, '全不选')
            )
          ),
          h('div', { className: 'tn-hint', style: { marginBottom: '10px' } },
            '点卡片就能勾上或取消，可以同时勾好几个。默认只勾前四项（完成/出错/中断/截断）—— 这四种是「一轮真的结束了」的信号。'),
          h('div', { className: 'tn-triggers' },
            TRIGGER_ITEMS.map((item) => h('div', {
              key: item.key,
              className: 'tn-trigger',
              'data-on': triggers[item.key] === true ? '1' : '0',
              onClick: () => { if (busy !== true) toggleTrigger(item.key) },
              style: { cursor: busy === true ? 'not-allowed' : 'pointer' },
            },
              h('input', {
                type: 'checkbox',
                checked: triggers[item.key] === true,
                readOnly: true,
                style: { marginTop: '3px' },
              }),
              h('div', { className: 'tn-trigger-main' },
                h('div', { className: 'tn-trigger-name' }, item.name),
                h('div', { className: 'tn-trigger-desc' }, item.desc)
              )
            ))
          ),
          triggers.timeout === true
            ? h('div', { className: 'tn-row', style: { marginTop: '10px' } },
                h('label', null, '超时阈值'),
                h('input', {
                  className: 'tn-num', type: 'number', min: 1, max: 720,
                  value: Number(config?.timeoutMinutes ?? 30),
                  onChange: (e) => patch({ timeoutMinutes: Number(e.target.value) }),
                }),
                h('span', { className: 'tn-hint' }, '分钟（一轮超过这个时长还没结束就提醒）')
              )
            : null,
          triggers.noProgress === true
            ? h('div', { className: 'tn-row', style: { marginTop: '10px' } },
                h('label', null, '无进展阈值'),
                h('input', {
                  className: 'tn-num', type: 'number', min: 1, max: 720,
                  value: Number(config?.noProgressMinutes ?? 10),
                  onChange: (e) => patch({ noProgressMinutes: Number(e.target.value) }),
                }),
                h('span', { className: 'tn-hint' }, '分钟（这么久没有任何新事件就提醒）')
              )
            : null,
          triggers.keyword === true
            ? h('div', { className: 'tn-row', style: { marginTop: '10px' } },
                h('label', null, '关键词'),
                h('input', {
                  className: 'tn-field tn-grow', type: 'text',
                  value: Array.isArray(config?.keywords) ? config.keywords.join('、') : '',
                  placeholder: '用中文顿号或逗号分隔，例如：失败、报错、无法完成',
                  onChange: (e) => patch({ keywords: String(e.target.value).split(/[、,，\s]+/).filter((s) => s !== '') }),
                })
              )
            : null
        ),

        // ── 发给谁 ───────────────────────────────────────────────────
        h('div', { className: 'tn-card' },
          h('div', { className: 'tn-title' },
            '发给谁',
            resolved?.ok === true
              ? h('span', { className: 'tn-chip tn-chip-ok' }, '将发到 ' + String(resolved.count) + ' 个账号')
              : h('span', { className: 'tn-chip tn-chip-bad' }, '还没有可用的目标'),
            h('div', { className: 'tn-tools' },
              h('button', { className: 'tn-btn', type: 'button', disabled: busy, onClick: () => setAllAccounts(true) }, '全选可用'),
              h('button', { className: 'tn-btn', type: 'button', disabled: busy, onClick: () => setAllAccounts(false) }, '清空（回到跟随）')
            )
          ),
          h('div', { className: 'tn-hint', style: { marginBottom: '10px' } },
            picked.length === 0
              ? '当前是「跟随通知发送器」：它选哪几个，这里就发给哪几个。想单独指定就在这里勾。'
              : '当前是本插件自选：只发下面勾选的账号。全部取消勾选会回到「跟随通知发送器」。'),
          accounts.list.length === 0
            ? h('div', { className: 'tn-empty' },
                '没有读到任何账号。' + (accounts.error !== '' ? '原因：' + accounts.error : '请先在「通知发送器」里确认至少有一个可用账号。'))
            : h('div', { className: 'tn-accounts' },
                accounts.list.map((item) => {
                  const id = String(item.id ?? '')
                  const on = picked.indexOf(id) >= 0
                  const usable = item.usable === true
                  return h('div', {
                    key: id,
                    className: 'tn-acc',
                    'data-on': on ? '1' : '0',
                    'data-off': usable ? '0' : '1',
                    onClick: () => { if (usable === true && busy !== true) toggleAccount(id) },
                  },
                    h('div', { className: 'tn-acc-name' }, String(item.name ?? id)),
                    h('div', { className: 'tn-acc-meta' }, String(item.channel ?? '') + ' · ' + String(item.source ?? '')),
                    h('div', { className: 'tn-acc-meta' }, usable ? (on ? '已选' : '可用') : '缺凭据，不可用')
                  )
                })
              ),
          h('div', { className: 'tn-row', style: { marginTop: '10px' } },
            h('button', { className: 'tn-btn', type: 'button', disabled: busy, onClick: () => { void refreshAccounts() } }, '刷新账号'),
            h('button', { className: 'tn-btn', type: 'button', disabled: busy, onClick: () => { void runTest(true) } }, '演练一次（不真发）'),
            h('button', { className: 'tn-btn tn-btn-primary', type: 'button', disabled: busy, onClick: () => { void runTest(false) } }, '发一条测试通知')
          )
        ),

        // ── 什么时候不发 ─────────────────────────────────────────────
        h('div', { className: 'tn-card' },
          h('div', { className: 'tn-title' }, '什么时候不发（防止吵）'),
          h('div', { className: 'tn-row' },
            h('label', null, '冷却时间'),
            h('input', {
              className: 'tn-num', type: 'number', min: 0, max: 3600,
              value: Number(config?.cooldownSeconds ?? 90),
              onChange: (e) => patch({ cooldownSeconds: Number(e.target.value) }),
            }),
            h('span', { className: 'tn-hint' }, '秒（同一个会话里连续触发时，至少隔这么久才再发）')
          ),
          h('div', { className: 'tn-row', style: { marginTop: '10px' } },
            h('label', null, '静默时段'),
            h('button', {
              className: quiet.enabled === true ? 'tn-btn tn-btn-primary' : 'tn-btn',
              type: 'button',
              disabled: busy,
              onClick: () => patch({ quietHours: { enabled: quiet.enabled !== true } }),
            }, quiet.enabled === true ? '已开启' : '已关闭'),
            h('input', {
              className: 'tn-num', type: 'time', value: String(quiet.start ?? '23:00'),
              disabled: quiet.enabled !== true,
              onChange: (e) => patch({ quietHours: { start: String(e.target.value) } }),
            }),
            h('span', { className: 'tn-hint' }, '到'),
            h('input', {
              className: 'tn-num', type: 'time', value: String(quiet.end ?? '08:00'),
              disabled: quiet.enabled !== true,
              onChange: (e) => patch({ quietHours: { end: String(e.target.value) } }),
            }),
            h('span', { className: 'tn-hint' }, '（这段时间内一律不发）')
          ),
          h('div', { className: 'tn-row', style: { marginTop: '10px' } },
            h('label', null, '排除工作区'),
            h('input', {
              className: 'tn-field tn-grow', type: 'text',
              value: Array.isArray(config?.excludeCwdPrefixes) ? config.excludeCwdPrefixes.join('、') : '',
              placeholder: '路径前缀，用顿号分隔；例如 G:\\临时项目',
              onChange: (e) => patch({ excludeCwdPrefixes: String(e.target.value).split(/[、,，\n]+/).map((s) => s.trim()).filter((s) => s !== '') }),
            })
          ),
          h('div', { className: 'tn-row', style: { marginTop: '10px' } },
            h('label', null, '排除会话'),
            h('input', {
              className: 'tn-field tn-grow', type: 'text',
              value: Array.isArray(config?.excludeSessionIds) ? config.excludeSessionIds.join('、') : '',
              placeholder: '会话 id（可只写前几位），用顿号分隔',
              onChange: (e) => patch({ excludeSessionIds: String(e.target.value).split(/[、,，\n]+/).map((s) => s.trim()).filter((s) => s !== '') }),
            })
          ),
          h('div', { className: 'tn-row', style: { marginTop: '10px' } },
            h('label', null, 'IM 发起的对话'),
            h('button', {
              className: config?.skipImOriginated === true ? 'tn-btn tn-btn-primary' : 'tn-btn',
              type: 'button',
              disabled: busy,
              onClick: () => patch({ skipImOriginated: config?.skipImOriginated !== true }),
            }, config?.skipImOriginated === true ? '跳过（推荐）' : '照发'),
            h('span', { className: 'tn-hint' }, '这轮对话是从微信/QQ/飞书/Telegram 发起的，你本来就在那边等着，不再重复推一条')
          ),
          h('div', { className: 'tn-row', style: { marginTop: '10px' } },
            h('label', null, '标题前缀'),
            h('input', {
              className: 'tn-field tn-grow', type: 'text',
              value: String(config?.titlePrefix ?? ''),
              onChange: (e) => patch({ titlePrefix: String(e.target.value) }),
            }),
            h('label', null, '摘要字数'),
            h('input', {
              className: 'tn-num', type: 'number', min: 50, max: 2000,
              value: Number(config?.excerptChars ?? 300),
              onChange: (e) => patch({ excerptChars: Number(e.target.value) }),
            })
          )
        ),

        // ── 运行统计 + 自检结果 ──────────────────────────────────────
        h('div', { className: 'tn-split' },
          h('div', { className: 'tn-card' },
            h('div', { className: 'tn-title' }, '运行情况'),
            h('div', { className: 'tn-row' },
              h('span', { className: 'tn-chip tn-chip-ok' }, '已发 ' + String(stats?.sent ?? 0)),
              h('span', { className: 'tn-chip' }, '跳过 ' + String(stats?.skipped ?? 0)),
              h('span', { className: stats?.failed > 0 ? 'tn-chip tn-chip-bad' : 'tn-chip' }, '失败 ' + String(stats?.failed ?? 0))
            ),
            stats?.lastReason ? h('div', { className: 'tn-hint', style: { marginTop: '8px' } }, '最近判定：' + String(stats.lastReason)) : null,
            stats?.lastAt ? h('div', { className: 'tn-hint' }, '最近发送：' + String(stats.lastAt)) : null,
            stats?.lastError ? h('div', { className: 'tn-hint', style: { color: '#c87b22' } }, '最近错误：' + String(stats.lastError)) : null,
            h('div', { className: 'tn-row', style: { marginTop: '10px' } },
              h('button', { className: 'tn-btn tn-btn-sm', type: 'button', onClick: () => { void loadLog() } }, '看日志'),
              h('button', { className: 'tn-btn tn-btn-sm', type: 'button', onClick: () => { void refresh(false) } }, '刷新统计')
            ),
            logText !== '' ? h('div', { className: 'tn-log', style: { marginTop: '8px' } }, logText) : null
          ),
          selfcheck !== null
            ? h('div', { className: 'tn-card' },
                h('div', { className: 'tn-title' }, '自检结果'),
                h('div', { className: 'tn-hint', style: { marginBottom: '8px' } },
                  selfcheck?.ok === true ? '全部正常。' : '发现问题：' + (Array.isArray(selfcheck?.issues) ? selfcheck.issues.join('；') : '见下')),
                (Array.isArray(selfcheck?.steps) ? selfcheck.steps : []).map((step, i) => h('div', {
                  key: 'step-' + i,
                  className: 'tn-hint',
                  style: { color: step.ok === true ? '#3f9c5a' : '#c87b22' },
                }, (step.ok === true ? '✓ ' : '✗ ') + String(step.step ?? '') + '：' + String(step.detail ?? '')))
              )
            : null
        ),

        // ── 发送记录 ─────────────────────────────────────────────────
        compact !== true
          ? h('div', { className: 'tn-card' },
              h('div', { className: 'tn-title' }, '最近的发送记录'),
              history.length === 0
                ? h('div', { className: 'tn-empty' }, '还没有记录。等第一次回合结束，或点上面的「发一条测试通知」。')
                : h('div', { className: 'tn-hist' },
                    history.map((item, i) => h('div', { key: 'hist-' + i, className: 'tn-hist-item' },
                      h('span', { className: item.ok === true ? 'tn-chip tn-chip-ok' : 'tn-chip tn-chip-bad' },
                        item.ok === true ? '成功' : '失败'),
                      h('div', { className: 'tn-hist-main' },
                        h('div', { className: 'tn-hist-text' }, String(item.title ?? '（无标题）')),
                        h('div', { className: 'tn-hint tn-hist-text' },
                          String(item.sessionTitle ?? '（未命名会话）') + ' · ' + String(item.reason ?? '') + (item.detail ? ' · ' + String(item.detail) : '')),
                        h('div', { className: 'tn-hint tn-hist-text' }, String(item.preview ?? ''))
                      ),
                      h('span', { className: 'tn-hist-when' }, String(item.at ?? '').replace('T', ' ').slice(0, 19))
                    ))
                  )
            )
          : null
      )
    }

    /** 设置区里的一块（设置 → 左侧「回合通知」）。 */
    function SettingsSection() {
      return h(TurnNotifyPanel, { compact: false })
    }

    /** 侧栏图标。 */
    function SidebarIcon() {
      return h('span', { className: 'tn-chip', style: { padding: '1px 8px' } }, '🔔')
    }

    /** 侧栏文字行。 */
    function SidebarActionRow(props) {
      const [hot, setHot] = useState(false)
      return h('button', {
        className: 'tn-btn',
        type: 'button',
        onMouseEnter: () => setHot(true),
        onMouseLeave: () => setHot(false),
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          background: hot ? 'var(--dsh-hover, rgba(128,128,128,.14))' : 'transparent',
          border: 'none', cursor: 'pointer', padding: '6px 8px', borderRadius: '6px',
          fontSize: '14px', lineHeight: '22px', color: 'inherit', textAlign: 'left', font: 'inherit',
        },
      },
        h('span', { style: { flex: 'none', width: '16px', textAlign: 'center', opacity: 0.8 } }, '🔔'),
        h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '回合通知'),
        h('span', { style: { flex: 'none', fontSize: '11px', opacity: 0.55 } }, '结束提醒')
      )
    }

    /** 插件详情页的「打开回合通知」。 */
    function OpenPanelAction(props) {
      const onOpen = props !== null && props !== undefined && typeof props.onOpen === 'function' ? props.onOpen : null
      return h('button', {
        className: 'tn-btn',
        type: 'button',
        onClick: () => { if (onOpen !== null) onOpen() },
      }, '打开回合通知')
    }

    /** 整页 + 侧栏 + 详情页按钮。任何一步失败只丢那一个入口，绝不让整个插件激活失败。 */
    function installPanelEntry(ctx) {
      if (typeof ctx.inject !== 'function') return () => {}
      try {
        return ctx.inject(['layout'], (pageCtx) => {
          if (!pageCtx || typeof pageCtx.slots?.inject !== 'function') return () => {}
          const stops = []
          stops.push(pageCtx.slots.inject('main', () => pageCtx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, () => h(TurnNotifyPanel, { compact: false }))))
          stops.push(pageCtx.slots.inject('sidebar.panellist', () => pageCtx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 42,
            label: () => '回合通知',
          }, SidebarIcon)))
          stops.push(pageCtx.slots.inject('sidebar.panellist.actions', () => pageCtx.slots.register({
            name: 'sidebar.panellist.actions',
            id: 'turn-notify-row',
            order: -98,
            label: () => '回合通知',
          }, SidebarActionRow)))
          stops.push(pageCtx.slots.inject('plugins.detail.actions', () => pageCtx.slots.register({
            name: 'plugins.detail.actions',
            id: PANEL_ID + '-open',
            order: 22,
            inject: () => ({
              packageName: '@duma520/dsh-turn-notify',
              onOpen: () => pageCtx.layout.selectPanel(PANEL_ID),
            }),
          }, OpenPanelAction)))
          helloSlots.main = true
          helloSlots.panellist = true
          helloSlots.panellistActions = true
          helloSlots.detailAction = true
          reportHello('layout-registered')
          return () => {
            for (const stop of stops) {
              try { if (typeof stop === 'function') stop() } catch { /* 卸载失败不影响其它入口 */ }
            }
          }
        })
      } catch (error) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[turn-notify] 侧栏入口注册失败，已跳过：' + String((error && error.message) || error))
        }
        return () => {}
      }
    }

    function apply(ctx) {
      reportHello('apply-start')
      ctx.effect(() => installStyle(), 'turn-notify: 样式表')

      ctx.effect(() => ctx.slots.inject('settings.section', () => {
        const stop = ctx.slots.register({
          name: 'settings.section',
          id: 'turn-notify',
          order: 40,
          label: () => '回合通知',
        }, SettingsSection)
        helloSlots.settings = true
        reportHello('settings-registered')
        return stop
      }), 'turn-notify: 设置分区')

      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => {
        const stop = ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@duma520/dsh-turn-notify',
        }, () => h(TurnNotifyPanel, { compact: true }))
        helloSlots.bundleConfig = true
        reportHello('bundle-config-registered')
        return stop
      }), 'turn-notify: 插件详情页配置区')

      ctx.effect(() => installPanelEntry(ctx), 'turn-notify: 侧栏入口')
      reportHello('apply-done')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = '@duma520/dsh-turn-notify'
    return module.exports
  },
})
