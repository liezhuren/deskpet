// gameio/unity.mjs —— Unity 2D 引擎 adapter
//
// ═══════════════════════════════════════════════════════════════════
// 这个 adapter 的诚实结论（全部来自本机 50 个真实游戏目录的实测）
// ═══════════════════════════════════════════════════════════════════
// ① `Player.log` **一定存在**（8 款游戏实测无一例外），但**内容基本是引擎噪声**：
//    丝之歌那个 6,226,118 字节 / 129,392 行的文件，绝大部分是重复的
//    `Couldn't find a Game Manager`。**"从日志读 Boss 名字"这种设计不成立。**
// ② 它能可靠给出的只有**会话边界**，以及少数几条环境信息：
//      头部 `Initialize engine version: 2020.2.2f1`   → 引擎版本
//      `Steam logged in as <玩家名>`                  → 玩家名（是上下文，不是事件）
//      `Loaded saved language code 'ZH'`              → 语言
//      尾部 `Input System module state changed to: Shutdown` 等 → 这次是不是正常退出
// ③ 存档格式跨游戏天差地别（实测：明文 JSON / .NET BinaryFormatter / 加密块 / zip），
//    所以 `capabilityBase` **只敢声明 save 与 exit**。
//    存档能不能读出进度，由 inferCapability() 根据**解密结果**在运行时决定。
//
// 结论：Unity 游戏默认落在保守档（这正是用户要的 —— 「读不出信息就只给保守选项」），
// 除非它的存档恰好是明文可解的（本机 33 个 JSON 存档里就有不少 Unity 的）。

import { existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { walkFiles, readTail, readHead, genericSaveEvents, timeOf } from './base.mjs'

export const id = 'unity'
export const name = 'Unity 2D'

/**
 * 只声明**结构上总能拿到**的类型。
 * 不写 death / progress —— 那些 Unity 的日志给不了，写上去就等于骗时机引擎去提高档位。
 */
export const capabilityBase = Object.freeze(['save', 'exit'])

/** Unity 日志里已知的噪声。先过滤掉，否则事件流会被上万行重复噪声淹没。 */
const NOISE = [
  /^Mono path\[/i, /^Mono config path/i, /^\[Subsystems\]/i, /^GfxDevice:/i,
  /^\s*(Version|Renderer|Vendor|VRAM|Driver):/i, /^Direct3D:/i, /^Begin MonoManager/i,
  /^- Completed reload/i, /^OnLevelWasLoaded/i, /^This message has been deprecated/i,
  /^Add a delegate to SceneManager/i, /^D3D11 device created/i, /^<RI>/i,
  /^UnloadTime:/i, /^Unloading \d+ Unused/i, /^The class named .* is abstract/i,
  /^Graphics tier changed/i, /^Discovered supported languages/i, /^Selected online subsystem/i,
  /^Steam initializing$/i, /^Fallback handler could not load/i, /^Setting up \d+ worker threads/i,
  /Couldn't find a Game Manager/i, /^Shader /i, /^WARNING: Shader/i, /^d3d11: /i,
  /^ScreenManager /i, /^Setting up 1 worker threads/i, /^Loading player data/i,
  /^Local user /i, /^Input System polling thread/i,
  // ⚠ 这里刻意**不放** `^\[Physics::Module\]` 与 `^Input System module state changed`：
  //   它们既是噪声也是收尾标记。写成两条规则重叠过一次，噪声表把收尾标记吃掉了，
  //   结果是"正常退出"永远识别不出来。现在靠「先判标记、后过滤噪声」的顺序来区分。
]

/** 会话收尾标记。**注意 `backned` 是 Unity/游戏自己的拼写错误，实测原文如此**，别"顺手改对"。 */
const SHUTDOWN_MARKERS = [
  /Input System module state changed to: Shutdown/i,
  /\[Physics::Module\] Cleanup current backned/i,
  /\[Physics::Module\] Cleanup current backend/i,
  /Input System polling thread exited/i,
]

/** 崩溃迹象。 */
const CRASH_MARKERS = [
  /Crash!!!/i, /Receiving unhandled NULL exception/i, /^Fatal error/i,
  /NullReferenceException/i, /StackOverflowException/i, /OutOfMemoryException/i,
  /A crash has been intercepted by the crash handler/i,
]

/**
 * 判断一个目录像不像 Unity 游戏。
 *
 * 实测的目录形状有两种，**两种都要支持**：
 *   LocalLow\<公司>\<产品>\      （绝大多数，如 Team Cherry\Hollow Knight）
 *   LocalLow\<公司>\             （HyperGryph 的 Player.log 就直接躺在公司目录下）
 * 所以 detect 走有界递归找 Player.log，而不是只看顶层。
 */
export function detect(dir) {
  const evidence = []
  let score = 0

  const { logs, saves } = walkFiles(dir, { maxDepth: 2, limit: 60 })
  const hasPlayerLog = logs.some((l) => /^Player(-prev)?\.log$/i.test(l.name))
  const hasOutputLog = logs.some((l) => /^output_log\.txt$/i.test(l.name))

  if (hasPlayerLog) { score += 0.85; evidence.push('找到 Player.log / Player-prev.log（Unity 独有）') }
  else if (hasOutputLog) { score += 0.7; evidence.push('找到 output_log.txt（旧版 Unity 的日志名）') }

  if (existsSync(join(dir, 'Unity'))) { score += 0.1; evidence.push('存在 Unity/ 目录（分析数据落点）') }
  if (saves.some((s) => /steam_autocloud\.vdf$/i.test(s.name))) { score += 0.05; evidence.push('存在 steam_autocloud.vdf') }

  // 反向证据：明显是别的引擎就压下去，免得抢答
  if (saves.some((s) => /\.(rpgsave|rmmzsave|rvdata2|rxdata)$/i.test(s.name))) {
    score -= 0.8; evidence.push('发现 RPG Maker 存档 ⇒ 扣分')
  }
  if (logs.some((l) => /godot/i.test(l.name)) || existsSync(join(dir, 'logs', 'godot.log'))) {
    score -= 0.9; evidence.push('发现 godot.log ⇒ 扣分')
  }

  return { score: Math.max(0, Math.min(1, score)), evidence }
}

/** 日志文件（含玩家自己指定的额外日志路径由上层配置补进来）。 */
export function findLogs(dir) {
  return walkFiles(dir, { maxDepth: 2, limit: 80 }).logs
    .filter((l) => !/launcher\.log|patch\.log|updater\.log/i.test(l.name))
    .map((l) => ({
      ...l,
      kind: /^Player(-prev)?\.log$/i.test(l.name) ? 'player-log'
        : /^output_log\.txt$/i.test(l.name) ? 'output-log' : 'other-log',
    }))
}

/** 存档候选。排序让最可能含内容的排在前面（体积适中的优先，超大文件多半是缓存）。 */
export function findSaves(dir) {
  const { saves } = walkFiles(dir, { maxDepth: 3, limit: 200 })
  return saves
    .filter((s) => !/steam_autocloud/i.test(s.name))
    .map((s) => ({ ...s, kind: 'save' }))
}

/**
 * 读一次会话信息。**注意 `cleanExit` 可能是 null**：
 * 日志没走到收尾标记，既可能是崩溃，也可能只是**游戏此刻还在运行**。
 * 必须由调用方结合进程探测来区分 —— 这个 adapter 不替它猜。
 *
 * @returns {{startedAt:number|null, endedAt:number|null, cleanExit:boolean|null, version:string|null, playerName:string|null, language:string|null, notes:string[]}}
 */
export function readSession(dir) {
  const notes = []
  const out = { startedAt: null, endedAt: null, cleanExit: null, version: null, playerName: null, language: null, notes }
  const logs = findLogs(dir).filter((l) => l.kind === 'player-log' || l.kind === 'output-log')
  if (logs.length === 0) { notes.push('没有找到 Unity 日志'); return out }

  // 当前这次会话 = 最新写入的那个日志
  const cur = [...logs].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))[0]
  out.endedAt = cur.mtimeMs ?? null
  notes.push(`读日志 ${cur.name}（${cur.size} 字节）`)

  try {
    const head = readHead(cur.path).text
    const v = head.match(/Initialize engine version:\s*(\S+)/)
    if (v) { out.version = v[1]; notes.push(`引擎版本 ${v[1]}`) }
    const pn = head.match(/Steam logged in as\s+(.+?)\s*$/m)
    if (pn) { out.playerName = pn[1].trim() }
    const lang = head.match(/Loaded saved language code '([^']+)'/)
    if (lang) out.language = lang[1]
  } catch (e) {
    notes.push(`读日志头失败：${e.code ?? e.message}`)
  }

  try {
    const tail = readTail(cur.path).text
    const sawShutdown = SHUTDOWN_MARKERS.some((re) => re.test(tail))
    const crashed = CRASH_MARKERS.some((re) => re.test(tail))
    if (sawShutdown) { out.cleanExit = true; notes.push('日志尾部有正常收尾标记 ⇒ 本次是正常退出') }
    else if (crashed) { out.cleanExit = false; notes.push('日志尾部有崩溃迹象 ⇒ 本次是异常退出') }
    else { out.cleanExit = null; notes.push('日志尾部没有收尾标记：可能崩溃，也可能游戏还在运行（需结合进程探测）') }
  } catch (e) {
    notes.push(`读日志尾失败：${e.code ?? e.message}`)
  }
  return out
}

