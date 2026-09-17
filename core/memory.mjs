// core/memory.mjs —— 跨会话记忆（纯逻辑，零依赖）
//
// 需求原话：「退出游戏后，桌宠能带有刚才游戏的记忆继续与用户交流。」
//
// ═══════════════════════════════════════════════════════════════════
// 为什么不能"把历史全塞进上下文"（HANDOFF §3.3）
// ═══════════════════════════════════════════════════════════════════
// 长会话必然溢出，而且塞进去的历史里绝大多数是噪声（"存档已更新"会出现几十次）。
// 所以本模块只做三件事：**写（带权重/时间）→ 召回（按当前话题相关性）→ 淘汰（低权重且久未命中）**。
//
// ═══════════════════════════════════════════════════════════════════
// 三个关键设计（都不是拍脑袋的，理由写在下面）
// ═══════════════════════════════════════════════════════════════════
//
// ① 【重复出现的事要"强化已有记忆"，不是"新增一条"】
//    `observe` 每次存档都会产出「存档已更新」。若逐条入记忆库，
//    玩十天之后记忆里 90% 是同一句话，召回出来毫无信息量。
//    所以按 `fingerprint`（类别 + 归一化文本）去重：命中就 **+1 计数、抬高权重、刷新时间**。
//    这一条同时让"这件事发生过很多次"变成一个可读的事实（×12）。
//
// ② 【召回要按"当前话题"相关，而不是按时间倒序】
//    玩家说"刚才那关好难"，召回「角色 #1 倒下了」比召回「存档已更新」有用得多。
//    所以打分 = 权重 + 时间衰减 + 关键词相关 − 刚被说过的惩罚（见 scoreOf）。
//    最后那一项很重要：**不惩罚重复召回，桌宠会反复念叨同一件事**。
//
// ③ 【一局结束时要把散事件"压缩"成记忆】
//    「退出游戏后带着刚才的记忆继续聊」不等于"把 40 条原始事件全带出来"。
//    所以 consolidate() 把一局压成：一条**汇总**（打了多久/存了几次/死过几次/推进了什么）
//    加几条**最重**的个体事件。这才是"记忆"，原始事件流是"日志"。
//
// 所有函数都是纯函数（返回新状态、不改入参），且**不读系统时间** —— 时间一律由调用方传 `now`。
// 这两条是为了可复现：同一段事件流跑两遍，召回结果必须逐字一致。

/** 记忆条目的默认参数。 */
export const MEMORY_DEFAULTS = Object.freeze({
  maxEntries: 400,           // 库里最多留这么多条
  recallLimit: 8,            // 单次召回上限
  halfLifeMs: 7 * 24 * 3600_000,   // 权重的时间半衰期（一周）
  hitPenaltyWindowMs: 30 * 60_000, // 这么短时间内被召回过的，再召回要扣分（别念叨）
  hitPenalty: 0.25,
  minScore: 0.12,            // 低于这个召回分数就不给模型（宁可少说）
  maxPerSession: 6,          // 一局最多留下几条个体记忆（其余靠汇总）
})

/** 记忆条目的类别。`summary` 是压缩出来的，其余是原始事件类别。 */
export const MEMORY_KINDS = Object.freeze([
  'summary', 'progress', 'combat', 'item', 'death', 'dialogue', 'area', 'system',
  'save', 'exit', 'crash',
  // 玩家自己说过的话 / 角色被明确告知的事实 —— 这两类只能由对话层写入
  'player-said', 'fact',
])

// ---------- 建立 / 归一化 ----------

/**
 * 建一个空的记忆库。
 * @param {{maxEntries?:number, game?:string}} [init]
 */
export function createMemory(init = {}) {
  return {
    version: 1,
    entries: [],
    maxEntries: init.maxEntries ?? MEMORY_DEFAULTS.maxEntries,
    game: init.game ?? null,
    sessionCount: 0,
  }
}

/**
 * 写入一条记忆。**按 fingerprint 去重**：命中已有条目就强化它，而不是新增。
 *
 * @param {object} mem
 * @param {object} item - { at, kind, text, weight?, game?, session?, pinned?, data? }
 * @returns {object} 新记忆库
 */
