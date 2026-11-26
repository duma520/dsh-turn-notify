/**
 * lib/watcher.js —— 回合事件订阅 + 定时器 + 发送队列（本插件的心脏）。
 *
 * 订阅一个事件：宿主 cordis 的 **ctx.on('session/event', (session, event) => {})**。
 * 这是 dsh-bridge 与 dsh-im 都在用的同一条通道（非 waterfall，只读监听，不会
 * 阻断任何宿主行为 —— 这一点很关键：审批类是 waterfall，接错会瘫痪审批，所以本插件不碰）。
 *
 * 三条硬约束：
 *  1. **绝不 await 阻塞宿主**：回调里只做极轻的状态更新，发送丢进串行队列异步跑；
 *  2. **绝不把异常冒到宿主事件链**：任何异常就地 catch 并记日志，宁可少发一条也不能弄崩会话；
 *  3. **串行发送 + 冷却**：同一时刻只允许一条在飞，避免把 IM 通道打到限流（规则 g24/g25）。
 *
 * @module watcher.js
 */

import { decide, mapTurnEndKind, matchKeyword } from './rules.js'
import { composeNotification, lastAssistantText, countTools, titleFromEvents, excerpt } from './format.js'
import { resolveTargets, sendToOne } from './bridge.js'
import { readConfig, appendHistory, logLine, readImActiveSessionIds, SNAPSHOT_PATH } from './paths.js'
import { buildQuestionCandidate } from './questions.js'
import {
  judgeChange,
  probeBalance,
  probeCredits,
  probeAccountCredits,
  diffAccountCredits,
  buildCreditsPluginCandidate,
  readSnapshot,
  patchSnapshot,
  buildBalanceCandidate,
  buildCreditsCandidate,
  buildTokenCandidate,
  buildSettleCandidate,
  numOrNull,
} from './changes.js'

/** 每个会话的运行时状态（内存里，进程退出即丢，不落盘）。 */
const sessions = new Map()

/** 串行发送队列：同一时刻只有一条在飞。 */
let sending = false
const queue = []

/** 全局统计：界面上「今日已发 N 条」用它。 */
const stats = { sent: 0, failed: 0, skipped: 0, lastAt: '', lastError: '', lastReason: '' }

/**
 * 变化类触发的运行时状态。
 *
 * tokenTotal 是「本机累计消耗」的内存副本，落盘在 snapshot.json；
 * 落盘做 5 秒节流 —— 每一步都写盘既没必要又伤磁盘。
 * lastProbe 记录轮询状况，供界面显示「上次查余额是什么时候」。
 */
const changeState = {
  tokenTotal: null,
  notifiedTotal: null,
  lastTokenSaveAt: 0,
  probeTimer: null,
  lastProbeAt: 0,
  /**
   * 多账号积分的**独立**上次查询时间。
   *
   * 为什么不跟 lastProbeAt 共用：它要管的那一路默认 2 分钟一查，
   * 而余额/单账号积分是 5 分钟。共用一个时间戳的话，短的那个会被长的那个挡掉，
   * 等于把「缩短间隔」这条需求废掉。
   */
  lastPluginProbeAt: 0,
  lastProbeResult: { balance: '', credits: '', creditsPlugin: '', at: '' },
  /** 最近一次「回合结算」的结果，供界面显示（不含任何凭据）。 */
  lastSettle: { at: '', detail: '', sent: false },
}

/** 取（或建）一个会话的运行时状态。 */
function stateOf(sessionId) {
  const id = String(sessionId ?? '')
  let state = sessions.get(id)
  if (!state) {
    state = {
      turn: 0,
      turnStartedAt: 0,
      lastEventAt: 0,
      lastSentAt: 0,
      timeoutTimer: null,
      progressTimer: null,
      timeoutNotifiedTurn: 0,
      progressNotifiedAt: 0,
      /**
       * 本回合精确 Token 增量（只累加、不落盘、零 IO）。
       * 与 changeState.tokenTotal 的口径不同：那是「本机累计」，
       * 这是「这一轮里用了多少」，供「每回合结算」通知使用。
       */
      turnToken: 0,
      /**
       * **回合开始前的采样结果**（v0.1.11 新增）。
       *
       * 用户 2026-11-25 的要求：结算里要写「回合前 DS 多少 / 全部账号积分多少」，
       * 所以 turn/start 时真的联网采一次（选项 A，用户 m00959 确认）。
       *
       * 结构：{ at, balance, creditAccounts, creditsError }
       *  - at              采样完成时刻（正文里直接显示，避免让人以为是本回合开始那一秒）
       *  - balance         probeBalance 的返回值，或 {ok:false,error}
       *  - creditAccounts  probeAccountCredits 的 accounts，或 null
       *  - creditsError    积分没采到的原因
       *
       * 只在内存里，不落盘：它只服务这一个小节，跨进程恢复没意义。
       */
      beforeSample: null,
      /** 正在采样的 Promise（同一轮重复收到 turn/start 时复用它，不重复发请求）。 */
      beforeSampling: null,
      /**
       * 本回合是否**已经发起过**前值采样（无论成败）。
       *
       * v0.1.17 新增。存在的唯一理由：避免「补采」在每一个后续事件上反复重试。
       * 实测约 50% 的结算收不到回合前值，根因是那一轮 turn/start 没送到插件；
       * 所以改成「本回合第一个后续事件到达时补采一次」，采样成败都只做一次。
       */
      beforeSampleTried: false,
    }
    sessions.set(id, state)
  }
  return state
}

/**
 * 回合开始前采样一次余额 + 全部账号积分（v0.1.11）。
 *
 * 为什么要单独一个函数：这段要联网、要 await，必须在 turn/start 分支里用
 * `void sampleBeforeTurn(...)` 异步跑，**绝不能 await**（会阻塞宿主事件链）。
 *
 * 三条纪律：
 *  1. 只有真的要用（结算开关打开且勾了余额/积分）才发请求，否则一次网络都不发；
 *  2. 失败如实记原因，不抛异常（采样失败不能让回合跑不下去）；
 *  3. 不受 probeIntervalMinutes 闸门约束 —— 那道闸是给「后台轮询」用的，
 *     回合开始的采样必须是真的「此刻」，否则会给出错误的前值。
 *
 * v0.1.17：`via` 记录这次采样是**怎么来的**，正文要如实标出来。
 *  - 'turn-start'  turn/start 到达时采的（正常路径）
 *  - 'catch-up'    turn/start 没到，本回合第一个后续事件补采的
 *  - 'snapshot'    整轮都没采到，用快照里上一回合结束时的记录兜底
 */
async function sampleBeforeTurn(config, ctx, state, via = 'turn-start') {
  if (!state) return
  const wantSettle = config?.triggers?.turnSettle === true
  const wantBalance = wantSettle && config?.triggers?.settleBalance === true
  const wantCredits = wantSettle && config?.triggers?.settleCredits === true
  if (!wantBalance && !wantCredits) return

  const sample = { at: '', balance: null, creditAccounts: null, creditsError: '', via }
  if (wantBalance === true) {
    try {
      sample.balance = await probeBalance(ctx, { keys: config?.changes?.balanceKeys })
    } catch (error) {
      sample.balance = { ok: false, error: String((error && error.message) || error) }
    }
  }
  if (wantCredits === true) {
    try {
      const all = await probeAccountCredits(ctx, config?.changes?.region)
      if (all.ok === true) sample.creditAccounts = all.accounts
      else sample.creditsError = String(all.error ?? '账号积分接口没返回数据')
    } catch (error) {
      sample.creditsError = String((error && error.message) || error)
    }
  }
  sample.at = localTimeOf()
  state.beforeSample = sample
}

