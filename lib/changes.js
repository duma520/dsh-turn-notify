/**
 * lib/changes.js —— 「变化类」通知的数据源与判定。
 *
 * 三类变化（各自独立，互不影响）：
 *  1. balanceChange —— DeepSeek 账户余额变了（充值或扣费）；
 *  2. tokenChange   —— Token 累计消耗走到阈值（事件驱动，不轮询）；
 *  3. creditsChange —— WorkBuddy 账号积分变了（签到、消耗、月度刷新）。
 *
 * 四条纪律（都是踩过的坑）：
 *  1. **不伪造实时值**：余额取不到官方接口时降级读本机快照，并在通知里显著标注
 *     「非实时」。宁可承认数据旧，也不能让用户以为那是刚查到的余额。
 *  2. **不硬编码端口**：WorkBuddy 积分走同进程的宿主 HTTP 路由，origin 从
 *     ctx.webServer.getOrigin() 现取（用户改端口就跟着改）。
 *  3. **不泄露凭据**：API Key 只用于发请求，绝不进日志、通知、快照文件。
 *  4. **首次只记基准**：没有「上次值」时不发通知，否则装上插件的第一秒就会
 *     推一条「余额从无到 307.84」，那是噪音。
 *
 * @module changes.js
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ensureDataDir, SNAPSHOT_PATH, logLine } from './paths.js'
import { humanNumber, humanDelta, localTime, trendEmoji } from './format.js'

/** DeepSeek 余额接口：**只允许这一个域名**（防止被配置或错误数据带去别的站）。 */
export const BALANCE_URL = 'https://api.deepseek.com/user/balance'
export const BALANCE_HOST = 'api.deepseek.com'

/** 余额 Key 的候选凭据名：先专用，再落到渠道通用名。 */
export const BALANCE_KEY_NAMES = ['DEEPSEEK_BALANCE_API_KEY', 'DEEPSEEK_API_KEY']

/**
 * 多 Key 的默认清单（v0.1.10 起）。
 *
 * 为什么要多 Key：一个人可能有好几个 DeepSeek 账号（公司 / 个人 / 小号），
 * 每个账号一把 Key、各自一份余额。只查一把 Key 就只能看到一个账号的钱。
 *
 * 配置里 `changes.balanceKeys` 为空时回落到 BALANCE_KEY_NAMES 的老行为，
 * 老配置文件不需要迁移也能正常跑。
 */
export const DEFAULT_BALANCE_KEYS = [{ name: 'DEEPSEEK_BALANCE_API_KEY', label: '账号 1' }]

/** 最多允许配几个 Key：再多就是「逐账号串行请求」，会拖慢每一轮结算。 */
export const MAX_BALANCE_KEYS = 10

/**
 * 把配置里的 balanceKeys 归一成 `[{ name, label }]`。
 *
 * 三条纪律：
 *  1. name 必须是能当凭据名 / 环境变量名的标识符（字母数字下划线），否则丢弃；
 *  2. 同一个 name 只留第一次出现（避免重复请求同一把 Key）；
 *  3. 超过 MAX_BALANCE_KEYS 的部分丢弃（保护上游限流与本回合耗时）。
 */
