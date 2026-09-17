// gameio/base.mjs —— 引擎 adapter 的公共契约与工具（零依赖）
//
// 职责边界（ARCHITECTURE §4）：gameio **只做翻译** ——
// 把「文件系统上发生了什么」翻译成 core/events.mjs 规定的事件形状。
// 它不认识 Electron，也不认识任何具体游戏；core/ 与 dialogue/ 不认识任何具体引擎。
//
// ═══════════════════════════════════════════════════════════════════
// ★ 核心设计：capability 不是「引擎属性」，而是「引擎 + 这一个具体游戏」的运行时事实
// ═══════════════════════════════════════════════════════════════════
// 反例最能说明问题：同为 Unity 游戏，
//   · 森林之子的 PlayerProfile.json 是明文 JSON，里面有 Stats.CoreGameCompleted ⇒ 读得到进度
//   · 致命公司的 LCGeneralSaveData 是高熵加密块                          ⇒ 只能知道"文件变了"
// 所以不能写死「unity 支持 progress」。正确做法是：
//   adapter 声明 capabilityBase（结构上**总能**拿到的类型，如 save / exit），
//   运行时再由 inferCapability() 根据**实测证据**（存档解出来了没、日志解析器真匹配到了什么）追加。
// 这样「读不出信息就别装作读得出」变成代码里可检查的事实，
// 时机引擎再据此封顶主动档位（core/presence.mjs 的 resolvePolicy）。

import { openSync, readSync, fstatSync, closeSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { capabilityOf } from '../core/presence.mjs'

// ---------- 文件读取（日志可能很大，绝不能整份读进来） ----------

/**
 * 只读文件尾部。**这是硬需求不是优化**：实测 Unity 日志单文件可达 6.2MB
 * （丝之歌 Player.log），No Rest for the Wicked 的崩溃转储单个 25MB。
 *
 * @param {string} path
 * @param {number} [maxBytes=262144]
 * @returns {{text:string, truncated:boolean, size:number}}
 */
export function readTail(path, maxBytes = 256 * 1024) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const start = size - len
    const buf = Buffer.alloc(len)
    if (len > 0) readSync(fd, buf, 0, len, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      // 从文件中间切进来，首行几乎必然是半截的，整行丢掉
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    return { text, truncated: start > 0, size }
  } finally {
    closeSync(fd)
  }
}

/** 只读文件头部（会话开始的标记在这里）。 */
export function readHead(path, maxBytes = 64 * 1024) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    if (len > 0) readSync(fd, buf, 0, len, 0)
    return { text: buf.toString('utf8'), truncated: size > len, size }
  } finally {
    closeSync(fd)
  }
}

/**
 * 读文件的 `[start, end)` 区间 —— 日志监视就是靠它做**增量读取**的：
 * 记住上次读到的字节偏移，下次只读新增部分。
 *
 * ⚠ 默认**原样返回**，不替调用方丢半截行。原因：调用方若把偏移记在**行边界**上，
 *   首行就是完整的，此时丢首行会把整条新增事件吃掉（这个坑真踩过）。
 *   只有从文件中间切进来时（如尾读）才该丢 —— 那时传 `{ dropPartialFirstLine: true }`。
 *
 * @param {string} path
 * @param {number} start - 起始字节偏移
 * @param {number} [maxBytes=262144]
 * @param {{dropPartialFirstLine?:boolean}} [opts]
 * @returns {{text:string, from:number, to:number, size:number, truncated:boolean, reset:boolean}}
 *   `reset` 为 true 表示文件比记录的偏移还短（日志被重写/轮转了），此时已从尾部重新读起
 */
export function readRange(path, start = 0, maxBytes = 256 * 1024, opts = {}) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const reset = start > size
    const from = reset ? Math.max(0, size - maxBytes) : Math.max(0, start)
    const len = Math.min(size - from, maxBytes)
    const buf = Buffer.alloc(Math.max(0, len))
    if (len > 0) readSync(fd, buf, 0, len, from)
    let text = buf.toString('utf8')
    if (opts.dropPartialFirstLine && from > 0) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    return { text, from, to: from + len, size, truncated: from + len < size, reset }
  } finally {
    closeSync(fd)
  }
}

// ---------- 扫描规则（这些规则是拿本机 158 个真实文件试出来的） ----------

/**
 * 明确不是存档、或体积无意义的目录。
 * 实测撞到的噪声：LocalLow 里混着显卡驱动的着色器缓存（AMD/ 下 8MB 二进制块）、
 * Unity 崩溃转储（*.framedump 单个 25MB）、游戏的 *.crc 校验文件。
 */
