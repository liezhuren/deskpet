// tests/card-spec.test.mjs —— core/card-spec.mjs（角色卡格式的规范）+ lore/fill.mjs（填表）
//
// 用户的要求：「我想要一个规范的角色卡格式，不要让 llm 即兴生成，而是让他类似于填表一样地生成角色卡。」
// 所以这两件事必须被钉死：
//   ★ 格式只有**一个**事实来源，且校验 / 填表 / 文档都从它派生（不能各写一遍）
//   ★ 填表时**未登记的格子直接拒** —— 否则"格式定死"就是一句空话
//   ★ 没有依据的格子留空是**正确**行为，编一个才是错的

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  FIELDS, FIELD_PATHS, LAYERS, LAYER_DOC, CARD_VERSION,
  fieldByPath, fieldsOfLayer, modelFillablePaths, evidenceRequiredPaths, requiredPaths,
  REQUIRED_CONTAINERS, CONTAINER_PATHS, HARD_FIELD_PATHS,
  blankForm, readPath, writePath, fieldBriefs, validateAgainstSpec, listLeafPaths, specToMarkdown,
} from '../core/card-spec.mjs'
import {
  fillForm, FORM_FORMAT, SLOT_STATUS, slotBriefs, buildFillPrompt,
  parseFilledForm, applyFilledForm, fillCardForm,
} from '../lore/fill.mjs'
import { HARD_KEYS, ANIMATION_TEMPERAMENTS, EMOJI_POLICIES, validateCard } from '../core/card.mjs'
import { draftCard } from '../app/cardgen.mjs'
import { actionsFor } from '../art/actions.mjs'
import { STYLE_IDS } from '../art/styles.mjs'

const LORE = [
  '霞是主角的同班同学，坐在后排。',
  '她的口癖是「……才不是」，嘴上从不承认自己在关心别人。',
  '性格开朗，爱吐槽，但她说自己「不需要你操心」。',
  '她从不说「谢谢」，只会用行动表达。',
  '称呼主角为「你」，但心里其实另有叫法。',
].join('\n')

function goodCard(over = {}) {
  return {
    id: 'x', name: '霞', game: 'g', version: CARD_VERSION, draft: false,
    animation: { temperament: 'calm', style: 'soft', actions: [], scale: 1 },
    persona: {
      soft: { personality: '嘴硬心软', background: '同班同学', speechStyle: '短句' },
      hard: {
        speechTics: ['……才不是'], forbiddenWords: ['本小姐'], addresses: { player: '你' },
        avgLength: { min: 4, max: 40 }, emojiPolicy: 'none', mustMention: {},
      },
    },
    ...over,
  }
}

// ══════════════════ A. 规范本身 ══════════════════

test('★ spec 是完整的：每个字段都回答了"哪层/谁填/什么类型/填错怎样"', () => {
  assert.ok(FIELDS.length >= 15, `字段太少：${FIELDS.length}`)
  for (const f of FIELDS) {
    assert.ok(LAYERS.includes(f.layer), `${f.path} 的 layer 不合法：${f.layer}`)
    assert.ok(['derived', 'user', 'model'].includes(f.fill), `${f.path} 的 fill 不合法：${f.fill}`)
    assert.ok(typeof f.type === 'string' && f.type.length > 0, `${f.path} 缺类型`)
    assert.ok(typeof f.desc === 'string' && f.desc.length >= 4, `${f.path} 缺说明（说明会被写进文档与提示词）`)
    if (f.fill === 'model') assert.ok(f.ask.length > 0, `${f.path} 是模型可填的，就该有一句"该怎么问"`)
    if (f.type === 'enum') assert.ok(Array.isArray(f.values) && f.values.length > 0, `${f.path} 是枚举却没给取值`)
  }
  assert.equal(new Set(FIELD_PATHS).size, FIELD_PATHS.length, '字段路径不能重复')
})

test('★ 每个字段都被分到了某个层，且每层都有字段（不能有"没人管"的字段）', () => {
  const covered = LAYERS.flatMap((l) => fieldsOfLayer(l).map((f) => f.path))
  assert.deepEqual([...covered].sort(), [...FIELD_PATHS].sort())
  for (const l of LAYERS) assert.ok(fieldsOfLayer(l).length > 0, `${l} 层没有字段`)
  for (const l of LAYERS) assert.ok(LAYER_DOC[l].length > 4, `${l} 层缺用途说明`)
})

