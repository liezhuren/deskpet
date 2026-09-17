// tests/persona.test.mjs —— core/persona.mjs 的测试
//
// ★ 这个模块是本项目对外宣称的核心：「靠校验器量化角色一致性」。
//   **校验器自己没被测过，那条宣称就不成立** —— 所以这份测试的分量比别处更重：
//   · 状态机是确定性的（模型不许改），所以每条影响规则都要钉住
//   · 校验器要能"拒绝"，也要能"回归"（lintBatch 的指标就是回归的依据）
//   · 它对脏输入不能崩，也不能静默放过

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initState, applyEvent, applyEvents, markFlag, countTurn, addressFor,
  describeState, lintDialogue, lintBatch,
} from '../core/persona.mjs'
import { normalizeCard } from '../core/card.mjs'

function card(over = {}) {
  const { card: c } = normalizeCard({
    id: 'x', name: '霞', game: 'g',
    persona: {
      soft: { personality: 'p', background: 'b', speechStyle: 's' },
      hard: {
        speechTics: ['……才不是'],
        forbiddenWords: ['本小姐'],
        addresses: { player: '你' },
        avgLength: { min: 4, max: 60 },
        emojiPolicy: 'none',
        ...over,
      },
    },
  })
  return c
}

const ev = (kind, at, extra = {}) => ({ kind, at, text: `${kind} 事件`, ...extra })

// ══════════════════ A. 状态初始化 ══════════════════

test('initState 给出中性初值', () => {
  const s = initState(card())
  assert.equal(s.mood, 0)
  assert.equal(s.affinity, 0.3)
  assert.deepEqual(s.progress, { kind: 'unknown', note: null })
  assert.deepEqual(s.flags, {})
  assert.equal(s.turns, 0)
  assert.deepEqual(s.log, [])
  assert.equal(s.cardId, 'x')
  assert.equal(s.name, '霞')
})

test('initState 的 seed 被夹到合法范围', () => {
  assert.equal(initState(card(), { mood: 99 }).mood, 1)
  assert.equal(initState(card(), { mood: -99 }).mood, -1)
  assert.equal(initState(card(), { affinity: 5 }).affinity, 1)
  assert.equal(initState(card(), { affinity: -1 }).affinity, 0)
})

// ══════════════════ B. applyEvent：唯一允许改状态的入口 ══════════════════

test('death 压低 mood，重要度越高压得越狠', () => {
  const s = initState(card())
  assert.equal(applyEvent(s, ev('death', 1, { importance: 1 })).mood, -0.5)
  assert.equal(applyEvent(s, ev('death', 1, { importance: 0.4 })).mood, -0.2)
})

test('combat 按 outcome 分胜负', () => {
  const s = initState(card())
  assert.ok(applyEvent(s, ev('combat', 1, { importance: 1, data: { outcome: 'win' } })).mood > 0)
  assert.ok(applyEvent(s, ev('combat', 1, { importance: 1, data: { outcome: 'lose' } })).mood < 0)
  assert.ok(applyEvent(s, ev('combat', 1, { importance: 1 })).mood < 0, '没写胜负时按受挫计')
})

test('progress 抬 mood 并记下进度', () => {
  const s = applyEvent(initState(card()), { kind: 'progress', at: 1, text: '打到第三章', importance: 1 })
  assert.ok(s.mood > 0)
  assert.deepEqual(s.progress, { kind: 'progress', note: '打到第三章' })
})

test('area 只改进度、不改 mood', () => {
  const s = applyEvent(initState(card()), { kind: 'area', at: 1, text: '进入地下室', importance: 1 })
  assert.equal(s.mood, 0)
  assert.deepEqual(s.progress, { kind: 'area', note: '进入地下室' })
})

test('item 小幅抬 mood', () => {
  const s = applyEvent(initState(card()), ev('item', 1, { importance: 1 }))
  assert.ok(s.mood > 0 && s.mood < 0.35, `item 的影响应当比 progress 小，实际 ${s.mood}`)
})

test('dialogue / system 不改 mood', () => {
  const s = initState(card())
  assert.equal(applyEvent(s, ev('dialogue', 1, { importance: 1 })).mood, 0)
  assert.equal(applyEvent(s, ev('system', 1, { importance: 1 })).mood, 0)
})

test('mood 被夹在 -1..1（连打十次死亡也不会越界）', () => {
  let s = initState(card())
  for (let i = 0; i < 10; i++) s = applyEvent(s, ev('death', i, { importance: 1 }))
  assert.equal(s.mood, -1)
})

