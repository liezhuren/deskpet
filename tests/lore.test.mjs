// tests/lore.test.mjs —— lore/ 抓取与提议
//
// 这一层有两个必须钉死的东西：
//   ★ 证据核验：模型提议的出处**必须真的在原文里**，找不到就拒 —— 这是防幻觉的硬机制
//   ★ 提议永不自动生效：applyProposals 只认布尔 true 的确认
// 抓取那半靠注入 fetch 离线测；真实网络连通性**未验证**（如实写在文件头）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchLore, htmlToText, decodeEntities, FETCH_DEFAULTS } from '../lore/fetch.mjs'
import {
  PROPOSABLE_FIELDS, proposeHeuristic, proposeWithLlm, verifyProposals, mergeProposals,
  applyProposals, describeProposal, buildProposalPrompt, parseProposals,
} from '../lore/propose.mjs'
import { draftCard } from '../app/cardgen.mjs'
import { normalizeCard, validateCard } from '../core/card.mjs'
import { actionsFor } from '../art/actions.mjs'

/** 一段像真介绍的文字（含明确标记，便于启发式抽到） */
const LORE = [
  '霞是主角的同班同学，坐在后排。',
  '她的口癖是「……才不是」，嘴上从不承认自己在关心别人。',
  '性格开朗，爱吐槽，但她说自己「不需要你操心」。',
  '她从不说「谢谢」，只会用行动表达。',
  '称呼主角为「你」，但心里其实另有叫法。',
].join('\n')

function fakeRes(body, { ok = true, status = 200, url = 'https://example.test/a' } = {}) {
  return { ok, status, url, text: async () => body }
}

// ══════════════════ A. HTML → 文本 ══════════════════

test('★ htmlToText：去脚本样式、块级转换行、解实体', () => {
  const html = `<!doctype html><html><head>
    <title>霞 - 角色介绍</title>
    <meta name="description" content="同班同学，嘴硬心软。">
    <style>.x{color:red}</style><script>var a=1;</script>
  </head><body>
    <nav>首页 攻略 角色</nav>
    <div><p>霞是主角的同班同学。</p><p>她的口癖是「&hellip;&hellip;才不是」。</p></div>
    <footer>&copy; 2024</footer>
  </body></html>`
  const r = htmlToText(html)
  assert.equal(r.title, '霞 - 角色介绍')
  assert.ok(!r.text.includes('var a=1'), '脚本要去掉')
  assert.ok(!r.text.includes('color:red'), '样式要去掉')
  assert.ok(r.text.includes('霞是主角的同班同学。'))
  assert.ok(r.text.includes('……才不是'), '实体要解回来')
  assert.ok(r.text.includes('同班同学，嘴硬心软。'), 'meta description 要作为补充带上')
  assert.ok(r.text.split('\n').length >= 3, '块级标签应当产生换行')
})

test('★ htmlToText：JS 渲染的空壳要能被识别（脚本占比高会给提示）', () => {
  const html = '<html><head><title>空壳</title></head><body><script>' + 'x'.repeat(5000) + '</script><div id="app"></div></body></html>'
  const r = htmlToText(html)
  assert.ok(r.notes.some((n) => n.includes('JS 渲染')), r.notes.join(' | '))
})

