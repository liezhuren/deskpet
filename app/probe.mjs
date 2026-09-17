// app/probe.mjs —— 外部信号探测：游戏进程在不在跑 / 系统空闲了多久
//
// 这两件事是时机引擎的**外部输入**（core/presence.mjs 需要 `gameRunning` 与 `idleSec`），
// 但它们依赖操作系统与 Electron，所以刻意做成**依赖注入**：
//   · execImpl   —— 默认 spawn 一次 `tasklist`；测试注入假的，于是完全离线可测
//   · idleReader —— 默认由 Electron 的 powerMonitor 提供（main 进程里接上）
//
// ═══════════════════════════════════════════════════════════════════
// ★ 一个必须想清楚的问题：读不到空闲时间时该怎么办
// ═══════════════════════════════════════════════════════════════════
// `idleSeconds()` 是可以失败的（非 Windows、powerMonitor 不可用、权限问题）。
// 此时若把"读不到"当成"玩家空闲"（返回 0 或大数），后果分别是：
//   当成空闲 → 游戏正在跑的时候去打扰玩家（最坏的结果）
//   当成专注 → 什么都不说（只是错过机会）
// 所以本模块在失败时返回 **null**，而 agent 层把 `null + 游戏在跑` 视为**专注**：
// **宁可漏说，不可打扰**。这与 ARCHITECTURE §3 原则 P1/P2 的立场一致。
//
// 进程探测还有个成本问题：`tasklist` 是个真进程，每秒 spawn 一次是浪费。
// 所以带 TTL 缓存（默认 5 秒）—— 游戏启动/退出这种事件，5 秒的粒度足够。

import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'

export const PROBE_DEFAULTS = Object.freeze({
  ttlMs: 5000,        // 进程探测结果的缓存时长
  timeoutMs: 4000,    // tasklist 超时
})

/** Windows 的候选进程名后缀。 */
const EXE_SUFFIXES = ['', '.exe']

/**
 * 从游戏目录名**猜**进程名。
 *
 * ⚠ 这是**猜测**，不是事实：目录名（`Hollow Knight`）与可执行文件名
 * （`hollow_knight.exe`）经常不一致，所以：
 *   · 猜出来的候选会一并返回，界面要**显示给用户看**，让他改
 *   · 探测结果里带 `guessed: true`，绝不假装这是准确信息
 *
 * @param {string} dir
 * @returns {string[]} 候选进程名（去重、小写）
 */
export function guessProcessNames(dir) {
  if (!dir || typeof dir !== 'string') return []
  const name = basename(dir).trim()
  if (name === '') return []
  const variants = new Set()
  const bases = [
    name,
    name.replace(/\s+/g, ''),
    name.replace(/\s+/g, '_'),
    name.replace(/\s+/g, '-'),
    name.replace(/[^\p{L}\p{N} ]+/gu, '').trim(),
  ]
  for (const b of bases) {
    if (!b) continue
    for (const suf of EXE_SUFFIXES) variants.add((b + suf).toLowerCase())
  }
  return [...variants]
}

/**
 * 建一个探测器。
 * @param {object} [opts]
 * @param {(cmd:string, args:string[], o:object)=>Promise<{stdout:string}>} [opts.execImpl]
 * @param {()=>number|null} [opts.idleReader]
 * @param {()=>number} [opts.now]
 * @param {number} [opts.ttlMs]
 */
