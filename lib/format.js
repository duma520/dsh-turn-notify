/**
 * lib/format.js —— 通知文案拼装（纯字符串处理，可单测）。
 *
 * 设计原则：
 *  1. **只发摘要，不外推全文**：默认只带「结束原因 + 会话标题 + 最后一条助手消息前 N 字」，
 *     避免把整轮对话内容推到 IM（隐私与体积双重考虑）。
 *  2. 每条通知第一行就能看出「是什么情况」，不会被 IM 折叠掉关键信息。
 *  3. 时间用本地时间（Asia/Shanghai），不用 UTC，避免用户换算。
 *
 * @module format.js
 */

/** 触发类型 → 通知里的图标与短标签（一眼可辨，不依赖颜色）。 */
const BADGES = {
  completed: { icon: '✅', label: '回合完成' },
  error: { icon: '❌', label: '回合出错' },
  aborted: { icon: '⏹', label: '回合中断' },
  maxTokens: { icon: '✂️', label: '输出截断' },
  timeout: { icon: '⏰', label: '任务超时' },
  noProgress: { icon: '😴', label: '长时间无进展' },
  toolFailure: { icon: '🔧', label: '工具失败' },
  keyword: { icon: '🔍', label: '命中关键词' },
  question: { icon: '❓', label: '等你回答问题' },
}

/** 取某个触发类型的徽标；未知类型给通用徽标，绝不返回 undefined。 */
export function badgeOf(kind) {
  return BADGES[String(kind ?? '')] ?? { icon: '🔔', label: '通知' }
}

/** 本地时间 'YYYY-MM-DD HH:MM:SS'。 */
export function localTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const p = (n) => String(n).padStart(2, '0')
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  )
}

/** 把长文本压成单行并截断，避免正文把通知撑得过长。 */
export function excerpt(text, limit) {
  const max = Number(limit)
  if (!Number.isFinite(max) || max <= 0) return ''
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  // 按码点切，避免把 emoji / 生僻字切一半（UTF-16 代理对）。
  const chars = Array.from(flat)
  if (chars.length <= max) return flat
  return chars.slice(0, max).join('') + '…'
}

/**
 * 从回合事件里挑出「最后一条助手正文」。
 *
 * 只取 type === 'text' 的片段，**不要 reasoning**（思考过程不该外推到 IM）。
 */
export function lastAssistantText(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ev = list[i]
    if (String(ev?.type ?? '') !== 'assistant/message') continue
    const content = ev?.data?.message?.content
    if (!Array.isArray(content)) continue
    const texts = content
      .filter((part) => String(part?.type ?? '') === 'text')
      .map((part) => String(part?.text ?? ''))
      .filter((t) => t.trim() !== '')
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

/** 从事件里数工具调用次数与失败次数（只统计本轮）。 */
export function countTools(events, turn) {
  const list = Array.isArray(events) ? events : []
  let calls = 0
  let failures = 0
  for (const ev of list) {
    const type = String(ev?.type ?? '')
    if (type !== 'tool/call' && type !== 'tool/result') continue
    if (turn != null && ev?.data?.turn != null && ev.data.turn !== turn) continue
    if (type === 'tool/call') calls += 1
    if (type === 'tool/result' && ev?.data?.message?.isError === true) failures += 1
  }
  return { calls, failures }
}

/** 从事件里取会话标题（宿主会自动生成 session/title）。 */
export function titleFromEvents(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ev = list[i]
    if (String(ev?.type ?? '') !== 'session/title') continue
    const title = String(ev?.data?.title ?? '').trim()
    if (title !== '') return title
  }
  return ''
}

/** 把毫秒时长说成人话：90 秒 / 12 分钟 / 1 小时 5 分钟。 */
export function humanDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000))
  if (!Number.isFinite(total)) return '0 秒'
  if (total < 60) return total + ' 秒'
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? hours + ' 小时' : hours + ' 小时 ' + rest + ' 分钟'
}

/**
 * 组装通知正文。
 *
 * @param {object} input
 * @param {string} input.kind 触发类型
 * @param {string} [input.prefix] 标题前缀（配置里的 titlePrefix）
 * @param {string} [input.title] 会话标题
 * @param {string} [input.sessionId] 会话 id（会截短显示，不暴露完整 uuid）
 * @param {string} [input.cwd] 工作目录
 * @param {string} [input.detail] 补充说明（错误信息等）
 * @param {string} [input.assistantText] 助手最后一段正文
 * @param {number} [input.excerptChars] 正文截断长度
 * @param {{calls:number, failures:number}} [input.tools] 工具统计
 * @param {number} [input.elapsedMs] 本轮耗时
 * @param {Date} [input.now] 当前时间
 * @returns {{ title: string, text: string }}
 */
export function composeNotification(input) {
  const kind = String(input?.kind ?? '')
  const badge = badgeOf(kind)
  const prefix = String(input?.prefix ?? '').trim() || 'DSH 回合通知'
  const title = badge.icon + ' ' + prefix + '：' + badge.label

  const lines = []
  lines.push(badge.icon + ' ' + badge.label)
  const sessionTitle = String(input?.title ?? '').trim()
  if (sessionTitle !== '') lines.push('会话：' + sessionTitle)

  // 会话 id 只给前 8 位：足够区分，又不至于把 uuid 全量外推。
  // 必须先把 `session-` 前缀剥掉再截——宿主内部 id 普遍是 session-<uuid>，
  // 直接 slice(0, 8) 会得到 'session-' 这种毫无信息量的结果（真实踩过）。
  const sid = String(input?.sessionId ?? '').trim().replace(/^session-/, '')
  if (sid !== '') lines.push('会话 ID：' + sid.slice(0, 8))

  const cwd = String(input?.cwd ?? '').trim()
  if (cwd !== '') lines.push('工作区：' + cwd)

  const elapsed = Number(input?.elapsedMs)
  if (Number.isFinite(elapsed) && elapsed > 0) lines.push('本轮耗时：' + humanDuration(elapsed))

  const tools = input?.tools
  if (tools && Number.isFinite(Number(tools.calls)) && Number(tools.calls) > 0) {
    const fails = Number(tools.failures) || 0
    lines.push('工具调用：' + Number(tools.calls) + ' 次' + (fails > 0 ? '（失败 ' + fails + ' 次）' : ''))
  }

  const detail = String(input?.detail ?? '').trim()
  if (detail !== '') lines.push('说明：' + excerpt(detail, 200))

  // 「Agent 提问」这类通知要把逐题逐选项原样列出来：压成一行就没法选，
  // 所以这里不做 excerpt，只按行追加（行数与选项数已由 questions.js 限流）。
  const extra = Array.isArray(input?.extraLines) ? input.extraLines : []
  if (extra.length > 0) {
    lines.push('')
    for (const line of extra) lines.push(String(line ?? ''))
  }

  // excerptChars 没传（手工调用 / 老配置）时按 300 兜底，否则正文会被静默丢光。
  const body = excerpt(input?.assistantText, input?.excerptChars ?? 300)
  if (body !== '') {
    lines.push('')
    lines.push('最后一段回复：')
    lines.push(body)
  }

  lines.push('')
  lines.push('时间：' + localTime(input?.now instanceof Date ? input.now : new Date()))

  return { title, text: lines.join('\n') }
}
