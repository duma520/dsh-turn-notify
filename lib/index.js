/**
 * dsh-turn-notify — Host 半身。
 *
 * 定位：**只在回合结束时提醒你**。它不接收消息、不建立任何连接，
 * 只是订阅宿主已经有的回合事件流，按用户设的条件判断「这一轮该不该发通知」，
 * 需要发的时候交给「通知发送器」用它已经配好的账号发出去。
 *
 * 为什么单独做一个插件、而不是塞进通知发送器：
 *  通知发送器是「手动/被调用才发」的发送器，语义干净；
 *  自动提醒是「事件驱动 + 有规则引擎 + 有冷却/静默/排除」的另一件事。
 *  混在一起会让发送器多出一堆它不该关心的状态，也难单独关掉。
 *
 * 三层职责（与 notify-sender 同构，便于互相抄作业）：
 *  1. /api 路由：给中文设置页与外部脚本用；
 *  2. 工具：让 AI 也能查状态 / 改配置 / 发测试通知；
 *  3. 事件订阅：ctx.on('session/event', ...) → watcher.js。
 *
 * 所有设置实时落盘（~/.dsh/dsh-turn-notify/config.json），不依赖「保存」按钮。
 *
 * @module index.js
 */

import { readFileSync } from 'node:fs'

import * as paths from './paths.js'
import * as bridge from './bridge.js'
import * as watcher from './watcher.js'
import * as changes from './changes.js'
import { TRIGGER_KEYS, TRIGGER_LABELS, mapTurnEndKind } from './rules.js'

/** 外部调用的 API 前缀（与包名一致，便于记忆）。 */
const API_PREFIX = '/@duma520/dsh-turn-notify/api'

export const name = '@duma520/dsh-turn-notify'

/**
 * 需要的宿主能力。
 *
 * sessions：拿会话对象（header.cwd、events 事件流）与订阅 session/event；
 * webServer：注册 /api 路由给前端；
 * tools：注册工具给 AI。
 */
export const inject = ['webServer', 'tools', 'sessions']