test('★ 派生字段不许交给模型填（id 之类）', () => {
  assert.ok(FIELD_PATHS.includes('id'))
  assert.equal(fieldByPath('id').fill, 'derived')
  assert.ok(!modelFillablePaths.includes('id'))
  assert.ok(!modelFillablePaths.includes('game'), 'game 是用户给的标识，不该由模型猜')
  assert.ok(!modelFillablePaths.includes('animation.style'), 'style 是主观选择，没有"正确答案"可抽')
})

test('★ 证据要求只压在 hard 层与 soft 的可抽字段上', () => {
  // 关键：hard 层里凡是模型能填的，都必须带出处 —— 它们会被当硬约束执行
  for (const p of HARD_FIELD_PATHS) {
    const f = fieldByPath(p)
    if (f.fill === 'model') assert.ok(f.evidence, `${p} 是模型可填的 hard 字段，必须要求出处`)
  }
  // 而纯主观的字段不该要求出处（没有"依据"可言）
  for (const p of ['persona.hard.emojiPolicy', 'persona.hard.mustMention', 'animation.style']) {
    assert.equal(fieldByPath(p).evidence, false, `${p} 不该要求出处`)
  }
})

test('★ 枚举取值与 card.mjs 导出的常量完全一致（同一份事实，不能各写一遍）', () => {
  assert.deepEqual([...HARD_KEYS].sort(), HARD_FIELD_PATHS.map((p) => p.split('.').pop()).sort())
  assert.deepEqual([...ANIMATION_TEMPERAMENTS], [...fieldByPath('animation.temperament').values])
  assert.deepEqual([...EMOJI_POLICIES], [...fieldByPath('persona.hard.emojiPolicy').values])
  assert.deepEqual([...fieldByPath('animation.style').values], [...STYLE_IDS])
})

test('★ 必填容器覆盖 persona 的三层结构', () => {
  for (const c of ['persona', 'persona.soft', 'persona.hard']) assert.ok(REQUIRED_CONTAINERS.includes(c))
  assert.ok(CONTAINER_PATHS.includes('persona'))
  assert.ok(CONTAINER_PATHS.includes('animation'))
})

// ══════════════════ B. blankForm / 路径读写 ══════════════════

test('★ blankForm：格子由 spec 决定，派生字段不进表', () => {
  const form = blankForm()
  assert.ok(form._format.includes('card@'))
  assert.ok(form._instructions.length > 0)
  for (const p of FIELD_PATHS) {
    const f = fieldByPath(p)
    const present = readPath(form, p) !== undefined
    assert.equal(present, f.fill !== 'derived', `${p} 该不该出现在表里判断错了`)
  }
  assert.equal(readPath(form, 'id'), undefined)
  assert.equal(readPath(form, 'persona.hard.speechTics'), null, '空表里的格子应当显式为 null')
})

test('blankForm(withDefaults) 用 spec 默认值填格子', () => {
  const form = blankForm({ withDefaults: true })
  assert.deepEqual(readPath(form, 'persona.hard.avgLength'), { min: 4, max: 40 })
  assert.equal(readPath(form, 'persona.hard.emojiPolicy'), 'none')
  assert.equal(readPath(form, 'animation.temperament'), 'calm')
})

test('readPath / writePath 成对且支持深路径', () => {
  const o = {}
  writePath(o, 'a.b.c', 1)
  assert.deepEqual(o, { a: { b: { c: 1 } } })
  assert.equal(readPath(o, 'a.b.c'), 1)
  assert.equal(readPath(o, 'a.b.z'), undefined)
  assert.equal(readPath(null, 'a'), undefined)
  writePath(o, 'a.b.c', 2)
  assert.equal(readPath(o, 'a.b.c'), 2)
})

test('fieldBriefs 只给可填字段，且能按层与"只给模型可填的"过滤', () => {
  const all = fieldBriefs()
  assert.ok(all.every((b) => b.path !== 'id'))
  const hard = fieldBriefs({ layers: ['hard'] })
  assert.ok(hard.every((b) => b.layer === 'hard'))
  const model = fieldBriefs({ onlyModel: true })
  assert.deepEqual(model.map((b) => b.path), [...modelFillablePaths])
})

