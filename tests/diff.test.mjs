// tests/diff.test.mjs —— core/diff.mjs 的测试
//
// 测试数据刻意贴近 §2 实测到的真实存档形状：
//   · Godot .tres  → triggered_stories 是字符串数组（推进进度 = 数组变长）
//   · 各类存档     → 数值字段（等级/路线值/天数）、布尔 flag（item_*）
// 因为「索引 diff 会把数组判成全线位移」这个坑，只有在数组真的长、真的在尾部追加时才会暴露。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  diffValues, countBy, pathMatches, toSegments,
  DEFAULT_KEY_HINTS, VOLATILE_DEFAULTS,
} from '../core/diff.mjs'

const clone = (v) => JSON.parse(JSON.stringify(v))

test('首帧：before 为 undefined 时展开到叶子（便于规则匹配）', () => {
  const r = diffValues(undefined, { a: 1, b: { c: 'x' } })
  assert.deepEqual(r.changes, [
    { path: '$.a', kind: 'added', after: 1 },
    { path: '$.b.c', kind: 'added', after: 'x' },
  ])
  assert.equal(r.counts.total, 2)
})

test('首帧：数组元素也展开到叶子', () => {
  const r = diffValues(undefined, { list: [{ a: 1 }] })
  assert.deepEqual(r.changes, [{ path: '$.list[0].a', kind: 'added', after: 1 }])
})

test('新增一个空对象仍然留下记录（不被展开吞掉）', () => {
  const r = diffValues({}, { slot: {} })
  assert.deepEqual(r.changes, [{ path: '$.slot', kind: 'added', after: {} }])
})

test('完全相同的对象没有任何变更', () => {
  const r = diffValues({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })
  assert.deepEqual(r.changes, [])
  assert.equal(r.counts.total, 0)
  assert.equal(r.truncated, false)
})

test('标量变化产出 changed 并保留前后值', () => {
  const r = diffValues({ level: 12 }, { level: 13 })
  assert.deepEqual(r.changes, [{ path: '$.level', kind: 'changed', before: 12, after: 13 }])
})

test('对象键的新增与删除', () => {
  const r = diffValues({ keep: 1, gone: 2 }, { keep: 1, fresh: 3 })
  assert.deepEqual(r.changes, [
    { path: '$.fresh', kind: 'added', after: 3 },
    { path: '$.gone', kind: 'removed', before: 2 },
  ])
})

test('null 与「键不存在」是两回事', () => {
  const r = diffValues({ a: null }, { a: null, b: null })
  assert.deepEqual(r.changes, [{ path: '$.b', kind: 'added', after: null }])
})

test('★ 原始值数组走集合 diff：尾部追加只产出「新增了那一项」', () => {
  const before = ['day1', 'day2']
  const after = ['day1', 'day2', 'day3']
  const r = diffValues({ stories: before }, { stories: after })
  assert.deepEqual(r.changes, [
    { path: '$.stories', kind: 'added', value: 'day3', index: 2 },
  ])
})

test('★ 集合 diff 对重排序不产生噪声（索引 diff 会全线报错）', () => {
  const r = diffValues({ s: ['a', 'b', 'c'] }, { s: ['c', 'a', 'b', 'd'] })
  assert.deepEqual(r.changes, [{ path: '$.s', kind: 'added', value: 'd', index: 3 }])
})

test('集合 diff 的移除项', () => {
  const r = diffValues({ s: ['a', 'b'] }, { s: ['a'] })
  assert.deepEqual(r.changes, [{ path: '$.s', kind: 'removed', value: 'b', index: 1 }])
})

test('★ 带 id 的对象数组按 key 配对：改一个字段只出一条变化', () => {
  const before = { items: [{ id: 'sword', count: 1 }, { id: 'shield', count: 2 }] }
  const after = { items: [{ id: 'sword', count: 1 }, { id: 'shield', count: 3 }] }
  const r = diffValues(before, after)
  assert.deepEqual(r.changes, [
    { path: '$.items[id=shield].count', kind: 'changed', before: 2, after: 3 },
  ])
})

test('keyed diff：新增/删除整个元素（按前缀聚合即可还原）', () => {
  const r = diffValues(
    { items: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }] },
    { items: [{ id: 'a', n: 1 }, { id: 'c', n: 9 }] },
  )
  assert.deepEqual(r.changes, [
    { path: '$.items[id=c].id', kind: 'added', after: 'c' },
    { path: '$.items[id=c].n', kind: 'added', after: 9 },
    { path: '$.items[id=b].id', kind: 'removed', before: 'b' },
    { path: '$.items[id=b].n', kind: 'removed', before: 2 },
  ])
  // 消费方要「某个元素整体没了」时按前缀聚合
  const gonePrefixes = [...new Set(
    r.changes.filter((c) => c.kind === 'removed').map((c) => c.path.replace(/\.[^.]+$/, '')),
  )]
  assert.deepEqual(gonePrefixes, ['$.items[id=b]'])
})

