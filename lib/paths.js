/**
 * lib/paths.js —— 路径、配置与历史的读写（本插件唯一的落盘层）。
 *
 * 三条纪律（对应开发规则）：
 *  1. 所有设置**实时落盘**：任何一次改动都立刻写 config.json，不依赖「保存」按钮（规则 g3）。
 *  2. 原子写：先写 .tmp 再 rename，避免进程被杀时留下半个 JSON 把配置毁掉。
 *  3. 本文件只管「路径 + 读写 + 校验」，不掺业务判断（规则判断在 rules.js）。
 *
 * 配置目录固定在 <home>/.dsh/dsh-turn-notify/，与 dsh-notify-sender 同级，
 * 绝不写进插件代码目录（plugins/<名字>/），这样升级插件不会丢配置。
 *
 * @module paths.js
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（lib/ 的上一层）。 */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 用户数据目录：<home>/.dsh/dsh-turn-notify。
 *
 * 允许被环境变量 DSH_TURN_NOTIFY_DIR 覆盖：回归测试必须能在一个临时目录里跑，
 * 否则测试会把真实配置写坏（或者被真实配置干扰，断言莫名失败）。
 */
export const DATA_DIR = process.env.DSH_TURN_NOTIFY_DIR
  ? path.resolve(String(process.env.DSH_TURN_NOTIFY_DIR))
  : path.join(os.homedir(), '.dsh', 'dsh-turn-notify')

/** 主配置文件。 */
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json')

/** 通知历史（最近 N 条），用于界面「发送记录」与「今日已发 N 条」。 */
export const HISTORY_PATH = path.join(DATA_DIR, 'history.json')

/** 调试日志：只在出错时追加一行，正常不写，避免无谓写盘。 */
export const LOG_PATH = path.join(DATA_DIR, 'log.txt')

/**
 * 变化类触发的「上次已知值」缓存。
 *
 * 只存三个数字与时间戳（余额 / token 累计 / 积分），**绝不存任何凭据**。
 * 落盘的目的：DSH 重启后还能和「上次见到多少」对比，否则每次重启都会把
 * 第一次读到的值当成基准，重启一次就丢一次变化通知。
 */
export const SNAPSHOT_PATH = path.join(DATA_DIR, 'snapshot.json')

/** 通知发送器的数据目录（只读它的 config.json 取「上次选了哪些账号」）。 */
export const SENDER_DATA_DIR = path.join(os.homedir(), '.dsh', 'dsh-notify-sender')

/** 通知发送器数据目录下的配置文件。 */
export const SENDER_CONFIG_PATH = path.join(SENDER_DATA_DIR, 'config.json')

/** 通知发送器的 HTTP 接口前缀（首选直连模块，接口是兜底路径）。 */
export const SENDER_API = '/@duma520/dsh-notify-sender/api'

/**
 * dsh-bridge（IM 桥）的配置文件。
 *
 * 只读用途：它的每个 IM 账号都带一个 `activeSessionId`，那是「这个 IM 账号当前绑定的会话」。
 * 本插件据此判断「这轮是不是从 IM 发起的对话」——从 IM 来的对话本来就是在手机上等着看，
 * 再往同一个 IM 推一条「回合完成」属于自己通知自己，默认跳过。
 *
 * **只读，且只取 activeSessionId 这一个字段**，绝不读 token / appSecret 之类的凭据。
 */
export const BRIDGE_CONFIG_PATH = path.join(os.homedir(), '.dsh', 'dsh-bridge', 'config.json')

/** 历史最多留多少条：够界面翻，又不至于无限长大。 */
const HISTORY_LIMIT = 200

/**
 * 默认配置。
 *
 * 每一项都对应设置页上的一个控件；新增字段必须同时改这里、mergeConfig 的白名单
 * 与前端默认值，三处不一致会导致「界面改了但读不到」。
 */