/**
 * 发起一次回合前采样（统一入口，v0.1.17）。
 *
 * 三条路径都走这里，保证「只发一次、失败也不重试」：
 *  - turn/start 到达 → via='turn-start'
 *  - turn/start 没到、本回合第一个后续事件到达 → via='catch-up'
 *
 * 绝不 await：采样要联网，等待它会阻塞宿主的事件链。
 */
function startBeforeSampling(config, ctx, state, via) {
  if (!state) return null
  state.beforeSampleTried = true
  const job = sampleBeforeTurn(config, ctx, state, via)
    .catch((error) => {
      logLine('sampleBeforeTurn failed: ' + String((error && error.message) || error))
    })
    .finally(() => { state.beforeSampling = null })
  state.beforeSampling = job
  return job
}

/**
 * 整轮都没采到前值时，用快照里上一回合结束时的记录兜底（v0.1.17）。
 *
 * 为什么允许这么干：快照里的 balanceValue / balanceAccounts / creditsPluginValues
 * 都是**上一次真实联网查到的值**（宁可写清时刻，也不让用户看到「没采到」）。
 * 但必须让用户一眼看出这不是本回合开始那一刻的数，所以：
 *  - via='snapshot'，正文会写「回合前：取自上一回合结束时（<时刻> 的记录）」；
 *  - **快照没有拆分字段时不编 0**，toppedUp / granted 保持 null，正文显示「未采到」；
 *  - 快照整体为空就直接返回 null，让正文如实写「没采到」。
 */
function beforeSampleFromSnapshot() {
  const snapshot = readSnapshot()
  if (!snapshot || typeof snapshot !== 'object') return null

  const hasBalance = snapshot.balanceValue !== undefined &&
    snapshot.balanceValue !== null && snapshot.balanceValue !== ''
  const prevAccounts = Array.isArray(snapshot.balanceAccounts) ? snapshot.balanceAccounts : []
  const prevMap = snapshot.creditsPluginValues && typeof snapshot.creditsPluginValues === 'object'
    ? snapshot.creditsPluginValues
    : null

  const hasCredits = prevMap !== null && Object.keys(prevMap).length > 0
  if (!hasBalance && !hasCredits) return null

  const sample = { at: '', balance: null, creditAccounts: null, creditsError: '', via: 'snapshot' }

  if (hasBalance) {
    const accounts = prevAccounts.length > 0
      ? prevAccounts.map((item) => ({
        name: String(item?.name ?? ''),
        label: String(item?.label ?? ''),
        ok: true,
        total: numOrNull(item?.total),
        toppedUp: numOrNull(item?.toppedUp),
        granted: numOrNull(item?.granted),
        currency: String(item?.currency ?? 'CNY'),
      }))
      : [{
        name: 'snapshot',
        label: '本机快照',
        ok: true,
        total: numOrNull(snapshot.balanceValue),
        toppedUp: null,
        granted: null,
        currency: String(snapshot.balanceCurrency ?? 'CNY'),
      }]
    sample.balance = {
      ok: true,
      value: numOrNull(snapshot.balanceValue),
      currency: String(snapshot.balanceCurrency ?? 'CNY'),
      source: '本机快照（上一回合结束时的记录）',
      dataTime: String(snapshot.balanceAt ?? ''),
      stale: false,
      accounts,
      fromSnapshot: true,
    }
    sample.at = String(snapshot.balanceAt ?? '')
  }

  if (hasCredits) {
    const accounts = Object.keys(prevMap).map((id) => ({
      id,
      accountName: id,
      value: numOrNull(prevMap[id]),
      selected: false,
    }))
    // 账号名只在快照里存了 id，能补上名字就补（同名 id 优先用当前配置里的 label）。
    const nameOf = {}
    for (const item of (Array.isArray(snapshot.balanceAccounts) ? snapshot.balanceAccounts : [])) {
      const key = String(item?.name ?? '')
      if (key !== '') nameOf[key] = String(item?.label ?? key)
    }
    for (const account of accounts) {
      if (nameOf[account.id]) account.accountName = nameOf[account.id]
    }
    sample.creditAccounts = accounts
    if (sample.at === '') sample.at = String(snapshot.creditsPluginAt ?? '')
  }

  if (sample.at === '') sample.at = String(snapshot.creditsPluginAt ?? '')
  return sample
}

/**
 * 三层兜底的第 2 层：`turn/start` 没到，就在本回合的**第一个后续事件**上补采（v0.1.17）。
 *
 * 为什么需要：实测约 50% 的结算收不到回合前值，根因是那一轮 `turn/start` 没送到插件
 * （证据：「本轮耗时」与「有回合前值」100% 同时出现或同时缺失，而 turnStartedAt 只由
 * turn/start 设置）。只要这一轮有事件（必然有），前值就不会缺。
 *
 * 只认**回合内才会出现**的事件类型，避免在回合之间的杂事件上白发请求：
 * assistant/message、tool/result、step/start、step/end，或任何带 usage 的事件。
 *
 * `beforeSampleTried` 保证每回合最多补采一次 —— 失败也不反复重试，免得把接口打爆。
 */
const CATCH_UP_EVENT_TYPES = new Set(['assistant/message', 'tool/result', 'step/start', 'step/end'])

function maybeCatchUpBeforeSample(config, ctx, state, type, event) {
  if (!state) return
  if (state.beforeSampleTried === true) return
  if (state.beforeSampling) return
  if (state.beforeSample) return
  if (config?.triggers?.turnSettle !== true) return

  let inTurn = CATCH_UP_EVENT_TYPES.has(type)
  if (inTurn !== true) {
    try { inTurn = usageOf(event) !== null } catch { inTurn = false }
  }
  if (inTurn !== true) return

  logLine('turn/start 没到，改用 ' + type + ' 补采回合前值')
  startBeforeSampling(config, ctx, state, 'catch-up')
}

/** 清掉一个会话的定时器（回合结束时必须调，否则会残留告警）。 */
function clearTimers(state) {
  if (!state) return
  if (state.timeoutTimer) { clearTimeout(state.timeoutTimer); state.timeoutTimer = null }
  if (state.progressTimer) { clearTimeout(state.progressTimer); state.progressTimer = null }
}

/** 把候选事件推进队列；队列自己保证串行。 */
function enqueue(job) {
  queue.push(job)
  void drain()
}

/** 串行消费队列：一条发完再发下一条。 */
async function drain() {
  if (sending) return
  sending = true
  try {
    while (queue.length > 0) {
      const job = queue.shift()
      try {
        await job()
      } catch (error) {
        // 单条失败绝不能让队列卡死
        logLine('job failed: ' + String((error && error.message) || error))
      }
    }
  } finally {
    sending = false
  }
}

