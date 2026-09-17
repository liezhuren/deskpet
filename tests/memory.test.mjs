// tests/memory.test.mjs —— core/memory.mjs 的测试
//
// 三件事必须钉死，因为它们各自对应一条设计：
//   ① 去重是"强化"而不是"新增" —— 否则玩十天，记忆里 90% 是同一句"存档已更新"
//   ② 召回按当前话题相关 —— 玩家说"刚才那关好难"，该想起"角色倒下了"而不是"存档了"
//   ③ 念叨惩罚真的生效 —— 不惩罚重复召回，桌宠会反复念叨同一件事
// 另外全部函数必须是纯的、且不读系统时间（时间一律由调用方传 now），否则没法做回归。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createMemory, remember, rememberAll, rememberEvents, consolidate,
  recall, scoreOf, markRecalled, forget, digest, stats, startSession,
  MEMORY_DEFAULTS, MEMORY_KINDS,
} from '../core/memory.mjs'
import { createEvent } from '../core/events.mjs'

const T0 = 1_700_000_000_000
const DAY = 24 * 3600_000
const HOUR = 3600_000

const mem1 = () => remember(createMemory(), { kind: 'death', text: '角色倒下了', weight: 0.9, at: T0 })

// ══════════════════ A. 建立 / 写入 ══════════════════

test('createMemory 形状', () => {
  const m = createMemory()
  assert.deepEqual(m.entries, [])
  assert.equal(m.maxEntries, MEMORY_DEFAULTS.maxEntries)
  assert.equal(m.game, null)
  assert.equal(m.sessionCount, 0)
  assert.ok(Object.isFrozen(MEMORY_DEFAULTS))
})

test('remember 写入一条，字段齐全', () => {
  const m = mem1()
  assert.equal(m.entries.length, 1)
  const e = m.entries[0]
  assert.equal(e.kind, 'death')
  assert.equal(e.text, '角色倒下了')
  assert.equal(e.weight, 0.9)
  assert.equal(e.count, 1)
  assert.equal(e.hits, 0)
  assert.equal(e.lastHitAt, null)
  assert.equal(e.pinned, false)
  assert.equal(typeof e.fingerprint, 'string')
  assert.equal(typeof e.id, 'string')
})

test('未登记的 kind 退回 system（不抛）', () => {
  const m = remember(createMemory(), { kind: '莫名其妙', text: 'x' })
  assert.equal(m.entries[0].kind, 'system')
  assert.ok(MEMORY_KINDS.includes('summary'))
})

test('权重被夹到 0..1；非有限数退回默认', () => {
  assert.equal(remember(createMemory(), { text: 'a', weight: 9 }).entries[0].weight, 1)
  assert.equal(remember(createMemory(), { text: 'a', weight: -1 }).entries[0].weight, 0)
  assert.equal(remember(createMemory(), { text: 'a', weight: NaN }).entries[0].weight, 0.4)
  assert.equal(remember(createMemory(), { text: 'a' }).entries[0].weight, 0.4)
})

test('空文本 / 脏输入不写入，也不抛', () => {
  for (const bad of [null, undefined, 0, {}, { text: '' }, { text: '   ' }]) {
    assert.doesNotThrow(() => remember(createMemory(), bad))
    assert.equal(remember(createMemory(), bad).entries.length, 0)
  }
})

// ══════════════════ B. ★ 去重 = 强化，不是新增 ══════════════════

test('★ 同内容重复写入 → 强化已有条目而不是新增', () => {
  const m = rememberAll(createMemory(), [
    { kind: 'save', text: '存档已更新', weight: 0.8, at: T0 },
    { kind: 'save', text: '存档已更新', weight: 0.5, at: T0 + HOUR },
    { kind: 'save', text: '存档已更新', weight: 0.8, at: T0 + 2 * HOUR },
  ])
  assert.equal(m.entries.length, 1, '三条同样的话必须合成一条')
  const e = m.entries[0]
  assert.equal(e.count, 3, '"发生过很多次"要变成一个可读的事实')
  assert.equal(e.weight, 0.8, '权重取更高的')
  assert.equal(e.at, T0 + 2 * HOUR, '时间刷到最近')
  assert.equal(e.firstAt, T0, '保留最初出现的时间')
  assert.equal(e.lastSeenAt, T0 + 2 * HOUR)
})