export function remember(mem, item) {
  const m = cloneMem(mem)
  if (!item || typeof item !== 'object') return m
  const text = String(item.text ?? '').trim()
  if (!text) return m

  const kind = MEMORY_KINDS.includes(item.kind) ? item.kind : 'system'
  const weight = Number.isFinite(item.weight)
    ? clamp01(item.weight)
    : 0.4
  const at = Number.isFinite(item.at) ? item.at : null
  const game = item.game ?? m.game ?? null
  const fingerprint = `${kind}|${game ?? ''}|${normalizeText(text)}`
  // ★ 允许调用方直接带 `count` 进来：consolidate 已经把"一局里同一件事出现了几次"折叠算好了，
  //   若不带进来，"这事发生了 30 次"这个事实会在压缩那一步丢掉（本来 ×N 就是为了保留它）。
  const inc = Number.isFinite(item.count) && item.count > 0 ? Math.floor(item.count) : 1

  const existing = m.entries.findIndex((e) => e.fingerprint === fingerprint)
  if (existing >= 0) {
    const prev = m.entries[existing]
    const merged = {
      ...prev,
      // 强化：次数累加、权重取更高的、时间刷到最近
      count: prev.count + inc,
      weight: Math.max(prev.weight, weight),
      at: at ?? prev.at,
      lastSeenAt: at ?? prev.lastSeenAt,
      // 保留最初出现的时间 —— "这事第一次是什么时候"经常比"最近一次"更有意义
      firstAt: prev.firstAt ?? prev.at ?? at ?? null,
      pinned: prev.pinned || item.pinned === true,
    }
    const entries = [...m.entries]
    entries[existing] = merged
    return { ...m, entries }
  }

  return {
    ...m,
    entries: [...m.entries, {
      id: item.id != null ? String(item.id) : makeId(fingerprint, m.entries.length),
      fingerprint,
      kind,
      game,
      session: item.session ?? null,
      text,
      weight,
      count: inc,
      at,
      firstAt: at,
      lastSeenAt: at,
      hits: 0,
      lastHitAt: null,
      pinned: item.pinned === true,
      data: item.data ?? null,
    }],
  }
}

/** 批量写入（按给定顺序）。 */
export function rememberAll(mem, items = []) {
  return items.reduce((acc, it) => remember(acc, it), mem)
}

/**
 * 把一批事件写进记忆。事件的 `importance` 直接当权重。
 * @param {object} mem
 * @param {object[]} events - core/events.mjs 形状
 * @param {{now?:number, game?:string, session?:string, kinds?:string[]}} [ctx]
 */
export function rememberEvents(mem, events = [], ctx = {}) {
  const allow = ctx.kinds ? new Set(ctx.kinds) : null
  let out = mem
  for (const e of events ?? []) {
    if (!e || allow && !allow.has(e.kind)) continue
    out = remember(out, {
      at: Number.isFinite(ctx.now) ? ctx.now : e.at,
      kind: e.kind,
      text: e.text,
      weight: e.importance,
      game: ctx.game,
      session: ctx.session,
      data: e.data,
    })
  }
  return out
}

// ---------- ★ 一局结束时的压缩 ----------

/**
 * ★ 把一局的事件压成"记忆"。
 *
 * 产出两条东西：
 *   1. **一条汇总**（kind='summary'）：这一局打了多久、存了几次、死过几次、推进了什么。
 *      权重取该局最高重要度，所以"这一局很关键"会被记住。
 *   2. **至多 `maxPerSession` 条个体事件**：按重要度取最重的几条。
 *
 * 为什么要有上限：一局可能产出上百条事件，全留下等于没压缩，
 * 而"退出游戏后带着记忆继续聊"要的是**能说上来的几件事**，不是完整日志。
 *
 * @param {object} mem
 * @param {object[]} events
 * @param {{now?:number, game?:string, session?:string, maxPerSession?:number, durationMs?:number}} [ctx]
 * @returns {{memory:object, summary:object|null, kept:object[]}}
 */
