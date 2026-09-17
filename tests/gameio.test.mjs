// tests/gameio.test.mjs —— gameio/base.mjs + gameio/unity.mjs 的测试
//
// 测试分两层：
//   §1 合成夹具 —— 会话、日志行、diff 变化都是可控的
//   §2 真实目录 —— **本机存在才跑**（本机有 50 个真实游戏目录可对拍）
//
// 最要紧的是最后那组「gameio → presence」的联调断言：
// 它证明「读不出信息就别装作读得出」这条约束**真的会限制主动档位**，
// 而不只是文档里的一句话。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import {
  readTail, readHead, walkFiles, isSaveCandidate, validateAdapter, detectEngine,
  inferCapability, triggerFromEvent, timeOf, classifyPath, genericSaveEvents,
  describeDetection, SKIP_DIR, SAVE_SIGNAL_PATTERNS,
} from '../gameio/base.mjs'
import * as unity from '../gameio/unity.mjs'
import { resolvePolicy, step, initPresence, LEVELS } from '../core/presence.mjs'
import { EVENT_KINDS, DEFAULT_IMPORTANCE, createEvent, normalizeEvents } from '../core/events.mjs'
import { diffValues } from '../core/diff.mjs'

const T0 = 1_700_000_000_000
const sec = (n) => n * 1000

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'pet-gameio-'))
  return { dir: d, done: () => rmSync(d, { recursive: true, force: true }) }
}

// ══════════════════ §1a. 读取原语 ══════════════════

test('readTail 只读尾部，并丢掉被切半的首行', () => {
  const t = tmp()
  try {
    const p = join(t.dir, 'big.log')
    const lines = []
    for (let i = 0; i < 5000; i++) lines.push(`line-${i}-${'x'.repeat(40)}`)
    writeFileSync(p, lines.join('\n'), 'utf8')
    const r = readTail(p, 1024)
    assert.equal(r.truncated, true)
    assert.ok(r.size > 200000)
    assert.ok(r.text.length <= 1024)
    assert.ok(r.text.includes('line-4999'), '尾部内容必须在')
    assert.ok(!r.text.includes('line-0-'), '开头内容不该出现')
    for (const l of r.text.split('\n')) {
      if (l) assert.match(l, /^line-\d+-x+$/, `不该出现半截行：${l.slice(0, 30)}`)
    }
  } finally { t.done() }
})

test('readTail 对短文件不截断，readHead 对称', () => {
  const t = tmp()
  try {
    const p = join(t.dir, 's.log')
    writeFileSync(p, 'a\nb\nc', 'utf8')
    assert.equal(readTail(p).truncated, false)
    assert.equal(readTail(p).text, 'a\nb\nc')
    assert.equal(readHead(p).truncated, false)
    assert.match(readHead(p, 2).text, /^a\n/)
    assert.equal(readHead(p, 2).truncated, true)
  } finally { t.done() }
})

// ══════════════════ §1b. 扫描规则 ══════════════════

test('isSaveCandidate 按名字与大小过滤', () => {
  assert.equal(isSaveCandidate('user1.dat', 1000), true)
  assert.equal(isSaveCandidate('LCGeneralSaveData', 1792), true, '没有扩展名的也要认')
  assert.equal(isSaveCandidate('Player.log', 1000), false)
  assert.equal(isSaveCandidate('serialize.framedump', 1e6), false, '崩溃转储不是存档')
  assert.equal(isSaveCandidate('Analytics.crc', 4096), false)
  assert.equal(isSaveCandidate('tiny.dat', 10), false, '太小')
  assert.equal(isSaveCandidate('huge.dat', 128 * 1024 * 1024), false, '太大')
})

test('SKIP_DIR 覆盖实测撞到的噪声目录', () => {
  for (const d of ['AMD', 'shader_cache', 'crashpad', 'desyncs', 'vulkan', 'backtrace']) {
    assert.equal(SKIP_DIR.test(d), true, `${d} 应当被跳过`)
  }
  assert.equal(SKIP_DIR.test('Saves'), false)
})

