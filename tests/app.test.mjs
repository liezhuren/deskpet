// tests/app.test.mjs —— app/ 持久化、外部信号探测、运行时编排
//
// 这一层是主进程里最有状态的部分，也是最容易"只有跑起来才知道对错"的部分。
// 所以刻意把 Electron 挡在外面、把时钟与探测器做成可注入的，于是能在这里离线跑完整链路：
//   存档变化 → 读取 → 决策 → 说出来 → 落盘
// 其中有一条断言是**设计立场**而不是功能：
//   「读不到系统空闲时间 + 游戏在跑 ⇒ 当成专注，不说话」（宁可漏说，不可打扰）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createStore, DEFAULT_SETTINGS, validateSettings, redactSettings, mergeSettings, unknownPaths } from '../app/store.mjs'
import { createProbe, parseTasklist, guessProcessNames, normalizeNames, resolveProcessNames } from '../app/probe.mjs'
import { createRuntime, artActionFor } from '../app/agent.mjs'
import { createMemory } from '../core/memory.mjs'
import { compressToBase64 } from '../core/lzstring.mjs'
import { normalizeCard } from '../core/card.mjs'

const T0 = 1_700_000_000_000
const sec = (n) => n * 1000
const min = (n) => n * 60_000

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'pet-app-'))
  return { dir: d, done: () => rmSync(d, { recursive: true, force: true }) }
}

function mvSave(over = {}) {
  return {
    system: { _saveCount: 12, _framesOnSave: 4.5 * 3600 * 60 },
    switches: { _data: [null, true, false] },
    variables: { _data: [null, 0, 5] },
    actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: 12, _hp: 300, _mp: 40 }] },
    party: { _gold: 1234, _items: [[1, 3]], _weapons: [], _armors: [], _actors: [1], _steps: 5000 },
    map: { _mapId: 7 },
    ...over,
  }
}
function writeSave(dir, save) {
  mkdirSync(join(dir, 'save'), { recursive: true })
  writeFileSync(join(dir, 'save', 'file1.rpgsave'), compressToBase64(JSON.stringify(save)), 'utf8')
}

function heroCard(animation = { temperament: 'lively' }) {
  const { card } = normalizeCard({
    id: 'kasumi', name: '霞', game: 'g', animation,
    persona: {
      soft: { personality: '嘴硬心软', background: '同班同学', speechStyle: '短句' },
      hard: { speechTics: ['……不是'], forbiddenWords: ['本小姐'], addresses: { player: '你' }, avgLength: { min: 4, max: 40 }, emojiPolicy: 'none' },
    },
  })
  return card
}

/** 假探测器：把"游戏在不在跑 / 空闲多久"变成可控输入。 */
function fakeProbe(o = {}) {
  const calls = { isRunning: 0, idle: 0 }
  return {
    calls,
    async isRunning() { calls.isRunning++; return { running: o.running ?? true, matches: [], at: 0, cached: false, error: null, available: true } },
    idleSeconds() { calls.idle++; return o.idle === undefined ? 30 : o.idle },
    setIdleReader() {}, reset() {}, stats: {}, guessProcessNames,
  }
}

// ══════════════════ A. 持久化（app/store.mjs） ══════════════════

test('默认设置齐全，且缺字段会被补上', () => {
  const t = tmp()
  try {
    const s = createStore({ dir: t.dir })
    const cfg = s.getSettings()
    assert.equal(cfg.game.level, 'moderate')
    assert.equal(cfg.llm.provider, 'template')
    assert.equal(cfg.watch.intervalMs, 1000)
    assert.deepEqual([...DEFAULT_SETTINGS.game.processes], [])
  } finally { t.done() }
})

test('★ 设置写入是原子的：不留 .tmp，且内容可完整读回', () => {
  const t = tmp()
  try {
    const s = createStore({ dir: t.dir })
    const r = s.setSettings({ game: { level: 'conservative' } })
    assert.equal(r.ok, true)
    assert.equal(s.getSettings().game.level, 'conservative')
    const files = readdirSync(t.dir)
    assert.ok(files.includes('settings.json'))
    assert.ok(!files.some((f) => f.endsWith('.tmp')), `不该残留临时文件：${files.join(',')}`)
    // 落盘的是合法 JSON
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(t.dir, 'settings.json'), 'utf8')))
  } finally { t.done() }
})

