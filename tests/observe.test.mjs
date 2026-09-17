// tests/observe.test.mjs —— gameio/observe.mjs：★ 端到端链路
//
// 这份测试存在的唯一理由（HANDOFF §4 未完成 7 / ARCHITECTURE M9）：
//   core/decode、core/diff、core/presence、gameio/* 各层都有自己的测试，
//   但"各层都绿"**不等于**链路是通的。上个项目的真 bug 曾经逃过当时全部 7 套测试。
//   所以这里跑的是**一条完整的链路**：真实形状的存档文件 → 解码 → 归一化 → diff → 事件
//   → 触发 → 时机引擎 → 该不该开口。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { observe, createStore, storeSlot, suggestPatterns, OBSERVE_DEFAULTS } from '../gameio/observe.mjs'
import { readRange } from '../gameio/base.mjs'
import { compressToBase64 } from '../core/lzstring.mjs'
import { initPresence, step, resolvePolicy, summarize } from '../core/presence.mjs'

const T0 = 1_700_000_000_000
const sec = (n) => n * 1000
const LOW = join(homedir(), 'AppData', 'LocalLow')
const ROAMING = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const REAL_GODOT = join(ROAMING, 'Godot', 'app_userdata', '30 Days in the Workplace')

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'pet-observe-'))
  return { dir: d, done: () => rmSync(d, { recursive: true, force: true }) }
}

/** 造一个 RPG Maker 目录，并写一份真实形状的 MV/MZ 存档。 */
function mvGame(over = {}) {
  const save = {
    system: { _saveCount: 12, _framesOnSave: 4.5 * 3600 * 60 },
    switches: { _data: [null, true, false] },
    variables: { _data: [null, 0, 5] },
    actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: 12, _hp: 300, _mp: 40 }] },
    party: { _gold: 1234, _items: [[1, 3]], _weapons: [], _armors: [], _actors: [1], _steps: 5000 },
    map: { _mapId: 7 },
    player: { _x: 5, _y: 6, _realX: 5.2, _realY: 6.1 },
    ...over,
  }
  return save
}

function writeMvSave(dir, save, name = 'file1.rpgsave') {
  mkdirSync(join(dir, 'save'), { recursive: true })
  writeFileSync(join(dir, 'save', name), compressToBase64(JSON.stringify(save)), 'utf8')
}

// ══════════════════ A. 首帧 = 纯基线 ══════════════════

test('★ 首帧只建立基线，一条事件都不产（否则桌宠会对着刚认识的游戏开口）', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvGame())
    const r = observe(t.dir, { now: T0 })
    assert.equal(r.isFirst, true)
    assert.equal(r.baselineOnly, true)
    assert.deepEqual(r.events, [])
    assert.deepEqual(r.triggers, [])
    assert.equal(r.engine, 'rpgmaker')
    assert.equal(r.savesSeen, 1)
    assert.equal(r.savesDecoded, 1, '首帧也要解码 —— 基线需要内容才能下次做 diff')
    assert.ok(r.capability.rich, '存档解出了结构 ⇒ capability 应当升级')
  } finally { t.done() }
})

test('首帧：includeFirstRead 只在诊断时才打开', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvGame())
    const r = observe(t.dir, { now: T0, includeFirstRead: true })
    assert.equal(r.baselineOnly, false)
  } finally { t.done() }
})

test('存档没变 ⇒ 不产事件，也不重复解码', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvGame())
    const r1 = observe(t.dir, { now: T0 })
    const r2 = observe(t.dir, { now: T0 + sec(60), store: r1.store })
    assert.deepEqual(r2.events, [])
    assert.equal(r2.isFirst, false)
    assert.equal(r2.savesDecoded, 0, '文件没变就不该再解码一次')
  } finally { t.done() }
})

// ══════════════════ B. ★ 完整链路（RPG Maker） ══════════════════