/**
 * 处理一个候选事件：跑规则 → 命中就拼文案 → 入队发送。
 *
 * 这里是「事件」到「通知」的唯一闸门，所有触发类型都走同一条路，
 * 保证规则、冷却、静默、目标账号的行为完全一致。
 */
export function handleCandidate(candidate, extra = {}) {
  let config
  try {
    config = extra.config ?? readConfig()
  } catch {
    config = null
  }
  if (!config) return { send: false, reason: '读配置失败' }

  const sessionId = String(candidate?.sessionId ?? '')
  const state = stateOf(sessionId)
  // IM 绑定的会话 id 每次现读：用户可能在界面上切了 IM 会话，缓存会判错。
  // 读失败返回空数组 → 不跳过（宁可多发一条，也不吞掉通知）。
  const imSessionIds = config.skipImOriginated === true ? readImActiveSessionIds() : []
  const verdict = decide(config, candidate, { now: new Date(), lastSentAt: state.lastSentAt, imSessionIds })

  if (verdict.send !== true) {
    stats.skipped += 1
    stats.lastReason = verdict.reason
    return verdict
  }

  // 拼文案（纯函数，不进队列也能算，方便试运行时立刻返回预览）
  const notification = composeNotification({
    kind: candidate.kind,
    prefix: config.titlePrefix,
    title: candidate.title,
    sessionId,
    cwd: candidate.cwd,
    detail: candidate.detail,
    assistantText: candidate.assistantText,
    // 「Agent 提问」要逐题逐选项列出来（多行），其余触发类型没有这个字段
    extraLines: candidate.extraLines,
    excerptChars: config.excerptChars,
    tools: candidate.tools,
    elapsedMs: candidate.elapsedMs,
    // 变化类（余额 / Token / 积分）的核心信息就是「多少 → 多少，差了多少」。
    // 这几个字段必须原样透传：早先漏传，导致变化通知只写了「积分减少（4427）」，
    // 用户看到「发生了变化」却不知道变化了多少 —— 一行都不该丢。
    oldText: candidate.oldText,
    newText: candidate.newText,
    deltaText: candidate.deltaText,
    source: candidate.source,
    dataTime: candidate.dataTime,
    stale: candidate.stale,
    now: new Date(),
  })

  const record = {
    at: new Date().toISOString(),
    sessionId,
    sessionTitle: String(candidate.title ?? ''),
    cwd: String(candidate.cwd ?? ''),
    kind: String(candidate.kind ?? ''),
    reason: verdict.reason,
    title: notification.title,
    preview: excerpt(notification.text, 160),
    ok: false,
    skipped: false,
    detail: '',
    channels: [],
    dryRun: config.dryRun === true,
  }

  if (config.dryRun === true) {
    // 试运行：只落历史，不真发，让用户先看「本该发什么」。
    record.ok = true
    record.detail = '试运行（未真发）'
    appendHistory(record)
    state.lastSentAt = Date.now()
    stats.sent += 1
    stats.lastAt = record.at
    return { send: true, reason: verdict.reason, preview: notification }
  }

  enqueue(async () => {
    const resolved = await resolveTargets(config)
    if (resolved.ok !== true) {
      record.ok = false
      record.detail = String(resolved.error ?? '取目标账号失败')
      appendHistory(record)
      stats.failed += 1
      stats.lastError = record.detail
      logLine('resolveTargets failed: ' + record.detail)
      return
    }

    const channels = []
    let okCount = 0
    // 串行：逐个账号发，一个失败不连累下一个。
    for (const account of resolved.targets) {
      const outcome = await sendToOne({ account, title: notification.title, text: notification.text, dryRun: false })
      channels.push({
        channel: String(account.channel ?? ''),
        account: String(account.name ?? ''),
        ok: outcome?.ok === true,
        detail: String(outcome?.error ?? outcome?.detail ?? ''),
      })
      if (outcome?.ok === true) okCount += 1
    }

    record.ok = okCount > 0
    record.channels = channels
    record.detail = okCount === channels.length
      ? '已发到 ' + okCount + ' 个账号'
      : '成功 ' + okCount + ' / 共 ' + channels.length + ' 个账号'
    appendHistory(record)

    if (okCount > 0) {
      state.lastSentAt = Date.now()
      stats.sent += 1
      stats.lastAt = record.at
    } else {
      stats.failed += 1
      stats.lastError = record.detail
    }
  })

  return { send: true, reason: verdict.reason, preview: notification }
}

/**
 * 从事件里挑出 usage 数字（宿主在 assistant/message 等事件上带 usage）。
 *
 * 真实字段（已从本机会话日志核实）：{ inputTokens, outputTokens, totalTokens, cacheReadTokens }。
 * 判空必须用 != null，不能用 !== undefined —— 宿主会给 null，
 * 而 null 通过 !== undefined 检查后就会在读属性时抛 TypeError（踩过）。
 */