test('★ 标点/空白差异算同一条（否则"存档已更新。"会另开一条）', () => {
  const m = rememberAll(createMemory(), [
    { kind: 'save', text: '存档已更新', at: T0 },
    { kind: 'save', text: '存档已更新。', at: T0 + 1 },
    { kind: 'save', text: '存档 已更新', at: T0 + 2 },
  ])
  assert.equal(m.entries.length, 1)
  assert.equal(m.entries[0].count, 3)
})

test('不同游戏 / 不同类别不互相去重', () => {
  const m = rememberAll(createMemory(), [
    { kind: 'save', text: '存档已更新', game: 'A' },
    { kind: 'save', text: '存档已更新', game: 'B' },
    { kind: 'progress', text: '存档已更新', game: 'A' },
  ])
  assert.equal(m.entries.length, 3)
})

test('去重命中时 pinned 会累加（一旦钉住就一直是钉住）', () => {
  const m = rememberAll(createMemory(), [
    { kind: 'fact', text: '她的本名是霞', pinned: true },
    { kind: 'fact', text: '她的本名是霞' },
  ])
  assert.equal(m.entries[0].pinned, true)
})

test('remember 不改入参（纯函数）', () => {
  const m = createMemory()
  const snap = JSON.stringify(m)
  remember(m, { kind: 'save', text: 'x' })
  assert.equal(JSON.stringify(m), snap)
})

test('rememberEvents 用事件的 importance 当权重，并支持按类别过滤', () => {
  const evs = [
    createEvent({ kind: 'save', at: T0, text: '存档' }),
    createEvent({ kind: 'item', at: T0 + 1, text: '捡到药水' }),
  ]
  const all = rememberEvents(createMemory(), evs)
  assert.equal(all.entries.length, 2)
  assert.equal(all.entries.find((e) => e.kind === 'save').weight, 0.8)

  const onlySave = rememberEvents(createMemory(), evs, { kinds: ['save'] })
  assert.equal(onlySave.entries.length, 1)
  assert.equal(onlySave.entries[0].kind, 'save')
})

test('rememberEvents 的 now 覆盖事件时间（观察时刻 ≠ 游戏内时刻）', () => {
  const evs = [createEvent({ kind: 'save', at: 1, text: '存档' })]
  const m = rememberEvents(createMemory(), evs, { now: T0 })
  assert.equal(m.entries[0].at, T0)
})

test('rememberEvents 对脏输入安全', () => {
  assert.doesNotThrow(() => rememberEvents(createMemory(), [null, undefined, {}]))
  assert.equal(rememberEvents(createMemory(), null).entries.length, 0)
})

// ══════════════════ C. ★ consolidate：一局 → 记忆 ══════════════════

function sessionEvents() {
  return [
    createEvent({ kind: 'save', at: T0 + 1 * HOUR, text: '存档已更新' }),
    createEvent({ kind: 'save', at: T0 + 2 * HOUR, text: '存档已更新' }),
    createEvent({ kind: 'save', at: T0 + 3 * HOUR, text: '存档已更新' }),
    createEvent({ kind: 'progress', at: T0 + 1.5 * HOUR, text: '地图切换到 8' }),
    createEvent({ kind: 'progress', at: T0 + 2.5 * HOUR, text: '等级 12→13' }),
    createEvent({ kind: 'death', at: T0 + 4 * HOUR, text: '角色倒下了' }),
    createEvent({ kind: 'item', at: T0 + 4.5 * HOUR, text: '金币 1234→1500' }),
  ]
}

test('★ consolidate 产出"一条汇总 + 至多 N 条个体记忆"', () => {
  const { memory, summary, kept } = consolidate(createMemory(), sessionEvents(), { now: T0 + 5 * HOUR, game: 'g1', session: 's1', maxPerSession: 3 })
  assert.ok(summary)
  assert.equal(summary.kind, 'summary')
  assert.equal(kept.length, 3, '个体记忆受 maxPerSession 限制 —— "记忆"要能说上来，不是完整日志')
  assert.equal(summary.weight, 0.9, '该局最重的事决定这局的权重')
  // 汇总 + 3 条个体（三条存档已折叠成一条，所以名额没被浪费）
  assert.equal(memory.entries.length, 4)
  assert.deepEqual(kept.map((k) => k.kind), ['death', 'save', 'progress'])
})

