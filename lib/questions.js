/**
 * lib/questions.js —— 「Agent 正在问你问题」的通知文案（纯函数，可单测）。
 *
 * 为什么需要单独一个模块：
 *  `ask_user_question` **不落会话事件流**（已扫本机 1889 个会话日志核实：35 次调用全是普通
 *  tool/call，没有独立的提问事件），所以它拿不到 turn/* 那套事件。唯一入口是宿主 cordis 的
 *  waterfall 钩子 `user-questions/request`。这个钩子给的是「原始请求对象」，不是现成的通知文案，
 *  所以需要一层把 request → 人要读的一小段文字。
 *
 * 三条设计红线：
 *  1. **只提醒，不代答**。本模块产出的纯是文本，不返回、不修改、不注入任何答案。
 *     （用户 2026-11-21 明确取消「等多久自动选推荐项」，所以这里一行代选逻辑都不写。）
 *  2. **推荐项只有两种合法来源**：选项带 `recommended: true`，或 label 里写了「（推荐）」/
 *     「(Recommended)」。**绝不按「第一个就是推荐」臆造** —— 猜错了会误导用户点错。
 *  3. **脏数据一律兜底**：request 可能是 null、questions 可能不是数组、单个问题可能缺 options。
 *     钩子是 waterfall，抛出去会影响提问链路，所以这里每个字段都用可选链 + 类型判定。
 *
 * @module questions.js
 */

/** 每个问题最多列几个选项（超出就写「还有 N 个未列出」，避免通知被撑爆）。 */
const MAX_OPTIONS = 8

/** 每条选项描述压到多少字符（IM 正文里太长会被折行折得很难读）。 */
const MAX_OPTION_DESC = 60

/** 整套问题最多列几题（正常一次只问 1~3 题，防脏数据刷屏）。 */
const MAX_QUESTIONS = 5

/** 推荐项识别：宿主与 dsh-bridge 都按这个约定，跟它们保持一致。 */
const RECOMMENDED_RE = /（推荐）|\(recommended\)/i

/**
 * 某个选项是不是推荐项。
 *
 * @param {any} option 单个选项 { label, description?, recommended? }
 * @param {number} [index] 选项序号（保留参数：曾经想「第一个当推荐」，已明确禁止，见文件头）
 * @returns {boolean}
 */
export function isRecommended(option, index) {
  void index
  if (!option || typeof option !== 'object') return false
  if (option.recommended === true) return true
  return RECOMMENDED_RE.test(String(option.label ?? ''))
}

/** 把一段可能很长/多行的文字压成一行短描述。 */
function flatten(text, limit) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const max = Number(limit)
  if (!Number.isFinite(max) || max <= 0) return flat
  // 按码点切，避免把 emoji 切一半
  const chars = Array.from(flat)
  return chars.length <= max ? flat : chars.slice(0, max).join('') + '…'
}

/** 取所有问题里「推荐项」的 label，按题号顺序返回（给一行摘要用）。 */
export function recommendedLabels(questions) {
  const list = Array.isArray(questions) ? questions : []
  const out = []
  for (const question of list) {
    const options = Array.isArray(question?.options) ? question.options : []
    for (const option of options) {
      if (isRecommended(option)) {
        const label = flatten(option.product ?? option?.label, 40)
        if (label !== '') out.push(label)
        break
      }
    }
  }
  return out
}

/**
 * 把 `questions` 数组渲染成「逐题 + 逐选项」的多行文本。
 *
 * 输出形如：
 *   第 1 题：要现在重启 DSH 吗？
 *     ⭐ [1] 帮我重启（推荐） —— 会杀掉当前进程
 *        [2] 先不重启
 *   第 2 题：日志级别？
 *     （可多选）
 *     ⭐ [1] info（推荐）
 *        [2] debug
 *
 * @param {any} questions request.questions
 * @returns {string} 逐行文本；空数组返回空串（调用方据此不追加这一段）
 */
