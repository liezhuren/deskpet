// gameio/rpgmaker.mjs —— RPG Maker MV / MZ（VX Ace / XP 只做识别，不做解析）
//
// ═══════════════════════════════════════════════════════════════════
// ★ 为什么这个 adapter 必须提供 normalizeSave()（本文件最要紧的一处）
// ═══════════════════════════════════════════════════════════════════
// MV/MZ 的存档解出来是 `DataManager.makeSaveContents()` 的结果，其中：
//     $gameSwitches._data  = [null, true, false, null, true, ...]
//     $gameVariables._data = [null, 0, 5, 0, 12, ...]
//     $gameParty._items    = [[1, 3], [7, 1], ...]
// 这些都是**稀疏、下标有意义**的原始值数组 —— 下标就是开关/变量 id。
//
// 而 core/diff.mjs 对原始值数组走的是**集合 diff**（那是为了 `triggered_stories`
// 那种"列表"设计的）。两者冲突，后果很严重：
//     开关 3 从 false 变 true、开关 4 从 true 变 false
//   → 集合里 `true` 少了一个又多了一个，**互相抵消，diff 报"什么都没变"**
// 这不是精度问题，是**静默丢事件**。
//
// 解法：adapter 负责把这类容器转成"下标当键"的稀疏对象再交给 diff：
//     _data: [null, true, false]  →  { "1": true, "2": false }
// 于是每个开关都是独立路径（`$.switches._data.3`），翻转变动再也不会互相掩盖。
//
// 这也是一个通用教训：**能不能 diff 得对，取决于 engine adapter 懂不懂数据的语义**，
// 所以 normalizeSave 属于 adapter 的职责，而不是 core/diff.mjs 该去猜的事。
//
// ═══════════════════════════════════════════════════════════════════
// 其他实测/文档事实
// ═══════════════════════════════════════════════════════════════════
// · `file1.rpgsave` / `file1.rmmzsave` = `LZString.compressToBase64(JSON.stringify(contents))`
//   （见 Gteditor99/rpgsave-decode 的 main.go：decompress 用 lzstring，且它读的就是这种文件）
// · MV/MZ 桌面版把存档写在可执行文件旁的 `save/`（`www/save/`）
// · **RPG Maker 默认没有日志文件** —— 所以它的通道只有存档
// · 开关/变量的 id 是**不透明的**，名字在游戏本体的 `data/System.json` 里
//   （`switches: ["", "名字", ...]`）。所以本 adapter 支持传入 System.json 来把 id 变成名字。

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { walkFiles } from './base.mjs'

export const id = 'rpgmaker'
export const name = 'RPG Maker MV/MZ'

/**
 * 只声明文件系统层面的两类。
 * MV/MZ 的存档**总是**能解开（LZString+JSON 是引擎固定格式），但 VX Ace/XP 用的是
 * Ruby Marshal（`.rvdata2` / `.rxdata`），本工具**不支持** ——
 * 所以不能把 progress/item/area 写进 capabilityBase，只能等 inferCapability 按实际解码结果升。
 */
export const capabilityBase = Object.freeze(['save', 'exit'])

/** 各代 RPG Maker 的存档扩展名。前三代能解析，后两代只能识别。 */
const SAVE_EXT = /\.(rpgsave|rmmzsave|rvdata2|rxdata)$/i
const DECODABLE_EXT = /\.(rpgsave|rmmzsave)$/i

/** 全局存档文件（不是"第 N 号存档"），单独标一下便于界面区分。 */
const GLOBAL_NAMES = /^(global|config)\./i

