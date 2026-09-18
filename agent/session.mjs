// agent/session.mjs —— 一次「陪玩会话」：把读游戏 / 该不该说 / 记住 串起来
//
// 为什么要有这一层（而不是让 app 自己拼）：
//   `gameio/observe.mjs` 只管「读游戏 → 事件」，
//   `core/presence.mjs` 只管「该不该开口」，
//   `core/memory.mjs`   只管「写 / 召回 / 淘汰」。
//   三者之间的时序与状态归属（谁在什么时候写记忆、capability 怎么变成档位、
//   一局什么时候该压缩成记忆）必须有一个地方统一负责，否则会散在界面代码里。
//
// ★ 三处关键约定：
//   1. **档位由 capability 决定，不由用户偏好决定**（见 core/presence.mjs 的 resolvePolicy）。
//      本层把 observe 实测出的 capability 直接喂进去，于是"读不出内容的游戏被封顶在保守档"
//      是自动发生的，不需要界面去判断。
//   2. **记忆在一局结束时压缩**（endSession → consolidate），不是每条事件都入库。
//      一局可能上百条事件，全留下等于没记忆。
//   3. **写入记忆的时间用"观察到"的时刻**，不是游戏内时刻 —— Godot/Unity 的日志根本没有时间戳。
//
// 所有函数都是纯函数（返回新 session、不改入参），且不读系统时间（`now` 一律由调用方传）。

import { createStore, observe } from '../gameio/observe.mjs'
import {
  initPresence, step as presenceStep, resolvePolicy, summarize as presenceSummary,
} from '../core/presence.mjs'
import { initState, applyEvents, countTurn, describeState } from '../core/persona.mjs'
import { buildRequest } from '../dialogue/base.mjs'
import { createDialogue } from '../dialogue/index.mjs'
import {
  createMemory, rememberEvents, rememberAll, remember, consolidate, recall, digest, markRecalled, forget, stats, startSession,
  judgeImportance, hashOf, MEMORY_DEFAULTS,
} from '../core/memory.mjs'
import { triggerFromEvent } from '../gameio/base.mjs'

export const SESSION_DEFAULTS = Object.freeze({
  level: 'moderate',        // 用户/角色卡想要的主动档位（会被 capability 封顶）
  affinity: 0.3,
  pendingCap: 200,          // 一局里最多暂存多少条待压缩事件
})

/**
 * 建一次会话。
 * @param {object} opts
 * @param {string} [opts.dir]       游戏目录
 * @param {string} [opts.game]      游戏标识（记忆按它归属）
 * @param {'conservative'|'moderate'} [opts.level]
 * @param {number} [opts.affinity]
 * @param {object} [opts.store]     `observe` 的监视状态（跨进程要持久化）
 * @param {object} [opts.memory]    既有记忆库（跨会话复用）
 * @param {object} [opts.presence]  既有人格状态
 * @param {number} [opts.now]
 */
export function createSession(opts = {}) {
  const game = opts.game ?? null
  // ★ 必须走 startSession 才能让会话编号递增。
  //   最初这里直接读 `memory.sessionCount ?? 0` 来拼 id，但没有任何地方递增它，
  //   于是每一局都叫 's1' —— 记忆里就再也分不出"这件事是哪一局发生的"。
  //   startSession 返回的是**新** memory，所以本函数仍然是纯的。
  const base = opts.memory ?? createMemory({ game })
  const started = startSession(base)
  return {
    dir: opts.dir ?? null,
    game,
    level: opts.level ?? SESSION_DEFAULTS.level,
    // 一局的编号：用来把这一局的事件归到一起（记忆里能区分"哪一局"）
    sessionId: opts.sessionId ?? started.session,
    store: opts.store ?? createStore(),
    memory: started.memory,
    // ★ 两个状态是不同的东西，别混：
    //   presence  —— 时机状态（谨慎度 / 冷却 / 预算），决定"该不该说"
    //   persona   —— 人格状态（mood / affinity / 剧情进度），决定"用什么口吻说"
    presence: opts.presence ?? initPresence({ affinity: opts.affinity ?? SESSION_DEFAULTS.affinity }),
    card: opts.card ?? null,
    persona: opts.card ? (opts.personaState ?? initState(opts.card)) : null,
    dialogue: opts.dialogue ?? createDialogue({ provider: opts.provider ?? 'template', providerOptions: opts.providerOptions }),
    policy: null,
    capability: null,
    engine: null,
    pendingEvents: [],   // 本局待压缩的事件
    at: Number.isFinite(opts.now) ? opts.now : null,
    baselineDone: false,
  }
}