// ══════════════════ C. 按 spec 校验 ══════════════════

test('★ validateAgainstSpec：类型 / 枚举 / 范围 / 必填 / 容器', () => {
  assert.deepEqual(validateAgainstSpec(goodCard()).errors, [])

  assert.ok(validateAgainstSpec(goodCard({ id: '' })).errors.some((e) => e.includes('id')))
  assert.ok(validateAgainstSpec(goodCard({ id: '   ' })).errors.some((e) => e.includes('id')), '只有空白也算缺')
  assert.ok(validateAgainstSpec({ ...goodCard(), persona: undefined }).errors.some((e) => e.includes('persona')))
  assert.ok(validateAgainstSpec({ ...goodCard(), persona: [] }).errors.some((e) => e.includes('必须是对象')))
  assert.ok(validateAgainstSpec({ ...goodCard(), animation: [] }).errors.some((e) => e.includes('animation')))
  assert.ok(validateAgainstSpec(goodCard({ animation: { temperament: '暴躁' } })).errors.some((e) => e.includes('temperament')))
  assert.ok(validateAgainstSpec(goodCard({ animation: { scale: 99 } })).errors.some((e) => e.includes('scale')))
  assert.ok(validateAgainstSpec(goodCard({ persona: { ...goodCard().persona, hard: { avgLength: { min: 9, max: 2 } } } })).errors.some((e) => e.includes('min')))
  assert.ok(validateAgainstSpec(goodCard({ persona: { ...goodCard().persona, hard: { speechTics: '不是数组' } } })).errors.length > 0)
  assert.ok(validateAgainstSpec(goodCard({ persona: { ...goodCard().persona, hard: { mustMention: { combat: [1] } } } })).errors.some((e) => e.includes('combat')))
})

test('★ 显式写成 null 与"整个键不写"是两件事', () => {
  const withNull = goodCard({ persona: { ...goodCard().persona, hard: { ...goodCard().persona.hard, emojiPolicy: null } } })
  const r = validateAgainstSpec(withNull)
  assert.ok(r.errors.some((e) => e.includes('不能为 null')), r.errors.join(' | '))

  const omitted = goodCard({ persona: { ...goodCard().persona, hard: { speechTics: ['x'] } } })
  assert.deepEqual(validateAgainstSpec(omitted).errors, [], '整个键不写只是"没填"，不是错')
})

test('★ 闭集：未登记的字段要报出来（模型不能自己加字段）', () => {
  const card = goodCard({ persona: { ...goodCard().persona, hard: { ...goodCard().persona.hard, favoriteColor: 'blue' } } })
  const r = validateAgainstSpec(card)
  assert.equal(r.errors.length, 0, '未登记的字段只是警告，不阻塞')
  assert.ok(r.warnings.some((w) => w.includes('favoriteColor') && w.includes('未登记')), r.warnings.join(' | '))
})

test('★ 闭集检查不能因为"路径以 persona 开头"就把该报的跳掉', () => {
  // 这一条是回归：早先有个前缀过滤把 persona.* 全跳过了，于是闭集检查等于没做
  const card = goodCard({ persona: { ...goodCard().persona, hard: { ...goodCard().persona.hard, 乱写的: 1 } } })
  assert.ok(validateAgainstSpec(card).warnings.some((w) => w.includes('乱写的')))
  const top = goodCard({ persona: { ...goodCard().persona, soft: { ...goodCard().persona.soft, extra: 'x' } } })
  assert.ok(validateAgainstSpec(top).warnings.some((w) => w.includes('persona.soft.extra')))
})

test('用户自己挂在卡上的顶层笔记不报警（卡是用户的资产）', () => {
  const card = goodCard({ myNotes: '这行是我自己记的' })
  assert.deepEqual(validateAgainstSpec(card).warnings, [])
})

test('validateAgainstSpec 对脏输入不崩', () => {
  for (const bad of [null, undefined, 0, 'x', [], true]) {
    assert.doesNotThrow(() => validateAgainstSpec(bad))
    assert.equal(validateAgainstSpec(bad).errors.length > 0, true)
  }
})

test('listLeafPaths 列出叶子且不展开空对象', () => {
  assert.deepEqual(listLeafPaths({ a: 1, b: { c: 2 } }).sort(), ['a', 'b.c'])
  assert.deepEqual(listLeafPaths({ a: {} }), ['a'])
  assert.deepEqual(listLeafPaths(null), [])
})