export function detect(dir) {
  const evidence = []
  let score = 0
  const { saves, logs } = walkFiles(dir, { maxDepth: 4, limit: 200 })

  const rm = saves.filter((s) => SAVE_EXT.test(s.name))
  if (rm.length > 0) {
    score += 0.9
    evidence.push(`找到 ${rm.length} 个 RPG Maker 存档（${[...new Set(rm.map((s) => s.name.replace(/^.*(\.[^.]+)$/, '$1')))].join('、')}）`)
  }
  if (existsSync(join(dir, 'save'))) { score += 0.08; evidence.push('存在 save/ 目录') }
  if (existsSync(join(dir, 'www', 'save'))) { score += 0.12; evidence.push('存在 www/save/（MV 的落点）') }
  if (existsSync(join(dir, 'www', 'data', 'System.json'))) { score += 0.2; evidence.push('存在 www/data/System.json（MV 游戏本体）') }
  if (existsSync(join(dir, 'data', 'System.json'))) { score += 0.2; evidence.push('存在 data/System.json（MZ 游戏本体）') }

  if (logs.some((l) => /^Player(-prev)?\.log$/i.test(l.name))) { score -= 0.8; evidence.push('发现 Player.log ⇒ 更像 Unity，扣分') }
  if (existsSync(join(dir, 'logs', 'godot.log'))) { score -= 0.9; evidence.push('发现 godot.log ⇒ 扣分') }

  return { score: Math.max(0, Math.min(1, score)), evidence }
}

export function findSaves(dir) {
  const { saves } = walkFiles(dir, { maxDepth: 4, limit: 300 })
  return saves
    .filter((s) => SAVE_EXT.test(s.name))
    .map((s) => ({
      ...s,
      kind: GLOBAL_NAMES.test(s.name) ? 'rm-global' : 'rm-slot',
      decodable: DECODABLE_EXT.test(s.name),
      /** 第几号存档（global/config 为 null） */
      slot: slotOf(s.name),
    }))
    .sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999))
}

/**
 * RPG Maker 没有引擎级日志文件，所以这里只顺带捞一下游戏自己/插件写的日志。
 * **不假装有日志通道** —— 这是这个 adapter 与 Unity/Godot 最大的区别。
 */
export function findLogs(dir) {
  return walkFiles(dir, { maxDepth: 3, limit: 40 }).logs.map((l) => ({ ...l, kind: 'other-log' }))
}

export function readSession(dir) {
  return {
    startedAt: null, endedAt: null, cleanExit: null,
    version: null, playerName: null, language: null,
    notes: ['RPG Maker 默认不写日志文件，本次会话的边界只能靠进程探测与存档写入时间推断'],
  }
}

/**
 * RPG Maker 不产生日志 ⇒ 只有调用方配的每游戏规则可能命中。
 * 保持接口形状一致，但不编造默认规则。
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
  return null
}

export function parseLog(text, opts = {}) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const e = parseLogLine(line, opts)
    if (e) out.push({ ...e, at: opts.at ?? null })
  }
  return out
}

// ---------- ★ diff 前的形状归一化 ----------

/**
 * 把 MV/MZ 存档里"下标有意义"的容器转成可正确 diff 的形状。
 *
 *   switches._data  [null, true, false]        → { "1": true, "2": false }   （null / false 略去 false? 不 —— 见下）
 *   variables._data [null, 0, 5]               → { "2": 5 }                  （0 视作未用，略去）
 *   party._items    [[1,3],[7,1]]              → { "1": 3, "7": 1 }
 *   selfSwitches    { "1,2,A": true }          → 原样（本来就是键值对）
 *
 * 保留策略：
 *   · 开关只保留 **true**（false 是默认值，全都留会产出几万个键，把 save 撑爆且毫无信息量）
 *   · 变量只保留 **非 0**（同上，0 是 MV 的默认值）
 *   · 道具保留 count > 0 的
 * 这样"从 false 变 true"就是一条 `added`，"从 true 变 false"就是一条 `removed`，**方向不会互相抵消**。
 *
 * ⚠ 代价要说清楚：这样一来 diff 报的是"开关 n 现在是 true"，**丢失了"它之前是 true 还是根本不存在"**
 *   这个区别。对"这局发生了什么"这个用途足够了；需要更精确的历史时应当保留原始值。
 *
 * @param {*} raw - core/decode.mjs 解出的原始值
 * @returns {{value:*, changes:number}} 归一化后的值，以及处理了几个稀疏容器
 */
