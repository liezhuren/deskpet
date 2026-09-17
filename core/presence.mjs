// core/presence.mjs —— 时机引擎：什么时候可以开口（本项目差异化最强的一层）
//
// 用户原话（决定了这一层存在的理由）：
//   「希望达到的效果是类似于用户好不容易打败了一个 boss，存好档的松懈时间和他交流，
//     或者是角色死亡后与用户交流，这样的度再加上读取日志和存档的局限应该是刚刚好的。」
//
// 这个「度」如果只是"调个冷却时间"，那它无法被证明是对的。所以本模块把它拆成：
//   · 可解释的规则（三层闸门）
//   · 可观测的指标（见 summarize / replay）—— 用数字回答「是不是刚刚好」
//
// ═══════════════════════════════════════════════════════════════════
// 两条来自实测的关键判断（不是拍脑袋，见 docs/ARCHITECTURE.md §2、§5）
// ═══════════════════════════════════════════════════════════════════
//
// ① 【玩家专不专心，不能靠日志活动判断】
//    实测：Unity 的 Player.log 在进行游戏时几乎不产出内容（单个文件 6MB 全是引擎噪声），
//    所以"存档之后有没有新的日志行"根本区分不出「打完 boss 放下手柄」和「接着打下一段」。
//    真正的判据是**系统空闲时长**（Electron 的 powerMonitor.getSystemIdleTime()）。
//    因此本模块把「静默判定」拆成两个独立信号：
//      · activity —— 文件/日志层面的新动静。用来合并存档写入的突发，以及 Godot/RPG Maker
//                    这类日志确实有内容的引擎。
//      · relaxed  —— 玩家多久没有键鼠输入了。**这是 Unity 场景下唯一可靠的「已松懈」信号。**
//    要开口，必须 relaxed 够了；只有 activity 停了是不够的。
//
// ② 【调整空间必须被「实际读得到什么」框住】
//    用户要求「留给用户调整的空间」，但同时说「如果真的读不出信息，还是只给保守选项」。
//    这是对的：把档位调高却读不到新东西，等于逼桌宠编内容，直接违反「只报事实」。
//    所以 capability（这个 adapter 到底能读出哪些事件类型）**决定档位上限**：
//    只读得到 save / exit / manual 的 adapter，无论用户怎么调，都封顶在保守档。
//    见 resolvePolicy 与 RELIABLE_KINDS。
//
// ═══════════════════════════════════════════════════════════════════
// 三层闸门（缺一不可）
// ═══════════════════════════════════════════════════════════════════
//   1) 去抖 + 显著性：游戏自动存档可能每 30s 一次，且一次存档常写多个文件
//      → mergeWindowMs 内合并；significance 低于门槛的事件直接不算数
//   2) 静默判定：触发后等 settleMs，期间若有新活动就取消（玩家还在玩）
//      → 再加上 relaxed（空闲）判据，见判断 ①
//   3) 节流 + 预算：同类冷却、全局冷却、每小时发言上限
//      → 且全部被 caution（被忽略越多越谨慎）与 affinity（越生疏越克制）缩放
//
// ★ 发言与动作是两个通道，刻意分开：
//   动作（无聊时换个姿势）几乎不打扰人，可以频繁；发言会打断人，必须稀缺。
//   用户要的「长时间不理人做出无聊的动作」属于动作通道，不走发言预算。

// ---------- 档位预设 ----------

/**
 * 三个档位。**注意 moderate 及以上是否生效取决于 capability**（见 resolvePolicy）。
 * 数值都是可调的，这里给的是"保守优先"的默认值。
 */