test('★ validateCard 已经改成从 spec 派生（同一份事实）', () => {
  // 只要 spec 判它错，validateCard 就必须也判错 —— 两边不能各有一套规则
  const cases = [
    goodCard({ id: '' }),
    goodCard({ animation: { temperament: '暴躁' } }),
    goodCard({ persona: { ...goodCard().persona, hard: { emojiPolicy: null } } }),
    goodCard({ persona: { ...goodCard().persona, hard: { avgLength: { min: 9, max: 2 } } } }),
  ]
  for (const c of cases) {
    assert.ok(validateAgainstSpec(c).errors.length > 0, 'spec 应当判错')
    assert.equal(validateCard(c).ok, false, 'validateCard 必须也判错')
  }
  assert.equal(validateCard(goodCard()).ok, true)
})

// ══════════════════ D. ★ 填表（用户的直接要求） ══════════════════

test('★ fillForm：格子由 spec 派生，且只含"模型可填"的', () => {
  const form = fillForm()
  assert.equal(form._format, FORM_FORMAT)
  assert.match(form._instructions, /不要新增格子/)
  assert.deepEqual(Object.keys(form.slots).sort(), [...modelFillablePaths].sort())
  assert.equal(form.slots['id'], undefined, '派生字段不该出现在表里')
  assert.equal(form.slots['game'], undefined)
  for (const [path, slot] of Object.entries(form.slots)) {
    assert.equal(slot._fill, null, '空表的值必须是 null')
    assert.ok(slot._type, `${path} 缺类型标注`)
    assert.ok(slot._ask, `${path} 缺提问`)
  }
})

test('★ 提示词把"不许新增格子、没依据就留空、出处要逐字复制"写在最前面', () => {
  const p = buildFillPrompt(LORE, { name: '霞' })
  assert.match(p, /只填表里已有的格子/)
  assert.match(p, /没有依据就留 null/)
  assert.match(p, /逐字复制/)
  assert.match(p, /未登记的格子会被程序直接丢掉/)
  assert.ok(p.includes('……才不是'), '原文要带进去')
  assert.match(p, /persona\.hard\.speechTics/, '格子名要带进去')
  assert.ok(FORM_FORMAT.includes('form@'))
})

test('slotBriefs 覆盖全部可填格子并带上提问', () => {
  const briefs = slotBriefs()
  assert.equal(briefs.length, modelFillablePaths.length)
  for (const b of briefs) assert.ok(b.ask.length > 0, `${b.path} 缺提问`)
})

test('★ parseFilledForm：正常填法解析出值（含出处）', () => {
  const text = JSON.stringify({ slots: {
    'persona.hard.speechTics': { value: ['……才不是'], quote: '她的口癖是「……才不是」' },
    'animation.temperament': { value: 'lively', quote: '性格开朗' },
    'persona.soft.background': { value: '同班同学', quote: '霞是主角的同班同学' },
    'persona.hard.avgLength': null,
  } })
  const r = parseFilledForm(text)
  assert.equal(r.ok, true)
  assert.equal(r.blank, 1, '留 null 的格子算"留空"，不是失败')
  assert.deepEqual(r.slots['persona.hard.speechTics'].value, ['……才不是'])
  assert.equal(r.slots['persona.hard.speechTics'].quote, '她的口癖是「……才不是」')
  assert.equal(r.slots['animation.temperament'].value, 'lively')
  assert.equal(r.rejected.length, 0)
})

test('★★ 未登记的格子会被**显式拒掉**（这就是"不许即兴生成"）', () => {
  const text = JSON.stringify({ slots: {
    'persona.hard.speechTics': { value: ['x'], quote: '她的口癖是「x」' },
    'persona.hard.favoriteColor': { value: 'blue', quote: '她喜欢蓝色' },
    'persona.hard.catchphrase': { value: 'y', quote: 'y' },
  } })
  const r = parseFilledForm(text)
  assert.equal(r.rejected.length, 2)
  const paths = r.rejected.map((x) => x.path).sort()
  assert.deepEqual(paths, ['persona.hard.catchphrase', 'persona.hard.favoriteColor'])
  assert.ok(r.rejected.every((x) => /未登记/.test(x.reason)))
  assert.ok(!('persona.hard.favoriteColor' in r.slots), '未登记的格子绝不能进 slots')
})