export function normalizeSave(raw) {
  if (!raw || typeof raw !== 'object') return { value: raw, sparse: 0 }
  let sparse = 0
  const out = { ...raw }

  if (raw.switches && typeof raw.switches === 'object') {
    const { v, n } = sparseTruthy(raw.switches._data)
    out.switches = { ...raw.switches, _data: v }; sparse += n
  }
  if (raw.variables && typeof raw.variables === 'object') {
    const { v, n } = sparseNonZero(raw.variables._data)
    out.variables = { ...raw.variables, _data: v }; sparse += n
  }
  if (raw.party && typeof raw.party === 'object') {
    const p = { ...raw.party }
    if (Array.isArray(raw.party._items)) { p._items = pairsToMap(raw.party._items); sparse++ }
    if (Array.isArray(raw.party._weapons)) { p._weapons = pairsToMap(raw.party._weapons); sparse++ }
    if (Array.isArray(raw.party._armors)) { p._armors = pairsToMap(raw.party._armors); sparse++ }
    out.party = p
  }
  if (raw.actors && Array.isArray(raw.actors._data)) {
    // $gameActors._data 下标就是 actorId，有意义的稀疏数组
    out.actors = { ...raw.actors, _data: indexToMap(raw.actors._data) }; sparse++
  }
  if (raw.map && typeof raw.map === 'object') {
    // $gameMap._events 是巨大的对象图，diff 出来全是噪声；坐标类的也别留
    const { _events, _interpreter, ...rest } = raw.map
    out.map = rest
    if (_events !== undefined) sparse++
  }
  if (raw.player && typeof raw.player === 'object') {
    // 玩家坐标每帧都在变，是纯噪声（VOLATILE_DEFAULTS 也覆盖不到这么深的路径）
    const { _realX, _realY, _x, _y, _direction, _newX, _newY, ...rest } = raw.player
    out.player = rest
  }
  // 存档每存一次都会变，但没有信息量
  if (raw.system && typeof raw.system === 'object') {
    const { _framesOnSave, _bgmOnSave, _bgsOnSave, _windowTone, _savedBgm, _walkingBgm, ...rest } = raw.system
    out.system = rest
  }
  return { value: out, sparse }
}

// ---------- diff → 事件 ----------

/**
 * 把归一化后的存档 diff 翻成事件。
 * 这里用的是 MV/MZ 的**已知结构**，所以比通用启发式准得多。
 */