test('decodeEntities：命名 / 十进制 / 十六进制 / 未知保留', () => {
  assert.equal(decodeEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f')
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB')
  assert.equal(decodeEntities('&hellip;'), '…')
  assert.equal(decodeEntities('&unknown;'), '&unknown;')
  assert.equal(decodeEntities('&nbsp;'), ' ')
})

test('htmlToText 对空/脏输入不崩', () => {
  for (const bad of [null, undefined, '', 42, {}]) {
    assert.doesNotThrow(() => htmlToText(bad))
    assert.equal(typeof htmlToText(bad).text, 'string')
  }
})

// ══════════════════ B. fetchLore（注入 fetch，离线） ══════════════════

test('★ fetchLore：正常抓到正文', async () => {
  const r = await fetchLore('https://example.test/a', {
    fetchImpl: async () => fakeRes(`<html><head><title>T</title></head><body><p>${'角色介绍正文。'.repeat(30)}</p></body></html>`),
  })
  assert.equal(r.ok, true)
  assert.ok(r.chars >= FETCH_DEFAULTS.minUsefulChars)
  assert.match(r.text, /角色介绍正文/)
  assert.equal(r.title, 'T')
  assert.ok(r.bytes > 0)
})

test('★ fetchLore：正文太短时如实报告"多半是前端渲染的"，而不是拿碎片冒充介绍', async () => {
  const r = await fetchLore('https://example.test/a', { fetchImpl: async () => fakeRes('<html><body><div id="app"></div></body></html>') })
  assert.equal(r.ok, false)
  assert.ok(r.notes.some((n) => n.includes('前端渲染')), r.notes.join(' | '))
})

test('fetchLore：只接受 http/https，URL 空或协议不对时给可读错误', async () => {
  assert.equal((await fetchLore('')).error, 'URL 是空的')
  assert.equal((await fetchLore('file:///etc/passwd')).error, '只支持 http/https')
  assert.match((await fetchLore('ftp://x')).error, /http/)
})

test('★ fetchLore：HTTP 错误 / 超时 / 网络失败都变成可读错误，不抛', async () => {
  const e404 = await fetchLore('https://x.test/a', { fetchImpl: async () => fakeRes('nope', { ok: false, status: 404 }) })
  assert.equal(e404.ok, false)
  assert.match(e404.error, /404/)

  const eNet = await fetchLore('https://x.test/a', { fetchImpl: async () => { throw new Error('ECONNRESET') } })
  assert.equal(eNet.ok, false)
  assert.match(eNet.error, /ECONNRESET/)

  const eAbort = await fetchLore('https://x.test/a', { fetchImpl: async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e } })
  assert.equal(eAbort.ok, false)
  assert.match(eAbort.error, /超时/)
})

test('fetchLore：超过 maxBytes 会被截断并记一笔', async () => {
  const big = `<html><body><p>${'字'.repeat(5000)}</p></body></html>`
  const r = await fetchLore('https://x.test/a', { fetchImpl: async () => fakeRes(big), maxBytes: 500 })
  assert.ok(r.notes.some((n) => n.includes('超过上限')), r.notes.join(' | '))
})

test('fetchLore：没有 fetch 时给可读错误', async () => {
  const r = await fetchLore('https://x.test/a', { fetchImpl: null, ...{} })
  assert.equal(r.ok, false)
  assert.ok(r.error)
})

// ══════════════════ C. 启发式提议 ══════════════════

test('★ 启发式：从有明确标记的句子里抽出口癖 / 禁用词 / 称呼 / 气质 / 长度', () => {
  const { proposals } = proposeHeuristic({ lore: LORE, name: '霞' })
  const byField = (f) => proposals.filter((p) => p.field === f)
  assert.ok(byField('speechTics').some((p) => p.value === '……才不是'), JSON.stringify(proposals.map((p) => [p.field, p.value])))
  assert.ok(byField('forbiddenWords').some((p) => p.value === '谢谢'), '「从不说「谢谢」」应当被抽成禁用词')
  assert.ok(byField('addresses').some((p) => p.value?.player === '你'))
  assert.ok(byField('temperament').some((p) => p.value === 'lively'), '「性格开朗」应当推出活泼')
  assert.equal(byField('avgLength').length, 0, '没有长度标记就不该瞎提')
  for (const p of proposals) {
    assert.ok(PROPOSABLE_FIELDS.includes(p.field))
    assert.ok(p.evidence.length > 0, '每条提议都必须带出处')
    assert.ok(p.confidence > 0 && p.confidence <= 1)
  }
})

test('★ 启发式抽出来的每一条，证据都真的在原文里（自带可核对）', () => {
  const { proposals } = proposeHeuristic({ lore: LORE })
  const { accepted, rejected } = verifyProposals(proposals, LORE)
  assert.equal(rejected.length, 0, `启发式不该产出无法核对的证据：${JSON.stringify(rejected)}`)
  assert.equal(accepted.length, proposals.length)
})

