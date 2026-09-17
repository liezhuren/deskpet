// tests/card.test.mjs —— core/card.mjs 的测试
//
// 这个模块的卖点是「自相矛盾检查」（人工很难发现，机器一查就出）。
// 所以测试的重点不只是"字段类型校验对不对"，更是：
//   ★ 一张自相矛盾的卡**真的**会让校验器没法用 —— 用 persona 的 lintBatch 实测出来
//   （光断言 validateCard 报错是不够的，那只是"我声称它矛盾"）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCard, normalizeCard, HARD_KEYS, EMOJI_POLICIES } from '../core/card.mjs'
import { initState, lintDialogue, lintBatch } from '../core/persona.mjs'

/** 一张完全合规的卡 */
function goodCard(over = {}) {
  return {
    id: 'heroine',
    name: '霞',
    game: 'someday',
    persona: {
      soft: { personality: '嘴硬心软', background: '同班同学', speechStyle: '短句、爱吐槽' },
      hard: {
        speechTics: ['……才不是'],
        forbiddenWords: ['本小姐'],
        addresses: { player: '你' },
        avgLength: { min: 4, max: 60 },
        emojiPolicy: 'none',
        mustMention: {},
        ...(over.hard ?? {}),
      },
      ...(over.persona ?? {}),
    },
    ...(over.top ?? {}),
  }
}

// ══════════════════ A. 基本结构 ══════════════════

test('合规的卡通过校验且无警告', () => {
  const r = validateCard(goodCard())
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, [])
})

test('缺必填字段逐个报错', () => {
  const r = validateCard({ persona: { soft: {}, hard: {} } })
  assert.equal(r.ok, false)
  for (const k of ['id', 'name', 'game']) {
    assert.ok(r.errors.some((e) => e.includes(k)), `应当报缺少 ${k}：${r.errors.join(' | ')}`)
  }
})

test('必填字段是空字符串也算缺', () => {
  const r = validateCard(goodCard({ top: { id: '   ' } }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('id')))
})

test('缺 persona / soft / hard 都会报错', () => {
  assert.ok(validateCard({ id: 'a', name: 'b', game: 'c' }).errors.some((e) => e.includes('persona')))
  assert.ok(validateCard({ id: 'a', name: 'b', game: 'c', persona: { hard: {} } }).errors.some((e) => e.includes('soft')))
  assert.ok(validateCard({ id: 'a', name: 'b', game: 'c', persona: { soft: {} } }).errors.some((e) => e.includes('hard')))
})

test('★ 非法输入永不抛异常（校验器自己不能崩）', () => {
  for (const bad of [null, undefined, 42, 'x', [], true, { persona: null }, { persona: 'x' }]) {
    assert.doesNotThrow(() => validateCard(bad), `validateCard(${JSON.stringify(bad)}) 抛了`)
    const r = validateCard(bad)
    assert.equal(r.ok, false)
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0)
  }
})

// ══════════════════ B. hard 层逐项 ══════════════════

test('未登记的 hard 键只给警告，不给错误（不阻塞创作者）', () => {
  const r = validateCard(goodCard({ hard: { favColour: 'blue' } }))
  assert.equal(r.ok, true, '未登记的键不该让整张卡不通过')
  assert.ok(r.warnings.some((w) => w.includes('favColour') && w.includes('未登记')))
})

test('speechTics / forbiddenWords 必须是字符串数组', () => {
  assert.equal(validateCard(goodCard({ hard: { speechTics: '不是数组' } })).ok, false)
  assert.equal(validateCard(goodCard({ hard: { speechTics: [1, 2] } })).ok, false)
  assert.equal(validateCard(goodCard({ hard: { forbiddenWords: { a: 1 } } })).ok, false)
  assert.equal(validateCard(goodCard({ hard: { speechTics: [] } })).ok, true, '空数组是合法的')
})