export const SKIP_DIR = /^(shader_cache|crashpad|Crashes|Cache|cache|Analytics|backtrace|vulkan|Temp|temp|desyncs|AMD|NVIDIA|Intel)$/i

/** 明确不是存档的文件。 */
export const SKIP_FILE = /(\.log$|\.dmp$|\.vdf$|\.cache$|\.crc$|\.framedump$|\.png$|\.jpg$|\.dll$|\.exe$|\.pdb$|\.bak\d*$|^desync|^Player(-prev)?\.log$|\.moddata$|\.txt$)/i

/** 存档候选判定。**只看名字与大小，不看扩展名语义** —— 实测扩展名会骗人。 */
export function isSaveCandidate(name, size) {
  if (!name || SKIP_FILE.test(name)) return false
  if (!Number.isFinite(size) || size < 64 || size > 64 * 1024 * 1024) return false
  return true
}

/**
 * 有界递归扫描。返回 `{ saves, logs, other }`（按大小降序）。
 * @param {string} dir
 * @param {{maxDepth?:number, limit?:number}} [opts]
 */
export function walkFiles(dir, opts = {}) {
  const maxDepth = opts.maxDepth ?? 3
  const limit = opts.limit ?? 400
  const saves = []
  const logs = []
  const other = []
  const walk = (d, depth) => {
    if (depth > maxDepth || saves.length >= limit) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return } // 权限问题不致命
    for (const e of entries) {
      if (saves.length >= limit) return
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p, depth + 1); continue }
      if (e.name === 'Player.log' || e.name === 'Player-prev.log' || e.name === 'output_log.txt') {
        const st = statSafe(p)
        if (st) logs.push({ path: p, name: e.name, size: st.size, mtimeMs: st.mtimeMs })
        continue
      }
      if (/\.log$/i.test(e.name)) {
        const st = statSafe(p)
        if (st) logs.push({ path: p, name: e.name, size: st.size, mtimeMs: st.mtimeMs })
        continue
      }
      const st = statSafe(p)
      if (!st || !st.isFile()) continue
      if (isSaveCandidate(e.name, st.size)) saves.push({ path: p, name: e.name, size: st.size, mtimeMs: st.mtimeMs })
      else if (!SKIP_FILE.test(e.name)) other.push({ path: p, name: e.name, size: st.size })
    }
  }
  walk(dir, 0)
  const bySize = (a, b) => b.size - a.size
  saves.sort(bySize); logs.sort(bySize); other.sort(bySize)
  return { saves, logs, other }
}

function statSafe(p) {
  try { return statSync(p) } catch { return null }
}

// ---------- adapter 契约 ----------

/**
 * adapter 对象必须提供的字段。`validateAdapter` 会逐条检查 ——
 * 契约写在这里而不是口头约定，因为 adapter 是要跨引擎重复实现的。
 *
 *   id             string   稳定标识，如 'unity'
 *   name           string   展示名
 *   capabilityBase string[] **结构上总能拿到**的触发类型（不许吹牛，见文件头）
 *   detect(dir)    → { score: 0..1, evidence: string[] }
 *   findLogs(dir)  → Array<{path,name,size,mtimeMs,kind}>
 *   findSaves(dir) → Array<{path,name,size,mtimeMs}>
 *   parseLogLine(line, ctx) → 事件片段 | null
 *   readSession(dir) → { startedAt, endedAt, cleanExit, version, playerName, notes[] }
 *   mapSaveChanges(changes, ctx) → 事件片段[]   （可选；没有就是"只能读出文件变了"）
 *
 *   normalizeSave(value) → { value, sparse }   （**可选，但很要紧** —— 见下）
 *
 * ★ 关于 `normalizeSave`：diff 得对不对，取决于 adapter 懂不懂数据的语义。
 *   RPG Maker 的 `$gameSwitches._data` 是**稀疏、下标有意义**的原始值数组，
 *   而 core/diff.mjs 对原始值数组走集合 diff（那是为 `triggered_stories` 那种列表设计的）。
 *   两者冲突会导致**两个开关朝相反方向翻转时互相抵消、静默丢事件**。
 *   所以这类引擎必须提供 normalizeSave，把"下标当键"的容器转成稀疏对象再交给 diff。
 *   这是 adapter 的职责，不是 core/diff.mjs 该去猜的事。
 */
export const ADAPTER_METHODS = Object.freeze(['detect', 'findLogs', 'findSaves'])