test('★ 不该由模型填的格子（user / derived）也会被拒', () => {
  const r = parseFilledForm(JSON.stringify({ slots: {
    id: { value: '瞎写的 id' },
    'animation.style': { value: 'pixel' },
    'persona.hard.mustMention': { value: { save: ['存档'] } },
  } }))
  assert.equal(r.rejected.length, 3)
  assert.ok(r.rejected.every((x) => /不是给模型填的/.test(x.reason)))
})

test('★ hard 层的格子没给出处会被拒（出处是防幻觉的那道闸门）', () => {
  const r = parseFilledForm(JSON.stringify({ slots: {
    'persona.hard.speechTics': { value: ['哼'] },
    'persona.soft.personality': { value: '嘴硬' },
  } }))
  assert.equal(r.rejected.length, 1)
  assert.match(r.rejected[0].reason, /需要出处/)
  assert.ok('persona.soft.personality' in r.slots, 'soft 层不要求出处')
})

test('★ 值类型按 spec 收敛：无歧义的笔误修，有歧义的拒', () => {
  const r = parseFilledForm(JSON.stringify({ slots: {
    'persona.hard.speechTics': { value: '……才不是', quote: '她的口癖是「……才不是」' },
    'animation.temperament': { value: 'LIVELY', quote: '性格开朗' },
    'persona.hard.avgLength': { value: { min: 4, max: 20 }, quote: '她话很少' },
  } }))
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected))
  assert.deepEqual(r.slots['persona.hard.speechTics'].value, ['……才不是'], '单字符串应包成数组')
  assert.equal(r.slots['animation.temperament'].value, 'lively', '枚举大小写应归一')

  const bad = parseFilledForm(JSON.stringify({ slots: {
    'animation.temperament': { value: '暴躁', quote: '她性格非常暴躁易怒' },
    'persona.hard.avgLength': { value: { min: 9, max: 2 }, quote: '她话很少说得很短' },
  } }))
  assert.equal(bad.rejected.length, 2)
  assert.ok(bad.rejected.some((x) => /只能是/.test(x.reason)), JSON.stringify(bad.rejected))
  assert.ok(bad.rejected.some((x) => /不能大于/.test(x.reason)))
})

test('★ 出处太短（<4 字）会被拒 —— 这条要写进提示词，否则模型不会知道', () => {
  const short = parseFilledForm(JSON.stringify({ slots: { 'animation.temperament': { value: 'calm', quote: '冷静' } } }))
  assert.equal(short.rejected.length, 1)
  assert.match(short.rejected[0].reason, /太短/)
  assert.match(buildFillPrompt('x'), /至少 4 个字/)
})

test('parseFilledForm：宽容吃掉代码块 / 直接给字面量 / 省略 value 键', () => {
  const fenced = parseFilledForm('```json\n{"slots":{"animation.temperament":{"value":"cool","quote":"她很高冷"}}}\n```')
  assert.equal(fenced.ok, true)
  assert.equal(fenced.slots['animation.temperament'].value, 'cool')

  const bare = parseFilledForm(JSON.stringify({ slots: { 'persona.soft.personality': '嘴硬心软' } }))
  assert.equal(bare.ok, true)
  assert.equal(bare.slots['persona.soft.personality'].value, '嘴硬心软')

  const asFill = parseFilledForm(JSON.stringify({ slots: { 'persona.soft.speechStyle': { _fill: '短句' } } }))
  assert.equal(asFill.ok, true)
  assert.equal(asFill.slots['persona.soft.speechStyle'].value, '短句')
})

test('parseFilledForm：坏输入给可读错误，不抛', () => {
  for (const bad of ['', '随便说点什么', '{坏 json}', '{"nope":1}']) {
    assert.doesNotThrow(() => parseFilledForm(bad), JSON.stringify(bad))
    assert.equal(parseFilledForm(bad).ok, false)
  }
  assert.match(parseFilledForm('').error, /空内容/)
  assert.match(parseFilledForm('随便').error, /没有 JSON/)
})