test('★ affinity 只被互动改变，不被战况改变（否则角色会显得势利）', () => {
  const s = initState(card())
  for (const kind of ['death', 'combat', 'progress', 'item', 'area']) {
    assert.equal(applyEvent(s, ev(kind, 1, { importance: 1 })).affinity, 0.3, `${kind} 不该改 affinity`)
  }
  assert.ok(countTurn(s).affinity > 0.3, '对话轮数才该抬 affinity')
})

test('每个事件都进 log，并且有上限（长会话不能无限涨）', () => {
  let s = initState(card())
  for (let i = 0; i < 60; i++) s = applyEvent(s, ev('save', i))
  assert.equal(s.log.length, 50, 'log 上限是 50')
  assert.equal(s.log[s.log.length - 1].at, 59, '保留最近的')
})

test('log 条目带 kind / text / importance', () => {
  const s = applyEvent(initState(card()), { kind: 'save', at: 5, text: '存档了', importance: 0.8 })
  assert.deepEqual(s.log[0], { at: 5, kind: 'save', text: '存档了', importance: 0.8 })
})

test('★ applyEvent 是纯函数（不改入参，便于回放与测试）', () => {
  const s = initState(card())
  const snap = JSON.stringify(s)
  applyEvent(s, ev('death', 1, { importance: 1 }))
  assert.equal(JSON.stringify(s), snap)
})

test('applyEvent 对未知 kind 与脏输入安全', () => {
  const s = initState(card())
  assert.doesNotThrow(() => applyEvent(s, ev('不存在的类别', 1)))
  assert.doesNotThrow(() => applyEvent(s, null))
  assert.doesNotThrow(() => applyEvent(s, { kind: 'death' }), '没有 importance 时按 0 算，不抛')
})

test('applyEvents 顺序回放', () => {
  const s = applyEvents(initState(card()), [
    ev('progress', 1, { importance: 1 }),
    ev('death', 2, { importance: 1 }),
  ])
  assert.equal(s.log.length, 2)
  assert.ok(s.mood < 0.35 && s.mood > -0.5)
  assert.equal(applyEvents(initState(card()), []).log.length, 0)
})

test('markFlag 记状态位，countTurn 加轮数', () => {
  const s = markFlag(initState(card()), '知道她是公主')
  assert.equal(s.flags['知道她是公主'], true)
  assert.equal(markFlag(s, 'k', 'v').flags.k, 'v')
  assert.equal(initState(card()).flags.k, undefined, 'markFlag 不该改入参')

  const t = countTurn(initState(card()), { affinityGain: 0.5 })
  assert.equal(t.turns, 1)
  assert.equal(t.affinity, 0.8)
  assert.equal(countTurn(t, { affinityGain: 0.5 }).affinity, 1, 'affinity 被夹在 1')
})

// ══════════════════ C. addressFor：确定性，不交给模型猜 ══════════════════

test('卡里指定了称呼就用卡的', () => {
  const c = card({ addresses: { player: '搭档' } })
  const r = addressFor(initState(c), c)
  assert.deepEqual(r, { text: '搭档', from: 'card' })
})

test('卡里没指定时按亲密度分档', () => {
  const c = card({ addresses: {} })
  assert.equal(addressFor({ ...initState(c), affinity: 0.2 }, c).text, '您')
  assert.equal(addressFor({ ...initState(c), affinity: 0.5 }, c).text, '你')
  assert.equal(addressFor({ ...initState(c), affinity: 0.9 }, c).text, '你')
  assert.equal(addressFor({ ...initState(c), affinity: 0.2 }, c).from, 'affinity-low')
})

test('addressFor 对缺卡 / 缺 persona 不抛', () => {
  assert.doesNotThrow(() => addressFor(initState(card()), null))
  assert.doesNotThrow(() => addressFor(initState(card()), {}))
  assert.equal(typeof addressFor(initState(card()), {}).text, 'string')
})

// ══════════════════ D. describeState：模型唯一的事实来源 ══════════════════

test('describeState 给出模型该知道的事实', () => {
  let s = initState(card())
  s = applyEvent(s, { kind: 'progress', at: 1, text: '打到第三章', importance: 1 })
  s = markFlag(s, '知道她是公主')
  const text = describeState(s, card())
  assert.match(text, /霞/)
  assert.match(text, /打到第三章/)
  assert.match(text, /知道她是公主/)
  assert.match(text, /称呼玩家：「你」/)
  assert.match(text, /最近发生/)
})

