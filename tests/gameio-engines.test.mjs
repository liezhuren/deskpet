// tests/gameio-engines.test.mjs —— gameio/godot.mjs + gameio/rpgmaker.mjs + gameio/index.mjs
//
// 最要紧的两组：
//   ① RPG Maker 的「两个开关朝相反方向翻转」—— 证明 normalizeSave 不是可选装饰，
//      少了它 diff 会**静默丢事件**（不是精度问题，是丢数据）
//   ② RPG Maker 的**完整离线链路**：造存档 → LZString 压缩 → 解码 → 归一化 → diff → 事件

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import * as godot from '../gameio/godot.mjs'
import * as rpgmaker from '../gameio/rpgmaker.mjs'
import * as unity from '../gameio/unity.mjs'
import { ADAPTERS, ADAPTER_IDS, adapterById, identify, inspect } from '../gameio/index.mjs'
import { validateAdapter, applyNormalize, inferCapability, readTail, unmatchedLines } from '../gameio/base.mjs'
import { resolvePolicy } from '../core/presence.mjs'
import { diffValues } from '../core/diff.mjs'
import { decodeSaveBuffer, FORMAT } from '../core/decode.mjs'
import { compressToBase64 } from '../core/lzstring.mjs'

const T0 = 1_700_000_000_000
const LOW = join(homedir(), 'AppData', 'LocalLow')
const ROAMING = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const REAL_GODOT = join(ROAMING, 'Godot', 'app_userdata', '30 Days in the Workplace')

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'pet-engines-'))
  return { dir: d, done: () => rmSync(d, { recursive: true, force: true }) }
}

/** 造一份真实形状的 MV/MZ 存档。 */
function mvSave() {
  return {
    system: { _saveCount: 12, _framesOnSave: 4.5 * 3600 * 60, _bgmOnSave: { name: 'Theme1' }, _windowTone: [0, 0, 0, 0] },
    switches: { _data: [null, true, false, null] },
    variables: { _data: [null, 0, 5, 0] },
    selfSwitches: { '1,2,A': true },
    actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: 12, _hp: 300, _mp: 40, _classId: 1 }] },
    party: { _gold: 1234, _items: [[1, 3], [7, 1]], _weapons: [], _armors: [], _actors: [1], _steps: 5000 },
    map: { _mapId: 7, _events: { big: { object: 'graph' } }, _interpreter: { running: false } },
    player: { _x: 5, _y: 6, _newX: 5, _newY: 6, _realX: 5.2, _realY: 6.1, _direction: 2 },
  }
}

// ══════════════════ A. Godot ══════════════════

test('godot adapter 符合契约', () => {
  assert.deepEqual(validateAdapter(godot), [])
})

test('★ Godot 的 area 信号：从 USER ERROR 的节点路径里读出场景名', () => {
  // 实测原文形状
  const e = godot.parseLogLine('USER ERROR: Node not found: "../../NPC_AoKawa" (relative to "/root/Home/TimePanel/PhoneMenu").')
  assert.equal(e.kind, 'area')
  assert.equal(e.data.scene, 'Home')
  assert.equal(godot.parseLogLine('USER ERROR: Node not found: "../../Bed" (relative to "/root/Office/TimePanel/PhoneMenu").').data.scene, 'Office')
  // `/root` 之下没有场景段 ⇒ 这行就是个普通 USER ERROR，**不该瞎猜**
  // （注意它对 parseLogLine 来说等于"认不出来"，返回 null；不是返回一个空 scene）
  assert.equal(godot.parseLogLine('USER ERROR: Node not found: "x" (relative to "/root").'), null)
})

test('★ Godot 会重复打同一条错误上万次 ⇒ 默认去重', () => {
  const line = 'USER ERROR: Node not found: "../../PlayerSeat" (relative to "/root/Home/TimePanel/PhoneMenu").'
  const text = Array.from({ length: 500 }, () => line).join('\n')
  assert.equal(godot.parseLog(text, { at: T0 }).length, 1, '同一场景重复报错只该产出一条 area 事件')

  // 两个不同场景 ⇒ 两条
  const two = godot.parseLog([
    line,
    'USER ERROR: Node not found: "../../Bed" (relative to "/root/Office/TimePanel/PhoneMenu").',
  ].join('\n'), { at: T0 })
  assert.deepEqual(two.map((e) => e.data.scene), ['Home', 'Office'])
})

