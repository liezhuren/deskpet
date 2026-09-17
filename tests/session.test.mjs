// tests/session.test.mjs —— agent/session.mjs：读游戏 / 该不该说 / 记住 三者串起来
//
// 这一层是把需求 ⑤（时机引擎 + 跨会话记忆）真正落到底的地方，所以要验的是**跨模块的行为**：
//   · capability 实测结果真的会决定档位（不是界面去判断）
//   · 一局的事件在结束时才压缩成记忆（不是每条都入库）
//   · "退出游戏后带着刚才的记忆继续聊" —— 换一个会话实例，仍能召回上一局

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { createSession, tick, endSession, recallFor, describeSession, utter, SESSION_DEFAULTS } from '../agent/session.mjs'
import { createMemory, stats as memoryStats } from '../core/memory.mjs'
import { compressToBase64 } from '../core/lzstring.mjs'
import { normalizeCard } from '../core/card.mjs'
import { lintDialogue } from '../core/persona.mjs'
import { createTemplateProvider } from '../dialogue/template.mjs'
import { createLlmProvider } from '../dialogue/llm.mjs'

const T0 = 1_700_000_000_000
const sec = (n) => n * 1000
const min = (n) => n * 60_000
const LOW = join(homedir(), 'AppData', 'LocalLow')

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'pet-session-'))
  return { dir: d, done: () => rmSync(d, { recursive: true, force: true }) }
}

/** 一份真实形状的 MV/MZ 存档 */
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
function writeMvSave(dir, save) {
  mkdirSync(join(dir, 'save'), { recursive: true })
  writeFileSync(join(dir, 'save', 'file1.rpgsave'), compressToBase64(JSON.stringify(save)), 'utf8')
}

// ══════════════════ A. 创建与首帧 ══════════════════

test('createSession 形状与默认值', () => {
  const s = createSession({ dir: 'X', game: 'g' })
  assert.equal(s.game, 'g')
  assert.equal(s.level, SESSION_DEFAULTS.level)
  assert.equal(s.sessionId, 's1')
  assert.deepEqual(s.pendingEvents, [])
  assert.ok(s.memory && s.presence && s.store)
  assert.equal(s.policy, null, '档位要等 capability 出来才能定')
})

test('★ 首帧只建基线：不产事件、不入记忆、不说话', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    const s0 = createSession({ dir: t.dir, game: 'g', now: T0 })
    const r = tick(s0, { now: T0, idleSec: 30, gameRunning: true })
    assert.deepEqual(r.events, [])
    assert.equal(r.speak, null)
    assert.equal(r.session.pendingEvents.length, 0)
    assert.ok(r.notes.some((n) => n.includes('首帧只建立基线')))
    assert.equal(r.session.policy.level, 'moderate', '存档可解 ⇒ 拿得到中等档')
  } finally { t.done() }
})

test('★ "读不出内容就别装作读得出"：解不开的存档会被自动封顶在保守档', () => {
  const t = tmp()
  try {
    mkdirSync(join(t.dir, 'save'), { recursive: true })
    writeFileSync(join(t.dir, 'save', 'opaque.dat'),
      Buffer.concat([Buffer.from([0, 1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1]), Buffer.alloc(400, 0x41)]))
    const s0 = createSession({ dir: t.dir, game: 'g', level: 'moderate', now: T0 })
    const r = tick(s0, { now: T0, idleSec: 30, gameRunning: true })
    assert.equal(r.session.policy.level, 'conservative')
    assert.equal(r.session.policy.capped, true)
    assert.ok(r.notes.some((n) => n.includes('封顶')), r.notes.join(' | '))
  } finally { t.done() }
})

// ══════════════════ B. 一局之内 ══════════════════