test('describeState 随状态变化（mood / affinity 说法会变）', () => {
  const c = card()
  const happy = describeState({ ...initState(c), mood: 0.9, affinity: 0.9 }, c)
  const sad = describeState({ ...initState(c), mood: -0.9, affinity: 0.1 }, c)
  assert.notEqual(happy, sad)
  assert.match(happy, /心情不错/)
  assert.match(happy, /很亲近/)
  assert.match(sad, /情绪低落/)
  assert.match(sad, /还比较生疏/)
})

test('describeState 无进度 / 无 flag / 无 log 时不输出空行', () => {
  const text = describeState(initState(card()), card())
  assert.ok(!text.includes('剧情进度'))
  assert.ok(!text.includes('已知事实'))
  assert.ok(!text.includes('最近发生'))
})

// ══════════════════ E. lintDialogue：单句校验 ══════════════════

test('合规的一句通过', () => {
  const r = lintDialogue('……才不是，你想多了。', card(), { state: initState(card()) })
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, [])
})

test('出现禁用词 ⇒ error', () => {
  const r = lintDialogue('本小姐才不会呢', card())
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.rule === 'forbiddenWords'))
})

test('过长 / 过短 ⇒ error（这是硬约束：太长的角色扮演最劝退）', () => {
  const c = card({ avgLength: { min: 4, max: 20 } })
  assert.equal(lintDialogue('短', c).ok, false)
  assert.ok(lintDialogue('短', c).errors.some((e) => e.rule === 'avgLength' && /过短/.test(e.detail)))
  const long = '啊'.repeat(30)
  assert.equal(lintDialogue(long, c).ok, false)
  assert.ok(lintDialogue(long, c).errors.some((e) => /过长/.test(e.detail)))
})

test('长度按码点算（emoji / 增广平面字符不该算成两个）', () => {
  const c = card({ avgLength: { min: 1, max: 1 }, emojiPolicy: 'allow' })
  assert.equal(lintDialogue('😀', c).ok, true, '一个 emoji 应当是 1 个字符')
})

test('emojiPolicy=none 出现表情 ⇒ error；=require 没表情 ⇒ error', () => {
  // 夹具文本要够长，别让 avgLength 的 min 混进来（那会让断言失败在别的原因上）
  const withEmoji = '你好呀，今天天气不错😀'
  const withoutEmoji = '你好呀，今天天气不错呢'

  const r1 = lintDialogue(withEmoji, card({ emojiPolicy: 'none' }))
  assert.equal(r1.ok, false)
  assert.deepEqual(r1.errors.map((e) => e.rule), ['emojiPolicy'], '只该因为表情违规')

  const r2 = lintDialogue(withoutEmoji, card({ emojiPolicy: 'require' }))
  assert.equal(r2.ok, false)
  assert.ok(r2.errors.some((e) => e.rule === 'emojiPolicy' && /require/.test(e.detail)))

  assert.equal(lintDialogue(withEmoji, card({ emojiPolicy: 'allow' })).ok, true)
})

test('★ 多了一个表情不该把长度也算超（表情只占 1 个码点）', () => {
  const c = card({ avgLength: { min: 1, max: 9 }, emojiPolicy: 'allow' })
  const text = '一二三四五六七八😀' // 9 个码点
  const r = lintDialogue(text, c)
  assert.equal(r.stats.length, 9)
  assert.equal(r.ok, true, `不该报长度错：${JSON.stringify(r.errors)}`)
})

test('未出现指定称呼只是 warning（偶尔省略是自然的）', () => {
  const c = card({ addresses: { player: '搭档' } })
  const r = lintDialogue('前面有危险，小心点。', c, { state: initState(c) })
  assert.equal(r.ok, true, 'warning 不该阻断')
  assert.ok(r.warnings.some((w) => w.rule === 'addresses'))
})

test('★ 单句没口癖只是 warning，不判 error（否则每句都报）', () => {
  const r = lintDialogue('前面有危险，小心点。', card())
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.rule === 'speechTics'))
})

test('stats 给出长度 / 表情数 / 命中的口癖', () => {
  const r = lintDialogue('……才不是，你好😀', card({ emojiPolicy: 'allow' }))
  assert.equal(r.stats.length, [...'……才不是，你好😀'].length)
  assert.equal(r.stats.emoji, 1)
  assert.deepEqual(r.stats.ticsHit, ['……才不是'])
})