test('Godot 引擎启动行被识别，驱动/堆栈行被过滤', () => {
  assert.equal(godot.parseLogLine('Godot Engine v4.2.2.stable.official.15073afe3 - https://godotengine.org').kind, 'system')
  for (const l of [
    'Vulkan API 1.3.292 - Forward Mobile - Using Vulkan Device #0: AMD - AMD Radeon RX 6950 XT',
    '   at: get_node (scene/main/node.cpp:1651)',
    '--- Debug adapter server started ---',
    'TextServer: Added interface "Dummy"',
  ]) assert.equal(godot.parseLogLine(l), null, `不该产出事件：${l}`)
})

test('Godot 的 SCRIPT ERROR 产出 system，普通 ERROR 不猜', () => {
  const e = godot.parseLogLine('SCRIPT ERROR: Invalid call. Nonexistent function \'foo\' in base \'Node\'.')
  assert.equal(e.kind, 'system')
  assert.match(e.text, /脚本报错/)
  assert.equal(godot.parseLogLine('ERROR: Condition "!is_inside_tree()" is true.'), null,
    '引擎内部报错没有稳定语义，不该冒充游戏事件')
})

test('Godot 的每游戏自定义规则优先', () => {
  const e = godot.parseLogLine('Chapter 3 cleared', { patterns: [{ re: /chapter/i, kind: 'progress', label: '章节' }] })
  assert.equal(e.kind, 'progress')
})

test('★ Godot 真实目录：detect 命中、存档含 .tres 与 dialogic 的 .txt', (t) => {
  if (!existsSync(REAL_GODOT)) { t.skip('本机没有 Godot 游戏目录'); return }
  const d = godot.detect(REAL_GODOT)
  assert.ok(d.score >= 0.9, `置信度应当很高，实际 ${d.score}`)

  const saves = godot.findSaves(REAL_GODOT)
  assert.ok(saves.some((s) => /^savegame0\.tres$/.test(s.name)), '应当认出 .tres 存档')
  assert.ok(!saves.some((s) => /shader_cache|vulkan/.test(s.path)), 'shader_cache / vulkan 是噪声')

  const s = godot.readSession(REAL_GODOT)
  assert.equal(s.version, '4.2.2.stable.official.15073afe3', `实际版本 ${s.version}`)
  assert.equal(s.cleanExit, null, 'Godot 不输出收尾标记，只能说"不确定"')
  t.diagnostic(`Godot：置信度 ${d.score}，存档候选 ${saves.length} 个，版本 ${s.version}`)
})

test('★ 真实 Godot 日志能解析出场景（用真实文件验证 area 信号）', (t) => {
  const log = join(REAL_GODOT, 'logs', 'godot.log')
  if (!existsSync(log)) { t.skip('本机没有 godot.log'); return }
  const { text } = readTail(log, 32 * 1024)
  const evs = godot.parseLog(text, { at: T0 })
  const scenes = evs.filter((e) => e.kind === 'area').map((e) => e.data.scene)
  const raw = godot.parseLog(text, { at: T0, dedup: false })
  t.diagnostic(`真实 godot.log：不去重 ${raw.length} 条 → 去重后 ${evs.length} 条；场景：${scenes.join('、')}`)

  assert.ok(raw.length > 100, `这个日志里本来就有大量重复行（实测 ${raw.length}）`)
  assert.ok(evs.length <= 6, `去重 + 噪声过滤后应当很干净，实际 ${evs.length} 条`)
  assert.ok(scenes.includes('Home') && scenes.includes('Office'),
    `应当读到 Home 与 Office，实际 ${scenes.join('、')}`)
})

