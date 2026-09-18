// tests/wiki.test.mjs —— Wiki 管线：多页抓取 → 合并 → 喂给出表填表
//
// 这一层的风险不在"抓不到"，而在**抓太多**：多抓几页离爬虫只有一步。
// 所以测试的重点是那几条硬边界：
//   · 只走同域（跨站链接一个都不跟）
//   · 只走一层、页数封顶、总字节封顶
//   · 请求之间有间隔（sleep 被调用，且用的是配置值）
//   · 种子页拿不到正文就**不再往下抓**（那时链接也是空的，白跑）
// 以及诚实性：抓失败要如实说，不许拿别的页硬凑。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WIKI_DEFAULTS, extractLinks, pickSubpageLinks, fetchPage, fetchWiki, htmlToText,
} from '../lore/fetch.mjs'
import { fillCardFromWiki, fillForm } from '../lore/fill.mjs'
import { draftCard } from '../app/cardgen.mjs'

const LORE = [
  '霞是主角的同班同学，坐在教室最后一排。',
  '她的口癖是「……才不是」，嘴上从不承认自己在关心别人。',
  '性格开朗，爱吐槽，但她说自己「不需要你操心」。',
  '她从不说「谢谢」，只会用行动表达。',
  '称呼主角为「你」，但心里其实另有叫法。',
].join('')

/** 一个假的 wiki 站点：种子页 + 若干子页 + 一个跨站链接。 */
function makeSite(pages) {
  const hits = []
  const fetchImpl = async (url) => {
    hits.push(url)
    const body = pages[url]
    if (body === undefined) return { ok: false, status: 404, url, text: async () => 'not found' }
    return { ok: true, status: 200, url, text: async () => body }
  }
  return { fetchImpl, hits }
}

/** 造一个够长的正文（fetchLore 的 minUsefulChars 是 120）。 */
const filler = '她喜欢在放学后一个人待在教室。'.repeat(10)

const SEED = 'https://wiki.test/xia'
const VOICE = 'https://wiki.test/xia/voice'
const PROFILE = 'https://wiki.test/xia/profile'
const OTHER = 'https://wiki.test/other-character'
const OFFSITE = 'https://ads.example.com/cheap'

const seedHtml = `<html><head><title>霞 - 角色介绍</title></head><body>
<p>${filler}</p>
<p>她的口癖是「……才不是」。</p>
<p>性格开朗，爱吐槽。</p>
<p>她从不说「谢谢」。</p>
<p>称呼主角为「你」。</p>
<nav>
<a href="/xia/voice">霞 语音</a>
<a href="/xia/profile">霞 档案</a>
<a href="/other-character">另一个角色</a>
<a href="${OFFSITE}">广告</a>
<a href="#top">回到顶部</a>
<a href="javascript:void(0)">展开</a>
</nav></body></html>`

const voiceHtml = `<html><head><title>霞 语音</title></head><body><p>「……才不是」${filler}</p></body></html>`
const profileHtml = `<html><head><title>霞 档案</title></head><body><p>同班同学，坐后排。${filler}</p></body></html>`

// ══════════════════ A. 链接抽取 ══════════════════

test('★ extractLinks：绝对化、去重、标出是否同域、跳过特殊协议', () => {
  const links = extractLinks(seedHtml, SEED)
  const hrefs = links.map((l) => l.href)
  assert.ok(hrefs.includes(VOICE), '相对链接要绝对化')
  assert.ok(hrefs.includes(PROFILE))
  assert.ok(hrefs.includes(OFFSITE), '跨站链接也要抽出来（由上层决定跟不跟）')
  assert.ok(!hrefs.some((h) => h.includes('#top')), '锚点要丢掉')
  assert.ok(!hrefs.some((h) => h.startsWith('javascript:')), 'javascript: 要丢掉')
  const off = links.find((l) => l.href === OFFSITE)
  assert.equal(off.sameHost, false)
  assert.equal(links.find((l) => l.href === VOICE).sameHost, true)
  assert.equal(new Set(hrefs).size, hrefs.length, '要去重')
})

test('extractLinks 对脏输入不崩', () => {
  for (const bad of [null, undefined, '', 'not html', 42, {}]) {
    assert.doesNotThrow(() => extractLinks(bad, SEED))
    assert.deepEqual(extractLinks(bad, SEED), [])
  }
  assert.deepEqual(extractLinks('<a href="/x">y</a>', '不是 URL'), [])
})