test('★ 折叠发生在取名额之前 —— 名额不该被同一句话占掉', () => {
  // 30 条一模一样的"存档已更新" + 1 条独特的进度
  const events = [
    ...Array.from({ length: 30 }, (_, i) => createEvent({ kind: 'save', at: T0 + i, text: '存档已更新' })),
    createEvent({ kind: 'progress', at: T0 + 100, text: '等级 12→13' }),
  ]
  const { kept, memory } = consolidate(createMemory(), events, { now: T0 + 200, maxPerSession: 2 })
  assert.equal(kept.length, 2)
  assert.ok(kept.some((k) => k.kind === 'progress'), '独特的进度必须拿到名额')
  assert.equal(kept.find((k) => k.kind === 'save').text, '存档已更新')
  assert.ok(memory.entries.some((e) => e.kind === 'save' && e.count === 30))
})

test('★ 汇总文本是事实清单的口吻（不是叙事，也不照抄字段）', () => {
  const { summary } = consolidate(createMemory(), sessionEvents(), { now: T0 + 5 * HOUR })
  assert.equal(summary.text, '这一局：存了 3 次档、死过 1 次、有 2 处进度推进、1 处道具变化')
  assert.equal(summary.data.total, 7)
  assert.equal(summary.data.byKind.death, 1)
})

test('汇总里异常退出 / 没存档就退出会被点出来', () => {
  const a = consolidate(createMemory(), [createEvent({ kind: 'crash', at: T0, text: '不是正常退出的' })], { now: T0 })
  assert.match(a.summary.text, /异常退出/)
  const b = consolidate(createMemory(), [createEvent({ kind: 'exit', at: T0, text: '游戏已退出' })], { now: T0 })
  assert.match(b.summary.text, /没存档就退出/)
})

test('空事件不产生汇总', () => {
  const r = consolidate(createMemory(), [], { now: T0 })
  assert.equal(r.summary, null)
  assert.equal(r.memory.entries.length, 0)
  assert.doesNotThrow(() => consolidate(createMemory(), [null, { text: '  ' }], { now: T0 }))
})

test('★ "退出游戏后带着刚才的记忆继续聊"：换一个"会话"仍能召回上一局的事', () => {
  const { memory } = consolidate(createMemory(), sessionEvents(), { now: T0 + 5 * HOUR, game: 'g1', session: 's1' })
  // 退出游戏之后，玩家问"刚才那关怎么回事"
  const r = recall(memory, { terms: ['刚才'], kinds: ['death', 'summary'], now: T0 + 6 * HOUR }, { minScore: 0.1 })
  assert.ok(r.length >= 1, '退出后仍要能想起上一局')
  assert.ok(r.some((x) => x.entry.kind === 'death'), `应当想起死亡，实际：${r.map((x) => x.entry.text).join(' | ')}`)
})

// ══════════════════ D. ★ 召回打分 ══════════════════

test('★ 按当前话题相关，而不是按时间倒序', () => {
  let m = createMemory()
  m = remember(m, { kind: 'save', text: '存档已更新', weight: 0.8, at: T0 + 10 * HOUR })   // 更新
  m = remember(m, { kind: 'death', text: '角色倒下了', weight: 0.9, at: T0 })               // 更早

  // 玩家说"刚才那关太难了" —— 没有明确关键词时按权重+时间
  const noTerm = recall(m, { now: T0 + 10 * HOUR }, { minScore: 0 })
  assert.equal(noTerm.length, 2)

  // 玩家提到"倒下" —— 相关度必须把它顶上来
  const withTerm = recall(m, { terms: ['倒下'], now: T0 + 10 * HOUR }, { minScore: 0 })
  assert.equal(withTerm[0].entry.kind, 'death')
  assert.ok(withTerm[0].why.some((w) => w.includes('相关')))
})