export function defaultConfig() {
  return {
    /** 配置结构版本，将来迁移用。 */
    version: 1,
    /** 总开关：关掉等于本插件不存在（不订阅、不发送）。 */
    enabled: true,
    /**
     * 触发条件。键名固定，前端按同一份清单渲染，避免两边不一致。
     *  true = 命中就发；false = 不检查。
     */
    triggers: {
      completed: true,
      error: true,
      aborted: true,
      maxTokens: true,
      timeout: false,
      noProgress: false,
      toolFailure: false,
      keyword: false,
      // 「Agent 提问」默认开：用户 2026-11-21 明确要求「一问就推」。
      // 它跟冷却/静默同样受约束，不会比别的触发项更吵。
      question: true,
      // 变化类（v0.1.6 新增）：判的不是「回合结束」，而是「某个数值变了」。
      // 默认全关 —— 它们靠定时轮询外部数据，默认打开会平白多出网络请求与通知。
      balanceChange: false,
      tokenChange: false,
      creditsChange: false,
      /**
       * 「插件版多账号积分变化」（v0.1.9 新增）：一次拿回 dsh-connect-workbuddy
       * 里**全部账号**的积分，逐账号比对增减。
       *
       * 与上面 creditsChange 的差别：creditsChange 只看 /usage 那**一个**当前账号，
       * 这个看的是 /account-credits 的整张账号表（本机实测 13 个账号）。
       * 默认关 —— 它是本插件里最费外部请求的一个开关（见 changes.creditsPluginIntervalMinutes）。
       */
      creditsPluginChange: false,
      /**
       * 「每回合结算」（v0.1.7 新增）：每轮对话结束时，把这一轮里
       * 余额 / Token / 积分各动了多少汇总成一条通知。
       *
       * 主开关默认关 —— 余额与积分都要发外部请求，回合越多请求越多，
       * 等于替用户打开了一条持续性网络访问，必须他亲手开。
       */
      turnSettle: false,
      /** 结算里包含哪几项（各自独立，主开关打开后才生效）。Token 零 IO，默认开。 */
      settleBalance: false,
      settleToken: true,
      settleCredits: false,
    },
    /** 关键词触发（triggers.keyword 打开时生效），命中任一即发。 */
    keywords: ['失败', '报错', '无法完成', '对不起'],
    /** 发到哪些账号；空数组 = 沿用通知发送器里「上次选中」的那一组。 */
    targetAccountIds: [],
    /** 排除的会话 id（前缀或完整 id 均可，避免打扰后台自动会话）。 */
    excludeSessionIds: [],
    /** 排除的工作区路径前缀（例如不想收到某个项目的通知）。 */
    excludeCwdPrefixes: [],
    /** 期望排除「由 IM 发起的对话」——宿主侧读不到稳定的来源标记时按不跳过兜底。 */
    skipImOriginated: true,
    /** 静默时段：开启后该时段内命中规则也不发（只记历史，标记 skipped）。 */
    quietHours: { enabled: false, start: '23:00', end: '08:00' },
    /** 长任务超时告警阈值（分钟），triggers.timeout 打开时生效。 */
    timeoutMinutes: 30,
    /** 无进展告警阈值（分钟），triggers.noProgress 打开时生效。 */
    noProgressMinutes: 10,
    /** 冷却秒数：同一会话两次通知的最小间隔，防刷屏。 */
    cooldownSeconds: 90,
    /** 文案标题模板里的固定前缀。 */
    titlePrefix: 'DSH 回合通知',
    /** 正文里附带助手最后一条消息的字符上限；0 = 不附带正文。 */
    excerptChars: 300,
    /** 试运行：只走规则与文案，不真发（界面上能看「本该发什么」）。 */
    dryRun: false,
    /**
     * 变化类触发的阈值与轮询参数（triggers.balanceChange / tokenChange / creditsChange
     * 打开时才生效）。四项各管一个数据源，互不影响。
     */
    changes: {
      /** DeepSeek 余额变化超过多少「元」才通知。 */
      balanceMinDelta: 1,
      /** Token 消耗累计增加多少「个」才通知。 */
      tokenMinDelta: 100000,
      /** WorkBuddy 积分变化超过多少「分」才通知。 */
      creditsMinDelta: 10,
      /** WorkBuddy 查哪个区：cn / global。 */
      region: 'cn',
      /** 轮询最小间隔（分钟）：额度类接口都有限流，太密会被拒。 */
      probeIntervalMinutes: 5,
      /**
       * 多账号积分「单个账号变化超过多少分」才写进通知（triggers.creditsPluginChange）。
       *
       * 为什么默认 0.01 而不是像 creditsMinDelta 那样 10：
       * 多账号是**逐账号**判断的，一个账号动 10 分以上才会被看到的话，
       * 13 个账号每天那点零头就永远不会出现在通知里。改成「只要动了就说」，
       * 再由下面的条数上限（最多列 8 个）控制噪音。
       */
      creditsPluginMinDelta: 0.01,
      /**
       * 多账号积分的轮询间隔（分钟），**与 probeIntervalMinutes 分开**。
       *
       * 为什么不共用：probeIntervalMinutes 还要管 DeepSeek 余额，而余额接口是
       * 真正的对外 API。把共用的那个调到 1 分钟，会让余额接口跟着被打。
       *
       * 默认 2 分钟是折中：account-credits 内部是「每账号一次真实上游调用」，
       * 本机 13 个账号 → 1 分钟一查是 18,720 次/天，2 分钟是 9,360 次/天。
       * 参照物：dsh-connect-workbuddy 自己的 pollIntervalMs 是 5 分钟。
       */
      creditsPluginIntervalMinutes: 2,
      /**
       * 多个 DeepSeek 账号的余额 Key 清单（v0.1.10 新增）。
       *
       * 每项 `{ name, label }`：name 是 DSH 凭据库里的名字（也是环境变量名），
       * label 是通知里显示的名字（默认等于 name）。
       *
       * **空数组 = 老行为**：按 BALANCE_KEY_NAMES 的默认顺序找一把 Key，
       * 所以升级上来不改配置也能继续工作。
       */
      balanceKeys: [],
    },
    /**
     * 「每回合结算」的三个入账阈值（triggers.turnSettle 打开时才生效）。
     *
     * 与上面的 changes.* 不同：那三项管「账户级、跟回合无关」的累计变化，
     * 这三项管「这一轮里到底动了多少」。所以默认值故意调小 ——
     * 一轮的 Token 增量通常只有几千几万，拿 10 万去卡就永远不达标。
     */
    settle: {
      /** 本回合 Token 增量达到多少才写进结算。0 = 有任何消耗就写。 */
      tokenMinDelta: 0,
      /** 本回合余额变化达到多少「元」才写进结算。 */
      balanceMinDelta: 0.01,
      /** 本回合积分变化达到多少「分」才写进结算。 */
      creditsMinDelta: 0.01,
    },
  }
}