// ══════════════════ B. 子页挑选 ══════════════════

test('★ pickSubpageLinks：只选同域，跨站一个都不跟', () => {
  const picks = pickSubpageLinks(extractLinks(seedHtml, SEED), { seedUrl: SEED, name: '霞' })
  const hrefs = picks.map((p) => p.href)
  assert.ok(hrefs.includes(VOICE))
  assert.ok(hrefs.includes(PROFILE))
  assert.ok(!hrefs.includes(OFFSITE), '★ 跨站链接绝不能被选中')
  assert.ok(!hrefs.includes(SEED), '种子页自身要排除')
})

test('★ pickSubpageLinks：锚文本含角色名的排在前面', () => {
  const links = [
    { href: 'https://wiki.test/a', text: '语音', sameHost: true },
    { href: 'https://wiki.test/b', text: '霞 语音', sameHost: true },
  ]
  const picks = pickSubpageLinks(links, { seedUrl: SEED, name: '霞' })
  assert.equal(picks[0].href, 'https://wiki.test/b', '含角色名的该优先')
  assert.ok(picks[0].score > picks[1].score)
})

test('★ pickSubpageLinks：没有相关链接时返回空（而不是随便抓）', () => {
  const links = [
    { href: 'https://wiki.test/zasu', text: '完全无关', sameHost: true },
    { href: 'https://wiki.test/other', text: '另一个词条', sameHost: true },
  ]
  assert.deepEqual(pickSubpageLinks(links, { seedUrl: SEED, name: '霞' }), [])
  assert.deepEqual(pickSubpageLinks([], { seedUrl: SEED }), [])
  assert.deepEqual(pickSubpageLinks(null, { seedUrl: SEED }), [])
})

test('pickSubpageLinks 受 max 限制', () => {
  const links = Array.from({ length: 10 }, (_, i) => ({ href: `https://wiki.test/xia/${i}`, text: `霞 ${i}`, sameHost: true }))
  assert.equal(pickSubpageLinks(links, { seedUrl: SEED, name: '霞', max: 3 }).length, 3)
})

// ══════════════════ C. fetchPage ══════════════════

test('★ fetchPage 返回原始 HTML（wiki 管线靠它抽链接）', async () => {
  const site = makeSite({ [SEED]: seedHtml })
  const r = await fetchPage(SEED, { fetchImpl: site.fetchImpl })
  assert.equal(r.ok, true)
  assert.ok(r.html.includes('<a href="/xia/voice">'), '要拿到原始 HTML')
  assert.equal(r.title, '霞 - 角色介绍')
  assert.ok(!r.html.includes('<script'), '……过滤后的 HTML 也已去掉脚本')
})

// ══════════════════ D. fetchWiki ══════════════════

test('★ fetchWiki：种子页 + 同域子页，跨站不跟，请求次数可控', async () => {
  const site = makeSite({ [SEED]: seedHtml, [VOICE]: voiceHtml, [PROFILE]: profileHtml })
  const slept = []
  const r = await fetchWiki(SEED, {
    fetchImpl: site.fetchImpl,
    sleepImpl: async (ms) => { slept.push(ms) },
    name: '霞',
    delayMs: 250,
  })
  assert.equal(r.ok, true)
  assert.equal(site.hits.length, 3, `该抓 3 页（种子+2 子页），实际 ${site.hits.length}：${site.hits.join(', ')}`)
  assert.ok(!site.hits.includes(OFFSITE), '★ 绝不能抓跨站链接')
  assert.equal(slept.length, 2, '两次子页请求之间要各等一次')
  assert.deepEqual([...new Set(slept)], [250], '等待时间要用配置值')
  assert.match(r.text, /她的口癖是/)
  assert.match(r.text, /【补充资料：霞 语音】/, '子页要带来源标注')
  assert.match(r.text, /【补充资料：霞 档案】/)
  assert.equal(r.pages.length, 3)
  assert.equal(r.pages[0].role, 'seed')
  assert.ok(r.notes.some((n) => n.includes('合并 3 页')), r.notes.join(' | '))
})

test('★ fetchWiki：maxPages 封顶（不许变成爬虫）', async () => {
  const site = makeSite({ [SEED]: seedHtml, [VOICE]: voiceHtml, [PROFILE]: profileHtml })
  const r = await fetchWiki(SEED, { fetchImpl: site.fetchImpl, sleepImpl: async () => {}, name: '霞', maxPages: 2, delayMs: 0 })
  assert.equal(site.hits.length, 2, 'maxPages=2 ⇒ 只该请求 2 次')
  assert.equal(r.pages.filter((p) => p.ok).length, 2)
})