/**
 * 推进一次。**这是唯一改变会话状态的入口。**
 *
 * @param {object} session
 * @param {object} input
 * @param {number} input.now          当前时间（毫秒，必填）
 * @param {boolean} [input.gameRunning] 游戏进程是否在跑（决定"专注中"）
 * @param {number} [input.idleSec]    系统空闲秒数（**Unity 场景下唯一可靠的"已松懈"信号**）
 * @param {string} [input.reply]      玩家刚说的话（有值就当作"回应了"，并写进记忆）
 * @param {object} [input.patterns]   每游戏日志规则
 * @param {object} [input.saveRules]  每游戏存档规则
 * @returns {{session:object, speak:object|null, act:object|null, events:object[], notes:string[]}}
 */
export function tick(session, input = {}) {
  const now = Number.isFinite(input.now) ? input.now : session.at
  const notes = []
  const s = { ...session, at: now }

  // ---------- 1) 读游戏 ----------
  let events = []
  if (s.dir) {
    const r = observe(s.dir, {
      store: s.store,
      now,
      patterns: input.patterns,
      saveRules: input.saveRules,
      systemNames: input.systemNames,
    })
    events = r.events
    s.store = r.store
    s.capability = r.capability
    s.engine = r.engine
    if (r.baselineOnly) { s.baselineDone = true; notes.push('首帧只建立基线，不产事件') }
    for (const n of r.notes) notes.push(n)
  }

  // ---------- 2) capability → 档位（读不出信息就自动封顶） ----------
  s.policy = resolvePolicy({ level: s.level, capability: s.capability ?? undefined })
  if (s.policy.capped) notes.push(`档位被封顶：${s.policy.why}`)

  // ---------- 3) 事件写进"本局待压缩"，不直接入长期记忆 ----------
  //
  // ⚠ 这里原先写的是 `merged.slice(-pendingCap)` —— 超上限就把**最老的悄悄扔掉**。
  //   长跑实测暴露了它的后果：一个连打几小时不退出游戏的玩家，
  //   前面的事件会被无声丢弃，而且因为记忆只在一局结束时才写，
  //   那一局前半段的经历**根本没有落盘的机会**（应用一关就全没了）。
  //   现在改成：**先压缩最早的那批进长期记忆**，再截断。
  //   代价是同一局可能产生多条摘要；但"少记一点"远好过"悄悄丢一堆"。
  if (events.length) {
    let merged = [...s.pendingEvents, ...events]
    if (merged.length > SESSION_DEFAULTS.pendingCap) {
      const overflow = merged.length - SESSION_DEFAULTS.pendingCap
      const oldest = merged.slice(0, overflow)
      const { memory, summary } = consolidate(s.memory, oldest, { now, sid: s.sessionId })
      s.memory = memory
      s.midSessionSummaries = [...(s.midSessionSummaries ?? []), summary]
      merged = merged.slice(overflow)
      notes.push(`待压缩队列超过 ${SESSION_DEFAULTS.pendingCap} 条 ⇒ 先把最早 ${overflow} 条压成记忆（免得被静默丢弃）`)
      if (summary?.text) notes.push(`中途摘要：${summary.text}`)
    }
    s.pendingEvents = merged
    // 同时作用到人格状态上（mood / 剧情进度）—— 这是"角色会为战况有反应"的唯一入口，
    // 也是 dialogue 层挑口吻的依据。模型不许改它。
    if (s.persona) s.persona = applyEvents(s.persona, events)
  }

  // ---------- 4) 触发 → 时机引擎 ----------
  let speak = null
  let act = null
  let presence = s.presence
  // 玩家**主动**搭话（点了桌宠 / 打开对话窗）：这不是打扰，走单独的通道（不节流、不计指标）
  if (input.manual === true) {
    const r = presenceStep(presence, { type: 'manual', at: now, summary: input.summary }, s.policy)
    presence = r.state
    if (r.speak) speak = r.speak
    for (const n of r.notes) notes.push(n)
  }

  const triggers = events.map((e) => triggerFromEvent(e)).filter(Boolean)
  for (const tr of triggers) {
    const r = presenceStep(presence, tr, s.policy)
    presence = r.state
    if (r.speak && !speak) speak = r.speak
    if (r.act) act = r.act
  }

  // 玩家回应 / 空转心跳
  if (typeof input.reply === 'string' && input.reply.trim() !== '') {
    const r = presenceStep(presence, { type: 'reply', at: now }, s.policy)
    presence = r.state
    // 互动才抬 affinity（见 persona 的设计：战况不改亲密度，否则角色会显得势利）
    if (s.persona) s.persona = countTurn(s.persona)
    s.memory = remember(s.memory, {
      at: now, kind: 'player-said', text: input.reply.trim(),
      weight: 0.7, game: s.game, session: s.sessionId,
    })
    notes.push('玩家回应了：谨慎度回落，并把这句话记下')
  } else {
    const r = presenceStep(presence, {
      type: 'tick', at: now,
      idleSec: input.idleSec ?? 0,
      gameRunning: input.gameRunning === true,
    }, s.policy)
    presence = r.state
    if (r.act) act = r.act
    if (r.speak && !speak) speak = r.speak
  }

  s.presence = presence

  // ---------- 5) 真要开口时，把"用过的记忆"记上（念叨惩罚才会生效） ----------
  let memoryText = ''
  let memoryUsed = []
  if (speak) {
    const d = digest(s.memory, { terms: speak.summaries.flatMap(splitTerms), now, game: s.game }, { now })
    memoryText = d.text
    memoryUsed = d.used
    s.memory = markRecalled(s.memory, d.used, now)
    if (d.used.length) notes.push(`本次开口参考了 ${d.used.length} 条既有记忆`)
  }

  return {
    session: s,
    speak: speak ? { ...speak, memoryText, memoryUsed } : null,
    act,
    events,
    notes,
  }
}