test('★ 发现：Godot 日志里混着游戏自己的 print()，这是"每游戏规则"的输入', (t) => {
  const log = join(REAL_GODOT, 'logs', 'godot.log')
  if (!existsSync(log)) { t.skip('本机没有 godot.log'); return }
  const { text } = readTail(log, 32 * 1024)
  const un = unmatchedLines((l, o) => godot.parseLogLine(l, o), text, { minCount: 1 })
  const lines = un.map((u) => u.line)
  t.diagnostic(`未被识别的独特行 ${un.length} 条，例如：${lines.slice(0, 5).join(' / ')}`)
  // 实测确实存在这类行（`saved` / `check money happened` / 裸数字）
  assert.ok(un.length > 0, '应当能看到自己没认出来的行 —— 这正是用户写规则的依据')
  assert.ok(lines.every((l) => l.trim() !== ''))
  // 配了规则之后这些行就能变成事件
  const evs = godot.parseLog(text, { at: T0, patterns: [{ re: /^saved$/i, kind: 'save', label: '游戏内保存' }] })
  assert.ok(evs.some((e) => e.kind === 'save'), '用户配的规则应当能把这类行变成事件')
})

test('★ 反向：真实 Unity 目录不该被判成 Godot，反之亦然', (t) => {
  if (!existsSync(REAL_GODOT)) { t.skip('本机没有 Godot 目录'); return }
  assert.equal(unity.detect(REAL_GODOT).score, 0, 'Godot 目录不该被 Unity adapter 抢答')
  const hk = join(LOW, 'Team Cherry', 'Hollow Knight')
  if (existsSync(hk)) assert.equal(godot.detect(hk).score, 0, 'Unity 目录不该被 Godot adapter 抢答')
})

// ══════════════════ B. RPG Maker ══════════════════

test('rpgmaker adapter 符合契约', () => {
  assert.deepEqual(validateAdapter(rpgmaker), [])
  assert.deepEqual([...rpgmaker.capabilityBase], ['save', 'exit'])
})

test('★ 核心：不归一化的话，两个开关反向翻转会互相抵消、什么都不报', () => {
  const before = { switches: { _data: [null, false, true, null] } }
  const after = { switches: { _data: [null, true, false, null] } }

  const raw = diffValues(before, after)
  assert.equal(raw.counts.total, 0, '这就是问题本身：集合 diff 认为没变')

  const nb = rpgmaker.normalizeSave(before).value
  const na = rpgmaker.normalizeSave(after).value
  const d = diffValues(nb, na)
  assert.equal(d.counts.total, 2, '归一化后两条变化都要在')
  assert.ok(d.changes.some((c) => c.path === '$.switches._data.1' && c.kind === 'added'))
  assert.ok(d.changes.some((c) => c.path === '$.switches._data.2' && c.kind === 'removed'))
})

test('normalizeSave：开关只留 true、变量只留非 0、道具对转成映射', () => {
  const raw = mvSave()
  const { value, sparse } = rpgmaker.normalizeSave(raw)
  assert.deepEqual(value.switches._data, { '1': true })
  assert.deepEqual(value.variables._data, { '2': 5 })
  assert.deepEqual(value.party._items, { '1': 3, '7': 1 })
  assert.deepEqual(value.actors._data['1']._name, '勇者')
  assert.ok(sparse >= 3)
})

test('normalizeSave：剔除纯噪声字段（坐标 / 事件图 / 存档时的 BGM）', () => {
  const { value } = rpgmaker.normalizeSave(mvSave())
  assert.equal(value.player._x, undefined, '玩家坐标每帧在变，是纯噪声')
  assert.equal(value.player._realX, undefined)
  assert.equal(value.map._events, undefined, '_events 是巨大对象图，diff 出来全是噪声')
  assert.equal(value.system._framesOnSave, undefined)
  assert.equal(value.system._bgmOnSave, undefined)
  assert.equal(value.system._saveCount, 12, '存档次数要留下（它不是噪声，是"又存了一次"）')
  assert.equal(value.map._mapId, 7, '地图 id 必须留下 —— 最可靠的 area 信号')
})

test('normalizeSave 不改入参（纯函数）', () => {
  const raw = mvSave()
  const snap = JSON.stringify(raw)
  rpgmaker.normalizeSave(raw)
  assert.equal(JSON.stringify(raw), snap)
})

