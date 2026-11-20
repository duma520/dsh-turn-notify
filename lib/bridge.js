/**
 * lib/bridge.js —— 与「通知发送器」对接的桥（拿账号 + 发通知）。
 *
 * 为什么不当场重写一套发送逻辑：
 *  通知发送器已经把「聚合 push-hub / bridge / im-connect 三处账号 + 逐通道发送」
 *  这一整套做完了，而且凭据只留在它那一侧。本插件再去复制一遍通道代码，
 *  等于把凭据处理逻辑复制成两份，任何一边升级都会错位（宪法红线 g22 的精神）。
 *
 * 因此这里**只复用、不复制**：
 *  主路径：直接 import 通知发送器的 lib/paths.js、lib/accounts.js、lib/sender.js，
 *          调它们的 collect / publicList / sendWithAccount —— 与本插件同进程、零网络。
 *  兜底路径：模块找不到时，退回 HTTP 调它的 /@duma520/dsh-notify-sender/api。
 *
 * 两条纪律：
 *  1. 任何失败都返回**明确原因**（不说「未知错误」），界面才能告诉用户去修什么；
 *  2. 绝不读写、绝不打印任何 token / secret —— 凭据只在这条链路内部流转。
 *
 * @module bridge.js
 */

import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 通知发送器的包名（用于在 profile 的 node_modules 里找）。 */
const SENDER_PKG = '@duma520/dsh-notify-sender'

/** 模块缓存：三个子模块各加载一次即可。 */
let modCache = null
let modError = ''

/**
 * 列出「可能装着通知发送器」的目录，按可信度排序。
 *
 * 为什么不只找一处：本机的插件可能是 link:（开发目录）、也可能是 npm 安装的
 * （在 profile 的 node_modules 里）。两种情况都要能找到，否则一升级就失联。
 */
export function candidateSenderDirs() {
  const home = os.homedir()
  const dirs = []
  const push = (dir) => {
    const abs = path.resolve(String(dir ?? ''))
    if (abs !== '' && !dirs.includes(abs)) dirs.push(abs)
  }

  // 1. 环境变量显式指定（调试用，优先级最高）
  push(process.env.DSH_NOTIFY_SENDER_DIR)
  // 2. 各 profile 的 node_modules（正常安装路径）
  const profilesDir = path.join(home, '.dsh', 'profiles')
  if (existsSync(profilesDir)) {
    try {
      const entries = readdirSync(profilesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        push(path.join(profilesDir, entry.name, 'node_modules', SENDER_PKG))
      }
    } catch {
      /* 读不到就跳过，不影响后面的候选 */
    }
  }
  // 3. 本机开发目录约定（link: 安装时指向这里）
  push('<插件根目录>/dsh-notify-sender')
  return dirs.filter((dir) => existsSync(path.join(dir, 'package.json')))
}

/**
 * 加载通知发送器的三个子模块。
 *
 * 只加载子模块、**不加载它的 index.js** —— index.js 是插件半身，import 它会尝试
 * 注册 webServer/tools，在别人的上下文里跑会出问题。子模块是纯函数，安全。
 */
export async function loadSenderModules() {
  if (modCache !== null) return modCache
  if (modError !== '') return { ok: false, error: modError }

  const dirs = candidateSenderDirs()
  if (dirs.length === 0) {
    modError = '找不到通知发送器 ' + SENDER_PKG + '（既没装在 profile，也没有开发目录）。请先安装 @duma520/dsh-notify-sender。'
    return { ok: false, error: modError }
  }

  let lastError = ''
  for (const dir of dirs) {
    try {
      const pathsMod = await import(pathToFileURL(path.join(dir, 'lib', 'paths.js')).href)
      const accountsMod = await import(pathToFileURL(path.join(dir, 'lib', 'accounts.js')).href)
      const senderMod = await import(pathToFileURL(path.join(dir, 'lib', 'sender.js')).href)
      modCache = { ok: true, dir, paths: pathsMod, accounts: accountsMod, sender: senderMod }
      return modCache
    } catch (error) {
      lastError = String((error && error.message) || error)
    }
  }
  modError = '找到通知发送器目录但加载失败：' + lastError
  return { ok: false, error: modError }
}