export function normalizeBalanceKeys(list) {
  const source = Array.isArray(list) ? list : []
  const out = []
  const seen = new Set()
  for (const item of source) {
    const raw = item && typeof item === 'object' ? item : { name: item }
    const name = String(raw.name ?? raw.ref ?? '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) continue
    if (seen.has(name)) continue
    seen.add(name)
    const label = String(raw.label ?? '').trim()
    out.push({ name, label: label !== '' ? label : name })
    if (out.length >= MAX_BALANCE_KEYS) break
  }
  return out
}

/** WorkBuddy 积分路由（同进程插件，必须带 region 参数，否则 400）。 */
export const WORKBUDDY_USAGE_PATH = '/plugins/dsh-connect-workbuddy/usage'
/**
 * WorkBuddy **全部账号**的积分路由（v0.1.9 新增，同样必须带 region）。
 *
 * 与上面的 /usage 差别：/usage 只回答「当前选中的那个账号」有多少分；
 * 这个一次返回整张账号表：[{ id, accountName, selected, credits, expiringSoon }]。
 * 本机实测 cn 区 13 个账号、global 区 1 个。
 *
 * 代价：宿主侧实现是 Promise.all(accounts.map(fetchCredits))，
 * **每个账号一次真实上游调用、没有任何缓存** —— 所以调用方必须自己限流。
 */
export const WORKBUDDY_ACCOUNT_CREDITS_PATH = '/plugins/dsh-connect-workbuddy/account-credits'

/** 本机 dsh-usage 的 provider 快照（**只读兜底**，实测已停更）。 */
export const PROVIDER_SNAPSHOTS_PATH = path.join(os.homedir(), '.dsh', 'dsh-usage', 'provider-snapshots.json')

/** 一次探测的超时（毫秒）：外部接口卡住不能把插件拖死。 */
const PROBE_TIMEOUT_MS = 8000

/** 读缓存快照；坏了就当空对象（绝不让插件起不来）。 */
export function readSnapshot() {
  try {
    const parsed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 原子写缓存快照（先 .tmp 再 rename）。失败返回 false，由调用方决定要不要说。 */
export function writeSnapshot(snapshot) {
  try {
    ensureDataDir()
    const tmp = SNAPSHOT_PATH + '.tmp'
    writeFileSync(tmp, JSON.stringify(snapshot ?? {}, null, 2) + '\n', 'utf8')
    renameSync(tmp, SNAPSHOT_PATH)
    return true
  } catch {
    return false
  }
}

/** 合并写：只覆盖传入的键，其余保留。 */
export function patchSnapshot(patch) {
  const next = { ...readSnapshot(), ...(patch && typeof patch === 'object' ? patch : {}) }
  writeSnapshot(next)
  return next
}

/**
 * 判定「这个值算不算真的变了」。
 *
 * 返回 changed 为 true 时，调用方负责更新基准并发通知；首次（old 无值）返回
 * changed=false 且 seeded=true，表示「已记下基准，但这次不通知」。
 *
 * @param {any} oldValue 上次已知值（undefined / null / '' 视为无基准）
 * @param {any} newValue 本次读到的值
 * @param {number} minDelta 触发阈值（绝对值，大于等于即算变化）
 */
export function judgeChange(oldValue, newValue, minDelta) {
  const next = Number(newValue)
  if (!Number.isFinite(next)) return { changed: false, seeded: false, delta: 0, reason: '本次读到的值不是数字' }
  const hasOld = oldValue !== undefined && oldValue !== null && oldValue !== ''
  const prev = Number(oldValue)
  if (!hasOld || !Number.isFinite(prev)) {
    return { changed: false, seeded: true, delta: 0, reason: '首次读取，已记下基准值（不通知）' }
  }
  const delta = next - prev
  const threshold = Math.max(0, Number(minDelta) || 0)
  if (Math.abs(delta) < threshold) {
    return { changed: false, seeded: false, delta, reason: '变化 ' + humanDelta(delta) + ' 未达到阈值 ' + humanNumber(threshold) }
  }
  return { changed: true, seeded: false, delta, reason: '变化 ' + humanDelta(delta) + ' 达到阈值 ' + humanNumber(threshold) }
}

/** 带超时的 fetch（AbortController）。外部接口卡住时按时放弃，不拖死插件。 */
async function fetchWithTimeout(url, options = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从宿主凭据服务取余额用的 API Key。
 *
 * 语义（宿主 CredentialProvider.resolve 的注释原文）：每次操作都要重新解析，
 * 不许跨操作缓存 —— 用户换了 Key 要立刻生效。
 *
 * @returns {Promise<{ value: string, source: string }>} 取不到时 value 为空串
 */
export async function resolveBalanceKey(ctx) {
  const all = await resolveBalanceKeys(ctx, null)
  const first = all.find((item) => item.value !== '')
  return first ? { value: first.value, source: first.source } : { value: '', source: '' }
}

/**
 * 取**多把**余额 Key（v0.1.10 起）。
 *
 * list 为空 / 不是数组时回落到 BALANCE_KEY_NAMES 的老行为，老配置无需迁移；
 * list 非空则只认 list 里的名字（用户在界面上填了几把就查几把）。
 *
 * 每把 Key 都单独返回一条记录，取不到的那些 value 为空串、error 写原因 ——
 * 由调用方决定「是整条报错，还是只把这一个账号标成取不到」。
 *
 * @param {any} ctx 插件上下文（取 credentials 服务）
 * @param {Array<{name:string,label?:string}>|null} list 配置里的 Key 清单
 * @returns {Promise<Array<{name:string,label:string,value:string,source:string,error:string}>>}
 */
export async function resolveBalanceKeys(ctx, list) {
  const wanted = normalizeBalanceKeys(list)
  const targets = wanted.length > 0
    ? wanted
    : BALANCE_KEY_NAMES.map((name) => ({ name, label: name }))
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : null
  const out = []
  // 同一个 Key 值被多个名字解析出来时只留第一条（v0.1.13）。
  //
  // 实测事故：凭据库里 DEEPSEEK_API_KEY 与 DEEPSEEK_BALANCE_API_KEY 指向**同一把**
  // sk-****（脱敏）...，两个名字各解析成功一次，probeBalance 的 sumOf('total') 就把
  // 267.61 算成 535.22，于是「535.22 → 267.61 -267.61」和反向「+267.61」成对乱发。
  // 判据只能按**实际 Key 值**去重：名字不同不代表账号不同。
  const seenValues = new Map()
  for (const target of targets) {
    let value = ''
    let source = ''
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        // CredentialRef 在运行时就是个字符串（TS 的 branded type 不产生运行时结构）。
        const hit = await credentials.resolve(target.name)
        value = String(hit?.value ?? '').trim()
        if (value !== '') source = 'DSH 凭据库（' + target.name + '）'
      } catch {
        // 单个名字解析失败就试下一个，不中断
      }
    }
    // 兜底读环境变量：DSH 之外起进程、或凭据服务不可用时还能工作。
    if (value === '') {
      const fromEnv = String(process.env?.[target.name] ?? '').trim()
      if (fromEnv !== '') {
        value = fromEnv
        source = '环境变量（' + target.name + '）'
      }
    }
    if (value !== '') {
      // 同一个值已经有名字解析出来了：这把 Key 就是同一个账号，跳过，不再计一次。
      if (seenValues.has(value)) continue
      seenValues.set(value, target.name)
    }
    out.push({
      name: target.name,
      label: target.label || target.name,
      value,
      source,
      error: value === '' ? '没有填这个 Key' : '',
    })
  }
  return out
}

/**
 * 读本机 provider-snapshots.json 里 DeepSeek 的余额（**陈旧数据的兜底**）。
 *
 * 实测该文件已停更（mtime 停在很久以前），所以调用方必须把 stale 标出来。
 */
export function readBalanceSnapshotFile() {
  try {
    const parsed = JSON.parse(readFileSync(PROVIDER_SNAPSHOTS_PATH, 'utf8'))
    const provider = parsed?.providers?.['deepseek-official']
    const balance = provider?.balance
    const total = Number(balance?.totalBalance)
    if (!Number.isFinite(total)) return { ok: false, error: '快照文件里没有 DeepSeek 余额字段' }
    const at = Number(balance?.updatedAt)
    return {
      ok: true,
      value: total,
      currency: String(balance?.currency ?? 'CNY'),
      dataTime: Number.isFinite(at) && at > 0 ? localTime(new Date(at)) : '',
      path: PROVIDER_SNAPSHOTS_PATH,
    }
  } catch (error) {
    return { ok: false, error: '读快照失败：' + String(error?.message ?? error) }
  }
}

/**
 * 探测 DeepSeek 余额。
 *
 * 顺序（用户 2026-11-22 拍板「先试凭据库 Key，取不到再降级快照」）：
 *  1. 凭据库 / 环境变量里的 Key → 官方接口（实时，stale=false）；
 *  2. 官方接口失败或没有 Key → provider-snapshots.json（陈旧，stale=true，通知里显著标注）；
 *  3. 两路都失败 → ok=false，**不发假通知**，只记日志。
 */
export async function probeBalance(ctx, options = {}) {
  const keys = await resolveBalanceKeys(ctx, options?.keys)
  const usable = keys.filter((item) => item.value !== '')
  const accounts = []
  let lastError = ''

  for (const key of usable) {
    const one = await fetchBalanceForKey(key)
    if (one.ok === true) {
      accounts.push({ ...one, name: key.name, label: key.label })
    } else {
      accounts.push({ ok: false, name: key.name, label: key.label, error: String(one.error ?? '') })
      lastError = String(one.error ?? '')
    }
  }

  const good = accounts.filter((item) => item.ok === true)
  if (good.length > 0) {
    // 多账号时 value 取各账号总额之和（判定「有没有变」用合计，明细逐账号列）。
    const sumOf = (field) => good.reduce((acc, item) => acc + (Number.isFinite(Number(item[field])) ? Number(item[field]) : 0), 0)
    return {
      ok: true,
      value: Math.round(sumOf('total') * 100) / 100,
      currency: String(good[0]?.currency ?? 'CNY'),
      source: good.length === 1
        ? String(good[0]?.source ?? 'DeepSeek 官方余额接口')
        : 'DeepSeek 官方余额接口（' + good.length + ' 个 Key）',
      dataTime: localTime(new Date()),
      stale: false,
      accounts: good.map((item) => ({
        name: String(item.name ?? ''),
        label: String(item.label ?? ''),
        ok: true,
        total: Number(item.total),
        // readBalanceInfo 对缺失字段返回 null，这里必须原样保留 null。
        // 写成 `Number.isFinite(Number(x)) ? Number(x) : null` 会把 null 变 0
        // （Number(null) === 0 且 isFinite(0) 为真），于是「接口没给赠金字段」
        // 会被显示成「赠金余额 0 元」，用户会以为赠金被清零了。
        toppedUp: numOrNull(item.toppedUp),
        granted: numOrNull(item.granted),
        currency: String(item.currency ?? 'CNY'),
      })),
      failed: accounts
        .filter((item) => item.ok !== true)
        .map((item) => ({ name: String(item.name ?? ''), label: String(item.label ?? ''), error: String(item.error ?? '') })),
    }
  }

  if (usable.length > 0) {
    logLine('probeBalance: 所有 Key 都取不到余额（' + String(lastError || '未知原因') + '），转用本机快照')
  }

  const snap = readBalanceSnapshotFile()
  if (snap.ok === true) {
    return {
      ok: true,
      value: snap.value,
      currency: snap.currency,
      source: '本机快照文件 provider-snapshots.json',
      dataTime: snap.dataTime,
      stale: true,
      // 快照只有总额，没有充值/赠金拆分：如实写 null，通知里会标成「—」。
      accounts: [{
        name: 'snapshot',
        label: '本机快照',
        ok: true,
        total: snap.value,
        toppedUp: null,
        granted: null,
        currency: snap.currency,
      }],
      failed: accounts.map((item) => ({ name: String(item.name ?? ''), label: String(item.label ?? ''), error: String(item.error ?? '') })),
    }
  }
  return {
    ok: false,
    error: '取不到余额：' + (usable.length === 0 ? '没有可用的 API Key，' : String(lastError || '所有 Key 都失败，')) + String(snap.error ?? ''),
  }
}

/**
 * 用一把 Key 查一次官方余额接口。
 *
 * 返回的是**单个账号**的读数：total / toppedUp / granted 三个字段都试着读出来
 * （官方把这三个都当字符串返回，必须 Number() 转换）。
 */
async function fetchBalanceForKey(key) {
  try {
    const url = new URL(BALANCE_URL)
    // 硬校验：域名必须是官方那一个，防止任何环节把请求带偏。
    if (url.protocol !== 'https:' || url.hostname !== BALANCE_HOST) {
      return { ok: false, error: '余额接口地址被篡改，已拒绝请求' }
    }
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + key.value, accept: 'application/json' },
    })
    if (res.ok === true) {
      const data = await res.json().catch(() => null)
      // 官方返回：{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
      const info = readBalanceInfo(pickBalanceInfo(data?.balance_infos))
      if (!info) return { ok: false, error: '官方接口返回里没有可用的余额字段' }
      return {
        ok: true,
        total: info.total,
        toppedUp: info.toppedUp,
        granted: info.granted,
        currency: info.currency,
        source: 'DeepSeek 官方余额接口（' + String(key.label ?? key.name) + '）',
        dataTime: localTime(new Date()),
        stale: false,
      }
    }
    const hint = res.status === 401 ? 'API Key 无效或已过期' : 'HTTP ' + res.status
    logLine('probeBalance: 官方接口失败（' + hint + '，' + String(key.name) + '）')
    return { ok: false, error: hint }
  } catch (error) {
    const why = String(error?.message ?? error)
    logLine('probeBalance: 官方接口异常（' + why + '，' + String(key.name) + '）')
    return { ok: false, error: why }
  }
}