test('walkFiles 分类并排除噪声，且遵守深度与数量上限', () => {
  const t = tmp()
  try {
    writeFileSync(join(t.dir, 'Player.log'), 'x'.repeat(200))
    writeFileSync(join(t.dir, 'save1.dat'), 'y'.repeat(500))
    writeFileSync(join(t.dir, 'steam_autocloud.vdf'), 'z')
    mkdirSync(join(t.dir, 'shader_cache'))
    writeFileSync(join(t.dir, 'shader_cache', 'junk.dat'), 'q'.repeat(900))
    mkdirSync(join(t.dir, 'sub'))
    writeFileSync(join(t.dir, 'sub', 'Player.log'), 'x'.repeat(300))

    const r = walkFiles(t.dir, { maxDepth: 2 })
    assert.equal(r.logs.length, 2, '两层里的 Player.log 都要找到')
    assert.ok(r.saves.some((s) => s.name === 'save1.dat'))
    assert.ok(!r.saves.some((s) => /shader_cache/.test(s.path)), '噪声目录要被跳过')
    assert.ok(!r.saves.some((s) => /steam_autocloud/.test(s.name)))
    assert.equal(walkFiles(t.dir, { limit: 1 }).saves.length <= 1, true)
  } finally { t.done() }
})

// ══════════════════ §1c. adapter 契约 ══════════════════

test('unity adapter 符合契约', () => {
  assert.deepEqual(validateAdapter(unity), [])
  assert.deepEqual(validateAdapter({}), ['缺少 id', '缺少 name', '缺少 capabilityBase 数组', '缺少方法 detect()', '缺少方法 findLogs()', '缺少方法 findSaves()'])
})

test('★ capabilityBase 只声明结构上总能拿到的类型（不许吹牛）', () => {
  assert.deepEqual([...unity.capabilityBase], ['save', 'exit'])
  for (const k of ['death', 'progress', 'combat', 'item', 'area']) {
    assert.ok(!unity.capabilityBase.includes(k),
      `Unity 日志给不了 ${k}，写进 capabilityBase 就等于骗时机引擎去提高档位`)
  }
})

test('detectEngine 排序，且单个 adapter 抛异常不影响整体', () => {
  const boom = { id: 'boom', name: 'Boom', capabilityBase: [], detect() { throw new Error('炸了') }, findLogs: () => [], findSaves: () => [] }
  const weak = { id: 'weak', name: 'Weak', capabilityBase: [], detect: () => ({ score: 0.4, evidence: [] }), findLogs: () => [], findSaves: () => [] }
  const r = detectEngine('nowhere', [weak, boom])
  assert.equal(r.length, 1)
  assert.equal(r[0].id, 'weak')
  assert.equal(detectEngine('nowhere', []).length, 0)
})

// ══════════════════ §1d. 日志解析 ══════════════════

test('实测的噪声行一律不产生事件', () => {
  const noise = [
    "Mono path[0] = 'D:/1/steamapps/common/Hollow Knight/hollow_knight_Data/Managed'",
    'GfxDevice: creating device client; threaded=1',
    '    Renderer: AMD Radeon RX 6950 XT (ID=0x73a5)',
    "OnLevelWasLoaded was found on GameMap",
    'This message has been deprecated and will be removed in a later version of Unity.',
    "Couldn't find a Game Manager, make sure one exists in the scene.",
    'Unloading 5 Unused Serialized files (Serialized files now loaded: 0)',
    'Graphics tier changed to High',
    'Discovered supported languages: DE, EN, ES, FR, IT, JA, KO, PT, RU, ZH',
  ]
  for (const l of noise) assert.equal(unity.parseLogLine(l), null, `不该产出事件：${l}`)
})

test('★ 正常退出的收尾标记被识别（含 Unity 自己的拼写错误 backned）', () => {
  assert.equal(unity.parseLogLine('Input System module state changed to: Shutdown').kind, 'exit')
  assert.equal(unity.parseLogLine('[Physics::Module] Cleanup current backned.').kind, 'exit',
    '实测原文拼写就是 backned，不能"顺手改对"而漏掉真实日志')
  assert.equal(unity.parseLogLine('Input System polling thread exited.').kind, 'exit')
})