/**
 * 读出「IM 账号当前绑定的会话 id」清单。
 *
 * 返回的是会话 id 数组（形如 session-xxxxxxxx-…）；读不到就返回空数组——
 * **读不到时按「不跳过」兜底**（宁可多发一条，也不要因为读配置失败把该发的通知吞掉）。
 * 只取 activeSessionId，其余字段（含各类凭据）一律不碰、不外传。
 */
export function readImActiveSessionIds() {
  try {
    if (!existsSync(BRIDGE_CONFIG_PATH)) return []
    const raw = readFileSync(BRIDGE_CONFIG_PATH, 'utf8')
    const cfg = JSON.parse(raw)
    const ids = new Set()
    for (const value of Object.values(cfg ?? {})) {
      if (!value || typeof value !== 'object') continue
      const accounts = Array.isArray(value.accounts) ? value.accounts : []
      for (const account of accounts) {
        const id = String(account?.activeSessionId ?? '').trim()
        if (id !== '') ids.add(id)
      }
    }
    return [...ids]
  } catch {
    return []
  }
}

/** 把任意输入统一成字符串数组（去空、去重、保序）。 */
export function toStringArray(value) {
  const out = []
  const push = (v) => {
    const s = String(v ?? '').trim()
    if (s !== '' && !out.includes(s)) out.push(s)
  }
  if (Array.isArray(value)) for (const v of value) push(v)
  else if (typeof value === 'string') for (const v of value.split(/[,\n]/)) push(v)
  return out
}