test('applyNormalize：没有 normalizeSave 的 adapter 走恒等，抛异常也能兜住', () => {
  const v = { a: 1 }
  assert.deepEqual(applyNormalize(unity, v), { value: v, sparse: 0, normalized: false })
  assert.deepEqual(applyNormalize(rpgmaker, v).normalized, true)
  const boom = { normalizeSave() { throw new Error('炸了') } }
  assert.deepEqual(applyNormalize(boom, v), { value: v, sparse: 0, normalized: false })
})

test('★ mapSaveChanges：用 RPG Maker 的已知结构说话', () => {
  const before = rpgmaker.normalizeSave(mvSave()).value
  const raw2 = mvSave()
  raw2.variables._data[2] = 9
  raw2.actors._data[1]._level = 13
  raw2.party._gold = 1500
  raw2.map._mapId = 8
  raw2.switches._data[2] = true
  const after = rpgmaker.normalizeSave(raw2).value

  const { changes } = diffValues(before, after)
  const evs = rpgmaker.mapSaveChanges(changes, { at: T0 })
  const kinds = evs.map((e) => e.kind)

  assert.ok(kinds.includes('area'), '地图切换应当产出 area')
  assert.ok(kinds.includes('item'), '金币变化应当产出 item')
  assert.ok(kinds.includes('progress'), '等级 / 变量 / 开关应当产出 progress')
  assert.ok(evs.some((e) => /地图切换到 8/.test(e.text)), evs.map((e) => e.text).join(' | '))
  assert.ok(evs.some((e) => /金币 1234→1500/.test(e.text)))
  assert.ok(evs.some((e) => /等级 12→13/.test(e.text)))
})

test('★ mapSaveChanges：给了 System.json 的名字表，事件就说人话', () => {
  const before = rpgmaker.normalizeSave({ switches: { _data: [null, false] }, variables: { _data: [null, 0] } }).value
  const after = rpgmaker.normalizeSave({ switches: { _data: [null, true] }, variables: { _data: [null, 3] } }).value
  const { changes } = diffValues(before, after)

  const plain = rpgmaker.mapSaveChanges(changes, { at: T0 })
  assert.ok(plain.some((e) => e.text.includes('#1')), '没有名字表时只能说编号')

  const withNames = rpgmaker.mapSaveChanges(changes, { at: T0, systemNames: { switches: { 1: '打败了魔王' }, variables: { 1: '好感度' } } })
  assert.ok(withNames.some((e) => e.text.includes('「打败了魔王」')), withNames.map((e) => e.text).join(' | '))
  assert.ok(withNames.some((e) => e.text.includes('「好感度」')))
})

test('mapSaveChanges：角色倒下产出 death', () => {
  const before = rpgmaker.normalizeSave({ actors: { _data: [null, { _actorId: 1, _hp: 300 }] } }).value
  const after = rpgmaker.normalizeSave({ actors: { _data: [null, { _actorId: 1, _hp: 0 }] } }).value
  const evs = rpgmaker.mapSaveChanges(diffValues(before, after).changes, { at: T0 })
  assert.equal(evs[0].kind, 'death')
})

test('systemNames 同时支持 MV 与 MZ 的字段名', () => {
  const mv = rpgmaker.systemNames({ gameTitle: 'G', switches: ['', 'A', '', 'B'] })
  assert.deepEqual(mv.switches, { 1: 'A', 3: 'B' })
  assert.equal(mv.gameTitle, 'G')
  const mz = rpgmaker.systemNames(JSON.stringify({ switchNames: ['', 'X'], variableNames: ['', 'Y'] }))
  assert.deepEqual(mz.switches, { 1: 'X' })
  assert.deepEqual(mz.variables, { 1: 'Y' })
  assert.equal(rpgmaker.systemNames('{ 坏 JSON'), null)
  assert.equal(rpgmaker.systemNames({}), null)
})

