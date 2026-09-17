// tests/decode.test.mjs —— core/decode.mjs 的测试
//
// 分两部分：
//   §1 合成夹具 —— 每个分支各一组，形状取自实测到的真实文件（注释里注明来源）。
//   §2 真实文件 —— **本机存在才跑，否则 skip**。离线造的假数据证明不了真实世界能解，
//      但真实存档里有个人信息，不能提交进仓库，所以只能在本地对拍。
//
// LZString 夹具用 tests/vendor（作者 Pieroxy，WTFPL 授权的参考实现，其内部版本注释为 1.4.5）构造，
// **不用 core/lzstring.mjs** ——
// 这样万一我自己的实现有偏差，也不会把解码链的测试一起带偏，两边互不掩盖。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync, deflateSync } from 'node:zlib'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createRequire } from 'node:module'

import { decodeSaveBuffer, decodeSaveFile, parseIni, parseGodotResource, sniffMagic, looksBinary, FORMAT } from '../core/decode.mjs'

const require = createRequire(import.meta.url)
const refLz = require('./vendor/lz-string.js')

const B = (s) => Buffer.from(s, 'utf8')

// ---------- §1 合成夹具 ----------

test('明文 JSON（含 CRLF 与 BOM）', () => {
  for (const src of ['{"a":1}', '\uFEFF{"a":1}', '  \r\n{"a":1}\r\n']) {
    const r = decodeSaveBuffer(B(src))
    assert.equal(r.ok, true, src)
    assert.equal(r.format, FORMAT.JSON, `BOM/CRLF 不应被当成二进制头部：${JSON.stringify(src)}`)
    assert.equal(r.content, FORMAT.JSON)
    assert.deepEqual(r.value, { a: 1 })
  }
})

test('★ BOM 必须在外层剥掉，不能被误判成「二进制头部 + JSON」', () => {
  const r = decodeSaveBuffer(B('\uFEFF{"a":1}'))
  assert.notEqual(r.format, FORMAT.JSON_OFFSET)
  assert.ok(r.notes.some((n) => n.includes('BOM')), r.notes.join(' / '))
})

test('gzip → JSON（实测：有游戏把存档 gzip 后直接落盘）', () => {
  const r = decodeSaveBuffer(gzipSync(B('{"lv":9}')))
  assert.equal(r.ok, true)
  assert.deepEqual(r.chain, ['gzip', 'json'])
  assert.deepEqual(r.value, { lv: 9 })
})

test('zlib → JSON', () => {
  const r = decodeSaveBuffer(deflateSync(B('{"lv":9}')))
  assert.equal(r.format, FORMAT.ZLIB)
  assert.deepEqual(r.chain, ['zlib', 'json'])
  assert.deepEqual(r.value, { lv: 9 })
})

test('容器嵌套：gzip → gzip → JSON', () => {
  const r = decodeSaveBuffer(gzipSync(gzipSync(B('{"lv":9}'))))
  assert.deepEqual(r.chain, ['gzip', 'gzip', 'json'])
  assert.deepEqual(r.value, { lv: 9 })
})

test('maxDepth 限制嵌套，不死循环也不爆栈', () => {
  let buf = B('{"x":1}')
  for (let i = 0; i < 8; i++) buf = gzipSync(buf)
  const r = decodeSaveBuffer(buf, { maxDepth: 2 })
  assert.equal(r.ok, false)
  assert.ok(r.notes.some((n) => n.includes('maxDepth')), r.notes.join('|'))
})

test('zip 容器：内部条目被解析，不可解析的条目退化为哈希', () => {
  const r = decodeSaveFile(join(import.meta.dirname, 'fixtures', 'zip-save.zip'))
  assert.equal(r.ok, true)
  assert.equal(r.format, FORMAT.ZIP)
  assert.deepEqual(r.value['player.json'], { hp: 100, level: 3, items: ['potion'] })
  assert.deepEqual(r.value['progress.json'], { bosses: ['goblin'], cleared: false })
  assert.match(r.value['readme.txt'].__sha256, /^[0-9a-f]{64}$/)
  assert.equal(r.entries.length, 3)
})