export function describeQuestions(questions) {
  const list = Array.isArray(questions) ? questions : []
  if (list.length === 0) return ''
  const lines = []
  const shown = list.slice(0, MAX_QUESTIONS)

  shown.forEach((question, qi) => {
    const title = flatten(question?.question ?? question?.header, 200) || '（未命名的提问）'
    if (qi > 0) lines.push('')
    lines.push('第 ' + String(qi + 1) + ' 题：' + title)

    const detail = flatten(question?.detail, 160)
    if (detail !== '') lines.push('  ' + detail)
    if (question?.multiSelect === true) lines.push('  （可多选）')

    const options = Array.isArray(question?.options) ? question.options : []
    if (options.length === 0) {
      lines.push('  · 没有预设选项，需要你直接输入')
      return
    }

    const shownOptions = options.slice(0, MAX_OPTIONS)
    shownOptions.forEach((option, oi) => {
      const star = isRecommended(option) ? '⭐ ' : '   '
      const label = flatten(option?.label, 80) || '（第 ' + String(oi + 1) + ' 项）'
      const desc = flatten(option?.description, MAX_OPTION_DESC)
      lines.push('  ' + star + '[' + String(oi + 1) + '] ' + label + (desc !== '' ? ' —— ' + desc : ''))
    })
    if (options.length > shownOptions.length) {
      lines.push('   … 还有 ' + String(options.length - shownOptions.length) + ' 个选项未列出')
    }
  })

  if (list.length > shown.length) {
    lines.push('')
    lines.push('… 还有 ' + String(list.length - shown.length) + ' 个问题未列出')
  }
  return lines.join('\n')
}

/**
 * 一行摘要：几题、有没有推荐项。用于通知正文的「说明：」行与历史记录。
 *
 * @param {any} questions
 * @returns {string}
 */
export function summarizeQuestions(questions) {
  const list = Array.isArray(questions) ? questions : []
  if (list.length === 0) return 'Agent 在等你回答'
  const optionCount = list.reduce((sum, question) => {
    const options = Array.isArray(question?.options) ? question.options : []
    return sum + options.length
  }, 0)

  let text = list.length === 1 ? 'Agent 在等你回答 1 个问题' : 'Agent 在等你回答 ' + String(list.length) + ' 个问题'
  if (optionCount > 0) text += '（共 ' + String(optionCount) + ' 个选项）'
  const recommended = recommendedLabels(list)
  if (recommended.length > 0) text += '，推荐：' + recommended.join(' / ')
  return text
}

/**
 * 从钩子给的 request 里取会话 id。
 *
 * 实测形状可能有多层（agent.session.id / session.id / sessionId），三处都试，
 * 取不到就返回空串 —— 调用方据此仍然发通知（宁可少一个字段，也不吞整条提醒）。
 *
 * @param {any} req
 * @returns {string}
 */
export function sessionIdOf(req) {
  const candidates = [
    req?.agent?.session?.id,
    req?.session?.id,
    req?.sessionId,
    req?.agent?.sessionId,
  ]
  for (const value of candidates) {
    const id = String(value ?? '').trim()
    if (id !== '') return id
  }
  return ''
}

/** 从 request 里取工作目录（有就用，没有就空串，由 watcher 回落到会话 header）。 */
export function cwdOf(req) {
  const candidates = [req?.agent?.session?.header?.cwd, req?.session?.header?.cwd, req?.cwd]
  for (const value of candidates) {
    const cwd = String(value ?? '').trim()
    if (cwd !== '') return cwd
  }
  return ''
}

/** 从 request 里取会话标题（一般没有，返回空串）。 */
export function titleOf(req) {
  const candidates = [req?.agent?.session?.title, req?.session?.title]
  for (const value of candidates) {
    const title = String(value ?? '').trim()
    if (title !== '') return title
  }
  return ''
}

/**
 * 把 request 变成 watcher 认得的「候选事件」。
 *
 * 这里是 request → candidate 的唯一转换点，纯函数，方便单测。
 *
 * @param {any} req user-questions/request 的请求对象
 * @returns {{ kind: string, sessionId: string, cwd: string, title: string, detail: string, extraLines: string[], questions: any[] } | null}
 *   request 里一个问题都没有时返回 null（不发空通知）。
 */
export function buildQuestionCandidate(req) {
  const questions = Array.isArray(req?.questions) ? req.questions : []
  if (questions.length === 0) return null

  const optionsText = describeQuestions(questions)
  return {
    kind: 'question',
    sessionId: sessionIdOf(req),
    cwd: cwdOf(req),
    title: titleOf(req),
    detail: summarizeQuestions(questions),
    // 逐题逐选项的多行文本：正文里原样换行，不压成一行（压了就没法看选项了）
    extraLines: optionsText === '' ? [] : optionsText.split('\n'),
    questions,
  }
}