test('describeSave 抽取能展示的摘要', () => {
  const d = rpgmaker.describeSave(mvSave())
  assert.equal(d.saveCount, 12)
  assert.equal(d.playtimeSec, 16200)
  assert.equal(d.playtimeText, '4:30:00')
  assert.equal(d.mapId, 7)
  assert.equal(d.gold, 1234)
  assert.equal(d.steps, 5000)
  assert.deepEqual(d.actor, { name: '勇者', level: 12, hp: 300, mp: 40 })
  assert.equal(d.partySize, 1)
  assert.equal(d.switchesOn, 1)
  assert.equal(d.variablesSet, 1)
  assert.equal(rpgmaker.describeSave(null), null)
})

test('findSaves 区分槽位与全局存档，并标出能否解析', () => {
  const t = tmp()
  try {
    mkdirSync(join(t.dir, 'save'))
    for (const n of ['file1.rpgsave', 'file2.rpgsave', 'global.rpgsave', 'Save1.rvdata2']) {
      writeFileSync(join(t.dir, 'save', n), 'x'.repeat(200))
    }
    const saves = rpgmaker.findSaves(t.dir)
    assert.equal(saves.length, 4)
    assert.equal(saves.find((s) => s.name === 'global.rpgsave').kind, 'rm-global')
    assert.equal(saves.find((s) => s.name === 'file1.rpgsave').slot, 1)
    assert.equal(saves.find((s) => s.name === 'file2.rpgsave').slot, 2)
    assert.equal(saves.find((s) => s.name === 'file1.rpgsave').decodable, true)
    assert.equal(saves.find((s) => s.name === 'Save1.rvdata2').decodable, false,
      'VX Ace 是 Ruby Marshal，本工具不支持，必须如实标出')
  } finally { t.done() }
})

test('detect：RPG Maker 目录命中，别的引擎目录不命中', () => {
  const t = tmp()
  try {
    mkdirSync(join(t.dir, 'save'))
    writeFileSync(join(t.dir, 'save', 'file1.rmmzsave'), 'x'.repeat(300))
    mkdirSync(join(t.dir, 'data'))
    writeFileSync(join(t.dir, 'data', 'System.json'), '{}')
    assert.ok(rpgmaker.detect(t.dir).score >= 0.9)
    // 反过来：Unity / Godot 的痕迹要压分
    writeFileSync(join(t.dir, 'Player.log'), 'x'.repeat(200))
    assert.ok(rpgmaker.detect(t.dir).score < 0.5, '有 Player.log 时不该还判成 RPG Maker')
  } finally { t.done() }
})

test('★ RPG Maker 完整离线链路：压缩 → 解码 → 归一化 → diff → 事件', () => {
  // ① 造存档并走真实的编码路径（MV/MZ 就是 LZString + base64）
  const before = mvSave()
  const encoded = compressToBase64(JSON.stringify(before))

  // ② 解码（core/decode.mjs 应当认出这是 LZString 包 JSON）
  const dec = decodeSaveBuffer(Buffer.from(encoded, 'utf8'))
  assert.equal(dec.ok, true)
  assert.equal(dec.format, FORMAT.LZSTRING)
  assert.deepEqual(dec.chain, ['lzstring', 'json'])
  assert.deepEqual(dec.value, JSON.parse(JSON.stringify(before)))

  // ③ 一局之后：推了剧情、升了级、换了地图、赚了钱
  const afterRaw = JSON.parse(JSON.stringify(before))
  afterRaw.switches._data[2] = true
  afterRaw.variables._data[2] = 9
  afterRaw.actors._data[1]._level = 13
  afterRaw.party._gold = 1500
  afterRaw.map._mapId = 8
  afterRaw.system._saveCount = 13

  const n0 = rpgmaker.normalizeSave(dec.value)
  const n1 = rpgmaker.normalizeSave(afterRaw)
  const { changes } = diffValues(n0.value, n1.value)

  const evs = rpgmaker.mapSaveChanges(changes, {
    at: T0,
    systemNames: rpgmaker.systemNames({ switches: ['', '', '打开了城门'], variables: ['', '', '好感度'] }),
  })

  assert.ok(evs.some((e) => e.kind === 'area' && /地图切换到 8/.test(e.text)))
  assert.ok(evs.some((e) => e.kind === 'item' && /金币/.test(e.text)))
  assert.ok(evs.some((e) => /「打开了城门」/.test(e.text)), '开关名字应当被解析出来')
  assert.ok(evs.some((e) => /「好感度」/.test(e.text)))
  assert.ok(evs.some((e) => /等级 12→13/.test(e.text)))

  // ④ 事件能直接喂给时机引擎
  const saveEv = { kind: 'save', text: '存档已更新', at: T0, importance: 0.8 }
  assert.ok(evs.length >= 4, `应当产出至少 4 条事件，实际 ${evs.length}`)
  void saveEv
})