test('★ LZString → JSON（RPG Maker MV/MZ 的 .rpgsave 格式）', () => {
  const save = {
    system: { versionId: 1, saveCount: 12, framesOnSave: 987654 },
    party: { gold: 1234, actors: [{ actorId: 1, level: 12, exp: 3456, hp: 300, mp: 80 }] },
    switches: { 1: true, 2: false },
    variables: { 1: 5, 2: '中文变量' },
  }
  const r = decodeSaveBuffer(B(refLz.compressToBase64(JSON.stringify(save))))
  assert.equal(r.ok, true)
  assert.deepEqual(r.chain, ['lzstring', 'json'])
  assert.deepEqual(r.value, save)
})

test('LZString 解出来不是 JSON 时不认（避免误判）', () => {
  const r = decodeSaveBuffer(B(refLz.compressToBase64('这不是 JSON')))
  assert.notEqual(r.format, FORMAT.LZSTRING)
})

test('★ Godot 资源（.tres）—— 实测信息量最大的格式', () => {
  const src = [
    '[gd_resource type="Resource" script_class="SavedGame" load_steps=2 format=3]',
    '',
    '[ext_resource type="Script" path="res://saved_game/saved_game.gd" id="1"]',
    '',
    '[resource]',
    'script = ExtResource("1")',
    'slot_info_saved_day = "2025-05-01"',
    'current_scene = "Home"',
    'current_day = 21',
    'player_name = "测试"',
    'triggered_stories = Array[String](["day1", "day2", "day3"])',
    'himemiya_route = 24',
    'item_wallet = true',
    'empty_list = Array[String]([])',
    'position = Vector2(1.5, -2)',
  ].join('\n')
  const r = decodeSaveBuffer(B(src))
  assert.equal(r.ok, true)
  assert.equal(r.format, FORMAT.GODOT_RES)
  assert.equal(r.value.slot_info_saved_day, '2025-05-01')
  assert.equal(r.value.current_scene, 'Home')
  assert.equal(r.value.current_day, 21)
  assert.equal(r.value.item_wallet, true)
  assert.deepEqual(r.value.triggered_stories, ['day1', 'day2', 'day3'])
  assert.deepEqual(r.value.empty_list, [])
  assert.deepEqual(r.value.position, { __gd: 'Vector2', raw: '1.5, -2' })
  assert.deepEqual(r.value.script, { __ref: 'ExtResource', id: '1' })
  assert.equal(r.godot.header.script_class, 'SavedGame')
})

test('INI / ConfigFile（实测：Godot settings.ini）', () => {
  const src = '[Ending]\n\nMinaseA=false\nMinaseB=true\n\n[Hscene]\nMinase1=true\n'
  const r = decodeSaveBuffer(B(src))
  assert.equal(r.ok, true)
  assert.equal(r.format, FORMAT.INI)
  assert.deepEqual(r.value, { Ending: { MinaseA: false, MinaseB: true }, Hscene: { Minase1: true } })
})

test('INI 的类型推断很保守："1.0" 保持字符串（否则版本号会变成 1）', () => {
  const ini = parseIni('[v]\na=1.0\nb=1.5\nc=42\nd=true\ne=abc\nf=-3\n')
  assert.deepEqual(ini.v, { a: '1.0', b: 1.5, c: 42, d: true, e: 'abc', f: -3 })
  assert.equal(typeof ini.v.a, 'string')
})

test('XML（实测：Noita 存档是 XML）', () => {
  const r = decodeSaveBuffer(B('<?xml version="1.0"?><Entity tags="wand"><_Transform position.x="1.5"/></Entity>'))
  assert.equal(r.ok, true)
  assert.equal(r.format, FORMAT.XML)
  assert.equal(r.value.Entity['@tags'], 'wand')
})

test('★ base64 → XML（实测：Ultimate Chicken Horse 的 saveData.uch）', () => {
  const xml = '<UCHSave version="1.11.01" lastSaveDate="07/28/2024 09:15:05"><settings><sound volume="0.8"/></settings></UCHSave>'
  const r = decodeSaveBuffer(B(Buffer.from(xml, 'utf8').toString('base64')))
  assert.equal(r.ok, true)
  assert.deepEqual(r.chain, ['base64', 'xml'])
  assert.equal(r.value.UCHSave['@version'], '1.11.01')
  assert.equal(r.value.UCHSave.settings.sound['@volume'], '0.8')
})