export const LEVELS = Object.freeze({
  conservative: Object.freeze({
    settleMs: 20_000,          // 触发后等这么久，期间有新活动就取消
    mergeWindowMs: 20_000,     // 这段时间内的多次触发合成一次
    // ★ pendingTtlMs 是**新鲜度守卫**，不是节流手段 —— 这一条是被长跑实测纠正的。
    //   它回答的是"这条待发言还值不值得提"，节流是 globalCooldownMs + budgetPerHour 的职责。
    //   先前两档给的是 5min / 3min，造成一个**反直觉的倒挂**：越主动的档位越没耐心。
    //   而长跑实测（tools/longrun.mjs）显示：玩家存档后常常**继续打 3~20 分钟**才放下手柄，
    //   于是 3 分钟的 TTL 让待发言**几乎总在松懈到来之前就作废** ——
    //   `droppedExpired` 一直在涨、`spoke` 恒为 0，而"击败 boss 后存档、松懈下来搭话"
    //   恰恰是这个产品存在的理由。宁可说得晚一点，也不能把那个时刻悄悄扔掉。
    //   10 分钟是"再说'你刚存档了？'还不算离谱"的上界；超过它才作废。
    pendingTtlMs: 10 * 60_000,
    minSignificance: 0.45,     // 低于此值不算一次"值得开口"的事件
    globalCooldownMs: 10 * 60_000,
    cooldownMs: Object.freeze({ save: 25 * 60_000, death: 12 * 60_000, exit: 5 * 60_000, progress: 30 * 60_000, combat: 20 * 60_000, item: 30 * 60_000, default: 25 * 60_000 }),
    budgetPerHour: 2,
    relaxedIdleSec: 15,        // 键鼠空闲达到这个秒数才算"已松懈"
    replyWindowMs: 5 * 60_000, // 发言后多久没回应算"被忽略"
    idleActionAfterSec: 120,   // 空闲这么久 → 小动作
    boredActionAfterSec: 300,  // 再久 → 无聊动作
    actionCooldownMs: 45_000,
    cautionPerIgnore: 0.5,
    cautionDecayPerReply: 0.6,
    maxCaution: 2.5,
  }),
  moderate: Object.freeze({
    settleMs: 12_000,
    mergeWindowMs: 20_000,
    // 与 conservative 同值：TTL 是新鲜度守卫，不该随"主动程度"缩放（见保守档那段说明）。
    // 曾经这里写的是 3 分钟 —— 那让 moderate **比** conservative 更容易错过松懈时刻，
    // 与"moderate = 泄压点更灵敏"的定位正好相反。
    pendingTtlMs: 10 * 60_000,
    minSignificance: 0.35,
    globalCooldownMs: 5 * 60_000,
    cooldownMs: Object.freeze({ save: 12 * 60_000, death: 6 * 60_000, exit: 3 * 60_000, progress: 15 * 60_000, combat: 12 * 60_000, item: 20 * 60_000, default: 12 * 60_000 }),
    budgetPerHour: 5,
    relaxedIdleSec: 10,
    replyWindowMs: 5 * 60_000,
    idleActionAfterSec: 90,
    boredActionAfterSec: 240,
    actionCooldownMs: 35_000,
    cautionPerIgnore: 0.4,
    cautionDecayPerReply: 0.6,
    maxCaution: 2,
  }),
})

/**
 * **只靠文件系统与进程表就能拿到**的触发类型 —— 不需要游戏配合。
 * 一个 adapter 若只读得到这些，就说明它并不真的理解游戏内容，档位必须封顶。
 */
export const RELIABLE_KINDS = Object.freeze(['save', 'exit', 'manual'])

/** 需要 adapter **证明**它能从日志/存档里真读出来，才允许算数的类型。 */
export const ADAPTER_KINDS = Object.freeze(['death', 'progress', 'combat', 'item', 'area'])

// ---------- 能力与档位 ----------

/**
 * 由 adapter 声明的可读事件类型，推出能力描述。
 * 刻意**信任 adapter 的自述**：它能不能读出 death，应由 adapter 自己的测试去证明；
 * 本模块只负责按这个自述限制档位，不猜。
 *
 * @param {string[]} readable - adapter 声明自己能产出的 kind
 */