/** 把 'HH:MM' 规整；非法值返回 fallback，绝不抛错。 */
export function normalizeClock(value, fallback) {
  const s = String(value ?? '').trim()
  // 放宽到 1~2 位小时、1~2 位分钟：手改配置写 '7:5' 很自然，替用户补齐成 '07:05'，
  // 而不是直接判非法丢掉（丢掉会静默回落默认值，用户会以为设置没生效）。
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s)
  if (!m) return fallback
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return fallback
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
}

/** 把数字限制在闭区间内，非数字回落到 fallback。 */
export function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 同 clampInt，但保留小数（金额、积分这类阈值不能取整）。
 *
 * 为什么金额/积分不能用 clampInt：余额变化 0.35 元、积分变化 3.2 分都是正常量级，
 * 取整会全变成 0，等于「任何变化都通知」，阈值就白设了。
 */
export function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(max, Math.max(min, n))
  return Math.round(clamped * 100) / 100
}

/**
 * 归一路余额 Key 清单（v0.1.10 新增）。
 *
 * 两种写法人人都可能手写，必须都认：
 *   1. 字符串数组：`["DEEPSEEK_BALANCE_API_KEY"]`
 *   2. 对象数组：`[{ "name": "DEEPSEEK_BALANCE_API_KEY", "label": "账号 1" }]`
 *
 * name 必须是合法标识符（它同时是 DSH 凭据库的键名与环境变量名），
 * 不合法的直接丢掉而不是抛错 —— 配置坏一条不能把整个插件带崩。
 * 按 name 去重（保留第一次出现的 label），最多保留 MAX_BALANCE_KEYS 条。
 */
export function normalizeKeys(value) {
  const MAX_KEYS = 10
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
  const out = []
  const seen = new Set()
  const push = (item) => {
    if (item === null || item === undefined) return
    let name = ''
    let label = ''
    if (typeof item === 'string') {
      name = item.trim()
      label = name
    } else if (typeof item === 'object') {
      name = String(item.name ?? '').trim()
      label = String(item.label ?? '').trim()
    }
    if (!NAME_RE.test(name)) return
    if (seen.has(name)) return
    seen.add(name)
    out.push({ name, label: label === '' ? name : label.slice(0, 40) })
  }
  if (Array.isArray(value)) for (const item of value) push(item)
  return out.slice(0, MAX_KEYS)
}

/**
 * 归一一组触发开关。
 *
 * **必须支持「只改一个」**：界面点某一个开关时只传 { toolFailure: true }，
 * 如果这里把没传的键一律写成 false，用户一点「工具失败」，其余七项就全被关掉，
 * 这是最容易被忽略、后果又最严重的一类 bug（回归里专门有一条断言盯着它）。
 *
 * @param {any} input    本次提交的 triggers（可能只有一两个键）
 * @param {any} baseline 现有 triggers（未提交的键从这里继承）
 */
function normalizeTriggers(input, baseline) {
  const d = defaultConfig().triggers
  const base = baseline && typeof baseline === 'object' ? baseline : d
  const src = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of Object.keys(d)) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key] === true
    else out[key] = base[key] === true
  }
  return out
}

/**
 * 合并配置：**只接受白名单键**，未知键一律丢弃。
 *
 * 为什么严格白名单：配置是用户手改得动的 JSON，一旦把任意键透传进去，
 * 前端或规则引擎读到意外结构就会崩。宁可丢掉未知键，也不能让坏数据进内存。
 */
