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
  // ★ V2：容量从 400 提到 3000。400 条对"玩了几个月"的桌宠太少了 ——
  //   一旦满了就会开始丢真正有价值的旧记忆（比如第一次通关）。
  maxEntries: 3000,
  recallLimit: 8,            // 单次召回上限
  halfLifeMs: 7 * 24 * 3600_000,   // **默认**权重半衰期（一周）。V2 里每种类型有自己的值，见 KIND_POLICY
  hitPenaltyWindowMs: 30 * 60_000, // 这么短时间内被召回过的，再召回要扣分（别念叨）
  hitPenalty: 0.25,
  minScore: 0.12,            // 低于这个召回分数就不给模型（宁可少说）
  maxPerSession: 6,          // 一局最多留下几条个体记忆（其余靠汇总）
  // —— V2 新增 ——
  // 淘汰一次要腾出的比例。**批量淘汰**而不是"每写一条丢一条"：
  //   3000 条的库每次写入都排序一次是全量开销，而按比例一次腾 5% 就摊薄了代价。
  evictBatchRatio: 0.05,
  // LLM 评分过滤：低于这个分就不入长期记忆（只对"够格被评分"的类别生效，见 judgePolicy）
  llmJudgeMin: 0.35,
  // 单次最多送几条去评分（防止一局几百条事件把 token 打爆）
  llmJudgeMaxItems: 24,
})

// ══════════════════════════════════════════════════════════════════
// ★ V2 核心：**分型打分**（每种记忆有自己的权重、半衰期、强化上限、淘汰保护）
// ══════════════════════════════════════════════════════════════════
// 为什么要分型：V1 里所有类别共用"一周半衰期"，于是两类记忆的行为都不对 ——
//   · 「她说过她怕黑」是**设定**，一年后也该记得；一周半衰期等于一个月就淡没了
//   · 「存档已更新」是流水账，一周半衰期又太长了，几百条噪声能把召回位挤满
// 分型就是承认这两者**根本不是一个东西**。数字不是拍的，判据是：
//   halfLifeDays —— 这件事"还值不值得提"的时间尺度（设定按年、流水账按天）
//   weight       —— 这条记忆**自身**的重要性下限（玩家说的话、汇总，天然比"存档了"重）
//   reinforce    —— 反复出现最多能把它抬多高（噪声类封顶低，免得刷成最重的）
//   evictBonus   —— 淘汰时的保护分（钉住的设定最该活到最后）
export const KIND_POLICY = Object.freeze({
  //            基础权重  半衰期(天)  强化上限  淘汰保护
  fact: { weight: 0.90, halfLifeDays: 365, reinforce: 5, evictBonus: 3.0 },
  'player-said': { weight: 0.80, halfLifeDays: 120, reinforce: 4, evictBonus: 2.0 },
  summary: { weight: 0.75, halfLifeDays: 60, reinforce: 3, evictBonus: 1.0 },
  death: { weight: 0.70, halfLifeDays: 30, reinforce: 3, evictBonus: 0.8 },
  crash: { weight: 0.60, halfLifeDays: 30, reinforce: 2, evictBonus: 0.6 },
  dialogue: { weight: 0.50, halfLifeDays: 30, reinforce: 2, evictBonus: 0.5 },
  combat: { weight: 0.50, halfLifeDays: 14, reinforce: 2, evictBonus: 0.2 },
  progress: { weight: 0.55, halfLifeDays: 21, reinforce: 2, evictBonus: 0.3 },
  area: { weight: 0.35, halfLifeDays: 10, reinforce: 1.5, evictBonus: 0 },
  item: { weight: 0.35, halfLifeDays: 10, reinforce: 1.5, evictBonus: 0 },
  system: { weight: 0.30, halfLifeDays: 14, reinforce: 1, evictBonus: 0 },
  exit: { weight: 0.30, halfLifeDays: 7, reinforce: 1, evictBonus: 0 },
  // 「存档已更新」是全场最大的噪声源（每存一次档就来一条），衰减最快、强化封顶最低
  save: { weight: 0.20, halfLifeDays: 5, reinforce: 1, evictBonus: 0 },
})

