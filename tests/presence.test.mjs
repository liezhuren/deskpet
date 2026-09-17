// tests/presence.test.mjs —— core/presence.mjs（时机引擎）的测试
//
// ⚠ 时间戳刻意用**真实 epoch 毫秒量级**（1.7e12），不是从 0 开始的小数字。
//   理由：本模块一开始把收紧系数乘到了绝对时间戳上，在 0 起点的小时间戳下看不出来，
//   一放到真实时间戳上冷却会被放大成几十年。用真实量级的时间戳才能把这类量纲错误钉住。
//
// 这份测试就是「度」的验收标准：它断言的不只是"能跑"，而是
//   · 玩家专注游戏时**一次都不许开口**
//   · 触发不该 100% 被使用（100% 说明太吵）
//   · 被忽略会自动变安静
//   · 读不到信息的 adapter 拿不到高主动档位

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initPresence, step, replay, summarize, resolvePolicy, capabilityOf,
  LEVELS, RELIABLE_KINDS, ADAPTER_KINDS,
} from '../core/presence.mjs'

const T0 = 1_700_000_000_000 // 真实 epoch 毫秒
const sec = (n) => n * 1000
const min = (n) => n * 60_000

/** 保守档 + 只有文件系统信号的策略（最常见的真实情形）。 */
const P = (level = 'conservative', readable = [...RELIABLE_KINDS]) =>
  resolvePolicy({ level, capability: capabilityOf(readable) })

const trigger = (at, kind = 'save', significance = 0.8, summary = '存档已更新') =>
  ({ type: 'trigger', at, kind, significance, summary })
const tick = (at, idleSec = 20, gameRunning = true) => ({ type: 'tick', at, idleSec, gameRunning })
const activity = (at) => ({ type: 'activity', at })
const reply = (at) => ({ type: 'reply', at })

/** 顺序喂输入，收集发言/动作。 */
function drive(inputs, policy, init) {
  let st = initPresence(init ?? {})
  const speaks = []
  const acts = []
  for (const i of inputs) {
    const r = step(st, i, policy)
    st = r.state
    if (r.speak) speaks.push(r.speak)
    if (r.act) acts.push(r.act)
  }
  return { state: st, speaks, acts, metrics: summarize(st, { policy }) }
}

/** 「打好 boss → 存档 → 放下手柄」：最核心的那个场景。 */
function bossSaveScenario(extra = []) {
  return [
    trigger(T0, 'save', 0.8, '存档已更新'),
    ...extra,
    tick(T0 + sec(21), 22),
  ]
}

// ══════════════════ A. 档位封顶：能力决定上限，用户决定偏好 ══════════════════

test('★ 只读得到文件系统信号的 adapter，moderate 被强制封顶为 conservative', () => {
  const r = resolvePolicy({ level: 'moderate', capability: capabilityOf(RELIABLE_KINDS) })
  assert.equal(r.requested, 'moderate')
  assert.equal(r.level, 'conservative')
  assert.equal(r.capped, true)
  assert.match(r.why, /编内容/, '必须说清封顶的理由，而不是默默改掉')
  assert.equal(r.thresholds, LEVELS.conservative)
})

test('★ adapter 能读出 death 之后，moderate 才被放行', () => {
  const r = resolvePolicy({ level: 'moderate', capability: capabilityOf([...RELIABLE_KINDS, 'death']) })
  assert.equal(r.level, 'moderate')
  assert.equal(r.capped, false)
  assert.equal(r.thresholds, LEVELS.moderate)
})

test('没有任何 capability 信息时按最保守处理', () => {
  const r = resolvePolicy({ level: 'moderate' })
  assert.equal(r.level, 'conservative')
  assert.equal(r.capped, true)
})

test('未知档位名退回保守档', () => {
  assert.equal(resolvePolicy({ level: 'chatty', capability: capabilityOf(['death']) }).level, 'conservative')
})