/** 从官方 balance_infos 里挑出 CNY 那一条（没有 CNY 就用第一条）。 */
function pickBalanceInfo(infos) {
  const list = Array.isArray(infos) ? infos : []
  return list.find((item) => String(item?.currency ?? '').toUpperCase() === 'CNY') ?? list[0] ?? null
}

/**
 * 把官方一条 balance_info 转成统一结构。
 *
 * total_balance 是必须的（没有就当这条无效）；topped_up_balance / granted_balance
 * 在极老的接口版本里可能没有，缺失时给 null，由展示层写「—」而不是编个 0。
 */
function readBalanceInfo(info) {
  const total = Number(info?.total_balance)
  if (!Number.isFinite(total)) return null
  // 用 numOrNull 而不是 Number()+isFinite：接口把字段给成 null 时，
  // Number(null) === 0 会被当成「确实是 0 元」，那是编数据。
  return {
    total,
    toppedUp: numOrNull(info?.topped_up_balance),
    granted: numOrNull(info?.granted_balance),
    currency: String(info?.currency ?? 'CNY'),
  }
}

/**
 * 探测 WorkBuddy 积分。
 *
 * 走同进程宿主路由：origin 从 ctx.webServer.getOrigin() 现取，**不写死端口**。
 * 该路由只允许回环访问，且必须带 region 参数（缺了返回 400）。
 */
export async function probeCredits(ctx, region) {
  const zone = region === 'global' ? 'global' : 'cn'
  let origin = ''
  try {
    // 在 webServer.listen 之前调用会 throw，所以必须包 try —— 拿不到就当未就绪。
    origin = String(ctx?.webServer?.getOrigin?.() ?? '').trim()
  } catch {
    origin = ''
  }
  if (origin === '') return { ok: false, error: '宿主 Web 服务还没就绪（拿不到 origin），本次跳过' }

  const url = origin.replace(/\/+$/, '') + WORKBUDDY_USAGE_PATH + '?region=' + zone
  try {
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { accept: 'application/json' } })
    if (res.ok !== true) {
      return { ok: false, error: '积分接口返回 HTTP ' + res.status + (res.status === 404 ? '（插件 dsh-connect-workbuddy 可能没装）' : '') }
    }
    const data = await res.json().catch(() => null)
    const total = Number(data?.credits?.total)
    if (!Number.isFinite(total)) return { ok: false, error: '积分接口返回里没有 credits.total' }
    const packages = Array.isArray(data?.credits?.packages) ? data.credits.packages : []
    return {
      ok: true,
      value: total,
      region: zone,
      accountName: String(data?.accountName ?? ''),
      source: 'WorkBuddy 积分接口（' + zone + ' 区）',
      dataTime: localTime(new Date()),
      stale: false,
      packages,
    }
  } catch (error) {
    return { ok: false, error: '请求积分接口失败：' + String(error?.message ?? error) }
  }
}


/**
 * 探测 WorkBuddy **全部账号**的积分（一次请求拿回整张表）。
 *
 * 与 probeCredits 一样走同进程宿主路由、origin 现取不写死端口，
 * 区别只在于路由与返回结构：这里给的是一个账号数组，不是一个总数。
 *
 * @returns {Promise<{ok:boolean, region?:string, accounts?:Array<object>, source?:string, dataTime?:string, error?:string}>}
 */
export async function probeAccountCredits(ctx, region) {
  const zone = region === 'global' ? 'global' : 'cn'
  let origin = ''
  try {
    origin = String(ctx?.webServer?.getOrigin?.() ?? '').trim()
  } catch {
    origin = ''
  }
  if (origin === '') return { ok: false, error: '宿主 Web 服务还没就绪（拿不到 origin），本次跳过' }

  const url = origin.replace(/\/+$/, '') + WORKBUDDY_ACCOUNT_CREDITS_PATH + '?region=' + zone
  try {
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { accept: 'application/json' } })
    if (res.ok !== true) {
      return { ok: false, error: '账号积分接口返回 HTTP ' + res.status + (res.status === 404 ? '（插件 dsh-connect-workbuddy 可能没装）' : '') }
    }
    const data = await res.json().catch(() => null)
    const list = Array.isArray(data?.accounts) ? data.accounts : []
    if (list.length === 0) return { ok: false, error: '账号积分接口没有返回任何账号' }
    // 只留需要的字段：凭据、到期时间这些一概不碰，也不往日志/通知里带。
    const accounts = []
    for (const item of list) {
      const id = String(item?.id ?? '').trim()
      const value = Number(item?.credits)
      if (id === '' || !Number.isFinite(value)) continue
      accounts.push({
        id,
        accountName: String(item?.accountName ?? id),
        value,
        selected: item?.selected === true,
      })
    }
    if (accounts.length === 0) return { ok: false, error: '账号积分接口返回的账号里没有可用积分' }
    return {
      ok: true,
      region: zone,
      accounts,
      source: 'WorkBuddy 账号积分接口（' + zone + ' 区，全部账号）',
      dataTime: localTime(new Date()),
    }
  } catch (error) {
    return { ok: false, error: '请求账号积分接口失败：' + String(error?.message ?? error) }
  }
}

/**
 * 逐账号比对本次读数与上次基准。
 *
 * 三条边界（都写进返回值里，由调用方决定怎么说）：
 *  1. **新出现的账号**只记基准、不算变化（seeded 里给出来）——
 *     否则第一次打开这个开关时会把 13 个账号全当成「凭空多出来一堆分」。
 *  2. **消失的账号**不算变化，基准也保留（可能只是这次没取到 / 被移出池子），
 *     直接删基准会让它下次回来又变成「新账号」。
 *  3. 变化量小于阈值的账号也**不丢**，只是不进 moved，方便解释「为什么没发」。
 *
 * @param {Record<string, number>} oldMap 上次基准（账号 id → 积分）
 * @param {Array<object>} accounts 本次读数
 * @param {number} minDelta 单账号变化阈值
 */