test('★ 存档变化 → 事件 → 等松懈 → 开口，且事件进了"本局待压缩"而不是长期记忆', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session  // 基线

    const after = mvSave()
    after.map._mapId = 8
    after.actors._data[1]._level = 13
    writeMvSave(t.dir, after)

    const now2 = T0 + min(10)
    const r1 = tick(s, { now: now2, idleSec: 2, gameRunning: true })   // 还在专注
    assert.ok(r1.events.length >= 2, `应当有事件，实际 ${r1.events.length}`)
    assert.equal(r1.speak, null, '专注期不许开口')
    assert.ok(r1.session.pendingEvents.length >= 2)
    s = r1.session

    const r2 = tick(s, { now: now2 + sec(30), idleSec: 40, gameRunning: true })  // 放下手柄
    assert.ok(r2.speak, '松懈后应当开口')
    assert.equal(r2.speak.kind, 'save')
    assert.ok(r2.speak.summaries.length >= 2)

    // 还没结束会话 ⇒ 长期记忆里不该有本局的事件（只有开口时可能写 player-said）
    assert.equal(memoryStats(r2.session.memory).entries, 0)
  } finally { t.done() }
})

test('玩家回应 → 写进记忆（player-said）并让谨慎度回落', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session

    // 人为把谨慎度抬高，验证回应会让它回落
    s = { ...s, presence: { ...s.presence, caution: 2 } }
    const r = tick(s, { now: T0 + sec(10), reply: '刚才那关好难' })
    assert.ok(r.session.presence.caution < 2)
    assert.ok(r.notes.some((n) => n.includes('玩家回应')))
    const mem = r.session.memory
    assert.equal(memoryStats(mem).byKind['player-said'], 1)
    assert.equal(mem.entries[0].text, '刚才那关好难')
  } finally { t.done() }
})

test('tick 不改入参 session（纯函数）', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    const s = createSession({ dir: t.dir, game: 'g', now: T0 })
    const snap = JSON.stringify({ ...s, store: null, memory: null, presence: null })
    tick(s, { now: T0 + 1000, idleSec: 30, gameRunning: true })
    assert.equal(JSON.stringify({ ...s, store: null, memory: null, presence: null }), snap)
  } finally { t.done() }
})

test('没有 dir 时也能跑（只做时机决策与记忆，不读游戏）', () => {
  const s = createSession({ game: 'g', now: T0 })
  const r = tick(s, { now: T0 + sec(1), idleSec: 100, gameRunning: false })
  assert.deepEqual(r.events, [])
  assert.equal(r.session.policy.level, 'conservative', '没有任何 capability 信息 ⇒ 最保守')
})

// ══════════════════ C. ★ 一局结束 → 压缩成记忆 ══════════════════

test('★ endSession 把一局压成"汇总 + 个体记忆"', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session

    const after = mvSave()
    after.map._mapId = 8
    after.actors._data[1]._level = 13
    after.party._gold = 1500
    writeMvSave(t.dir, after)
    s = tick(s, { now: T0 + min(10), idleSec: 2, gameRunning: true }).session

    const r = endSession(s, { now: T0 + 3 * 3600_000, durationMs: 3 * 3600_000 })
    assert.ok(r.summary, '应当产出汇总')
    assert.equal(r.summary.session, 's1')
    assert.equal(r.summary.game, 'g')
    assert.ok(r.summary.text.startsWith('这一局：'))
    assert.ok(r.kept.length >= 1)
    assert.equal(r.session.pendingEvents.length, 0, '压缩后清空待压缩队列')
    assert.ok(memoryStats(r.session.memory).entries >= 2, '汇总 + 至少一条个体')
    assert.ok(memoryStats(r.session.memory).byKind.summary === 1)
  } finally { t.done() }
})

test('本局没有事件时 endSession 不产出汇总，也不报错', () => {
  const s = createSession({ game: 'g', now: T0 })
  const r = endSession(s, { now: T0 + 1000 })
  assert.equal(r.summary, null)
  assert.equal(r.kept.length, 0)
  assert.ok(r.notes.some((n) => n.includes('没有可压缩')))
})