test('parseFilledForm：模型把表格说明抄回来（_type 之类）不该当成格子', () => {
  const r = parseFilledForm(JSON.stringify({ slots: { _type: 'enum', _ask: 'x', 'animation.temperament': { value: 'calm', quote: '她一向很冷静' } } }))
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected))
  assert.equal(Object.keys(r.slots).length, 1)
})

// ══════════════════ E. ★ 落卡：证据核验 + 逐格确认 ══════════════════

test('★ applyFilledForm：出处不成立的格子被拒（编的东西进不了卡）', () => {
  const parsed = parseFilledForm(JSON.stringify({ slots: {
    'persona.hard.speechTics': { value: ['……才不是'], quote: '她的口癖是「……才不是」' },  // 真
    'persona.hard.forbiddenWords': { value: ['请'], quote: '她从来不说请字' },              // 编的
  } }))
  const card = draftCard({ name: '霞', game: 'someday' }).card
  const r = applyFilledForm(card, parsed, LORE, { 'persona.hard.speechTics': true, 'persona.hard.forbiddenWords': true })
  assert.equal(r.rejected.length, 1)
  assert.ok(r.rejected.some((x) => x.path === 'persona.hard.forbiddenWords'))
  assert.equal(r.applied, 1)
  assert.deepEqual(r.card.persona.hard.speechTics, ['……才不是'])
  assert.deepEqual(r.card.persona.hard.forbiddenWords, [], '编出来的禁用词绝不能进卡')
})

test('★ applyFilledForm：没确认的格子一律不写（提议 ≠ 生效）', () => {
  const parsed = parseFilledForm(JSON.stringify({ slots: {
    'persona.hard.speechTics': { value: ['……才不是'], quote: '她的口癖是「……才不是」' },
    'animation.temperament': { value: 'lively', quote: '性格开朗' },
  } }))
  const card = draftCard({ name: '霞', game: 'g' }).card
  const none = applyFilledForm(card, parsed, LORE, {})
  assert.equal(none.applied, 0)
  assert.deepEqual(none.card.persona.hard.speechTics, [])
  assert.equal(none.card.animation.temperament, 'calm')

  const some = applyFilledForm(card, parsed, LORE, { 'persona.hard.speechTics': true })
  assert.equal(some.applied, 1)
  assert.deepEqual(some.card.persona.hard.speechTics, ['……才不是'])
  assert.equal(some.card.animation.temperament, 'calm', '没确认的气质不该生效')
})

// ══════════════════ F. ★ 一条龙 ══════════════════

test('★ fillCardForm：没有模型时用启发式填，产出仍按同一张表', async () => {
  const r = await fillCardForm({ lore: LORE, forceHeuristic: true })
  assert.equal(r.source, 'heuristic')
  assert.equal(r.form._format, FORM_FORMAT)
  assert.ok(r.proposals.length >= 3, JSON.stringify(r.proposals.map((p) => p.path)))
  for (const p of r.proposals) {
    assert.ok(modelFillablePaths.includes(p.path), `${p.path} 不在可填格子里`)
    assert.ok(p.evidence.length > 0, `${p.path} 缺出处`)
  }
  assert.ok(r.proposals.some((p) => p.path === 'persona.hard.speechTics'))
  assert.ok(r.proposals.some((p) => p.path === 'persona.soft.background'), 'soft 的 background 也该被填上')
  assert.ok(r.notes.length > 0)
})

test('★ fillCardForm：有模型时走模型那条路，且未登记的格子被拒并报出来', async () => {
  const provider = {
    available: () => true,
    async generate({ prompt }) {
      assert.match(prompt, /只填表里已有的格子/, '发给模型的必须是填表提示词')
      return { text: JSON.stringify({ slots: {
        'persona.soft.personality': { value: '嘴硬心软' },
        'persona.hard.speechTics': { value: ['……才不是'], quote: '她的口癖是「……才不是」' },
        'persona.hard:乱加的': { value: 1 },
      } }) }
    },
  }
  const r = await fillCardForm({ lore: LORE, provider })
  assert.equal(r.source, 'model')
  assert.ok(r.proposals.some((p) => p.path === 'persona.hard.speechTics'))
  assert.ok(r.rejected.some((x) => x.path === 'persona.hard:乱加的'))
  assert.ok(r.notes.some((n) => n.includes('未登记') || n.includes('不合格')))
})