export function diffAccountCredits(oldMap, accounts, minDelta) {
  const prev = oldMap && typeof oldMap === 'object' ? oldMap : {}
  const threshold = Number.isFinite(Number(minDelta)) ? Math.abs(Number(minDelta)) : 0
  const list = Array.isArray(accounts) ? accounts : []
  const moved = []
  const seeded = []
  let deltaSum = 0
  const seen = new Set()

  for (const account of list) {
    const id = String(account?.id ?? '')
    const value = Number(account?.value)
    if (id === '' || !Number.isFinite(value)) continue
    seen.add(id)
    const hasOld = Object.prototype.hasOwnProperty.call(prev, id)
    const oldValue = Number(prev[id])
    if (!hasOld || !Number.isFinite(oldValue)) {
      // 首次见到这个账号：记基准，不报「变化」。
      seeded.push(id)
      continue
    }
    const delta = Math.round((value - oldValue) * 100) / 100
    if (delta === 0) continue
    if (Math.abs(delta) < threshold) continue
    moved.push({ id, accountName: String(account?.accountName ?? id), oldValue, value, delta })
    deltaSum += delta
  }

  let gone = 0
  for (const id of Object.keys(prev)) {
    if (!seen.has(id)) gone += 1
  }

  // 减项优先：用户最关心「分怎么少了」，所以掉的排前面，同方向按幅度大→小。
  moved.sort((a, b) => {
    if ((a.delta < 0) !== (b.delta < 0)) return a.delta < 0 ? -1 : 1
    return Math.abs(b.delta) - Math.abs(a.delta)
  })

  const changed = moved.length > 0
  const down = moved.filter((m) => m.delta < 0)
  const up = moved.filter((m) => m.delta > 0)
  const parts = []
  if (down.length > 0) parts.push(down.length + ' 个账号减少')
  if (up.length > 0) parts.push(up.length + ' 个账号增加')
  const reason = changed
    ? parts.join('、') + '，合计 ' + humanDelta(Math.round(deltaSum * 100) / 100, ' 分') + '（共 ' + list.length + ' 个账号）'
    : '账号积分没有超阈值的变化（共 ' + list.length + ' 个账号）'

  return { changed, moved, seeded, gone, total: list.length, deltaSum: Math.round(deltaSum * 100) / 100, reason }
}
/**
 * 组装一条「多账号积分变化」通知的候选事件。
 *
 * 正文结构（与单账号 creditsChange 的差别）：
 *  - 说明行写「几个账号减少/增加、合计多少、总共几个账号」——
 *    折叠视图第一眼就能看到全局量级；
 *  - extraLines 逐账号列「· 名字 旧 → 新（-4.29）」，最多 8 个，超出的只报个数；
 *  - 合计变化同时写进 oldText/newText/deltaText，复用变化类的「变化：/差值：」两行。
 *
 * 为什么没有分包明细：/account-credits 的返回里**没有 packages 字段**
 * （只有积分总数），所以这条通知天然没有「哪个包剩多少」那些行。
 *
 * @param {{region:string, source:string, dataTime:string}} now 本次读数元信息
 * @param {Array<object>} moved 超阈值的账号
 * @param {number} deltaSum 合计变化
 * @param {number} total 本次一共看到几个账号
 */
export function buildCreditsPluginCandidate(now, moved, deltaSum, total) {
  const list = Array.isArray(moved) ? moved : []
  const extraLines = []
  // v0.1.10：不再截断。用户明确要求「一个信息显示所有账号」，
  // 所以有变化的账号**全部逐条列出**，既不丢账号也不写「还有 N 个未列出」。
  for (const item of list) {
    extraLines.push(
      '· ' + String(item.accountName ?? item.id ?? '账号') + ' ' +
      humanNumber(item.oldValue, ' 分') + ' → ' + humanNumber(item.value, ' 分') +
      '（' + humanDelta(item.delta, ' 分') + '）' + trendEmoji(item.delta),
    )
  }

  const down = list.filter((m) => m.delta < 0).length
  const up = list.filter((m) => m.delta > 0).length
  const head = []
  if (down > 0) head.push(down + ' 个账号减少')
  if (up > 0) head.push(up + ' 个账号增加')
  const arrow = deltaSum < 0 ? '🔻' : '🔺'
  const zone = String(now?.region ?? 'cn')
  const absSum = Math.abs(Math.round(Number(deltaSum) * 100) / 100)
  return {
    kind: 'creditsPluginChange',
    sessionId: '',
    cwd: '',
    title: '',
    detail: head.join('、') + '，合计 ' + humanDelta(deltaSum, ' 分') + '（共 ' + Number(total) + ' 个账号）',
    // 变化类的「变化：」行是「旧值 → 新值」。多账号没有单一的旧/新总量，
    // 所以这里把「合计变化」当成主角：左 0、右 累计变化量，差值行给带符号的真值。
    oldText: '0 分（合计基准）',
    newText: arrow + ' 合计 ' + humanNumber(absSum, ' 分'),
    deltaText: humanDelta(deltaSum, ' 分') + trendEmoji(deltaSum),
    source: String(now?.source ?? ('WorkBuddy 账号积分接口（' + zone + ' 区，全部账号）')),
    dataTime: String(now?.dataTime ?? ''),
    stale: false,
    extraLines,
  }
}
/**
 * 组装一条「余额变化」通知的候选事件（交给 watcher.handleCandidate 统一发）。
 *
 * @param {{ value:number, currency:string, source:string, dataTime:string, stale:boolean }} now 本次读数
 * @param {number} oldValue 上次已知余额
 * @param {number} delta 差值
 */
export function buildBalanceCandidate(now, oldValue, delta) {
  const unit = String(now.currency ?? 'CNY') === 'CNY' ? ' 元' : ' ' + String(now.currency ?? '')
  const arrow = delta < 0 ? '🔻' : '🔺'
  const breakdown = describeBalanceBreakdown(now, unit)
  return {
    kind: 'balanceChange',
    sessionId: '',
    cwd: '',
    title: '',
    // 变化量必须出现在「说明」这一行：手机通知折叠时可能只露出第一行，
    // 只说「余额减少」而不说减少多少，等于什么都没告诉用户。
    // v0.1.10 起再补一句「哪一项变了」，让用户不用展开明细就知道是充值还是赠金在动。
    detail: (delta < 0 ? '余额减少 ' : '余额增加 ') + humanNumber(Math.abs(delta), unit) +
      '，' + (now.stale === true ? '数据非实时' : '数据为实时查询结果') +
      (breakdown.summary !== '' ? '；' + breakdown.summary : ''),
    oldText: humanNumber(oldValue, unit),
    newText: arrow + ' ' + humanNumber(now.value, unit),
    deltaText: humanDelta(delta, unit) + trendEmoji(delta),
    source: String(now.source ?? ''),
    dataTime: String(now.dataTime ?? ''),
    stale: now.stale === true,
    extraLines: breakdown.lines,
  }
}

/**
 * 把余额拆成「总额 / 充值余额 / 赠金余额」三项。
 *
 * 用户 2026-11-25 的原话：不止是总额，还要写是充值余额变了还是赠金余额变了，
 * 三项都写出来，方便一眼看出是哪个额度在动。
 *
 * 数据来源是官方 balance_infos 里的三个字段（total_balance / topped_up_balance /
 * granted_balance）。拿不到的那些写「—」，**绝不编成 0**（编 0 会让人误以为余额归零）。
 *
 * @param {object} now probeBalance 的返回值（可能带 accounts 数组）
 * @param {string} unit 金额单位（' 元' 或 ' USD'）
 * @returns {{ lines: string[], summary: string }}
 */