test('capabilityOf 分类：文件系统信号 vs 需要 adapter 证明的信号', () => {
  const cap = capabilityOf([...RELIABLE_KINDS, 'progress', 'area'])
  assert.equal(cap.rich, true)
  // readable / beyondFiles 都是**排序后**的，顺序由内容决定，不受调用方插入序影响
  assert.deepEqual([...cap.beyondFiles], ['area', 'progress'])
  assert.deepEqual([...cap.readable], ['area', 'exit', 'manual', 'progress', 'save'])
  assert.equal(capabilityOf([]).rich, false)
  assert.ok(ADAPTER_KINDS.includes('death'))
})

test('capabilityOf 的顺序与插入序无关（否则比较与测试都会变脆）', () => {
  assert.deepEqual([...capabilityOf(['save', 'death', 'exit']).readable],
    [...capabilityOf(['exit', 'save', 'death']).readable])
})

// ══════════════════ B. 硬闸门：专注期绝不开口 ══════════════════

test('★ 玩家仍专注游戏时不开口，但**不丢弃**待发言，而是继续等', () => {
  const p = P()
  const r = drive([trigger(T0), tick(T0 + sec(21), 3), tick(T0 + sec(40), 3)], p)
  assert.equal(r.speaks.length, 0)
  assert.notEqual(r.state.pending, null, '还在等松懈，不该把待发言丢掉（丢了就等于要求玩家 20 秒内停手）')
  assert.equal(r.state.stats.waitedForFocus, 2)
  assert.equal(r.metrics.waitedForFocus, 2)
})

test('★ 等太久（超过 pendingTtlMs）才作废', () => {
  const p = P()
  const ttl = LEVELS.conservative.pendingTtlMs
  const r = drive([trigger(T0), tick(T0 + ttl + sec(1), 2)], p)
  assert.equal(r.speaks.length, 0)
  assert.equal(r.state.pending, null)
  assert.equal(r.state.stats.droppedExpired, 1)
  assert.equal(r.state.stats.droppedNotRelaxed, 1, '作废时若仍在专注，要记一笔"一直没等到机会"')
})

test('★ 存档后接着打两分钟再放下手柄 → 仍然开口（这才是"松懈时间"）', () => {
  const p = P()
  const r = drive([
    trigger(T0, 'save', 0.9),
    ...Array.from({ length: 12 }, (_, i) => tick(T0 + sec(10 * (i + 1)), 2)), // 专注 2 分钟
    tick(T0 + min(2) + sec(20), 40),                                          // 放下手柄
  ], p)
  assert.equal(r.speaks.length, 1)
  assert.ok(r.speaks[0].triggerLatencyMs >= min(2), '延迟体现的是"等玩家松懈"的时间')
  assert.equal(r.metrics.spokeWhileFocused, 0)
})

test('★ spokeWhileFocused 必须恒为 0（这是硬性指标）', () => {
  const p = P()
  // 一整局都在专注（空闲始终很低），期间塞满各种触发
  const inputs = []
  for (let i = 0; i < 40; i++) {
    inputs.push(tick(T0 + sec(i * 3), 2))
    if (i % 5 === 0) inputs.push(trigger(T0 + sec(i * 3) + 500, 'save', 0.9))
  }
  const r = drive(inputs, p)
  assert.equal(r.speaks.length, 0, '专注期一次都不该说')
  assert.equal(r.metrics.spokeWhileFocused, 0)
})

test('空转的 tick 不产生任何副作用', () => {
  const p = P()
  const r = drive([tick(T0, 100), tick(T0 + sec(1), 100)], p)
  assert.equal(r.speaks.length, 0)
  assert.equal(r.state.stats.triggers, 0)
})

// ══════════════════ C. 静默窗口（泄压点的判定） ══════════════════

test('★ 核心场景：存档后放下手柄 → 在静默窗口结束时开口', () => {
  const p = P()
  const r = drive(bossSaveScenario(), p)
  assert.equal(r.speaks.length, 1)
  assert.equal(r.speaks[0].kind, 'save')
  assert.equal(r.speaks[0].triggerLatencyMs, sec(21), '延迟应等于静默窗口的等待，而不是立刻开口')
  assert.equal(r.metrics.spokeWhileFocused, 0)
})