/** 清掉缓存（用户刚装/升级了通知发送器时用）。 */
export function resetSenderModules() {
  modCache = null
  modError = ''
}

/**
 * 拿当前可用账号清单。
 *
 * @returns {Promise<{ok:boolean, list:any[], byId:Map<string,any>, error?:string}>}
 */
export async function listAccounts() {
  const mods = await loadSenderModules()
  if (mods.ok !== true) return { ok: false, list: [], byId: new Map(), error: mods.error }

  try {
    const settings = mods.paths.readSettings()
    let hubCfg = null
    const hub = await mods.sender.getHub()
    if (hub && hub.ok === true) {
      try {
        hubCfg = hub.config.load(settings?.pushHubPath || undefined)
      } catch {
        hubCfg = null
      }
    }
    const collected = mods.accounts.collect(hubCfg, { disabledSources: settings?.disabledSources })
    return {
      ok: true,
      list: mods.accounts.publicList(collected),
      byId: collected.byId,
      hub: hub && hub.ok === true ? { ok: true, dir: hub.dir, source: hub.source } : { ok: false, error: String(hub?.error ?? '') },
    }
  } catch (error) {
    return { ok: false, list: [], byId: new Map(), error: '读取账号清单失败：' + String((error && error.message) || error) }
  }
}

/**
 * 通知发送器里「上次选中」的账号 id（用户在那边挑好的那一组）。
 * 本插件默认沿用它，避免要用户在两个插件里各配置一遍。
 */
export async function lastSelectedIds() {
  const mods = await loadSenderModules()
  if (mods.ok !== true) return []
  try {
    const selection = mods.accounts.lastSelection()
    return Array.isArray(selection?.ids) ? selection.ids.map(String).filter((s) => s !== '') : []
  } catch {
    return []
  }
}

/**
 * 发一条通知到一个账号。
 *
 * 单条发送 + 逐条返回：与通知发送器同口径（失败不吞，明确说哪个通道哪个账号失败了）。
 */
export async function sendToOne({ account, title, text, dryRun }) {
  const mods = await loadSenderModules()
  if (mods.ok !== true) return { ok: false, error: mods.error, accountId: '', channel: '', account: '' }

  try {
    const body = mods.sender.composeBody(String(title ?? ''), String(text ?? ''))
    if (body.trim() === '') return { ok: false, error: '正文为空，没东西可发', accountId: String(account?.id ?? ''), channel: String(account?.channel ?? ''), account: String(account?.name ?? '') }
    const outcome = await mods.sender.sendWithAccount({ account, text: body, dryRun: dryRun === true })
    return {
      ...outcome,
      accountId: String(account?.id ?? ''),
      channel: String(account?.channel ?? ''),
      account: String(account?.name ?? ''),
    }
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error),
      accountId: String(account?.id ?? ''),
      channel: String(account?.channel ?? ''),
      account: String(account?.name ?? ''),
    }
  }
}

/**
 * 解析「这次到底发给谁」。
 *
 * 优先级：插件自己配了 targetAccountIds → 用它；没配 → 沿用通知发送器上次选中的那组。
 * 一个都没有就明确失败，不猜默认值（猜错会把通知发到用户没想到的地方）。
 */
export async function resolveTargets(config) {
  const all = await listAccounts()
  if (all.ok !== true) return { ok: false, targets: [], error: all.error }

  const configured = Array.isArray(config?.targetAccountIds) ? config.targetAccountIds.map(String).filter((s) => s !== '') : []
  const ids = configured.length > 0 ? configured : await lastSelectedIds()
  if (ids.length === 0) {
    return { ok: false, targets: [], error: '没有目标账号：请在本插件设置里选账号，或先到「通知发送器」里选一组账号。' }
  }

  const targets = []
  const missing = []
  for (const id of ids) {
    const hit = all.byId.get(id) ?? null
    if (hit === null) { missing.push(id); continue }
    if (hit.usable !== true) { missing.push(id + '（缺凭据）'); continue }
    targets.push(hit)
  }
  if (targets.length === 0) {
    return { ok: false, targets: [], error: '目标账号都不可用：' + missing.join('、') }
  }
  return { ok: true, targets, missing, fromSender: configured.length === 0 }
}