function describeBalanceBreakdown(now, unit) {
  const accounts = Array.isArray(now?.accounts) ? now.accounts : []
  const lines = []
  let summary = ''

  if (accounts.length === 0) {
    // 没有逐账号数据（例如只有 value 的旧调用方）：至少把当前总额说出来。
    const total = Number(now?.value)
    if (Number.isFinite(total)) {
      lines.push('· 总额 ' + humanNumber(total, unit))
      lines.push('· 充值余额 ' + fmtOrDash(now?.toppedUp, unit))
      lines.push('· 赠金余额 ' + fmtOrDash(now?.granted, unit))
    }
    return { lines, summary }
  }

  // 汇总「哪一项在动」：把每个账号分项的变化加起来，只有非零的才写进 summary。
  const movedParts = []
  for (const account of accounts) {
    const label = String(account?.label ?? account?.name ?? '账号')
    const prev = account?.prev && typeof account.prev === 'object' ? account.prev : null
    const dTotal = diffOf(account?.total, prev?.total)
    const dToppedUp = diffOf(account?.toppedUp, prev?.toppedUp)
    const dGranted = diffOf(account?.granted, prev?.granted)
    if (dTotal !== null && dTotal !== 0) movedParts.push(label + '总额' + humanDelta(dTotal, unit) + trendEmoji(dTotal))
    if (dToppedUp !== null && dToppedUp !== 0) movedParts.push(label + '充值' + humanDelta(dToppedUp, unit) + trendEmoji(dToppedUp))
    if (dGranted !== null && dGranted !== 0) movedParts.push(label + '赠金' + humanDelta(dGranted, unit) + trendEmoji(dGranted))

    if (accounts.length > 1) lines.push('· ' + label)
    lines.push(indent(accounts.length > 1) + '总额 ' + humanNumber(account?.total, unit) + deltaTag(dTotal, unit))
    lines.push(indent(accounts.length > 1) + '充值余额 ' + fmtOrDash(account?.toppedUp, unit) + deltaTag(dToppedUp, unit))
    lines.push(indent(accounts.length > 1) + '赠金余额 ' + fmtOrDash(account?.granted, unit) + deltaTag(dGranted, unit))
  }

  if (movedParts.length > 0) {
    // 太长就只留前几条，summary 是给折叠视图看的一句话。
    const head = movedParts.slice(0, 3).join('、')
    summary = '变的是：' + head + (movedParts.length > 3 ? ' 等' : '')
  }
  return { lines, summary }
}

/** 单账号时的缩进（多账号才缩进，避免单账号看着像漏了一级）。 */
function indent(nested) {
  return nested ? '   ' : ''
}

/**
 * 把「可能缺失的数字」转成 number 或 null。**对外导出**：watcher.js 写快照时也要用。
 *
 * 存在的唯一理由：`Number(null) === 0`。凡是接口字段可能不存在的场合，
 * 一律走这个函数，不允许写 `Number.isFinite(Number(x)) ? Number(x) : null`
 * —— 那种写法会把缺失变成 0。
 */
export function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 值缺失时给「—」，不编 0。
 *
 * **必须先判空再 Number()**：`Number(null) === 0`、`Number(undefined) === NaN`，
 * 只靠 isFinite 判断会把「快照里没有拆分字段」显示成「充值余额 0 元」——
 * 用户会以为钱真的花光了。缺失就是缺失，显示破折号。
 */
function fmtOrDash(value, unit) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  return Number.isFinite(n) ? humanNumber(n, unit) : '—'
}

/**
 * 「N 个」的中文计数写法：humanNumber 已把大数缩成「12.24 万」，
 * 此时直接拼「个」（「12.24 万个」）；整数（500）没有单位后缀，补一个空格（「500 个」）。
 *
 * 这个函数被 buildSettleCandidate 与 buildTokenCandidate 共用。
 * 早先两处各写一遍，结果一处拼出「12.24 万 个」、另一处拼出「+12 万 个」——
 * 同一个项目里同一种数值出现了两种写法。
 */
function countOf(n) {
  const t = humanNumber(n)
  return /[万亿]$/.test(t) ? t + '个' : t + ' 个'
}

/** 变化量标签；没有基准就不写（不是 0）。后面跟一个涨跌三角（🔺/🔻；±0 不加）。 */
function deltaTag(delta, unit) {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return ''
  return '（' + humanDelta(delta, unit) + '）' + trendEmoji(delta)
}

/**
 * 两个数相减；任一「没有值」就返回 null（表示「没有基准」）。
 *
 * 同样必须先判空：`Number(null) === 0`，若直接相减，
 * 「上次快照里没有 grant 字段」会被算成「从 0 涨到现在」的假变化。
 */
function diffOf(nowValue, oldValue) {
  if (nowValue === null || nowValue === undefined || nowValue === '') return null
  if (oldValue === null || oldValue === undefined || oldValue === '') return null
  const a = Number(nowValue)
  const b = Number(oldValue)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((a - b) * 100) / 100
}

/** 组装一条「积分变化」通知的候选事件。 */
export function buildCreditsCandidate(now, oldValue, delta) {
  const extraLines = []
  const packages = Array.isArray(now.packages) ? now.packages : []
  for (const item of packages.slice(0, 3)) {
    const remain = Number(item?.remain)
    const size = Number(item?.size)
    if (!Number.isFinite(remain)) continue
    extraLines.push('· ' + String(item?.packageName ?? '积分包') + '：剩 ' + humanNumber(remain) + (Number.isFinite(size) ? ' / ' + humanNumber(size) : ''))
  }
  const arrow = delta < 0 ? '🔻' : '🔺'
  return {
    kind: 'creditsChange',
    sessionId: '',
    cwd: '',
    title: '',
    // 同上：折叠视图里「积分减少」四个字没有信息量，必须带数字。
    detail: (delta < 0 ? '积分减少 ' : '积分增加 ') + humanNumber(Math.abs(delta), ' 分') +
      (String(now.accountName ?? '') !== '' ? '（' + String(now.accountName) + '）' : ''),
    oldText: humanNumber(oldValue, ' 分'),
    newText: arrow + ' ' + humanNumber(now.value, ' 分'),
    deltaText: humanDelta(delta, ' 分') + trendEmoji(delta),
    source: String(now.source ?? ''),
    dataTime: String(now.dataTime ?? ''),
    stale: now.stale === true,
    extraLines,
  }
}

/** 组装一条「Token 累计」通知的候选事件。 */
export function buildTokenCandidate(oldTotal, newTotal, delta) {
  return {
    kind: 'tokenChange',
    sessionId: '',
    cwd: '',
    title: '',
    // 单位只写一次：humanNumber 的缩写（万 / 亿）后面直接跟「Token」，
    // 否则会拼出「57.76 万 个 Token」这种叠字，读起来别扭。
    detail: '本机累计 Token 消耗又增加了 ' + humanNumber(delta) + ' 个',
    oldText: humanNumber(oldTotal) + ' 个 Token',
    newText: '累计 ' + humanNumber(newTotal) + ' 个 Token',
    // 与结算正文同一套口径（countOf），避免「+12 万 个」这种多一个空格的写法。
    deltaText: (delta > 0 ? '+' : delta < 0 ? '-' : '±') + countOf(delta) + trendEmoji(delta),
    source: '宿主会话事件里的 usage 字段（实时）',
    dataTime: localTime(new Date()),
    stale: false,
  }
}

/**
 * 组装「每回合结算」通知（kind = turnSettle）。
 *
 * 与上面三个「变化类」的本质差别：变化类盯的是**账户级、跨回合**的累计值，
 * 没有会话；结算是**某一轮里到底动了多少**，所以它带会话、带本轮耗时。
 *
 * 四条纪律：
 *  1. **三项全都没有可说的内容就返回 null**（不发）——本轮没有 Token 消耗、
 *     余额与积分也没动，发一条「什么都没变」纯属噪音。
 *  2. **不达阈值的那一项不写行**，但会体现在 reason 里（便于界面/日志解释）。
 *  3. **查询失败必须如实写出来**，绝不省略、绝不用 0 或"未变"顶替。
 *  4. 余额/积分即使采集成功但没变化，也不写行（没有信息量）。
 *
 * @param {object} input
 * @param {number} [input.tokenDelta] 本轮 Token 增量（精确累加）
 * @param {number} [input.tokenTotal] 本机累计 Token（只为显示参考，可省）
 * @param {{ok:boolean,value?:number,oldValue?:number,currency?:string,stale?:boolean,source?:string,dataTime?:string,error?:string}} [input.balance]
 * @param {{ok:boolean,value?:number,oldValue?:number,accountName?:string,packages?:any[],stale?:boolean,source?:string,dataTime?:string,error?:string}} [input.credits]
 * @param {{tokenMinDelta?:number,balanceMinDelta?:number,creditsMinDelta?:number}} [input.settle] 判定阈值
 * @returns {{candidate: object|null, reason: string, lines: string[]}}
 */