test('★ 脏数组不能让校验器抛异常（它的契约就是"不抛"）', () => {
  // 真踩到的 bug：speechTics: [1,2] 会在 t.includes(...) 上抛 TypeError。
  // 把字符串当数组更阴：for...of 逐字符迭代，"矛盾检查"在拿单字比禁用词，静默查不出东西。
  const cases = [
    { speechTics: [1, 2] },
    { speechTics: [null, undefined] },
    { speechTics: '不是数组' },
    { forbiddenWords: [1, 2] },
    { forbiddenWords: '不是数组' },
    { addresses: [['player', '你']] },
    { addresses: { player: 123 } },
    { addresses: { player: null } },
    { mustMention: { combat: 'x' } },
    { mustMention: ['x'] },
    { avgLength: { min: 1, max: 'x' } },
    { avgLength: 'x' },
    { emojiPolicy: 5 },
  ]
  for (const hard of cases) {
    assert.doesNotThrow(() => validateCard(goodCard({ hard })), `抛了：${JSON.stringify(hard)}`)
  }
})

test('★ 字符串当数组时，矛盾检查不该"静默失效"', () => {
  // speechTics 是字符串时，类型检查已经报错了；重点是它不能再被当成"逐字符的口癖列表"
  const r = validateCard(goodCard({ hard: { speechTics: '本小姐', forbiddenWords: ['本小姐'] } }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('speechTics')), '至少要报类型错，且不能抛出')
})

test('addresses 必须是对象', () => {
  assert.equal(validateCard(goodCard({ hard: { addresses: ['你'] } })).ok, false)
  assert.equal(validateCard(goodCard({ hard: { addresses: '你' } })).ok, false)
  assert.equal(validateCard(goodCard({ hard: { addresses: { player: '你', npc: '她' } } })).ok, true)
})

test('avgLength 的区间与下界', () => {
  assert.equal(validateCard(goodCard({ hard: { avgLength: { min: 10, max: 5 } } })).ok, false, 'min > max')
  assert.equal(validateCard(goodCard({ hard: { avgLength: { min: -1, max: 5 } } })).ok, false, 'min 为负')
  assert.equal(validateCard(goodCard({ hard: { avgLength: { min: '1', max: 5 } } })).ok, false, '不是数字')
  assert.equal(validateCard(goodCard({ hard: { avgLength: { min: 5, max: 5 } } })).ok, true, 'min === max 合法')
})

test('emojiPolicy 必须是三选一', () => {
  assert.deepEqual([...EMOJI_POLICIES], ['none', 'allow', 'require'])
  for (const ok of EMOJI_POLICIES) assert.equal(validateCard(goodCard({ hard: { emojiPolicy: ok } })).ok, true, ok)
  assert.equal(validateCard(goodCard({ hard: { emojiPolicy: 'always' } })).ok, false)
  assert.equal(validateCard(goodCard({ hard: { emojiPolicy: null } })).ok, false)
})

test('mustMention 的形状', () => {
  assert.equal(validateCard(goodCard({ hard: { mustMention: { combat: ['受伤'] } } })).ok, true)
  assert.equal(validateCard(goodCard({ hard: { mustMention: ['受伤'] } })).ok, false, '不能是数组')
  assert.equal(validateCard(goodCard({ hard: { mustMention: { combat: '受伤' } } })).ok, false, '值必须是数组')
  assert.equal(validateCard(goodCard({ hard: { mustMention: { combat: [1] } } })).ok, false)
})

test('soft 层缺字段只提醒，不报错', () => {
  const r = validateCard(goodCard({ persona: { soft: { personality: 'x' } } }))
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.includes('background') && w.includes('speechStyle')))
})

test('HARD_KEYS 是闭集且覆盖了校验器实现的每一项', () => {
  assert.ok(Object.isFrozen(HARD_KEYS))
  for (const k of ['speechTics', 'forbiddenWords', 'addresses', 'avgLength', 'emojiPolicy', 'mustMention']) {
    assert.ok(HARD_KEYS.includes(k), `${k} 应当在 HARD_KEYS 里`)
  }
})

// ══════════════════ C. ★ 自相矛盾检查 ══════════════════

test('★ 口癖同时是禁用词 → 报错', () => {
  const r = validateCard(goodCard({ hard: { speechTics: ['呵呵'], forbiddenWords: ['呵呵'] } }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('自相矛盾')))
})

test('★ 口癖含有禁用词 → 报错', () => {
  const r = validateCard(goodCard({ hard: { speechTics: ['本小姐才不'], forbiddenWords: ['本小姐'] } }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('含有禁用词')))
})