test('★ 未登记的设置路径被拒绝（不能让"写错了却看起来存上了"发生）', () => {
  const t = tmp()
  try {
    const s = createStore({ dir: t.dir })
    const r = s.setSettings({ llm: { apiKye: 'typo' } })   // 故意拼错
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('apiKye')), r.errors.join(' | '))
    assert.equal(s.getSettings().llm.apiKye, undefined, '不该被写进去')
  } finally { t.done() }
})

test('unknownPaths 能认出各种拼错', () => {
  assert.deepEqual(unknownPaths({ llm: { model: 'x' } }), [])
  assert.deepEqual(unknownPaths({ llm: { modle: 'x' } }), ['llm.modle'])
  assert.deepEqual(unknownPaths({ 顶层错: 1 }), ['顶层错'])
  assert.deepEqual(unknownPaths(null), [])
  assert.deepEqual(unknownPaths({ game: { processes: ['a'] } }), [], '数组叶子是合法路径')
})

test('非法值被拦下，返回可读错误', () => {
  const t = tmp()
  try {
    const s = createStore({ dir: t.dir })
    assert.equal(s.setSettings({ game: { level: '很凶' } }).ok, false)
    assert.equal(s.setSettings({ watch: { intervalMs: 10 } }).ok, false, '太快只会白烧 CPU')
    assert.equal(s.setSettings({ pet: { position: ['x', 'y'] } }).ok, false)
    assert.equal(s.setSettings({ game: { level: 'conservative' } }).ok, true)
  } finally { t.done() }
})

test('★ 配了 llm 却没填 key：只给警告、照常保存（运行时会自动退回模板档）', () => {
  const t = tmp()
  try {
    const s = createStore({ dir: t.dir })
    const r = s.setSettings({ llm: { provider: 'llm', apiKey: '' } })
    assert.equal(r.ok, true)
    assert.ok(r.warnings.some((w) => w.includes('退回模板档')), r.warnings.join(' | '))
  } finally { t.done() }
})

test('未实现的图像 provider 会被如实提醒（不静默退回）', () => {
  const s = validateSettings(mergeSettings(DEFAULT_SETTINGS, { art: { provider: '云端某家' } }))
  assert.equal(s.ok, true)
  assert.ok(s.warnings.some((w) => w.includes('退回程序化')))
})

test('★ 坏掉的设置文件退回默认值，不抛异常', () => {
  const t = tmp()
  try {
    writeFileSync(join(t.dir, 'settings.json'), '{ 这不是 JSON', 'utf8')
    const s = createStore({ dir: t.dir })
    assert.doesNotThrow(() => s.getSettings())
    assert.equal(s.getSettings().game.level, 'moderate')
    // 覆盖写之后就恢复正常
    assert.equal(s.setSettings({ game: { level: 'conservative' } }).ok, true)
    assert.equal(s.getSettings().game.level, 'conservative')
  } finally { t.done() }
})

test('★ 密钥脱敏：只露头尾 4 位，且不泄露长度', () => {
  const red = redactSettings({ llm: { apiKey: 'sk-1234567890abcdef' } })
  assert.equal(red.llm.apiKey, 'sk-1****cdef')
  assert.equal(red.llm.apiKeySet, true)
  assert.equal(redactSettings({ llm: { apiKey: 'short' } }).llm.apiKey, '****')
  assert.equal(redactSettings({ llm: {} }).llm.apiKeySet, false)
  assert.equal(redactSettings(null), null, '空输入原样返回 null（不该抛）')
  assert.equal(redactSettings(undefined), undefined)
  assert.equal(redactSettings({}).llm, undefined)
})

test('resetState 清掉状态但保留设置', () => {
  const t = tmp()
  try {
    const s = createStore({ dir: t.dir })
    s.setSettings({ game: { level: 'conservative' } })
    s.setMemory({ entries: [] })
    s.setWatch({ games: {} })
    const removed = s.resetState()
    assert.deepEqual(removed.sort(), ['memory', 'watch'])
    assert.equal(s.getMemory(), null)
    assert.equal(s.getSettings().game.level, 'conservative', '设置必须保留')
  } finally { t.done() }
})

test('未登记的存储名会被拒绝（白名单之外不写）', () => {
  const t = tmp()
  try {
    const s = createStore({ dir: t.dir })
    assert.throws(() => s.write('随便一个名字', {}), /未知的存储名/)
    assert.doesNotThrow(() => s.write('card', { id: 'x' }))
    assert.deepEqual(s.getCard(), { id: 'x' })
  } finally { t.done() }
})