/**
 * 把「回合前 / 回合后」两批余额账号配对（按 Key 名字）。
 *
 * 用户 2026-11-25 的要求：结算里要同时看到回合前的值和回合后的值。
 * 两次采样之间账号可能增减，所以取并集：只在一边出现的那一项，另一边写 null（显示「—」），
 * 不拿 0 顶替 —— 否则会凭空报出「从 0 涨到 267 元」。
 *
 * @returns {Array<{name:string,label:string,currency:string,before:object|null,after:object|null}>}
 */
function pairBalanceAccounts(beforeList, afterList) {
  const before = Array.isArray(beforeList) ? beforeList : []
  const after = Array.isArray(afterList) ? afterList : []
  const keyOf = (item) => String(item?.name ?? item?.label ?? '')
  const map = new Map()
  for (const item of before) {
    const key = keyOf(item)
    if (key === '') continue
    map.set(key, { name: key, label: String(item?.label ?? key), currency: String(item?.currency ?? 'CNY'), before: item, after: null })
  }
  for (const item of after) {
    const key = keyOf(item)
    if (key === '') continue
    const hit = map.get(key)
    if (hit) {
      hit.after = item
      if (hit.label === '' ) hit.label = String(item?.label ?? key)
    } else {
      map.set(key, { name: key, label: String(item?.label ?? key), currency: String(item?.currency ?? 'CNY'), before: null, after: item })
    }
  }
  return [...map.values()]
}

/**
 * 余额三项的「回合前 → 回合后」明细。
 *
 * @returns {{ lines: string[], summary: string }}
 */
function describeBalancePair(pairs, unit) {
  const lines = []
  const moved = []
  const nested = pairs.length > 1
  for (const pair of pairs) {
    if (nested) lines.push('· ' + pair.label)
    const before = pair.before
    const after = pair.after
    const rows = [
      ['总额', before?.total, after?.total],
      ['充值余额', before?.toppedUp, after?.toppedUp],
      ['赠金余额', before?.granted, after?.granted],
    ]
    for (const [name, bv, av] of rows) {
      const d = diffOf(av, bv)
      // 只在一边有值时，另一边写「未采到」而不是「—」：
      // 「—」在某些字体里看起来就是一片空白，用户会以为是排版坏了。
      const arrow = (bv === null || bv === undefined ? '未采到' : fmtOrDash(bv, unit)) + ' → ' +
        (av === null || av === undefined ? '未采到' : fmtOrDash(av, unit))
      lines.push(indent(nested) + name + ' ' + arrow + deltaTag(d, unit))
      if (d !== null && d !== 0) moved.push(pair.label + name + humanDelta(d, unit) + trendEmoji(d))
    }
  }
  const summary = moved.length === 0
    ? ''
    : '变的是：' + moved.slice(0, 4).join('、') + (moved.length > 4 ? ' 等' : '')
  return { lines, summary }
}

/**
 * 把「回合前 / 回合后」两张 WorkBuddy 账号表配对（按账号 id）。
 *
 * 与 pairBalanceAccounts 同样的道理：只在一边出现的账号，另一边写 null。
 *
 * @returns {Array<{id:string,name:string,before:number|null,after:number|null}>}
 */
function pairCreditAccounts(beforeList, afterList) {
  const before = Array.isArray(beforeList) ? beforeList : []
  const after = Array.isArray(afterList) ? afterList : []
  const map = new Map()
  for (const item of before) {
    const id = String(item?.id ?? item?.accountName ?? '')
    if (id === '') continue
    map.set(id, { id, name: String(item?.accountName ?? id), before: numOrNull(item?.value), after: null })
  }
  for (const item of after) {
    const id = String(item?.id ?? item?.accountName ?? '')
    if (id === '') continue
    const hit = map.get(id)
    if (hit) {
      hit.after = numOrNull(item?.value)
      hit.name = String(item?.accountName ?? hit.name)
    } else {
      map.set(id, { id, name: String(item?.accountName ?? id), before: null, after: numOrNull(item?.value) })
    }
  }
  return [...map.values()]
}

/**
 * 积分「回合前 → 回合后」明细：**全部账号都列**（用户明确要求不截断）。
 *
 * @returns {{ lines: string[], summary: string, movedCount: number }}
 */
function describeCreditsPair(pairs, minDelta) {
  const moved = []
  for (const pair of pairs) {
    const d = diffOf(pair.after, pair.before)
    if (d !== null && d !== 0 && Math.abs(d) >= minDelta) {
      moved.push({ name: pair.name, delta: d })
    }
  }
  // 减项优先、同向按幅度降序（与 diffAccountCredits 口径一致）。
  moved.sort((a, b) => {
    if ((a.delta < 0) !== (b.delta < 0)) return a.delta < 0 ? -1 : 1
    return Math.abs(b.delta) - Math.abs(a.delta)
  })

  const lines = []
  for (const pair of pairs) {
    const d = diffOf(pair.after, pair.before)
    lines.push('· ' + pair.name + ' ' +
      (pair.before === null || pair.before === undefined ? '未采到' : fmtOrDash(pair.before, ' 分')) + ' → ' +
      (pair.after === null || pair.after === undefined ? '未采到' : fmtOrDash(pair.after, ' 分')) + deltaTag(d, ' 分'))
  }

  let summary = ''
  if (moved.length > 0) {
    const sum = Math.round(moved.reduce((acc, item) => acc + item.delta, 0) * 100) / 100
    summary = moved.length + ' 个账号有变化，合计 ' + humanDelta(sum, ' 分') + '（共 ' + pairs.length + ' 个账号）' + trendEmoji(sum)
  }
  return { lines, summary, movedCount: moved.length }
}

/**
 * 组装「本回合结算」候选通知。
 *
 * v0.1.11 起支持**成对模式**（input.pair = { before, after }）：回合开始前与结束后各采样一次，
 * 正文把「回合前是多少 → 回合后是多少」直接列出来，用户一眼看出这一轮消耗了多少。
 * 两边任何一边没采到都如实写「未采到」，绝不拿上一次的旧值冒充。
 *
 * 没有 pair 时退回单值路径（老调用方与单测仍可用）。
 */