test('★ 称呼本身是禁用词 → 报错（这条比口癖那条更隐蔽）', () => {
  const r = validateCard(goodCard({ hard: { addresses: { player: '亲爱的' }, forbiddenWords: ['亲爱的'] } }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('称呼') && e.includes('禁用词')))
})

test('★ mustMention 的词比长度上限还长 → 报错', () => {
  const r = validateCard(goodCard({
    hard: { avgLength: { min: 1, max: 4 }, mustMention: { combat: ['你这个笨蛋受伤了吧'] } },
  }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('mustMention') && e.includes('不可能同时满足')))
})

test('★ 称呼比长度上限还长 → 报错', () => {
  const r = validateCard(goodCard({ hard: { avgLength: { min: 1, max: 3 }, addresses: { player: '我的好搭档' } } }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('称呼') && e.includes('不可能同时满足')))
})

test('★ 要求带表情但长度上限装不下 → 报错', () => {
  const r = validateCard(goodCard({ hard: { emojiPolicy: 'require', avgLength: { min: 1, max: 1 } } }))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('装不下')))
})

test('★ 自相矛盾的卡确实会让校验器没法用（用 lintBatch 实测，不是空口声称）', () => {
  // 口癖「本小姐才不」含有禁用词「本小姐」：
  //   · 说了口癖 → 命中禁用词 → error
  //   · 没说口癖 → 命中口癖警告
  // 也就是**怎么写都不对**，这张卡在机制上就是不可用的。
  const card = goodCard({ hard: { speechTics: ['本小姐才不'], forbiddenWords: ['本小姐'] } })
  assert.equal(validateCard(card).ok, false, 'validateCard 应当先拦下来')

  const { card: normalized } = normalizeCard(card)
  assert.equal(normalized, null, '有 error 的卡不该被归一化后继续用')

  // 就算硬喂给校验器，结果也证明它不可用
  const withTic = lintDialogue('本小姐才不是呢，你别乱说', card)
  assert.equal(withTic.ok, false, '带口癖 ⇒ 命中禁用词')
  const withoutTic = lintDialogue('我可不是那个意思，你别乱说啦', card)
  assert.ok(withoutTic.warnings.some((w) => w.rule === 'speechTics'), '不带口癖 ⇒ 命中口癖警告')

  const batch = lintBatch(['本小姐才不是呢，你别乱说', '我可不是那个意思，你别乱说啦'], card)
  assert.equal(batch.passRate, 0.5, '两句里只有一句没有 error —— 这张卡本身有问题')
})

// ══════════════════ D. normalizeCard ══════════════════

test('normalizeCard 给可选字段补中性默认值', () => {
  const { card, errors } = normalizeCard({
    id: 'a', name: 'b', game: 'c',
    persona: { soft: {}, hard: {} },
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(card.persona.hard, {
    speechTics: [], forbiddenWords: [], addresses: {},
    avgLength: { min: 1, max: 400 }, emojiPolicy: 'allow', mustMention: {},
  })
})

test('normalizeCard 保留已给的硬约束', () => {
  const { card } = normalizeCard(goodCard())
  assert.deepEqual(card.persona.hard.speechTics, ['……才不是'])
  assert.equal(card.persona.hard.emojiPolicy, 'none')
  assert.deepEqual(card.persona.hard.addresses, { player: '你' })
})

test('★ 有 error 时返回 card: null —— 不让坏卡流到下游', () => {
  const { card, errors } = normalizeCard(goodCard({ hard: { emojiPolicy: 'always' } }))
  assert.equal(card, null)
  assert.ok(errors.length > 0)
})

test('normalizeCard 不改入参（纯函数）', () => {
  const original = goodCard()
  const snap = JSON.stringify(original)
  normalizeCard(original)
  assert.equal(JSON.stringify(original), snap)
})

test('normalizeCard 对非法输入也不抛', () => {
  for (const bad of [null, undefined, 'x', 7]) {
    assert.doesNotThrow(() => normalizeCard(bad))
    assert.equal(normalizeCard(bad).card, null)
  }
})

test('★ 归一化后的卡能直接跑校验器（链路闭环）', () => {
  const { card } = normalizeCard(goodCard())
  const state = initState(card)
  const r = lintDialogue('……才不是，你想多了。', card, { state })
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, [])
})
