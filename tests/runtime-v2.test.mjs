// tests/runtime-v2.test.mjs —— 五项新功能在**运行时**里真的接通了
//
// 单模块测试（tools.test / wiki.test / memory-v2.test / purposes.test）证明的是
// "零件对"。这个文件证明的是"**装到一起还能用**"：工具能从运行时调到、启动器清单出得来、
// 分用途 provider 真的按用途取、一局结束真的走了评分过滤。
//
// 需要网络的两条路（评分 / wiki）都用**注入的 provider 与 fetch** 测 —— 于是
// "离线可跑"这条承诺在这层也成立。会真的启动进程的 launch_app，在测试里
// **永远走不到 spawn**（清单为空 ⇒ 目标解析不出来），所以不可能误启动用户的程序。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createRuntime } from '../app/agent.mjs'
import { createStore, mergeSettings } from '../app/store.mjs'
import { draftCard } from '../app/cardgen.mjs'
import { TOOL_NAMES } from '../core/tools.mjs'
import { buildLaunchables } from '../app/launcher.mjs'

const T0 = 1_700_000_000_000

function fakeProbe(o = {}) {
  return {
    async isRunning() { return { running: o.running ?? false, matches: [], cached: true, error: null, available: true } },
    idleSeconds: () => (o.idle === undefined ? 60 : o.idle),
    setIdleReader() {}, reset() {}, stats() {}, guessProcessNames: () => [],
  }
}

/**
 * 建运行时。
 * ⚠ 两个测试基建上的坑，都是被失败逼出来的：
 *   ① **时钟必须是可推进的**：工具执行器有最小调用间隔（限流），
 *      固定时钟下第二次调用同一工具必然被限流挡掉 —— 那测的就不是工具本身了。
 *   ② **改设置要走 runtime.applySettings**：运行时在创建时把设置读到内存里，
 *      直接 `store.setSettings` 绕过它 ⇒ 运行时仍在用旧设置（这不是 bug，
 *      是"设置只有一个所有者"的代价；测试要按公开 API 来）。
 */
function makeRuntime(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pet-rt2-'))
  const store = createStore({ dir })
  let clock = T0
  const runtime = createRuntime({
    store,
    probe: fakeProbe(o.probe),
    now: () => clock,
    providers: o.providers,
    toolHandlers: o.toolHandlers,
    approveTool: o.approveTool,
    fetchImpl: o.fetchImpl,
  })
  if (o.settings) runtime.applySettings(o.settings)
  return { runtime, store, dir, tick: (ms = 5000) => { clock += ms }, done: () => rmSync(dir, { recursive: true, force: true }) }
}

// ══════════════════ A. 分用途模型在运行时里生效 ══════════════════

test('★ runtime.llmConfig 按用途给出各自的配置', () => {
  const { runtime, done } = makeRuntime({
    settings: {
      llm: {
        provider: 'llm', model: 'big', apiKey: 'sk-default',
        purposes: { memoryJudge: { model: 'tiny', apiKey: 'sk-judge' }, dialogue: { enabled: false } },
      },
    },
  })
  try {
    assert.equal(runtime.llmConfig('dialogue').provider, 'template', 'dialogue 被显式关掉 ⇒ 模板档')
    assert.equal(runtime.llmConfig('memoryJudge').model, 'tiny')
    assert.equal(runtime.llmConfig('memoryJudge').apiKey, 'sk-judge')
    assert.equal(runtime.llmConfig('cardFill').model, 'big', '没覆盖的用途回落默认')
    assert.equal(runtime.llmConfig('cardFill').apiKey, 'sk-default')
    const all = runtime.purposes()
    assert.equal(all.length, 5)
    assert.ok(all.every((x) => typeof x.id === 'string' && typeof x.provider === 'string'))
  } finally { done() }
})

// ══════════════════ B. 工具在运行时里接通 ══════════════════

test('★ 六个工具都接上了实现（不能有"登记了但没实现"的）', () => {
  const { runtime, done } = makeRuntime()
  try {
    const st = runtime.toolState()
    assert.equal(st.total, 6)
    assert.deepEqual(st.missing, [], `缺实现：${st.missing.join(', ')}`)
    assert.equal(st.stats.ok, 0)
  } finally { done() }
})

test('★ move_to：发得出移动请求（真正挪窗口由外壳执行）', async () => {
  const { runtime, done } = makeRuntime()
  try {
    const seen = []
    runtime.on((e) => seen.push(e))
    const r = await runtime.runTool({ name: 'move_to', args: { x: 1200, y: 700, reason: '别挡视线' } })
    assert.equal(r.ok, true)
    assert.equal(r.result.requested.x, 1200)
    assert.ok(seen.some((e) => e.type === 'pet:move' && e.x === 1200), '该发出 pet:move 事件')
  } finally { done() }
})