test('★ 存档后马上又继续玩 → 这次泄压点作废，不开口', () => {
  const p = P()
  const r = drive(bossSaveScenario([activity(T0 + sec(5))]), p)
  assert.equal(r.speaks.length, 0)
  assert.equal(r.state.stats.droppedCanceled, 1)
})

test('静默窗口之后才出现的活动不取消本次触发', () => {
  const p = P()
  const r = drive([trigger(T0), activity(T0 + sec(21))], p)
  assert.equal(r.state.stats.droppedCanceled, 0)
  assert.notEqual(r.state.pending, null, '窗口外的活动不该取消待发言')
})

test('还没到静默窗口就 tick，不会提前开口', () => {
  const p = P()
  const r = drive([trigger(T0), tick(T0 + sec(5), 60)], p)
  assert.equal(r.speaks.length, 0)
  assert.notEqual(r.state.pending, null)
})

// ══════════════════ D. 去抖与合并 ══════════════════

test('★ 一次存档写入多个文件 / 自动存档连发 → 合并成一次开口', () => {
  const p = P()
  // 注意 tick 要落在**最后一次**合并的静默窗口之后：每来一条新触发，静默窗口都会重新开始算
  const r = drive([
    trigger(T0, 'save', 0.6, '存档槽 1 更新'),
    trigger(T0 + sec(3), 'save', 0.7, '存档槽 2 更新'),
    trigger(T0 + sec(9), 'save', 0.5, '元数据更新'),
    tick(T0 + sec(31), 30),
  ], p)
  assert.equal(r.speaks.length, 1)
  assert.equal(r.speaks[0].mergedCount, 3)
  assert.equal(r.speaks[0].summaries.length, 3, '合并后仍要保留每一条摘要，供表达层使用')
  assert.equal(r.speaks[0].significance, 0.7, '合并取最高的显著性')
  assert.equal(r.state.stats.merged, 2)
})

test('合并窗口之外的两个触发不作为同一个处理', () => {
  const p = P()
  const r = drive([
    trigger(T0, 'save'),
    trigger(T0 + sec(30), 'save'), // 超过 20s 合并窗口
    tick(T0 + sec(51), 30),
  ], p)
  assert.equal(r.speaks.length, 1, '仍只开口一次（第二个被冷却挡住）')
  assert.equal(r.state.stats.merged, 0)
  assert.equal(r.state.stats.droppedCooldown, 0, '同一时刻只有一个 pending，不构成冷却拒绝')
})

// ══════════════════ E. 显著性过滤 ══════════════════

test('显著性低于门槛的触发不算数', () => {
  const p = P()
  const r = drive([trigger(T0, 'item', 0.2), tick(T0 + sec(21), 30)], p)
  assert.equal(r.speaks.length, 0)
  assert.equal(r.state.stats.droppedLowSignificance, 1)
})

test('低显著性触发不计入 usedTriggerRate 的分母（否则指标会被稀释）', () => {
  const p = P()
  const r = drive([
    trigger(T0, 'item', 0.1),
    trigger(T0 + sec(30), 'save', 0.9),
    tick(T0 + sec(60), 30),
  ], p)
  assert.equal(r.metrics.triggers, 2)
  assert.equal(r.metrics.spoke, 1)
  assert.equal(r.metrics.usedTriggerRate, 1)
})

// ══════════════════ F. 冷却与预算 ══════════════════

test('★ 冷却按「时长」缩放，不会在真实时间戳下变成几十年（量纲回归）', () => {
  const p = P()
  const first = drive(bossSaveScenario(), p)
  assert.equal(first.speaks.length, 1)
  const spokeAt = first.speaks[0].at

  // 11 分钟后再来一次：全局冷却 10min × 1.7 = 17min，应当被拒
  const soon = drive([
    ...bossSaveScenario(),
  ], p)
  void soon

  let st = first.state
  const before = step(st, trigger(spokeAt + min(11)), p)
  const after = step(before.state, tick(spokeAt + min(11) + sec(21), 30), p)
  assert.equal(after.speak, null, '17 分钟内的冷却必须生效')
  assert.equal(after.state.stats.droppedCooldown, 1)
  // 关键：冷却的剩余量是"分钟级"，不是"年级"
  const why = after.notes.join(' ')
  const leftSec = Number((why.match(/还需 (\d+)s/) ?? [])[1])
  assert.ok(Number.isFinite(leftSec), `冷却说明应含剩余秒数，实际：${why}`)
  assert.ok(leftSec < 3600, `剩余冷却应在小时量级内，实际 ${leftSec}s —— 这说明系数被乘到了时间戳上`)
})