function usageOf(event) {
  const usage = event?.data?.usage ?? event?.data?.message?.usage ?? event?.data?.chunk?.usage
  if (usage == null || typeof usage !== 'object') return null
  const total = Number(usage.totalTokens)
  const input = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  const cacheRead = Number(usage.cacheReadTokens)
  const settled = Number.isFinite(total)
    ? total
    : (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
  if (!Number.isFinite(settled) || settled <= 0) return null
  return { total: settled, cacheRead: Number.isFinite(cacheRead) ? cacheRead : 0 }
}

/**
 * 累计 Token 消耗，走到阈值就发一条。
 *
 * 「累计」口径：本机自本插件装上以来的 Token 消耗总量（宿主不提供可直接读的
 * 全局计数器，事件里的 usage 是「这一次调用」的量，只能自己累加）。
 */
function trackTokenUsage(config) {
  if (config?.triggers?.tokenChange !== true) return
  if (changeState.tokenTotal === null) {
    // 启动时从快照恢复，否则重启就把累计值清零，阈值永远走不到。
    const snap = readSnapshot()
    const restored = Number(snap?.tokenTotal)
    changeState.tokenTotal = Number.isFinite(restored) ? restored : 0
    const notified = Number(snap?.tokenNotifiedTotal)
    changeState.notifiedTotal = Number.isFinite(notified) ? notified : 0
  }
}

/** 把一次 usage 累加进总量，必要时触发通知并落盘（5 秒节流）。 */
function accumulateUsage(config, event) {
  if (config?.triggers?.tokenChange !== true) return
  const usage = usageOf(event)
  if (usage === null) return
  trackTokenUsage(config)
  changeState.tokenTotal = Number(changeState.tokenTotal ?? 0) + usage.total

  const threshold = Math.max(1, Number(config?.changes?.tokenMinDelta) || 100000)
  const notified = Number(changeState.notifiedTotal ?? 0)
  if (changeState.tokenTotal - notified >= threshold) {
    const candidate = buildTokenCandidate(notified, changeState.tokenTotal, changeState.tokenTotal - notified)
    changeState.notifiedTotal = changeState.tokenTotal
    patchSnapshot({ tokenTotal: changeState.tokenTotal, tokenNotifiedTotal: changeState.notifiedTotal })
    changeState.lastTokenSaveAt = Date.now()
    try {
      handleCandidate(candidate, { config })
    } catch (error) {
      logLine('tokenChange candidate failed: ' + String((error && error.message) || error))
    }
    return
  }

  // 没到阈值：5 秒最多落一次盘（避免每步都写）
  if (Date.now() - changeState.lastTokenSaveAt > 5000) {
    changeState.lastTokenSaveAt = Date.now()
    patchSnapshot({ tokenTotal: changeState.tokenTotal })
  }
}


/**
 * 把一次 usage 累加进「本回合」增量（零 IO，只改内存）。
 *
 * 为什么单独算一遍而不复用 changeState.tokenTotal：结算是按回合出账的，
 * 「本机累计差」在并发回合、跨回合重入时会算错（另一个回合的消耗会串进来）。
 * 这里只认「本会话、本回合」的事件，逐个累加 usage.totalTokens。
 */
function accumulateTurnUsage(config, state, event) {
  // 只要主开关或结算里的 Token 项开着就累加 —— 用户可能随时打开结算，
  // 打开那一刻起就能算出「本轮用了多少」，不必等到下一轮。
  const need = config?.triggers?.turnSettle === true || config?.triggers?.tokenChange === true
  if (need !== true) return
  const usage = usageOf(event)
  if (usage === null) return
  state.turnToken = Number(state.turnToken ?? 0) + usage.total
}

/**
 * 回合结束时出账：汇总本轮 Token，并把「回合前 → 回合后」的余额 / 积分一起发出去。
 *
 * 四条纪律：
 *  1. **回合前**的值在 turn/start 时已采好（state.beforeSample），这里只采「回合后」；
 *     两侧都绕开 probeIntervalMinutes（那道闸只给后台轮询用，套在这里会让前值经常缺失）；
 *  2. **Token 用本轮精确增量**，不是累计差；
 *  3. **结算单独发一条**（kind=turnSettle），不并入「回合完成」正文，
 *     这样即使没开「回合完成」也能收到结算；
 *  4. **任何一侧失败都如实写「未采到」**，绝不伪造数字，也不因此放弃整条结算。
 *
 * 请求代价：用户 m00959 已知并接受「前后各查一次」（余额 ×2、积分上游 ×2）。
 */
async function settleTurn(config, ctx, state, base) {
  if (config?.triggers?.turnSettle !== true) return
  const wantToken = config?.triggers?.settleToken === true
  const wantBalance = config?.triggers?.settleBalance === true
  const wantCredits = config?.triggers?.settleCredits === true
  if (!wantToken && !wantBalance && !wantCredits) {
    changeState.lastSettle = { at: localTimeOf(), detail: '结算已开，但三项都没勾选，跳过', sent: false }
    return
  }

  // ── v0.1.11：改成「回合前 → 回合后」成对比较 ─────────────────────────
  //
  // 回合开始前那次读数在 turn/start 分支里已经采好（state.beforeSample）。
  // 这里只负责采「回合后」，然后把两边一起交给 buildSettleCandidate。
  //
  // 两条纪律：
  //  1. **两侧都绕开 probeIntervalMinutes** —— 那道闸是给后台轮询用的。
  //     套在结算上会让「回合前」经常被跳过，前后一对凑不齐，功能等于废掉。
  //     用户已知并接受请求翻倍（m00959 选 A），所以这里不做间隔裁剪。
  //  2. **任何一侧失败都如实写出来**，绝不拿旧值/0 冒充（宁可写「未采到」）。
  if (state && state.beforeSampling) {
    // 极短回合：回合开始时那次采样可能还没回来。settleTurn 本身跑在 void 里，
    // 这里 await 不会阻塞宿主事件链，所以可以安心地等它把前值落下来。
    try {
      await state.beforeSampling
    } catch (error) {
      logLine('settleTurn: 等回合前采样失败 ' + String((error && error.message) || error))
    }
  }
  let before = state && state.beforeSample ? state.beforeSample : null
  // v0.1.17 第 3 层兜底：整轮都没采到前值（turn/start 没到、后续事件也没来得及补采，
  // 比如一进来就 turn/end），就拿快照里上一回合结束时的记录顶上，
  // 并在正文里写明「取自上一回合结束时（<时刻> 的记录）」——绝不补 0、也不冒充本回合。
  if (before === null) {
    const fallback = beforeSampleFromSnapshot()
    if (fallback !== null) {
      before = fallback
      logLine('settleTurn: 回合前值缺失，改用快照兜底（' + String(fallback.at) + '）')
    }
  }
  const after = { at: '', balance: null, creditAccounts: null, creditsError: '' }

  if (wantBalance === true) {
    try {
      const probe = await probeBalance(ctx, { keys: config?.changes?.balanceKeys })
      after.balance = probe
      if (probe.ok === true) {
        // 三项拆分的基准继续落盘：后台轮询的「上次」和界面显示都还要用它。
        const prevAccounts = Array.isArray(readSnapshot()?.balanceAccounts) ? readSnapshot().balanceAccounts : []
        const prevById = new Map(prevAccounts.map((item) => [String(item?.name ?? ''), item]))
        const withPrev = (Array.isArray(probe.accounts) ? probe.accounts : []).map((item) => ({
          ...item,
          prev: prevById.get(String(item?.name ?? '')) ?? null,
        }))
        // ★ v0.1.13：结算采到的是陈旧快照时，**不得覆盖**已有实时基准。
        // 覆盖的话下一轮轮询拿实时值一比就是「暴跌」，又是一条假警报（同 runChangeProbe 的坑）。
        const snapNow = readSnapshot()
        const hasBaseline = snapNow?.balanceValue !== undefined && snapNow?.balanceValue !== null && snapNow?.balanceValue !== ''
        if (probe.stale !== true || !hasBaseline) {
          patchSnapshot({
            balanceValue: probe.value,
            balanceCurrency: probe.currency,
            balanceSource: probe.source,
            balanceAt: probe.dataTime,
            balanceStale: probe.stale === true,
            balanceAccounts: withPrev.map((item) => ({
              name: String(item?.name ?? ''),
              label: String(item?.label ?? ''),
              total: numOrNull(item?.total),
              // 必须用 numOrNull：`Number.isFinite(Number(null))` 是 true，
              // 会把「接口没给这个字段」当成 0 存进基准，下次比对就永远对不上。
              toppedUp: numOrNull(item?.toppedUp),
              granted: numOrNull(item?.granted),
              currency: String(item?.currency ?? 'CNY'),
            })),
          })
        } else {
          logLine('settle balance: 采到快照，保留实时基准不覆盖（' + String(probe.value) + '）')
        }
      } else {
        logLine('settle balance probe failed: ' + String(probe.error ?? ''))
      }
    } catch (error) {
      after.balance = { ok: false, error: String((error && error.message) || error) }
      logLine('settle balance probe threw: ' + String((error && error.message) || error))
    }
  }

  if (wantCredits === true) {
    // 积分走 WorkBuddy 账号表接口（全部账号）；拿不到再退回单账号接口。
    try {
      const all = await probeAccountCredits(ctx, config?.changes?.region)
      if (all.ok === true) {
        after.creditAccounts = all.accounts
        const snapshot = readSnapshot()
        const prevMap = snapshot?.creditsPluginValues && typeof snapshot.creditsPluginValues === 'object'
          ? snapshot.creditsPluginValues
          : {}
        const nextMap = { ...prevMap }
        for (const account of all.accounts) nextMap[account.id] = account.value
        patchSnapshot({
          creditsPluginValues: nextMap,
          creditsPluginRegion: all.region,
          creditsPluginAt: all.dataTime,
        })
        // 单账号那一路的基准也顺手更新，界面「上次积分」不会停在旧值。
        const selected = all.accounts.find((account) => account?.selected === true) ?? all.accounts[0]
        if (selected) {
          patchSnapshot({ creditsValue: selected.value, creditsRegion: all.region, creditsAt: all.dataTime })
        }
      } else {
        after.creditsError = String(all.error ?? '账号积分接口没返回数据')
        const probe = await probeCredits(ctx, config?.changes?.region)
        if (probe.ok === true) {
          // 账号表拿不到时，用单账号读数拼一条「只有一个账号」的列表，
          // 这样成对比较仍然成立（不至于整段退化成「未采到」）。
          after.creditAccounts = [{
            id: 'selected',
            accountName: String(probe.accountName ?? '当前账号'),
            value: probe.value,
            selected: true,
          }]
          after.creditsError = ''
          patchSnapshot({ creditsValue: probe.value, creditsRegion: probe.region, creditsAt: probe.dataTime })
        } else {
          after.creditsError = String(after.creditsError || probe.error || '积分查询失败')
          logLine('settle credits probe failed: ' + after.creditsError)
        }
      }
    } catch (error) {
      after.creditsError = String((error && error.message) || error)
      logLine('settle credits probe threw: ' + after.creditsError)
    }
  }
  after.at = localTimeOf()

  // 后值采样已经真实发生过，把「上次查询」的时间戳推进一下，
  // 免得后台轮询紧接着又打一遍同样的接口。
  if (wantBalance === true || wantCredits === true) {
    changeState.lastProbeAt = Date.now()
    changeState.lastProbeResult = {
      balance: wantBalance === true ? (after.balance?.ok === true ? '已读到' : '读取失败') : changeState.lastProbeResult.balance,
      credits: wantCredits === true
        ? (Array.isArray(after.creditAccounts) && after.creditAccounts.length > 0
          ? '已读到 ' + after.creditAccounts.length + ' 个账号'
          : '读取失败')
        : changeState.lastProbeResult.credits,
      creditsPlugin: changeState.lastProbeResult.creditsPlugin,
      at: after.at,
    }
  }

  const input = {
    wantToken,
    wantBalance,
    wantCredits,
    tokenDelta: wantToken === true ? Number(base?.turnToken ?? state?.turnToken ?? 0) : 0,
    tokenTotal: changeState.tokenTotal,
    settle: config?.settle,
    pair: { before, after },
  }
  // 回合结束就把前值清掉：下一轮由 turn/start 重新采，绝不把上一轮的当成这一轮的。
  if (state) state.beforeSample = null


  const built = buildSettleCandidate(input)
  changeState.lastSettle = { at: localTimeOf(), detail: built.reason, sent: built.candidate !== null }
  if (built.candidate === null) {
    logLine('turnSettle skipped: ' + built.reason)
    return
  }

  try {
    handleCandidate({
      ...built.candidate,
      sessionId: base.sessionId,
      cwd: base.cwd,
      title: base.title,
      elapsedMs: base.elapsedMs,
    }, { config })
  } catch (error) {
    logLine('turnSettle candidate failed: ' + String((error && error.message) || error))
  }
}

/**
 * 轮询「余额 / 积分」，变化超阈值就发通知。
 *
 * 一次只查需要查的那几路（对应触发开关打开才查），任何一路失败都只记原因、
 * 绝不发假通知。查询本身有最小间隔（changes.probeIntervalMinutes），
 * 因为额度类接口都有限流。
 */
export async function runChangeProbe(ctx, options = {}) {
  const config = options.config ?? readConfig()
  const force = options.force === true
  const out = { balance: '', credits: '', creditsPlugin: '', checked: false }

  const wantBalance = config?.triggers?.balanceChange === true
  const wantCredits = config?.triggers?.creditsChange === true
  const wantPlugin = config?.triggers?.creditsPluginChange === true
  if (!wantBalance && !wantCredits && !wantPlugin) {
    changeState.lastProbeResult = { balance: '未开启', credits: '未开启', creditsPlugin: '未开启', at: localTimeOf() }
    return { ok: true, ...changeState.lastProbeResult, checked: false }
  }

  // 两条独立的时间闸门：
  //  - 余额 + 单账号积分共用 probeIntervalMinutes（同一个对外余额接口 / 同一个 /usage 路由）；
  //  - 多账号积分用 creditsPluginIntervalMinutes（默认更短，且是逐账号的真实上游调用）。
  // 早先这里是**一个** lastProbeAt 挡住全部三路，导致「把多账号间隔调短」实际不生效。
  const nowMs = Date.now()
  const legacyInterval = Math.max(1, Number(config?.changes?.probeIntervalMinutes) || 5) * 60_000
  const legacyWanted = wantBalance || wantCredits
  const legacyDue = force || changeState.lastProbeAt === 0 || nowMs - changeState.lastProbeAt >= legacyInterval
  const pluginInterval = Math.max(1, Number(config?.changes?.creditsPluginIntervalMinutes) || 2) * 60_000
  const pluginDue = force || changeState.lastPluginProbeAt === 0 || nowMs - changeState.lastPluginProbeAt >= pluginInterval

  if (!(legacyWanted && legacyDue) && !(wantPlugin && pluginDue)) {
    const waitMin = Math.max(1, Math.min(
      legacyWanted && !legacyDue ? Math.ceil((legacyInterval - (nowMs - changeState.lastProbeAt)) / 60000) : 99,
      wantPlugin && !pluginDue ? Math.ceil((pluginInterval - (nowMs - changeState.lastPluginProbeAt)) / 60000) : 99,
    ))
    return { ok: true, ...changeState.lastProbeResult, checked: false, skipped: '距上次查询不到 ' + waitMin + ' 分钟' }
  }

  const snapshot = readSnapshot()

  if (legacyWanted && legacyDue) {
    changeState.lastProbeAt = nowMs
  }

  if (wantBalance && legacyDue) {
    const probe = await probeBalance(ctx, { keys: config?.changes?.balanceKeys })
    if (probe.ok !== true) {
      out.balance = '读取失败：' + String(probe.error ?? '')
      logLine('balance probe failed: ' + out.balance)
    } else {
      // 上一次的三项拆分存在 balanceAccounts 里，用于写清「是充值还是赠金在动」。
      const prevAccounts = Array.isArray(snapshot?.balanceAccounts) ? snapshot.balanceAccounts : []
      const prevById = new Map(prevAccounts.map((item) => [String(item?.name ?? ''), item]))
      const withPrev = (Array.isArray(probe.accounts) ? probe.accounts : []).map((item) => ({
        ...item,
        prev: prevById.get(String(item?.name ?? '')) ?? null,
      }))
      // ★ v0.1.13：实时值与陈旧快照**绝不可比**。
      //
      // 事故现场（history.json 里有 18 条，成对出现）：
      //   08:24:23 本机快照 239.24 → 307.84  +68.6
      //   08:29:23 官方接口 307.84 → 239.24  -68.6
      // 307.84 出自 provider-snapshots.json（mtime 停在 2026-10-18），是永远不动的死数据。
      // 只要官方接口偶尔超时/被限流一次，探测就会降级读快照，于是基准被写成 307.84，
      // 下一轮实时值回来又变成「暴跌」，来回乒乓，全是假的。
      //
      // 规则（两条，缺一不可）：
      //  1. 本次读到快照（probe.stale）：**不比较、不通知、也不覆盖基准**
      //     —— 拿死数据盖掉实时基准，下一轮就必然假跌。
      //  2. 基准本身是快照（snapshot.balanceStale）：本次实时值**不比较、不通知，
      //     只把基准换成实时值** —— 这是「基准校正」，不是「余额变化」。
      const wasStale = snapshot?.balanceStale === true
      const isStale = probe.stale === true
      const comparable = !isStale && !wasStale
      const verdict = comparable
        ? judgeChange(snapshot?.balanceValue, probe.value, config?.changes?.balanceMinDelta)
        : { changed: false, seeded: false, delta: 0, reason: '' }
      out.balance = isStale ? '已读到（快照，非实时）' : '已读到'
      if (isStale) {
        out.balance += '，快照不参与比对'
      } else if (wasStale) {
        out.balance += '，基准已从快照校正为实时值'
      }
      if (verdict.changed === true) {
        const candidate = buildBalanceCandidate({ ...probe, accounts: withPrev }, Number(snapshot.balanceValue), verdict.delta)
        try {
          handleCandidate(candidate, { config })
        } catch (error) {
          logLine('balanceChange candidate failed: ' + String((error && error.message) || error))
        }
      } else if (verdict.seeded === true) {
        out.balance += '，首次记下基准'
      }
      // 是否覆盖基准：
      //  - 实时值：总是覆盖（否则「没到阈值」的多次变化会累积到某次爆发）；
      //  - 快照值：**只有当前还没有任何基准时**才写入（第一次装插件又没有 Key 时可显示），
      //    已有基准就原样保留，绝不用死数据盖实时值。
      const hasBaseline = snapshot?.balanceValue !== undefined && snapshot?.balanceValue !== null && snapshot?.balanceValue !== ''
      if (!isStale || !hasBaseline) {
        patchSnapshot({
          balanceValue: probe.value,
          balanceCurrency: probe.currency,
          balanceSource: probe.source,
          balanceAt: probe.dataTime,
          balanceStale: isStale,
          balanceAccounts: withPrev.map((item) => ({
            name: String(item?.name ?? ''),
            label: String(item?.label ?? ''),
            total: Number(item?.total),
            // 同 settleTurn：缺失字段必须存 null，不能因为 Number(null)===0 存成 0。
            toppedUp: numOrNull(item?.toppedUp),
            granted: numOrNull(item?.granted),
            currency: String(item?.currency ?? 'CNY'),
          })),
        })
      }
    }
  }

  if (wantCredits && legacyDue) {
    const probe = await probeCredits(ctx, config?.changes?.region)
    if (probe.ok !== true) {
      out.credits = '读取失败：' + String(probe.error ?? '')
      logLine('credits probe failed: ' + out.credits)
    } else {
      const verdict = judgeChange(snapshot?.creditsValue, probe.value, config?.changes?.creditsMinDelta)
      out.credits = '已读到'
      if (verdict.changed === true) {
        const candidate = buildCreditsCandidate(probe, Number(snapshot.creditsValue), verdict.delta)
        try {
          handleCandidate(candidate, { config })
        } catch (error) {
          logLine('creditsChange candidate failed: ' + String((error && error.message) || error))
        }
      } else if (verdict.seeded === true) {
        out.credits += '，首次记下基准'
      }
      patchSnapshot({
        creditsValue: probe.value,
        creditsRegion: probe.region,
        creditsAt: probe.dataTime,
      })
    }
  }

  if (wantPlugin && pluginDue) {
    changeState.lastPluginProbeAt = Date.now()
    const probe = await probeAccountCredits(ctx, config?.changes?.region)
    if (probe.ok !== true) {
      out.creditsPlugin = '读取失败：' + String(probe.error ?? '')
      logLine('creditsPlugin probe failed: ' + out.creditsPlugin)
    } else {
      const prevMap = snapshot?.creditsPluginValues && typeof snapshot.creditsPluginValues === 'object'
        ? snapshot.creditsPluginValues
        : {}
      const diff = diffAccountCredits(prevMap, probe.accounts, config?.changes?.creditsPluginMinDelta)
      out.creditsPlugin = '已读到 ' + probe.accounts.length + ' 个账号'
      if (diff.changed === true) {
        const candidate = buildCreditsPluginCandidate(probe, diff.moved, diff.deltaSum, diff.total)
        try {
          handleCandidate(candidate, { config })
        } catch (error) {
          logLine('creditsPluginChange candidate failed: ' + String((error && error.message) || error))
        }
      } else if (diff.seeded.length > 0 && diff.seeded.length === probe.accounts.length) {
        out.creditsPlugin += '，首次记下基准'
      } else if (diff.seeded.length > 0) {
        out.creditsPlugin += '，' + diff.seeded.length + ' 个新账号记下基准'
      }
      // 新基准 = 旧表 + 本次读到的账号（**消失的账号保留旧值**：
      // 它可能只是这次没取到，删掉会让它下次回来又被当成「新账号」）。
      const nextMap = { ...prevMap }
      for (const account of probe.accounts) nextMap[account.id] = account.value
      patchSnapshot({
        creditsPluginValues: nextMap,
        creditsPluginRegion: probe.region,
        creditsPluginAt: probe.dataTime,
      })
    }
  }

  changeState.lastProbeResult = { balance: out.balance, credits: out.credits, creditsPlugin: out.creditsPlugin, at: localTimeOf() }
  return { ok: true, ...out, checked: true }
}

/** 本地时间（避免为一个时间串再多 import 一个模块）。 */
function localTimeOf() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

/**
 * 启动变化类轮询（插件 apply 时调一次）。
 *
 * 用 setTimeout 递归而不是 setInterval：每次轮询耗时不定，
 * setInterval 会在慢查询时叠加；递归保证「上一次查完才排下一次」。
 * 定时器 unref()，不阻止进程退出。
 */
export function startChangeProbe(ctx) {
  if (changeState.probeTimer) return
  const tick = async () => {
    try {
      await runChangeProbe(ctx)
    } catch (error) {
      logLine('change probe tick failed: ' + String((error && error.message) || error))
    }
    const config = readConfig()
    // 下一次什么时候再跑：取**所有已开启**的那几路里最短的间隔。
    // 例：只开多账号（2 分钟）→ 2 分钟一跳；同时开余额（5 分钟）→ 仍 2 分钟一跳，
    // 但余额那一路会被自己的闸门挡住，不会跟着变密。
    const intervals = []
    if (config?.triggers?.balanceChange === true || config?.triggers?.creditsChange === true) {
      intervals.push(Math.max(1, Number(config?.changes?.probeIntervalMinutes) || 5))
    }
    if (config?.triggers?.creditsPluginChange === true) {
      intervals.push(Math.max(1, Number(config?.changes?.creditsPluginIntervalMinutes) || 2))
    }
    const interval = (intervals.length > 0 ? Math.min(...intervals) : 5) * 60_000
    changeState.probeTimer = setTimeout(() => { void tick() }, interval)
    if (typeof changeState.probeTimer.unref === 'function') changeState.probeTimer.unref()
  }
  // 插件刚起来时先等一个间隔再查，避免与宿主启动抢资源。
  changeState.probeTimer = setTimeout(() => { void tick() }, 20_000)
  if (typeof changeState.probeTimer.unref === 'function') changeState.probeTimer.unref()
}

/** 停掉变化类轮询（插件卸载 / 被禁用时调）。 */
export function stopChangeProbe() {
  if (changeState.probeTimer) {
    clearTimeout(changeState.probeTimer)
    changeState.probeTimer = null
  }
}

/** 供界面读变化类的运行状况（不含任何凭据）。 */
export function changeSnapshot() {
  return {
    tokenTotal: changeState.tokenTotal,
    notifiedTotal: changeState.notifiedTotal,
    lastProbeAt: changeState.lastProbeAt,
    lastPluginProbeAt: changeState.lastPluginProbeAt,
    lastProbe: changeState.lastProbeResult,
    lastSettle: changeState.lastSettle,
    snapshotPath: SNAPSHOT_PATH,
  }
}

/** 会话事件里的「回合耗时」：用 turn/start 记的起点算。 */
function elapsedOf(state) {
  if (!state?.turnStartedAt) return 0
  return Math.max(0, Date.now() - state.turnStartedAt)
}

/**
 * 主入口：处理一条 session/event。
 *
 * 事件类型只关心 5 种：
 *   turn/start（记起点 + 起定时器）、任意事件（刷新活跃时间）、
 *   tool/result（失败统计，供 toolFailure 触发）、
 *   assistant/message（关键词触发）、turn/end（主触发点）。
 */
export function onSessionEvent(ctx, session, event) {
  try {
    if (!event || typeof event !== 'object') return
    const config = readConfig()
    if (config.enabled !== true) return

    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    const state = stateOf(sessionId)
    state.lastEventAt = Date.now()

    const type = String(event.type ?? '')

    // Token 累计与「回合结局」无关，任何带 usage 的事件都要累加（宿主在
    // assistant/message、部分 tool/result 上都会带）。放在类型分支之前，避免漏计。
    try {
      accumulateUsage(config, event)
    } catch (error) {
      logLine('accumulateUsage failed: ' + String((error && error.message) || error))
    }
    // 「本回合」增量单独累加（零 IO）。回合结算用它出账，
    // 不能拿「本机累计差」代替 —— 并发回合会把别人的消耗算进来。
    try {
      accumulateTurnUsage(config, state, event)
    } catch (error) {
      logLine('accumulateTurnUsage failed: ' + String((error && error.message) || error))
    }

    const header = session?.header && typeof session.header === 'object' ? session.header : {}
    const cwd = String(header.cwd ?? session?.cwd ?? '')
    const events = Array.isArray(session?.events) ? session.events : []

    // v0.1.17 第 2 层兜底：turn/start 没送到插件时，用本回合第一个后续事件补采前值。
    // 放在类型分支之前，这样 tool/result、assistant/message 这些「早退」分支也能触发。
    try {
      maybeCatchUpBeforeSample(config, ctx, state, type, event)
    } catch (error) {
      logLine('maybeCatchUpBeforeSample failed: ' + String((error && error.message) || error))
    }

    if (type === 'turn/start') {
      const turn = Number(event?.data?.turn)
      state.turn = Number.isFinite(turn) ? turn : state.turn + 1
      state.turnStartedAt = Date.now()
      state.timeoutNotifiedTurn = 0
      // 新回合开始时把「无进展已提醒」标记清掉，否则下一回合停住就不会再提醒。
      state.progressNotifiedAt = 0
      clearTimers(state)
      // 清掉上一轮的前值采样，并立刻异步采一次本轮的（v0.1.11）。
      // 绝不 await：采样要联网，等待它会阻塞宿主的事件链。
      state.beforeSample = null
      state.beforeSampleTried = false
      startBeforeSampling(config, ctx, state, 'turn-start')
      // 超时告警：跑太久还没 turn/end 就提醒一次（同轮不重复提醒）
      if (config.triggers?.timeout === true) {
        const ms = Math.max(1, Number(config.timeoutMinutes) || 30) * 60_000
        state.timeoutTimer = setTimeout(() => {
          try {
            // 同一回合只提醒一次（原写法用了不存在的字段名，守卫恒为假，等于没守卫）。
            if (state.timeoutNotifiedTurn === state.turn) return
            state.timeoutNotifiedTurn = state.turn
            handleCandidate({
              kind: 'timeout',
              sessionId,
              cwd,
              title: titleFromEvents(events),
              detail: '已运行 ' + Math.round(elapsedOf(state) / 60000) + ' 分钟仍未结束',
              assistantText: lastAssistantText(events),
              tools: countTools(events, state.turn),
              elapsedMs: elapsedOf(state),
            }, { config: readConfig() })
          } catch (error) {
            logLine('timeout candidate failed: ' + String((error && error.message) || error))
          }
        }, ms)
        if (typeof state.timeoutTimer.unref === 'function') state.timeoutTimer.unref()
      }
      // 无进展告警：N 分钟没有任何新事件就提醒
      if (config.triggers?.noProgress === true) {
        const ms = Math.max(1, Number(config.noProgressMinutes) || 10) * 60_000
        const scheduleProgress = () => {
          if (state.progressTimer) clearTimeout(state.progressTimer)
          state.progressTimer = setTimeout(() => {
            try {
              const quietMs = Date.now() - state.lastEventAt
              if (quietMs < ms) { scheduleProgress(); return }
              // 同一个「静默窗口」只提醒一次：如果上次提醒之后又有新事件，才算新的停滞。
              if (state.progressNotifiedAt > 0 && state.lastEventAt <= state.progressNotifiedAt) { scheduleProgress(); return }
              handleCandidate({
                kind: 'noProgress',
                sessionId,
                cwd,
                title: titleFromEvents(events),
                detail: '已 ' + Math.round(quietMs / 60000) + ' 分钟没有任何新事件',
                assistantText: lastAssistantText(events),
                tools: countTools(events, state.turn),
                elapsedMs: elapsedOf(state),
              }, { config: readConfig() })
              state.progressNotifiedAt = Date.now()
              scheduleProgress()
            } catch (error) {
              logLine('noProgress candidate failed: ' + String((error && error.message) || error))
            }
          }, ms)
          if (typeof state.progressTimer.unref === 'function') state.progressTimer.unref()
        }
        scheduleProgress()
      }
      return
    }

    if (type === 'tool/result') {
      if (config.triggers?.toolFailure !== true) return
      // 失败判定只认 data.message.isError === true（已从真实样本核实）
      if (event?.data?.message?.isError !== true) return
      const callId = String(event?.data?.toolCallId ?? event?.data?.message?.toolCallId ?? '')
      const toolName = findToolName(events, callId)
      const text = firstTextOf(event?.data?.message?.content)
      handleCandidate({
        kind: 'toolFailure',
        sessionId,
        cwd,
        title: titleFromEvents(events),
        detail: (toolName !== '' ? '工具 ' + toolName + ' 失败：' : '工具调用失败：') + excerpt(text, 160),
        assistantText: lastAssistantText(events),
        tools: countTools(events, state.turn),
        elapsedMs: elapsedOf(state),
      }, { config })
      return
    }

    if (type === 'assistant/message') {
      if (config.triggers?.keyword !== true) return
      const content = event?.data?.message?.content
      const text = Array.isArray(content)
        ? content.filter((p) => String(p?.type ?? '') === 'text').map((p) => String(p?.text ?? '')).join('\n')
        : ''
      const hit = matchKeyword(config.keywords, text)
      if (hit === '') return
      handleCandidate({
        kind: 'keyword',
        sessionId,
        cwd,
        title: titleFromEvents(events),
        detail: '命中关键词「' + hit + '」',
        assistantText: text,
        tools: countTools(events, state.turn),
        elapsedMs: elapsedOf(state),
      }, { config })
      return
    }

    if (type === 'turn/end') {
      const turn = Number(event?.data?.turn)
      const reasonKind = String(event?.data?.reason?.kind ?? '')
      const mapped = mapTurnEndKind(reasonKind)
      const elapsedMs = elapsedOf(state)
      clearTimers(state)

      if (mapped === null) {
        // 未知 kind：记一行日志就好，绝不猜成「完成」发出去。
        logLine('unknown turn/end reason: ' + reasonKind + ' (session ' + sessionId.replace(/^session-/, '').slice(0, 8) + ')')
        state.turnStartedAt = 0
        return
      }

      const errInfo = event?.data?.reason?.error
      const detail = mapped === 'error'
        ? String(errInfo?.message ?? errInfo?.code ?? '未知错误')
        : mapped === 'aborted'
          ? (event?.data?.reason?.reason?.kind === 'parent' ? '被父会话终止' : '被中断')
          : ''

      handleCandidate({
        kind: mapped,
        sessionId,
        cwd,
        title: titleFromEvents(events),
        detail,
        assistantText: lastAssistantText(events),
        tools: countTools(events, Number.isFinite(turn) ? turn : state.turn),
        elapsedMs,
      }, { config })

      // 「本回合结算」：独立一条通知，单独一个触发开关。
      // 它要查余额/积分（异步），所以不能 await —— 绝不能阻塞宿主事件链。
      // 本轮 Token 增量先快照下来再清零，避免结算异步期间被下一轮的消耗污染。
      const turnToken = Number(state.turnToken ?? 0)
      state.turnToken = 0
      // 必须把**真实的 state** 传进去：回合开始时那次采样存在 state.beforeSample 里，
      // 早先这里是传了个只含 turnToken 的字面量对象，导致「回合前」永远是空，
      // 结算只能显示「回合开始时没采到」。
      void settleTurn(config, ctx, state, {
        turnToken,
        sessionId,
        cwd,
        title: titleFromEvents(events),
        elapsedMs,
      }).catch((error) => {
        logLine('settleTurn failed: ' + String((error && error.message) || error))
      })

      state.turnStartedAt = 0
      return
    }
  } catch (error) {
    // 绝不让异常冒到宿主事件链
    logLine('onSessionEvent failed: ' + String((error && error.message) || error))
  }
}

/** 从事件流里按 callId 找回工具名（tool/result 本身不带 name）。 */
function findToolName(events, callId) {
  if (callId === '') return ''
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ev = list[i]
    if (String(ev?.type ?? '') !== 'tool/call') continue
    if (String(ev?.data?.callId ?? '') !== callId) continue
    return String(ev?.data?.name ?? '')
  }
  return ''
}