test('★ 收尾标记优先于噪声表：两者有重叠时不能被吃掉', () => {
  // 真踩到的 bug：`[Physics::Module]` 同时出现在噪声表和收尾标记里，
  // 而噪声过滤跑在前面 ⇒ "正常退出"永远识别不出来。
  assert.equal(unity.parseLogLine('[Physics::Module] Id: 0xdecafbad'), null, '同一前缀的纯噪声行仍旧过滤')
  assert.equal(unity.parseLogLine('[Physics::Module] Cleanup current backned.').kind, 'exit',
    '同一前缀的收尾标记必须保住')
})

test('崩溃迹象被识别为 crash', () => {
  assert.equal(unity.parseLogLine('Crash!!!').kind, 'crash')
  assert.equal(unity.parseLogLine('NullReferenceException: Object reference not set').kind, 'crash')
})

test('引擎版本行被识别为 system 且带出版本号', () => {
  const e = unity.parseLogLine('Initialize engine version: 2020.2.2f1 (068178b99f32)')
  assert.equal(e.kind, 'system')
  assert.equal(e.data.version, '2020.2.2f1')
})

test('★ 每游戏自定义规则优先，且只有配了才生效', () => {
  const line = 'Boss defeated: The Hollow Knight'
  assert.equal(unity.parseLogLine(line), null, '默认不认 —— 我们不可能预先知道某游戏打了什么')
  const e = unity.parseLogLine(line, { patterns: [{ re: /Boss defeated/i, kind: 'progress', label: '击败 Boss' }] })
  assert.equal(e.kind, 'progress')
  assert.match(e.text, /击败 Boss/)
  assert.equal(unity.parseLogLine(line, { patterns: [{ re: 'boss defeated', kind: 'combat' }] }).kind, 'combat',
    '字符串形式的正则也要能用')
})

test('parseLog 批量解析并保留顺序', () => {
  const text = [
    'GfxDevice: creating device client; threaded=1',
    'Initialize engine version: 6000.0.50f1',
    'Crash!!!',
    'Unloading 5 Unused Serialized files',
  ].join('\n')
  const out = unity.parseLog(text, { at: T0 })
  assert.deepEqual(out.map((e) => e.kind), ['system', 'crash'])
  assert.equal(out[0].at, T0)
})

// ══════════════════ §1e. 会话读取 ══════════════════

test('★ readSession：正常退出 / 崩溃 / 无法判定（游戏可能还在跑）', () => {
  const t = tmp()
  try {
    const mk = (name, head, tail) => writeFileSync(join(t.dir, name), `${head}\n...\n${tail}\n`, 'utf8')
    // 正常退出
    const d1 = join(t.dir, 'g1'); mkdirSync(d1)
    writeFileSync(join(d1, 'Player.log'),
      'Initialize engine version: 2020.2.2f1\nSteam logged in as 玩家甲\nLoaded saved language code \'ZH\'\nInput System module state changed to: Shutdown\n', 'utf8')
    const s1 = unity.readSession(d1)
    assert.equal(s1.cleanExit, true)
    assert.equal(s1.version, '2020.2.2f1')
    assert.equal(s1.playerName, '玩家甲')
    assert.equal(s1.language, 'ZH')

    // 崩溃（尾部没有收尾标记，但有崩溃迹象）
    const d2 = join(t.dir, 'g2'); mkdirSync(d2)
    writeFileSync(join(d2, 'Player.log'), 'Initialize engine version: 2021.3.1f1\nCrash!!!\n', 'utf8')
    assert.equal(unity.readSession(d2).cleanExit, false)

    // 无收尾标记也无崩溃 ⇒ 必须是 null（不能猜：游戏可能正在运行）
    const d3 = join(t.dir, 'g3'); mkdirSync(d3)
    writeFileSync(join(d3, 'Player.log'), 'Initialize engine version: 2022.1.1f1\nsome random line\n', 'utf8')
    assert.equal(unity.readSession(d3).cleanExit, null)

    // 根本没有日志
    const d4 = join(t.dir, 'g4'); mkdirSync(d4)
    const s4 = unity.readSession(d4)
    assert.equal(s4.cleanExit, null)
    assert.ok(s4.notes.some((n) => n.includes('没有找到')))
    void mk
  } finally { t.done() }
})

