// gameio/godot.mjs —— Godot 3/4 引擎 adapter
//
// ═══════════════════════════════════════════════════════════════════
// 为什么 Godot 是三种引擎里**最能读出真内容**的（全部来自本机真实目录实测）
// ═══════════════════════════════════════════════════════════════════
// 实测目录：`%APPDATA%\Godot\app_userdata\30 Days in the Workplace\`
//   savegame0.tres        3,236B  **纯文本**，逐字段可读（见下）
//   settings.ini            671B  ConfigFile，纯文本
//   logs/godot.log       31,677B  有货：会泄漏场景名与角色名
//   dialogic/saves/*.txt          Dialogic 插件的存档
//   shader_cache/ vulkan/         纯噪声
//
// `savegame0.tres` 里有（真实字段）：
//   slot_info_saved_day = "2025-05-01"        ← 现实时间的存档点
//   current_scene = "Home"                    ← 玩家在哪个场景
//   current_day = 21 / current_weekday / current_time
//   triggered_stories = Array[String]([...43 条...])  ← **新增项 = 这局推进了什么**
//   himemiya_route = 24                       ← 角色关系数值
//   item_wallet = true                        ← 道具布尔量
//
// `logs/godot.log` 里的 `USER ERROR: Node not found: "../../NPC_AoKawa"
// (relative to "/root/Home/TimePanel/PhoneMenu")` 会泄漏：
//   · `/root/Home/...` ⇒ 玩家**当前在哪个场景**（Home / Office 来回切）
//   · `NPC_AoKawa` / `Char_Himemiya` ⇒ 该场景里有哪些角色
// 这是实测撞到的、意外有用的信号 —— 但它依赖"游戏恰好报了这类错"，所以是**加分项不是保证**。
//
// ⚠ 时间戳问题（诚实说明）：Godot 的日志行**没有时间戳**。
//   所以事件时间只能取「我们观察到这一行的时刻」，而不是游戏内部的时刻。
//   这也是为什么本 adapter 的 parseLog 需要调用方传 at。

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles, readTail, readHead, genericSaveEvents, SKIP_DIR } from './base.mjs'

export const id = 'godot'
export const name = 'Godot'

/**
 * Godot 没有"一定会打"的收尾标记，日志也常被游戏自己的 print 淹没，
 * 所以只声明文件系统层面能拿到的两类。
 * （注意：**没有**把 `area` 写进来 —— 场景名是撞运气撞到的，不是保证。
 *  真读到了会由 inferCapability 的证据链加进去。）
 */
export const capabilityBase = Object.freeze(['save', 'exit'])

/** 已知噪声。Godot 的 Vulkan/驱动信息、以及 shader 编译日志量很大。 */
const NOISE = [
  /^Vulkan API /i,
  /^OpenGL API /i,
  /^Using Vulkan Device #/i,
  /^  at: /,                                // 错误堆栈的续行
  /^--- Debug adapter server started/i,
  /^--- GDScript language server started/i,
  /^TextServer: /i,
  /^drivers\/vulkan/i,
  /^Vulkan: /i,
  // 注意：**不放** `^Godot Engine v` —— 那一行是有用的（引擎版本），
  // 由 parseLogLine 里专门的规则先接住。噪声表里再放一条只会是死规则、徒增误解。
]

/** Godot 的错误级别前缀。`USER ERROR:` 是 gameplay 脚本自己报的，最可能有语义。 */
const LEVEL_RE = /^(USER ERROR|USER WARNING|SCRIPT ERROR|ERROR|WARNING|USER SCRIPT ERROR):\s*(.*)$/