export function capabilityOf(readable = []) {
  const set = new Set(readable.filter((k) => typeof k === 'string'))
  // 排序后返回：顺序由内容决定，不依赖调用方的插入序 ——
  // 否则「同一个 capability 用不同顺序构造出来」会得到不相等的结果，比较和测试都会变得脆。
  const list = [...set].sort()
  const beyondFiles = list.filter((k) => !RELIABLE_KINDS.includes(k))
  return Object.freeze({
    readable: Object.freeze(list),
    beyondFiles: Object.freeze(beyondFiles),
    // 只有拿到「文件系统之外」的信息，才配得上更高的主动档位
    rich: beyondFiles.length > 0,
  })
}

/**
 * 把「用户想要的档位」和「这个 adapter 实际能给的信息」合起来，得出**生效档位**。
 * 这是用户那句「如果读不出信息，还是只给保守选项」的落地处。
 *
 * @param {object} req
 * @param {'conservative'|'moderate'} [req.level='conservative'] 用户/角色卡想要的档位
 * @param {object} req.capability - capabilityOf() 的结果
 * @returns {{level:string, requested:string, capped:boolean, why:string, thresholds:object}}
 */
export function resolvePolicy({ level = 'conservative', capability } = {}) {
  const requested = LEVELS[level] ? level : 'conservative'
  const cap = capability ?? capabilityOf([])
  if (requested !== 'conservative' && !cap.rich) {
    return {
      level: 'conservative',
      requested,
      capped: true,
      why: `该 adapter 只能读出「${cap.readable.join('、') || '（无）'}」，` +
        `没有文件系统之外的信号（需要 ${ADAPTER_KINDS.join(' / ')} 之一）。` +
        '读不到新东西却提高主动程度，只会逼桌宠编内容，因此封顶在保守档。',
      thresholds: LEVELS.conservative,
    }
  }
  return { level: requested, requested, capped: false, why: '', thresholds: LEVELS[requested] }
}

// ---------- 状态 ----------

/**
 * @param {object} [init]
 * @param {number} [init.affinity=0.3] 角色亲密度（0 疏远 … 1 亲近）—— 越生疏越克制
 * @param {number} [init.now=0]
 */
export function initPresence(init = {}) {
  return {
    affinity: clamp(init.affinity ?? 0.3, 0, 1),
    pending: null,            // 待发起的触发（等静默窗口）
    // 冷却刻意记「上次发言的时刻」而不是「下次允许的时刻」：
    // 因为收紧系数（caution × 亲密度）会随时间变化，必须缩放**时长**再和当前时间比。
    // 若把系数乘到绝对时间戳上，在真实 epoch 毫秒（~1.7e12）下会把冷却放大成几十年 —— 这是量纲错误。
    lastSpeakAt: null,
    lastSpeakKindAt: {},      // kind -> 上次该类型发言的时刻
    speakTimes: [],           // 用于小时预算的滑动窗口
    awaitingReplySince: null,
    ignoredStreak: 0,
    caution: 1,               // ≥1，越大越谨慎
    lastActivityAt: null,
    idleSec: 0,
    lastActionAt: null,
    // 观察窗口：第一次/最后一次收到任何输入的时刻。
    // speaksPerHour 必须按这个窗口算，否则"只说过一次话"会被算成 60 次/小时。
    observedFrom: null,
    observedTo: null,
    history: [],              // 决策记录（供指标与回归）
    stats: {
      triggers: 0, merged: 0, droppedLowSignificance: 0, droppedCanceled: 0,
      // waitedForFocus 不是失败，是"耐心"：玩家还在打，我们继续等
      waitedForFocus: 0, droppedExpired: 0, droppedNotRelaxed: 0,
      droppedCooldown: 0, droppedBudget: 0,
      spoke: 0, spokeWhileFocused: 0, actions: 0, replies: 0, ignores: 0,
      // 玩家主动搭话的次数 —— 与 spoke 分开统计（见 'manual' 分支的解释）
      answered: 0,
    },
  }
}