/**
 * 逐行解析日志。**只认引擎自己保证会打的行**，外加调用方通过 `ctx.patterns`
 * 传进来的**每游戏自定义规则** —— 那是应对"某些开发者恰好打了有用日志"的唯一诚实做法：
 * 我们不可能预先知道某款游戏打了什么，但可以让用户配。
 *
 * @param {string} line
 * @param {{patterns?: Array<{re:RegExp|string, kind:string, label?:string}>, ctx?:object}} [opts]
 * @returns {{kind:string, text:string, data:object}|null}
 */
export function parseLogLine(line, opts = {}) {
  const s = String(line ?? '').trim()
  if (s === '') return null

  // 自定义规则优先（用户比我们清楚这款游戏打了什么）
  for (const p of opts.patterns ?? []) {
    const re = p.re instanceof RegExp ? p.re : new RegExp(String(p.re), 'i')
    if (re.test(s)) {
      return { kind: p.kind ?? 'system', text: p.label ? `${p.label}：${s}` : s, data: { source: 'log', pattern: String(p.re) } }
    }
  }

  // ★ 顺序很重要：**先判有意义的标记，再过滤噪声**。
  //   反过来的话，噪声表里任何一条与标记重叠的规则都会把标记悄悄吃掉
  //   （这正是最初 fail 的原因：`[Physics::Module]` 同时出现在两张表里）。
  if (SHUTDOWN_MARKERS.some((re) => re.test(s))) {
    return { kind: 'exit', text: '游戏会话结束（正常退出）', data: { source: 'log', raw: s } }
  }
  if (CRASH_MARKERS.some((re) => re.test(s))) {
    return { kind: 'crash', text: `疑似异常：${s.slice(0, 120)}`, data: { source: 'log', raw: s } }
  }
  const init = s.match(/Initialize engine version:\s*(\S+)/)
  if (init) {
    return { kind: 'system', text: `游戏启动（引擎 ${init[1]}）`, data: { source: 'log', version: init[1] } }
  }

  if (NOISE.some((re) => re.test(s))) return null

  // 剩下的一律不认。**这是有意的**：Unity 日志的其余内容实测就是噪声，
  // 硬凑事件只会让桌宠拿噪声去搭话（违反「只报事实」）。
  return null
}

/** 一次日志文件的整批解析。 */
export function parseLog(text, opts = {}) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const e = parseLogLine(line, opts)
    if (e) out.push({ ...e, at: opts.at ?? null })
  }
  return out
}

/**
 * 存档 diff → 事件。
 * Unity 没有通用字段约定，所以走公共启发式；调用方可用 `ctx.saveRules` 覆盖成每游戏规则。
 */
export function mapSaveChanges(changes, ctx = {}) {
  const out = []
  for (const rule of ctx.saveRules ?? []) {
    const re = rule.re instanceof RegExp ? rule.re : new RegExp(String(rule.re), 'i')
    for (const c of changes ?? []) {
      if (!re.test(c.path)) continue
      out.push({
        at: ctx.at ?? null,
        kind: rule.kind ?? 'progress',
        text: rule.text ? String(rule.text).replace('{path}', c.path) : `${c.path} 发生变化`,
        data: { source: 'save-rule', path: c.path },
      })
    }
  }
  if (out.length > 0) return out
  return genericSaveEvents(changes, { at: ctx.at, maxEvents: ctx.maxEvents })
}

/** 会话信息 → 事件（正常退出 / 异常退出）。 */
export function sessionEvents(session, { at, gameRunning } = {}) {
  const out = []
  const t = at ?? session?.endedAt ?? null
  if (session?.cleanExit === true) {
    out.push({ at: t, kind: 'exit', text: '游戏已退出', data: { source: 'session' } })
  } else if (session?.cleanExit === false) {
    out.push({ at: t, kind: 'crash', text: '游戏上次是异常结束的', data: { source: 'session' } })
  } else if (session?.cleanExit === null && gameRunning === false && session?.endedAt) {
    // 日志没有收尾标记、而进程又不在了 ⇒ 可以判定为异常结束（这才是"结合进程探测"的意思）
    out.push({ at: t, kind: 'crash', text: '游戏不是正常退出的', data: { source: 'session', inferred: true } })
  }
  return out
}

export default {
  id, name, capabilityBase,
  detect, findLogs, findSaves, readSession,
  parseLogLine, parseLog, mapSaveChanges, sessionEvents,
  helpers: { basename, timeOf, statSync },
}
