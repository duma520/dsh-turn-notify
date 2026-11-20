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

  // 4. 事件订阅状态
  push('事件订阅', typeof ctx?.on === 'function', typeof ctx?.on === 'function' ? "session/event 已订阅" : '当前上下文拿不到 on()，订阅未建立')

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
            return sendJson(res, written ? 200 : 500, { ok: written, config: merged })
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
    description: '读取或修改「回合通知」的配置（实时落盘）。action=get 只看；action=set 传要改的字段即可，其余不变。可改：enabled（总开关）、triggers（哪些情况发）、targetAccountIds（发给谁，空=沿用通知发送器）、cooldownSeconds（冷却秒）、quietHours（静默时段）、dryRun（试运行）。',
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
    paths.logLine('plugin started v' + readVersion() + ' enabled=' + (config.enabled === true) + ' mapTurnEndKind(max-tokens)=' + String(mapTurnEndKind('max-tokens')))
  } catch {
    /* 日志失败不影响插件 */
  }
}