export function createProbe(opts = {}) {
  const ttlMs = opts.ttlMs ?? PROBE_DEFAULTS.ttlMs
  const now = opts.now ?? (() => Date.now())
  const execImpl = opts.execImpl ?? defaultExec
  let idleReader = opts.idleReader ?? (() => null)

  let cache = null          // { at, names, result }
  const stats = { probes: 0, cacheHits: 0, errors: 0, idleCalls: 0 }

  /** 允许 main 进程在 app ready 之后再接上 powerMonitor。 */
  function setIdleReader(fn) { idleReader = typeof fn === 'function' ? fn : (() => null) }

  /**
   * 系统空闲秒数。**读不到时返回 null**（理由见文件头）。
   * @returns {number|null}
   */
  function idleSeconds() {
    stats.idleCalls++
    let v
    try { v = idleReader() } catch { return null }
    if (!Number.isFinite(v) || v < 0) return null
    return v
  }

  /**
   * 指定名字的进程是否在跑。
   * @param {string[]} names 进程名候选（大小写不敏感，带不带 .exe 都行）
   * @param {{force?:boolean}} [o]
   * @returns {Promise<{running:boolean, matches:string[], at:number, cached:boolean, error:string|null, available:boolean}>}
   */
  async function isRunning(names, o = {}) {
    const want = normalizeNames(names)
    const t = now()
    if (!o.force && cache && now() - cache.at < ttlMs && sameNames(cache.names, want)) {
      stats.cacheHits++
      return { ...cache.result, cached: true }
    }
    stats.probes++

    if (want.length === 0) {
      const result = { running: false, matches: [], at: t, cached: false, error: null, available: true }
      cache = { at: t, names: want, result }
      return result
    }

    let stdout = ''
    let error = null
    let available = true
    try {
      const r = await execImpl('tasklist', ['/FO', 'CSV', '/NH'], { timeout: PROBE_DEFAULTS.timeoutMs })
      stdout = r?.stdout ?? ''
    } catch (e) {
      stats.errors++
      error = e?.code === 'ENOENT' ? '找不到 tasklist（非 Windows？）' : (e?.message ?? '进程探测失败')
      available = e?.code !== 'ENOENT'
    }

    const running = parseTasklist(stdout)
    const matches = want.filter((n) => running.has(n))
    const result = { running: matches.length > 0, matches, at: t, cached: false, error, available }
    cache = { at: t, names: want, result }
    return result
  }

  function reset() { cache = null }

  return { isRunning, idleSeconds, setIdleReader, reset, stats, guessProcessNames }
}

/**
 * 解析 `tasklist /FO CSV /NH` 的输出。
 * 每行形如 `"notepad.exe","1234","Console","1","12,345 K"` —— 注意内存那一列**含逗号**，
 * 所以不能用 split(',')，必须按 CSV 的引号规则来（这里只需要第一个字段）。
 * @returns {Set<string>} 小写的进程名集合
 */
export function parseTasklist(stdout) {
  const set = new Set()
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*"([^"]+)"/)
    if (m) set.add(m[1].toLowerCase())
    else {
      // 少见：没有引号的行（本地化/异常输出）也要能捞到第一个字段
      const t = line.trim().split(/\s+/)[0]
      if (t && /\.exe$/i.test(t)) set.add(t.toLowerCase())
    }
  }
  return set
}

/** 名字归一化：小写 + 补 `.exe`（Windows 进程名带扩展名）。 */
export function normalizeNames(names) {
  const out = new Set()
  for (const n of names ?? []) {
    if (typeof n !== 'string') continue
    const s = n.trim().toLowerCase()
    if (s === '') continue
    out.add(s.endsWith('.exe') ? s : `${s}.exe`)
    out.add(s.replace(/\.exe$/, ''))
  }
  return [...out]
}

function sameNames(a, b) {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

function defaultExec(cmd, args, o) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: o?.timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { err.code = err.code ?? (err.killed ? 'ETIMEDOUT' : 'EEXEC'); reject(err); return }
      resolve({ stdout })
    })
  })
}

/** 由设置里的进程名 + 目录猜测，合成最终要探测的名字列表。 */
export function resolveProcessNames({ configured = [], dir = null } = {}) {
  const configuredList = (configured ?? []).filter((n) => typeof n === 'string' && n.trim() !== '')
  if (configuredList.length) return { names: configuredList, guessed: false, source: 'settings' }
  const g = guessProcessNames(dir)
  return { names: g, guessed: g.length > 0, source: g.length ? 'folder-name-guess' : 'none' }
}

export { join }
