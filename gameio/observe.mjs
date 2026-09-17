// gameio/observe.mjs —— 把各层串成一条真实链路
//
// 为什么需要它（HANDOFF §4 里程碑 M7 / ARCHITECTURE M9，标注「不能跳」）：
//   在它出现之前，core/decode、core/diff、core/presence、gameio/* 各层都有自己的测试，
//   但**没有任何一个入口**把「读一个真实游戏目录 → 产出事件 → 判断该不该开口」跑完过。
//   而各层各自的测试都绿，并不等于链路是通的 —— 这正是上个项目的教训：
//   LESSONS §4「套件多 ≠ 覆盖全」：真 bug 曾经逃过当时全部 7 套测试。
//
// 链路：
//   identify(dir)              探测引擎
//     → findSaves/findLogs     找文件
//     → decodeSaveFile         解码（失败也要给出 sha256）
//     → applyNormalize         归一化（RPG Maker 那类稀疏数组必须做，否则丢事件）
//     → diffValues             与上次快照比
//     → mapSaveChanges         翻成事件
//     → createEvent            规范化为 core/events.mjs 形状
//     → triggerFromEvent       转成 core/presence.mjs 的触发
//
// ══════════════════════════════════════════════════════════════════
// ★ 首帧 = 纯基线，绝不产事件
// ══════════════════════════════════════════════════════════════════
// 第一次看某个目录时，我们**没有**"上一次"可比，也就无从判断刚刚发生了什么。
// 此时若把整个存档当成一堆 added、把整份日志当成一堆事件，桌宠就会对着一个
// 它刚认识、玩家也没刚做过什么的游戏开口 —— 既吵又蠢。
// 所以规则是：首帧只记录基线（sha256 / 解码值 / 日志偏移），**一条事件都不产**。
// 想强制读首帧（做诊断用）传 `includeFirstRead: true`。

import { createHash } from 'node:crypto'
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { decodeSaveFile } from '../core/decode.mjs'
import { diffValues, VOLATILE_DEFAULTS } from '../core/diff.mjs'
import { normalizeEvents } from '../core/events.mjs'
import { identify } from './index.mjs'
import {
  applyNormalize, inferCapability, triggerFromEvent, readRange, walkFiles, unmatchedLines,
} from './base.mjs'

/** 默认上限，避免在一款游戏上花掉不必要的时间。 */
export const OBSERVE_DEFAULTS = Object.freeze({
  maxSaves: 8,             // 每次最多处理这么多个存档（大的存档可能有几十个槽位）
  maxNewBytes: 256 * 1024, // 每次最多读这么多新日志字节
  firstReadBytes: 64 * 1024,
  maxEvents: 40,
})

/** 监视状态。**必须由调用方持久化**（进程重启后要靠它才知道"上次是什么样"）。 */
export function createStore() {
  return { version: 1, games: {} }
}

/** 取某个目录的状态槽；没有就建一个（**会写入 store**，调用方注意别对只读副本用它）。 */
export function storeSlot(store, dir) {
  if (!store.games) store.games = {}
  if (!store.games[dir]) store.games[dir] = { saves: {}, logs: {}, firstSeenAt: null, lastSeenAt: null }
  return store.games[dir]
}

const EMPTY_SLOT = Object.freeze({ saves: {}, logs: {}, firstSeenAt: null, lastSeenAt: null })

/**
 * 观测一个游戏目录，产出事件与触发。
 *
 * @param {string} dir - 游戏目录（`LocalLow\<公司>\<产品>` 或 Godot 的 app_userdata 目录）
 * @param {object} [opts]
 * @param {object} [opts.store]        上一步的 store（不传则视为首次观测 → 纯基线）
 * @param {number} [opts.now]          当前时间（毫秒）；不传取 Date.now()
 * @param {string} [opts.adapter]      强制指定引擎 adapter id
 * @param {object} [opts.patterns]     每游戏日志规则（传给 adapter.parseLogLine 的 opts）
 * @param {object} [opts.saveRules]    每游戏存档规则
 * @param {object} [opts.systemNames]  RPG Maker 的开关/变量名字表
 * @param {boolean} [opts.includeFirstRead] 首帧也产事件（仅诊断用）
 * @returns {object} 见文件末尾的返回值形状说明
 */