test('★ sessionEvents：无收尾标记时，靠进程探测才能判定异常退出', () => {
  const base = { cleanExit: null, endedAt: T0 }
  assert.equal(unity.sessionEvents(base, { gameRunning: true }).length, 0, '还在跑 ⇒ 不能说是崩溃')
  const crashed = unity.sessionEvents(base, { gameRunning: false })
  assert.equal(crashed[0].kind, 'crash')
  assert.equal(crashed[0].data.inferred, true)
  assert.equal(unity.sessionEvents({ cleanExit: true, endedAt: T0 })[0].at, T0)
  assert.equal(unity.sessionEvents({ cleanExit: true }).length, 1)
  assert.equal(unity.sessionEvents({ cleanExit: false }).length, 1)
})

// ══════════════════ §1f. 存档 diff → 事件 ══════════════════

test('classifyPath 按信号词分类', () => {
  assert.equal(classifyPath('$.Stats.CoreGameCompleted'), 'progress')
  assert.equal(classifyPath('$.triggered_stories day22_story'), 'progress')
  assert.equal(classifyPath('$.player.died_count'), 'death')
  assert.equal(classifyPath('$.inventory.potion'), 'item')
  assert.equal(classifyPath('$.current_scene'), 'area')
  assert.equal(classifyPath('$.unknown_thing'), null, '认不出来就说认不出来')
  assert.ok(SAVE_SIGNAL_PATTERNS.length >= 6)
})

test('★ 复数形式必须命中：`triggered_stories` 不能被写成 `story` 的规则漏掉', () => {
  // 这是真踩到的 bug：规则写 `story`，Godot 的字段叫 `triggered_stories`（复数），
  // 于是整整一类进度字段全部静默漏掉 —— 不报错，只是什么都不产出。
  assert.equal(classifyPath('$.triggered_stories'), 'progress')
  assert.equal(classifyPath('$.storyFlags'), 'progress')
  assert.equal(classifyPath('$.stories'), 'progress')
})

test('★ 天数与点数也是进度（实测一款真实 Unity 存档就叫 dayCount / hPoint / totalPoint）', () => {
  // 这三个字段来自真实存档，最初一个信号词都没命中，只报了"存档已更新"
  assert.equal(classifyPath('$.dayCount'), 'progress')
  assert.equal(classifyPath('$.hPoint'), 'progress')
  assert.equal(classifyPath('$.totalPoint'), 'progress')
  assert.equal(classifyPath('$.current_day'), 'progress', '第几天就是进度')
  assert.equal(classifyPath('$.exp'), 'progress')
})

test('★ genericSaveEvents：Godot 的 triggered_stories 新增多条 → 折成一条事件', () => {
  const before = { triggered_stories: ['day1'], current_scene: 'Home' }
  const after = { triggered_stories: ['day1', 'day2', 'day3', 'day4', 'day5', 'day6'], current_scene: 'Office' }
  const { changes } = diffValues(before, after)
  const evs = genericSaveEvents(changes, { at: T0 })
  const progress = evs.filter((e) => e.kind === 'progress')
  assert.equal(progress.length, 1, '同一数组上的多条新增必须折叠：逐条产出会把时机引擎淹没')
  assert.equal(progress[0].data.count, 5)
  assert.ok(progress[0].data.labels.includes('day2'))
  assert.ok(evs.some((e) => e.kind === 'area'), 'current_scene 的变化应当成为 area 事件')
})