/**
 * ★ 把「该不该说」的决策变成**一句真的话**。
 *
 * 刻意与 `tick` 分开：tick 是纯同步的决策（好测、不依赖网络），
 * 而表达层可能要走网络（LLM provider）。分开之后：
 *   · 决策逻辑的回归测试完全离线、可复现
 *   · 网络慢/失败只影响"这句怎么说"，不影响"该不该说"的判断
 *
 * @param {object} tickResult - tick() 的返回值
 * @param {object} [opts]
 * @param {object} [opts.dialogue] 覆盖会话里的表达器
 * @param {number} [opts.seed]
 * @returns {Promise<{ok:boolean, text:string|null, providerId:string|null, notes:string[]}>}
 */
export async function utter(tickResult, opts = {}) {
  const session = tickResult?.session
  const speak = tickResult?.speak
  if (!speak) return { ok: false, text: null, providerId: null, notes: ['本次不需要开口'] }

  const dialogue = opts.dialogue ?? session?.dialogue
  if (!dialogue) return { ok: false, text: null, providerId: null, notes: ['没有配置表达层'] }
  const active = dialogue.active?.()
  if (!active) return { ok: false, text: null, providerId: null, notes: ['所有表达 provider 都不可用'] }

  const req = buildRequest({
    card: session.card,
    state: session.persona,
    trigger: speak,
    memoryText: speak.memoryText,
    memoryUsed: speak.memoryUsed,
    now: session.at,
    seed: opts.seed,
  })
  const r = await dialogue.speak(req, { seed: opts.seed })
  return { ...r, request: req }
}