// ---------- 核心：一步 ----------

/**
 * 推进一步。**这是唯一改变状态的入口**，纯函数（返回新 state，不改入参）。
 *
 * @param {object} state - initPresence() 的状态
 * @param {object} input - 以下之一：
 *   { type:'trigger',  at, kind, significance, summary, focused? }  存档写入 / 死亡 / 退出 / 进度…
 *   { type:'activity', at }                                          文件或日志出现新动静
 *   { type:'tick',     at, idleSec, gameRunning }                    时间推进（心跳，建议 1s 一次）
 *   { type:'reply',    at }                                          玩家回应了
 * @param {object} policy - resolvePolicy() 的结果
 * @returns {{state:object, speak:object|null, act:object|null, notes:string[]}}
 */
export function step(state, input, policy) {
  const th = policy.thresholds
  const s = clone(state)
  const notes = []
  let speak = null
  let act = null

  if (Number.isFinite(input.at)) {
    if (s.observedFrom === null) s.observedFrom = input.at
    s.observedTo = input.at
  }

  switch (input.type) {
    case 'trigger': {
      s.stats.triggers++
      const sig = Number(input.significance ?? 0.5)
      if (sig < th.minSignificance) {
        s.stats.droppedLowSignificance++
        notes.push(`显著性 ${sig.toFixed(2)} < 门槛 ${th.minSignificance}，不算数`)
        break
      }
      if (s.pending && input.at - s.pending.at <= th.mergeWindowMs) {
        // 合并：取更高的显著性；摘要累加（桌宠开口时可以一次提到两件事）
        s.pending = {
          ...s.pending,
          significance: Math.max(s.pending.significance, sig),
          summaries: uniq([...s.pending.summaries, input.summary].filter(Boolean)),
          dueAt: input.at + th.settleMs,
          mergedCount: s.pending.mergedCount + 1,
        }
        s.stats.merged++
        notes.push(`与上一个触发合并（窗口 ${th.mergeWindowMs}ms）`)
        break
      }
      s.pending = {
        kind: input.kind, firstAt: input.at, at: input.at, dueAt: input.at + th.settleMs,
        expiresAt: input.at + (th.pendingTtlMs ?? 5 * 60_000),
        significance: sig, summaries: input.summary ? [input.summary] : [], mergedCount: 1,
      }
      notes.push(`记下触发 ${input.kind}，${th.settleMs}ms 后若仍静默才可能开口`)
      break
    }

    case 'activity': {
      s.lastActivityAt = input.at
      // 静默窗口内出现新动静 ⇒ 玩家还在玩 ⇒ 这个泄压点过去了。
      // 这不是"失败"，而是设计：ARCHITECTURE §3 原则 P1 —— 宁可不说。
      if (s.pending && input.at < s.pending.dueAt) {
        notes.push(`静默窗口内又有活动（${input.kind ?? 'activity'}），取消本次触发`)
        s.pending = null
        s.stats.droppedCanceled++
      }
      break
    }

    case 'tick': {
      if (Number.isFinite(input.idleSec)) s.idleSec = input.idleSec
      const focused = input.gameRunning === true && s.idleSec < th.relaxedIdleSec

      // ① 待发言的处理。**这是本模块最容易做错的一处**：
      //    「到了静默窗口但玩家还在玩」绝不能把待发言丢掉 —— 按用户原话，存档后接着打一会儿、
      //    再放下手柄，那**依然是**松懈时间。丢掉就等于要求玩家必须在存档后 20 秒内停手，太苛刻。
      //    所以：专注 ⇒ 继续等（记 waitedForFocus）；等到 pendingTtlMs 还没等到 ⇒ 才作废。
      if (s.pending) {
        const p = s.pending
        if (input.at >= p.expiresAt) {
          s.pending = null
          s.stats.droppedExpired++
          if (focused) s.stats.droppedNotRelaxed++
          notes.push(`触发已等待 ${Math.round((input.at - p.firstAt) / 1000)}s 仍未等到松懈，作废`)
          s.history = [...s.history, { at: input.at, kind: p.kind, decision: 'expired', reasons: ['ttl'] }]
        } else if (input.at >= p.dueAt) {
          const verdict = gate(s, p, input.at, focused, th)
          if (verdict.wait) {
            // 不是失败：玩家还在打，我们继续等（见上面那段注释）
            s.stats.waitedForFocus++
            notes.push(verdict.why)
          } else if (verdict.ok) {
            speak = {
              at: input.at, kind: p.kind, summaries: p.summaries, significance: p.significance,
              mergedCount: p.mergedCount,
              // 延迟 = 开口时刻 − 触发**第一次**出现的时刻（合并过的话按第一次算），
              // 这正是"等松懈"造成的等待，是时机引擎最该被观测的量。
              triggerLatencyMs: input.at - p.firstAt,
            }
            s.pending = null
            s.stats.spoke++
            if (focused) s.stats.spokeWhileFocused++ // 正常永远为 0；不为 0 就是回归信号
            s.speakTimes = [...s.speakTimes, input.at]
            s.lastSpeakAt = input.at
            s.lastSpeakKindAt = { ...s.lastSpeakKindAt, [p.kind]: input.at }
            s.awaitingReplySince = input.at
            s.history = [...s.history, {
              at: input.at, kind: p.kind, decision: 'speak', reasons: verdict.reasons,
              triggerLatencyMs: input.at - p.firstAt,
            }]
          } else {
            s.pending = null
            s.stats[verdict.stat] = (s.stats[verdict.stat] ?? 0) + 1
            notes.push(verdict.why)
            s.history = [...s.history, { at: input.at, kind: p.kind, decision: 'skip', reasons: verdict.reasons }]
          }
        }
      }

      // ② 被忽略判定：发言后迟迟没回应 ⇒ 变谨慎
      if (s.awaitingReplySince !== null && input.at - s.awaitingReplySince >= th.replyWindowMs) {
        s.awaitingReplySince = null
        s.ignoredStreak++
        s.caution = Math.min(th.maxCaution, s.caution + th.cautionPerIgnore)
        s.stats.ignores++
        notes.push(`上次发言 ${th.replyWindowMs}ms 内没有回应，谨慎度升到 ${s.caution.toFixed(2)}`)
      }

      // ③ 动作通道（与发言完全分开，不占预算）
      const action = pickAction(s, input, th)
      if (action) {
        act = action
        s.lastActionAt = input.at
        s.stats.actions++
      }
      break
    }

    case 'reply': {
      s.stats.replies++
      s.awaitingReplySince = null
      s.ignoredStreak = 0
      s.caution = Math.max(1, s.caution * th.cautionDecayPerReply)
      notes.push(`玩家回应了，谨慎度回落到 ${s.caution.toFixed(2)}`)
      break
    }

    // ★ 玩家**主动**来找你说话（点了桌宠 / 打开对话窗）。
    //   这与"我们主动开口"是两件事，所以处理完全不同：
    //     · 不走节流（冷却 / 预算都是为了防止**打扰**；他先开的口，谈不上打扰）
    //     · 不计入主动发言指标（否则 spokeWhileFocused 与 speaksPerHour 会被用户点击污染，
    //       那两个指标就不再是"我们有多烦人"的度量了）
    //     · 顺手把"被忽略"清掉（人就在这儿，不算忽略）
    case 'manual': {
      s.stats.answered++
      s.awaitingReplySince = null
      s.ignoredStreak = 0
      s.caution = Math.max(1, s.caution * th.cautionDecayPerReply)
      speak = {
        at: input.at, kind: 'manual', manual: true,
        summaries: [typeof input.summary === 'string' && input.summary ? input.summary : '玩家主动来搭话'],
        significance: 1, mergedCount: 1, triggerLatencyMs: 0,
      }
      notes.push('玩家主动搭话 ⇒ 不节流、不计入主动发言')
      break
    }

    default:
      notes.push(`未知输入类型 ${input.type}`)
  }

  return { state: s, speak, act, notes }
}