export function mergeConfig(current, patch) {
  const base = current && typeof current === 'object' ? current : defaultConfig()
  const d = defaultConfig()
  const src = patch && typeof patch === 'object' ? patch : {}
  const has = (key) => Object.prototype.hasOwnProperty.call(src, key)
  const out = { ...d, ...base }

  if (has('enabled')) out.enabled = src.enabled === true
  if (has('triggers')) out.triggers = normalizeTriggers(src.triggers, base.triggers)
  if (has('keywords')) out.keywords = toStringArray(src.keywords)
  if (has('targetAccountIds')) out.targetAccountIds = toStringArray(src.targetAccountIds)
  if (has('excludeSessionIds')) out.excludeSessionIds = toStringArray(src.excludeSessionIds)
  if (has('excludeCwdPrefixes')) out.excludeCwdPrefixes = toStringArray(src.excludeCwdPrefixes)
  if (has('skipImOriginated')) out.skipImOriginated = src.skipImOriginated === true
  if (has('dryRun')) out.dryRun = src.dryRun === true
  if (has('quietHours')) {
    // 与 triggers 同理：界面只切开关时只会传 { enabled }，
    // 这时必须继承已有的起止时间，否则用户设好的 22:00–07:00 会被悄悄重置成默认 23:00–08:00。
    const q = src.quietHours && typeof src.quietHours === 'object' ? src.quietHours : {}
    const prev = base.quietHours && typeof base.quietHours === 'object' ? base.quietHours : d.quietHours
    out.quietHours = {
      enabled: Object.prototype.hasOwnProperty.call(q, 'enabled') ? q.enabled === true : prev.enabled === true,
      start: normalizeClock(q.start, normalizeClock(prev.start, d.quietHours.start)),
      end: normalizeClock(q.end, normalizeClock(prev.end, d.quietHours.end)),
    }
  }
  if (has('timeoutMinutes')) out.timeoutMinutes = clampInt(src.timeoutMinutes, 1, 24 * 60, d.timeoutMinutes)
  if (has('noProgressMinutes')) out.noProgressMinutes = clampInt(src.noProgressMinutes, 1, 24 * 60, d.noProgressMinutes)
  if (has('cooldownSeconds')) out.cooldownSeconds = clampInt(src.cooldownSeconds, 0, 3600, d.cooldownSeconds)
  if (has('excerptChars')) out.excerptChars = clampInt(src.excerptChars, 0, 4000, d.excerptChars)
  if (has('titlePrefix')) out.titlePrefix = String(src.titlePrefix ?? d.titlePrefix).slice(0, 60) || d.titlePrefix

  if (has('changes')) {
    // 与 quietHours 同理：界面只改一个阈值时只传那一个键，其余必须继承，
    // 否则用户调了「余额阈值」，Token 阈值会被悄悄重置成默认。
    const c = src.changes && typeof src.changes === 'object' ? src.changes : {}
    const prev = base.changes && typeof base.changes === 'object' ? base.changes : d.changes
    const pick = (key) => (Object.prototype.hasOwnProperty.call(c, key) ? c[key] : prev[key])
    out.changes = {
      balanceMinDelta: clampNumber(pick('balanceMinDelta'), 0, 100000, d.changes.balanceMinDelta),
      tokenMinDelta: clampInt(pick('tokenMinDelta'), 0, 1e12, d.changes.tokenMinDelta),
      creditsMinDelta: clampNumber(pick('creditsMinDelta'), 0, 100000, d.changes.creditsMinDelta),
      region: pick('region') === 'global' ? 'global' : 'cn',
      probeIntervalMinutes: clampInt(pick('probeIntervalMinutes'), 1, 240, d.changes.probeIntervalMinutes),
      creditsPluginMinDelta: clampNumber(pick('creditsPluginMinDelta'), 0, 100000, d.changes.creditsPluginMinDelta),
      creditsPluginIntervalMinutes: clampInt(pick('creditsPluginIntervalMinutes'), 1, 240, d.changes.creditsPluginIntervalMinutes),
      balanceKeys: normalizeKeys(pick('balanceKeys')),
    }
  }

  if (has('settle')) {
    // 同 changes：界面只改一个阈值时只传那一个键，其余继承，不能被悄悄重置。
    const s = src.settle && typeof src.settle === 'object' ? src.settle : {}
    const prevSettle = base.settle && typeof base.settle === 'object' ? base.settle : d.settle
    const pickSettle = (key) => (Object.prototype.hasOwnProperty.call(s, key) ? s[key] : prevSettle[key])
    out.settle = {
      tokenMinDelta: clampInt(pickSettle('tokenMinDelta'), 0, 1e12, d.settle.tokenMinDelta),
      balanceMinDelta: clampNumber(pickSettle('balanceMinDelta'), 0, 100000, d.settle.balanceMinDelta),
      creditsMinDelta: clampNumber(pickSettle('creditsMinDelta'), 0, 100000, d.settle.creditsMinDelta),
    }
  }

  // 关键约束：老配置里缺失的字段一律补默认值，保证「旧 config.json + 新版本代码」也能跑。
  out.version = d.version
  return out
}