/** 未登记类别的兜底策略 —— 与 V1 的默认行为一致（一周半衰期）。 */
export const DEFAULT_POLICY = Object.freeze({
  weight: 0.40, halfLifeDays: 7, reinforce: 2, evictBonus: 0,
})

/** 取某类别的策略。未登记的类别退回 DEFAULT_POLICY（而不是当成错误）。 */
export function policyFor(kind) {
  const p = KIND_POLICY[kind] ?? DEFAULT_POLICY
  return {
    weight: p.weight,
    halfLifeMs: p.halfLifeDays * 24 * 3600_000,
    reinforce: p.reinforce,
    evictBonus: p.evictBonus,
  }
}

/**
 * 内容哈希（去重用）。FNV-1a 两轮拼成 16 位十六进制 —— **零依赖、确定性**。
 * 为什么不用 sha256：这里是去重用，不是密码学场景；而 core/ 要保持零依赖
 * 且能跑在渲染端（拿不到 node:crypto）。16 位十六进制 = 64 位，撞库概率对
 * 几千条记忆可以忽略。
 */
export function hashOf(text, kind = '', game = '') {
  const s = `${kind}\u0000${game}\u0000${normalizeText(String(text ?? ''))}`
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
}

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
 *
 * ★ V2：`version: 2`。旧库（version 1 或无 version）走 `migrateMemory()` 升级 ——
 *   迁移只补字段、不改已有条目的行为（老条目没有 `policy`，仍按全局半衰期算）。
 * @param {{maxEntries?:number, game?:string}} [init]
 */
export function createMemory(init = {}) {
  return {
    version: 2,
    entries: [],
    maxEntries: init.maxEntries ?? MEMORY_DEFAULTS.maxEntries,
    game: init.game ?? null,
    sessionCount: 0,
  }
}

/**
 * 把 V1 的记忆库升级成 V2。
 *
 * 迁移策略是**保守的**：只补 `hash` 与 `policy` 两个字段，**不动任何已有数值**
 * （权重/计数/时间原样保留）。理由：老库里的分数是用户已经看到过的行为，
 * 迁移时重算会让"桌宠的记忆"在一夜之间变样，而用户完全不知道发生了什么。
 *
 * @returns {{memory:object, migrated:number, already:boolean}}
 */
export function migrateMemory(mem) {
  if (!mem || typeof mem !== 'object') return { memory: createMemory(), migrated: 0, already: false }
  if (mem.version >= 2 && (mem.entries ?? []).every((e) => e.hash && e.policy)) {
    return { memory: mem, migrated: 0, already: true }
  }
  let migrated = 0
  const entries = (mem.entries ?? []).map((e) => {
    if (e.hash && e.policy) return e
    migrated++
    const kind = e.kind ?? 'system'
    return {
      ...e,
      hash: e.hash ?? hashOf(e.text, kind, e.game ?? mem.game ?? ''),
      // 老条目也补上策略：**这样它们才能享受分型带来的好处**（比如设定类衰减变慢），
      // 但已经算出来的权重不变，所以下一次召回的分数只会朝"更合理"的方向微调。
      policy: e.policy ?? policyFor(kind),
    }
  })
  return { memory: { ...mem, version: 2, entries }, migrated, already: false }
}