test('name 也是身份键（DEFAULT_KEY_HINTS 里含 name）', () => {
  const r = diffValues(
    { list: [{ name: 'x', v: 1 }] },
    { list: [{ name: 'x', v: 2 }] },
  )
  assert.deepEqual(r.changes, [
    { path: '$.list[name=x].v', kind: 'changed', before: 1, after: 2 },
  ])
  assert.ok(DEFAULT_KEY_HINTS.includes('name'))
})

test('身份键不唯一时回退到索引 diff', () => {
  const r = diffValues(
    { list: [{ id: 'dup', v: 1 }, { id: 'dup', v: 2 }] },
    { list: [{ id: 'dup', v: 1 }, { id: 'dup', v: 3 }] },
  )
  assert.deepEqual(r.changes, [
    { path: '$.list[1].v', kind: 'changed', before: 2, after: 3 },
  ])
})

test('无身份键的对象数组走索引 diff', () => {
  const r = diffValues({ list: [{ a: 1 }] }, { list: [{ a: 1 }, { a: 2 }] })
  assert.deepEqual(r.changes, [{ path: '$.list[1].a', kind: 'added', after: 2 }])
})

test('原始值数组的边界：null 算原始值（走集合 diff），对象不算（走索引 diff）', () => {
  const setDiff = diffValues({ s: ['a', 1] }, { s: ['a', 1, null] })
  assert.deepEqual(setDiff.changes, [{ path: '$.s', kind: 'added', value: null, index: 2 }])

  const idxDiff = diffValues({ s: ['a', { x: 1 }] }, { s: ['a', { x: 1 }, null] })
  assert.deepEqual(idxDiff.changes, [{ path: '$.s[2]', kind: 'added', after: null }])
})

test('numberTolerance 吸收浮点抖动', () => {
  const before = { pos: { x: 1.0000001, y: 2 } }
  const after = { pos: { x: 1.0000002, y: 2 } }
  assert.equal(diffValues(before, after).counts.total, 1, '默认零容差时抖动应被报出')
  assert.equal(diffValues(before, after, { numberTolerance: 0.001 }).counts.total, 0)
  assert.equal(diffValues({ x: 1 }, { x: 5 }, { numberTolerance: 0.001 }).counts.total, 1)
})

test('ignore 支持「只写字段名」', () => {
  const before = { meta: { playtime: 100, saveDate: 'd1' }, level: 1 }
  const after = { meta: { playtime: 200, saveDate: 'd2' }, level: 2 }
  const r = diffValues(before, after, { ignore: ['playtime', 'saveDate'] })
  assert.deepEqual(r.changes, [{ path: '$.level', kind: 'changed', before: 1, after: 2 }])
})

test('VOLATILE_DEFAULTS 能压掉一组噪声字段', () => {
  const before = { timestamp: 1, playtime: 1, seed: 1, tick: 1, level: 1 }
  const after = { timestamp: 2, playtime: 2, seed: 2, tick: 2, level: 2 }
  const r = diffValues(before, after, { ignore: VOLATILE_DEFAULTS })
  assert.deepEqual(r.changes, [{ path: '$.level', kind: 'changed', before: 1, after: 2 }])
})

test('ignore 支持路径模式、通配与 **', () => {
  const before = { a: { b: { c: 1 } }, keep: 1 }
  const after = { a: { b: { c: 2 } }, keep: 2 }
  assert.equal(diffValues(before, after, { ignore: ['$.a.b.c'] }).counts.total, 1)
  assert.equal(diffValues(before, after, { ignore: ['$.a.*.c'] }).counts.total, 1)
  assert.equal(diffValues(before, after, { ignore: ['$.**.c'] }).counts.total, 1)
  assert.equal(diffValues(before, after, { ignore: ['$.a.**'] }).counts.total, 1)
  assert.equal(diffValues(before, after, { ignore: ['$.a.**', 'keep'] }).counts.total, 0)
})

test('ignore 支持正则（正则测的是完整路径串，如 "$.hp"）', () => {
  assert.equal(diffValues({ hp: 1 }, { hp: 2 }, { ignore: [/^\$\.hp$/] }).counts.total, 0)
  assert.equal(diffValues({ hp: 1 }, { hp: 2 }, { ignore: [/^\$\.mp$/] }).counts.total, 1)
})

test('maxChanges 触发截断并如实置 truncated', () => {
  const before = {}, after = {}
  for (let i = 0; i < 50; i++) after[`k${i}`] = i
  const r = diffValues(before, after, { maxChanges: 10 })
  assert.equal(r.changes.length, 10)
  assert.equal(r.truncated, true)
  assert.equal(r.counts.total, 10)
})

test('未截断时 truncated 为 false', () => {
  assert.equal(diffValues({ a: 1 }, { a: 2 }).truncated, false)
})

test('counts 按 kind 分类', () => {
  const r = diffValues(
    { a: 1, b: 2, c: 3 },
    { a: 9, d: 4 },
  )
  assert.deepEqual(r.counts, { added: 1, removed: 2, changed: 1, total: 4 })
  assert.deepEqual(countBy([]), { added: 0, removed: 0, changed: 0, total: 0 })
})