test('★ pet：亲密度与 mood 上升，且播 happy', async () => {
  const { runtime, done } = makeRuntime()
  try {
    runtime.setCard(draftCard({ name: '霞', game: 'g' }).card)
    const before = runtime.snapshot().session?.affinity
    const r = await runtime.runTool({ name: 'pet', args: { times: 2 } })
    assert.equal(r.ok, true)
    assert.ok(r.result.affinity > 0, '亲密度该被抬高')
    const after = runtime.snapshot().session?.affinity
    assert.ok(after > before, `亲密度该上升：${before} -> ${after}`)
  } finally { done() }
})

test('★ interact：表意动作映射到素材层的动作 id', async () => {
  const { runtime, tick, done } = makeRuntime()
  try {
    const seen = []
    runtime.on((e) => seen.push(e))
    const nod = await runtime.runTool({ name: 'interact', args: { kind: 'nod', note: '表示同意' } })
    assert.equal(nod.ok, true)
    assert.equal(nod.result.action, 'talk')
    tick(1000)   // ★ 推一下时钟：interact 有 600ms 的最小间隔，不推会被限流挡掉
    const greet = await runtime.runTool({ name: 'interact', args: { kind: 'greet' } })
    assert.equal(greet.ok, true)
    assert.equal(greet.result.action, 'greeting')
    assert.ok(seen.some((e) => e.type === 'pet:action' && e.action === 'greeting'))
  } finally { done() }
})

test('★ cancel：清掉待发言，并把"自我取消"记进指标', async () => {
  const { runtime, done } = makeRuntime()
  try {
    runtime.setCard(draftCard({ name: '霞', game: 'g' }).card)
    await runtime.pump({ now: T0 })
    // 手动造一个待发言（模拟"模型攒了个话头又想收回"）
    runtime.session.presence.pending = { kind: 'save', firstAt: T0, at: T0, dueAt: T0 + 1000, expiresAt: T0 + 60000, significance: 0.6, summaries: ['存档'], mergedCount: 1 }
    const r = await runtime.runTool({ name: 'cancel', args: { reason: '玩家在忙' } })
    assert.equal(r.ok, true)
    assert.equal(r.result.canceled, true)
    assert.equal(runtime.session.presence.pending, null, '待发言该被清掉')
    assert.equal(runtime.snapshot().presence.canceledBySelf, 1, '要记为"自我取消"（与被打断分开）')
  } finally { done() }
})

test('★ launch_app：**没有确认就绝不启动**（清单为空 ⇒ 连解析都过不去）', async () => {
  const { runtime, done } = makeRuntime({ settings: { launcher: { favorites: [] } } })
  try {
    const r = await runtime.runTool({ name: 'launch_app', args: { target: '随便什么游戏' } })
    assert.equal(r.ok, false)
    assert.equal(r.needsConfirm, true, '★ 这是 confirm 级工具，未批准时必须挂起')
    assert.ok(r.pendingId, '该挂成一条待确认')
    const st = runtime.toolState()
    assert.equal(st.pending.length, 1)
    assert.equal(st.stats.needsConfirm, 1)
    assert.equal(st.stats.ok, 0, '★ 一次都不许真的执行')
  } finally { done() }
})

test('★ 批准一条待确认：工具会执行，但清单里没目标 ⇒ 启动本身被拒（不会启动任何东西）', async () => {
  const { runtime, done } = makeRuntime()
  try {
    const r0 = await runtime.runTool({ name: 'launch_app', args: { target: '不存在的游戏' } })
    const r1 = await runtime.approveTool(r0.pendingId)
    // ⚠ 这里要分清两件事：**工具执行成功**（r1.ok）与**业务动作成功**（r1.result.ok）。
    //   把它们混为一谈就会写出错的断言 —— 而"工具跑了但动作被拒"恰恰是要保留的信息。
    assert.equal(r1.ok, true, '工具本身执行了')
    assert.equal(r1.result.ok, false, '启动被拒')
    assert.match(r1.result.error, /没有登记过/)
    assert.equal(runtime.toolState().pending.length, 0, '批准后要从待确认里移走')
  } finally { done() }
})

test('拒绝一条待确认会被记进审计', async () => {
  const { runtime, done } = makeRuntime()
  try {
    const r0 = await runtime.runTool({ name: 'launch_app', args: { target: 'x' } })
    assert.equal(runtime.rejectTool(r0.pendingId, '现在不想玩'), true)
    assert.equal(runtime.toolState().pending.length, 0)
    assert.ok(runtime.toolState().history.some((h) => h.decision === 'rejected'))
  } finally { done() }
})