/** 校验一个 adapter 是否符合契约。返回问题列表（空数组 = 合规）。 */
export function validateAdapter(a) {
  const problems = []
  if (!a || typeof a !== 'object') return ['adapter 不是对象']
  if (!a.id || typeof a.id !== 'string') problems.push('缺少 id')
  if (!a.name || typeof a.name !== 'string') problems.push('缺少 name')
  if (!Array.isArray(a.capabilityBase)) problems.push('缺少 capabilityBase 数组')
  for (const m of ADAPTER_METHODS) {
    if (typeof a[m] !== 'function') problems.push(`缺少方法 ${m}()`)
  }
  if (a.mapSaveChanges !== undefined && typeof a.mapSaveChanges !== 'function') problems.push('mapSaveChanges 存在但不是函数')
  if (a.parseLogLine !== undefined && typeof a.parseLogLine !== 'function') problems.push('parseLogLine 存在但不是函数')
  return problems
}

/**
 * 让所有 adapter 对同一目录打分，按可能性降序返回。
 * 单个 adapter 抛异常不会拖垮整体（探错目录是常态）。
 */
export function detectEngine(dir, adapters, opts = {}) {
  const out = []
  for (const a of adapters ?? []) {
    let r
    try {
      r = a.detect(dir, opts)
    } catch (e) {
      r = { score: 0, evidence: [`detect 抛异常：${e.message}`] }
    }
    const score = Number(r?.score ?? 0)
    if (score > 0) out.push({ id: a.id, name: a.name, adapter: a, score, evidence: r.evidence ?? [] })
  }
  out.sort((x, y) => y.score - x.score || String(x.id).localeCompare(String(y.id)))
  return out
}

/**
 * ★ 由「adapter 自述 + 运行时实测证据」推出这一个游戏实际的可读能力。
 *
 * @param {object} adapter
 * @param {object} evidence
 * @param {boolean} [evidence.savesDecoded] 至少有一个存档被 core/decode.mjs 解出了结构
 * @param {string[]} [evidence.logKinds]    日志解析器在**真实数据**上真正匹配到的类型
 * @param {string[]} [evidence.notes]
 * @returns {{readable:string[], base:string[], reasons:string[], rich:boolean, beyondFiles:string[]}}
 */
export function inferCapability(adapter, evidence = {}) {
  const base = [...(adapter?.capabilityBase ?? [])]
  const readable = new Set(base)
  const reasons = []
  if (base.length) reasons.push(`adapter 声明结构上总能拿到：${base.join('、')}`)

  for (const k of evidence.logKinds ?? []) {
    if (readable.has(k)) continue
    readable.add(k)
    reasons.push(`日志解析器在真实数据上确实匹配到了 ${k}`)
  }

  if (evidence.savesDecoded) {
    for (const k of ['progress', 'item', 'area']) {
      if (!readable.has(k)) { readable.add(k); }
    }
    reasons.push('至少一个存档解出了结构 ⇒ 存档 diff 能读到进度 / 道具 / 区域')
  }

  for (const n of evidence.notes ?? []) reasons.push(n)
  // rich / beyondFiles 的判定交给 core/presence.mjs，保持单一事实来源
  return { ...capabilityOf([...readable]), base, reasons }
}

// ---------- 事件 → 时机引擎的触发 ----------

/**
 * ★ 把「adapter 认不出来的日志行」汇总出来，按出现次数降序。
 *
 * 为什么需要它：本项目的立场是「模型/代码不许编事实」，所以 adapter 只认它**确实认识**的行。
 * 但真实游戏常常用 `print()` / `Debug.Log()` 打出有用的东西 —— 实测那款 Godot 视觉小说的
 * `logs/godot.log` 里就有 `saved`、`check money happened`、裸数字这类游戏自己打的行。
 * 我们**不可能预先知道**某款游戏打了什么，所以正确做法不是硬猜，而是：
 *   把「没认出来的行」摆给用户看 → 用户写一条每游戏规则 → 立刻变成事件。
 *
 * 这个函数就是给配置界面用的那一步。
 *
 * @param {(line:string, opts:object)=>any} parseLine - adapter 的 parseLogLine
 * @param {string} text
 * @param {{minCount?:number, limit?:number, maxLen?:number}} [opts]
 * @returns {Array<{line:string, count:number}>}
 */
export function unmatchedLines(parseLine, text, opts = {}) {
  const minCount = opts.minCount ?? 1
  const limit = opts.limit ?? 50
  const maxLen = opts.maxLen ?? 200
  const counts = new Map()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.length > maxLen) continue
    let known = false
    try { known = parseLine(line) != null } catch { known = false }
    if (known) continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([line, count]) => ({ line, count }))
    .filter((x) => x.count >= minCount)
    .sort((a, b) => b.count - a.count || a.line.localeCompare(b.line))
    .slice(0, limit)
}

