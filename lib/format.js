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
  balanceChange: { icon: '💰', label: 'DeepSeek 余额变化' },
  tokenChange: { icon: '🧮', label: 'Token 消耗累计' },
  creditsChange: { icon: '🎫', label: 'WorkBuddy 积分变化' },
  creditsPluginChange: { icon: '🎟️', label: 'WorkBuddy 积分变化（多账号）' },
  // 「每回合结算」不是变化类：它属于某一轮对话（有会话/耗时），
  // 但正文主体是三项明细，所以走普通回合通知的行序 + extraLines。
  turnSettle: { icon: '🧾', label: '本回合结算' },
}

/** 变化类触发（没有会话，文案结构也不同）。 */
const CHANGE_BADGES = ['balanceChange', 'tokenChange', 'creditsChange', 'creditsPluginChange']

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
  // 变化类通知没有会话/工作区/耗时/工具这些行，走独立的一套行序。
  // 在这里委派是为了让调用方只用一个入口——规则、冷却、目标的处理路径
  // 与回合通知完全一致，不给变化类另开一条发送通道。
  if (CHANGE_BADGES.includes(kind)) return composeChangeNotification(input)
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

/**
 * 把数字说成人话：大数按「万 / 亿」缩写，小数保留两位且去掉无意义的 0。
 *
 * 为什么不用 toLocaleString：Node 在不同 ICU 版本下的输出不完全一致，
 * 单测会因为环境差异挂掉；这里自己算，行为稳定。
 */
export function humanNumber(value, unit = '') {
  // Number(null) === 0，会把「没有数据」显示成 0 —— 先挡掉空值。
  if (value == null || value === '') return '—' + unit
  const n = Number(value)
  if (!Number.isFinite(n)) return '—' + unit
  const abs = Math.abs(n)
  // 去掉小数尾随的 0：'1.50' → '1.5'，'2.00' → '2'。
  // 这里不用带转义符的正则 —— 之前的 /(\.\d*?)0+$/ 在源码里丢了反斜杠，
  // 变成 /(.d*?)0+$/ 后会把 '0.50' 里的 '5' 一起吃掉，输出成 '0.'。
  const trim = (s) => {
    if (!s.includes('.')) return s
    const t = s.replace(/0+$/, '')
    return t.endsWith('.') ? t.slice(0, -1) : t
  }
  if (abs >= 1e8) return trim((n / 1e8).toFixed(2)) + ' 亿' + unit
  if (abs >= 1e4) return trim((n / 1e4).toFixed(2)) + ' 万' + unit
  if (Number.isInteger(n)) return String(n) + unit
  return trim(n.toFixed(2)) + unit
}

/**
 * 带符号的差值：「+1.23」「-0.45」。
 *
 * 余额与积分都是「变大变小都有意义」的量，所以必须带符号；
 * Token 只会变大，也用同一个函数，正号会让「涨了多少」更明确。
 */
export function humanDelta(value, unit = '') {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '-' : '±'
  return sign + humanNumber(Math.abs(n), unit)
}

/**
 * 涨跌三角：涨 🔺 / 跌 🔻 / 没变化**不加任何标记**。
 *
 * 为什么用箭头而不是给文字上色：IM 通知正文是**纯文本**，
 * QQ、Telegram 都不支持在纯文本里指定颜色（只有 Markdown/HTML 才有那能力，
 * 而各通道对 Markdown 的支持参差不齐，强行上色只会在部分通道变成一堆星号）。
 * 三角 emoji 在所有通道都能显示，还能跟着文字一起复制。
 *
 * ⚠️ 注意：🔺（U+1F53A）与 🔻（U+1F53B）**都是红色的**，颜色本身不区分方向，
 * 只能靠三角形朝上/朝下辨别。这是用户 2026-11-25 明确指定的样式
 * （原文：「🔽🔼🔺🔻看看哪个能用，我想换成这种🔺🔻」），已确认接受。
 *
 * 为什么「没变化」返回空串（不是某种中性符号）：
 *  1. 用户明确要求「没变化就不需要 emoji」——±0 的行本来就写着「（±0 元）」，
 *     再挂一个标记是纯噪音；
 *  2. 返回空串也让「没有可判断的数值」自然落空——「没采到」和「±0」都不该有箭头，
 *     但两者含义完全不同，由调用方各自决定写「未采到」还是不写。若这里统一返回
 *     一个中性符号，就会把「数据缺失」伪装成「数值没动」，这是本项目反复踩过的坑
 *     （Number(null) === 0）。
 */