/**
 * ★ 一局结束 → 把本局事件压缩成记忆。
 * 「退出游戏后带着刚才的记忆继续聊」就是靠这一步成立的。
 *
 * @param {object} session
 * @param {{now?:number, durationMs?:number}} [opts]
 * @returns {{session:object, summary:object|null, kept:object[], notes:string[]}}
 */
export function endSession(session, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : session.at
  const notes = []
  const s = { ...session, at: now }

  const { memory, summary, kept } = consolidate(s.memory, s.pendingEvents, {
    now, game: s.game, session: s.sessionId, durationMs: opts.durationMs,
    dropHashes: opts.dropHashes,
  })
  s.memory = memory
  s.pendingEvents = []
  // 顺手淘汰一次（记忆库不能无限涨）
  const { memory: pruned, dropped } = forget(s.memory, { now })
  s.memory = pruned
  if (dropped.length) notes.push(`记忆库淘汰了 ${dropped.length} 条低权重条目`)

  // ★ 记忆 V2：让「记忆评分」那个用途的模型给个体候选打一次分，低于门槛的不入长期记忆。
  //   放在**异步版**（endSessionScored）里做，所以这个同步入口的行为完全没变 ——
  //   既有调用点与测试都不受影响。
  if (summary) notes.push(`本局压缩成 1 条汇总 + ${kept.length} 条个体记忆`)
  else notes.push('本局没有可压缩的事件')

  return { session: s, summary, kept, notes }
}

/**
 * ★ 一局结束（带记忆评分）：**先评分、后写入**，低分的不进长期记忆。
 *
 * ⚠ 顺序是这个函数存在的全部理由。第一版写成"先 endSession 落库，再拿 kept 去评分"，
 *   结果是：候选一进库就与自身成为"重复 hash"，评分模型**一条都看不到**，
 *   日志里只会出现「N 条与已有记忆同 hash ⇒ 直接强化（不评分）」——
 *   功能看起来在跑，实际什么都没过滤。所以这里：
 *     ① 先在**临时记忆库**上 dry-run 一次压缩，只为拿到"候选有哪些"
 *     ② 让模型给候选打分
 *     ③ 带着"要跳过的 hash"真正跑一遍 endSession（压缩逻辑仍然只有一处）
 *
 * @param {object} session
 * @param {{now?:number, durationMs?:number, judgeProvider?:object, min?:number}} [opts]
 * @returns {Promise<{session:object, summary:object|null, kept:object[], notes:string[],
 *                    judged:number, filtered:number}>}
 */