test('base64 → JSON', () => {
  // 夹具要够长：isBase64Blob 的 32 字符门槛是为了避免把普通英文单词误判成 base64
  const payload = JSON.stringify({ player: { hp: 100, level: 3, items: ['potion', 'shield'] } })
  const r = decodeSaveBuffer(B(Buffer.from(payload, 'utf8').toString('base64')))
  assert.equal(r.ok, true)
  assert.deepEqual(r.chain, ['base64', 'json'])
  assert.deepEqual(r.value, JSON.parse(payload))
})

test('过短的 base64 文本不当作 base64（宁可漏，不可误报）', () => {
  const r = decodeSaveBuffer(B(Buffer.from('{"a":1}', 'utf8').toString('base64')))
  assert.notEqual(r.format, FORMAT.BASE64)
})

test('★ 单行 base64 但解不出文本 ⇒ 如实报「多半加密」，不假装解开', () => {
  const blob = Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 37 + 11) % 256))
  const b64 = blob.toString('base64')
  assert.ok(b64.length >= 32 && !/\s/.test(b64), '夹具本身得是单行 base64')
  const r = decodeSaveBuffer(B(b64))
  assert.equal(r.ok, false)
  assert.equal(r.format, FORMAT.BASE64_BINARY)
  assert.match(r.sha256, /^[0-9a-f]{64}$/, '解不开也必须留下哈希')
})

test('短文本不会被误判成 base64', () => {
  for (const s of ['test', 'note', 'abcd', 'hello world']) {
    assert.notEqual(decodeSaveBuffer(B(s)).format, FORMAT.BASE64_BINARY, s)
  }
})

test('★ 头部 + 明文 JSON（实测：失落城堡 game_save.sav 前 2 字节是头）', () => {
  const r = decodeSaveBuffer(Buffer.concat([Buffer.from([0xb7, 0x41]), B('{"record":[{"gameRound":19}]}')]))
  assert.equal(r.ok, true)
  assert.equal(r.format, FORMAT.JSON_OFFSET)
  assert.deepEqual(r.chain, ['json@offset', 'json'])
  assert.equal(r.value.record[0].gameRound, 19)
})

test('★ BinaryFormatter：识别得出来，但不假装能解析', () => {
  const buf = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x01]), Buffer.alloc(64, 0x41)])
  const r = decodeSaveBuffer(buf)
  assert.equal(r.ok, false)
  assert.equal(r.format, FORMAT.BINARY_FORMATTER)
  assert.match(r.sha256, /^[0-9a-f]{64}$/)
  assert.ok(r.notes.some((n) => n.includes('BinaryFormatter')))
})

test('高熵二进制 ⇒ binary，且仍有哈希', () => {
  const buf = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 131 + 7) % 256))
  const r = decodeSaveBuffer(buf)
  assert.equal(r.ok, false)
  assert.equal(r.format, FORMAT.BINARY)
  assert.match(r.sha256, /^[0-9a-f]{64}$/)
})