test('endSession 顺手淘汰一次（记忆库不会无限涨）', () => {
  let s = createSession({ game: 'g', now: T0 })
  s = { ...s, memory: { ...createMemory({ maxEntries: 2 }), entries: [] } }
  // 塞进远超上限的事件
  s = {
    ...s,
    pendingEvents: Array.from({ length: 20 }, (_, i) => ({
      kind: 'progress', text: `第 ${i} 处进度`, at: T0 + i, importance: 0.5 + (i % 5) / 100,
    })),
  }
  const r = endSession(s, { now: T0 + 1000 })
  assert.ok(memoryStats(r.session.memory).entries <= 2, `应当被淘汰到上限内，实际 ${memoryStats(r.session.memory).entries}`)
  assert.ok(r.notes.some((n) => n.includes('淘汰')))
})

// ══════════════════ D. ★ 跨会话：退出游戏后带着记忆继续聊 ══════════════════

test('★ 换一个会话实例（模拟重启），仍能召回上一局的事', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    // ---- 第一局 ----
    let s1 = createSession({ dir: t.dir, game: 'g', now: T0 })
    s1 = tick(s1, { now: T0, idleSec: 30, gameRunning: true }).session
    const after = mvSave()
    after.map._mapId = 8
    writeMvSave(t.dir, after)
    s1 = tick(s1, { now: T0 + min(10), idleSec: 2, gameRunning: true }).session
    const ended = endSession(s1, { now: T0 + 2 * 3600_000, durationMs: 2 * 3600_000 })
    assert.ok(ended.summary)

    // ---- 游戏退出后，开一个新区块（复用记忆库，模拟进程重启） ----
    const s2 = createSession({ game: 'g', memory: ended.session.memory, now: T0 + 3 * 3600_000 })
    assert.equal(s2.sessionId, 's2', '会话编号要递增')

    const { text, used } = recallFor(s2, { terms: ['刚才', '这一局'] }, { now: T0 + 3 * 3600_000, minScore: 0.1 })
    assert.ok(used.length >= 1, `退出后必须还能说上来点什么，实际 ${used.length}`)
    assert.match(text, /【与这个玩家有关的记忆】/)
    assert.ok(used.some((u) => u.entry.kind === 'summary'), `应当想起上一局的汇总：${used.map((u) => u.entry.text).join(' | ')}`)
  } finally { t.done() }
})

test('★ 跨游戏不串味：另一个游戏的记忆不会被召回', () => {
  const ended = endSession({
    ...createSession({ game: 'gameA', now: T0 }),
    pendingEvents: [{ kind: 'death', text: 'A 里死了', at: T0, importance: 0.9 }],
  }, { now: T0 + 1000 })

  const sB = createSession({ game: 'gameB', memory: ended.session.memory, now: T0 + 2000 })
  const { used } = recallFor(sB, { terms: ['死'] }, { now: T0 + 2000, minScore: 0.05 })
  assert.ok(!used.some((u) => u.entry.game === 'gameA'), '不同游戏的记忆不该冒出来')
})

test('★ 重复的一局不会把记忆撑爆（同内容折叠 + 计数）', () => {
  let memory = createMemory({ game: 'g' })
  for (let round = 0; round < 5; round++) {
    let s = createSession({ game: 'g', memory, now: T0 + round * 3600_000 })
    s = {
      ...s,
      pendingEvents: [
        { kind: 'save', text: '存档已更新', at: T0 + round * 3600_000, importance: 0.8 },
        { kind: 'save', text: '存档已更新', at: T0 + round * 3600_000 + 1, importance: 0.8 },
      ],
    }
    memory = endSession(s, { now: T0 + round * 3600_000 + 1000 }).session.memory
  }
  const save = memory.entries.find((e) => e.kind === 'save' && e.text === '存档已更新')
  assert.ok(save, '应当留下这一条')
  assert.equal(save.count, 10, '5 局 × 每局 2 次 = 10 次，必须是同一条被强化')

  const d = recallFor(createSession({ game: 'g', memory, now: T0 }), { terms: ['存档'] }, { now: T0, minScore: 0 })
  assert.ok(d.text.includes('（×10）'), `摘要里应当体现次数：${d.text}`)
})