test('★ fetchWiki：delayMs=0 时不等待（测试与离线场景）', async () => {
  const site = makeSite({ [SEED]: seedHtml, [VOICE]: voiceHtml })
  let slept = 0
  await fetchWiki(SEED, { fetchImpl: site.fetchImpl, sleepImpl: async () => { slept++ }, name: '霞', delayMs: 0, maxPages: 2 })
  assert.equal(slept, 0)
})

test('★ fetchWiki：种子页抓不到正文 ⇒ 不再往下抓（那时链接也是空的，白跑）', async () => {
  const site = makeSite({ [SEED]: '<html><body><div id="app"></div></body></html>' })
  const r = await fetchWiki(SEED, { fetchImpl: site.fetchImpl, sleepImpl: async () => {}, name: '霞' })
  assert.equal(r.ok, false)
  assert.equal(site.hits.length, 1, '★ 种子页失败后不该再请求')
  assert.equal(r.chars, 0)
  assert.ok(r.pages.length === 1)
  assert.ok(r.notes.some((n) => n.includes('前端渲染')), r.notes.join(' | '))
})

test('★ fetchWiki：某个子页失败 ⇒ 如实记下，种子页正文照用', async () => {
  const site = makeSite({ [SEED]: seedHtml, [VOICE]: voiceHtml })   // PROFILE 会 404
  const r = await fetchWiki(SEED, { fetchImpl: site.fetchImpl, sleepImpl: async () => {}, name: '霞' })
  assert.equal(r.ok, true)
  assert.ok(r.notes.some((n) => n.includes('子页未取到正文')), r.notes.join(' | '))
  assert.ok(r.pages.some((p) => p.ok === false && p.role === 'subpage'))
  assert.match(r.text, /她的口癖是/)
  assert.equal(r.pages.filter((p) => p.ok).length, 2)
})

test('★ fetchWiki：总字节封顶', async () => {
  const huge = `<html><body><p>${'字'.repeat(50000)}</p><a href="/xia/voice">霞 语音</a></body></html>`
  const site = makeSite({ [SEED]: huge, [VOICE]: voiceHtml, [PROFILE]: profileHtml })
  const r = await fetchWiki(SEED, {
    fetchImpl: site.fetchImpl, sleepImpl: async () => {}, name: '霞',
    maxTotalBytes: 1000, maxBytes: 200000,
  })
  assert.equal(site.hits.length, 1, '种子页已超总上限 ⇒ 不该再抓子页')
  assert.ok(r.notes.some((n) => n.includes('总字节上限')), r.notes.join(' | '))
})

test('★ fetchWiki：页面上有关系链接但都不像子页 ⇒ 明说，只用手上的正文', async () => {
  const html = `<html><body><p>${filler}</p><a href="/a">甲</a><a href="/b">乙</a></body></html>`
  const site = makeSite({ [SEED]: html })
  const r = await fetchWiki(SEED, { fetchImpl: site.fetchImpl, sleepImpl: async () => {}, name: '霞' })
  assert.equal(r.ok, true)
  assert.equal(site.hits.length, 1)
  assert.ok(r.notes.some((n) => n.includes('没有一个像是这个角色的子页')), r.notes.join(' | '))
})

test('fetchWiki：坏 URL / 没有 fetch ⇒ 可读错误，不抛', async () => {
  for (const bad of ['', 'file:///x', 'ftp://x', null, undefined]) {
    const r = await fetchWiki(bad, { fetchImpl: async () => { throw new Error('不该被调用') } })
    assert.equal(r.ok, false)
    assert.ok(r.error)
  }
  const noFetch = await fetchWiki(SEED, { fetchImpl: null })
  assert.equal(noFetch.ok, false)
  assert.match(noFetch.error, /没有可用的 fetch|请求失败/)
})

test('fetchWiki 对脏 opts 不崩', async () => {
  const site = makeSite({ [SEED]: seedHtml })
  for (const bad of [null, undefined, 0, 'x', []]) {
    assert.doesNotThrow(() => fetchWiki(SEED, bad))
    const r = await fetchWiki(SEED, { ...(bad && typeof bad === 'object' ? bad : {}), fetchImpl: site.fetchImpl, sleepImpl: async () => {} })
    assert.equal(typeof r.ok, 'boolean')
  }
})