test('启发式：没有明确标记时不硬提（宁可不提）', () => {
  const { proposals, notes } = proposeHeuristic({ lore: '她是一个普通的同学，喜欢在放学后散步，偶尔会去图书馆。' })
  assert.ok(!proposals.some((p) => p.confidence >= 0.7), '不该高置信度地硬提')
  assert.ok(notes.length > 0)
})

test('启发式：话少/话多的长度标记', () => {
  const a = proposeHeuristic({ lore: '她话很少，惜字如金。' })
  assert.ok(a.proposals.some((p) => p.field === 'avgLength' && p.value.max <= 20))
  const b = proposeHeuristic({ lore: '她话很多，一开口就滔滔不绝。' })
  assert.ok(b.proposals.some((p) => p.field === 'avgLength' && p.value.max >= 60))
})

test('启发式对空/脏输入不崩', () => {
  for (const bad of [undefined, null, {}, { lore: '' }, { lore: 42 }]) {
    assert.doesNotThrow(() => proposeHeuristic(bad))
    assert.ok(Array.isArray(proposeHeuristic(bad).proposals))
  }
})

// ══════════════════ D. ★ 证据核验（防幻觉的硬机制） ══════════════════

test('★ 出处能找到就收，找不到就拒', () => {
  const ok = { field: 'speechTics', value: '……才不是', evidence: '她的口癖是「……才不是」' }
  const fake = { field: 'speechTics', value: '本小姐', evidence: '她的口癖是「本小姐」' }
  const { accepted, rejected } = verifyProposals([ok, fake], LORE)
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].value, '……才不是')
  assert.equal(accepted[0].verified, true)
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason, /找不到/)
})

test('★ 出处太短也拒（一句"她"不能证明任何事）', () => {
  const { accepted, rejected } = verifyProposals([{ field: 'speechTics', value: 'x', evidence: '她' }], LORE)
  assert.equal(accepted.length, 0)
  assert.match(rejected[0].reason, /太短/)
})

test('证据核验容忍空白与标点差异（但不容忍编造）', () => {
  const p = { field: 'speechTics', value: '……才不是', evidence: '她的口癖是 ……才不是' }
  assert.equal(verifyProposals([p], LORE).accepted.length, 1)
})

test('未登记字段被拒', () => {
  const { rejected } = verifyProposals([{ field: '乱写的字段', value: 1, evidence: '霞是主角的同班同学' }], LORE)
  assert.match(rejected[0].reason, /未登记/)
})

test('verifyProposals 对脏输入不崩', () => {
  for (const bad of [null, undefined, [], [null], [{}], ['x']]) {
    assert.doesNotThrow(() => verifyProposals(bad, LORE))
  }
  assert.doesNotThrow(() => verifyProposals([{ field: 'speechTics', value: 'x', evidence: 'y' }], null))
})

// ══════════════════ E. LLM 提议（注入 provider，离线） ══════════════════

test('★ LLM 提议：合法的收下，编造出处的拒掉', async () => {
  const provider = {
    available: () => true,
    async generate() {
      return {
        text: JSON.stringify({
          proposals: [
            { field: 'speechTics', value: '……才不是', quote: '她的口癖是「……才不是」', confidence: 0.9 },
            { field: 'forbiddenWords', value: '请', quote: '她从来不说请字', confidence: 0.8 },
            { field: 'addresses', value: { player: '你' }, quote: '称呼主角为「你」', confidence: 0.7 },
          ],
        }),
      }
    },
  }
  const r = await proposeWithLlm({ lore: LORE, provider })
  assert.equal(r.proposals.length, 2, JSON.stringify(r.proposals))
  assert.equal(r.rejected.length, 1)
  assert.match(r.rejected[0].evidence, /请/)
  assert.ok(r.notes.some((n) => n.includes('防幻觉')))
})

test('★ LLM 提议：provider 不可用时如实说明，并指出还有启发式那条路', async () => {
  const r = await proposeWithLlm({ lore: LORE, provider: { available: () => false, generate: async () => ({ text: '' }) } })
  assert.equal(r.proposals.length, 0)
  assert.ok(r.notes.some((n) => n.includes('启发式')))
  // 连 generate 都没有 ⇒ 归到"没有可用的 provider"
  assert.match((await proposeWithLlm({ lore: LORE, provider: { available: () => false } })).notes[0], /没有可用的 provider/)
})