test('冷却过去之后可以再次开口', () => {
  const p = P()
  const first = drive(bossSaveScenario(), p)
  const spokeAt = first.speaks[0].at
  // 同类冷却 25min × 1.7 = 42.5min；等 45 分钟
  const later = T0 + min(45)
  const r = drive([
    trigger(later, 'save'),
    tick(later + sec(21), 30),
  ], p, { ...first.state })
  assert.equal(r.speaks.length, 1)
})

test('不同 kind 之间受全局冷却约束', () => {
  const p = P() // 注意：这里用只有文件系统信号的 capability，death 仍可被触发（引擎不阻止）
  const inputs = [
    trigger(T0, 'save'),
    tick(T0 + sec(21), 30),
    trigger(T0 + sec(40), 'exit'),
    tick(T0 + sec(61), 30),
  ]
  const r = drive(inputs, p)
  assert.equal(r.speaks.length, 1, '第二次被全局冷却挡住（exit 自身冷却只有 5min，但全局是 10min×1.7）')
  assert.equal(r.state.stats.droppedCooldown, 1)
})

test('★ 每小时发言数不超过预算', () => {
  const p = P()
  const inputs = []
  // 3 小时里每 5 分钟来一次存档触发，且始终松懈
  for (let i = 0; i < 36; i++) {
    const t = T0 + min(i * 5)
    inputs.push(trigger(t, 'save', 0.9))
    inputs.push(tick(t + sec(21), 30))
  }
  const r = drive(inputs, p)
  assert.ok(r.metrics.speaksPerHour <= LEVELS.conservative.budgetPerHour + 0.01,
    `每小时发言 ${r.metrics.speaksPerHour.toFixed(2)} 超出预算`)
  assert.ok(r.metrics.spoke >= 1, '不该一次都不说')
})

test('★ usedTriggerRate 不该是 100%（100% 就等于太吵了）', () => {
  const p = P()
  const inputs = []
  for (let i = 0; i < 12; i++) {
    const t = T0 + min(i * 10)
    inputs.push(trigger(t, 'save', 0.9))
    inputs.push(tick(t + sec(21), 30))
  }
  const r = drive(inputs, p)
  assert.ok(r.metrics.usedTriggerRate < 1, `覆盖率 ${r.metrics.usedTriggerRate} 说明每个触发都被用掉了`)
  assert.ok(r.metrics.droppedForCooldown + r.metrics.droppedForBudget > 0)
})

// ══════════════════ G. 自适应：被忽略就变安静 ══════════════════

test('★ 发言后被忽略 → 谨慎度上升、连续被忽略计数增加', () => {
  const p = P()
  const first = drive(bossSaveScenario(), p)
  assert.equal(first.state.caution, 1)
  const t = first.speaks[0].at + LEVELS.conservative.replyWindowMs + sec(1)
  const r = step(first.state, tick(t, 60), p)
  assert.equal(r.state.ignoredStreak, 1)
  assert.ok(r.state.caution > 1, '谨慎度应当上升')
  assert.equal(r.state.stats.ignores, 1)
})

test('★ 玩家回应 → 谨慎度回落、被忽略计数归零', () => {
  const p = P()
  const first = drive(bossSaveScenario(), p)
  const afterIgnore = step(first.state, tick(first.speaks[0].at + min(6), 60), p).state
  assert.ok(afterIgnore.caution > 1)
  const afterReply = step(afterIgnore, reply(afterIgnore.observedTo + sec(1)), p).state
  assert.equal(afterReply.ignoredStreak, 0)
  assert.ok(afterReply.caution < afterIgnore.caution)
})