test('WIKI_DEFAULTS 的边界是收紧的（不是"随便抓"）', () => {
  assert.ok(WIKI_DEFAULTS.maxPages <= 6, '页数上限该收紧')
  assert.ok(WIKI_DEFAULTS.maxTotalBytes <= 4 * 1024 * 1024)
  assert.ok(WIKI_DEFAULTS.delayMs >= 100, '请求之间该有间隔')
  assert.ok(WIKI_DEFAULTS.subpageWords.length >= 8)
})

// ══════════════════ E. 端到端：Wiki → 角色卡 ══════════════════

test('★ fillCardFromWiki：抓 Wiki → 出表 → 填 → 拿到可确认的提议', async () => {
  const site = makeSite({ [SEED]: seedHtml, [VOICE]: voiceHtml, [PROFILE]: profileHtml })
  const base = draftCard({ name: '霞', game: 'someday' }).card
  const r = await fillCardFromWiki({
    url: SEED, card: base, name: '霞',
    fetchImpl: site.fetchImpl, sleepImpl: async () => {}, forceHeuristic: true,
    wiki: { delayMs: 0 },
  })
  assert.equal(r.source, 'heuristic')
  assert.ok(r.wiki.ok)
  assert.equal(r.wiki.pages.filter((p) => p.ok).length, 3)
  assert.deepEqual(Object.keys(r.form.slots).length > 0, true, '表要出得来')
  const byPath = Object.fromEntries(r.proposals.map((p) => [p.path, p.value]))
  assert.deepEqual(byPath['persona.hard.speechTics'], ['……才不是'], JSON.stringify(byPath))
  assert.deepEqual(byPath['persona.hard.forbiddenWords'], ['谢谢'])
  assert.equal(byPath['animation.temperament'], 'lively', '「性格开朗」该推出活泼')
  assert.ok(r.notes.some((n) => n.includes('合并 3 页')), r.notes.join(' | '))
})

test('★ fillCardFromWiki：抓不到就**不硬凑** —— 如实说，且不出提议', async () => {
  const site = makeSite({ [SEED]: '<html><body><div id="app"></div></body></html>' })
  const r = await fillCardFromWiki({ url: SEED, name: '霞', fetchImpl: site.fetchImpl, sleepImpl: async () => {}, forceHeuristic: true })
  assert.equal(r.source, 'none')
  assert.deepEqual(r.proposals, [])
  assert.equal(r.wiki.ok, false)
  assert.ok(r.notes.some((n) => n.includes('没拿到正文')), r.notes.join(' | '))
  assert.ok(r.form && Object.keys(r.form.slots).length > 0, '表本身还是要给出来（用户可以手填）')
})

test('★ 子页贡献的证据也能过核验（合并文本里确实有那句原文）', async () => {
  // 口癖只在子页（语音页）里出现，种子页没有
  const seedNoTic = `<html><body><p>${filler}</p><a href="/xia/voice">霞 语音</a></body></html>`
  const site = makeSite({ [SEED]: seedNoTic, [VOICE]: voiceHtml })
  const r = await fillCardFromWiki({
    url: SEED, card: draftCard({ name: '霞', game: 'g' }).card, name: '霞',
    fetchImpl: site.fetchImpl, sleepImpl: async () => {}, forceHeuristic: true, wiki: { delayMs: 0 },
  })
  const tics = r.proposals.find((p) => p.path === 'persona.hard.speechTics')
  assert.ok(tics, '子页里的口癖该被抽到')
  // 证据必须能在**合并后的文本**里找到（因为核验就是对着它做的）
  assert.ok(r.wiki.text.includes(tics.evidence), '证据要能在合并文本里逐字找到')
})

test('fillCardFromWiki 对脏输入不崩', async () => {
  for (const bad of [null, undefined, 0, 'x', {}, { url: null }]) {
    assert.doesNotThrow(() => fillCardFromWiki(bad))
    const r = await fillCardFromWiki(bad)
    assert.equal(r.source, 'none')
    assert.deepEqual(r.proposals, [])
  }
})

test('fillForm 在 wiki 失败时仍可用作"空表"（不返回 undefined）', async () => {
  const r = await fillCardFromWiki({ url: '' })
  assert.deepEqual(Object.keys(r.form).sort(), Object.keys(fillForm()).sort())
})