test('LLM 提议：调用失败 / 返回非 JSON / 空内容都给可读说明，不抛', async () => {
  const boom = { available: () => true, generate: async () => { throw new Error('网络炸了') } }
  const r1 = await proposeWithLlm({ lore: LORE, provider: boom })
  assert.match(r1.notes[0], /网络炸了/)

  const junk = { available: () => true, generate: async () => ({ text: '我不太确定，大概是这样吧' }) }
  const r2 = await proposeWithLlm({ lore: LORE, provider: junk })
  assert.match(r2.notes[0], /没有 JSON/)

  const empty = { available: () => true, generate: async () => ({ text: '' }) }
  assert.match((await proposeWithLlm({ lore: LORE, provider: empty })).notes[0], /空内容/)
})

test('parseProposals：能吃掉包在代码块里的 JSON；坏输入给可读错误', () => {
  const ok = parseProposals('```json\n{"proposals":[{"field":"temperament","value":"calm","quote":"冷静","confidence":0.5}]}\n```')
  assert.equal(ok.ok, true)
  assert.equal(ok.proposals[0].field, 'temperament')
  for (const bad of ['', 'x', '{oops}', '{"nope":1}', '[1,2]']) {
    assert.equal(parseProposals(bad).ok, false, JSON.stringify(bad))
  }
})

test('★ 提示词里明确要求"quote 必须逐字复制、拿不准就别提"', () => {
  const p = buildProposalPrompt(LORE, '霞')
  assert.match(p, /逐字复制/)
  assert.match(p, /拿不准就不要提/)
  assert.ok(p.includes('……才不是'), '原文要带进去')
  assert.match(p, /temperament 只能是 lively \/ calm \/ cool/)
})

// ══════════════════ F. ★ 提议永不自动生效 ══════════════════

test('★ applyProposals：只认布尔 true 的确认，其余一律不写', () => {
  const card = draftCard({ name: '霞', game: 'someday' }).card
  const props = [
    { key: 'a', field: 'speechTics', value: '……才不是', evidence: 'x', confidence: 0.9 },
    { key: 'b', field: 'forbiddenWords', value: '谢谢', evidence: 'x', confidence: 0.8 },
    { key: 'c', field: 'temperament', value: 'lively', evidence: 'x', confidence: 0.7 },
  ]
  const none = applyProposals(card, props, {})
  assert.equal(none.applied, 0)
  assert.equal(none.skipped, 3)
  assert.deepEqual(none.card.persona.hard.speechTics, [], '没确认就一个字都不该写进去')

  const some = applyProposals(card, props, { a: true, b: false })
  assert.equal(some.applied, 1)
  assert.deepEqual(some.card.persona.hard.speechTics, ['……才不是'])
  assert.deepEqual(some.card.persona.hard.forbiddenWords, [], '明确拒绝（false）也不写')
  assert.equal(some.card.animation.temperament, 'calm', '没确认的气质不写')

  const all = applyProposals(card, props, { a: true, b: true, c: true })
  assert.equal(all.applied, 3)
  assert.equal(all.card.animation.temperament, 'lively')
  assert.equal(all.card.draft, false, '确认过硬约束之后就不该再标"草稿"')
  assert.equal(validateCard(all.card).ok, true)
})

test('★ applyProposals：结果给出的卡确实改变需要的动作（气质生效）', () => {
  const card = draftCard({ name: '霞', game: 'g' }).card
  assert.equal(actionsFor(card).temperament, 'calm')
  const r = applyProposals(card, [{ key: 0, field: 'temperament', value: 'lively', evidence: '开朗', confidence: 0.7 }], { 0: true })
  assert.equal(actionsFor(r.card).temperament, 'lively')
  assert.ok(actionsFor(r.card).required.includes('greeting'))
})

test('applyProposals 去重：同一个口癖确认两次也只留一条', () => {
  const card = draftCard({ name: '霞', game: 'g' }).card
  const r = applyProposals(card, [
    { key: 0, field: 'speechTics', value: '……才不是', evidence: 'x' },
    { key: 1, field: 'speechTics', value: '……才不是', evidence: 'y' },
  ], { 0: true, 1: true })
  assert.deepEqual(r.card.persona.hard.speechTics, ['……才不是'])
})