export function mapSaveChanges(changes = [], ctx = {}) {
  const names = ctx.systemNames ?? null   // { switches: {5:'名字'}, variables: {...} }
  const out = []
  const seen = new Set()

  for (const c of changes) {
    const hit = classify(c, names)
    if (!hit) continue
    const key = `${hit.kind}|${hit.group}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ at: ctx.at ?? null, kind: hit.kind, text: hit.text, data: { source: 'rpgmaker', path: c.path, ...hit.data } })
  }
  return out
}

/** MV/MZ 的路径 → 事件。返回 null 表示这条变化没有叙事价值（例如无关内部字段）。 */
function classify(c, names) {
  const p = String(c.path)

  // 地图与传送 —— 最可靠的"进入新区域"
  if (/^\$\.map\._mapId$/.test(p)) return { kind: 'area', group: 'map', text: `地图切换到 ${fmt(c.after)}`, data: { mapId: c.after } }
  if (/^\$\.player\._transferring$/.test(p) && c.after === true) return { kind: 'area', group: 'transfer', text: '角色被传送到别处', data: {} }

  // 开关：id → 名字（给了 System.json 才有名字）
  const sw = p.match(/^\$\.switches\._data\.(\d+)$/)
  if (sw) {
    const n = names?.switches?.[sw[1]]
    const label = n ? `「${n}」` : `#${sw[1]}`
    if (c.kind === 'added') return { kind: 'progress', group: `sw${sw[1]}`, text: `事件开关 ${label} 打开了`, data: { switchId: Number(sw[1]), name: n ?? null } }
    if (c.kind === 'removed') return { kind: 'progress', group: `sw${sw[1]}`, text: `事件开关 ${label} 关上了`, data: { switchId: Number(sw[1]), name: n ?? null } }
    return null
  }

  // 变量：数值变化也是进度
  const va = p.match(/^\$\.variables\._data\.(\d+)$/)
  if (va) {
    const n = names?.variables?.[va[1]]
    const label = n ? `「${n}」` : `#${va[1]}`
    if (c.kind === 'changed') return { kind: 'progress', group: `va${va[1]}`, text: `变量 ${label} 变为 ${fmt(c.after)}`, data: { variableId: Number(va[1]), name: n ?? null } }
    if (c.kind === 'added') return { kind: 'progress', group: `va${va[1]}`, text: `变量 ${label} 变为 ${fmt(c.after)}`, data: { variableId: Number(va[1]), name: n ?? null } }
    return null
  }

  // 金钱与道具
  if (/^\$\.party\._gold$/.test(p)) return { kind: 'item', group: 'gold', text: `金币 ${fmt(c.before)}→${fmt(c.after)}`, data: {} }
  const it = p.match(/^\$\.party\._(items|weapons|armors)\.(\d+)$/)
  if (it) {
    const what = { items: '道具', weapons: '武器', armors: '防具' }[it[1]]
    if (c.kind === 'added') return { kind: 'item', group: `${it[1]}${it[2]}`, text: `获得${what} #${it[2]} ×${fmt(c.after)}`, data: { id: Number(it[2]) } }
    if (c.kind === 'removed') return { kind: 'item', group: `${it[1]}${it[2]}`, text: `失去${what} #${it[2]}`, data: { id: Number(it[2]) } }
    return { kind: 'item', group: `${it[1]}${it[2]}`, text: `${what} #${it[2]} 数量 ${fmt(c.before)}→${fmt(c.after)}`, data: { id: Number(it[2]) } }
  }

  // 角色成长
  const lv = p.match(/^\$\.actors\._data\.(\d+)\._level$/)
  if (lv) return { kind: 'progress', group: `lv${lv[1]}`, text: `角色 #${lv[1]} 等级 ${fmt(c.before)}→${fmt(c.after)}`, data: { actorId: Number(lv[1]) } }
  const hp = p.match(/^\$\.actors\._data\.(\d+)\._hp$/)
  if (hp && typeof c.after === 'number' && c.after <= 0) return { kind: 'death', group: `dead${hp[1]}`, text: `角色 #${hp[1]} 倒下了`, data: { actorId: Number(hp[1]) } }
  const ac = p.match(/^\$\.actors\._data\.(\d+)\._actorId$/)
  if (ac) return { kind: 'progress', group: `join${ac[1]}`, text: `队伍多了一名角色（#${ac[1]}）`, data: { actorId: Number(ac[1]) } }

  // 存档次数：只用来判断"这是新的一次存档"，没有叙事价值
  if (/^\$\.system\._saveCount$/.test(p)) return null
  return null
}

/**
 * 从解出的原始存档里抽取能直接展示的摘要（给界面用，不参与时机判断）。
 * 注意：**动的是原始值**（归一化前），因为归一化会把默认值略去。
 */