/**
 * 写入一条记忆。**按内容哈希去重**：命中已有条目就强化它，而不是新增。
 *
 * ★ V2 变了三处：
 *   ① 去重键从"指纹"换成**内容哈希**（`hashOf`）—— 指纹是拼字符串，长文本下
 *      既贵又容易被标点差异绕过；哈希把"同一件事的不同说法"稳定地映射到同一个键。
 *      为了兼容旧库，找不到 hash 命中时会回退去比 fingerprint。
 *   ② 写入时把该类别的策略（`policy`）**戳在条目上**。这样每个条目的衰减/强化
 *      行为在写入那一刻就固定了，后续调整策略表不会让老记忆的表现发生漂移。
 *   ③ 基础权重取 `max(调用方给的, 该类别下限)` —— 玩家说的话不该因为调用方忘了传
 *      weight 就退化成普通流水账。
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
  const policy = policyFor(kind)
  // 权重：调用方给的值与类别下限取高者（承认"这句话本身就有分量"）
  const given = Number.isFinite(item.weight) ? clamp01(item.weight) : null
  const weight = given === null ? Math.max(0.4, policy.weight) : Math.max(given, 0)
  const at = Number.isFinite(item.at) ? item.at : null
  const game = item.game ?? m.game ?? null
  const fingerprint = `${kind}|${game ?? ''}|${normalizeText(text)}`
  const hash = item.hash ?? hashOf(text, kind, game ?? '')
  // ★ 允许调用方直接带 `count` 进来：consolidate 已经把"一局里同一件事出现了几次"折叠算好了，
  //   若不带进来，"这事发生了 30 次"这个事实会在压缩那一步丢掉（本来 ×N 就是为了保留它）。
  const inc = Number.isFinite(item.count) && item.count > 0 ? Math.floor(item.count) : 1

  // 哈希优先；同一库里的老条目可能还没 hash，所以再比一次 fingerprint
  let existing = m.entries.findIndex((e) => e.hash === hash)
  if (existing < 0) existing = m.entries.findIndex((e) => e.fingerprint === fingerprint)
  if (existing >= 0) {
    const prev = m.entries[existing]
    const merged = {
      ...prev,
      hash: prev.hash ?? hash,
      policy: prev.policy ?? policy,
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
      id: item.id != null ? String(item.id) : makeId(hash, m.entries.length),
      hash,
      fingerprint,
      kind,
      policy,
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
 * @param {{now?:number, game?:string, session?:string, maxPerSession?:number, durationMs?:number,
 *          dropHashes?:Set<string>|string[]}} [ctx]
 *        dropHashes —— 这些 hash 的个体记忆**不要写入**（汇总照样写）。
 *        ★ 这是给「LLM 评分过滤」用的：评分必须在**写入之前**做，
 *        否则候选一进库就变成"重复"，评分模型再也看不到它们（这个顺序踩过）。
 *        把决定表达成"写入时跳过哪些 hash"，就把压缩逻辑仍然留在了这一处。
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
  const drop = ctx.dropHashes instanceof Set
    ? ctx.dropHashes
    : new Set(Array.isArray(ctx.dropHashes) ? ctx.dropHashes : [])
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
    // ★ 评分判定为"不值得记"的那些，在这里就被拦下 —— 不进记忆库
    .filter((k) => !drop.has(hashOf(k.text, k.kind, k.game ?? ctx.game ?? '')))

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
  // ★ V2 分型：条目自带策略就用它（写入时戳上的），没有则退回全局默认。
  //   手写/老条目没有 policy ⇒ 行为与 V1 完全一致（既有测试盯着这条）。
  const pol = entry.policy ?? null
  const halfLifeMs = pol?.halfLifeMs ?? D.halfLifeMs

  let score = entry.weight
  why.push(`权重 ${entry.weight.toFixed(2)}`)

  if (now !== null && Number.isFinite(entry.at)) {
    const age = Math.max(0, now - entry.at)
    const decay = 0.5 ** (age / halfLifeMs)
    score += decay
    why.push(`时间衰减 +${decay.toFixed(2)}${pol ? `（${entry.kind} 半衰期 ${Math.round(halfLifeMs / 86400000)} 天）` : ''}`)
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

  // 反复出现过的事（count > 1）略微加权：它显然不是偶然。
  // ★ V2：上限按类型给 —— 「存档已更新」出现 30 次也只是流水账，
  //   不该靠刷次数把自己顶到最前面（那是 V1 真实存在的问题）。
  if (entry.count > 1) {
    const cap = pol ? pol.reinforce * 0.1 : 0.3
    const bonus = Math.min(cap, 0.05 * (entry.count - 1))
    if (bonus > 0) {
      score += bonus
      why.push(`出现过 ${entry.count} 次 +${bonus.toFixed(2)}${pol && bonus >= cap ? '（已封顶）' : ''}`)
    }
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
 * 淘汰：库超过 `maxEntries` 时，按**保留分**从低到高丢。
 * 被 `pinned` 的永不淘汰 —— 那是角色卡里钉住的设定（"她的本名叫…"），不是流水账。
 *
 * ★ V2 两处变化：
 *   ① 保留分加上**分型保护分**（`policy.evictBonus`）：设定类/玩家说过的话
 *      比"存档已更新"更该活到最后，而 V1 只看权重与被命中次数，噪声照样能靠次数苟住。
 *   ② **批量淘汰**：一次腾出 `evictBatchRatio` 的比例，而不是每次超一条就全量排序。
 *      3000 条的库如果每写一条都排序，写入成本会随时长线性上升 —— 这是长跑里会咬人的坑。
 *
 * @returns {{memory:object, dropped:object[], target:number}}
 */
