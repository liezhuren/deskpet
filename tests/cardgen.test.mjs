// tests/cardgen.test.mjs —— app/cardgen.mjs：草稿生成、导入导出、约束解释
//
// 这一层最要紧的不是"能不能生成"，而是**它不该做什么**：
// 不能替用户编硬约束。所以有一条专门的断言盯着这件事：
//   用户给的人设原文只能进 soft（不参与校验），hard 必须是中性默认值。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftCard, draftGaps, exportCard, importCard, explainCard, makeId, NEUTRAL_HARD } from '../app/cardgen.mjs'
import { validateCard } from '../core/card.mjs'
import { ANIMATION_TEMPERAMENTS } from '../core/card.mjs'
import { lintDialogue } from '../core/persona.mjs'
import { actionsFor } from '../art/actions.mjs'

const base = {
  name: '霞', game: 'someday',
  personality: '嘴硬心软', lore: '同班同学，坐你后排。', speechStyle: '短句、爱吐槽',
}

test('草稿生成成功，字段落到该落的地方', () => {
  const r = draftCard({ ...base, temperament: 'lively', address: '你' })
  assert.equal(r.ok, true, r.errors.join('；'))
  assert.equal(r.draft, true)
  assert.equal(r.card.name, '霞')
  assert.equal(r.card.game, 'someday')
  assert.equal(r.card.animation.temperament, 'lively')
  assert.equal(r.card.persona.soft.personality, '嘴硬心软')
  assert.equal(r.card.persona.soft.background, '同班同学，坐你后排。')
  assert.deepEqual(r.card.persona.hard.addresses, { player: '你' })
})

test('★ 底线：人设原文只进 soft，hard 层必须是中性默认值', () => {
  const r = draftCard({ ...base, lore: '她的口癖是「本小姐」，而且从不说「谢谢」', personality: '傲娇毒舌' })
  const h = r.card.persona.hard
  // 关键：不能从这段文字里"提炼"出口癖或禁用词 —— 提炼就是替用户编设定
  assert.deepEqual(h.speechTics, [])
  assert.deepEqual(h.forbiddenWords, [])
  assert.deepEqual(h.mustMention, {})
  assert.deepEqual(h.avgLength, { ...NEUTRAL_HARD.avgLength })
  assert.equal(h.emojiPolicy, 'none')
  assert.match(r.card.persona.soft.background, /本小姐/, '原文原样进 soft')
})

test('★ 生成出来的草稿本身就能过 schema 校验（但不能过"内容完整"这一关）', () => {
  const r = draftCard(base)
  assert.equal(validateCard(r.card).ok, true)
  const gaps = draftGaps(r.card)
  assert.ok(gaps.length >= 2, '草稿应当被指出还缺什么')
  assert.ok(gaps.some((g) => g.includes('口癖')))
  assert.ok(gaps.some((g) => g.includes('禁用词')))
})

test('缺角色名 / 游戏标识时明确报错', () => {
  assert.equal(draftCard({ game: 'g' }).ok, false)
  assert.ok(draftCard({ game: 'g' }).errors.some((e) => e.includes('角色名')))
  assert.equal(draftCard({ name: 'n' }).ok, false)
  assert.ok(draftCard({ name: 'n' }).errors.some((e) => e.includes('游戏标识')))
})

test('气质取值非法时退回 calm（宽松默认，不阻塞）', () => {
  for (const t of ['暴躁', '', null, 42]) {
    assert.equal(draftCard({ ...base, temperament: t }).card.animation.temperament, 'calm', String(t))
  }
  for (const t of ANIMATION_TEMPERAMENTS) {
    assert.equal(draftCard({ ...base, temperament: t }).card.animation.temperament, t)
  }
})

test('★ 气质真的会改变需要的动作（草稿也要一致）', () => {
  const lively = draftCard({ ...base, temperament: 'lively' }).card
  const cool = draftCard({ ...base, temperament: 'cool' }).card
  assert.ok(actionsFor(lively).required.includes('greeting'))
  assert.ok(!actionsFor(cool).required.includes('greeting'))
  assert.ok(actionsFor(cool).required.includes('worried'))
  for (const c of [lively, cool]) {
    for (const must of ['idle', 'idleBored', 'talk']) assert.ok(actionsFor(c).required.includes(must))
  }
})

test('id 由 name+game 派生：同输入恒定，不同输入不同', () => {
  assert.equal(draftCard(base).card.id, draftCard(base).card.id)
  assert.notEqual(draftCard(base).card.id, draftCard({ ...base, name: '另一位' }).card.id)
  assert.equal(makeId('a', 'b'), makeId('a', 'b'))
})