test('★ 完整链路：存档变化 → 解码 → 归一化 → diff → 事件 → 触发', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvGame())
    const r1 = observe(t.dir, { now: T0 })

    // 一局之后：推了剧情、升了级、换了地图、赚了钱
    const after = mvGame()
    after.system._saveCount = 13
    after.switches._data[2] = true
    after.variables._data[2] = 9
    after.actors._data[1]._level = 13
    after.party._gold = 1500
    after.map._mapId = 8
    writeMvSave(t.dir, after)

    const r2 = observe(t.dir, { now: T0 + sec(600), store: r1.store, systemNames: { switches: { 2: '打开了城门' }, variables: { 2: '好感度' } } })

    const texts = r2.events.map((e) => e.text)
    assert.ok(r2.events.some((e) => e.kind === 'save'), `必须有"存档已更新"事件。实际：${texts.join(' | ')}`)
    assert.ok(r2.events.some((e) => e.kind === 'area'), '地图切换应当产出 area')
    assert.ok(r2.events.some((e) => e.kind === 'item'), '金币变化应当产出 item')
    assert.ok(r2.events.some((e) => /「打开了城门」/.test(e.text)), '开关名字应当被解析出来')
    assert.ok(r2.events.some((e) => /「好感度」/.test(e.text)))
    assert.ok(r2.events.some((e) => /等级 12→13/.test(e.text)))

    // 存档事件应当带上可读的摘要（describeSave 的功劳）
    const saveEv = r2.events.find((e) => e.kind === 'save')
    assert.match(saveEv.text, /第 13 次存档/)
    assert.match(saveEv.text, /游戏时间 4:30:00/)

    // 触发已经可直接喂给时机引擎
    assert.ok(r2.triggers.length >= 2)
    for (const tr of r2.triggers) {
      assert.equal(tr.type, 'trigger')
      assert.ok(Number.isFinite(tr.at) && Number.isFinite(tr.significance))
    }
  } finally { t.done() }
})

test('★ 完整链路的最后一环：触发 → 时机引擎 → 开口', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvGame())
    const r1 = observe(t.dir, { now: T0 })
    const after = mvGame()
    after.map._mapId = 8
    after.actors._data[1]._level = 13
    writeMvSave(t.dir, after)

    const now2 = T0 + sec(600)
    const r2 = observe(t.dir, { now: now2, store: r1.store })
    const pol = resolvePolicy({ level: 'moderate', capability: r2.capability })
    assert.equal(pol.level, 'moderate', 'RPG Maker 存档必然可解 ⇒ 拿得到中等档')

    let st = initPresence()
    for (const tr of r2.triggers) st = step(st, tr, pol).state
    // 玩家放下手柄
    const out = step(st, { type: 'tick', at: now2 + sec(21), idleSec: 30, gameRunning: true }, pol)

    assert.ok(out.speak, '应当开口')
    assert.equal(out.speak.kind, 'save', '主导触发是存档')
    assert.ok(out.speak.summaries.length >= 2, `应当合并了多条摘要，实际 ${out.speak.summaries.length}`)
    assert.equal(summarize(out.state, { policy: pol }).spokeWhileFocused, 0)
  } finally { t.done() }
})

// ══════════════════ C. ★ 解不开也要能用（P2 的保证） ══════════════════

test('★ 内容完全解不开的存档，仅凭"文件变了"依然产出触发', () => {
  const t = tmp()
  try {
    // 伪装成 .NET BinaryFormatter（实测空洞骑士 user1.dat 的 magic 就是这样）
    const binfmt = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01]),
      Buffer.alloc(400, 0x41),
    ])
    mkdirSync(join(t.dir, 'save'), { recursive: true })
    const p = join(t.dir, 'save', 'opaque.dat')
    writeFileSync(p, binfmt)

    // 先用 Unity adapter 保证识别（这个目录没有引擎特征，所以强制指定）
    const r1 = observe(t.dir, { now: T0, adapter: 'unity' })
    assert.equal(r1.engine, 'unity', '显式指定的 adapter 不该被 detect 打分否决')
    assert.equal(r1.savesDecoded, 0, '解不开就不该谎报解开了')
    assert.equal(r1.capability.rich, false)
    assert.equal(resolvePolicy({ level: 'moderate', capability: r1.capability }).capped, true,
      '读不出内容的游戏必须被封顶在保守档')

    writeFileSync(p, Buffer.concat([binfmt, Buffer.alloc(50, 0x42)]))
    const r2 = observe(t.dir, { now: T0 + sec(300), store: r1.store, adapter: 'unity' })

    assert.equal(r2.events.length, 1, `只该有一条"存档已更新"。实际：${r2.events.map((e) => e.text).join(' | ')}`)
    assert.equal(r2.events[0].kind, 'save')
    assert.equal(r2.triggers.length, 1)
    assert.ok(r2.notes.some((n) => n.includes('解不开')), '必须如实说明内容解不开')
  } finally { t.done() }
})