test('谨慎度会收紧预算下限（至少留 1 次）', () => {
  const p = P()
  let st = initPresence()
  for (let i = 0; i < 6; i++) {
    st = { ...st, caution: st.caution + LEVELS.conservative.cautionPerIgnore, awaitingReplySince: T0 }
    const r = step(st, tick(T0 + LEVELS.conservative.replyWindowMs + i * sec(1), 60), p)
    st = r.state
  }
  assert.ok(st.caution > 2)
  const m = summarize(st, { policy: p })
  assert.ok(m.ignoredStreak >= 1)
})

test('亲密度低时冷却更长（越生疏越克制）', () => {
  const p = P()
  const shy = drive(bossSaveScenario(), p, { affinity: 0.05 })
  const close = drive(bossSaveScenario(), p, { affinity: 1 })
  assert.equal(shy.speaks.length, 1)
  assert.equal(close.speaks.length, 1)
  // 同一次发言之后，生疏的那个应当更久才能恢复。
  // 30 分钟：亲近方（系数 1，同类冷却 25min）应当放行，生疏方（系数 1.95，约 48.75min）应当仍被挡
  const later = shy.speaks[0].at + min(30)
  const fromShy = step(step(shy.state, trigger(later), p).state, tick(later + sec(21), 60), p)
  const fromClose = step(step(close.state, trigger(later), p).state, tick(later + sec(21), 60), p)
  assert.equal(fromShy.speak, null, '生疏时更该克制')
  assert.notEqual(fromClose.speak, null, '亲近时同样的时间点应当放行')
})

// ══════════════════ H. 动作通道（与发言完全分开） ══════════════════

test('★ 长时间不理人 → 出动作；更久 → 出无聊动作', () => {
  const p = P()
  const th = LEVELS.conservative
  const r = drive([
    tick(T0, th.idleActionAfterSec + 1),
    tick(T0 + min(5), th.boredActionAfterSec + 1),
  ], p)
  assert.equal(r.acts.length, 2)
  assert.equal(r.acts[0].action, 'idle-shift')
  assert.equal(r.acts[1].action, 'bored')
})

test('闲着但还没到门槛时不出动作', () => {
  const p = P()
  const r = drive([tick(T0, 10), tick(T0 + sec(1), 30)], p)
  assert.equal(r.acts.length, 0)
})

test('★ 游戏没在跑时不出动作（桌宠不该在桌面上自嗨）', () => {
  const p = P()
  const th = LEVELS.conservative
  const r = drive([tick(T0, th.boredActionAfterSec + 1, false)], p)
  assert.equal(r.acts.length, 0)
})

test('★ 动作不消耗发言预算：一直出动作也不影响之后开口', () => {
  const p = P()
  const th = LEVELS.conservative
  const inputs = [trigger(T0, 'save', 0.9)]
  for (let i = 0; i < 20; i++) inputs.push(tick(T0 + sec(i * 30), th.boredActionAfterSec + i))
  const r = drive(inputs, p)
  assert.ok(r.acts.length >= 3, `应当出了不少动作，实际 ${r.acts.length}`)
  assert.equal(r.speaks.length, 1, '动作多了不该挤掉发言')
})

test('动作之间有节流，不会每 tick 都出', () => {
  const p = P()
  const th = LEVELS.conservative
  const inputs = []
  for (let i = 0; i < 10; i++) inputs.push(tick(T0 + sec(i * 5), th.boredActionAfterSec + 100))
  const r = drive(inputs, p)
  assert.ok(r.acts.length <= 2, `50 秒内动作次数应受 actionCooldownMs 限制，实际 ${r.acts.length}`)
})

test('动作不会把 pending 的触发取消掉', () => {
  const p = P()
  const th = LEVELS.conservative
  const r = drive([
    trigger(T0, 'save', 0.9),
    tick(T0 + sec(21), th.boredActionAfterSec + 1),
  ], p)
  assert.equal(r.acts.length, 1)
  assert.equal(r.speaks.length, 1)
})

// ══════════════════ I. 指标 ══════════════════