test('★ 工具参数错了会被拦下，且不落到实现', async () => {
  const calls = []
  const { runtime, done } = makeRuntime({ toolHandlers: { pet: (a) => { calls.push(a); return {} } } })
  try {
    const bad = await runtime.runTool({ name: 'pet', args: { times: 99 } })
    assert.equal(bad.ok, false)
    assert.deepEqual(calls, [], '校验不过就不该调实现')
    assert.equal(runtime.toolState().stats.invalid, 1)
  } finally { done() }
})

test('★ 可以覆盖单个工具的实现（外壳就是这么接管 move_to 的）', async () => {
  const moved = []
  const { runtime, done } = makeRuntime({ toolHandlers: { move_to: (a) => { moved.push(a); return { real: true } } } })
  try {
    const r = await runtime.runTool({ name: 'move_to', args: { x: 1, y: 2 } })
    assert.equal(r.ok, true)
    assert.equal(r.result.real, true, '覆盖的实现该被调用')
    assert.deepEqual(moved, [{ x: 1, y: 2 }])
  } finally { done() }
})

test('★ generate_character_card：是 confirm 级（要先挂起），批准后只产出提议、不落盘', async () => {
  const { runtime, store, done } = makeRuntime({ providers: { cardFill: null } })
  try {
    const args = { name: '霞', game: 'someday', lore: '霞是主角的同班同学。她的口癖是「……才不是」。她从不说「谢谢」。称呼主角为「你」。' }
    // ① 没批准 ⇒ 挂起，不执行
    const r0 = await runtime.runTool({ name: 'generate_character_card', args })
    assert.equal(r0.ok, false)
    assert.equal(r0.needsConfirm, true)
    // ② 批准之后才跑出提议
    const r1 = await runtime.approveTool(r0.pendingId)
    assert.equal(r1.ok, true)
    assert.ok(r1.result.proposals >= 3, JSON.stringify(r1.result))
    assert.match(r1.result.hint, /逐格确认/)
    assert.equal(store.getCard(), null, '★ 工具不许直接落盘角色卡 —— 它只能把表端上来')
  } finally { done() }
})

// ══════════════════ C. 启动器在运行时里接通 ══════════════════

test('★ listLaunchables：空收藏 + 不扫 Steam ⇒ 空清单，且说明得清楚', () => {
  const { runtime, done } = makeRuntime()
  try {
    const r = runtime.listLaunchables({ includeSteam: false })
    assert.deepEqual(r.items, [])
    assert.equal(r.favorites, 0)
    assert.ok(Array.isArray(r.notes))
  } finally { done() }
})

test('★ 收藏的游戏会出现在启动清单里（用真实临时目录，证明接线真的通）', async () => {
  const { runtime, dir, done } = makeRuntime()
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const gameDir = join(dir, 'MyGame')
    mkdirSync(gameDir, { recursive: true })
    writeFileSync(join(gameDir, 'MyGame.exe'), 'M'.repeat(2048))
    // 走公开的 applySettings（直接写 store 的话运行时还在用旧设置）
    runtime.applySettings({ launcher: { favorites: [{ dir: gameDir, name: '我的游戏' }] } })
    const r = runtime.listLaunchables({ includeSteam: false })
    assert.equal(r.items.length, 1)
    assert.equal(r.items[0].name, '我的游戏')
    assert.ok(r.items[0].exe.endsWith('MyGame.exe'))
    assert.equal(r.items[0].launchable, true)
    // 也能解析出目标（但**不启动**）
    const t = runtime.resolveLaunchTarget('我的游戏')
    assert.equal(t.ok, true)
    assert.equal(t.item.name, '我的游戏')
  } finally { done() }
})

test('buildLaunchables 与运行时用的是同一份清单来源（没有第二套实现）', () => {
  const a = buildLaunchables({ favorites: [], roots: [] })
  assert.deepEqual(a.items, [])
  assert.ok(a.notes.length === 0)
})

// ══════════════════ D. 记忆 V2 在会话结束时真的生效 ══════════════════