test('识别不出引擎时，退化成纯文件监视也照样能触发', () => {
  const t = tmp()
  try {
    const p = join(t.dir, 'mystery.sav')
    // 注意夹具要够大：isSaveCandidate 会跳过 < 64 字节的文件（那是实测得出的阈值，挡的是配置碎文件）
    const v1 = JSON.stringify({ hp: 100, level: 3, note: 'x'.repeat(80) })
    const v2 = JSON.stringify({ hp: 90, level: 4, note: 'x'.repeat(80) })
    writeFileSync(p, v1)
    const r1 = observe(t.dir, { now: T0 })
    assert.equal(r1.engine, null)
    assert.equal(r1.savesSeen, 1, '没有 adapter 时也要能找到候选存档')
    assert.ok(r1.notes.some((n) => n.includes('只按纯文件监视')))

    writeFileSync(p, v2)
    const r2 = observe(t.dir, { now: T0 + sec(120), store: r1.store })
    assert.equal(r2.events.length, 1)
    assert.equal(r2.events[0].kind, 'save')
  } finally { t.done() }
})

test('太小的文件不算存档候选（挡的是配置碎文件，不是内容）', () => {
  const t = tmp()
  try {
    writeFileSync(join(t.dir, 'tiny.sav'), '{}')
    const r = observe(t.dir, { now: T0 })
    assert.equal(r.savesSeen, 0)
  } finally { t.done() }
})

// ══════════════════ D. 日志通道的增量读取 ══════════════════

test('★ 日志增量：只有新增的部分会被解析，旧内容不重复产事件', () => {
  const t = tmp()
  try {
    mkdirSync(join(t.dir, 'logs'), { recursive: true })
    const log = join(t.dir, 'logs', 'godot.log')
    writeFileSync(log, 'Godot Engine v4.2.2.stable.official.15073afe3 - https://godotengine.org\n', 'utf8')

    const r1 = observe(t.dir, { now: T0 })
    assert.equal(r1.engine, 'godot')
    assert.deepEqual(r1.events, [], '首帧是基线')

    appendFileSync(log, 'USER ERROR: Node not found: "../../Bed" (relative to "/root/Office/TimePanel/PhoneMenu").\n', 'utf8')
    const r2 = observe(t.dir, { now: T0 + sec(60), store: r1.store })
    assert.equal(r2.events.length, 1)
    assert.equal(r2.events[0].kind, 'area')
    assert.equal(r2.events[0].data.scene, 'Office')

    // 再观测一次，没有新内容 ⇒ 不产事件
    const r3 = observe(t.dir, { now: T0 + sec(120), store: r2.store })
    assert.deepEqual(r3.events, [])
  } finally { t.done() }
})

test('★ 日志被重写（长度变小）时从头读起，并如实说明', () => {
  const t = tmp()
  try {
    mkdirSync(join(t.dir, 'logs'), { recursive: true })
    const log = join(t.dir, 'logs', 'godot.log')
    writeFileSync(log, 'Godot Engine v4.2.2.stable\n' + 'USER ERROR: Node not found: "x" (relative to "/root/Home/A").\n'.repeat(50), 'utf8')
    const r1 = observe(t.dir, { now: T0 })
    void r1

    writeFileSync(log, 'Godot Engine v4.2.2.stable\nUSER ERROR: Node not found: "y" (relative to "/root/Outside/B").\n', 'utf8')
    const r2 = observe(t.dir, { now: T0 + sec(60), store: r1.store })
    assert.ok(r2.notes.some((n) => n.includes('被重写')), r2.notes.join(' | '))
    assert.ok(r2.events.some((e) => e.data?.scene === 'Outside'))
    assert.ok(!r2.events.some((e) => e.data?.scene === 'Home'), '重写后旧内容不该再产事件')
  } finally { t.done() }
})

test('readRange：默认原样返回；只有明确要求时才丢半截首行', () => {
  const t = tmp()
  try {
    const p = join(t.dir, 'x.log')
    writeFileSync(p, 'abcdefghij\nklmnopqrst\n', 'utf8')
    const r = readRange(p, 0, 1024)
    assert.equal(r.from, 0)
    assert.equal(r.to, 22)
    assert.match(r.text, /^abcdefghij/)

    // 从中间切进来：默认原样返回（因为调用方若把偏移记在行边界上，首行本就是完整的）
    const mid = readRange(p, 5, 1024)
    assert.match(mid.text, /^fghij/, '默认不丢 —— 丢首行会把边界对齐时的整条新增事件吃掉')
    const dropped = readRange(p, 5, 1024, { dropPartialFirstLine: true })
    assert.match(dropped.text, /^klmnopqrst/, '明确要求时才丢')

    const r3 = readRange(p, 9999, 1024)
    assert.equal(r3.reset, true, '偏移超出文件长度 ⇒ reset')
    assert.equal(r3.from, 0)
  } finally { t.done() }
})