test('类型变化（对象 → 字符串）报 changed 而不是递归', () => {
  const r = diffValues({ v: { a: 1 } }, { v: 'gone' })
  assert.deepEqual(r.changes, [
    { path: '$.v', kind: 'changed', before: { a: 1 }, after: 'gone' },
  ])
})

test('结果可复现：同一输入两次调用深度相等', () => {
  const before = { s: ['a', 'b'], o: { x: 1 }, arr: [{ id: 'p', v: 1 }] }
  const after = { s: ['a', 'c'], o: { x: 2 }, arr: [{ id: 'p', v: 2 }] }
  const r1 = diffValues(before, after)
  const r2 = diffValues(before, after)
  assert.deepStrictEqual(r1, r2)
  assert.equal(JSON.stringify(r1), JSON.stringify(r2))
})

test('纯函数：不修改入参', () => {
  const before = { a: { b: [1, 2] } }
  const after = { a: { b: [1, 3] } }
  const snapBefore = clone(before)
  const snapAfter = clone(after)
  diffValues(before, after)
  assert.deepStrictEqual(before, snapBefore)
  assert.deepStrictEqual(after, snapAfter)
})

test('深层嵌套不会爆栈，且在 maxDepth 处收敛为一条 changed', () => {
  const build = (n) => { let o = { leaf: 1 }; for (let i = 0; i < n; i++) o = { next: o }; return o }
  const r = diffValues(build(200), build(200))
  assert.equal(r.counts.total, 0, '相同结构应无变化')

  const deepA = build(200), deepB = build(200)
  let p = deepB; for (let i = 0; i < 200; i++) p = p.next
  p.leaf = 2
  const r2 = diffValues(deepA, deepB)
  assert.ok(r2.counts.total >= 1)
  assert.ok(r2.changes.every((c) => c.kind === 'changed' || c.kind === 'added'))
})

test('pathMatches / toSegments 的基本行为', () => {
  assert.deepEqual(toSegments('$.a.b[0].c'), ['a', 'b', '0', 'c'])
  assert.deepEqual(toSegments('$'), [])
  assert.equal(pathMatches('$.a.b', 'b'), true)
  assert.equal(pathMatches('$.a.b', 'z'), false)
  assert.equal(pathMatches('$.a.b', '$.a.b'), true)
  assert.equal(pathMatches('$.a.b', '$.a.*'), true)
  assert.equal(pathMatches('$.a.b', '$.a'), false)
  assert.equal(pathMatches('$.a.b.c', '$.**.c'), true)
  assert.equal(pathMatches('$.c', '$.**.c'), true)
  assert.equal(pathMatches('$.abc', 'a*'), true)
  assert.equal(pathMatches('$.items[id=shield].count', '$.items.*.count'), true)
  assert.equal(pathMatches('$.a.b', /^\$\.a/), true)
  assert.equal(pathMatches('$.a.b', /^\.a/), false, '正则测的是完整路径串，故 "\.a" 开头不匹配')
  assert.equal(pathMatches('$.a.b', ''), false)
})

test('端到端：Godot 风格存档推进一局后的差异（真实字段形状）', () => {
  const before = {
    slot_info_saved_day: '2025-05-01',
    slot_info_saved_time: '01:20:01',
    current_scene: 'Home',
    current_day: 21,
    current_time: 2,
    triggered_stories: ['day1_morning_home', 'day2', 'himemiya_common_1'],
    current_route: 'FREE',
    himemiya_route: 24,
    item_wallet: true,
    item_maid: false,
  }
  const after = {
    ...clone(before),
    slot_info_saved_time: '02:05:44',
    current_scene: 'Office',
    current_day: 22,
    triggered_stories: [...before.triggered_stories, 'day22_story', 'himemiya_common_2'],
    himemiya_route: 28,
    item_maid: true,
  }

  const r = diffValues(before, after, { ignore: VOLATILE_DEFAULTS })

  const added = r.changes.filter((c) => c.kind === 'added' && c.path === '$.triggered_stories')
  assert.deepEqual(added.map((c) => c.value), ['day22_story', 'himemiya_common_2'],
    '新增剧情必须被逐条识别出来 —— 这是「这局推进了什么」的唯一来源')

  assert.ok(r.changes.some((c) => c.path === '$.current_scene' && c.after === 'Office'))
  assert.ok(r.changes.some((c) => c.path === '$.himemiya_route' && c.before === 24 && c.after === 28))
  assert.ok(r.changes.some((c) => c.path === '$.item_maid' && c.after === true))
  assert.ok(r.changes.some((c) => c.path === '$.slot_info_saved_time'),
    'saved_time 不在 VOLATILE_DEFAULTS 里，应当仍被报出')
  assert.equal(r.changes.some((c) => c.path === '$.current_day' && c.after === 22), true)
})