export function forget(mem, opts = {}) {
  const max = opts.maxEntries ?? mem.maxEntries ?? MEMORY_DEFAULTS.maxEntries
  const now = Number.isFinite(opts.now) ? opts.now : null
  const m = cloneMem(mem)
  if (m.entries.length <= max) return { memory: m, dropped: [], target: max }

  const ratio = Number.isFinite(opts.evictBatchRatio) ? opts.evictBatchRatio : MEMORY_DEFAULTS.evictBatchRatio
  // 一次腾出这么多，写进来的后续若干条都不用再排序。
  // 小库（max 很小）时 floor 为 0 ⇒ 退化成"丢一条"，与 V1 行为一致。
  const target = Math.max(1, max - Math.floor(max * ratio))

  const keepScore = (e) => {
    const pol = e.policy ?? null
    let s = e.weight
    if (now !== null && Number.isFinite(e.at)) {
      const half = pol?.halfLifeMs ?? (MEMORY_DEFAULTS.halfLifeMs * 8)
      s += 0.4 * (0.5 ** (Math.max(0, now - e.at) / half))
    }
    // 被召回过说明它曾经有用；但很老的也不再值钱
    s += Math.min(0.3, 0.02 * e.hits)
    if (pol) s += pol.evictBonus
    if (e.pinned) s += 10
    return s
  }

  const ranked = [...m.entries].sort((a, b) => keepScore(b) - keepScore(a) || String(a.id).localeCompare(String(b.id)))
  const keep = ranked.slice(0, target)
  const dropped = ranked.slice(target)
  const keepIds = new Set(keep.map((e) => e.id))
  m.entries = m.entries.filter((e) => keepIds.has(e.id))
  return { memory: m, dropped, target }
}

// ══════════════════════════════════════════════════════════════════
// ★ V2：LLM 评分过滤
// ══════════════════════════════════════════════════════════════════
// 为什么需要它：`observe` 只看得到"变了什么"，看不出"这件事对玩家意味着什么"。
// 一局里可能有几十条「角色 #2 等级 12→13」，而真正值得记住的只有那么两三件。
// 分型策略能压住噪声的量级，但**压不住"哪一条才是这次的关键"** —— 那需要读内容。
// 所以这里让模型给每条打一个 0~1 的分，低于门槛的不入长期记忆。
//
// 三条硬约束（都是被这个项目的教训逼出来的）：
//   ① **失败必须可降级**：没有模型 / 调用失败 / 返回没法解析 ⇒ 全部按分型权重正常入库，
//      绝不因为"评分服务挂了"而丢掉记忆。记忆是资产，模型是增强。
//   ② **不重复判**：已经在库里的（同 hash）直接强化，不送去评分 —— 它已经被认可过一次了，
//      而且"这事又发生了"本身就是它重要的证据。也省 token。
//   ③ **不是每一类都值得判**：`save`/`exit`/`system` 是纯流水账，判它们纯属浪费
//      （见 JUDGE_SKIP_KINDS）。省下来的额度留给真正拿不准的那些。