// ══════════════════ E. store 的持久化与纯性 ══════════════════

test('★ store 能 JSON 往返（进程重启后仍知道"上次是什么样"）', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvGame())
    const r1 = observe(t.dir, { now: T0 })
    const roundTripped = JSON.parse(JSON.stringify(r1.store))

    const after = mvGame()
    after.map._mapId = 42
    writeMvSave(t.dir, after)
    const r2 = observe(t.dir, { now: T0 + sec(60), store: roundTripped })
    assert.equal(r2.isFirst, false, '往返后不该被当成首次观测')
    assert.ok(r2.events.some((e) => e.kind === 'area'))
  } finally { t.done() }
})

test('observe 不修改传入的 store（返回新 store）', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvGame())
    const r1 = observe(t.dir, { now: T0 })
    const snap = JSON.stringify(r1.store)
    observe(t.dir, { now: T0 + sec(60), store: r1.store })
    assert.equal(JSON.stringify(r1.store), snap, '入参 store 被改动了')
  } finally { t.done() }
})

test('storeSlot 会建槽（调用方要小心它是带副作用的）', () => {
  const s = createStore()
  const slot = storeSlot(s, 'X')
  assert.deepEqual(slot, { saves: {}, logs: {}, firstSeenAt: null, lastSeenAt: null })
  assert.ok('X' in s.games)
})

test('★ 存档变了但识别不出语义时，如实把「变化位置」列出来（用户据此写规则）', () => {
  const t = tmp()
  try {
    // 这些字段名刻意都不命中信号词表，模拟"某游戏的存档字段我们完全不认识"
    writeFileSync(join(t.dir, 'weird.json'), JSON.stringify({ qzx: 1, wvy: 2, pad: 'x'.repeat(80) }))
    const r1 = observe(t.dir, { now: T0, adapter: 'unity' })

    writeFileSync(join(t.dir, 'weird.json'), JSON.stringify({ qzx: 9, wvy: 2, pad: 'x'.repeat(80) }))
    const r2 = observe(t.dir, { now: T0 + sec(60), store: r1.store, adapter: 'unity' })

    assert.equal(r2.events.length, 1, '只该有"存档已更新"')
    assert.equal(r2.events[0].kind, 'save')
    const note = r2.notes.find((n) => n.includes('没有可叙述的事件'))
    assert.ok(note, `应当有一条说明，实际：${r2.notes.join(' | ')}`)
    assert.match(note, /\$\.qzx/, '必须给出具体变化位置，否则用户无从下手写规则')
  } finally { t.done() }
})

test('★ 天数 / 点数这类真实字段现在能映射成 progress（实测字段：dayCount / hPoint / totalPoint）', () => {
  const t = tmp()
  try {
    const v = { dayCount: 24, hPoint: 9454, totalPoint: 59604, pad: 'x'.repeat(80) }
    writeFileSync(join(t.dir, 'save.json'), JSON.stringify(v))
    const r1 = observe(t.dir, { now: T0, adapter: 'unity' })
    writeFileSync(join(t.dir, 'save.json'), JSON.stringify({ ...v, dayCount: 31, hPoint: 9461, totalPoint: 59611 }))
    const r2 = observe(t.dir, { now: T0 + sec(60), store: r1.store, adapter: 'unity' })

    const progress = r2.events.filter((e) => e.kind === 'progress')
    assert.equal(progress.length, 3, `三条字段变化都该映射出来，实际 ${progress.length}：${r2.events.map((e) => e.text).join(' | ')}`)
    assert.ok(r2.events.some((e) => /dayCount/.test(e.text)))
    assert.ok(r2.triggers.length >= 2, '这些触发应当能喂给时机引擎')
  } finally { t.done() }
})