export function observe(dir, opts = {}) {
  const O = { ...OBSERVE_DEFAULTS, ...opts }
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const prevStore = opts.store ?? createStore()
  const store = { version: 1, games: { ...(prevStore.games ?? {}) } }
  // 读 prev 时**不要**用 storeSlot —— 那会往调用方的 store 里塞一个空槽（副作用）
  const prev = prevStore.games?.[dir] ?? EMPTY_SLOT
  const cur = { saves: { ...prev.saves }, logs: { ...prev.logs }, firstSeenAt: prev.firstSeenAt ?? now, lastSeenAt: now }
  const isFirst = prev.firstSeenAt === null
  const emit = isFirst && !O.includeFirstRead ? false : true

  // ══════════════════════════════════════════════════════════════════
  // ★ capability 是**累积的观察事实**，不是"这一 tick 产出了什么"
  // ══════════════════════════════════════════════════════════════════
  // 这里踩过一个很严重的坑：capability 原先完全由**本 tick 的证据**推出，
  // 于是"没有变化的那一 tick"（存档没变、日志没新增）会把它打回基线
  // ⇒ 档位从 moderate 掉回 conservative。
  // 而"没有新变化 + 玩家刚放下手柄"**恰恰是最该开口的那一刻** ——
  // 结果是桌宠几乎永远开不了口，而且原因藏在一条 notes 里，不查根本看不出来。
  //
  // 正确的模型：capability 回答的是"**这款游戏**能读出什么"，那是关于游戏的**持久事实**；
  // 一旦观察到"存档解得开"，它就永远成立，不该因为这一秒没变化而失效。
  //
  // 下面这几个名字刻意分开，因为**一个变量回答两个问题**正是上面那个 bug 的根因：
  //   savesDecoded            —— 本 tick **实际解码了几个**（性能指标：没变就不该重复解码）
  //   evidence.savesDecodable —— **已知这款游戏的存档解得开**（累积事实：capability 的输入）
  // 合成一个变量时，"没有变化的那一 tick"就会同时把性能指标与 capability 一起打回 0。
  const prevEvidence = prev.evidence ?? { savesDecodable: false, logKinds: [] }
  const evidence = { savesDecodable: prevEvidence.savesDecodable === true, logKinds: [...(prevEvidence.logKinds ?? [])] }

  const notes = []
  const rawEvents = []
  let savesDecoded = 0
  let savesSeen = 0
  const logKinds = new Set()

  const found = opts.adapter ? { adapter: identify(dir, { adapter: opts.adapter }).adapter, engine: opts.adapter, score: 1, evidence: [] } : identify(dir)
  const adapter = found.adapter
  if (!adapter) notes.push('没有识别出引擎：只按纯文件监视处理（存档一变就能触发）')

  const saves = adapter ? safe(() => adapter.findSaves(dir), []) : fallbackSaves(dir)
  const logs = adapter ? safe(() => adapter.findLogs(dir), []) : fallbackLogs(dir)

  // ---------- 存档通道 ----------
  for (const s of saves.slice(0, O.maxSaves)) {
    savesSeen++
    const rec = prev.saves[s.path]
    let sha
    try { sha = sha256File(s.path) } catch (e) { notes.push(`算哈希失败 ${s.name}：${e.code ?? e.message}`); continue }

    // 没变 ⇒ 跳过重复解码（省 CPU）。但"这个存档能不能解开"是**上一帧就已经知道的事实**
    // （记在 rec.decodable 里），必须照样累积进 capability —— 见上面 evidence 的说明。
    // ⚠ 这里**不能** `savesDecoded++`：那个计数回答的是"本 tick 实际解码了几个"，
    //   是性能指标（测试就盯着"文件没变不该再解码一次"）。两个问题的答案要分开记，
    //   合成一个变量的后果见上面那段说明。
    if (rec && rec.sha === sha) {
      cur.saves[s.path] = rec
      if (rec.decodable) evidence.savesDecodable = true
      continue
    }

    // 变了（或首次见）
    let dec = null
    try { dec = decodeSaveFile(s.path) } catch (e) { notes.push(`解码异常 ${s.name}：${e.message}`) }
    const decodable = dec?.ok === true

    if (!rec) {
      // 首帧：建立基线。
      // ★ 必须**连解码值一起存** —— 只存 sha 的话，第二次观测就没有"上一次"可比，
      //   diff 分支会被永远跳过，于是只能报"存档已更新"、永远读不出进展。（这个坑真踩过）
      cur.saves[s.path] = {
        sha, at: now, decodable, mtimeMs: statMtime(s.path),
        value: decodable ? compact(applyNormalize(adapter, dec.value).value) : undefined,
      }
      if (decodable) { savesDecoded++; evidence.savesDecodable = true }
      continue
    }

    // ★ 只要有变化，就先产出「存档被写入」—— 这是 P2 的保证：
    //   就算内容一个字节都读不懂，仅凭"文件变了"也足以驱动时机引擎。
    if (emit) {
      rawEvents.push({
        at: now, kind: 'save',
        text: decodable && dec.value !== undefined
          ? describeChange(adapter, s, dec, rec)
          : `「${s.name}」已更新`,
        data: { source: 'save-file', file: s.name, decoded: decodable, format: dec?.format ?? null },
      })
    }

    // 内容 diff：只有两次**都**解得出结构时才有意义
    if (decodable && rec.value !== undefined) {
      const n0 = applyNormalize(adapter, rec.value)
      const n1 = applyNormalize(adapter, dec.value)
      // 存档里天然高频变动但不表示进展的字段（时间戳/游戏时长/随机种子）默认压掉，
      // 否则每次自动存档都会 diff 出一堆噪声。要全量对比传 `volatile: false`。
      const ignore = opts.volatile === false ? [] : VOLATILE_DEFAULTS
      const { changes } = diffValues(n0.value, n1.value, { ignore })
      if (changes.length > 0 && emit) {
        const ctx = {
          at: now,
          saveRules: opts.saveRules,
          systemNames: opts.systemNames,
          patterns: opts.patterns,
          maxEvents: opts.maxSaveEvents,
        }
        const mapped = typeof adapter?.mapSaveChanges === 'function'
          ? safe(() => adapter.mapSaveChanges(changes, ctx), [])
          : []
        for (const m of mapped) rawEvents.push(m)
        if (mapped.length === 0) {
          // ★ 没映射出事件时，把**变化位置**如实列出来 —— 这是用户写"每游戏存档规则"的依据。
          //   不做这一步的话，用户只看到"存档变了"，无从知道该配什么。
          //   （实测撞到过：某游戏的存档字段叫 dayCount / hPoint / totalPoint，
          //     当时一个信号词都没命中，只报了"存档已更新"。）
          const where = changes.slice(0, 5).map((c) => c.path).join('、')
          notes.push(`存档变了（有效变化 ${changes.length} 处）但没有可叙述的事件；变化位置：${where}` +
            (changes.length > 5 ? ` 等 ${changes.length} 处` : ''))
        }
      }
    } else if (!decodable) {
      notes.push(`「${s.name}」内容解不开（${dec?.format ?? 'unknown'}），只按"文件变了"处理`)
    }

    cur.saves[s.path] = {
      sha, at: now, decodable, mtimeMs: statMtime(s.path),
      // 只留可 diff 的那部分值，避免 store 被巨大的存档对象图撑爆
      value: decodable ? compact(applyNormalize(adapter, dec.value).value) : undefined,
    }
    if (decodable) { savesDecoded++; evidence.savesDecodable = true }
  }

  // ---------- 日志通道 ----------
  // 关键：**记录的行边界偏移必须精确**。
  //   做法是只消费到最后一个换行为止，末尾那半行不消费、留到下次 —— 这样偏移永远对齐行首，
  //   于是 readRange 不必（也不该）丢首行。最初版本让 readRange 无条件丢首行，
  //   结果把刚追加的那一整行吃掉了，表现为"日志明明有新增却不产事件"。
  for (const l of logs.slice(0, 4)) {
    const rec = prev.logs[l.path]
    const start = rec ? rec.offset : 0
    let range
    try {
      range = readRange(l.path, start, rec ? O.maxNewBytes : O.firstReadBytes)
    } catch (e) { notes.push(`读日志失败 ${l.name}：${e.code ?? e.message}`); continue }

    if (rec && range.reset) notes.push(`${l.name} 被重写（长度变小），已从头读起`)

    let text = range.text
    let base = range.from
    if (range.reset && base > 0) {
      // 从尾部重新读起时首行是半截的，这一处才该丢
      const nl = text.indexOf('\n')
      if (nl < 0) { text = ''; base = range.to } else {
        base += Buffer.byteLength(text.slice(0, nl + 1), 'utf8')
        text = text.slice(nl + 1)
      }
    }

    const lastNl = text.lastIndexOf('\n')
    const usable = lastNl >= 0 ? text.slice(0, lastNl + 1) : ''
    const nextOffset = usable ? base + Buffer.byteLength(usable, 'utf8') : base

    if (emit && usable && typeof adapter?.parseLog === 'function') {
      const parsed = safe(() => adapter.parseLog(usable, { at: now, ...(opts.patterns ?? {}) }), [])
      for (const p of parsed) {
        rawEvents.push({ at: p.at ?? now, kind: p.kind, text: p.text, data: p.data })
        logKinds.add(p.kind)
      }
    }
    cur.logs[l.path] = { offset: nextOffset, at: now, size: range.size }
  }

  // ---------- 规范化 + 能力推理 ----------
  const { events, dropped } = normalizeEvents(rawEvents.slice(0, O.maxEvents))
  if (dropped.empty || dropped.dup) notes.push(`丢弃：空文本 ${dropped.empty} 条、重复 ${dropped.dup} 条`)

  // 把本 tick 观察到的证据并进累积证据。savesDecodable 在上面三条路径各自置位即可，
  // 这里只补日志种类 —— 同理，某一 tick 没新增日志，不代表"这个游戏不产日志类事件"。
  for (const k of logKinds) if (!evidence.logKinds.includes(k)) evidence.logKinds.push(k)
  cur.evidence = evidence

  const capability = inferCapability(adapter, {
    savesDecoded: evidence.savesDecodable,
    logKinds: evidence.logKinds,
    notes: isFirst ? ['本次是首次观测（只建立基线，不产事件）'] : [],
  })

  const triggers = events.map((e) => triggerFromEvent(e, { at: timeToMs(e.at, now) })).filter(Boolean)

  store.games[dir] = cur
  return {
    dir, now, isFirst, emitted: emit,
    engine: adapter?.id ?? null,
    score: found.score ?? 0,
    evidence: found.evidence ?? [],
    session: adapter && typeof adapter.readSession === 'function' ? safe(() => adapter.readSession(dir), null) : null,
    savesSeen, savesDecoded, logKinds: [...logKinds],
    events, triggers, capability, notes, store,
    baselineOnly: isFirst && !O.includeFirstRead,
  }
}

