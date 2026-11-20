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
import { readConfig, appendHistory, logLine, readImActiveSessionIds } from './paths.js'
import { buildQuestionCandidate } from './questions.js'

/** 每个会话的运行时状态（内存里，进程退出即丢，不落盘）。 */
const sessions = new Map()

/** 串行发送队列：同一时刻只有一条在飞。 */
let sending = false
const queue = []

/** 全局统计：界面上「今日已发 N 条」用它。 */
const stats = { sent: 0, failed: 0, skipped: 0, lastAt: '', lastError: '', lastReason: '' }

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
    }
    sessions.set(id, state)
  }
  return state
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
    const header = session?.header && typeof session.header === 'object' ? session.header : {}
    const cwd = String(header.cwd ?? session?.cwd ?? '')
    const events = Array.isArray(session?.events) ? session.events : []

    if (type === 'turn/start') {
      const turn = Number(event?.data?.turn)
      state.turn = Number.isFinite(turn) ? turn : state.turn + 1
      state.turnStartedAt = Date.now()
      state.timeoutNotifiedTurn = 0
      // 新回合开始时把「无进展已提醒」标记清掉，否则下一回合停住就不会再提醒。
      state.progressNotifiedAt = 0
      clearTimers(state)
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
}