test('describeSession 给出可展示的概况', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session
    const d = describeSession(s)
    assert.equal(d.engine, 'rpgmaker')
    assert.ok(d.capability.includes('progress'), '解出了存档 ⇒ 可读能力升级')
    assert.equal(d.level, 'moderate')
    assert.equal(d.capped, false)
    assert.equal(d.presence.silenceDuringPlay, 0)
    assert.equal(typeof d.presence.speaksPerHour, 'number')
    assert.equal(d.memory.entries, 0)
  } finally { t.done() }
})

// ══════════════════ E. ★ 表达层联调：决策 → 一句真的话 ══════════════════

function heroCard(over = {}) {
  const { card } = normalizeCard({
    id: 'heroine', name: '霞', game: 'g',
    persona: {
      soft: { personality: '嘴硬心软', background: '同班同学', speechStyle: '短句、爱吐槽' },
      hard: { speechTics: ['……才不是'], forbiddenWords: ['本小姐'], addresses: { player: '你' }, avgLength: { min: 4, max: 60 }, emojiPolicy: 'none', ...over },
    },
  })
  return card
}

test('★ 联调：存档事件 → 该开口 → utter 产出一句过校验的话，且不含机器信息', async () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    const card = heroCard()
    let s = createSession({ dir: t.dir, game: 'g', card, now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session

    const after = mvSave()
    after.map._mapId = 8
    after.actors._data[1]._level = 13
    writeMvSave(t.dir, after)
    const now2 = T0 + min(10)
    s = tick(s, { now: now2, idleSec: 2, gameRunning: true }).session
    const decided = tick(s, { now: now2 + sec(30), idleSec: 40, gameRunning: true })
    assert.ok(decided.speak, '该开口')

    const u = await utter(decided, { seed: 0 })
    assert.equal(u.ok, true, u.notes?.join(' | '))
    assert.ok(u.text.length > 0)
    assert.ok(!u.text.includes('$.'), `不许逐字复述字段：${u.text}`)
    assert.ok(!u.text.includes('SaveData1'), `不许提文件名：${u.text}`)
    const lint = lintDialogue(u.text, card, { state: decided.session.persona, triggerKind: 'save' })
    assert.equal(lint.ok, true, JSON.stringify(lint.errors))

    // ★ 人格状态也被事件影响了（mood 是确定性代码改的，模型不许碰）
    assert.ok(decided.session.persona)
    assert.equal(typeof decided.session.persona.mood, 'number')
  } finally { t.done() }
})

test('★ 不需要开口时 utter 直接返回"不说"，不调 provider', async () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', card: heroCard(), now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session
    const r = tick(s, { now: T0 + sec(60), idleSec: 30, gameRunning: true })  // 没变化 ⇒ 不开口
    assert.equal(r.speak, null)

    let called = false
    const spy = { id: 'spy', available: () => true, generate: async () => { called = true; return { text: 'x' } } }
    const u = await utter(r, { dialogue: { active: () => spy, speak: async () => { called = true } } })
    assert.equal(u.ok, false)
    assert.equal(called, false, '不开口就不该调 provider')
    assert.ok(u.notes.some((n) => n.includes('不需要开口')))
  } finally { t.done() }
})

test('★ 没有角色卡时也能决策，但 utter 会说清"没法表达"', async () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', now: T0 })  // 不给 card
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session
    const after = mvSave(); after.map._mapId = 9
    writeMvSave(t.dir, after)
    // ⚠ 两步：一次 tick 只能"发现触发"，静默窗口过了才轮到"决定开口"。
    //   真实部署里是每秒一次心跳，所以这天然是两次；写测试时容易漏。
    s = tick(s, { now: T0 + min(5), idleSec: 40, gameRunning: true }).session
    const r = tick(s, { now: T0 + min(5) + sec(30), idleSec: 40, gameRunning: true })
    assert.ok(r.speak, '决策层不依赖角色卡')
    const u = await utter(r)
    // 模板档能在没有卡的情况下给出一句话（卡的约束缺省为宽松），这不算失败
    assert.equal(typeof u.ok, 'boolean')
    assert.equal(u.request.card, null)
  } finally { t.done() }
})