test('★ genericSaveEvents：不同顶层字段不能被并成同一件事', () => {
  const { changes } = diffValues(
    { current_scene: 'A', triggered_stories: ['x'] },
    { current_scene: 'B', triggered_stories: ['x', 'y'] },
  )
  const evs = genericSaveEvents(changes, { at: T0 })
  const roots = new Set(evs.map((e) => e.data.path))
  assert.ok(roots.size >= 2, `不同字段应当分开，实际并成了 ${[...roots].join(' / ')}`)
  assert.ok(roots.has('$.triggered_stories'))
})

test('genericSaveEvents：数组元素的变化折到数组根路径', () => {
  const { changes } = diffValues(
    { items: [{ id: 'a', count: 1 }, { id: 'b', count: 1 }] },
    { items: [{ id: 'a', count: 5 }, { id: 'b', count: 9 }] },
  )
  const evs = genericSaveEvents(changes, { at: T0 })
  assert.equal(evs.length, 1)
  assert.equal(evs[0].data.path, '$.items')
  assert.equal(evs[0].data.count, 2)
})

test('genericSaveEvents：认不出来的路径不产出事件（宁可不说）', () => {
  const { changes } = diffValues({ aaa: 1, bbb: 2 }, { aaa: 3, bbb: 4 })
  assert.deepEqual(genericSaveEvents(changes, { at: T0 }), [])
})

test('genericSaveEvents：maxEvents 生效，且能按类别过滤', () => {
  const before = {}, after = {}
  for (let i = 0; i < 40; i++) { before[`progress_${i}`] = 0; after[`progress_${i}`] = 1 }
  const { changes } = diffValues(before, after)
  assert.equal(genericSaveEvents(changes, { maxEvents: 5 }).length, 5)
  const onlyArea = genericSaveEvents(changes, { onlyKinds: ['area'] })
  assert.equal(onlyArea.length, 0)
})

test('unity.mapSaveChanges：没有自定义规则时走通用启发式，有规则时规则优先', () => {
  const { changes } = diffValues({ quest_flag: 0 }, { quest_flag: 1 })
  const auto = unity.mapSaveChanges(changes, { at: T0 })
  assert.equal(auto[0].kind, 'progress')

  const ruled = unity.mapSaveChanges(changes, {
    at: T0,
    saveRules: [{ re: /quest_flag/, kind: 'progress', text: '任务 {path} 有新进展' }],
  })
  assert.equal(ruled.length, 1)
  assert.equal(ruled[0].data.source, 'save-rule')
  assert.match(ruled[0].text, /任务 \$\.quest_flag/)
})

// ══════════════════ §1g. 事件 → 触发 ══════════════════

test('★ 新增的三类事件已在闭集里登记，且重要度对得上「泄压点」', () => {
  for (const k of ['save', 'exit', 'crash']) {
    assert.ok(EVENT_KINDS.includes(k), `${k} 必须登记进 EVENT_KINDS`)
    assert.ok(DEFAULT_IMPORTANCE[k] >= 0.6, `${k} 是泄压点，重要度不该低于 0.6`)
  }
  assert.equal(createEvent({ kind: 'save', text: '存档', at: T0 }).kind, 'save')
})

test('triggerFromEvent 把事件转成时机引擎的触发', () => {
  const ev = createEvent({ kind: 'save', text: '存档已更新', at: T0 })
  const tr = triggerFromEvent(ev)
  assert.deepEqual(tr, { type: 'trigger', at: T0, kind: 'save', significance: DEFAULT_IMPORTANCE.save, summary: '存档已更新' })
  assert.equal(triggerFromEvent(createEvent({ kind: 'save', text: 'x' })), null, '时间无法确定时返回 null，不硬编时间')
  assert.equal(triggerFromEvent(ev, { at: T0 + 5, significance: 0.99 }).significance, 0.99)
})

test('timeOf 能吃秒 / 毫秒 / ISO 字符串', () => {
  assert.equal(timeOf(T0), T0)
  assert.equal(timeOf(String(T0)), T0)
  assert.equal(timeOf('2023-11-14T22:13:20.000Z'), T0)
  assert.ok(Number.isNaN(timeOf(null)))
  assert.ok(Number.isNaN(timeOf('不是时间')))
})