// ══════════════════ B. 外部信号（app/probe.mjs） ══════════════════

test('★ parseTasklist 能正确处理含逗号的内存列', () => {
  const out = [
    '"notepad.exe","1234","Console","1","12,345 K"',
    '"Hollow Knight.exe","5678","Console","1","1,234,567 K"',
    '',
    'INFO: No tasks are running which match the specified criteria.',
  ].join('\r\n')
  const set = parseTasklist(out)
  assert.ok(set.has('notepad.exe'))
  assert.ok(set.has('hollow knight.exe'), '带逗号的列不该把解析搞乱')
  assert.equal(set.size, 2)
})

test('guessProcessNames 会给出多种写法，且小写带后缀', () => {
  const g = guessProcessNames('E:\\games\\Hollow Knight')
  assert.ok(g.includes('hollow knight.exe'))
  assert.ok(g.includes('hollowknight.exe'))
  assert.ok(g.includes('hollow_knight.exe'))
  assert.ok(g.includes('hollow-knight.exe'))
  assert.deepEqual(guessProcessNames(null), [])
  assert.deepEqual(guessProcessNames(''), [])
  assert.ok(guessProcessNames('无扩展名游戏').length > 0)
})

test('normalizeNames 补 .exe 且大小写无关', () => {
  const n = normalizeNames(['Notepad', 'foo.exe', '', null, 42])
  assert.ok(n.includes('notepad.exe'))
  assert.ok(n.includes('notepad'))
  assert.ok(n.includes('foo.exe'))
  assert.equal(n.length, 4)
})

test('★ isRunning：命中判定 + TTL 缓存（不能每秒 spawn 一次 tasklist）', async () => {
  let spawned = 0
  let clock = 0
  const p = createProbe({
    now: () => clock,
    ttlMs: 5000,
    execImpl: async () => { spawned++; return { stdout: '"notepad.exe","1","Console","1","1 K"' } },
  })
  const a = await p.isRunning(['notepad'])
  assert.equal(a.running, true)
  assert.deepEqual(a.matches, ['notepad.exe'])
  assert.equal(spawned, 1)

  clock = 1000
  const b = await p.isRunning(['notepad'])
  assert.equal(b.cached, true)
  assert.equal(spawned, 1, 'TTL 内不该再 spawn')

  clock = 6000
  await p.isRunning(['notepad'])
  assert.equal(spawned, 2, 'TTL 过了应当重新探测')

  // 换一组名字应当立即重新探测（不能用另一组名字的缓存）
  await p.isRunning(['other'])
  assert.equal(spawned, 3)

  const miss = await p.isRunning(['nope'], { force: true })
  assert.equal(miss.running, false)
  assert.deepEqual(miss.matches, [])
})

test('★ isRunning：tasklist 不存在时如实报告不可用，而不是假装"没在运行"', async () => {
  const p = createProbe({ execImpl: async () => { const e = new Error('not found'); e.code = 'ENOENT'; throw e } })
  const r = await p.isRunning(['x'])
  assert.equal(r.available, false)
  assert.match(r.error, /tasklist/)
  assert.equal(r.running, false, '保守起见当作没在跑')
})

test('isRunning：空名字列表直接返回 false，不 spawn', async () => {
  let spawned = 0
  const p = createProbe({ execImpl: async () => { spawned++; return { stdout: '' } } })
  const r = await p.isRunning([])
  assert.equal(r.running, false)
  assert.equal(spawned, 0)
})

test('★ idleSeconds：读不到时返回 null（不是 0、也不是大数）', () => {
  assert.equal(createProbe({ idleReader: () => 42 }).idleSeconds(), 42)
  assert.equal(createProbe({ idleReader: () => null }).idleSeconds(), null)
  assert.equal(createProbe({ idleReader: () => NaN }).idleSeconds(), null)
  assert.equal(createProbe({ idleReader: () => -1 }).idleSeconds(), null)
  assert.equal(createProbe({ idleReader: () => { throw new Error('boom') } }).idleSeconds(), null)
  assert.equal(createProbe({}).idleSeconds(), null, '默认没有 reader ⇒ null')
})

test('★ 返回 null 而不是 0 很关键：0 会被当成"玩家正在专注"，null 才能被区分出来', () => {
  // 这条断言是把设计意图钉住：如果哪天有人"顺手"把 null 改成 0，
  // 那么"读不到空闲时间"与"玩家刚动过键盘"就再也分不开了。
  const p = createProbe({ idleReader: () => null })
  assert.strictEqual(p.idleSeconds(), null)
  assert.notEqual(p.idleSeconds(), 0)
})