/**
 * 把 core/events.mjs 的事件转成 core/presence.mjs 的触发输入。
 * 两边的 `kind` 词表是对齐的（save / exit / crash / death / progress / …）——
 * 这是刻意设计：EVENT_KINDS 新增类别时就要求同时考虑它能否构成主动开口的触发。
 *
 * `significance` 默认取事件的 importance，于是 DEFAULT_IMPORTANCE 与
 * 时机引擎的 minSignificance 门槛共同决定了"什么不值得打扰"：
 * 例如 item 的默认重要度 0.3 < 保守档门槛 0.45 ⇒ **拿到个小道具不会来烦你**。
 *
 * @param {object} ev 规范化事件
 * @param {{at?:number, significance?:number}} [opts]
 * @returns {object|null} presence.step 的 trigger 输入；时间无法确定时返回 null
 */
export function triggerFromEvent(ev, opts = {}) {
  const at = opts.at ?? timeOf(ev?.at)
  if (!Number.isFinite(at)) return null
  return {
    type: 'trigger',
    at,
    kind: ev.kind,
    significance: opts.significance ?? ev.importance,
    summary: ev.text,
  }
}

/** 把事件时间转成毫秒数（ISO 字符串 / 秒 / 毫秒都能吃）。无法确定时返回 NaN。 */
export function timeOf(at) {
  if (at == null) return NaN
  if (typeof at === 'number') return Number.isFinite(at) ? at : NaN
  const n = Number(at)
  if (Number.isFinite(n)) return n
  const t = Date.parse(String(at))
  return Number.isFinite(t) ? t : NaN
}

// ---------- 存档 diff → 事件 ----------

/**
 * 调用 adapter 的 normalizeSave（没提供就是恒等）。
 * **必须在 diff 之前调用**，否则下标有意义的稀疏数组会被集合 diff 静默丢掉变化。
 *
 * @returns {{value:*, sparse:number, normalized:boolean}}
 */
export function applyNormalize(adapter, value) {
  const fn = adapter?.normalizeSave
  if (typeof fn !== 'function') return { value, sparse: 0, normalized: false }
  try {
    const r = fn(value)
    if (r && typeof r === 'object' && 'value' in r) {
      return { value: r.value, sparse: Number(r.sparse) || 0, normalized: true }
    }
    return { value: r ?? value, sparse: 0, normalized: true }
  } catch {
    // 归一化失败不该让整条链路挂掉：退回原值，行为与"没有 normalizeSave"一致
    return { value, sparse: 0, normalized: false }
  }
}

/**
 * 通用启发式：按路径名猜这次变化属于哪一类。
 *
 * ⚠ 这是**启发式**，不是解析器。它之所以值得存在，是因为实测发现：
 * 各游戏的存档字段名高度趋同（progress / quest / unlocked / achievement / level / area…），
 * 所以光看路径名就能捞回一部分真实进展 —— 例：森林之子的
 * `Stats.CoreGameCompleted`、`Stats.EscapedIsland` 会命中 unlocked/complete 一组。
 *
 * 命中不了就返回 null，**绝不硬猜**：没把握时只报「存档被写入」（见 ARCHITECTURE §3 原则 P2）。
 */
export const SAVE_SIGNAL_PATTERNS = Object.freeze([
  // ⚠ `stor(?:y|ies)` 不能简写成 `story` —— Godot 存档里的字段叫 `triggered_stories`（复数），
  //   写成单数会让**整整一类进度字段全都漏掉**，而且不会报错，只是静默地什么都不产出。
  { re: /progress|quest|chapter|stor(?:y|ies)|scenario|stage|act\d|milestone/i, kind: 'progress' },
  // 天数 / 周目 / 集数推进也是进度（实测一款 Unity 游戏的存档里就叫 dayCount）
  { re: /day_?count|days?|week|episode|ep\d|loop_?count/i, kind: 'progress' },
  { re: /unlock|achiev|trophy|clear|complete|defeat|slay|boss|ending/i, kind: 'progress' },
  // 点数 / 分数 / 等级数是进度（实测 hPoint / totalPoint / exp 都属这一族）
  // 注意 `\bexp\b` 而不是 `_exp`：后者要求前面有下划线，`$.exp` 这种就命不中。
  { re: /point|score|rank|grade|\bexp\b|experience|total_?lv|level_?up/i, kind: 'progress' },
  // 关系数值也是进度：视觉小说存档里的 `himemiya_route = 24` 这种就是主线推进量
  { re: /route|affection|favor|bond|trust|relation|intimacy|love_?point/i, kind: 'progress' },
  { re: /death|dead|died|game_?over|defeat_?count|retry|fail|loss/i, kind: 'death' },
  { re: /item|inventory|equip|weapon|armor|potion|material|currency|gold|coin|loot/i, kind: 'item' },
  { re: /area|map_?id|region|zone|room|dungeon|floor|world_?id|scene/i, kind: 'area' },
  { re: /save_?count|saves?count|playtime|play_?time|elapsed/i, kind: 'save' },
])