/**
 * 给配置界面用：把「adapter 认不出来的日志行」列出来，好让用户写每游戏规则。
 * 实测那款 Godot 视觉小说的日志里就有 `saved`、`check money happened`、裸数字这类游戏自己打的行。
 */
export function suggestPatterns(dir, opts = {}) {
  const adapter = opts.adapter ? identify(dir, { adapter: opts.adapter }).adapter : identify(dir).adapter
  if (!adapter || typeof adapter.parseLogLine !== 'function') return { engine: adapter?.id ?? null, lines: [] }
  const logs = safe(() => adapter.findLogs(dir), [])
  const out = []
  const seen = new Set()
  for (const l of logs.slice(0, 3)) {
    let range
    try { range = readRange(l.path, 0, opts.bytes ?? 128 * 1024) } catch { continue }
    const items = unmatchedLines(
      (line, o) => adapter.parseLogLine(line, o),
      range.text,
      { minCount: opts.minCount ?? 1, limit: opts.limit ?? 60 },
    )
    for (const u of items) {
      if (seen.has(u.line)) continue
      seen.add(u.line)
      out.push(u)
    }
  }
  return { engine: adapter.id, lines: out.sort((a, b) => b.count - a.count).slice(0, opts.limit ?? 60) }
}

// ---------- 内部 ----------