test('resolveProcessNames：设置优先；否则由目录名猜并标明是猜的', () => {
  const fromSettings = resolveProcessNames({ configured: ['MyGame.exe'], dir: 'E:\\x\\Hollow Knight' })
  assert.deepEqual(fromSettings.names, ['MyGame.exe'])
  assert.equal(fromSettings.guessed, false)
  assert.equal(fromSettings.source, 'settings')

  const guessed = resolveProcessNames({ configured: [], dir: 'E:\\x\\Hollow Knight' })
  assert.equal(guessed.guessed, true)
  assert.equal(guessed.source, 'folder-name-guess')
  assert.ok(guessed.names.length > 0)

  const none = resolveProcessNames({})
  assert.equal(none.source, 'none')
  assert.deepEqual(none.names, [])
})

// ══════════════════ C. 动作映射 ══════════════════

test('★ 动作映射：说话时按事件类别挑动作，闲着时按 presence 的 act 挑', () => {
  assert.equal(artActionFor({ speakKind: 'save' }), 'talk')
  assert.equal(artActionFor({ speakKind: 'death' }), 'worried')
  assert.equal(artActionFor({ speakKind: 'crash' }), 'worried')
  assert.equal(artActionFor({ speakKind: 'progress' }), 'happy')
  assert.equal(artActionFor({ speakKind: 'manual' }), 'greeting')
  assert.equal(artActionFor({ presenceAction: 'bored' }), 'idleBored')
  assert.equal(artActionFor({ presenceAction: 'idle-shift' }), 'idle')
  assert.equal(artActionFor({}), 'idle')
})

// ══════════════════ D. ★ 运行时编排（app/agent.mjs） ══════════════════

function makeRuntime(o = {}) {
  const t = tmp()
  const store = createStore({ dir: t.dir })
  if (o.settings) store.setSettings(o.settings)
  const probe = fakeProbe(o.probe ?? {})
  const runtime = createRuntime({ store, probe, now: o.now ?? (() => T0) })
  if (o.card) runtime.setCard(o.card)
  return { t, store, probe, runtime }
}

test('★ 没配游戏目录时也能跑：不产事件、按最保守档', async () => {
  const { t, runtime } = makeRuntime({ card: heroCard() })
  try {
    const r = await runtime.pump({ now: T0 })
    assert.deepEqual(r.events, [])
    assert.equal(r.speak, null)
    assert.equal(runtime.session.policy.level, 'conservative', '没有任何 capability 信息 ⇒ 封顶保守')
  } finally { t.done() }
})

test('★ 端到端：存档变化 → 专注期不说 → 放下手柄 → 说出来 → 落盘', async () => {
  const t = tmp()
  try {
    writeSave(t.dir, mvSave())
    const store = createStore({ dir: join(t.dir, 'state') })
    store.setSettings({ game: { dir: t.dir, level: 'moderate' } })
    let clock = T0
    const probe = fakeProbe({ running: true, idle: 2 })
    const runtime = createRuntime({ store, probe, now: () => clock })
    runtime.setCard(heroCard())

    const r0 = await runtime.pump({ now: T0 })
    assert.equal(r0.events.length, 0, '首帧只建基线')

    // 造一次存档变化，玩家还在打
    const after = mvSave(); after.map._mapId = 8; after.actors._data[1]._level = 13
    writeSave(t.dir, after)
    clock = T0 + min(5)
    const r1 = await runtime.pump({ now: clock })
    assert.ok(r1.events.length >= 2, `应当读到事件，实际 ${r1.events.length}`)
    assert.equal(r1.speak, null, '专注期不许开口')

    // 放下手柄
    probe.idleSeconds = () => 45
    clock = T0 + min(5) + sec(30)
    const r2 = await runtime.pump({ now: clock })
    assert.ok(r2.speak, `应当开口，notes=${r2.notes.join(' | ')}`)
    assert.ok(r2.speak.text.length > 0)
    assert.ok(!r2.speak.text.includes('$.'), `不该复述字段：${r2.speak.text}`)
    assert.ok(['talk', 'happy'].includes(r2.action.action), `动作应当是 talk/happy，实际 ${r2.action.action}`)

    // 落盘了
    assert.ok(existsSync(join(store.dir, 'watch.json')))
    assert.ok(existsSync(join(store.dir, 'memory.json')) || existsSync(join(store.dir, 'watch.json')))
  } finally { rmSync(t.dir, { recursive: true, force: true }) }
})