test('speaksPerHour 按整个观察窗口算，不因单次发言而虚高', () => {
  const p = P()
  const r = drive([trigger(T0), tick(T0 + sec(21), 30), tick(T0 + min(30), 30)], p)
  assert.equal(r.metrics.spoke, 1)
  assert.ok(r.metrics.speaksPerHour < 3, `单次发言在 30 分钟窗口里不该算出 ${r.metrics.speaksPerHour}/h`)
  assert.ok(r.metrics.speaksPerHour > 1, '半小时一次应当约等于 2/h 量级')
})

test('指标里的字段齐全且类型正确', () => {
  const p = P()
  const r = drive(bossSaveScenario(), p)
  const m = r.metrics
  for (const k of ['speaksPerHour', 'triggerLatencyMs', 'usedTriggerRate', 'ignoredStreak',
    'caution', 'spokeWhileFocused', 'spoke', 'triggers', 'actions', 'spanMs']) {
    assert.ok(k in m, `指标缺少 ${k}`)
    assert.equal(typeof m[k], 'number', `${k} 应当是数字`)
  }
  assert.equal(m.level, 'conservative')
})

test('没有任何输入时指标是零而不是 NaN', () => {
  const m = summarize(initPresence(), { policy: P() })
  assert.equal(m.speaksPerHour, 0)
  assert.equal(m.triggerLatencyMs, 0)
  assert.equal(m.usedTriggerRate, 0)
  assert.equal(m.spokeWhileFocused, 0)
})

// ══════════════════ J. replay / 纯函数 / 确定性 ══════════════════

test('★ replay 确定性：同一段事件流跑两遍，指标完全一致', () => {
  const p = P()
  const timeline = []
  for (let i = 0; i < 30; i++) {
    const t = T0 + min(i * 4)
    timeline.push(trigger(t, i % 3 === 0 ? 'death' : 'save', 0.8))
    timeline.push(tick(t + sec(21), 30))
    if (i % 4 === 0) timeline.push(reply(t + sec(30)))
  }
  const a = replay(timeline, { policy: p })
  const b = replay(timeline, { policy: p })
  assert.deepEqual(a.metrics, b.metrics)
  assert.deepEqual(a.speaks, b.speaks)
  assert.equal(JSON.stringify(a.metrics), JSON.stringify(b.metrics))
})

test('★ step 是纯函数：不改入参状态', () => {
  const p = P()
  const st = initPresence()
  const snapshot = JSON.stringify(st)
  const r = step(st, trigger(T0), p)
  assert.equal(JSON.stringify(st), snapshot, '入参状态被改动了')
  assert.notEqual(r.state, st)
  assert.equal(st.pending, null)
})

test('replay 能接受未解析的 { level, capability } 并自行解析', () => {
  const a = replay(bossSaveScenario(), { policy: { level: 'conservative', capability: capabilityOf(['save']) } })
  const b = replay(bossSaveScenario(), { policy: P() })
  assert.deepEqual(a.metrics, b.metrics)
})

test('replay 的 decisions 与输入一一对应', () => {
  const p = P()
  const timeline = bossSaveScenario()
  const r = replay(timeline, { policy: p })
  assert.equal(r.decisions.length, timeline.length)
  assert.equal(r.decisions[0].type, 'trigger')
})

// ══════════════════ L. ★ 玩家主动搭话：不节流、不计入主动发言 ══════════════════

test('★ 玩家主动搭话不受冷却与预算限制（他先开的口，谈不上打扰）', () => {
  const p = P()
  // 先正常主动开口一次，把冷却顶满
  const first = drive(bossSaveScenario(), p)
  assert.equal(first.speaks.length, 1)

  // 立刻玩家点桌宠 —— 必须被回应
  const r = step(first.state, { type: 'manual', at: first.speaks[0].at + sec(5), summary: '玩家点了桌宠' }, p)
  assert.ok(r.speak, '玩家主动搭话必须被回应，不该被冷却挡住')
  assert.equal(r.speak.manual, true)
  assert.equal(r.speak.kind, 'manual')
  assert.equal(r.state.stats.answered, 1)
  assert.equal(r.state.stats.droppedCooldown, 0)
})