/** 取 message.content 里第一段文字。 */
function firstTextOf(content) {
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    if (String(part?.type ?? '') === 'text') {
      const text = String(part?.text ?? '').trim()
      if (text !== '') return text
    }
  }
  return ''
}

/**
 * 处理宿主 `user-questions/request`（waterfall）——「Agent 在问你问题」的唯一入口。
 *
 * 三条硬性纪律（写错会直接影响提问链路，比不发通知严重得多）：
 *  1. **必须 return next?.()**：这是 waterfall，不调 next() 等于否决整条链，
 *     Web GUI 不会再弹提问、Agent 会拿到 NO_PROVIDER。所以本函数无论走哪条分支，
 *     最后都交给下一个监听器。
 *  2. **必须 async 且不阻塞**：通知走的是串行队列（handleCandidate → enqueue），
 *     这里只做一次轻量的规则判定，绝不 await 发送。
 *  3. **抛错也放行**：整段 try/catch，异常只记日志，绝不让它冒到提问链路。
 *
 * @param {any} req     user-questions/request 的请求对象
 * @param {Function} next 链条里的下一个监听器（必须调用）
 * @param {any} [ctx]   cordis 上下文（可选，仅用于补会话工作目录/标题）
 * @returns {Promise<any>} next() 的结果
 */