test('★ 读不到空闲时间 + 游戏在跑 ⇒ 当成专注，不打扰（设计立场）', async () => {
  const t = tmp()
  try {
    writeSave(t.dir, mvSave())
    const store = createStore({ dir: join(t.dir, 'state') })
    store.setSettings({ game: { dir: t.dir, level: 'moderate' } })
    let clock = T0
    const probe = fakeProbe({ running: true, idle: null })
    const runtime = createRuntime({ store, probe, now: () => clock })
    runtime.setCard(heroCard())
    await runtime.pump({ now: T0 })

    const after = mvSave(); after.map._mapId = 8
    writeSave(t.dir, after)
    clock = T0 + min(5)
    await runtime.pump({ now: clock })
    clock = T0 + min(5) + sec(60)
    const r = await runtime.pump({ now: clock })
    assert.equal(r.speak, null, '读不到空闲时间又不知道玩家是否在玩 ⇒ 宁可不说话')
    assert.ok(r.notes.some((n) => n.includes('按专注处理')), r.notes.join(' | '))
  } finally { rmSync(t.dir, { recursive: true, force: true }) }
})

test('★ 游戏没在跑时（读不到空闲也无所谓）可以正常开口', async () => {
  const t = tmp()
  try {
    writeSave(t.dir, mvSave())
    const store = createStore({ dir: join(t.dir, 'state') })
    store.setSettings({ game: { dir: t.dir, level: 'moderate' } })
    let clock = T0
    const probe = fakeProbe({ running: false, idle: null })
    const runtime = createRuntime({ store, probe, now: () => clock })
    runtime.setCard(heroCard())
    await runtime.pump({ now: T0 })

    const after = mvSave(); after.map._mapId = 8
    writeSave(t.dir, after)
    clock = T0 + min(5)
    await runtime.pump({ now: clock })
    clock = T0 + min(5) + sec(60)
    const r = await runtime.pump({ now: clock })
    assert.ok(r.speak, `游戏没在跑就不该被"专注"挡住，notes=${r.notes.join(' | ')}`)
  } finally { rmSync(t.dir, { recursive: true, force: true }) }
})

test('★ 玩家主动搭话：不受节流，且会写进记忆', async () => {
  const { t, runtime, store } = makeRuntime({ card: heroCard() })
  try {
    await runtime.pump({ now: T0 })
    const a = await runtime.manual()
    assert.ok(a.utterance, `应当回应，notes=${a.notes.join(' | ')}`)
    assert.equal(a.utterance.manual, true)

    const b = await runtime.manual('刚才那关太难了')
    assert.ok(b.utterance, '立刻再点也要回应（主动搭话不节流）')
    const mem = store.getMemory()
    assert.ok(mem.entries.some((e) => e.kind === 'player-said' && e.text === '刚才那关太难了'), '玩家的原话要进记忆')
  } finally { t.done() }
})

test('★ snapshot 里的密钥一律脱敏', async () => {
  const { t, runtime } = makeRuntime({ card: heroCard(), settings: { llm: { provider: 'llm', apiKey: 'sk-secret-abcdefgh' } } })
  try {
    await runtime.pump({ now: T0 })
    const s = runtime.snapshot()
    assert.equal(s.settings.llm.apiKey, 'sk-s****efgh')
    assert.equal(s.settings.llm.apiKeySet, true)
    assert.ok(!JSON.stringify(s).includes('sk-secret-abcdefgh'), '快照里绝不能出现原文')
  } finally { t.done() }
})

test('★ setCard：不合规的卡不落盘，并给出可读错误', () => {
  const { t, store, runtime } = makeRuntime()
  try {
    const bad = runtime.setCard({ id: 'x', name: 'n', game: 'g', persona: { soft: {}, hard: { emojiPolicy: '总要有' } } })
    assert.equal(bad.ok, false)
    assert.ok(bad.errors.some((e) => e.includes('emojiPolicy')))
    assert.equal(store.getCard(), null, '坏卡不该落盘')

    const good = runtime.setCard(heroCard())
    assert.equal(good.ok, true)
    assert.equal(runtime.card.name, '霞')
    assert.equal(store.getCard().id, 'kasumi')
    assert.equal(store.getSettings().game.cardId, 'kasumi')
  } finally { t.done() }
})