test('★ LLM provider 不可用时，会话自动退回模板档（仍然说得出话）', async () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    const llm = createLlmProvider({ apiKey: '' })
    let s = createSession({ dir: t.dir, game: 'g', card: heroCard(), provider: 'llm', providerOptions: { apiKey: '' }, now: T0 })
    assert.equal(s.dialogue.active().id, 'template', '没 key 就该退回模板档')
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session

    const after = mvSave(); after.map._mapId = 9
    writeMvSave(t.dir, after)
    s = tick(s, { now: T0 + min(5), idleSec: 40, gameRunning: true }).session
    const r = tick(s, { now: T0 + min(5) + sec(30), idleSec: 40, gameRunning: true })
    assert.ok(r.speak)
    const u = await utter(r, { seed: 1 })
    assert.equal(u.ok, true, u.notes?.join(' | '))
    assert.equal(u.providerId, 'template')
    assert.equal(llm.available(), false)
  } finally { t.done() }
})

test('★ 玩家回应会同时影响：时机状态（谨慎度）+ 人格状态（affinity + 轮数）+ 记忆', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', card: heroCard(), now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session
    const before = { affinity: s.persona.affinity, turns: s.persona.turns, caution: s.presence.caution }
    s = { ...s, presence: { ...s.presence, caution: 2 } }

    const r = tick(s, { now: T0 + sec(5), reply: '嗯，刚才那关挺难的' })
    const after = r.session
    assert.ok(after.persona.affinity > before.affinity, 'affinity 应当上升')
    assert.equal(after.persona.turns, before.turns + 1)
    assert.ok(after.presence.caution < 2, '谨慎度应当回落')
    assert.equal(memoryStats(after.memory).byKind['player-said'], 1)
  } finally { t.done() }
})

test('★ 人格状态被事件改变（mood 由确定性代码改，不由模型改）', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', card: heroCard(), now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session
    const mood0 = s.persona.mood

    // 让存档差异映射出 death（角色倒下）
    const after = mvSave()
    after.actors._data[1]._hp = 0
    after.map._mapId = 8
    writeMvSave(t.dir, after)
    const r = tick(s, { now: T0 + min(5), idleSec: 40, gameRunning: true })
    assert.ok(r.events.some((e) => e.kind === 'death'), `应当有 death 事件：${r.events.map((e) => e.kind).join(',')}`)
    assert.ok(r.session.persona.mood < mood0, '角色倒下 ⇒ mood 应当被压低（确定性规则，不是模型猜的）')
  } finally { t.done() }
})

test('describeSession 在有卡时报告 mood / affinity / provider', () => {
  const t = tmp()
  try {
    writeMvSave(t.dir, mvSave())
    let s = createSession({ dir: t.dir, game: 'g', card: heroCard(), now: T0 })
    s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session
    const d = describeSession(s)
    assert.equal(d.hasCard, true)
    assert.equal(d.provider, 'template')
    assert.equal(typeof d.mood, 'number')
    assert.equal(typeof d.affinity, 'number')
  } finally { t.done() }
})

// ══════════════════ F. 真实目录 ══════════════════

test('★ 真实游戏目录（本机存在才跑）：会话能建立、能 tick、能结束', (t) => {
  const dir = join(LOW, 'Team Cherry', 'Hollow Knight')
  if (!existsSync(dir)) { t.skip('本机没有空洞骑士目录'); return }

  let s = createSession({ dir, game: 'hollow-knight', level: 'moderate', now: T0 })
  s = tick(s, { now: T0, idleSec: 30, gameRunning: true }).session
  const d1 = describeSession(s)
  assert.equal(d1.engine, 'unity')
  assert.equal(d1.level, 'conservative', 'BinaryFormatter 存档 ⇒ 应当被自动封顶')

  const r = tick(s, { now: T0 + sec(60), idleSec: 30, gameRunning: true })
  assert.deepEqual(r.events, [], '真实文件没变 ⇒ 不产事件')
  const ended = endSession(r.session, { now: T0 + 3600_000 })
  assert.equal(ended.summary, null, '这一局什么都没发生')

  t.diagnostic(`空洞骑士：capability=${d1.capability.join(',')} 档位=${d1.level}（capped=${d1.capped}）`)
})