/** 这些类别不送 LLM 评分（纯流水账，判了也白判）。 */
export const JUDGE_SKIP_KINDS = Object.freeze(['save', 'exit', 'system'])

/**
 * 按内容哈希筛出"库里还没有的"候选。
 * @returns {{fresh:Array, dup:Array}}
 */
export function partitionByHash(mem, items = []) {
  const have = new Set((mem?.entries ?? []).map((e) => e.hash).filter(Boolean))
  const fresh = []
  const dup = []
  for (const it of items ?? []) {
    if (!it || typeof it !== 'object') continue
    const text = String(it.text ?? '').trim()
    if (!text) continue
    const kind = MEMORY_KINDS.includes(it.kind) ? it.kind : 'system'
    const game = it.game ?? mem?.game ?? ''
    const hash = it.hash ?? hashOf(text, kind, game ?? '')
    if (have.has(hash)) dup.push({ ...it, hash, kind })
    else fresh.push({ ...it, hash, kind })
  }
  return { fresh, dup }
}

/**
 * 让模型的评分结果变成权重。
 * **取 `max(分型下限, 模型给的分)`** —— 而不是直接用模型分：
 * 模型偶尔会给出很低的分数（比如它不理解这条的含义），而"玩家自己说的话"
 * 不该因为模型打低分就被当成噪声。模型可以**抬高**重要性，但不能把类别下限压掉。
 */
export function weightFromScore(kind, score) {
  const pol = policyFor(kind)
  const s = Number.isFinite(score) ? clamp01(score) : null
  return s === null ? pol.weight : Math.max(pol.weight, s)
}

/**
 * ★ 让 LLM 给一批候选记忆打分。**永不抛异常**（契约：返回 ok:false 与说明）。
 *
 * @param {Array<{kind:string,text:string}>} items
 * @param {{provider?:object, min?:number, maxItems?:number}} [opts]
 * @returns {Promise<{ok:boolean, scores:number[], notes:string[], usage:object}>}
 *          `scores[i]` 对应 items[i]；无法判定时为 null（调用方按分型权重处理）
 */
export async function judgeImportance(items, opts = {}) {
  const list = (items ?? []).filter((x) => x && String(x.text ?? '').trim() !== '')
  const notes = []
  const empty = { ok: false, scores: list.map(() => null), notes, usage: { items: 0, skipped: list.length } }
  if (list.length === 0) { notes.push('没有候选可评'); return empty }

  const provider = opts.provider
  if (!provider || typeof provider.generate !== 'function') {
    notes.push('没有可用的 provider ⇒ 不评分，全部按分型权重入库')
    return empty
  }
  if (typeof provider.available === 'function' && !provider.available()) {
    notes.push('provider 不可用（没配 key？）⇒ 不评分，全部按分型权重入库')
    return empty
  }

  const maxItems = opts.maxItems ?? MEMORY_DEFAULTS.llmJudgeMaxItems
  const picked = []
  const pickedIdx = []
  list.forEach((it, i) => {
    if (picked.length >= maxItems) return
    if (JUDGE_SKIP_KINDS.includes(it.kind)) return
    picked.push(it)
    pickedIdx.push(i)
  })
  if (picked.length === 0) {
    notes.push('候选全是不值得评分的类别（save/exit/system）⇒ 不评分')
    return { ...empty, usage: { items: 0, skipped: list.length } }
  }

  const prompt = buildJudgePrompt(picked)
  let raw
  try {
    const out = await provider.generate({ rawPrompt: prompt })
    raw = typeof out === 'string' ? out : out?.text
  } catch (e) {
    notes.push(`评分调用失败：${e.message} ⇒ 不评分，全部按分型权重入库`)
    return { ...empty, usage: { items: 0, skipped: list.length } }
  }

  const parsed = parseJudgeScores(raw, picked.length)
  if (!parsed.ok) {
    notes.push(`评分结果解析不了：${parsed.error} ⇒ 不评分，全部按分型权重入库`)
    return { ...empty, usage: { items: 0, skipped: list.length } }
  }

  const scores = list.map(() => null)
  picked.forEach((_, k) => { scores[pickedIdx[k]] = parsed.scores[k] })
  notes.push(`模型评了 ${picked.length} 条（跳过 ${list.length - picked.length} 条流水账）`)
  return { ok: true, scores, notes, usage: { items: picked.length, skipped: list.length - picked.length } }
}