export function consolidate(mem, events = [], ctx = {}) {
  const list = (events ?? []).filter((e) => e && String(e.text ?? '').trim() !== '')
  if (list.length === 0) return { memory: cloneMem(mem), summary: null, kept: [] }

  const now = Number.isFinite(ctx.now) ? ctx.now : null
  const byKind = {}
  for (const e of list) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
  const maxWeight = Math.max(...list.map((e) => (Number.isFinite(e.importance) ? e.importance : 0)))

  // 汇总文本刻意用"事实清单"的口吻：这是要喂给模型的**事实**，不是让它自由发挥的引子。
  // 排掉 save（每次都存，天数多了会淹没真正的进展）。
  const parts = []
  const savedCount = byKind.save ?? 0
  if (savedCount) parts.push(`存了 ${savedCount} 次档`)
  const deaths = byKind.death ?? 0
  if (deaths) parts.push(`死过 ${deaths} 次`)
  const progress = (byKind.progress ?? 0) + (byKind.area ?? 0)
  if (progress) parts.push(`有 ${progress} 处进度推进`)
  const items = byKind.item ?? 0
  if (items) parts.push(`${items} 处道具变化`)
  if (byKind.crash) parts.push('中途异常退出过')
  if (byKind.exit && savedCount === 0) parts.push('没存档就退出了')

  const summaryText = parts.length ? `这一局：${parts.join('、')}` : `这一局有 ${list.length} 条动静`
  const summary = {
    at: now ?? list[list.length - 1]?.at ?? null,
    kind: 'summary',
    text: summaryText,
    weight: maxWeight,             // 该局最重的事决定这局的权重
    game: ctx.game,
    session: ctx.session,
    data: { byKind, total: list.length, durationMs: ctx.durationMs ?? null },
  }

  // 个体记忆：★ **先按指纹折叠，再取 Top-N**。
  // 顺序反过来的话，6 个名额可能被同一句"存档已更新"占掉三四个（它在一局里出现最频繁、
  // 权重又和别的 save 一样高），结果是"记忆"里只有两件事 —— 名额被白白浪费。
  const byFp = new Map()
  list.forEach((e, i) => {
    const fp = `${e.kind}|${normalizeText(String(e.text))}`
    const prev = byFp.get(fp)
    if (prev) {
      prev.count++
      prev.imp = Math.max(prev.imp, imp(e))
      prev.e = e   // 保留最后一条：文本里可能带更新的数值
      prev.i = i
    } else {
      byFp.set(fp, { e, imp: imp(e), count: 1, i })
    }
  })

  const budget = ctx.maxPerSession ?? MEMORY_DEFAULTS.maxPerSession
  const kept = [...byFp.values()]
    .sort((a, b) => (b.imp - a.imp) || (b.i - a.i))
    .slice(0, budget)
    .map(({ e, imp: im, count }) => ({
      at: Number.isFinite(e.at) ? e.at : now,
      kind: e.kind,
      text: e.text,
      weight: im,
      count,   // ← 必须带上：否则"这事发生了 30 次"会在压缩这一步丢掉
      game: ctx.game,
      session: ctx.session,
      data: e.data,
    }))

  const withSummary = remember(mem, summary)
  const memory = rememberAll(withSummary, kept)
  return { memory, summary, kept }
}

// ---------- 召回 ----------

/**
 * ★ 按**当前话题**召回，而不是按时间倒序。
 *
 * @param {object} mem
 * @param {object|string} [query]
 * @param {string[]} [query.terms]  关键词（中文没空格，按子串匹配）
 * @param {string[]} [query.kinds]  想找的类别
 * @param {number}   [query.now]    当前时间（时间衰减要用）
 * @param {string}   [query.game]   限定游戏；不给就用库的默认
 * @param {boolean}  [query.crossGame=false] 允许跨游戏召回
 * @param {number}   [opts.limit]
 * @param {number}   [opts.minScore]
 * @returns {Array<{entry:object, score:number, why:string[]}>} 按分数降序
 */
export function recall(mem, query = {}, opts = {}) {
  const q = typeof query === 'string' ? { terms: splitTerms(query) } : (query ?? {})
  const limit = opts.limit ?? MEMORY_DEFAULTS.recallLimit
  const minScore = opts.minScore ?? MEMORY_DEFAULTS.minScore
  const now = Number.isFinite(q.now) ? q.now : (Number.isFinite(opts.now) ? opts.now : null)
  const terms = (q.terms ?? []).filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
  const kinds = new Set(q.kinds ?? [])
  const game = q.game ?? mem.game ?? null

  const scored = []
  for (const entry of mem.entries ?? []) {
    if (!q.crossGame && game !== null && entry.game !== null && entry.game !== game) continue
    const { score, why } = scoreOf(entry, { terms, kinds, now })
    if (score >= minScore) scored.push({ entry, score, why })
  }
  scored.sort((a, b) => b.score - a.score || (String(a.entry.id).localeCompare(String(b.entry.id))))
  return scored.slice(0, limit)
}