/** 版本号只有 package.json 一个来源，避免 /info 与包版本不同步。 */
function readVersion() {
  try {
    const meta = JSON.parse(readFileSync(paths.PKG_ROOT + '/package.json', 'utf8'))
    return typeof meta?.version === 'string' ? meta.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 客户端心跳：判断前端半身到底跑没跑起来（与 notify-sender 同一套排错手段）。 */
const clientHello = { at: '', stage: '', loadId: '', ua: '', href: '', visibility: '', slots: null, note: '' }

/** 读请求体并解析 JSON；空体返回 {}，非法 JSON 返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readQuery(req) {
  try {
    return new URL(String(req?.url ?? ''), 'http://127.0.0.1').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** 配置摘要（给界面顶部信息条 / 工具输出用，只读不写）。 */
function configSummary(config) {
  const triggers = []
  for (const key of Object.keys(TRIGGER_KEYS)) {
    if (config?.triggers?.[key] === true) triggers.push(TRIGGER_LABELS[key] ?? key)
  }
  return {
    enabled: config?.enabled === true,
    triggers,
    targetAccountIds: Array.isArray(config?.targetAccountIds) ? config.targetAccountIds : [],
    dryRun: config?.dryRun === true,
    cooldownSeconds: Number(config?.cooldownSeconds) || 0,
    quietHours: config?.quietHours ?? null,
    excludeSessionIds: Array.isArray(config?.excludeSessionIds) ? config.excludeSessionIds.length : 0,
    excludeCwdPrefixes: Array.isArray(config?.excludeCwdPrefixes) ? config.excludeCwdPrefixes.length : 0,
  }
}

/**
 * 自检：把「为什么没收到通知」的每一环都摊开。
 *
 * 顺序与真实链路的顺序一致：插件起来了吗 → 配置能写吗 → 通知发送器找得到吗 →
 * 账号选了吗、可用吗 → 事件订阅上了吗。
 */
async function selfCheck(ctx) {
  const out = {
    ok: false,
    version: readVersion(),
    name,
    dataDir: paths.DATA_DIR,
    configPath: paths.CONFIG_PATH,
    historyPath: paths.HISTORY_PATH,
    logPath: paths.LOG_PATH,
    steps: [],
    issues: [],
  }

  const push = (step, ok, detail) => {
    out.steps.push({ step, ok, detail: String(detail ?? '') })
    if (ok !== true) out.issues.push(step + '：' + String(detail ?? ''))
  }

  // 1. 配置可读可写
  let config = null
  try {
    config = paths.readConfig()
    push('读取配置', true, paths.CONFIG_PATH)
  } catch (error) {
    push('读取配置', false, String(error?.message ?? error))
  }
  if (config !== null) {
    const written = paths.writeConfig(config)
    push('写入配置', written === true, written === true ? '可写' : '写盘失败（目录权限？）')
  }

  // 2. 通知发送器找得到
  const dirs = bridge.candidateSenderDirs()
  push('定位通知发送器', dirs.length > 0, dirs.length > 0 ? dirs[0] : '没找到 @duma520/dsh-notify-sender')

  // 3. 账号聚合 + 目标解析
  const accounts = await bridge.listAccounts()
  push('读取账号清单', accounts.ok === true, accounts.ok === true ? accounts.list.length + ' 个账号' : String(accounts.error ?? ''))
  const resolved = await bridge.resolveTargets(config ?? {})
  push('解析发送目标', resolved.ok === true,
    resolved.ok === true
      ? resolved.targets.length + ' 个可用目标' + (resolved.fromSender === true ? '（沿用通知发送器的选择）' : '（本插件自选）')
      : String(resolved.error ?? ''))

  // 3.5 配置与代码的触发键是否对齐（后端跑旧模块的典型症状）
  const unknownOnDisk = paths.unknownTriggerKeysOnDisk()
  push('配置与代码对齐', unknownOnDisk.length === 0,
    unknownOnDisk.length === 0
      ? Object.keys(paths.defaultConfig().triggers).length + ' 个触发条件，一致'
      : 'config.json 里有本模块不认识的触发条件（' + unknownOnDisk.join('、') + '）—— 插件后端还是旧代码，重启 DSH 后生效')

  // 4. 事件订阅状态
  push('事件订阅', typeof ctx?.on === 'function', typeof ctx?.on === 'function' ? "session/event 已订阅" : '当前上下文拿不到 on()，订阅未建立')

  // 4.5 变化类数据源：不真查外部接口（自检是只读的），只报「会怎么取数」
  const changeRun = watcher.changeSnapshot()
  const wantBalance = config?.triggers?.balanceChange === true
  const wantCredits = config?.triggers?.creditsChange === true
  const wantPlugin = config?.triggers?.creditsPluginChange === true
  const wantToken = config?.triggers?.tokenChange === true
  const wantAny = wantBalance || wantCredits || wantToken || wantPlugin
  push('变化通知数据源', true,
    wantAny !== true
      ? '四项变化通知都未开启（开启后才需要数据源）'
      : [
        wantBalance ? '余额：查询 api.deepseek.com/user/balance（无可用 Key 时读本机快照，并标注非实时）' : '',
        wantCredits ? '积分：查询本机 dsh-connect-workbuddy 用量接口' : '',
        wantPlugin
          ? '积分（多账号）：查询 dsh-connect-workbuddy 的 account-credits，一次取全部账号；间隔 '
            + String(config?.changes?.creditsPluginIntervalMinutes ?? 2) + ' 分钟（每账号一次上游调用）'
          : '',
        wantToken ? 'Token：从会话事件的 usage 自行累加（累计 ' + String(changeRun.tokenTotal ?? 0) + '）' : '',
      ].filter(Boolean).join('；'))

  // 4.6 回合结算：自检同样只报「会怎么出账」，不真查。
  const settleOn = config?.triggers?.turnSettle === true
  push('回合结算（每轮完成时出账）', true,
    settleOn !== true
      ? '未开启（开启后每轮结束会查一次余额/积分并汇总本轮 Token）'
      : [
        config?.triggers?.settleToken === true ? 'Token：本轮精确累加（零 IO）' : '',
        config?.triggers?.settleBalance === true ? '余额：回合末查一次（受查询间隔约束）' : '',
        config?.triggers?.settleCredits === true ? '积分：回合末查一次（受查询间隔约束）' : '',
      ].filter(Boolean).join('；') || '已开启但三项都没勾选，不会发送')

  // 5. 运行统计
  const stats = watcher.statsSnapshot()
  push('运行统计', true, '已发 ' + stats.sent + ' 条 / 跳过 ' + stats.skipped + ' 次 / 失败 ' + stats.failed + ' 条')

  out.config = configSummary(config ?? {})
  out.stats = stats
  out.accounts = accounts.ok === true ? accounts.list.length : 0
  out.ok = out.issues.length === 0
  return out
}

/**
 * 设置合并：只接受白名单键，逐项做类型归一。
 *
 * 为什么不直接 Object.assign：前端传来的任何脏值都会原样落盘，
 * 下次读出来就是个坏配置（例如 cooldownSeconds 变成 "abc"）。这里一次性挡住。
 */
function mergeSettings(current, patch) {
  const base = current ?? paths.defaultConfig()
  const next = paths.defaultConfig()
  // 先继承现有值，再叠加 patch
  Object.assign(next, base)
  next.triggers = { ...paths.defaultConfig().triggers, ...(base?.triggers ?? {}) }
  next.quietHours = { ...paths.defaultConfig().quietHours, ...(base?.quietHours ?? {}) }
  next.keywords = paths.toStringArray(base?.keywords)
  next.targetAccountIds = paths.toStringArray(base?.targetAccountIds)
  next.excludeSessionIds = paths.toStringArray(base?.excludeSessionIds)
  next.excludeCwdPrefixes = paths.toStringArray(base?.excludeCwdPrefixes)

  if (patch === null || typeof patch !== 'object') return paths.mergeConfig(next, {})

  if (Object.hasOwn(patch, 'enabled')) next.enabled = patch.enabled === true
  if (Object.hasOwn(patch, 'dryRun')) next.dryRun = patch.dryRun === true
  if (Object.hasOwn(patch, 'titlePrefix')) next.titlePrefix = String(patch.titlePrefix ?? '').slice(0, 60) || paths.defaultConfig().titlePrefix
  if (Object.hasOwn(patch, 'excerptChars')) next.excerptChars = paths.clampInt(patch.excerptChars, 50, 2000, paths.defaultConfig().excerptChars)
  if (Object.hasOwn(patch, 'cooldownSeconds')) next.cooldownSeconds = paths.clampInt(patch.cooldownSeconds, 0, 3600, paths.defaultConfig().cooldownSeconds)
  if (Object.hasOwn(patch, 'timeoutMinutes')) next.timeoutMinutes = paths.clampInt(patch.timeoutMinutes, 1, 720, paths.defaultConfig().timeoutMinutes)
  if (Object.hasOwn(patch, 'noProgressMinutes')) next.noProgressMinutes = paths.clampInt(patch.noProgressMinutes, 1, 720, paths.defaultConfig().noProgressMinutes)
  if (Object.hasOwn(patch, 'keywords')) next.keywords = paths.toStringArray(patch.keywords).slice(0, 50)
  if (Object.hasOwn(patch, 'targetAccountIds')) next.targetAccountIds = paths.toStringArray(patch.targetAccountIds)
  if (Object.hasOwn(patch, 'excludeSessionIds')) next.excludeSessionIds = paths.toStringArray(patch.excludeSessionIds)
  if (Object.hasOwn(patch, 'excludeCwdPrefixes')) next.excludeCwdPrefixes = paths.toStringArray(patch.excludeCwdPrefixes)

  if (patch.triggers && typeof patch.triggers === 'object') {
    for (const key of Object.keys(paths.defaultConfig().triggers)) {
      if (Object.hasOwn(patch.triggers, key)) next.triggers[key] = patch.triggers[key] === true
    }
  }
  // 变化类阈值：金额 / 积分是小数，不能用 clampInt 取整。
  const changeDefaults = paths.defaultConfig().changes
  next.changes = { ...changeDefaults, ...(base?.changes ?? {}) }
  if (patch.changes && typeof patch.changes === 'object') {
    const c = patch.changes
    if (Object.hasOwn(c, 'balanceMinDelta')) next.changes.balanceMinDelta = paths.clampNumber(c.balanceMinDelta, 0.01, 100000, changeDefaults.balanceMinDelta)
    if (Object.hasOwn(c, 'tokenMinDelta')) next.changes.tokenMinDelta = paths.clampInt(c.tokenMinDelta, 1, 100000000, changeDefaults.tokenMinDelta)
    if (Object.hasOwn(c, 'creditsMinDelta')) next.changes.creditsMinDelta = paths.clampNumber(c.creditsMinDelta, 0.01, 100000, changeDefaults.creditsMinDelta)
    if (Object.hasOwn(c, 'region')) next.changes.region = String(c.region ?? '') === 'global' ? 'global' : 'cn'
    if (Object.hasOwn(c, 'probeIntervalMinutes')) next.changes.probeIntervalMinutes = paths.clampInt(c.probeIntervalMinutes, 1, 1440, changeDefaults.probeIntervalMinutes)
    if (Object.hasOwn(c, 'creditsPluginMinDelta')) next.changes.creditsPluginMinDelta = paths.clampNumber(c.creditsPluginMinDelta, 0.01, 100000, changeDefaults.creditsPluginMinDelta)
    if (Object.hasOwn(c, 'creditsPluginIntervalMinutes')) next.changes.creditsPluginIntervalMinutes = paths.clampInt(c.creditsPluginIntervalMinutes, 1, 1440, changeDefaults.creditsPluginIntervalMinutes)
    // 多 Key 清单：只做归一（去非法/去重/限量），不校验 Key 本身是否有效。
    if (Object.hasOwn(c, 'balanceKeys')) next.changes.balanceKeys = paths.normalizeKeys(c.balanceKeys)
  }

  // 「每回合结算」的三个阈值：默认值比 changes.* 小得多 —— 一轮的增量
  // 通常只有几千几万 Token / 几块钱，拿账户级阈值去卡就永远不达标。
  const settleDefaults = paths.defaultConfig().settle
  next.settle = { ...settleDefaults, ...(base?.settle ?? {}) }
  if (patch.settle && typeof patch.settle === 'object') {
    const s = patch.settle
    if (Object.hasOwn(s, 'tokenMinDelta')) next.settle.tokenMinDelta = paths.clampInt(s.tokenMinDelta, 0, 100000000, settleDefaults.tokenMinDelta)
    if (Object.hasOwn(s, 'balanceMinDelta')) next.settle.balanceMinDelta = paths.clampNumber(s.balanceMinDelta, 0, 100000, settleDefaults.balanceMinDelta)
    if (Object.hasOwn(s, 'creditsMinDelta')) next.settle.creditsMinDelta = paths.clampNumber(s.creditsMinDelta, 0, 100000, settleDefaults.creditsMinDelta)
  }

  if (patch.quietHours && typeof patch.quietHours === 'object') {
    const q = patch.quietHours
    if (Object.hasOwn(q, 'enabled')) next.quietHours.enabled = q.enabled === true
    if (Object.hasOwn(q, 'start')) next.quietHours.start = paths.normalizeClock(q.start, next.quietHours.start)
    if (Object.hasOwn(q, 'end')) next.quietHours.end = paths.normalizeClock(q.end, next.quietHours.end)
  }

  return paths.mergeConfig(next, {})
}

/** 发一条测试通知（真的走一遍完整链路，不真发时用 dryRun）。 */
async function sendTest(input) {
  const config = paths.readConfig()
  const resolved = await bridge.resolveTargets(config)
  if (resolved.ok !== true) return { ok: false, error: String(resolved.error ?? '取目标账号失败') }

  const title = String(input?.title ?? '').trim() || '【测试】DSH 回合通知'
  const text = String(input?.text ?? '').trim() || '这是一条测试通知：能看到它，说明「回合通知 → 通知发送器 → IM」这条链路是通的。'
  const dryRun = input?.dryRun === true

  const results = []
  for (const account of resolved.targets) {
    const outcome = await bridge.sendToOne({ account, title, text, dryRun })
    results.push({
      channel: String(account.channel ?? ''),
      account: String(account.name ?? ''),
      ok: outcome?.ok === true,
      detail: String(outcome?.error ?? outcome?.detail ?? ''),
    })
  }
  const sent = results.filter((r) => r.ok === true).length
  return { ok: sent > 0, dryRun, total: results.length, sent, failed: results.length - sent, results }
}

/**
 * 列出余额 Key 的「填没填」状态（**绝不回显 Key 本身**）。
 *
 * 界面要显示的是「账号 1：已填写 / 未填写」，不是一个可以让别人截图就看到 Key 的输入框。
 */
async function listBalanceKeys(ctx) {
  const config = paths.readConfig()
  const configured = paths.normalizeKeys(config?.changes?.balanceKeys)
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : null
  const canWrite = typeof credentials?.set === 'function' && typeof credentials?.unset === 'function'
  // 配置为空时，界面上仍要显示「当前实际会用哪几把」（老行为回落）。
  const list = configured.length > 0
    ? configured
    : changes.BALANCE_KEY_NAMES.map((name) => ({ name, label: name }))
  const resolved = await changes.resolveBalanceKeys(ctx, list)
  return {
    ok: true,
    keys: resolved.map((item) => ({
      name: item.name,
      label: item.label,
      filled: item.value !== '',
      // 只说来源类别，不带 Key 片段，避免「截图泄漏一半 Key」。
      source: item.value === '' ? '' : (String(item.source).startsWith('DSH 凭据库') ? 'credential' : 'env'),
      error: item.error,
    })),
    configured: configured.length > 0,
    max: changes.MAX_BALANCE_KEYS,
    canWrite,
    hint: canWrite ? '' : '当前宿主没暴露凭据写入能力，只能在 .env 里配 DEEPSEEK_* 环境变量。',
  }
}

/**
 * 改一把余额 Key：set（填/改）/ remove（删）/ 都会同步进 `changes.balanceKeys`。
 *
 * 两条硬约束：
 *  1. Key 只写进 DSH 凭据库，**绝不明文落盘**（配置里只存 name 与 label）；
 *  2. 任何返回体、日志、异常信息里都不带 Key 原文。
 */
async function applyBalanceKeyChange(ctx, payload) {
  const action = String(payload?.action ?? '').trim()
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : null
  if (typeof credentials?.set !== 'function' || typeof credentials?.unset !== 'function') {
    return { ok: false, error: '当前宿主没有暴露凭据写入能力，无法在这里保存 Key；请改用 .env 环境变量。' }
  }

  const config = paths.readConfig()
  const configured = paths.normalizeKeys(config?.changes?.balanceKeys)
  const base = configured.length > 0 ? configured : changes.BALANCE_KEY_NAMES.map((name) => ({ name, label: name }))

  if (action === 'set') {
    const name = String(payload?.name ?? '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      return { ok: false, error: 'Key 的名字只能是字母、数字、下划线，且不能以数字开头。' }
    }
    const value = String(payload?.value ?? '').trim()
    if (value === '') return { ok: false, error: 'Key 不能为空。' }
    if (value.length > 400) return { ok: false, error: 'Key 太长了（超过 400 字），请确认粘贴的是不是别的内容。' }
    try {
      await credentials.set(name, value)
    } catch (error) {
      return { ok: false, error: '写入凭据库失败：' + String(error?.message ?? error) }
    }
    const label = String(payload?.label ?? '').trim()
    const next = [...base]
    const at = next.findIndex((item) => item.name === name)
    if (at >= 0) next[at] = { name, label: label || next[at].label || name }
    else next.push({ name, label: label || name })
    return saveBalanceKeyList(next, '已保存 ' + (label || name) + ' 的 Key。')
  }

  if (action === 'remove') {
    const name = String(payload?.name ?? '').trim()
    if (name === '') return { ok: false, error: '要删除哪个 Key？请给 name。' }
    try {
      await credentials.unset(name)
    } catch (error) {
      return { ok: false, error: '删除凭据失败：' + String(error?.message ?? error) }
    }
    const next = base.filter((item) => item.name !== name)
    return saveBalanceKeyList(next, '已删除 ' + name + '。')
  }

  if (action === 'label') {
    const name = String(payload?.name ?? '').trim()
    const label = String(payload?.label ?? '').trim()
    if (name === '') return { ok: false, error: '要改哪个 Key 的名字？请给 name。' }
    const next = base.map((item) => (item.name === name ? { name, label: label || name } : item))
    return saveBalanceKeyList(next, '已改名。')
  }

  return { ok: false, error: '不认识的 action：' + action }
}

/** 把 Key 清单写进 changes.balanceKeys（配置里只存 name/label，不含 Key）。 */
function saveBalanceKeyList(list, note) {
  const merged = mergeSettings(paths.readConfig(), { changes: { balanceKeys: paths.normalizeKeys(list) } })
  const written = paths.writeConfig(merged)
  return {
    ok: written === true,
    note,
    error: written === true ? '' : '配置写盘失败（目录权限？）',
    keys: paths.normalizeKeys(merged?.changes?.balanceKeys),
  }
}

/**
 * @param {any} ctx cordis 上下文
 * @param {any} config_in 插件配置
 */
export function apply(ctx, config_in) {
  if (config_in && typeof config_in === 'object' && Object.hasOwn(config_in, 'config')) {
    // 允许在插件配置里给初值（首次安装时用），之后一切以 config.json 为准。
    const merged = mergeSettings(paths.readConfig(), config_in.config)
    paths.writeConfig(merged)
  }

  // ── 事件订阅：只读监听，不是 waterfall，接上不会阻断宿主 ──────────────
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      watcher.onSessionEvent(ctx, session, event)
    })
    return () => {
      watcher.disposeWatcher()
      if (typeof dispose === 'function') dispose()
    }
  }, 'turn-notify: session/event')

  // ── 「Agent 提问」订阅：waterfall 钩子，**必须 prepend + 必须调 next()** ──────
  //
  // ask_user_question 不落 session/event（已扫本机 1889 个会话日志核实），
  // 唯一入口是 cordis 的 user-questions/request waterfall。
  //  - prepend: true —— 宿主 apiproxy 的 GUI 认领监听器注册在先，不抢链首有可能拿不到；
  //  - 每次都调 next() —— 本插件只是**观察者**，绝不接管提问。不调 next() 会让
  //    Web GUI 收不到提问、Agent 拿到 NO_PROVIDER（dsh-bridge 就是因为要接管才不调）。
  ctx.effect(() => {
    const dispose = ctx.on('user-questions/request', (req, next) => watcher.onUserQuestion(req, next, ctx), { prepend: true })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'turn-notify: user-questions/request')

  // ── API ───────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = String(req.url ?? '')
      const sub = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url
      const route = sub.split('?')[0].replace(/\/+$/, '') || '/'
      const isPost = req.method === 'POST'
      try {
        if (route === '/info') {
          return sendJson(res, 200, {
            ok: true,
            name,
            version: readVersion(),
            dataDir: paths.DATA_DIR,
            configPath: paths.CONFIG_PATH,
            senderApi: paths.SENDER_API,
            triggers: TRIGGER_KEYS,
            labels: TRIGGER_LABELS,
          })
        }

        if (route === '/config') {
          if (isPost) {
            const payload = await readJsonBody(req)
            if (payload === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            const merged = mergeSettings(paths.readConfig(), payload)
            const written = paths.writeConfig(merged)
            // 被丢弃的触发键必须说出来，不能静默「存成功」：
            // 后端跑旧模块 + 前端是新界面时，用户点的新触发项会走到这里被吃掉。
            const dropped = paths.unknownTriggerKeysInPatch(payload)
            const warning = dropped.length > 0
              ? '有 ' + dropped.length + ' 个触发条件当前插件不认识（' + dropped.join('、') + '），已忽略。'
                + '这通常说明插件后端还是旧代码：重启 DSH 后生效。'
              : ''
            return sendJson(res, written ? 200 : 500, {
              ok: written,
              config: merged,
              warning,
              droppedTriggerKeys: dropped,
            })
          }
          return sendJson(res, 200, { ok: true, config: paths.readConfig(), defaults: paths.defaultConfig(), labels: TRIGGER_LABELS })
        }

        if (route === '/accounts') {
          const all = await bridge.listAccounts()
          const config = paths.readConfig()
          const resolved = await bridge.resolveTargets(config)
          return sendJson(res, 200, {
            ok: all.ok === true,
            error: String(all.error ?? ''),
            hub: all.hub ?? null,
            count: all.list.length,
            accounts: all.list,
            lastFromSender: await bridge.lastSelectedIds(),
            resolved: {
              ok: resolved.ok === true,
              count: resolved.ok === true ? resolved.targets.length : 0,
              fromSender: resolved.fromSender === true,
              error: String(resolved.error ?? ''),
              ids: resolved.ok === true ? resolved.targets.map((t) => String(t.id ?? '')) : [],
            },
          })
        }

        if (route === '/accounts/refresh' && isPost) {
          bridge.resetSenderModules()
          const all = await bridge.listAccounts()
          return sendJson(res, 200, { ok: all.ok === true, count: all.list.length, error: String(all.error ?? '') })
        }

        if (route === '/history') {
          const limitRaw = readQuery(req).get('limit')
          const limit = limitRaw === null ? 50 : Math.max(1, Math.min(200, Number(limitRaw) || 50))
          const list = paths.readHistory()
          return sendJson(res, 200, { ok: true, path: paths.HISTORY_PATH, count: Math.min(limit, list.length), entries: list.slice(0, limit) })
        }

        if (route === '/stats') {
          return sendJson(res, 200, { ok: true, stats: watcher.statsSnapshot() })
        }

        // 变化类：看累计与上次探测结果
        if (route === '/changes') {
          const cfg = paths.readConfig()
          return sendJson(res, 200, {
            ok: true,
            changes: cfg.changes,
            triggers: {
              balanceChange: cfg?.triggers?.balanceChange === true,
              tokenChange: cfg?.triggers?.tokenChange === true,
              creditsChange: cfg?.triggers?.creditsChange === true,
              creditsPluginChange: cfg?.triggers?.creditsPluginChange === true,
            },
            settle: {
              ...cfg.settle,
              on: cfg?.triggers?.turnSettle === true,
              parts: {
                token: cfg?.triggers?.settleToken === true,
                balance: cfg?.triggers?.settleBalance === true,
                credits: cfg?.triggers?.settleCredits === true,
              },
            },
            run: watcher.changeSnapshot(),
          })
        }

        // 立刻查一次（界面上「立即查一次」按钮用）
        if (route === '/changes/probe' && isPost) {
          const payload = await readJsonBody(req)
          if (payload === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          const outcome = await watcher.runChangeProbe(ctx, { force: true })
          return sendJson(res, 200, { ok: outcome.ok !== false, outcome, run: watcher.changeSnapshot() })
        }

        // 余额 Key 管理（v0.1.10）：只回「填没填」，**绝不回显 Key 本身**。
        if (route === '/balance-keys') {
          if (isPost) {
            const payload = await readJsonBody(req)
            if (payload === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            const outcome = await applyBalanceKeyChange(ctx, payload)
            return sendJson(res, outcome.ok === true ? 200 : 400, outcome)
          }
          return sendJson(res, 200, await listBalanceKeys(ctx))
        }

        if (route === '/test' && isPost) {
          const payload = await readJsonBody(req)
          if (payload === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          const outcome = await sendTest(payload)
          return sendJson(res, outcome.ok === true ? 200 : 502, outcome)
        }

        if (route === '/log') {
          try {
            const raw = readFileSync(paths.LOG_PATH, 'utf8')
            const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '')
            const limit = Math.max(1, Math.min(500, Number(readQuery(req).get('limit')) || 100))
            return sendJson(res, 200, { ok: true, path: paths.LOG_PATH, total: lines.length, lines: lines.slice(-limit) })
          } catch {
            return sendJson(res, 200, { ok: true, path: paths.LOG_PATH, total: 0, lines: [], note: '还没有日志（正常运行时不会写日志）' })
          }
        }

        if (route === '/hello') {
          if (isPost) {
            const payload = await readJsonBody(req)
            if (payload === null) return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            clientHello.at = new Date().toISOString()
            clientHello.stage = String(payload.stage ?? '')
            clientHello.loadId = String(payload.loadId ?? '')
            clientHello.ua = String(payload.ua ?? '').slice(0, 400)
            clientHello.href = String(payload.href ?? '').slice(0, 400)
            clientHello.visibility = String(payload.visibility ?? '')
            clientHello.slots = payload.slots && typeof payload.slots === 'object' ? payload.slots : null
            clientHello.note = String(payload.note ?? '').slice(0, 400)
          }
          return sendJson(res, 200, { ok: true, client: clientHello })
        }

        if (route === '/selfcheck') {
          return sendJson(res, 200, await selfCheck(ctx))
        }

        return sendJson(res, 404, { ok: false, error: '未知接口 ' + route })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'turn-notify: api')

  // ── 变化类轮询：余额 / 积分的后台探测 ──────────────────────────────────
  //
  //
  // 只在对应触发开启时才会真的查外部接口；查询有最小间隔（changes.probeIntervalMinutes），
  // 因为额度类接口都有限流。Token 累计不需要轮询，它在事件里现算。
  ctx.effect(() => {
    watcher.startChangeProbe(ctx)
    return () => { watcher.stopChangeProbe() }
  }, 'turn-notify: change probe')

  // ── 工具 1：查状态 ────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'turn_notify_status',
    description: '查看「回合通知」插件的运行状态：总开关、开启了哪些触发条件、发给谁、今日已发/跳过/失败各多少、最近一次发送或跳过的人话原因。排查「为什么没收到通知」时先调它。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const config = paths.readConfig()
      const stats = watcher.statsSnapshot()
      const resolved = await bridge.resolveTargets(config)
      return JSON.stringify({
        ok: true,
        enabled: config.enabled === true,
        triggers: configSummary(config).triggers,
        dryRun: config.dryRun === true,
        cooldownSeconds: config.cooldownSeconds,
        quietHours: config.quietHours,
        targets: {
          ok: resolved.ok === true,
          count: resolved.ok === true ? resolved.targets.length : 0,
          fromSender: resolved.fromSender === true,
          ids: resolved.ok === true ? resolved.targets.map((t) => t.id) : [],
          error: String(resolved.error ?? ''),
        },
        changes: {
          ...config.changes,
          run: watcher.changeSnapshot(),
        },
        settle: {
          ...config.settle,
          on: config?.triggers?.turnSettle === true,
          lastSettle: config ? watcher.changeSnapshot().lastSettle : null,
        },
        stats: {
          sent: stats.sent,
          skipped: stats.skipped,
          failed: stats.failed,
          queueLength: stats.queueLength,
          lastAt: stats.lastAt,
          lastReason: stats.lastReason,
          lastError: stats.lastError,
        },
      }, null, 2)
    },
  }), 'turn-notify: tool status')

  // ── 工具 2：改配置 ────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'turn_notify_config',
    description: '读取或修改「回合通知」的配置（实时落盘）。action=get 只看；action=set 传要改的字段即可，其余不变。可改：enabled（总开关）、triggers（哪些情况发，含 balanceChange/tokenChange/creditsChange 三类变化通知）、changes（变化阈值：balanceMinDelta 余额阈值元 / tokenMinDelta Token 阈值 / creditsMinDelta 积分阈值 / region 分区 cn|global / probeIntervalMinutes 余额与单账号积分的最小查询间隔分钟 / creditsPluginMinDelta 多账号单账号变化阈值分 / creditsPluginIntervalMinutes 多账号积分独立查询间隔分钟 / balanceKeys 多个 DeepSeek 余额 Key 的清单 [{name,label}]，只存名字不存 Key，真正的 Key 在 DSH 凭据库里；多账号开关是 triggers.creditsPluginChange）、settle（每回合结算阈值：tokenMinDelta / balanceMinDelta / creditsMinDelta，只在 triggers.turnSettle 打开时生效；结算的开关是 triggers 里的 turnSettle + settleToken / settleBalance / settleCredits）、targetAccountIds（发给谁，空=沿用通知发送器）、cooldownSeconds（冷却秒）、quietHours（静默时段）、dryRun（试运行）。要填/删具体的 Key 请用界面卡片或 POST /balance-keys，不要通过本工具传 Key 原文。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: 'get=只看，set=修改' },
        patch: { type: 'object', description: '要修改的字段（action=set 时用）' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const action = String(args?.action ?? 'get')
      if (action === 'set') {
        const merged = mergeSettings(paths.readConfig(), args?.patch ?? {})
        const written = paths.writeConfig(merged)
        bridge.resetSenderModules()
        return JSON.stringify({ ok: written, config: merged }, null, 2)
      }
      return JSON.stringify({ ok: true, config: paths.readConfig(), defaults: paths.defaultConfig() }, null, 2)
    },
  }), 'turn-notify: tool config')

  // ── 工具 3：发测试通知 ────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'turn_notify_test',
    description: '发一条测试通知，验证「回合通知 → 通知发送器 → IM」这条链路是否通。默认真发；传 dryRun:true 只演练不真发。它能通，回合结束时的自动通知才有可能通。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '通知正文（可省，省略用默认测试文案）' },
        dryRun: { type: 'boolean', description: 'true=只演练不真发' },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const outcome = await sendTest(args ?? {})
      return JSON.stringify(outcome, null, 2)
    },
  }), 'turn-notify: tool test')

  // 启动时打一行，便于在宿主日志里确认本插件确实起来了。
  try {
    const config = paths.readConfig()
    // 打上触发条件个数：以后「界面有第 9 项、进程只有 8 项」这种新旧不一致，一眼就能看出来。
    paths.logLine('plugin started v' + readVersion() + ' enabled=' + (config.enabled === true)
      + ' triggers=' + String(Object.keys(paths.defaultConfig().triggers).length)
      + ' mapTurnEndKind(max-tokens)=' + String(mapTurnEndKind('max-tokens')))
  } catch {
    /* 日志失败不影响插件 */
  }
}