test('★ applySettings：非法设置不改内存里的配置', async () => {
  const { t, runtime } = makeRuntime({ card: heroCard() })
  try {
    const before = runtime.settings.game.level
    const r = runtime.applySettings({ game: { level: '瞎写' } })
    assert.equal(r.ok, false)
    assert.equal(runtime.settings.game.level, before, '失败时不该改掉现有配置')
  } finally { t.done() }
})

test('★ buildArt：没卡时说清楚；有卡时生成并记录动作', async () => {
  const { t, runtime } = makeRuntime()
  try {
    const none = await runtime.buildArt({ dryRun: true })
    assert.equal(none.ok, false)
    assert.ok(none.notes.some((n) => n.includes('还没有角色卡')))

    runtime.setCard(heroCard({ temperament: 'lively' }))
    const r = await runtime.buildArt({ dryRun: true })
    assert.equal(r.ok, true, r.notes.join(' | '))
    assert.deepEqual(Object.keys(r.manifest.actions).sort(), ['greeting', 'happy', 'idle', 'idleBored', 'talk'])
    assert.equal(runtime.frameFor('idle', 0), 'idle/0.png')
    assert.equal(runtime.frameFor('不存在的动作', 0), null)
  } finally { t.done() }
})

test('★ endCurrentSession 会把这一局压成记忆并落盘', async () => {
  const t = tmp()
  try {
    writeSave(t.dir, mvSave())
    const store = createStore({ dir: join(t.dir, 'state') })
    store.setSettings({ game: { dir: t.dir, level: 'moderate' } })
    let clock = T0
    const runtime = createRuntime({ store, probe: fakeProbe({ running: false, idle: 60 }), now: () => clock })
    runtime.setCard(heroCard())
    await runtime.pump({ now: T0 })
    const after = mvSave(); after.map._mapId = 8
    writeSave(t.dir, after)
    clock = T0 + min(5)
    await runtime.pump({ now: clock })

    const r = runtime.endCurrentSession({ now: T0 + 3600_000, durationMs: 3600_000 })
    assert.ok(r.summary, '应当产出汇总')
    assert.match(r.summary.text, /这一局/)
    const mem = store.getMemory()
    assert.ok(mem.entries.some((e) => e.kind === 'summary'))
  } finally { rmSync(t.dir, { recursive: true, force: true }) }
})

test('★ start/stop 用注入的定时器，不真的挂 setInterval（可测且不泄漏）', async () => {
  const { t, runtime } = makeRuntime({ card: heroCard() })
  try {
    let registered = null
    let cleared = null
    const rt = createRuntime({
      store: createStore({ dir: join(t.dir, 'state2') }),
      probe: fakeProbe({ running: false, idle: 60 }),
      now: () => T0,
      setInterval: (fn, ms) => { registered = { fn, ms }; return 'handle' },
      clearInterval: (h) => { cleared = h },
    })
    rt.setCard(heroCard())
    rt.start()
    assert.ok(registered, '应当注册定时器')
    assert.ok(registered.ms >= 250, '间隔不该小于 250ms（更快的轮询只是白烧 CPU）')
    rt.stop()
    assert.equal(cleared, 'handle')
  } finally { t.done() }
})

test('pump 出错不会打崩运行时（错误被记进诊断）', async () => {
  const t = tmp()
  try {
    const store = createStore({ dir: join(t.dir, 'state') })
    // ⚠ 必须设一个 dir，否则 `if (settings.game.dir)` 为假、探测器根本不会被调用 ——
    //   于是"探测炸了"永远不会发生，测试会假装通过。
    store.setSettings({ game: { dir: t.dir } })
    const boom = { isRunning: async () => { throw new Error('探测炸了') }, idleSeconds: () => 1, setIdleReader() {}, reset() {}, stats: {}, guessProcessNames }
    const runtime = createRuntime({ store, probe: boom, now: () => T0 })
    const r = await runtime.pump({ now: T0 })
    assert.ok(r.notes.some((n) => n.includes('探测炸了')), r.notes.join(' | '))
    assert.ok(runtime.diagnostics().errors.length >= 1)
    // 后续还能继续跑
    assert.doesNotThrow(() => runtime.diagnostics())
  } finally { t.done() }
})