test('draftCard 对空输入不崩', () => {
  for (const bad of [undefined, null, {}, 0, 'x', []]) {
    assert.doesNotThrow(() => draftCard(bad))
    assert.equal(draftCard(bad).ok, false)
  }
})

test('draftGaps 对脏输入不崩', () => {
  for (const bad of [null, undefined, {}, { persona: null }, { persona: { hard: null } }]) {
    assert.doesNotThrow(() => draftGaps(bad))
  }
})

// ---------- 导入导出 ----------

test('★ 导出 → 导入往返一致', () => {
  const card = draftCard({ ...base, address: '你' }).card
  const ex = exportCard(card)
  assert.equal(ex.ok, true)
  const im = importCard(ex.text)
  assert.equal(im.ok, true)
  assert.deepEqual(im.card, card)
})

test('★ 不完整的草稿**也允许导出**（卡是用户的资产，不该因为校验器不喜欢就导不出来）', () => {
  const draft = draftCard(base).card   // hard 还是空的
  const ex = exportCard(draft)
  assert.equal(ex.ok, true)
  assert.ok(ex.text.length > 0)
  assert.ok(Array.isArray(ex.errors))
})

test('导出的 JSON 能被 JSON.parse 回来（不是"看起来像 JSON"）', () => {
  const ex = exportCard(draftCard(base).card, { pretty: false })
  assert.doesNotThrow(() => JSON.parse(ex.text))
})

test('★ 导入非法内容时给可读错误，且不抛异常', () => {
  for (const bad of ['', '   ', '{ 不是 JSON', '[]', 'null', '123']) {
    assert.doesNotThrow(() => importCard(bad), JSON.stringify(bad))
    assert.equal(importCard(bad).ok, false, JSON.stringify(bad))
  }
  assert.match(importCard('{ 坏').errors[0], /JSON/)
  assert.match(importCard('').errors[0], /空/)
})

test('导入一张自相矛盾的卡会被拦下（并说清哪里矛盾）', () => {
  const card = draftCard(base).card
  const broken = {
    ...card,
    persona: { ...card.persona, hard: { ...card.persona.hard, addresses: { player: '亲爱的' }, forbiddenWords: ['亲爱的'] } },
  }
  const r = importCard(JSON.stringify(broken))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('禁用词')), r.errors.join('；'))
})

test('exportCard 对空输入不崩', () => {
  for (const bad of [null, undefined, 0, 'x']) {
    assert.doesNotThrow(() => exportCard(bad))
    assert.equal(exportCard(bad).ok, false)
  }
})

// ---------- explainCard ----------

test('★ explainCard 把每条硬约束摊开（让用户知道改这行会影响什么）', () => {
  const card = draftCard({ ...base, address: '你' }).card
  const e = explainCard(card)
  assert.equal(e.hard.length, 6)
  const byKey = Object.fromEntries(e.hard.map((h) => [h.key, h]))
  assert.ok(byKey.speechTics.note.includes('单句没有不判错'), '要写清"单句没有不判错"这个反直觉的点')
  assert.ok(byKey.forbiddenWords.note.includes('出现即判'), byKey.forbiddenWords.note)
  assert.equal(byKey.addresses.present, true)
  assert.equal(byKey.speechTics.present, false)
  assert.deepEqual(e.emojiPolicies, ['none', 'allow', 'require'])
  assert.equal(e.animation.temperament, 'calm')
  assert.ok(e.animation.required.includes('idleBored'))
  assert.deepEqual(e.soft, ['personality', 'background', 'speechStyle'])
})

// ---------- 与校验器的闭环 ----------

test('★ 把草稿的 hard 填上之后，模板产出就能过校验器（闭环）', async () => {
  const { card } = draftCard({ ...base, address: '你' })
  const filled = {
    ...card,
    draft: false,
    persona: {
      ...card.persona,
      hard: { ...card.persona.hard, speechTics: ['……不是'], forbiddenWords: ['本小姐'], avgLength: { min: 6, max: 40 } },
    },
  }
  assert.equal(validateCard(filled).ok, true)

  const { buildRequest } = await import('../dialogue/base.mjs')
  const { createTemplateProvider, generate } = await import('../dialogue/template.mjs')
  const { initState } = await import('../core/persona.mjs')
  const st = { ...initState(filled), affinity: 0.8 }
  const req = buildRequest({ card: filled, state: st, trigger: { kind: 'save', summaries: ['存档'] }, seed: 0 })
  const { text } = generate(req, { seed: 0 })
  assert.ok(text.length > 0)
  const lint = lintDialogue(text, filled, { state: st, triggerKind: 'save' })
  assert.equal(lint.ok, true, `${text} → ${JSON.stringify(lint.errors)}`)
  assert.ok(!text.includes('本小姐'), '禁用词绝不能出现')
  void createTemplateProvider
})
