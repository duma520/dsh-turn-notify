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