/** 路径上任意一段命中信号词 ⇒ 给出类别；否则 null。 */
export function classifyPath(path) {
  for (const p of SAVE_SIGNAL_PATTERNS) if (p.re.test(path)) return p.kind
  return null
}

/**
 * 把一组 diff 变化折成「人能读、桌宠能问」的事件。
 *
 * 折叠是必要的：Godot 存档里 `triggered_stories` 一次可能新增几十条，
 * 逐条产出事件会把时机引擎淹没（而且它们本就是同一件事）。
 * 所以**按数组根路径 + 类别分组**，一组出一条事件、附几个示例。
 *
 * @param {Array} changes - core/diff.mjs 的输出
 * @param {object} [opts]
 * @param {number} [opts.at]            事件时间
 * @param {number} [opts.maxEvents=20]
 * @param {string[]} [opts.onlyKinds]   只保留这些类别
 * @returns {object[]} 规范化的原始事件片段（未经 createEvent 也可直接用）
 */
export function genericSaveEvents(changes = [], opts = {}) {
  const maxEvents = opts.maxEvents ?? 20
  const only = opts.onlyKinds ? new Set(opts.onlyKinds) : null
  const groups = new Map()

  for (const c of changes) {
    // 集合型 added/removed 的路径指向数组本身，值才是内容 ⇒ 两类都要参与匹配
    const probe = `${c.path} ${c.value ?? c.after ?? ''}`
    const kind = classifyPath(probe)
    if (!kind) continue
    if (only && !only.has(kind)) continue

    const root = groupRoot(c.path)
    const key = `${kind}|${root}`
    let g = groups.get(key)
    if (!g) { g = { kind, path: root, count: 0, labels: [] }; groups.set(key, g) }
    g.count++
    if (g.labels.length < 5) {
      const label = labelOf(c)
      if (label && !g.labels.includes(label)) g.labels.push(label)
    }
  }

  return [...groups.values()].slice(0, maxEvents).map((g) => ({
    at: opts.at ?? null,
    kind: g.kind,
    text: `${g.path}：${g.labels.join('、')}${g.count > g.labels.length ? ` 等 ${g.count} 项变化` : ''}`,
    data: { path: g.path, count: g.count, labels: g.labels, source: 'save-diff' },
  }))
}

/**
 * 分组键。
 *
 * 规则：**包含 `[` 就砍到最后一个 `[` 之前，否则保留整条路径。**
 *   `$.items[id=sword].count` → `$.items`        （同一批数组元素的变化折成一条）
 *   `$.triggered_stories`     → `$.triggered_stories`（没有下标 ⇒ 是独立字段，不能并）
 *   `$.player.level`          → `$.player.level` （同上）
 *
 * 一开始我写的是「一律去掉末尾一段」，结果所有顶层字段都被并成 `$`，
 * `$.current_scene` 和 `$.triggered_stories` 会糊成一件事 —— 测试直接抓出来了。
 */
function groupRoot(path) {
  const s = String(path)
  const i = s.lastIndexOf('[')
  return i > 0 ? s.slice(0, i) : s
}

function labelOf(c) {
  if (c.kind === 'added') {
    const v = c.value !== undefined ? c.value : c.after
    return trunc(v)
  }
  if (c.kind === 'removed') return `失去 ${trunc(c.before)}`
  return `${trunc(c.before)}→${trunc(c.after)}`
}

function trunc(v) {
  if (v === null) return 'null'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40)
  return String(v).slice(0, 40)
}

/** 汇总一次探测的结论，给界面/日志用。 */
export function describeDetection(results) {
  if (!results || results.length === 0) return '没有匹配到已知引擎'
  const top = results[0]
  const rest = results.slice(1).filter((r) => r.score >= 0.3)
  const lines = [`最可能是 ${top.name}（${top.id}，置信度 ${top.score.toFixed(2)}）`]
  for (const ev of top.evidence) lines.push(`  · ${ev}`)
  if (rest.length) lines.push(`其它候选：${rest.map((r) => `${r.id}(${r.score.toFixed(2)})`).join('、')}`)
  return lines.join('\n')
}

export { basename }
