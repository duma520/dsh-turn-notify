/**
 * lib/rules.js —— 规则引擎（纯函数，不碰网络、不碰文件、可单测）。
 *
 * 输入：配置 + 一个「候选事件」（可能是回合结束、超时、无进展、工具失败……）
 * 输出：{ send, reason }，reason 是给界面看的**人话原因**，不是错误码。
 *
 * 为什么单独拆成纯函数：
 *  1. 规则最容易写错（漏判、误判），必须能回归测试；
 *  2. 纯函数没有副作用，测试里直接构造对象即可，不需要起宿主、不需要真发通知。
 *
 * 判定顺序（**严格按此顺序**，任何一步拦下就返回，不再往下走）：
 *  总开关 → 该类型开关 → 排除会话 → 排除工作区 → 静默时段 → 冷却
 *
 * @module rules.js
 */

/** 触发类型 → 配置里 triggers 的键名。未知类型一律不命中（安全兜底）。 */
export const TRIGGER_KEYS = {
  completed: 'completed',
  error: 'error',
  aborted: 'aborted',
  maxTokens: 'maxTokens',
  timeout: 'timeout',
  noProgress: 'noProgress',
  toolFailure: 'toolFailure',
  keyword: 'keyword',
  question: 'question',
  balanceChange: 'balanceChange',
  tokenChange: 'tokenChange',
  creditsChange: 'creditsChange',
  creditsPluginChange: 'creditsPluginChange',
  // 「每回合结算」：一条通知同时汇总本轮余额 / Token / 积分三项。
  // turnSettle 是这条通知的总闸门；下面三个 settleXxx 决定正文里包含哪几项
  // （也是「要不要为这一项去查接口」的开关 —— 余额和积分都要发请求）。
  turnSettle: 'turnSettle',
  settleBalance: 'settleBalance',
  settleToken: 'settleToken',
  settleCredits: 'settleCredits',
}

/**
 * 「变化类」触发：判的不是一轮对话的结局，而是某个数值变了。
 *
 * 它们与回合类触发的关键差别：**没有会话**（sessionId / cwd 都是空）。
 * 所以 decide() 里必须跳过「排除会话 / 排除工作区 / IM 同源」这三道闸，
 * 否则这些检查会拿空字符串去比，虽然多半不会误判，但语义上完全说不通。
 */
export const CHANGE_KINDS = ['balanceChange', 'tokenChange', 'creditsChange', 'creditsPluginChange']

/** 是否属于「变化类」触发。 */
export function isChangeKind(kind) {
  return CHANGE_KINDS.includes(String(kind ?? ''))
}

/** 触发类型的界面文案（前端也用它渲染，避免两处不一致）。 */
export const TRIGGER_LABELS = {
  completed: '回合正常完成',
  error: '回合出错',
  aborted: '回合被中断 / 停止',
  maxTokens: '输出达到上限被截断',
  timeout: '长任务超时告警（跑太久还没结束）',
  noProgress: '长时间无进展告警（N 分钟没有新事件）',
  toolFailure: '工具调用失败',
  keyword: '回复里命中关键词',
  question: 'Agent 在等你回答问题',
  balanceChange: 'DeepSeek 余额变化（降了或充了）',
  tokenChange: 'Token 消耗累计到阈值',
  creditsChange: 'WorkBuddy 积分变化',
  creditsPluginChange: 'WorkBuddy 积分变化（插件版 · 全部账号）',
  turnSettle: '本回合结算（余额 / Token / 积分）',
  settleBalance: '结算含余额变化',
  settleToken: '结算含 Token 用量',
  settleCredits: '结算含积分变化',
}

/**
 * 把宿主 turn/end 的 reason.kind 映射成本插件的触发类型。
 *
 * 真实取值范围（已从本机 60 个会话日志统计验证）：
 *   completed / aborted / error / interrupted，以及理论上存在的 max-tokens。
 * **未知 kind 一律返回 null**（不通知），而不是猜一个——宁可漏一条，
 * 也不能把「未知情况」当成「正常完成」发出去误导人。
 */
export function mapTurnEndKind(reasonKind) {
  const kind = String(reasonKind ?? '')
  if (kind === 'completed') return 'completed'
  if (kind === 'error') return 'error'
  if (kind === 'aborted') return 'aborted'
  if (kind === 'interrupted') return 'aborted'
  if (kind === 'max-tokens' || kind === 'maxTokens' || kind === 'max_tokens') return 'maxTokens'
  return null
}

/** 判定某个时刻是否落在静默时段内（支持跨零点，如 23:00–08:00）。 */
export function inQuietHours(quietHours, date = new Date()) {
  if (!quietHours || quietHours.enabled !== true) return false
  const toMinutes = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ''))
    if (!m) return null
    return Number(m[1]) * 60 + Number(m[2])
  }
  const start = toMinutes(quietHours.start)
  const end = toMinutes(quietHours.end)
  if (start === null || end === null) return false
  const now = date.getHours() * 60 + date.getMinutes()
  if (start === end) return false
  // 跨零点：start > end 时，区间是 [start, 24:00) ∪ [00:00, end)
  if (start > end) return now >= start || now < end
  return now >= start && now < end
}