test('★ item 的默认重要度低于保守档门槛 ⇒ 拿到小道具不会来烦你', () => {
  const ev = createEvent({ kind: 'item', text: '获得了药水', at: T0 })
  const tr = triggerFromEvent(ev)
  assert.ok(tr.significance < LEVELS.conservative.minSignificance,
    `item 重要度 ${tr.significance} 应当低于门槛 ${LEVELS.conservative.minSignificance}`)
})

// ══════════════════ §1h. ★ capability 推理（本条最关键） ══════════════════

test('★ 只看到文件与进程信号时，Unity 拿不到高主动档位', () => {
  const cap = inferCapability(unity, {})
  assert.deepEqual([...cap.readable], ['exit', 'save'], 'capabilityOf 返回的是**已排序**的冻结数组')
  assert.equal(cap.rich, false)
  const pol = resolvePolicy({ level: 'moderate', capability: cap })
  assert.equal(pol.level, 'conservative')
  assert.equal(pol.capped, true)
})

test('★ 存档能解出结构时，Unity 才拿到 progress/item/area', () => {
  const cap = inferCapability(unity, { savesDecoded: true })
  for (const k of ['save', 'exit', 'progress', 'item', 'area']) assert.ok(cap.readable.includes(k), k)
  assert.equal(cap.rich, true)
  assert.equal(resolvePolicy({ level: 'moderate', capability: cap }).level, 'moderate')
  assert.ok(cap.reasons.some((r) => r.includes('存档')), '必须给出升级理由')
})

test('★ 日志解析器真匹配到 death 也算数（要有证据，不是自述）', () => {
  const cap = inferCapability(unity, { logKinds: ['death'] })
  assert.ok(cap.readable.includes('death'))
  assert.equal(cap.rich, true)
  assert.ok(cap.reasons.some((r) => r.includes('真实数据')))
})

test('★ 同一个引擎的不同游戏可以有不同的 capability（这才是重点）', () => {
  // 森林之子：存档是明文 JSON ⇒ 读得到进度
  const rich = inferCapability(unity, { savesDecoded: true })
  // 致命公司：存档是高熵加密块 ⇒ 只能知道"文件变了"
  const poor = inferCapability(unity, { savesDecoded: false })
  assert.equal(rich.rich, true)
  assert.equal(poor.rich, false)
  assert.notDeepEqual(rich.readable, poor.readable)
})

// ══════════════════ §1i. ★ gameio → presence 联调 ══════════════════

test('★ 联调：存档事件 + 玩家松懈 → 开口', () => {
  const cap = inferCapability(unity, { savesDecoded: true })
  const pol = resolvePolicy({ level: 'conservative', capability: cap })
  const ev = createEvent({ kind: 'save', text: '存档已更新', at: T0 })
  const tr = triggerFromEvent(ev)
  let st = initPresence()
  st = step(st, tr, pol).state
  const r = step(st, { type: 'tick', at: T0 + sec(21), idleSec: 30, gameRunning: true }, pol)
  assert.equal(r.speak?.kind, 'save')
  assert.equal(r.speak.summaries[0], '存档已更新')
})

test('★ 联调：item 事件在保守档下根本不会触发开口', () => {
  const cap = inferCapability(unity, { savesDecoded: true })
  const pol = resolvePolicy({ level: 'conservative', capability: cap })
  const ev = createEvent({ kind: 'item', text: '获得了药水', at: T0 })
  const tr = triggerFromEvent(ev)
  let st = initPresence()
  const r1 = step(st, tr, pol)
  assert.equal(r1.state.pending, null, '被显著性门槛挡下，连待发言都不该产生')
  assert.equal(r1.state.stats.droppedLowSignificance, 1)
  const r2 = step(r1.state, { type: 'tick', at: T0 + sec(21), idleSec: 30, gameRunning: true }, pol)
  assert.equal(r2.speak, null)
})