test('空文件 ⇒ empty', () => {
  const r = decodeSaveBuffer(Buffer.alloc(0))
  assert.equal(r.ok, false)
  assert.equal(r.format, FORMAT.EMPTY)
  assert.equal(r.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('超过 maxBytes ⇒ too-large，但哈希照样给出', () => {
  const r = decodeSaveBuffer(B('{"a":1}'), { maxBytes: 4 })
  assert.equal(r.ok, false)
  assert.equal(r.format, FORMAT.TOO_LARGE)
  assert.match(r.sha256, /^[0-9a-f]{64}$/)
})

test('★ 无论成功与否，sha256 / size / notes 一律存在（时机引擎只依赖这个）', () => {
  const cases = [
    B('{"a":1}'), Buffer.alloc(0), Buffer.from([0, 1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1]),
    B('随便一段没人认识的文本内容，长度要够但不是任何已知格式'.repeat(3)),
    gzipSync(B('{"a":1}')), B(refLz.compressToBase64('{"z":1}')),
  ]
  for (const c of cases) {
    const r = decodeSaveBuffer(c)
    assert.match(r.sha256, /^[0-9a-f]{64}$/)
    assert.equal(r.size, c.length)
    assert.ok(Array.isArray(r.notes) && r.notes.length > 0, '每一步都该留下说明')
  }
})

test('文本但非已知格式 ⇒ text，且保留原文便于诊断', () => {
  const src = '这是一份没有任何已知结构的存档文本内容，长度也足够长到不会被当成 base64 处理。'
  const r = decodeSaveBuffer(B(src))
  assert.equal(r.ok, false)
  assert.equal(r.format, FORMAT.TEXT)
  assert.equal(r.text, src)
})

test('同一输入两次解码结果完全一致（sha256 与 format 都要稳定）', () => {
  const src = gzipSync(B('{"a":[1,2,3]}'))
  const a = decodeSaveBuffer(src), b = decodeSaveBuffer(src)
  assert.equal(a.sha256, b.sha256)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('嗅探函数本身：magic 与 binary 判定', () => {
  assert.equal(sniffMagic(gzipSync(B('x'))), 'gzip')
  assert.equal(sniffMagic(deflateSync(B('x'))), 'zlib')
  assert.equal(sniffMagic(B('{"a":1}')), null)
  assert.equal(sniffMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip')
  assert.equal(looksBinary(Buffer.from([0, 1, 2])), true)
  assert.equal(looksBinary(B('hello')), false)
})

test('decodeSaveFile：不存在的路径不抛异常，返回可诊断结果', () => {
  const r = decodeSaveFile(join(tmpdir(), 'definitely-not-here-9f3a2b.dat'))
  assert.equal(r.ok, false)
  assert.ok(r.notes.length > 0)
})

test('decodeSaveFile：目录不当文件处理', () => {
  const r = decodeSaveFile(tmpdir())
  assert.equal(r.ok, false)
  assert.ok(r.notes.some((n) => n.includes('目录')))
})

test('decodeSaveFile：附带 path / size / mtimeMs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-decode-'))
  try {
    const p = join(dir, 'save.json')
    writeFileSync(p, '{"ok":true}', 'utf8')
    const r = decodeSaveFile(p)
    assert.equal(r.path, p)
    assert.equal(r.size, 11)
    assert.ok(r.mtimeMs > 0)
    assert.deepEqual(r.value, { ok: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- §2 真实文件（本机存在才跑） ----------

const LOW = join(homedir(), 'AppData', 'LocalLow')
const ROAMING = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const REAL = [
  // 实测：.NET BinaryFormatter，magic 00 01 00 00 00 ff ff ff ff
  { p: join(LOW, 'Team Cherry', 'Hollow Knight', 'user1.dat'), format: FORMAT.BINARY_FORMATTER, name: '空洞骑士存档' },
  // 实测：明文 JSON，含 Stats.* 成就布尔量
  { p: join(LOW, 'Endnight', 'SonsOfTheForest', 'Saves', '76561199218214769', 'PlayerProfile.json'), format: FORMAT.JSON, name: '森林之子 PlayerProfile' },
  // 实测：Godot 文本资源，含 triggered_stories 数组
  { p: join(ROAMING, 'Godot', 'app_userdata', '30 Days in the Workplace', 'savegame0.tres'), format: FORMAT.GODOT_RES, name: 'Godot 存档' },
  // 实测：Noita 的 XML 存档
  { p: join(LOW, 'Nolla_Games_Noita', 'save00', 'persistent', 'bones_new', 'item15180.xml'), format: FORMAT.XML, name: 'Noita XML' },
  // 实测：base64 包 XML ⇒ 外层 base64、内容是 xml
  { p: join(LOW, 'Clever Endeavour Games', 'Ultimate Chicken Horse', 'saveData.uch'), format: FORMAT.BASE64, content: FORMAT.XML, name: 'UCH base64+XML' },
  // 实测：单行 base64，解不出文本（加密）
  { p: join(LOW, 'azcat', 'Ecchi＆Craft', 'savecommon.eacsav'), format: FORMAT.BASE64_BINARY, name: 'eacsav 加密' },
]

test('真实存档对拍（本机存在才跑，否则 skip）', (t) => {
  let ran = 0
  for (const c of REAL) {
    if (!existsSync(c.p)) { t.diagnostic(`skip ${c.name}：文件不存在`); continue }
    const r = decodeSaveFile(c.p)
    assert.equal(r.format, c.format, `${c.name} 期望 format=${c.format}，实际 ${r.format}（notes: ${r.notes.join(' / ')}）`)
    if (c.content) assert.equal(r.content, c.content, `${c.name} 期望 content=${c.content}，实际 ${r.content}`)
    assert.match(r.sha256, /^[0-9a-f]{64}$/, c.name)
    ran++
  }
  t.diagnostic(`真实文件对拍：跑了 ${ran} 个`)
})
