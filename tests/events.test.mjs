// tests/events.test.mjs —— core/events.mjs 的测试
//
// 这个模块是"不同引擎的日志/存档 → 一种统一形状"的落点，
// 所以测试重点是两件事：**闭集是否真的闭**、以及**脏数据不能把它搞崩**。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVENT_KINDS, DEFAULT_IMPORTANCE, createEvent, normalizeEvents, mergeEvents,
  summarize, pickNoteworthy,
} from '../core/events.mjs'

// ══════════════════ A. 闭集与默认值 ══════════════════

test('EVENT_KINDS 是冻结的闭集', () => {
  assert.ok(Object.isFrozen(EVENT_KINDS))
  assert.ok(EVENT_KINDS.length >= 10)
  for (const k of ['progress', 'combat', 'item', 'death', 'dialogue', 'area', 'system']) {
    assert.ok(EVENT_KINDS.includes(k), `原有类别 ${k} 不该被删掉`)
  }
})

test('★ 文件系统层面的三类信号已登记（实测这三类才是最可靠的输入）', () => {
  for (const k of ['save', 'exit', 'crash']) {
    assert.ok(EVENT_KINDS.includes(k), `${k} 必须登记进 EVENT_KINDS`)
  }
})

test('DEFAULT_IMPORTANCE 覆盖每一个类别，且都在 0..1', () => {
  assert.ok(Object.isFrozen(DEFAULT_IMPORTANCE))
  for (const k of EVENT_KINDS) {
    assert.equal(typeof DEFAULT_IMPORTANCE[k], 'number', `${k} 缺默认重要度`)
    assert.ok(DEFAULT_IMPORTANCE[k] >= 0 && DEFAULT_IMPORTANCE[k] <= 1, `${k} 的重要度越界`)
  }
})

test('★ 泄压点的重要度高于琐事（这是"什么不值得打扰"的量化依据）', () => {
  // save / exit / crash / death 是泄压点；item 是琐事
  for (const k of ['save', 'exit', 'crash', 'death']) {
    assert.ok(DEFAULT_IMPORTANCE[k] >= 0.6, `${k} 是泄压点，重要度不该低于 0.6`)
  }
  assert.ok(DEFAULT_IMPORTANCE.item < DEFAULT_IMPORTANCE.save)
  assert.ok(DEFAULT_IMPORTANCE.system < DEFAULT_IMPORTANCE.save)
})

// ══════════════════ B. createEvent ══════════════════

test('createEvent 补齐字段并规范化', () => {
  const e = createEvent({ kind: 'save', at: 123, text: '  存档已更新  ', data: { f: 1 } })
  assert.equal(e.kind, 'save')
  assert.equal(e.at, 123)
  assert.equal(e.text, '存档已更新', '文本要 trim')
  assert.deepEqual(e.data, { f: 1 })
  assert.equal(e.importance, DEFAULT_IMPORTANCE.save)
  assert.equal(typeof e.id, 'string')
})

test('未登记的 kind 退回 system，而不是抛异常', () => {
  assert.equal(createEvent({ kind: '不存在的类别', text: 'x' }).kind, 'system')
  assert.equal(createEvent({ text: 'x' }).kind, 'system')
  assert.equal(createEvent({ kind: null, text: 'x' }).kind, 'system')
})

test('显式重要度被夹到 0..1', () => {
  assert.equal(createEvent({ kind: 'item', text: 'x', importance: -5 }).importance, 0)
  assert.equal(createEvent({ kind: 'item', text: 'x', importance: 99 }).importance, 1)
  assert.equal(createEvent({ kind: 'item', text: 'x', importance: 0.42 }).importance, 0.42)
})

test('重要度是 NaN 时退回该类别默认值而不是 0', () => {
  // NaN 也是 number，若直接 clamp 会静默变成 0（= "最不重要"），
  // 那会让一个本该被看见的事件彻底沉默。这里钉住实际行为。
  const e = createEvent({ kind: 'save', text: 'x', importance: NaN })
  assert.ok(Number.isFinite(e.importance))
  assert.ok(e.importance > 0, `NaN 重要度不该静默变成 0，实际 ${e.importance}`)
})

test('text 兜底成空串而不是 undefined / "null"', () => {
  assert.equal(createEvent({ kind: 'save' }).text, '')
  assert.equal(createEvent({ kind: 'save', text: null }).text, '')
  assert.equal(createEvent({ kind: 'save', text: undefined }).text, '')
  assert.equal(createEvent({ kind: 'save', text: 123 }).text, '123')
})

test('★ 非法输入永不抛异常（日志是脏数据）', () => {
  for (const bad of [undefined, null, 0, 'x', [], true, { kind: {} }, { at: {}, text: {} }]) {
    assert.doesNotThrow(() => createEvent(bad), `createEvent(${JSON.stringify(bad)}) 抛了`)
  }
  assert.equal(createEvent().kind, 'system')
})

test('id 由内容决定：同内容同 id（去重才成立）', () => {
  const a = createEvent({ kind: 'save', at: 1, text: '存档' })
  const b = createEvent({ kind: 'save', at: 1, text: '存档' })
  assert.equal(a.id, b.id)
  const c = createEvent({ kind: 'save', at: 2, text: '存档' })
  assert.notEqual(a.id, c.id, '时间不同 ⇒ id 不同')
})

test('显式给了 id 就用它', () => {
  assert.equal(createEvent({ id: 7, kind: 'save', text: 'x' }).id, '7')
  assert.equal(createEvent({ id: 'ev_x', kind: 'save', text: 'x' }).id, 'ev_x')
})

// ══════════════════ C. normalizeEvents ══════════════════