test('★ 事件订阅：说话/动作/错误都能被观察到', async () => {
  const t = tmp()
  try {
    writeSave(t.dir, mvSave())
    const store = createStore({ dir: join(t.dir, 'state') })
    store.setSettings({ game: { dir: t.dir, level: 'moderate' } })
    let clock = T0
    const runtime = createRuntime({ store, probe: fakeProbe({ running: false, idle: 60 }), now: () => clock })
    runtime.setCard(heroCard())
    const seen = []
    const off = runtime.on((e) => seen.push(e.type))
    await runtime.pump({ now: T0 })
    clock = T0 + 1000
    await runtime.pump({ now: clock })
    assert.ok(seen.includes('pump'))
    off()
    const n = seen.length
    await runtime.pump({ now: clock + 1000 })
    assert.equal(seen.length, n, '退订之后不该再收到')
  } finally { rmSync(t.dir, { recursive: true, force: true }) }
})

test('listGames / inspectGame 透传且不崩', async () => {
  const { t, runtime } = makeRuntime()
  try {
    assert.ok(Array.isArray(runtime.listGames({ limit: 3 })))
    const r = await runtime.inspectGame(t.dir)
    assert.equal(r.engine, null, '空目录识别不出引擎')
    assert.ok(r.capability)
  } finally { t.done() }
})

// ══════════════════ E. ★ 填表式生成（用户的明确要求） ══════════════════

const LORE = [
  '霞是主角的同班同学，坐在后排。',
  '她的口癖是「……才不是」，嘴上从不承认自己在关心别人。',
  '性格开朗，爱吐槽。',
  '她从不说「谢谢」，只会用行动表达。',
  '称呼主角为「你」。',
].join('\n')

test('★ cardForm 透出空表（格子由主进程从 spec 派生）', () => {
  const { t, runtime } = makeRuntime()
  try {
    const form = runtime.cardForm()
    assert.match(form.format, /form@/)
    assert.ok(Object.keys(form.slots).length >= 8)
    assert.equal(form.slots.id, undefined, '派生字段不该在表里')
    assert.ok(form.slots['persona.hard.speechTics']._ask.length > 0, '每格要带提问')
  } finally { t.done() }
})

test('★ draftCard：不落盘，且明确列出还缺什么', () => {
  const { t, runtime, store } = makeRuntime()
  try {
    const bad = runtime.draftCard({ game: 'g' })
    assert.equal(bad.ok, false)
    assert.ok(bad.errors.some((e) => e.includes('角色名')))
    assert.equal(store.getCard(), null, '草稿不该落盘')

    const ok = runtime.draftCard({ name: '霞', game: 'someday' })
    assert.equal(ok.ok, true)
    assert.ok(ok.gaps.length >= 2, '应当指出还缺口癖/禁用词')
    assert.equal(store.getCard(), null, '草稿仍然不该落盘')
  } finally { t.done() }
})

test('★ fillCard：不写入任何东西，只返回逐格状态', async () => {
  const { t, runtime, store } = makeRuntime()
  try {
    const draft = runtime.draftCard({ name: '霞', game: 'someday' }).card
    const r = await runtime.fillCard({ card: draft, lore: LORE, forceHeuristic: true })
    assert.equal(r.source, 'heuristic')
    assert.ok(r.slots.length >= 4, JSON.stringify(r.slots.map((s) => s.path)))
    for (const s of r.slots) {
      assert.ok(typeof s.path === 'string' && s.status === 'filled')
      assert.ok(typeof s.evidence === 'string' && s.evidence.length > 0)
    }
    assert.ok(r.emptySlots.length >= 1, '没填到的格子也要报出来')
    assert.match(r.providerLine, /启发式/)
    assert.equal(store.getCard(), null, '★ 填表绝不能落盘 —— 还没确认呢')
    assert.equal(runtime.card, null, '运行时也不该换卡')
  } finally { t.done() }
})

test('★ applyFill：没确认的格子不写；确认的才写', async () => {
  const { t, runtime, store } = makeRuntime()
  try {
    const draft = runtime.draftCard({ name: '霞', game: 'someday' }).card
    const filled = await runtime.fillCard({ card: draft, lore: LORE, forceHeuristic: true })
    const tics = filled.slots.find((s) => s.path === 'persona.hard.speechTics')
    assert.ok(tics, '启发式应当抽到口癖')

    const none = runtime.applyFill({ card: draft, lore: LORE, slots: filled.slots, confirmed: {} })
    assert.equal(none.ok, false)
    assert.match(none.errors[0], /没有确认任何格子/)
    assert.equal(store.getCard(), null)

    const only = runtime.applyFill({ card: draft, lore: LORE, slots: filled.slots, confirmed: { 'persona.hard.speechTics': true } })
    assert.equal(only.ok, true)
    assert.equal(only.applied, 1)
    assert.deepEqual(only.card.persona.hard.speechTics, ['……才不是'])
    assert.deepEqual(only.card.persona.hard.forbiddenWords, [], '没确认的格子是空的')
    assert.equal(store.getCard()?.id, only.card.id, '确认写入后应当落盘')
  } finally { t.done() }
})