/**
 * 打分。四项相加/相减，每一项都刻意做得**可解释**（会写进 `why`，便于调试与测试）：
 *
 *   权重        entry.weight                    —— 事情本身重不重要
 *   时间衰减    0.5 ** (age / halfLifeMs)       —— 越久越淡
 *   相关度      命中关键词的比例 + 类别命中      —— 跟当前话题像不像
 *   念叨惩罚    最近被召回过的次数               —— **不加这项，桌宠会反复说同一件事**
 */
export function scoreOf(entry, { terms = [], kinds = new Set(), now = null, opts = {} } = {}) {
  const D = { ...MEMORY_DEFAULTS, ...opts }
  const why = []

  let score = entry.weight
  why.push(`权重 ${entry.weight.toFixed(2)}`)

  if (now !== null && Number.isFinite(entry.at)) {
    const age = Math.max(0, now - entry.at)
    const decay = 0.5 ** (age / D.halfLifeMs)
    score += decay
    why.push(`时间衰减 +${decay.toFixed(2)}`)
  }

  if (terms.length) {
    const hit = terms.filter((t) => entry.text.includes(t) || entry.kind.includes(t))
    if (hit.length) {
      const rel = hit.length / terms.length
      score += rel
      why.push(`相关 +${rel.toFixed(2)}（${hit.join('、')}）`)
    }
  }
  if (kinds.size && kinds.has(entry.kind)) {
    score += 0.4
    why.push('类别命中 +0.40')
  }

  if (now !== null && Number.isFinite(entry.lastHitAt) && now - entry.lastHitAt < D.hitPenaltyWindowMs) {
    score -= D.hitPenalty
    why.push(`刚说过 −${D.hitPenalty.toFixed(2)}`)
  }

  // 反复出现过的事（count > 1）略微加权：它显然不是偶然
  if (entry.count > 1) {
    const bonus = Math.min(0.3, 0.05 * (entry.count - 1))
    score += bonus
    why.push(`出现过 ${entry.count} 次 +${bonus.toFixed(2)}`)
  }
  if (entry.pinned) {
    score += 0.5
    why.push('被钉住 +0.50')
  }

  return { score: Math.max(0, score), why }
}

/**
 * 记下"这些记忆刚被用过"。**必须由调用方在真正把记忆喂给模型之后调用**，
 * 否则念叨惩罚永远不会生效（也就永远学不会少念叨）。
 */
export function markRecalled(mem, recalled, now) {
  const m = cloneMem(mem)
  const ids = new Set((recalled ?? []).map((r) => (r?.entry ? r.entry.id : r?.id)).filter((x) => x != null).map(String))
  if (ids.size === 0) return m
  m.entries = m.entries.map((e) => (
    ids.has(e.id) ? { ...e, hits: e.hits + 1, lastHitAt: Number.isFinite(now) ? now : e.lastHitAt } : e
  ))
  return m
}

// ---------- 淘汰 ----------

/**
 * 淘汰：库超过 `maxEntries` 时，按**保留分**（权重 × 长半衰期 + 被命中过）从低到高丢。
 * 被 `pinned` 的永不淘汰 —— 那是角色卡里钉住的设定（"她的本名叫…"），不是流水账。
 *
 * @returns {{memory:object, dropped:object[]}}
 */