test('★ 主动搭话不污染"我们有多烦人"的指标', () => {
  const p = P()
  const r = drive([
    tick(T0, 100),
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'manual', at: T0 + sec(i * 10), summary: '点桌宠' })),
  ], p)
  const m = summarize(r.state, { policy: p })
  assert.equal(m.answered, 5)
  assert.equal(m.spoke, 0, '玩家的点击不该算成我们主动开口')
  assert.equal(m.speaksPerHour, 0)
  assert.equal(m.spokeWhileFocused, 0)
})

test('主动搭话也会清掉"被忽略"（人就在这儿）', () => {
  const p = P()
  const first = drive(bossSaveScenario(), p)
  const ignored = step(first.state, tick(first.speaks[0].at + min(6), 60), p).state
  assert.equal(ignored.ignoredStreak, 1)
  const r = step(ignored, { type: 'manual', at: ignored.observedTo + sec(1) }, p)
  assert.equal(r.state.ignoredStreak, 0)
  assert.ok(r.state.caution < ignored.caution)
})

// ══════════════════ K. 端到端场景（用户原话的两种情形） ══════════════════


test('★ 场景一：打败 boss → 存档 → 又打了一会儿 → 放下手柄 → 开口（全程只说一次）', () => {
  const p = P()
  const r = drive([
    // 前面是一小时的苦战：一直在专注（空闲始终很低）
    ...Array.from({ length: 20 }, (_, i) => tick(T0 + min(i * 3), 1)),
    // 存档
    trigger(T0 + min(60), 'save', 0.9, '存档已更新'),
    // 又顺手打了一会儿 —— 已过静默窗口，但人还在，所以只能继续等
    tick(T0 + min(60) + sec(25), 3),
    tick(T0 + min(60) + sec(45), 2),
    // 终于放下手柄
    tick(T0 + min(61), 45),
  ], p)
  assert.equal(r.speaks.length, 1)
  assert.equal(r.speaks[0].kind, 'save')
  assert.equal(r.metrics.spokeWhileFocused, 0, '全程一次都没在专注期插嘴')
  assert.ok(r.metrics.waitedForFocus >= 1, '那两次「还在打」应当被记为"继续等"，而不是丢掉机会')
  assert.ok(r.speaks[0].triggerLatencyMs >= sec(60), '延迟应当体现「等玩家真的松懈」')
})

test('★ 场景二：死亡后交流', () => {
  const p = resolvePolicy({ level: 'moderate', capability: capabilityOf([...RELIABLE_KINDS, 'death']) })
  const r = drive([
    trigger(T0, 'death', 0.9, '角色死亡'),
    tick(T0 + sec(13), 30),
  ], p)
  assert.equal(r.speaks.length, 1)
  assert.equal(r.speaks[0].kind, 'death')
  assert.equal(r.metrics.level, 'moderate')
})

test('★ 场景三：退出游戏后带记忆继续聊（游戏没跑，不受专注闸门限制）', () => {
  const p = P()
  const r = drive([
    trigger(T0, 'exit', 0.8, '游戏已退出'),
    tick(T0 + sec(21), 0, false),
  ], p)
  assert.equal(r.speaks.length, 1)
  assert.equal(r.speaks[0].kind, 'exit')
})

test('★ 场景四：一局下来不该把玩家烦到（发言次数有上界）', () => {
  const p = P()
  const inputs = []
  // 4 小时的一局：每 8 分钟一次存档，始终松懈，从不回应
  for (let i = 0; i < 30; i++) {
    const t = T0 + min(i * 8)
    inputs.push(trigger(t, 'save', 0.9))
    inputs.push(tick(t + sec(21), 40))
  }
  const r = drive(inputs, p)
  const hours = (r.state.observedTo - r.state.observedFrom) / 3_600_000
  assert.ok(r.speaks.length <= Math.ceil(hours * LEVELS.conservative.budgetPerHour),
    `4 小时里说了 ${r.speaks.length} 次，超出预算上界`)
  assert.ok(r.metrics.caution > 1, '一直不回应，谨慎度应当上升')
  assert.ok(r.metrics.usedTriggerRate < 1)
})