export function trendEmoji(value) {
  if (value === null || value === undefined || value === '') return ''
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  if (n > 0) return '🔺'
  if (n < 0) return '🔻'
  return ''
}

/**
 * 组装「变化类」通知正文（余额 / Token / 积分）。
 *
 * 与回合通知的差别：
 *  - 没有会话、会话 ID、工作区、本轮耗时、最后一段回复；
 *  - 核心信息是「从多少 → 多少，差了多少」，即 oldValue / newValue / delta；
 *  - 数据来源与时间必须写清楚：快照数据要明确标注「非实时」，
 *    绝不能让用户以为那是刚刚查到的真实余额。
 *
 * @param {object} input
 * @param {string} input.kind 触发类型
 * @param {string} [input.prefix] 标题前缀
 * @param {string} [input.detail] 一句话说明（数据源、原因等）
 * @param {string[]} [input.extraLines] 额外明细行（原样追加，不截断）
 * @param {string} [input.oldText] 变化前的展示值（已格式化好）
 * @param {string} [input.newText] 变化后的展示值
 * @param {string} [input.deltaText] 差值展示
 * @param {string} [input.source] 数据来源（如「DeepSeek 官方余额接口」）
 * @param {string} [input.dataTime] 数据时间（快照数据必须给）
 * @param {boolean} [input.stale] 数据是否为陈旧快照（true 会在正文里显著标注）
 * @param {Date} [input.now] 当前时间
 * @returns {{ title: string, text: string }}
 */
export function composeChangeNotification(input) {
  const kind = String(input?.kind ?? '')
  const badge = badgeOf(kind)
  const prefix = String(input?.prefix ?? '').trim() || 'DSH 回合通知'
  const title = badge.icon + ' ' + prefix + '：' + badge.label

  const lines = []
  lines.push(badge.icon + ' ' + badge.label)

  const oldText = String(input?.oldText ?? '').trim()
  const newText = String(input?.newText ?? '').trim()
  if (oldText !== '' && newText !== '') lines.push('变化：' + oldText + ' → ' + newText)
  else if (newText !== '') lines.push('当前：' + newText)

  const deltaText = String(input?.deltaText ?? '').trim()
  if (deltaText !== '') lines.push('差值：' + deltaText)

  const source = String(input?.source ?? '').trim()
  if (source !== '') lines.push('数据来源：' + source)

  const dataTime = String(input?.dataTime ?? '').trim()
  if (dataTime !== '') lines.push('数据时间：' + dataTime)

  // 陈旧数据必须显眼：这是「不伪造实时值」这条纪律的落点。
  if (input?.stale === true) {
    lines.push('⚠️ 这份数据不是实时的（取自本机快照文件），仅作参考，请以控制台实际显示为准。')
  }

  const detail = String(input?.detail ?? '').trim()
  if (detail !== '') lines.push('说明：' + excerpt(detail, 200))

  const extra = Array.isArray(input?.extraLines) ? input.extraLines : []
  if (extra.length > 0) {
    lines.push('')
    for (const line of extra) lines.push(String(line ?? ''))
  }

  lines.push('')
  lines.push('时间：' + localTime(input?.now instanceof Date ? input.now : new Date()))

  return { title, text: lines.join('\n') }
}