/** 确保数据目录存在（幂等）。 */
export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

/** 读配置；文件不存在 / 坏了都回落到默认值，绝不让插件起不来。 */
export function readConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return mergeConfig(defaultConfig(), parsed)
  } catch {
    return defaultConfig()
  }
}

/**
 * 写配置（原子写）。
 *
 * 返回值语义：true = 已落盘；false = 落盘失败（调用方要把这句告诉界面，
 * 而不是假装成功——「看着存了、重启丢了」是最难查的一类故障）。
 */
export function writeConfig(config) {
  try {
    ensureDataDir()
    const next = mergeConfig(defaultConfig(), config)
    const tmp = CONFIG_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    renameSync(tmp, CONFIG_PATH)
    return true
  } catch {
    return false
  }
}

/**
 * 诊断用：这次提交里有没有「本模块不认识的触发键」。
 *
 * 为什么需要它：界面（前端）和后端是**分开加载**的两份代码。当前端已经更新、
 * 后端还跑着旧模块时，用户点的新触发项会被 mergeSettings 静默丢弃，接口却返回
 * ok:true —— 用户看到「勾上了」，一刷新又没了，且全程没有任何报错。
 * 2026-11-21 就踩过这个坑（新增 question 触发项，后端仍是 8 键版本）。
 *
 * @param {any} patch 前端提交的 patch
 * @returns {string[]} 本模块不认识、会被丢弃的触发键
 */
export function unknownTriggerKeysInPatch(patch) {
  const src = patch && typeof patch === 'object' && patch.triggers && typeof patch.triggers === 'object'
    ? patch.triggers
    : null
  if (src === null) return []
  const known = Object.keys(defaultConfig().triggers)
  return Object.keys(src).filter((key) => !known.includes(key))
}

/**
 * 诊断用：config.json 里存在、但**本模块不认识**的触发键。
 *
 * 读的是磁盘原文（不走 mergeConfig），所以不会像 readConfig 那样把未知键悄悄吃掉。
 * 非空 = 插件后端是旧代码（配置比代码新），重启 DSH 才会加载新模块。
 *
 * @returns {string[]} 磁盘上多出来、代码里没有的触发键
 */
export function unknownTriggerKeysOnDisk() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const disk = parsed && parsed.triggers && typeof parsed.triggers === 'object'
      ? Object.keys(parsed.triggers)
      : []
    const known = Object.keys(defaultConfig().triggers)
    return disk.filter((key) => !known.includes(key))
  } catch {
    return []
  }
}

/** 读通知发送器的配置（只取按键名，不碰任何凭据字段）。 */
export function readSenderConfig() {
  try {
    return JSON.parse(readFileSync(SENDER_CONFIG_PATH, 'utf8'))
  } catch {
    return null
  }
}

/** 读历史（最近 N 条，最新的在前）。 */
export function readHistory() {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : []
  } catch {
    return []
  }
}

/** 追加一条历史并立刻落盘（裁剪到 HISTORY_LIMIT）。 */
export function appendHistory(record) {
  try {
    ensureDataDir()
    const list = readHistory()
    list.unshift(record)
    const trimmed = list.slice(0, HISTORY_LIMIT)
    const tmp = HISTORY_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(trimmed, null, 2) + '\n', 'utf8')
    renameSync(tmp, HISTORY_PATH)
    return trimmed
  } catch {
    return readHistory()
  }
}

/** 追加一行日志；失败就算了，日志绝不影响主流程。 */
export function logLine(text) {
  try {
    ensureDataDir()
    appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + String(text) + '\n', 'utf8')
  } catch {
    /* 忽略 */
  }
}