/** 批量回放。**这是做回归的地方** —— 同一段事件流跑两遍，指标必须完全一致。 */
export function replay(timeline, { policy, init = {} } = {}) {
  const resolved = policy?.thresholds ? policy : resolvePolicy(policy ?? {})
  let state = initPresence(init)
  const speaks = []
  const acts = []
  const decisions = []
  for (const input of timeline) {
    const r = step(state, input, resolved)
    state = r.state
    if (r.speak) speaks.push(r.speak)
    if (r.act) acts.push(r.act)
    decisions.push({ at: input.at, type: input.type, speak: r.speak, act: r.act, notes: r.notes })
  }
  return { state, speaks, acts, decisions, metrics: summarize(state, { policy: resolved }) }
}

// ---------- 指标（用来证明"度"是对的，而不是感觉对） ----------

/**
 * 从状态算出可比较的指标。**这些数字就是"度"的验收标准。**
 * @returns {object}
 */
export function summarize(state, { policy, windowMs = 60 * 60_000 } = {}) {
  const th = policy?.thresholds ?? LEVELS.conservative
  const speaks = state.history.filter((h) => h.decision === 'speak')
  const usedTriggers = state.stats.triggers - state.stats.droppedLowSignificance

  return {
    // 每小时主动发言次数 —— 按**整个观察窗口**算，而不是按首次到末次发言之间算
    // （否则只说过一次话会被算成 60 次/小时，数字毫无意义）
    speaksPerHour: speaks.length === 0 ? 0 : speaks.length / Math.max(
      ((state.observedTo ?? 0) - (state.observedFrom ?? 0)) / windowMs, 1 / 60,
    ),
    // 从触发第一次出现到开口的平均延迟 —— 应当落在静默窗口之后，而不是立刻
    triggerLatencyMs: mean(speaks.map((h) => h.triggerLatencyMs).filter(Number.isFinite)),
    // 被使用的触发比例 —— **不该是 100%**（100% 说明太吵了）
    usedTriggerRate: usedTriggers > 0 ? speaks.length / usedTriggers : 0,
    // 连续被忽略次数
    ignoredStreak: state.ignoredStreak,
    caution: state.caution,
    // ★ 玩家专注游戏期间的发言次数：**必须为 0**
    spokeWhileFocused: state.stats.spokeWhileFocused,
    spoke: state.stats.spoke,
    triggers: state.stats.triggers,
    merged: state.stats.merged,
    canceled: state.stats.droppedCanceled,
    // 因为玩家还在专心而推迟的次数 —— 不是失败，是"在等松懈"
    waitedForFocus: state.stats.waitedForFocus,
    // 等到过期都没等到松懈（想说话但一直没机会）
    droppedExpired: state.stats.droppedExpired,
    droppedForBudget: state.stats.droppedBudget,
    droppedForCooldown: state.stats.droppedCooldown,
    actions: state.stats.actions,
    replies: state.stats.replies,
    ignores: state.stats.ignores,
    // 玩家主动搭话而被回应的次数。**不计入 speaksPerHour / spokeWhileFocused** ——
    // 那两个指标衡量的是"我们有多烦人"，被用户自己的点击污染就没意义了。
    answered: state.stats.answered ?? 0,
    spanMs: (state.observedTo ?? 0) - (state.observedFrom ?? 0),
    level: policy?.level ?? 'conservative',
    relaxedIdleSec: th.relaxedIdleSec,
  }
}