/** 会话是否被排除（id 精确或前缀命中都算）。 */
export function isSessionExcluded(config, sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return false
  const list = Array.isArray(config?.excludeSessionIds) ? config.excludeSessionIds : []
  return list.some((item) => {
    const rule = String(item ?? '').trim()
    return rule !== '' && (id === rule || id.startsWith(rule))
  })
}

/** 工作区是否被排除（路径前缀匹配，大小写不敏感以适配 Windows）。 */
export function isCwdExcluded(config, cwd) {
  const dir = String(cwd ?? '').toLowerCase()
  if (dir === '') return false
  const list = Array.isArray(config?.excludeCwdPrefixes) ? config.excludeCwdPrefixes : []
  return list.some((item) => {
    const rule = String(item ?? '').trim().toLowerCase()
    return rule !== '' && dir.startsWith(rule)
  })
}

/**
 * 判断某个会话是不是「IM 账号当前绑定的那个会话」。
 *
 * 两边格式不完全一致（宿主内部 id 可能带 `session-` 前缀，也可能不带），
 * 所以剥掉前缀后比对，避免因为差一个前缀就漏判。
 *
 * @param {string[]} imSessionIds 各 IM 账号的 activeSessionId
 * @param {string} sessionId 本次事件所属会话
 */
export function isImOriginated(imSessionIds, sessionId) {
  const normalize = (v) => String(v ?? '').trim().replace(/^session-/, '')
  const target = normalize(sessionId)
  if (target === '') return false
  const list = Array.isArray(imSessionIds) ? imSessionIds : []
  return list.some((id) => normalize(id) === target)
}

/** 关键词命中判定：返回命中的那个词，没命中返回 ''。 */
export function matchKeyword(keywords, text) {
  const body = String(text ?? '')
  if (body === '') return ''
  const list = Array.isArray(keywords) ? keywords : []
  for (const item of list) {
    const word = String(item ?? '').trim()
    if (word !== '' && body.includes(word)) return word
  }
  return ''
}

/**
 * 主判定。
 *
 * @param {object} config 已合并过的完整配置
 * @param {{ kind: string, sessionId?: string, cwd?: string, detail?: object }} candidate 候选事件
 * @param {{ now?: Date, lastSentAt?: number, imSessionIds?: string[] }} [context] 运行时上下文
 * @returns {{ send: boolean, reason: string }}
 */
export function decide(config, candidate, context = {}) {
  const now = context.now instanceof Date ? context.now : new Date()
  const kind = String(candidate?.kind ?? '')

  if (!config || config.enabled !== true) return { send: false, reason: '总开关已关闭' }

  const triggerKey = TRIGGER_KEYS[kind]
  if (!triggerKey) return { send: false, reason: '未知的触发类型，已忽略：' + (kind || '(空)') }
  if (config.triggers?.[triggerKey] !== true) return { send: false, reason: '该触发条件未开启：' + (TRIGGER_LABELS[kind] ?? kind) }

  // 变化类触发没有「会话 / 工作区」这个概念，下面三道闸对它一律跳过 ——
  // 拿空 sessionId 去比排除清单虽然不会误命中，但语义上是错的，也不该被
  // 「排除某个工作区」这种设置连带静默掉。
  if (!isChangeKind(kind)) {
    if (isSessionExcluded(config, candidate?.sessionId)) return { send: false, reason: '该会话在排除清单里' }
    if (isCwdExcluded(config, candidate?.cwd)) return { send: false, reason: '该工作区在排除清单里' }
    // 从 IM 发起的对话：你本来就在那个 IM 里等着，再推一条等于自己通知自己。
    // 读不到 IM 绑定的会话时 imSessionIds 是空数组，这里自然不跳过（宁可多发，不吞通知）。
    if (config.skipImOriginated === true && isImOriginated(context.imSessionIds, candidate?.sessionId)) {
      return { send: false, reason: '这轮对话是从 IM 发起的，不重复通知' }
    }
  }
  if (inQuietHours(config.quietHours, now)) return { send: false, reason: '当前处于静默时段（' + config.quietHours.start + '–' + config.quietHours.end + '）' }

  const cooldown = Number(config.cooldownSeconds ?? 0) * 1000
  const lastSentAt = Number(context.lastSentAt ?? 0)
  if (cooldown > 0 && lastSentAt > 0 && now.getTime() - lastSentAt < cooldown) {
    const left = Math.ceil((cooldown - (now.getTime() - lastSentAt)) / 1000)
    return { send: false, reason: '冷却中（还需等 ' + left + ' 秒）' }
  }

  return { send: true, reason: '命中：' + (TRIGGER_LABELS[kind] ?? kind) }
}