export async function endSessionScored(session, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {}
  const now = Number.isFinite(o.now) ? o.now : session.at
  if (!o.judgeProvider || (session.pendingEvents ?? []).length === 0) {
    const base = endSession(session, { now: o.now, durationMs: o.durationMs })
    const notes = [...base.notes]
    if (base.kept.length && !o.judgeProvider) notes.push('没有可用的评分模型 ⇒ 按分型权重正常入库')
    return { ...base, notes, judged: 0, filtered: 0 }
  }

  // ① dry-run：只为拿候选，不碰真实记忆库
  const dry = consolidate(createMemory({ game: session.game }), session.pendingEvents, {
    now, game: session.game, session: session.sessionId, durationMs: o.durationMs,
  })
  const candidates = dry.kept
  if (candidates.length === 0) {
    const base = endSession(session, { now: o.now, durationMs: o.durationMs })
    return { ...base, notes: [...base.notes, '本局没有可评分的个体候选'], judged: 0, filtered: 0 }
  }

  // ② 评分
  let scores = null
  const judgeNotes = []
  try {
    const r = await judgeImportance(candidates, { provider: o.judgeProvider })
    for (const n of r.notes) judgeNotes.push(n)
    if (r.ok) scores = r.scores
  } catch (e) {
    judgeNotes.push(`记忆评分失败（${e.message}）⇒ 按分型权重正常入库`)
  }

  const min = Number.isFinite(o.min) ? o.min : MEMORY_DEFAULTS.llmJudgeMin
  const dropHashes = new Set()
  if (scores) {
    candidates.forEach((c, i) => {
      const s = scores[i]
      if (s === null || s === undefined) return
      if (s < min) dropHashes.add(hashOf(c.text, c.kind, c.game ?? session.game ?? ''))
    })
  }

  // ③ 真正写入（带上"要跳过的 hash"）
  //    刻意**不**用模型分数去改权重：权重已经由分型策略给定，而"评分"这一环
  //    在需求里管的是**过滤**。多一套按分调权的逻辑只会让权重来源变模糊。
  const base = endSession(session, { now: o.now, durationMs: o.durationMs, dropHashes })
  const notes = [...base.notes, ...judgeNotes]
  if (dropHashes.size) notes.push(`${dropHashes.size} 条低于门槛 ${min} ⇒ 不入长期记忆`)
  return {
    ...base,
    notes,
    judged: scores ? candidates.length : 0,
    filtered: dropHashes.size,
  }
}

/**
 * ★ 「我闭嘴」：由**表达层/模型**主动取消待发言（对应 LLM 的 cancel 工具）。
 *
 * 与"外部活动打断"（`activity`）分开：那个是玩家动了，这个是角色自己判断不该说。
 * 指标里也分开记（`canceledBySelf` vs `canceled`）——
 * **"它学会闭嘴"与"它被打断"是两件不同的事**，混在一起就看不出它有没有在自我克制。
 *
 * @param {object} session
 * @param {{now?:number, reason?:string}} [opts]
 */
export function cancelSpeech(session, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {}
  const at = Number.isFinite(o.now) ? o.now : session.at
  const r = presenceStep(session.presence, { type: 'cancel', at, reason: o.reason }, session.policy)
  return {
    session: { ...session, at, presence: r.state, action: null },
    notes: r.notes ?? [],
  }
}

/** 退出之后仍能说上来点什么 —— 这是"带着记忆继续聊"的读取端。 */
export function recallFor(session, query = {}, opts = {}) {
  const q = {
    terms: typeof query === 'string' ? splitTerms(query) : query.terms,
    kinds: query.kinds,
    now: opts.now ?? session.at,
    game: session.game,
  }
  const used = recall(session.memory, q, opts)
  return { used, text: digest(session.memory, q, { ...opts, now: opts.now ?? session.at }).text }
}

/** 会话概况（给界面与测试用）。 */
export function describeSession(session) {
  const p = presenceSummary(session.presence, { policy: session.policy })
  return {
    game: session.game,
    sessionId: session.sessionId,
    engine: session.engine,
    capability: session.capability ? [...session.capability.readable] : [],
    level: session.policy?.level ?? null,
    capped: session.policy?.capped ?? false,
    pendingEvents: session.pendingEvents.length,
    memory: stats(session.memory),
    hasCard: Boolean(session.card),
    provider: session.dialogue?.active?.()?.id ?? null,
    mood: session.persona?.mood ?? null,
    affinity: session.persona?.affinity ?? null,
    presence: {
      spoke: p.spoke, triggers: p.triggers, merged: p.merged,
      spokeWhileFocused: p.spokeWhileFocused, caution: p.caution,
      speaksPerHour: p.speaksPerHour,
    },
  }
}

/** 中文没空格 ⇒ 按标点/空白切，再补整串（与 core/memory.mjs 的切法保持一致）。 */
function splitTerms(s) {
  const t = String(s ?? '').trim()
  if (t === '') return []
  const parts = t.split(/[\s，。、！？；：,.!?;:]+/).filter((x) => x.length >= 2)
  return parts.length ? parts : (t.length >= 2 ? [t] : [])
}