function fallbackSaves(dir) {
  return walkFiles(dir, { maxDepth: 3, limit: 200 }).saves.map((s) => ({ ...s, kind: 'unknown' }))
}
function fallbackLogs(dir) {
  return walkFiles(dir, { maxDepth: 3, limit: 200 }).logs.map((s) => ({ ...s, kind: 'unknown' }))
}

function describeChange(adapter, s, dec, rec) {
  const meta = typeof adapter?.describeSave === 'function' ? safe(() => adapter.describeSave(dec.value), null) : null
  if (meta?.playtimeText && meta.saveCount !== null) {
    return `「${s.name}」已更新（第 ${meta.saveCount} 次存档 · 游戏时间 ${meta.playtimeText}）`
  }
  void rec
  return `「${s.name}」已更新`
}

function sha256File(path) {
  const fd = openSync(path, 'r')
  try {
    const h = createHash('sha256')
    const buf = Buffer.alloc(1 << 16)
    let n
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
    return h.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function statMtime(path) {
  try { return statSync(path).mtimeMs } catch { return null }
}

/** 事件的 at 可能是毫秒数或 ISO 串；转不成数字就用 now。 */
function timeToMs(at, now) {
  if (typeof at === 'number' && Number.isFinite(at)) return at
  if (at == null) return now
  const n = Number(at)
  if (Number.isFinite(n)) return n
  const t = Date.parse(String(at))
  return Number.isFinite(t) ? t : now
}

/**
 * 把要存进 store 的值裁一刀：只保留能参与 diff 的部分。
 * 存档对象图可能非常大（实测 RPG Maker 的 `$gameMap._events` 就很夸张），
 * 全量存进 store 会让持久化文件失控。这里限制深度与体积，超出就退化成 sha256-only。
 */
function compact(value, { maxDepth = 8, maxKeys = 4000 } = {}) {
  let count = 0
  const walk = (v, d) => {
    if (++count > maxKeys || d > maxDepth) return undefined
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) {
      const out = []
      for (const x of v) { const r = walk(x, d + 1); if (r === undefined) return undefined; out.push(r) }
      return out
    }
    const out = {}
    for (const [k, x] of Object.entries(v)) { const r = walk(x, d + 1); if (r === undefined) return undefined; out[k] = r }
    return out
  }
  return walk(value, 0)
}

const safe = (fn, dflt) => { try { return fn() } catch { return dflt } }