test('★ RPG Maker 的存档总是能解开 ⇒ 它天然拿得到高档位（与 Unity 相反）', () => {
  const poor = inferCapability(rpgmaker, { savesDecoded: false })
  assert.equal(poor.rich, false)
  assert.equal(resolvePolicy({ level: 'moderate', capability: poor }).capped, true)

  const rich = inferCapability(rpgmaker, { savesDecoded: true, notes: ['MV/MZ 存档格式固定，必然可解'] })
  assert.equal(rich.rich, true)
  assert.equal(resolvePolicy({ level: 'moderate', capability: rich }).level, 'moderate')
})

// ══════════════════ C. index（注册表与统一入口） ══════════════════

test('注册表：三个 adapter 都在，且都能按 id 取到', () => {
  assert.deepEqual([...ADAPTER_IDS].sort(), ['godot', 'rpgmaker', 'unity'])
  for (const id of ADAPTER_IDS) assert.equal(adapterById(id).id, id)
  assert.equal(adapterById('UNITY').id, 'unity', 'id 查询应当大小写不敏感')
  assert.equal(adapterById('nope'), null)
  assert.equal(ADAPTERS.length, 3)
})

test('identify：识别不出时如实返回 null，而不是硬挑一个', () => {
  const t = tmp()
  try {
    const r = identify(t.dir)
    assert.equal(r.engine, null)
    assert.equal(r.adapter, null)
    assert.match(r.summary, /没有匹配到/)
  } finally { t.done() }
})

test('inspect：未解码存档时 capability 被保守化，并给出理由', () => {
  const t = tmp()
  try {
    mkdirSync(join(t.dir, 'save'))
    writeFileSync(join(t.dir, 'save', 'file1.rpgsave'), 'x'.repeat(300))
    const r = inspect(t.dir)
    assert.equal(r.engine, 'rpgmaker')
    assert.equal(r.capability.rich, false)
    assert.ok(r.capability.reasons.some((x) => x.includes('尚未解出结构')))
    assert.equal(resolvePolicy({ level: 'moderate', capability: r.capability }).capped, true)

    const r2 = inspect(t.dir, { savesDecoded: true })
    assert.equal(r2.capability.rich, true)
  } finally { t.done() }
})

test('inspect：识别不出引擎时仍给出可用的兜底结论', () => {
  const t = tmp()
  try {
    const r = inspect(t.dir)
    assert.equal(r.adapter, null)
    assert.equal(r.capability.rich, false)
    assert.match(r.summary, /存档一变就能触发/,
      '识别不出引擎也要能用 —— 仅凭"文件变了"就足以驱动时机引擎')
  } finally { t.done() }
})

test('inspect 在真实目录上端到端跑得通', (t) => {
  const dirs = [
    [join(LOW, 'Team Cherry', 'Hollow Knight'), 'unity'],
    [REAL_GODOT, 'godot'],
  ]
  let ran = 0
  for (const [dir, expect] of dirs) {
    if (!existsSync(dir)) { t.diagnostic(`skip ${dir}`); continue }
    const r = inspect(dir, { savesDecoded: false })
    assert.equal(r.engine, expect, `${dir} 应当是 ${expect}，实际 ${r.engine}`)
    assert.ok(Array.isArray(r.logs))
    assert.ok(Array.isArray(r.saves))
    assert.ok(r.capability.readable.length >= 1)
    t.diagnostic(`${expect}: 存档 ${r.saves.length} 个 / 日志 ${r.logs.length} 个 / capability ${r.capability.readable.join(',')}`)
    ran++
  }
  assert.ok(ran >= 1, '至少要跑到一个真实目录')
})