/** 评分提示词。导出以便离线断言"到底发了什么"。 */
export function buildJudgePrompt(items) {
  const lines = [
    '下面是一批刚从游戏里观察到的"变化"。请给每一条打一个 0~1 的分，表示**它对理解这个玩家有多重要**。',
    '',
    '打分标准（只按这个来，不要脑补剧情）：',
    '· 0.8~1.0 —— 里程碑或情绪节点：首次通关、关键角色死亡、重要抉择、玩家自己说过的事',
    '· 0.4~0.7 —— 真实进展：推进剧情、打败 boss、拿到关键道具、解锁新区域',
    '· 0.0~0.3 —— 例行流水：反复存档、数值小幅变动、无关紧要的物品增减',
    '',
    '只输出 JSON 数组，长度与输入一致，形如 [{"i":0,"score":0.7}]。不要输出别的东西。',
    '',
    '【候选】',
  ]
  items.forEach((it, i) => lines.push(`${i}. [${it.kind}] ${String(it.text).slice(0, 160)}`))
  return lines.join('\n')
}

/**
 * 解析评分结果。宽容：认 `[{i,score}]`、认裸数字数组、认包在代码块里的 JSON。
 *
 * ★ 分数刻度是**按批判定**的，且只作用于 >1 的值：
 *   提示词要的是 0~1，但模型偶尔会按 0~10 或 0~100 给分。逐条猜是错的
 *   （同一个 `2`，在 0~10 里是 20 分、在 0~100 里是 2 分），所以整批统一判：
 *     没有任何值 >1        ⇒ 就是 0~1，原样
 *     最大值 >10           ⇒ 按百分制，>1 的值除以 100
 *     其余（有 >1 但不 >10）⇒ 按十分制，>1 的值除以 10
 *   `>1 的值才缩放` 这一点很重要：模型返回 `[0.9, 85]` 这种混着写的时候，
 *   整批除以 100 会把本来正确的 0.9 毁成 0.009。
 *
 * @returns {{ok:boolean, scores:number[], scale:number, error:string|null}}
 */