export async function onUserQuestion(req, next, ctx) {
  try {
    const config = readConfig()
    if (config.enabled === true && config.triggers?.question === true) {
      const candidate = buildQuestionCandidate(req)
      if (candidate) {
        // 钩子给的 request 有时不带 cwd/title，用宿主会话对象补一下（有就补，没有就算了）
        const sid = candidate.sessionId
        if ((candidate.cwd === '' || candidate.title === '') && sid !== '' && ctx?.sessions?.get) {
          try {
            const session = ctx.sessions.get(sid)
            if (candidate.cwd === '') candidate.cwd = String(session?.header?.cwd ?? '')
            if (candidate.title === '') candidate.title = String(session?.title ?? '')
          } catch {
            // 补不到就算了，不影响发通知
          }
        }
        handleCandidate(candidate, { config })
      }
    }
  } catch (error) {
    logLine('onUserQuestion failed: ' + String((error && error.message) || error))
  }
  // 无论上面发生了什么，都必须把链交下去
  return typeof next === 'function' ? next() : undefined
}

/** 供界面读取的统计快照。 */
export function statsSnapshot() {
  return { ...stats, queueLength: queue.length, sending, sessions: sessions.size }
}

/** 供界面/测试读某个会话的运行态（不含任何敏感信息）。 */
export function sessionState(sessionId) {
  const state = sessions.get(String(sessionId ?? ''))
  if (!state) return null
  return {
    turn: state.turn,
    turnStartedAt: state.turnStartedAt,
    lastEventAt: state.lastEventAt,
    lastSentAt: state.lastSentAt,
    timeoutPending: state.timeoutTimer !== null,
    progressPending: state.progressTimer !== null,
  }
}

/** 进程退出/插件卸载时清干净，避免残留定时器。 */
export function disposeWatcher() {
  for (const state of sessions.values()) clearTimers(state)
  sessions.clear()
  queue.length = 0
  // 变化类轮询也要停：不停会在插件被禁用后继续查外部接口。
  stopChangeProbe()
}