test('normalizeEvents 去重 + 丢弃空文本，并如实报数', () => {
  const r = normalizeEvents([
    { kind: 'save', at: 1, text: '存档' },
    { kind: 'save', at: 1, text: '存档' },        // 重复
    { kind: 'save', at: 1, text: '   ' },          // 空
    { kind: 'save', at: 2, text: '存档' },         // 同文本不同时间 ⇒ 不重复
    { kind: 'save', at: 3, text: '' },
  ])
  assert.equal(r.events.length, 2)
  assert.equal(r.dropped.dup, 1)
  assert.equal(r.dropped.empty, 2)
})

test('normalizeEvents 保证输出顺序与输入一致（叙事顺序有意义）', () => {
  const r = normalizeEvents([
    { kind: 'save', at: 3, text: 'c' },
    { kind: 'save', at: 1, text: 'a' },
    { kind: 'save', at: 2, text: 'b' },
  ])
  assert.deepEqual(r.events.map((e) => e.text), ['c', 'a', 'b'])
})

test('normalizeEvents 对空输入与非法输入安全', () => {
  assert.deepEqual(normalizeEvents().events, [])
  assert.deepEqual(normalizeEvents([]).events, [])
  // null / undefined / 0 都产不出非空文本 ⇒ 全部被丢弃，且如实报数
  const r = normalizeEvents([null, undefined, 0])
  assert.equal(r.events.length, 0)
  assert.equal(r.dropped.empty, 3)
  assert.equal(normalizeEvents([{ kind: 'save', at: 1, text: 'x' }]).events.length, 1)
})

// ══════════════════ D. mergeEvents ══════════════════

test('mergeEvents 按时间排序，并保留"同刻先来后到"', () => {
  const a = [{ kind: 'save', at: 5, text: 'a5' }, { kind: 'save', at: 1, text: 'a1' }]
  const b = [{ kind: 'save', at: 3, text: 'b3' }, { kind: 'save', at: 5, text: 'b5' }]
  const merged = mergeEvents(a, b)
  assert.deepEqual(merged.map((e) => e.text), ['a1', 'b3', 'a5', 'b5'],
    '时刻相同（5）时应当保持"第一个流里的排前面"')
})

test('mergeEvents 能吃 ISO 字符串时间', () => {
  const merged = mergeEvents([
    { kind: 'save', at: '2024-01-02T00:00:00Z', text: 'later' },
    { kind: 'save', at: '2024-01-01T00:00:00Z', text: 'earlier' },
  ])
  assert.deepEqual(merged.map((e) => e.text), ['earlier', 'later'])
})

test('mergeEvents 对 null / 缺失时间不抛，且位置确定', () => {
  const merged = mergeEvents([
    { kind: 'save', at: 10, text: 'has-time' },
    { kind: 'save', at: null, text: 'no-time' },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].text, 'no-time', '未知时间排在前面（不阻塞排序）')
})

test('mergeEvents 忽略空流', () => {
  assert.deepEqual(mergeEvents(undefined, null, []).length, 0)
  assert.equal(mergeEvents([{ kind: 'save', at: 1, text: 'x' }], undefined).length, 1)
})

// ══════════════════ E. summarize / pickNoteworthy ══════════════════

test('summarize 按类别计数并给出时间范围与亮点', () => {
  const evs = [
    createEvent({ kind: 'save', at: 1, text: '存档' }),
    createEvent({ kind: 'save', at: 2, text: '又存' }),
    createEvent({ kind: 'item', at: 3, text: '捡到东西' }),
    createEvent({ kind: 'death', at: 4, text: '死了' }),
  ]
  const s = summarize(evs)
  assert.equal(s.total, 4)
  assert.equal(s.byKind.save, 2)
  assert.equal(s.byKind.item, 1)
  assert.equal(s.from, 1)
  assert.equal(s.to, 4)
  assert.equal(s.highlights[0].kind, 'death', '亮点按重要度降序')
  assert.ok(s.highlights.length <= 5)
})

test('summarize 对空列表安全', () => {
  const s = summarize([])
  assert.equal(s.total, 0)
  assert.deepEqual(s.byKind, {})
  assert.equal(s.from, null)
  assert.equal(s.to, null)
  assert.deepEqual(s.highlights, [])
})

test('pickNoteworthy 只挑够重要的，并按重要度降序、受 limit 限制', () => {
  const evs = [
    createEvent({ kind: 'save', at: 1, text: '存档' }),   // 0.8
    createEvent({ kind: 'item', at: 2, text: '道具' }),   // 0.3
    createEvent({ kind: 'death', at: 3, text: '死亡' }),  // 0.9
    createEvent({ kind: 'area', at: 4, text: '区域' }),   // 0.35
  ]
  const picked = pickNoteworthy(evs, { minImportance: 0.6 })
  assert.deepEqual(picked.map((e) => e.kind), ['death', 'save'])
  assert.equal(pickNoteworthy(evs, { minImportance: 0.6, limit: 1 }).length, 1)
  assert.equal(pickNoteworthy(evs).length, 2, '默认门槛 0.6')
  assert.deepEqual(pickNoteworthy([]), [])
})

test('★ 与 timing 引擎的取舍一致：默认重要度决定了"什么不值得主动开口"', () => {
  // conservative 档的 minSignificance 是 0.45（见 core/presence.mjs）。
  // 这里不复用那个常量（core/events 不该依赖 core/presence），只断言相对关系：
  // 琐事（item/area）应当落在"值得主动开口"的门槛之下，泄压点（save/death）之上。
  const threshold = 0.45
  assert.ok(DEFAULT_IMPORTANCE.item < threshold)
  assert.ok(DEFAULT_IMPORTANCE.area < threshold)
  assert.ok(DEFAULT_IMPORTANCE.save > threshold)
  assert.ok(DEFAULT_IMPORTANCE.death > threshold)
})