test('★ 校验器对脏输入不崩（文本可能是 undefined / null / 数字）', () => {
  for (const bad of [undefined, null, 0, false, {}, []]) {
    assert.doesNotThrow(() => lintDialogue(bad, card()), `lintDialogue(${JSON.stringify(bad)}) 抛了`)
  }
  assert.doesNotThrow(() => lintDialogue('x', null))
  assert.doesNotThrow(() => lintDialogue('x', {}))
})

// ══════════════════ F. lintBatch：量化「这版提示词比上版好多少」 ══════════════════

test('lintBatch 给出 passRate / errorRate / ticRate / byRule', () => {
  const c = card({ avgLength: { min: 1, max: 20 } })
  const lines = [
    '……才不是，你想多了。',
    '本小姐才不会呢',
    '……才不是啦。',
    '啊'.repeat(50),
  ]
  const b = lintBatch(lines, c)
  assert.equal(b.count, 4)
  assert.equal(b.passRate, 0.5, '4 句里 2 句无 error')
  assert.ok(b.errorRate > 0)
  assert.equal(b.ticRate, 0.5, '4 句里 2 句带口癖')
  assert.ok(b.byRule.forbiddenWords >= 1)
  assert.ok(b.byRule.avgLength >= 1)
  assert.equal(b.results.length, 4)
})

test('★ 这正是回归的依据：改提示词后同一批输入，指标可比', () => {
  const c = card()
  const good = Array.from({ length: 10 }, () => '……才不是，你想多了。')
  const bad = Array.from({ length: 10 }, () => '本小姐才不会呢，哼。')
  const g = lintBatch(good, c)
  const b = lintBatch(bad, c)
  assert.equal(g.passRate, 1)
  assert.equal(b.passRate, 0)
  assert.ok(g.ticRate > b.ticRate, '好的一批口癖出现率更高、违规率更低 —— 这就是"变好了"的可量化形式')
  assert.ok(g.errorRate < b.errorRate)
})

test('★ ticRate 是批级量：单句没口癖不报错，但整批从不出现才说明有问题', () => {
  const c = card()
  const none = lintBatch(Array.from({ length: 20 }, () => '前面有危险，小心点。'), c)
  assert.equal(none.ticRate, 0)
  assert.equal(none.passRate, 1, '单句没口癖不算 error')

  const some = lintBatch([
    '前面有危险，小心点。',
    '……才不是，你想多了。',
  ], c)
  assert.equal(some.ticRate, 0.5)
})

test('lintBatch 对空数组不产生 NaN', () => {
  const b = lintBatch([], card())
  assert.equal(b.count, 0)
  assert.equal(b.passRate, 0)
  assert.equal(b.errorRate, 0)
  assert.equal(b.ticRate, 0)
  assert.ok(Number.isFinite(b.passRate) && Number.isFinite(b.errorRate) && Number.isFinite(b.ticRate))
  assert.doesNotThrow(() => lintBatch(undefined, card()))
})

test('★ 端到端：脏日志/存档事件 → 状态机 → 事实描述 → 生成文本 → 校验', () => {
  const c = card()
  // 一局游戏的真实形状事件（含新登记的 save/exit）
  const events = [
    { kind: 'save', at: 1, text: '存档已更新（第 13 次存档）', importance: 0.8 },
    { kind: 'progress', at: 2, text: '地图切换到 8', importance: 0.7 },
    { kind: 'death', at: 3, text: '角色 #1 倒下了', importance: 0.9 },
  ]
  const state = applyEvents(initState(c), events)
  assert.equal(state.log.length, 3)
  assert.ok(state.mood < 0, '死亡之后 mood 应当被压低')

  const facts = describeState(state, c)
  assert.match(facts, /角色 #1 倒下了/, '状态描述要带上刚发生的事')

  // 模型只被允许"表达"，产出必须过校验器
  const ok = lintDialogue('……才不是你的错，再来一次就好。', c, { state })
  assert.equal(ok.ok, true)
  // 违禁词 + 超长，两条都要命中
  const long = '本小姐觉得你应该重开游戏然后按照攻略先升级装备再去打那个boss，' +
    '顺便把仓库里的药水全带上别舍不得用，不然你肯定还要再死一次'
  const bad = lintDialogue(long, c, { state })
  assert.equal(bad.ok, false, '违禁词 + 超长都该被拦下')
  assert.ok(bad.errors.length >= 2, `应当同时命中禁用词与长度，实际 ${JSON.stringify(bad.errors)}`)
  assert.ok(bad.errors.some((e) => e.rule === 'forbiddenWords'))
  assert.ok(bad.errors.some((e) => e.rule === 'avgLength'))
})