test('★ applyFill：编造的出处会被挡在卡之外', () => {
  const { t, runtime } = makeRuntime()
  try {
    const draft = runtime.draftCard({ name: '霞', game: 'someday' }).card
    const r = runtime.applyFill({
      card: draft,
      lore: LORE,
      slots: [
        { path: 'persona.hard.speechTics', value: ['……才不是'], evidence: '她的口癖是「……才不是」' },
        { path: 'persona.hard.forbiddenWords', value: ['请'], evidence: '她从来不说请字' },  // 原文里没有
      ],
      confirmed: { 'persona.hard.speechTics': true, 'persona.hard.forbiddenWords': true },
    })
    assert.equal(r.ok, true)
    assert.equal(r.applied, 1)
    assert.equal(r.rejected.length, 1)
    assert.deepEqual(r.card.persona.hard.forbiddenWords, [], '编的禁用词进不来')
  } finally { t.done() }
})

test('★ 端到端：建草稿 → 填表 → 确认 → 卡生效、动作清单也跟着变', async () => {
  const { t, runtime } = makeRuntime()
  try {
    const draft = runtime.draftCard({ name: '霞', game: 'someday' }).card
    assert.equal(draft.animation.temperament, 'calm')
    const filled = await runtime.fillCard({ card: draft, lore: LORE, forceHeuristic: true })
    const confirmed = Object.fromEntries(filled.slots.map((s) => [s.path, true]))
    const r = runtime.applyFill({ card: draft, lore: LORE, slots: filled.slots, confirmed })
    assert.equal(r.ok, true, JSON.stringify(r.errors ?? []))
    assert.ok(r.applied >= 5, `写入太少：${r.applied}`)
    assert.equal(r.card.animation.temperament, 'lively', '气质该被填上')
    assert.ok(r.card.persona.soft.background.length > 0, 'soft 背景也该写进去')
    // 气质变了 ⇒ 需要的动作也变（这是"填表真的生效"的体现，不只是字段被写了）
    const { actionsFor } = await import('../art/actions.mjs')
    assert.ok(actionsFor(r.card).required.includes('greeting'))
    // 卡能过完整校验，且素材能在这张卡上生成
    const art = await runtime.buildArt({ dryRun: true })
    assert.equal(art.ok, true, (art.notes ?? []).join(' | '))
  } finally { t.done() }
})

test('★ 抓取走的是注入的 fetch（真实网络未验证，链路本身可验）', async () => {
  const t = tmp()
  try {
    const store = createStore({ dir: t.dir })
    const runtime = createRuntime({
      store,
      probe: fakeProbe(),
      // ⚠ 正文要够长：fetchLore 的 minUsefulChars 是 120，
      //   太短会（正确地）判成"没抽到有用的东西" —— 那个判定本身在 lore.test.mjs 里单独测。
      fetchImpl: async () => ({
        ok: true, status: 200, url: 'https://example.test/x',
        text: async () => `<html><head><title>霞</title></head><body><p>${LORE.split('\n').join('</p><p>')}</p><p>${'她是班里最不爱说话却又最常吐槽的人。'.repeat(6)}</p></body></html>`,
      }),
    })
    const r = await runtime.fetchLore('https://example.test/x')
    assert.equal(r.ok, true, (r.notes ?? []).join(' | '))
    assert.ok(r.text.includes('……才不是'))
    assert.equal(r.title, '霞')

    // 抽到的正文可以直接拿去填表
    const draft = runtime.draftCard({ name: '霞', game: 'g' }).card
    const filled = await runtime.fillCard({ card: draft, lore: r.text, forceHeuristic: true })
    assert.ok(filled.slots.some((s) => s.path === 'persona.hard.speechTics'))

    // 抓不到时如实报告
    const bad = await runtime.fetchLore('file:///etc/passwd')
    assert.equal(bad.ok, false)
    assert.match(bad.error, /http/)
  } finally { t.done() }
})