export function parseJudgeScores(raw, expected) {
  let s = String(raw ?? '').trim()
  if (s === '') return { ok: false, scores: [], scale: 1, error: '模型返回了空内容' }
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return { ok: false, scores: [], scale: 1, error: '返回里没有 JSON 数组' }
  let json
  try { json = JSON.parse(s.slice(a, b + 1)) } catch (e) { return { ok: false, scores: [], scale: 1, error: `JSON 解析失败：${e.message}` } }
  if (!Array.isArray(json) || json.length === 0) return { ok: false, scores: [], scale: 1, error: '不是一个非空数组' }

  // 先把每条读成 (下标, 原始数值)，再做刻度判定
  const pairs = []
  json.forEach((x, k) => {
    let idx = k
    let val = x
    if (x && typeof x === 'object') {
      idx = Number.isFinite(x.i) ? x.i : (Number.isFinite(x.index) ? x.index : k)
      val = x.score ?? x.value ?? x.importance
    }
    const n = Number(val)
    if (!Number.isFinite(n)) return
    if (idx < 0 || idx >= expected) return
    pairs.push([idx, n])
  })
  if (pairs.length === 0) return { ok: false, scores: [], scale: 1, error: '数组里没有可用的分数' }

  const over1 = pairs.map(([, n]) => n).filter((n) => n > 1)
  const scale = over1.length === 0 ? 1 : (Math.max(...over1) > 10 ? 100 : 10)

  const out = new Array(expected).fill(null)
  for (const [idx, n] of pairs) out[idx] = clamp01(n > 1 ? n / scale : n)
  return { ok: true, scores: out, scale, error: null }
}

/**
 * ★ V2 入库主流程：hash 去重 → LLM 评分过滤 → 写入（命中强化）→ 批量淘汰。
 *
 * 与 `rememberEvents` 的区别：那个是**同步**的、不评分；这个需要 provider，且是异步的。
 * 会话层在"一局结束压缩"时用这个，日常的逐条写入仍走同步路径（不阻塞）。
 *
 * @param {object} mem
 * @param {object[]} items
 * @param {{provider?:object, now?:number, game?:string, session?:string,
 *          min?:number, maxEntries?:number, judge?:boolean}} [opts]
 * @returns {Promise<{memory:object, admitted:number, reinforced:number, filtered:number,
 *                    judged:number, dropped:number, notes:string[]}>}
 */
export async function rememberScored(mem, items = [], opts = {}) {
  const notes = []
  let m = cloneMem(mem)

  const { fresh, dup } = partitionByHash(m, items)
  if (dup.length) notes.push(`${dup.length} 条与已有记忆同 hash ⇒ 直接强化（不评分）`)

  // 重复的先强化：它们已经通过过一次，而且"又发生了"本身就是重要的证据
  for (const it of dup) {
    m = remember(m, { ...it, at: Number.isFinite(opts.now) ? opts.now : it.at })
  }

  let judged = 0
  let filtered = 0
  let admitted = 0
  const scored = new Map()

  if (opts.judge !== false && fresh.length) {
    const r = await judgeImportance(fresh, { provider: opts.provider, maxItems: opts.llmJudgeMaxItems })
    for (const n of r.notes) notes.push(n)
    if (r.ok) {
      judged = fresh.length
      const min = Number.isFinite(opts.min) ? opts.min : MEMORY_DEFAULTS.llmJudgeMin
      fresh.forEach((it, i) => {
        const s = r.scores[i]
        if (s === null || s === undefined) return
        if (s < min) { filtered++; scored.set(it.hash, { s, drop: true }) } else scored.set(it.hash, { s, drop: false })
      })
      if (filtered) notes.push(`${filtered} 条低于门槛 ${min} ⇒ 不入长期记忆`)
    }
  }

  for (const it of fresh) {
    const dec = scored.get(it.hash)
    if (dec?.drop) continue
    const weight = dec ? weightFromScore(it.kind, dec.s) : undefined
    m = remember(m, {
      ...it,
      at: Number.isFinite(opts.now) ? opts.now : it.at,
      game: it.game ?? opts.game,
      session: it.session ?? opts.session,
      ...(weight === undefined ? {} : { weight }),
    })
    admitted++
  }

  const f = forget(m, { now: opts.now, maxEntries: opts.maxEntries })
  if (f.dropped.length) notes.push(`超出容量 ⇒ 淘汰 ${f.dropped.length} 条（保留 ${f.memory.entries.length} 条）`)

  return {
    memory: f.memory,
    admitted,
    reinforced: dup.length,
    filtered,
    judged,
    dropped: f.dropped.length,
    notes,
  }
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