test('时间衰减：越久越淡', () => {
  const e = { weight: 0.5, at: T0, count: 1, kind: 'save', text: 'x', lastHitAt: null }
  const fresh = scoreOf(e, { now: T0 }).score
  const week = scoreOf(e, { now: T0 + 7 * DAY }).score
  const month = scoreOf(e, { now: T0 + 30 * DAY }).score
  assert.ok(fresh > week && week > month, `${fresh} > ${week} > ${month}`)
  assert.ok(month >= 0.5, '衰减不会把权重本身吃掉')
})

test('不给 now 时不做衰减（行为可预测）', () => {
  const e = { weight: 0.5, at: T0, count: 1, kind: 'save', text: 'x', lastHitAt: null }
  assert.equal(scoreOf(e, {}).score, 0.5)
})

test('★ 念叨惩罚：刚被召回过的条目分数更低', () => {
  const m0 = mem1()
  const before = recall(m0, { now: T0 }, { minScore: 0 })[0].score
  const m1 = markRecalled(m0, recall(m0, { now: T0 }, { minScore: 0 }), T0)
  const after = recall(m1, { now: T0 }, { minScore: 0 })[0].score
  assert.ok(after < before, `被召回后分数应当下降：${before} → ${after}`)
  assert.ok(recall(m1, { now: T0 }, { minScore: 0 })[0].why.some((w) => w.includes('刚说过')))
})

test('念叨惩罚会随时间失效（不至于永久抑制）', () => {
  const m0 = mem1()
  const m1 = markRecalled(m0, recall(m0, { now: T0 }, { minScore: 0 }), T0)
  const now = T0 + MEMORY_DEFAULTS.hitPenaltyWindowMs + 1
  assert.ok(!recall(m1, { now }, { minScore: 0 })[0].why.some((w) => w.includes('刚说过')))
})

test('markRecalled 累加 hits 并刷新 lastHitAt', () => {
  const m0 = mem1()
  const r = recall(m0, { now: T0 }, { minScore: 0 })
  const m1 = markRecalled(m0, r, T0 + 5)
  assert.equal(m1.entries[0].hits, 1)
  assert.equal(m1.entries[0].lastHitAt, T0 + 5)
  assert.equal(markRecalled(m0, [], T0).entries[0].hits, 0, '空召回不该动它')
  assert.equal(m0.entries[0].hits, 0, '不改入参')
})

test('反复出现过的事略微加权', () => {
  const once = { weight: 0.5, at: T0, count: 1, kind: 'save', text: 'x', lastHitAt: null }
  const many = { ...once, count: 5 }
  assert.ok(scoreOf(many, { now: T0 }).score > scoreOf(once, { now: T0 }).score)
  assert.ok(scoreOf(many, { now: T0 }).why.some((w) => w.includes('出现过 5 次')))
})

test('类别命中与钉住都会抬分', () => {
  const e = { weight: 0.5, at: T0, count: 1, kind: 'death', text: 'x', lastHitAt: null }
  assert.ok(scoreOf(e, { now: T0, kinds: new Set(['death']) }).score > scoreOf(e, { now: T0 }).score)
  assert.ok(scoreOf({ ...e, pinned: true }, { now: T0 }).score > scoreOf(e, { now: T0 }).score)
})

test('★ 游戏不匹配的记忆不召回（除非显式允许跨游戏）', () => {
  let m = createMemory({ game: 'A' })
  m = remember(m, { kind: 'death', text: 'A 里死了', weight: 0.9, at: T0, game: 'A' })
  m = remember(m, { kind: 'death', text: 'B 里死了', weight: 0.9, at: T0, game: 'B' })
  const same = recall(m, { now: T0 }, { minScore: 0 })
  assert.equal(same.length, 1)
  assert.equal(same[0].entry.game, 'A')
  const cross = recall(m, { now: T0, crossGame: true }, { minScore: 0 })
  assert.equal(cross.length, 2)
})

test('minScore 会挡住"不值得提"的记忆（宁可少说）', () => {
  const m = remember(createMemory(), { kind: 'item', text: '无关紧要', weight: 0.05, at: T0 })
  assert.equal(recall(m, {}, { minScore: 0.5 }).length, 0)
  assert.equal(recall(m, {}, { minScore: 0.01 }).length, 1)
})