export function detect(dir) {
  const evidence = []
  let score = 0

  const hasGodotLog = existsSync(join(dir, 'logs', 'godot.log'))
  if (hasGodotLog) { score += 0.9; evidence.push('找到 logs/godot.log（Godot 的 user:// 日志落点）') }

  // shader_cache/ 与 vulkan/pipelines.*.cache 是 Godot 特有的目录形状
  if (existsSync(join(dir, 'shader_cache'))) { score += 0.15; evidence.push('存在 shader_cache/（Godot 特有）') }
  if (existsSync(join(dir, 'vulkan'))) { score += 0.1; evidence.push('存在 vulkan/（Godot 特有）') }

  const { saves, logs } = walkFiles(dir, { maxDepth: 2, limit: 60 })
  if (saves.some((s) => /\.(tres|tscn|godot)$/i.test(s.name))) {
    score += 0.2
    evidence.push('存在 .tres / .tscn 资源文件（Godot 的文本资源格式）')
  }

  // 反向证据
  if (logs.some((l) => /^Player(-prev)?\.log$/i.test(l.name))) { score -= 0.8; evidence.push('发现 Player.log ⇒ 更像 Unity，扣分') }
  if (saves.some((s) => /\.(rpgsave|rmmzsave|rvdata2|rxdata)$/i.test(s.name))) { score -= 0.7; evidence.push('发现 RPG Maker 存档 ⇒ 扣分') }

  return { score: Math.max(0, Math.min(1, score)), evidence }
}

export function findLogs(dir) {
  const out = []
  const p = join(dir, 'logs', 'godot.log')
  if (existsSync(p)) {
    const st = statOf(p)
    if (st) out.push({ path: p, name: 'godot.log', size: st.size, mtimeMs: st.mtimeMs, kind: 'godot-log' })
  }
  // 有些项目会自己再写一份日志
  for (const l of walkFiles(dir, { maxDepth: 2, limit: 40 }).logs) {
    if (l.name === 'godot.log') continue
    out.push({ ...l, kind: 'other-log' })
  }
  return out
}

/**
 * 存档候选。
 *
 * ⚠ 刻意**不**套用全局的"排除 .txt"规则：Dialogic（视觉小说常用插件）的存档就是
 * `dialogic/saves/*.txt`。排除它会让一整类游戏读不出东西。
 */
export function findSaves(dir) {
  const { saves } = walkFiles(dir, { maxDepth: 4, limit: 200 })
  const out = saves.map((s) => ({ ...s, kind: s.name.endsWith('.tres') ? 'resource' : 'save' }))

  // Dialogic 的存档是 .txt / .json，落在 dialogic/saves/ 下
  const dialogicDir = join(dir, 'dialogic')
  if (existsSync(dialogicDir)) {
    const d = walkFiles(dialogicDir, { maxDepth: 3, limit: 60 })
    for (const t of [...d.saves, ...d.other]) {
      if (/\.(txt|json)$/i.test(t.name)) out.push({ ...t, kind: 'dialogic-save' })
    }
  }

  const seen = new Set()
  return out
    .filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)))
    .sort((a, b) => b.size - a.size)
}

/**
 * Godot 日志没有收尾标记，所以 `cleanExit` 通常是 null。
 * 能确定的是引擎版本（启动行）与文件写入时间。
 */
export function readSession(dir) {
  const notes = []
  const out = { startedAt: null, endedAt: null, cleanExit: null, version: null, playerName: null, language: null, notes }
  const logs = findLogs(dir)
  if (logs.length === 0) { notes.push('没有找到 Godot 日志'); return out }

  const cur = logs[0]
  out.endedAt = cur.mtimeMs ?? null
  try {
    const head = readHead(cur.path).text
    const v = head.match(/Godot Engine v([\w.\-]+)/)
    if (v) { out.version = v[1]; notes.push(`引擎版本 ${v[1]}`) }
  } catch (e) { notes.push(`读日志头失败：${e.code ?? e.message}`) }

  try {
    const tail = readTail(cur.path).text
    if (/SCRIPT ERROR|USER ERROR/.test(tail)) notes.push('日志尾部有脚本错误（游戏内的，不代表崩溃）')
    // Godot 正常退出不会打收尾标记 ⇒ 只能说"不确定"
    notes.push('Godot 不输出收尾标记，cleanExit 只能靠进程探测判定')
  } catch (e) { notes.push(`读日志尾失败：${e.code ?? e.message}`) }
  return out
}