test('★ fillCardForm：模型不可用 / 抛错 / 返回垃圾，一律退到启发式并说明', async () => {
  const unavailable = { available: () => false, generate: async () => ({ text: '' }) }
  const r1 = await fillCardForm({ lore: LORE, provider: unavailable })
  assert.equal(r1.source, 'heuristic')
  assert.ok(r1.notes.some((n) => n.includes('启发式')))

  const boom = { available: () => true, generate: async () => { throw new Error('网络炸了') } }
  const r2 = await fillCardForm({ lore: LORE, provider: boom })
  assert.equal(r2.source, 'heuristic')
  assert.ok(r2.notes.some((n) => n.includes('网络炸了')))

  const junk = { available: () => true, generate: async () => ({ text: '我随便说两句' }) }
  const r3 = await fillCardForm({ lore: LORE, provider: junk })
  assert.equal(r3.source, 'heuristic')
  assert.ok(r3.notes.some((n) => n.includes('解析不了')))
})

test('★ 一条龙端到端：填表 → 逐格确认 → 得到一张能过校验、动作清单也变了的卡', async () => {
  const base = draftCard({ name: '霞', game: 'someday' }).card
  const filled = await fillCardForm({ lore: LORE, card: base, forceHeuristic: true })
  assert.ok(filled.proposals.length >= 3)

  const confirmed = Object.fromEntries(filled.proposals.map((p) => [p.path, true]))
  const r = applyFilledForm(base, { slots: Object.fromEntries(filled.proposals.map((p) => [p.path, { value: p.value, quote: p.evidence }])) }, LORE, confirmed)
  assert.ok(r.applied >= 3, JSON.stringify(r))
  assert.equal(validateCard(r.card).ok, true, JSON.stringify(validateCard(r.card).errors))
  assert.ok(r.card.persona.hard.speechTics.includes('……才不是'))
  assert.ok(r.card.persona.hard.forbiddenWords.includes('谢谢'))
  assert.equal(r.card.animation.temperament, 'lively')
  assert.ok(actionsFor(r.card).required.includes('greeting'), '气质生效后动作清单也要跟着变')
  assert.deepEqual(validateAgainstSpec(r.card).errors, [])
})

test('fillCardForm：没有原文时如实说明，不出表内容', async () => {
  const r = await fillCardForm({ lore: '', forceHeuristic: true })
  assert.equal(r.source, 'none')
  assert.deepEqual(r.proposals, [])
  assert.ok(r.notes.some((n) => n.includes('没有原文')))
  assert.doesNotThrow(() => fillCardForm({}))
})

test('★ 回归：applyProposals 按 spec 派发，soft 层不会被静默跳过', async () => {
  // 早先的 applyProposals 是手写 switch，只认得 hard 层那几个字段名，
  // 于是 soft 层被算成"跳过" —— 用户点了确认却没写进去，而且**不报错**。
  const { applyProposals } = await import('../lore/propose.mjs')
  const card = draftCard({ name: '霞', game: 'g' }).card
  const props = [
    { key: 'p', field: 'personality', path: 'persona.soft.personality', value: '嘴硬心软', evidence: 'x' },
    { key: 's', field: 'speechStyle', path: 'persona.soft.speechStyle', value: '短句', evidence: 'x' },
    { key: 'b', field: 'background', path: 'persona.soft.background', value: '同班同学', evidence: 'x' },
    { key: 't', field: 'speechTics', path: 'persona.hard.speechTics', value: ['……才不是'], evidence: 'x' },
    { key: 'e', field: 'emojiPolicy', value: 'allow', evidence: 'x' },
  ]
  const r = applyProposals(card, props, Object.fromEntries(props.map((p) => [p.key, true])))
  assert.equal(r.applied, 5, JSON.stringify(r))
  assert.equal(r.skipped, 0)
  assert.equal(r.card.persona.soft.personality, '嘴硬心软')
  assert.equal(r.card.persona.soft.speechStyle, '短句')
  assert.equal(r.card.persona.soft.background, '同班同学')
  assert.deepEqual(r.card.persona.hard.speechTics, ['……才不是'])
  // 没给 path 的老式提议靠字段名兜底
  assert.equal(r.card.persona.hard.emojiPolicy, 'allow')
  assert.equal(validateAgainstSpec(r.card).errors.length, 0)
})