test('applyProposals 不改入参，且对脏输入不崩', () => {
  const card = draftCard({ name: '霞', game: 'g' }).card
  const snap = JSON.stringify(card)
  applyProposals(card, [{ key: 0, field: 'speechTics', value: 'x', evidence: 'e' }], { 0: true })
  assert.equal(JSON.stringify(card), snap)
  for (const bad of [null, undefined, {}, 'x']) {
    assert.doesNotThrow(() => applyProposals(card, bad, bad))
  }
})

test('mergeProposals：同字段同值去重、保留更高置信度、按置信度降序', () => {
  const merged = mergeProposals(
    [{ field: 'speechTics', value: 'a', evidence: 'e1', confidence: 0.4 }],
    [{ field: 'speechTics', value: 'a', evidence: 'e2', confidence: 0.9 }, { field: 'temperament', value: 'cool', evidence: 'e3', confidence: 0.6 }],
  )
  assert.equal(merged.length, 2)
  assert.equal(merged[0].confidence, 0.9)
  assert.equal(merged[0].evidence, 'e2')
  assert.equal(merged[1].field, 'temperament')
  assert.deepEqual(mergeProposals(null, undefined), [])
})

test('describeProposal 给出人话，含置信度与出处', () => {
  const s = describeProposal({ field: 'speechTics', value: '……才不是', evidence: '她的口癖是「……才不是」', confidence: 0.85 })
  assert.match(s, /speechTics/)
  assert.match(s, /85%/)
  assert.match(s, /出处/)
})

// ══════════════════ G. 端到端：抓取 → 提议 → 确认 → 卡 ══════════════════

test('★ 端到端：抓一页 → 启发式提议 → 核对证据 → 用户确认 → 卡生效且能过校验', async () => {
  const html = `<html><head><title>霞</title></head><body>
    <p>${'霞是主角的同班同学。'.repeat(12)}</p>
    <p>${LORE.replace(/\n/g, '</p><p>')}</p>
  </body></html>`
  const fetched = await fetchLore('https://example.test/xia', { fetchImpl: async () => fakeRes(html) })
  assert.equal(fetched.ok, true, fetched.notes.join(' | '))

  const { proposals } = proposeHeuristic({ lore: fetched.text, name: '霞' })
  const { accepted, rejected } = verifyProposals(proposals, fetched.text)
  assert.equal(rejected.length, 0)
  assert.ok(accepted.length >= 3, JSON.stringify(accepted.map((p) => [p.field, p.value])))

  const card = draftCard({ name: '霞', game: 'someday' }).card
  const confirmed = Object.fromEntries(accepted.map((p, i) => [i, true]))
  const { card: filled, applied } = applyProposals(card, accepted, confirmed)
  assert.ok(applied >= 3)
  assert.equal(validateCard(filled).ok, true, JSON.stringify(validateCard(filled).errors))
  assert.ok(filled.persona.hard.speechTics.includes('……才不是'))
  assert.equal(filled.animation.temperament, 'lively')
  assert.ok(!filled.draft)
})

test('★ 端到端：模型编的出处会被拦在卡之外', async () => {
  const provider = {
    available: () => true,
    async generate() {
      return { text: JSON.stringify({ proposals: [
        { field: 'forbiddenWords', value: '谢谢', quote: '她从不说「谢谢」', confidence: 0.9 },  // 真出处
        { field: 'speechTics', value: '哼', quote: '她常常哼一声表示不满', confidence: 0.9 },      // 编的
      ] }) }
    },
  }
  const r = await proposeWithLlm({ lore: LORE, provider })
  const card = draftCard({ name: '霞', game: 'g' }).card
  const { card: filled, applied } = applyProposals(card, r.proposals, Object.fromEntries(r.proposals.map((_, i) => [i, true])))
  assert.equal(applied, 1, '只有证据成立的那条能进来')
  assert.ok(filled.persona.hard.forbiddenWords.includes('谢谢'))
  assert.ok(!filled.persona.hard.speechTics.includes('哼'), '编出来的口癖必须被挡住')
})