/**
 * 逐行解析。返回 `{kind, text, data}` 或 null。
 *
 * 会识别（按可靠性排序）：
 *   1. 调用方通过 `ctx.patterns` 配的每游戏规则（最可靠 —— 用户知道这游戏打了什么）
 *   2. `USER ERROR: Node not found: "..." (relative to "/root/<场景>/...")`
 *      ⇒ **area 事件**，场景名就是 `/root/` 之后的第一段
 *   3. 引擎启动行 ⇒ system
 *
 * 注意 Godot 会把同一条错误重复打上万次（实测那个 31KB 日志绝大多数是重复行），
 * 所以 `parseLog` 默认做**同内容去重**，否则事件流会被淹掉。
 */
export function parseLogLine(line, opts = {}) {
  const s = String(line ?? '').trim()
  if (s === '') return null

  for (const p of opts.patterns ?? []) {
    const re = p.re instanceof RegExp ? p.re : new RegExp(String(p.re), 'i')
    if (re.test(s)) {
      return { kind: p.kind ?? 'system', text: p.label ? `${p.label}：${s}` : s, data: { source: 'log', pattern: String(p.re) } }
    }
  }

  // ① 场景泄漏：`(relative to "/root/Home/TimePanel/PhoneMenu")`
  const rel = s.match(/relative to "(\/root\/[^"]*)"/)
  if (rel) {
    const seg = rel[1].split('/').filter(Boolean) // ['root','Home','TimePanel','PhoneMenu']
    const scene = seg[1] ?? null
    if (scene) {
      return {
        kind: 'area',
        text: `进入场景 ${scene}`,
        data: { source: 'log', scene, node: rel[1] },
      }
    }
  }

  const v = s.match(/^Godot Engine v([\w.\-]+)/)
  if (v) return { kind: 'system', text: `游戏启动（Godot ${v[1]}）`, data: { source: 'log', version: v[1] } }

  const lv = s.match(LEVEL_RE)
  if (lv) {
    // 剩下的错误行没有稳定语义，**不猜**。只把 "SCRIPT ERROR" 当成可能有意义的信号，
    // 但也只产出 system 级别，免得把引擎内部的报错说成游戏事件。
    if (lv[1].startsWith('SCRIPT')) {
      return { kind: 'system', text: `脚本报错：${lv[2].slice(0, 120)}`, data: { source: 'log', level: lv[1] } }
    }
    return null
  }

  if (NOISE.some((re) => re.test(s))) return null
  return null
}

/**
 * 批量解析，**默认对同内容去重**（Godot 会重复打同一条错误上万次）。
 * `at` 由调用方给 —— Godot 日志行本身没有时间戳。
 */
export function parseLog(text, opts = {}) {
  const out = []
  const seen = opts.seen ?? new Set()
  const dedup = opts.dedup !== false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const e = parseLogLine(line, opts)
    if (!e) continue
    // area 事件按场景名去重（同一个场景反复进出，短时间内只报一次）
    const key = e.kind === 'area' ? `area:${e.data.scene}` : `${e.kind}|${e.text}`
    if (dedup && seen.has(key)) continue
    seen.add(key)
    out.push({ ...e, at: opts.at ?? null })
  }
  return out
}

/** 存档 diff → 事件。Godot 的字段名很规整，通用启发式命中率不错。 */
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

export function sessionEvents() {
  // Godot 没有收尾标记，正常/异常退出全部交给进程探测 + 文件监视，
  // 这里只保留接口形状，不假装能判定。
  return []
}

function statOf(p) {
  try { return statSync(p) } catch { return null }
}

export default {
  id, name, capabilityBase,
  detect, findLogs, findSaves, readSession,
  parseLogLine, parseLog, mapSaveChanges, sessionEvents,
  noise: NOISE, skipDir: SKIP_DIR,
}