export function describeSave(raw) {
  if (!raw || typeof raw !== 'object') return null
  const sys = raw.system ?? {}
  const map = raw.map ?? {}
  const party = raw.party ?? {}
  const actors = Array.isArray(raw.actors?._data) ? raw.actors._data.filter(Boolean) : []
  const lead = actors[0] ?? null
  const frames = Number(sys._framesOnSave)
  const switchesOn = countTruthy(raw.switches?._data)
  const varsSet = countNonZero(raw.variables?._data)
  return {
    saveCount: Number.isFinite(Number(sys._saveCount)) ? Number(sys._saveCount) : null,
    playtimeSec: Number.isFinite(frames) ? Math.round(frames / 60) : null,
    playtimeText: Number.isFinite(frames) ? hms(frames / 60) : null,
    mapId: Number.isFinite(Number(map._mapId)) ? Number(map._mapId) : null,
    gold: Number.isFinite(Number(party._gold)) ? Number(party._gold) : null,
    steps: Number.isFinite(Number(party._steps)) ? Number(party._steps) : null,
    actor: lead ? { name: lead._name ?? null, level: Number(lead._level) || null, hp: Number(lead._hp) || null, mp: Number(lead._mp) || null } : null,
    partySize: Array.isArray(party._actors) ? party._actors.length : actors.length,
    switchesOn,
    variablesSet: varsSet,
  }
}

/**
 * 从游戏本体的 `data/System.json` 里取开关/变量名字表，好让事件说人话
 * （`开关 #5` vs `开关「打败了魔王」`）。
 *
 * MV 与 MZ 的字段名不同：MV 是 `switchNames`/`variableNames`，
 * MZ 是 `switches`/`variables`。两种都试。
 *
 * @param {string|object} systemJson - 文件内容或已解析对象
 */
export function systemNames(systemJson) {
  let o = systemJson
  if (typeof systemJson === 'string') {
    try { o = JSON.parse(systemJson) } catch { return null }
  }
  if (!o || typeof o !== 'object') return null
  const toMap = (arr) => {
    if (!Array.isArray(arr)) return null
    const m = {}
    arr.forEach((n, i) => { if (i > 0 && typeof n === 'string' && n.trim() !== '') m[i] = n.trim() })
    return Object.keys(m).length ? m : null
  }
  const switches = toMap(o.switches) ?? toMap(o.switchNames)
  const variables = toMap(o.variables) ?? toMap(o.variableNames)
  if (!switches && !variables) return null
  return { switches, variables, gameTitle: o.gameTitle ?? null }
}

function slotOf(name) {
  const m = String(name).match(/(\d+)/)
  return m ? Number(m[1]) : null
}

function fmt(v) {
  if (v === null || v === undefined) return '（空）'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 30)
  return String(v)
}

function hms(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** `[null, 0, 5]` → `{ '1': 0, '2': 5 }`（保留下标） */
function indexToMap(arr) {
  const o = {}
  arr.forEach((v, i) => { if (i > 0 && v !== null && v !== undefined) o[String(i)] = v })
  return o
}

/** 开关数组 → 只留 true 的稀疏对象 */
function sparseTruthy(arr) {
  if (!Array.isArray(arr)) return { v: arr, n: 0 }
  const o = {}
  arr.forEach((v, i) => { if (i > 0 && v === true) o[String(i)] = true })
  return { v: o, n: 1 }
}

function sparseNonZero(arr) {
  if (!Array.isArray(arr)) return { v: arr, n: 0 }
  const o = {}
  arr.forEach((v, i) => { if (i > 0 && v !== 0 && v !== null && v !== undefined) o[String(i)] = v })
  return { v: o, n: 1 }
}

/** `[[1,3],[7,1]]` → `{ '1': 3, '7': 1 }` */
function pairsToMap(arr) {
  const o = {}
  for (const pair of arr) {
    if (!Array.isArray(pair) || pair.length < 2) continue
    const [id, count] = pair
    if (count > 0) o[String(id)] = count
  }
  return o
}

function countTruthy(arr) {
  return Array.isArray(arr) ? arr.filter((v) => v === true).length : 0
}

function countNonZero(arr) {
  return Array.isArray(arr) ? arr.filter((v) => v !== 0 && v !== null && v !== undefined).length : 0
}

export default {
  id, name, capabilityBase,
  detect, findLogs, findSaves, readSession,
  parseLogLine, parseLog, mapSaveChanges, sessionEvents: () => [],
  normalizeSave, describeSave, systemNames,
}