// ---------- 内部 ----------

/**
 * 三层闸门。顺序有讲究：先问"玩家松懈了吗"，再问"说过了吗"，最后问"说太多了吗"。
 * 收紧系数缩放的是**时长**，不是时间戳（见 initPresence 注释）。
 *
 * 返回值有三种：
 *   { wait: true }        —— 玩家还在专心。**不丢弃待发言**，继续等（调用方不要清 pending）
 *   { ok: false, stat }   —— 被冷却或预算挡下，这次机会作废
 *   { ok: true }          —— 可以开口
 */
function gate(s, p, at, focused, th) {
  const reasons = []
  if (focused) {
    reasons.push('player-focused')
    return { ok: false, wait: true, reasons, why: '已到静默窗口但玩家仍在游戏，继续等松懈' }
  }

  const scale = cautionScale(s, th)
  const sinceGlobal = s.lastSpeakAt === null ? Infinity : at - s.lastSpeakAt
  const sinceKind = s.lastSpeakKindAt?.[p.kind] === undefined ? Infinity : at - s.lastSpeakKindAt[p.kind]
  const globalNeed = th.globalCooldownMs * scale
  const kindNeed = cooldownFor(th, p.kind) * scale

  if (sinceGlobal < globalNeed || sinceKind < kindNeed) {
    const left = Math.max(globalNeed - sinceGlobal, kindNeed - sinceKind)
    reasons.push(sinceKind < kindNeed ? 'kind-cooldown' : 'global-cooldown')
    return { ok: false, reasons, stat: 'droppedCooldown', why: `冷却中（还需 ${Math.round(left / 1000)}s，收紧系数 ${scale.toFixed(2)}）` }
  }

  // 预算只被 caution 缩放，**不被亲密度缩放**：
  // budgetPerHour 是给用户看的硬承诺（"每小时最多说几次"），让它随亲密度悄悄减半会让这个设置失去可预期性。
  // 「越生疏越克制」体现在冷却时长上（见下面的 scale），那是柔性的。
  const budget = Math.max(1, Math.floor(th.budgetPerHour / (s.caution ?? 1)))
  const recent = s.speakTimes.filter((t) => at - t < 60 * 60_000)
  if (recent.length >= budget) {
    reasons.push('budget')
    return { ok: false, reasons, stat: 'droppedBudget', why: `本小时已发言 ${recent.length} 次（上限 ${budget}），不再开口` }
  }
  return { ok: true, reasons: ['relief-point', 'relaxed', 'within-budget'] }
}