test('★ 回归：applyProposals 挡住"给派生字段赋值"（模型不许改 id）', async () => {
  const { applyProposals } = await import('../lore/propose.mjs')
  const card = draftCard({ name: '霞', game: 'g' }).card
  const r = applyProposals(card, [{ key: 0, field: 'id', path: 'id', value: '被改了' }], { 0: true })
  assert.equal(r.applied, 0)
  assert.equal(r.card.id, card.id, 'id 必须原样不动')
})

// ══════════════════ G. ★ 文档与 spec 不许漂移 ══════════════════

test('★ docs/CARD.md 与 specToMarkdown() 逐字一致（否则"规范"就是两套说法）', () => {
  const path = join(import.meta.dirname, '..', 'docs', 'CARD.md')
  assert.ok(existsSync(path), 'docs/CARD.md 不存在 —— 跑 node tools/gen-card-doc.mjs 生成')
  const onDisk = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trimEnd()
  const generated = specToMarkdown().replace(/\r\n/g, '\n').trimEnd()
  assert.equal(onDisk, generated,
    'docs/CARD.md 与 spec 不一致 —— 改完 spec 要重新生成：node tools/gen-card-doc.mjs')
})

test('文档里列出了每个可填字段与空表', () => {
  const md = specToMarkdown()
  for (const p of FIELD_PATHS) assert.ok(md.includes(`\`${p}\``), `文档漏了字段 ${p}`)
  assert.match(md, /模型不许新增字段/)
  assert.match(md, /空表/)
  for (const l of LAYERS) assert.ok(md.includes(`## ${l}`), `文档漏了层 ${l}`)
})

// ══════════════════ H. examples 不许过期 ══════════════════

test('★ examples/card.example.json 必须是一张**能过校验**的卡（样例一旦失效就成了误导）', () => {
  const path = join(import.meta.dirname, '..', 'examples', 'card.example.json')
  assert.ok(existsSync(path), 'examples/card.example.json 不存在')
  const card = JSON.parse(readFileSync(path, 'utf8'))

  const check = validateCard(card)
  assert.equal(check.ok, true, `样例卡过不了校验：${check.errors.join('；')}`)
  assert.deepEqual(validateAgainstSpec(card).errors, [])
  assert.equal(validateAgainstSpec(card).warnings.length, 0,
    `样例卡不该有"未登记字段"这类警告：${validateAgainstSpec(card).warnings.join('；')}`)

  // 它得是一张"有用的"卡：hard 层不能是空的，否则示例看不出这套格式的意义
  assert.ok(card.persona.hard.speechTics.length > 0, '样例卡该有口癖')
  assert.ok(card.persona.hard.forbiddenWords.length > 0, '样例卡该有禁用词')
  assert.ok(card.persona.soft.background.length > 20, '样例卡该有背景')
  assert.equal(card.draft, false, '样例卡不该还是草稿')
  assert.deepEqual(validateAgainstSpec(card).errors, [])
})

test('★ examples/lore.example.txt 与样例卡是**对得上**的（介绍里确实有那些约束的依据）', () => {
  const lorePath = join(import.meta.dirname, '..', 'examples', 'lore.example.txt')
  const cardPath = join(import.meta.dirname, '..', 'examples', 'card.example.json')
  const lore = readFileSync(lorePath, 'utf8')
  const card = JSON.parse(readFileSync(cardPath, 'utf8'))

  // 口癖与禁用词都必须能在介绍原文里找到 —— 否则这份样例就是在教人编设定
  for (const t of card.persona.hard.speechTics) {
    assert.ok(lore.includes(t), `口癖 ${JSON.stringify(t)} 在 lore.example.txt 里找不到`)
  }
  for (const w of card.persona.hard.forbiddenWords) {
    assert.ok(lore.includes(w), `禁用词 ${JSON.stringify(w)} 在 lore.example.txt 里找不到`)
  }
  assert.ok(lore.includes(Object.values(card.persona.hard.addresses)[0]), '称呼要在介绍里找得到')
})

test('examples/README.md 说清了样例是怎么来的（含"留空是正确行为"那句）', () => {
  const md = readFileSync(join(import.meta.dirname, '..', 'examples', 'README.md'), 'utf8')
  assert.match(md, /不是手写的|由真实的填表流程产出/)
  assert.match(md, /留空是正确行为/)
  assert.match(md, /game/)
})