test('limit 生效', () => {
  let m = createMemory()
  for (let i = 0; i < 20; i++) m = remember(m, { kind: 'save', text: `第 ${i} 次`, weight: 0.5, at: T0 + i })
  assert.equal(recall(m, { now: T0 + 20 }, { minScore: 0, limit: 3 }).length, 3)
  assert.equal(recall(m, { now: T0 + 20 }, { minScore: 0 }).length, MEMORY_DEFAULTS.recallLimit)
})

test('字符串 query 会被切词（中文没空格也支持）', () => {
  let m = createMemory()
  m = remember(m, { kind: 'death', text: '角色倒下了', weight: 0.5, at: T0 })
  m = remember(m, { kind: 'save', text: '存档已更新', weight: 0.5, at: T0 })
  const r = recall(m, '角色倒下了', { minScore: 0, now: T0 })
  assert.equal(r[0].entry.kind, 'death')
})

test('空库召回返回空数组，不抛', () => {
  assert.deepEqual(recall(createMemory()), [])
  assert.deepEqual(recall(createMemory(), {}), [])
  assert.doesNotThrow(() => recall(createMemory(), null))
})

test('★ 召回结果可复现（同输入两次完全一致）', () => {
  const m = rememberAll(createMemory(), [
    { kind: 'death', text: 'd', weight: 0.9, at: T0 },
    { kind: 'save', text: 's', weight: 0.9, at: T0 },
    { kind: 'progress', text: 'p', weight: 0.9, at: T0 },
  ])
  const a = recall(m, { now: T0 }, { minScore: 0 })
  const b = recall(m, { now: T0 }, { minScore: 0 })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

// ══════════════════ E. 淘汰 ══════════════════

test('★ 超过上限时按保留分丢最低的，且钉住的永不被丢', () => {
  let m = createMemory({ maxEntries: 3 })
  m = remember(m, { kind: 'fact', text: '钉住的设定', weight: 0.01, at: T0, pinned: true })
  m = remember(m, { kind: 'item', text: '低', weight: 0.1, at: T0 })
  m = remember(m, { kind: 'death', text: '高', weight: 0.9, at: T0 })
  m = remember(m, { kind: 'save', text: '中', weight: 0.5, at: T0 })
  m = remember(m, { kind: 'progress', text: '中高', weight: 0.7, at: T0 })

  const { memory, dropped } = forget(m, { now: T0 })
  assert.equal(memory.entries.length, 3)
  assert.equal(dropped.length, 2)
  const keptTexts = memory.entries.map((e) => e.text)
  assert.ok(keptTexts.includes('钉住的设定'), '钉住的必须留下，哪怕权重最低')
  assert.ok(keptTexts.includes('高'))
  assert.ok(!keptTexts.includes('低'), '权重最低的应当被丢')
})

test('没超上限时 forget 不动任何东西', () => {
  const m = mem1()
  const { memory, dropped } = forget(m, { now: T0 })
  assert.equal(dropped.length, 0)
  assert.equal(memory.entries.length, 1)
})

test('forget 不改入参', () => {
  let m = createMemory({ maxEntries: 1 })
  m = rememberAll(m, [{ kind: 'a', text: '1' }, { kind: 'b', text: '2' }])
  const snap = JSON.stringify(m)
  forget(m, { now: T0 })
  assert.equal(JSON.stringify(m), snap)
})

// ══════════════════ F. digest / stats / session ══════════════════

test('digest 渲染成事实清单，供模型使用', () => {
  let m = createMemory()
  m = remember(m, { kind: 'death', text: '角色 #1 倒下了', weight: 0.9, at: T0 })
  m = remember(m, { kind: 'save', text: '存档已更新', weight: 0.8, at: T0 })
  const { text, used } = digest(m, { now: T0 }, { minScore: 0 })
  assert.match(text, /^【与这个玩家有关的记忆】/)
  assert.match(text, /· 角色 #1 倒下了/)
  assert.equal(used.length, 2)
  assert.ok(used[0].entry.text.includes('倒下'), '最相关的排最前')
})

test('digest 标出重复次数，便于角色说"又"', () => {
  let m = createMemory()
  m = rememberAll(m, [
    { kind: 'save', text: '存档已更新', weight: 0.8, at: T0 },
    { kind: 'save', text: '存档已更新', weight: 0.8, at: T0 + 1 },
  ])
  assert.match(digest(m, { now: T0 }, { minScore: 0 }).text, /（×2）/)
})

test('digest 空库返回空串（下游据此判断"没有可说的"）', () => {
  assert.deepEqual(digest(createMemory()), { text: '', used: [] })
})

test('digest 遵守 maxChars', () => {
  let m = createMemory()
  for (let i = 0; i < 10; i++) m = remember(m, { kind: 'save', text: `这是一条比较长的记忆内容 ${'x'.repeat(30)} ${i}`, weight: 0.8, at: T0 })
  const { text } = digest(m, { now: T0 }, { minScore: 0, maxChars: 100 })
  assert.ok(text.length < 300, `应当被截断，实际 ${text.length}`)
})

test('digest 的 withWhy 只在调试时打开', () => {
  const m = mem1()
  assert.ok(!digest(m, { now: T0 }, { minScore: 0 }).text.includes('权重'))
  assert.ok(digest(m, { now: T0 }, { minScore: 0, withWhy: true }).text.includes('权重'))
})

test('stats 汇总条目数 / 出现次数 / 钉住数 / 类别分布', () => {
  let m = createMemory()
  m = rememberAll(m, [
    { kind: 'save', text: '存档已更新', weight: 0.8, at: T0 },
    { kind: 'save', text: '存档已更新', weight: 0.8, at: T0 + 1 },
    { kind: 'death', text: '角色倒下了', weight: 0.9, at: T0, pinned: true },
  ])
  const s = stats(m)
  assert.equal(s.entries, 2)
  assert.equal(s.occurrences, 3)
  assert.equal(s.pinned, 1)
  assert.deepEqual(s.byKind, { save: 1, death: 1 })
})

test('startSession 递增会话计数并给出 id', () => {
  const a = startSession(createMemory())
  assert.equal(a.session, 's1')
  assert.equal(a.memory.sessionCount, 1)
  const b = startSession(a.memory)
  assert.equal(b.session, 's2')
})

// ══════════════════ G. ★ 端到端：一局 → 退出 → 记忆仍在 ══════════════════

test('★ 端到端：observe 形状的事件流 → consolidate → 退出后仍能召回并生成摘要', () => {
  // 事件形状与 gameio/observe.mjs 产出的一致
  const events = [
    createEvent({ kind: 'save', at: T0, text: '「SaveData1.dat」已更新（第 13 次存档 · 游戏时间 4:30:00）' }),
    createEvent({ kind: 'progress', at: T0 + 60_000, text: '$.dayCount：24→31' }),
    createEvent({ kind: 'progress', at: T0 + 60_000, text: '$.hPoint：9454→9461' }),
    createEvent({ kind: 'death', at: T0 + 2 * HOUR, text: '角色 #1 倒下了' }),
  ]

  // 一局结束
  const { memory, summary } = consolidate(createMemory({ game: 'someGame' }), events, {
    now: T0 + 3 * HOUR, game: 'someGame', session: 's1', durationMs: 3 * HOUR,
  })
  assert.ok(summary.text.includes('存了 1 次档'))

  // 退出游戏后（时间又过了一小时），玩家开口
  const after = T0 + 4 * HOUR
  const { text, used } = digest(memory, { terms: ['刚才'], kinds: ['death'], now: after }, { minScore: 0.1 })
  assert.ok(text.length > 0, '退出游戏后必须还能说上来点什么')
  assert.ok(used.some((u) => u.entry.kind === 'death'))

  // 把"用过的记忆"记下来，防止马上又念叨同一件
  const before = recall(memory, { terms: ['刚才'], kinds: ['death'], now: after }, { minScore: 0.1 })[0].score
  const marked = markRecalled(memory, used, after)
  const afterScore = recall(marked, { terms: ['刚才'], kinds: ['death'], now: after }, { minScore: 0.1 })[0].score
  assert.ok(afterScore < before)

  // 记得住、也不会无限涨
  const { memory: pruned } = forget(marked, { now: after, maxEntries: 2 })
  assert.equal(pruned.entries.length, 2)
  assert.ok(stats(memory).entries >= 3)
})