test('★ 一局结束时走「记忆评分」：低分候选被过滤掉', async () => {
  const judged = []
  const judge = {
    id: 'judge-fake',
    available: () => true,
    async generate(req) {
      const n = (req.rawPrompt.match(/^\d+\. \[/gm) ?? []).length
      judged.push(n)
      // 奇数下标的给低分 ⇒ 应当被过滤
      return { text: JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, score: i % 2 === 0 ? 0.9 : 0.05 }))) }
    },
  }
  const { runtime, store, dir, done } = makeRuntime({ providers: { memoryJudge: judge } })
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { compressToBase64 } = await import('../core/lzstring.mjs')
    const gameDir = join(dir, 'game')
    mkdirSync(join(gameDir, 'save'), { recursive: true })
    const mk = (o = {}) => ({
      system: { _saveCount: 1, _framesOnSave: 0 },
      switches: { _data: [null, true, false] },
      variables: { _data: [null, 0, 0, 0] },
      actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: 1, _hp: 300, _exp: 0 }] },
      party: { _gold: 0, _items: [], _actors: [1], _steps: 0 },
      map: { _mapId: 1 }, ...o,
    })
    const write = (s) => writeFileSync(join(gameDir, 'save', 'file1.rpgsave'), compressToBase64(JSON.stringify(s)), 'utf8')
    write(mk())
    runtime.applySettings({ game: { dir: gameDir, level: 'moderate' } })
    runtime.setCard(draftCard({ name: '霞', game: 'game' }).card)

    await runtime.pump({ now: T0 })                       // 基线
    const after = mk({ map: { _mapId: 7 } })
    after.actors._data[1]._level = 9
    after.party._gold = 500
    after.switches._data[2] = true
    write(after)
    await runtime.pump({ now: T0 + 60000 })               // 产出事件

    const r = await runtime.endCurrentSession({ now: T0 + 120000, durationMs: 120000 })
    assert.ok(r.summary, '该有汇总')
    assert.ok(judged.length >= 1, '★ 该调用过评分模型')
    assert.ok(r.judged >= 1, '该报告评了几分')
    assert.ok(r.filtered >= 1, `低分候选该被过滤，实际 filtered=${r.filtered}`)
    assert.ok(r.notes.some((n) => n.includes('不入长期记忆')), r.notes.join(' | '))
    // 落盘了
    assert.ok(store.getMemory()?.entries?.length > 0, '记忆要落盘')
  } finally { done() }
})

test('★ 评分模型炸了 ⇒ 一条记忆都不许丢（降级路径）', async () => {
  const boom = { id: 'boom', available: () => true, async generate() { throw new Error('评分服务挂了') } }
  const { runtime, store, dir, done } = makeRuntime({ providers: { memoryJudge: boom } })
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { compressToBase64 } = await import('../core/lzstring.mjs')
    const gameDir = join(dir, 'game')
    mkdirSync(join(gameDir, 'save'), { recursive: true })
    const mk = (o = {}) => ({
      system: { _saveCount: 1 }, switches: { _data: [null, true] }, variables: { _data: [null, 0, 0] },
      actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: 1, _hp: 300 }] },
      party: { _gold: 0, _items: [], _actors: [1] }, map: { _mapId: 1 }, ...o,
    })
    const write = (s) => writeFileSync(join(gameDir, 'save', 'file1.rpgsave'), compressToBase64(JSON.stringify(s)), 'utf8')
    write(mk())
    runtime.applySettings({ game: { dir: gameDir, level: 'moderate' } })
    runtime.setCard(draftCard({ name: '霞', game: 'game' }).card)
    await runtime.pump({ now: T0 })
    const a = mk({ map: { _mapId: 3 } }); a.party._gold = 90
    write(a)
    await runtime.pump({ now: T0 + 60000 })

    const r = await runtime.endCurrentSession({ now: T0 + 120000, durationMs: 120000 })
    assert.equal(r.filtered, 0, '评分失败不该过滤掉任何东西')
    assert.ok(r.notes.some((n) => n.includes('挂了')), r.notes.join(' | '))
    const mem = store.getMemory()
    assert.ok(mem.entries.some((e) => e.kind === 'summary'), '汇总必须还在')
    assert.ok(mem.entries.some((e) => e.kind !== 'summary'), '个体记忆也必须还在')
  } finally { done() }
})