/** 谨慎度与亲密度共同决定"收紧多少"。越生疏、越被忽略 ⇒ 越大。 */
function cautionScale(s, th) {
  const affinityFactor = 1 + (1 - s.affinity) // 亲密度 0 → ×2，亲密度 1 → ×1
  return clamp((s.caution ?? 1) * affinityFactor, 1, th.maxCaution * 2)
}

function cooldownFor(th, kind) {
  return th.cooldownMs?.[kind] ?? th.cooldownMs?.default ?? 20 * 60_000
}

/** 动作通道。空闲越久动作越"无聊"，但不占发言预算。 */
function pickAction(s, input, th) {
  if (input.gameRunning !== true) return null
  if (s.lastActionAt !== null && input.at - s.lastActionAt < th.actionCooldownMs) return null
  if (s.idleSec >= th.boredActionAfterSec) return { at: input.at, action: 'bored', idleSec: s.idleSec }
  if (s.idleSec >= th.idleActionAfterSec) return { at: input.at, action: 'idle-shift', idleSec: s.idleSec }
  return null
}

const mean = (a) => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length)

const uniq = (a) => [...new Set(a)]

const clamp = (v, lo, hi) => Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)

function clone(s) {
  return {
    ...s,
    lastSpeakKindAt: { ...s.lastSpeakKindAt },
    speakTimes: [...s.speakTimes],
    history: [...s.history],
    stats: { ...s.stats },
    pending: s.pending ? { ...s.pending, summaries: [...s.pending.summaries] } : null,
  }
}