test('compact 生效：超大存档的值不会把 store 撑爆', () => {
  const t = tmp()
  try {
    const big = mvGame()
    // 造一个很宽的 map._events（RPG Maker 的 _events 真实存在且很大）
    big.map._events = {}
    for (let i = 0; i < 6000; i++) big.map._events[`e${i}`] = { x: i, y: i, note: 'x'.repeat(20) }
    writeMvSave(t.dir, big)
    const r1 = observe(t.dir, { now: T0 })
    const savedValue = r1.store.games[t.dir].saves[Object.keys(r1.store.games[t.dir].saves)[0]].value
    const size = JSON.stringify(savedValue ?? null).length
    assert.ok(size < 400 * 1024, `store 里的值应当被裁剪，实际 ${size} 字节`)
  } finally { t.done() }
})

// ══════════════════ F. suggestPatterns（给配置界面用） ══════════════════

test('★ suggestPatterns 把"认不出来的日志行"摆给用户看', (t) => {
  const log = join(REAL_GODOT, 'logs', 'godot.log')
  if (!existsSync(log)) { t.skip('本机没有 godot.log'); return }
  const r = suggestPatterns(REAL_GODOT)
  assert.equal(r.engine, 'godot')
  t.diagnostic(`未识别的独特行 ${r.lines.length} 条，例如：${r.lines.slice(0, 6).map((x) => x.line).join(' / ')}`)
  // 实测那款游戏的日志里确实混着它自己的 print()
  assert.ok(r.lines.some((x) => /saved|money|^\d+$/i.test(x.line)),
    `应当看到游戏自己打的行，实际：${r.lines.slice(0, 10).map((x) => x.line).join(' / ')}`)
  assert.ok(r.lines.every((x) => x.count >= 1 && x.line.trim() !== ''))
  assert.equal(r.lines[0].count >= r.lines[r.lines.length - 1].count, true, '按出现次数降序')
})

test('suggestPatterns：识别不出引擎时返回空，不抛异常', () => {
  const t = tmp()
  try {
    const r = suggestPatterns(t.dir)
    assert.equal(r.engine, null)
    assert.deepEqual(r.lines, [])
  } finally { t.done() }
})

// ══════════════════ G. 真实目录端到端 ══════════════════

test('★ 真实游戏目录端到端跑得通（本机存在才跑）', (t) => {
  const cases = [
    [join(LOW, 'Team Cherry', 'Hollow Knight'), 'unity'],
    [REAL_GODOT, 'godot'],
  ]
  let ran = 0
  for (const [dir, expect] of cases) {
    if (!existsSync(dir)) { t.diagnostic(`skip ${dir}`); continue }
    const r1 = observe(dir, { now: T0 })
    assert.equal(r1.engine, expect, `${dir} 应当是 ${expect}`)
    assert.equal(r1.baselineOnly, true)
    assert.deepEqual(r1.events, [], '首帧对真实目录同样不产事件')
    assert.ok(r1.savesSeen >= 1, `${dir} 应当至少找到一个存档`)

    const r2 = observe(dir, { now: T0 + sec(60), store: r1.store })
    assert.deepEqual(r2.events, [], '真实文件没变 ⇒ 不该产事件')

    t.diagnostic(`${expect}: 存档 ${r1.savesSeen} 个（解出 ${r1.savesDecoded}）/ 日志 ${r2.logKinds.length ? r2.logKinds.join(',') : '无新事件'} / capability ${r1.capability.readable.join(',')}`)
    ran++
  }
  assert.ok(ran >= 1)
})

test('真实目录：空洞骑士的二进制存档解不开，但 capability 如实降级', (t) => {
  const hk = join(LOW, 'Team Cherry', 'Hollow Knight')
  if (!existsSync(hk)) { t.skip('本机没有空洞骑士目录'); return }
  const r = observe(hk, { now: T0 })
  assert.equal(r.engine, 'unity')
  // 实测 user*.dat 是 .NET BinaryFormatter
  assert.equal(r.savesDecoded, 0, 'BinaryFormatter 不该被当成解开了')
  assert.equal(r.capability.rich, false)
  assert.equal(resolvePolicy({ level: 'moderate', capability: r.capability }).capped, true)
  t.diagnostic(`空洞骑士：存档 ${r.savesSeen} 个，解出 ${r.savesDecoded} 个 ⇒ readable=${r.capability.readable.join(',')}`)
})

test('OBSERVE_DEFAULTS 是有限制的（不会在一款游戏上耗尽时间）', () => {
  assert.ok(OBSERVE_DEFAULTS.maxSaves > 0 && OBSERVE_DEFAULTS.maxSaves <= 32)
  assert.ok(OBSERVE_DEFAULTS.maxNewBytes > 0)
  assert.ok(OBSERVE_DEFAULTS.maxEvents > 0)
})