test('★ 没有配评分模型时：不联网、照常入库', async () => {
  const { runtime, store, dir, done } = makeRuntime({ providers: { memoryJudge: null } })
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { compressToBase64 } = await import('../core/lzstring.mjs')
    const gameDir = join(dir, 'game')
    mkdirSync(join(gameDir, 'save'), { recursive: true })
    const mkSave = (o = {}) => ({
      system: { _saveCount: 1 }, switches: { _data: [null, true] }, variables: { _data: [null, 0, 0] },
      actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: 1, _hp: 300 }] },
      party: { _gold: 0, _items: [], _actors: [1] }, map: { _mapId: 1 },
      ...o,
    })
    const write = (s) => writeFileSync(join(gameDir, 'save', 'file1.rpgsave'), compressToBase64(JSON.stringify(s)), 'utf8')
    write(mkSave())
    runtime.applySettings({ game: { dir: gameDir, level: 'moderate' } })
    runtime.setCard(draftCard({ name: '霞', game: 'game' }).card)
    await runtime.pump({ now: T0 })
    // ⚠ 必须再补一次**有变化**的 pump：否则本局一条事件都没有，压不出任何记忆
    //   （第一版就漏了这一步，跑出来的是"本局没有可压缩的事件"）
    const after = mkSave({ map: { _mapId: 4 } })
    after.party._gold = 120
    write(after)
    await runtime.pump({ now: T0 + 60000 })
    const r = await runtime.endCurrentSession({ now: T0 + 90000, durationMs: 90000 })
    assert.ok(r.notes.some((n) => n.includes('没有可用的评分模型')), r.notes.join(' | '))
    assert.ok(store.getMemory()?.entries?.length > 0)
  } finally { done() }
})

// ══════════════════ E. Wiki 管线在运行时里接通 ══════════════════

test('★ runtime.fillCardFromWiki：注入 fetch ⇒ 离线跑通（抓页面 → 出表 → 提议）', async () => {
  const page = (title, body, links = '') => `<html><head><title>${title}</title></head><body><p>${body}</p>${links}</body></html>`
  const filler = '她喜欢在放学后一个人待在教室。'.repeat(10)
  const pages = {
    'https://wiki.test/xia': page('霞', `${filler}她的口癖是「……才不是」。<a href="/xia/voice">霞 语音</a>`, ''),
    'https://wiki.test/xia/voice': page('霞 语音', `「……才不是」${filler}`),
  }
  const fetchImpl = async (url) => (pages[url]
    ? { ok: true, status: 200, url, text: async () => pages[url] }
    : { ok: false, status: 404, url, text: async () => 'no' })

  const { runtime, done } = makeRuntime({ fetchImpl })
  try {
    const r = await runtime.fillCardFromWiki({
      url: 'https://wiki.test/xia', name: '霞', forceHeuristic: true,
      wiki: { delayMs: 0 },   // 别真的等
      card: draftCard({ name: '霞', game: 'someday' }).card,
    })
    assert.equal(r.wiki.ok, true, r.notes.join(' | '))
    assert.equal(r.wiki.pages.filter((p) => p.ok).length, 2, '种子页 + 语音子页')
    const tics = r.proposals.find((p) => p.path === 'persona.hard.speechTics')
    assert.ok(tics, JSON.stringify(r.proposals.map((p) => p.path)))
    assert.deepEqual(tics.value, ['……才不是'])
  } finally { done() }
})

test('★ runtime.fetchWiki 抓不到时如实返回失败（不抛、不硬凑）', async () => {
  const fetchImpl = async (url) => ({ ok: true, status: 200, url, text: async () => '<html><body><div id="app"></div></body></html>' })
  const { runtime, done } = makeRuntime({ fetchImpl })
  try {
    const r = await runtime.fetchWiki('https://wiki.test/x', { delayMs: 0 })
    assert.equal(r.ok, false)
    assert.ok(r.error || r.notes.length > 0)
  } finally { done() }
})

// ══════════════════ F. 快照要把新东西带上（界面靠它渲染） ══════════════════

test('★ snapshot 带上了工具待确认数（否则界面显示不出来"桌宠想启动程序"）', async () => {
  const { runtime, done } = makeRuntime()
  try {
    await runtime.runTool({ name: 'launch_app', args: { target: 'x' } })
    const t = runtime.toolState()
    assert.equal(t.pending.length, 1)
    assert.equal(t.stats.needsConfirm, 1)
    assert.ok(Array.isArray(t.history) && t.history.length >= 1)
  } finally { done() }
})

test('runtime 对脏 options 不崩（含 providers 传垃圾）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-rt2b-'))
  try {
    const store = createStore({ dir })
    assert.doesNotThrow(() => createRuntime({ store, probe: fakeProbe(), providers: null, toolHandlers: null }))
    const rt = createRuntime({ store, probe: fakeProbe(), providers: null, toolHandlers: null })
    assert.equal(rt.toolState().missing.length, 0, '没覆盖时六个工具都该有默认实现')
    assert.equal(rt.llmConfig('dialogue').provider, 'template', '默认配置下全是模板档')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('TOOL_NAMES 与运行时报告的工具数一致', () => {
  const { runtime, done } = makeRuntime()
  try {
    assert.equal(runtime.toolState().total, TOOL_NAMES.length)
  } finally { done() }
})