test('★ 联调：一局 Unity 游戏的事件流跑完，指标仍然守规矩', () => {
  const cap = inferCapability(unity, { savesDecoded: true })
  const pol = resolvePolicy({ level: 'conservative', capability: cap })
  let st = initPresence()
  let speaks = 0
  for (let i = 0; i < 30; i++) {
    const t = T0 + sec(i * 60)
    // 每 5 分钟一次存档，其间穿插低显著性的道具事件
    if (i % 5 === 0) {
      st = step(st, triggerFromEvent(createEvent({ kind: 'save', text: '存档已更新', at: t })), pol).state
    }
    if (i % 3 === 0) {
      st = step(st, triggerFromEvent(createEvent({ kind: 'item', text: '获得道具', at: t })), pol).state
    }
    const r = step(st, { type: 'tick', at: t + sec(21), idleSec: 40, gameRunning: true }, pol)
    st = r.state
    if (r.speak) speaks++
  }
  assert.ok(speaks >= 1 && speaks <= 2, `半小时内说了 ${speaks} 次，不符合保守档预期`)
  assert.equal(st.stats.spokeWhileFocused, 0)
})

// ══════════════════ §2. 真实目录对拍（本机存在才跑） ══════════════════

const LOW = join(homedir(), 'AppData', 'LocalLow')
const ROAMING = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')

test('★ 真实 Unity 游戏目录：detect 命中、能列出日志与存档', (t) => {
  const hk = join(LOW, 'Team Cherry', 'Hollow Knight')
  if (!existsSync(hk)) { t.skip('本机没有空洞骑士目录'); return }

  const d = unity.detect(hk)
  assert.ok(d.score >= 0.8, `置信度应当很高，实际 ${d.score}（${d.evidence.join('；')}）`)

  const logs = unity.findLogs(hk)
  assert.ok(logs.some((l) => l.kind === 'player-log'))
  const saves = unity.findSaves(hk)
  assert.ok(saves.some((s) => /^user\d+\.dat$/.test(s.name)), '应当认出 user1.dat 之类的存档')
  assert.ok(!saves.some((s) => /steam_autocloud/.test(s.name)))

  const s = unity.readSession(hk)
  assert.ok(Array.isArray(s.notes) && s.notes.length > 0)
  t.diagnostic(`空洞骑士：置信度 ${d.score}，日志 ${logs.length} 个，存档候选 ${saves.length} 个，cleanExit=${s.cleanExit}`)
})

test('★ 真实 Godot 目录不应被误判为 Unity（反向证据生效）', (t) => {
  const gd = join(ROAMING, 'Godot', 'app_userdata', '30 Days in the Workplace')
  if (!existsSync(gd)) { t.skip('本机没有 Godot 游戏目录'); return }
  const d = unity.detect(gd)
  assert.equal(d.score, 0, `不该把 Godot 游戏判成 Unity：${d.evidence.join('；')}`)
})

test('detectEngine 在真实公司目录上能排出结果', (t) => {
  if (!existsSync(LOW)) { t.skip('没有 LocalLow 目录'); return }
  const hk = join(LOW, 'Team Cherry', 'Hollow Knight')
  if (!existsSync(hk)) { t.skip('本机没有空洞骑士目录'); return }
  const r = detectEngine(hk, [unity])
  assert.equal(r[0].id, 'unity')
  t.diagnostic(describeDetection(r))
})

test('真实日志里噪声过滤是否有效（用真实 Player.log 统计）', (t) => {
  const hk = join(LOW, 'Team Cherry', 'Hollow Knight', 'Player.log')
  if (!existsSync(hk)) { t.skip('本机没有空洞骑士日志'); return }
  const { text } = readTail(hk, 64 * 1024)
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const events = unity.parseLog(text, { at: T0 })
  t.diagnostic(`空洞骑士 Player.log：${lines.length} 非空行 → ${events.length} 条事件（噪声过滤比 ${(1 - events.length / Math.max(lines.length, 1)).toFixed(3)}）`)
  assert.ok(events.length <= 5, `小日志不该产出大量事件，实际 ${events.length}`)
  assert.ok(events.length >= 1, '至少应认出 Initialize engine version')
})