export function forget(mem, opts = {}) {
  const max = opts.maxEntries ?? mem.maxEntries ?? MEMORY_DEFAULTS.maxEntries
  const now = Number.isFinite(opts.now) ? opts.now : null
  const m = cloneMem(mem)
  if (m.entries.length <= max) return { memory: m, dropped: [] }

  const keepScore = (e) => {
    let s = e.weight
    if (now !== null && Number.isFinite(e.at)) s += 0.4 * (0.5 ** (Math.max(0, now - e.at) / (MEMORY_DEFAULTS.halfLifeMs * 8)))
    // 被召回过说明它曾经有用；但很老的也不再值钱
    s += Math.min(0.3, 0.02 * e.hits)
    if (e.pinned) s += 10
    return s
  }

  const ranked = [...m.entries].sort((a, b) => keepScore(b) - keepScore(a) || String(a.id).localeCompare(String(b.id)))
  const keep = ranked.slice(0, max)
  const dropped = ranked.slice(max)
  const keepIds = new Set(keep.map((e) => e.id))
  m.entries = m.entries.filter((e) => keepIds.has(e.id))
  return { memory: m, dropped }
}

// ---------- 给模型看的摘要 ----------

/**
 * 把记忆渲染成**一段事实**（同 `persona.describeState` 的立场：模型只被给事实，不许自己编）。
 * 按分数排序，所以"跟当前话题最相关"的排在最前。
 *
 * @param {object} mem
 * @param {object|string} [query] 同 recall
 * @param {{limit?:number, maxChars?:number, now?:number, digestOf?:number}} [opts]
 * @returns {{text:string, used:Array}}
 */
export function digest(mem, query = {}, opts = {}) {
  const used = recall(mem, { ...(typeof query === 'string' ? { terms: splitTerms(query) } : query), ...(opts.now != null ? { now: opts.now } : {}) }, {
    limit: opts.limit ?? 6,
    minScore: opts.minScore,
  })
  if (used.length === 0) return { text: '', used: [] }

  const maxChars = opts.maxChars ?? 600
  const lines = []
  let total = 0
  for (const { entry, why } of used) {
    const times = entry.count > 1 ? `（×${entry.count}）` : ''
    const line = `· ${entry.text}${times}`
    if (total + line.length > maxChars) break
    lines.push(opts.withWhy ? `${line}   [${why.join(' ')}]` : line)
    total += line.length
  }
  if (lines.length === 0) return { text: '', used: [] }
  return { text: `【与这个玩家有关的记忆】\n${lines.join('\n')}`, used: used.slice(0, lines.length) }
}

/** 库的统计（给界面与测试用）。 */
export function stats(mem) {
  const byKind = {}
  let pinned = 0
  let totalCount = 0
  for (const e of mem.entries ?? []) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
    if (e.pinned) pinned++
    totalCount += e.count
  }
  return {
    entries: (mem.entries ?? []).length,
    occurrences: totalCount,
    pinned,
    byKind,
    maxEntries: mem.maxEntries,
    sessionCount: mem.sessionCount ?? 0,
  }
}

/** 标记一次会话开始/结束（只用于统计与"这一局"的归属）。 */
export function startSession(mem) {
  const m = cloneMem(mem)
  m.sessionCount = (m.sessionCount ?? 0) + 1
  return { memory: m, session: `s${m.sessionCount}` }
}

// ---------- 内部 ----------

const imp = (e) => (Number.isFinite(e?.importance) ? e.importance : 0)

const clamp01 = (v) => Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 1)

function cloneMem(m) {
  return { ...m, entries: [...(m.entries ?? [])] }
}

/** 去重指纹用的归一化：压掉空白与标点，让「存档已更新。」和「存档已更新」算同一条。 */
function normalizeText(s) {
  return String(s).replace(/[\s，。、！？；：,.!?;:'"（）()【】\[\]]+/g, '').slice(0, 120)
}

/**
 * 关键词切分。中文没有空格，所以：按空白/标点切，再补上长度 ≥2 的整串。
 * **刻意不做分词** —— 没有词典的情况下，朴素子串匹配已经够用，而且行为可预测、可测试。
 */
function splitTerms(s) {
  const t = String(s ?? '').trim()
  if (t === '') return []
  const parts = t.split(/[\s，。、！？；：,.!?;:]+/).filter((x) => x.length >= 2)
  return parts.length ? parts : (t.length >= 2 ? [t] : [])
}

function makeId(fp, i) {
  let h = 0
  for (let k = 0; k < fp.length; k++) h = (h * 31 + fp.charCodeAt(k)) | 0
  return `mem_${(h >>> 0).toString(36)}_${i}`
}