export function buildSettleCandidate(input) {
  const settle = input?.settle && typeof input.settle === 'object' ? input.settle : {}
  const tokenMin = Math.max(0, Number(settle.tokenMinDelta) || 0)
  const balanceMin = Math.max(0, Number(settle.balanceMinDelta) || 0)
  const creditsMin = Math.max(0, Number(settle.creditsMinDelta) || 0)

  const lines = []
  const summary = []
  const notes = []

  // ── 1. Token（纯内存累加，永远有值，只是可能为 0） ─────────────────
  const tokenDelta = Number(input?.tokenDelta)
  if (Number.isFinite(tokenDelta) && tokenDelta > 0 && tokenDelta >= tokenMin) {
    const total = Number(input?.tokenTotal)
    // 单位只出现一次：humanNumber 已把大数缩成「12.24 万」，再拼「 个」会变成
    // 「12.24 万 个」。缩写后直接拼「个」；整数（500）没有空格，补一个。
    const suffix = Number.isFinite(total) && total > 0
      ? '（本机累计 ' + countOf(total) + '）'
      : ''
    lines.push('🧮 Token：本轮用了 ' + countOf(tokenDelta) + suffix)
    // humanDelta 已经带了万亿后缀，直接再拼「 个」会变成「1181.37 万 个」。
    // 用和正文同一套 countOf，保证「万/亿」后面不多一个空格。
    summary.push('Token ' + (tokenDelta > 0 ? '+' : tokenDelta < 0 ? '-' : '±') + countOf(tokenDelta))
  } else if (Number.isFinite(tokenDelta) && tokenDelta > 0) {
    notes.push('Token 本轮 ' + humanNumber(tokenDelta, ' 个') + '，未达结算阈值 ' + humanNumber(tokenMin, ' 个'))
  } else if (input?.wantToken === true) {
    notes.push('Token 本轮没有消耗记录')
  }

  const pair = input?.pair && typeof input.pair === 'object' ? input.pair : null
  const pairMode = pair !== null && (pair.before != null || pair.after != null)

  if (pairMode === true) {
    const before = pair.before && typeof pair.before === 'object' ? pair.before : null
    const after = pair.after && typeof pair.after === 'object' ? pair.after : null
    const beforeTime = String(before?.at ?? '').trim()
    const afterTime = String(after?.at ?? '').trim()
    // v0.1.17：回合前值可能是「补采」或「快照兜底」来的，必须让用户看得出差别。
    //  - ''           正常（turn/start 时采的）
    //  - '（回合开始后补采）'    turn/start 没到，用本回合第一个后续事件补采的
    //  - '（取自上一回合结束时 <时刻> 的记录）'  整轮都没采到，用快照顶上的
    const beforeVia = String(before?.via ?? '')
    const beforeMark = beforeVia === 'catch-up'
      ? '（回合开始后补采）'
      : (beforeVia === 'snapshot'
        ? '（取自上一回合结束时' + (beforeTime !== '' ? ' ' + beforeTime + ' ' : '') + '的记录）'
        : '')

    // ── 2. 余额三项（回合前 → 回合后） ───────────────────────────────
    if (input?.wantBalance === true) {
      const bBalance = before?.balance && before.balance.ok === true ? before.balance : null
      const aBalance = after?.balance && after.balance.ok === true ? after.balance : null
      const anyBalance = aBalance ?? bBalance
      const currency = String(anyBalance?.currency ?? 'CNY')
      const unit = currency === 'CNY' ? ' 元' : ' ' + currency
      // ★ v0.1.17：修「回合开始时没采到（回合开始时没有采到）」这个括号套括号。
      // 旧写法 `?? '回合开始时没有采到'` 在 before 整个为空时落到默认串，
      // 外层再套一层「没采到（…）」就重复了。现在分三种情况如实说：
      //  - before 整体为空：这一回合根本没采过（turn/start 没送到插件）
      //  - 采了但接口给了原因：用接口原因
      //  - 采了但没原因：不硬编一句废话
      const whyBefore = before === null
        ? '这一回合开始时没能采到（turn/start 事件没送到插件）'
        : String(before?.balance?.error ?? '').trim() || '没有返回具体原因'
      const whyAfter = after === null
        ? '这一回合结束时没能采到'
        : String(after?.balance?.error ?? '').trim() || '没有返回具体原因'

      if (bBalance === null && aBalance === null) {
        lines.push('💰 余额：本回合前后都没查到 —— ' + excerptText(whyBefore + ' / ' + whyAfter, 120))
        summary.push('余额 未查到')
        notes.push('余额查询失败：' + whyBefore + ' / ' + whyAfter)
      } else if (bBalance === null || aBalance === null) {
        const got = aBalance ?? bBalance
        const which = aBalance !== null ? '回合后' : '回合前'
        const missing = aBalance !== null
          ? '回合开始时没采到 —— ' + whyBefore
          : '回合结束时没采到 —— ' + whyAfter
        lines.push('💰 余额：' + missing + '，只列' + which + '的值')
        const oneSide = describeBalanceBreakdown(got, unit)
        for (const line of oneSide.lines) lines.push('   ' + line)
        summary.push('余额 只采到一边')
        notes.push('余额只有' + which + '数据')
      } else if (bBalance.stale === true || aBalance.stale === true) {
        // ★ v0.1.13：任一侧取自本机快照就不能算差值。
        //
        // 快照（provider-snapshots.json）是 2026-10-18 的死数据 307.84，实时值是 239.24，
        // 两侧一减就是「本回合 -68.6 元」，纯属假账。旧版只加了一行「⚠️ 非实时」的提示，
        // 却照旧把 delta 写进摘要，等于告诉用户花了一笔不存在的钱。
        // 现在的口径：**不可比**，只说清哪一侧不是实时的，不给任何数字。
        const staleSide = aBalance.stale === true && bBalance.stale === true
          ? '前后两次'
          : (aBalance.stale === true ? '回合结束时' : '回合开始时')
        lines.push('💰 余额：' + staleSide + '取到的是本机快照（非实时），本回合不做比较')
        const listed = describeBalanceBreakdown(aBalance.stale === true ? bBalance : aBalance, unit)
        for (const line of listed.lines) lines.push('   ' + line)
        if (listed.summary !== '' && listed.summary !== undefined) lines.push('   ' + listed.summary)
        summary.push('余额 不可比（快照）')
        notes.push('余额有快照数据掺入，已跳过差值计算')
      } else {
        const pairs = pairBalanceAccounts(bBalance.accounts, aBalance.accounts)
        const described = describeBalancePair(pairs, unit)
        const dTotal = diffOf(aBalance.value, bBalance.value)
        const head = dTotal === null
          ? humanNumber(aBalance.value, unit)
          : humanNumber(bBalance.value, unit) + ' → ' + humanNumber(aBalance.value, unit) +
            '（' + humanDelta(dTotal, unit) + '）' + trendEmoji(dTotal)
        lines.push('💰 余额（' + (beforeTime !== '' ? beforeTime + beforeMark : '回合前') + ' → ' +
          (afterTime !== '' ? afterTime : '回合后') + '）：' + head)
        for (const line of described.lines) lines.push('   ' + line)
        if (described.summary !== '') lines.push('   ' + described.summary)
        summary.push(dTotal !== null ? '余额 ' + humanDelta(dTotal, unit) + trendEmoji(dTotal) : '余额 ' + humanNumber(aBalance.value, unit))
      }
    }

    // ── 3. 积分（WorkBuddy 全部账号，回合前 → 回合后） ────────────────
    if (input?.wantCredits === true) {
      const bCredits = Array.isArray(before?.creditAccounts) ? before.creditAccounts : null
      const aCredits = Array.isArray(after?.creditAccounts) ? after.creditAccounts : null
      const whyBefore = before === null
        ? '这一回合开始时没能采到（turn/start 事件没送到插件）'
        : String(before?.creditsError ?? '').trim() || '没有返回具体原因'
      const whyAfter = after === null
        ? '这一回合结束时没能采到'
        : String(after?.creditsError ?? '').trim() || '没有返回具体原因'

      if (!bCredits && !aCredits) {
        lines.push('🎫 积分：本回合前后都没查到 —— ' + excerptText(whyBefore + ' / ' + whyAfter, 120))
        summary.push('积分 未查到')
        notes.push('积分查询失败：' + whyBefore + ' / ' + whyAfter)
      } else if (!bCredits || !aCredits) {
        const got = aCredits ?? bCredits
        const which = aCredits ? '回合后' : '回合前'
        const missing = aCredits
          ? '回合开始时没采到 —— ' + whyBefore
          : '回合结束时没采到 —— ' + whyAfter
        const listed = got.slice(0, 20).map((item) => '· ' + String(item?.accountName ?? item?.id ?? '账号') + ' ' +
          fmtOrDash(item?.value, ' 分')).join('\n')
        lines.push('🎫 积分：' + missing + '，只列' + which + '的值（共 ' + got.length + ' 个账号）')
        for (const one of listed.split('\n')) if (one !== '') lines.push('   ' + one)
        summary.push('积分 只采到一边')
        notes.push('积分只有' + which + '数据')
      } else {
        const pairs = pairCreditAccounts(bCredits, aCredits)
        const described = describeCreditsPair(pairs, creditsMin)
        lines.push('🎫 积分（WorkBuddy 全部 ' + pairs.length + ' 个账号，' +
          (beforeTime !== '' ? beforeTime + beforeMark : '回合前') + ' → ' +
          (afterTime !== '' ? afterTime : '回合后') + '）')
        for (const line of described.lines) lines.push('   ' + line)
        if (described.summary !== '') {
          lines.push('   ' + described.summary)
          summary.push('积分 ' + described.summary)
        } else {
          summary.push('积分 没有超阈值的变化')
        }
        if (described.movedCount === 0) {
          notes.push('积分本回合没有超阈值的变化（共 ' + pairs.length + ' 个账号，阈值 ' +
            humanNumber(creditsMin, ' 分') + '）')
        }
      }
    }
  } else {
    // ── 2. 余额（单值路径：三项都写，且说明是哪一项在动） ──────────────
    const balance = input?.balance
    if (input?.wantBalance === true) {
      if (!balance || balance.ok !== true) {
        const why = String(balance?.error ?? '未获取到数据')
        lines.push('💰 余额：本次没查到 —— ' + excerptText(why, 120))
        summary.push('余额 未查到')
        notes.push('余额查询失败：' + why)
      } else {
        const unit = String(balance.currency ?? 'CNY') === 'CNY' ? ' 元' : ' ' + String(balance.currency ?? '')
        const now = Number(balance.value)
        const old = Number(balance.oldValue)
        // ★ v0.1.13：快照值不参与差值计算（同 pair 分支的坑：307.84 是 2026-10-18 的死数据）。
        if (balance.stale === true) {
          lines.push('💰 余额：本次取到的是本机快照，不是实时的，不做比较')
          const listed = describeBalanceBreakdown(balance, unit)
          for (const line of listed.lines) lines.push('   ' + line)
          summary.push('余额 不可比（快照）')
          notes.push('余额取自快照，已跳过差值计算')
        } else {
          const delta = Number.isFinite(old) ? now - old : NaN
          const changed = Number.isFinite(delta) && Math.abs(delta) >= balanceMin && delta !== 0
          const seeded = !Number.isFinite(old)
          if (changed || seeded) {
            // 有变化或首次建基准时，把三项全写出来；没变化且已有基准时只在 notes 里提一句。
            const breakdown = describeBalanceBreakdown(balance, unit)
            if (changed) {
              lines.push('💰 余额：' + humanNumber(old, unit) + ' → ' + humanNumber(now, unit) + '（' + humanDelta(delta, unit) + '）' + trendEmoji(delta))
              summary.push('余额 ' + humanDelta(delta, unit) + trendEmoji(delta))
            } else {
              lines.push('💰 余额：' + humanNumber(now, unit) + '（本回合开始前没有基准值，下次才有对比）')
              summary.push('余额 ' + humanNumber(now, unit))
            }
            // 三项明细：总额 / 充值余额 / 赠金余额。用户要的就是这三行。
            for (const line of breakdown.lines) lines.push('   ' + line)
            if (changed && breakdown.summary !== '') lines.push('   ' + breakdown.summary)
          } else {
            notes.push('余额本回合没有变化（' + humanNumber(now, unit) + '，阈值 ' + humanNumber(balanceMin, unit) + '）')
          }
        }
      }
    }

    // ── 3. 积分（单值 / 多账号基准路径） ─────────────────────────────
    const credits = input?.credits
    const creditAccounts = Array.isArray(input?.creditAccounts) ? input.creditAccounts : []
    if (input?.wantCredits === true) {
      if (creditAccounts.length > 0) {
        // 多账号模式：逐账号列，合计写进 summary。
        let deltaSum = 0
        const moved = []
        const seededNames = []
        for (const item of creditAccounts) {
          const name = String(item?.accountName ?? item?.id ?? '账号')
          const nowValue = Number(item?.value)
          if (!Number.isFinite(nowValue)) continue
          // 注意：不能用 Number(null) 判断 —— Number(null) === 0，会把「首次见到的新账号」
          // 算成「从 0 分涨到 X 分」的假变化。必须先显式判空。
          const rawOld = item?.oldValue
          if (rawOld === null || rawOld === undefined || rawOld === '') {
            seededNames.push(name)
            continue
          }
          const oldValue = Number(rawOld)
          if (!Number.isFinite(oldValue)) {
            seededNames.push(name)
            continue
          }
          const d = Math.round((nowValue - oldValue) * 100) / 100
          if (d === 0) continue
          if (Math.abs(d) < creditsMin) continue
          moved.push({ name, oldValue, nowValue, delta: d })
          deltaSum += d
        }
        // 减项优先，同向按幅度降序（与 diffAccountCredits 的口径保持一致）。
        moved.sort((a, b) => {
          if ((a.delta < 0) !== (b.delta < 0)) return a.delta < 0 ? -1 : 1
          return Math.abs(b.delta) - Math.abs(a.delta)
        })
        if (moved.length > 0) {
          const rounded = Math.round(deltaSum * 100) / 100
          lines.push('🎫 积分：' + moved.length + ' 个账号有变化，合计 ' + humanDelta(rounded, ' 分') + trendEmoji(rounded) +
            '（共 ' + creditAccounts.length + ' 个账号）')
          summary.push('积分 ' + humanDelta(rounded, ' 分') + trendEmoji(rounded))
          for (const item of moved) {
            lines.push('   · ' + item.name + ' ' + humanNumber(item.oldValue, ' 分') + ' → ' +
              humanNumber(item.nowValue, ' 分') + '（' + humanDelta(item.delta, ' 分') + '）' + trendEmoji(item.delta))
          }
        } else if (seededNames.length === creditAccounts.length) {
          lines.push('🎫 积分：本次读到 ' + creditAccounts.length + ' 个账号，都是首次记录基准（下次才有对比）')
          summary.push('积分 首次记基准')
        } else {
          notes.push('积分本回合没有超阈值的变化（共 ' + creditAccounts.length + ' 个账号，阈值 ' +
            humanNumber(creditsMin, ' 分') + '）')
        }
      } else if (!credits || credits.ok !== true) {
        const why = String(credits?.error ?? '未获取到数据')
        lines.push('🎫 积分：本次没查到 —— ' + excerptText(why, 120))
        summary.push('积分 未查到')
        notes.push('积分查询失败：' + why)
      } else {
        // 单账号兜底（拿不到账号表时还能用）。
        const now = Number(credits.value)
        const old = Number(credits.oldValue)
        const delta = Number.isFinite(old) ? now - old : NaN
        const who = String(credits.accountName ?? '').trim()
        if (Number.isFinite(delta) && Math.abs(delta) >= creditsMin && delta !== 0) {
          lines.push('🎫 积分：' + humanNumber(old, ' 分') + ' → ' + humanNumber(now, ' 分') + '（' + humanDelta(delta, ' 分') + '）' + trendEmoji(delta) + (who !== '' ? ' · ' + who : ''))
          summary.push('积分 ' + humanDelta(delta, ' 分') + trendEmoji(delta))
        } else if (!Number.isFinite(old)) {
          lines.push('🎫 积分：' + humanNumber(now, ' 分') + '（本回合开始前没有基准值，下次才有对比）' + (who !== '' ? ' · ' + who : ''))
          summary.push('积分 ' + humanNumber(now, ' 分'))
        } else {
          notes.push('积分本回合没有变化（' + humanNumber(now, ' 分') + '，阈值 ' + humanNumber(creditsMin, ' 分') + '）')
        }
      }
    }
  }

  // 三项都没有可写内容 → 不发。这是「没变化就别吵」的落点。
  if (lines.length === 0) {
    return {
      candidate: null,
      reason: notes.length > 0 ? notes.join('；') : '本回合没有需要结算的数值变化',
      lines: [],
    }
  }

  return {
    candidate: {
      kind: 'turnSettle',
      sessionId: '',
      cwd: '',
      title: '',
      detail: summary.join('；'),
      extraLines: lines,
      source: '宿主会话事件 + 回合开始/结束各一次余额/积分查询',
      dataTime: localTime(new Date()),
      stale: false,
    },
    reason: notes.join('；'),
    lines,
  }
}

/** 局部截断（不 import excerpt 以免循环依赖 format ← changes 已经单向依赖）。 */
function excerptText(text, max) {
  const body = String(text ?? '').trim()
  const limit = Math.max(1, Number(max) || 120)
  const chars = Array.from(body)
  return chars.length <= limit ? body : chars.slice(0, limit).join('') + '…'
}

