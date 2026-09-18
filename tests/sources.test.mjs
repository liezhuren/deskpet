// tests/sources.test.mjs —— ★ 三级信源管线：官方 → 社区 Wiki → 搜索
//
// 这条管线要证明的不是"能抓到东西"，而是**"依次"真的成立**：
//   ① 按优先级取用：官方有料就不去问社区与搜索
//   ② 够用即停：累计到阈值就不再打扰下一级（并如实报告停在哪一级）
//   ③ 逐条可追溯：每条填进卡里的约束都能反查出它出自哪一级
//   ④ 高级优先：同一个事实在官方与论坛都出现时，算**官方**
//
// 全程注入 fetch ⇒ 离线可跑。真实端点（DuckDuckGo / 各社区 wiki 的 opensearch）
// **未验证**，这一点写在 lore/sources.mjs 的文件头里，不在测试里假装成立。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SOURCE_TIERS, TIER_IDS, tierLabel, tierById, classifySource, COMMUNITY_WIKI_HOSTS,
  mediawikiSearchUrl, parseOpenSearch, buildSearchUrl, parseSearchResults, isSearchEngineHost,
  buildSearchQuery, DEFAULT_SEARCH_TEMPLATE, describeTiers,
} from '../lore/sources.mjs'
import {
  GATHER_DEFAULTS, gatherLore, renderTieredText, locateTier, splitTierBlocks, describeGather, urlKey,
} from '../lore/gather.mjs'
import { fillCardFromSources, fillCardFromWiki, fillForm } from '../lore/fill.mjs'
import { draftCard } from '../app/cardgen.mjs'

// ---------- 假站点 ----------

const FILLER = '她喜欢在放学后一个人待在教室。她成绩不错但从不承认自己在用功。'.repeat(14)

const OFFICIAL = 'https://official.test/xia'
const OFFICIAL_EMPTY = 'https://official.test/empty'
const FANDOM = 'https://xia.fandom.com'
const FANDOM_API = `${FANDOM}/api.php`
const FANDOM_PAGE = `${FANDOM}/wiki/%E9%9C%9E`
const OTHER_WIKI = 'https://wiki.gg'
const OTHER_WIKI_API = `${OTHER_WIKI}/api.php`
const OTHER_PAGE = `${OTHER_WIKI}/xia`
const BLOG = 'https://blog.test/xia-review'
const FORUM = 'https://forum.test/topic/123'

function page(title, body) { return `<html><head><title>${title}</title></head><body><p>${FILLER}</p>${body}</body></html>` }

const PAGES = {
  [OFFICIAL]: page('霞 - 官方角色页', '<p>她的口癖是「……才不是」。</p>'),
  [FANDOM_PAGE]: page('霞 | 霞 Wiki', '<p>她从不说「谢谢」。</p>'),
  [OTHER_PAGE]: page('霞 - 其他 Wiki', '<p>她讨厌被人说教。</p>'),
  [BLOG]: page('霞 角色攻略', '<p>称呼主角为「你」。</p>'),
  [FORUM]: page('霞 讨论帖', '<p>性格开朗。</p>'),
}

/** 默认假站点：官方 + 两个社区 wiki + 搜索引擎。 */
function makeSite(over = {}) {
  const hits = []
  const pages = { ...PAGES, ...(over.pages ?? {}) }
  const wikiHits = over.wikiHits ?? {
    [FANDOM_API]: JSON.stringify(['霞', ['霞'], [''], [FANDOM_PAGE]]),
    [OTHER_WIKI_API]: JSON.stringify(['霞', ['霞'], [''], [OTHER_PAGE]]),
  }
  const searchHtml = ('searchHtml' in over) ? over.searchHtml : `<html><body>
    <a href="${FANDOM_PAGE}">霞 - 霞 Wiki</a>
    <a href="${BLOG}">霞 角色攻略</a>
    <a href="${FORUM}">霞 讨论帖</a>
    <a href="https://html.duckduckgo.com/about">关于我们</a>
  </body></html>`
  const fetchImpl = async (url) => {
    hits.push(url)
    // ⚠ 社区 wiki 的检索 URL 带 query 参数，**不能按完整 URL 精确匹配** ——
    //   第一版就是这么写的，于是 `url in wikiHits` 永远为 false、全部 404，
    //   12 条测试一起挂。按前缀匹配。
    const wikiKey = Object.keys(wikiHits).find((k) => url.startsWith(k))
    if (wikiKey !== undefined) {
      const v = wikiHits[wikiKey]
      if (v === null) return { ok: false, status: 500, url, text: async () => 'boom' }
      return { ok: true, status: 200, url, text: async () => v }
    }
    if (url.includes('duckduckgo') || url.includes('search.test')) {
      if (searchHtml === null) return { ok: false, status: 429, url, text: async () => 'rate limited' }
      return { ok: true, status: 200, url, text: async () => searchHtml }
    }
    const body = pages[url]
    if (body === undefined) return { ok: false, status: 404, url, text: async () => 'not found' }
    return { ok: true, status: 200, url, text: async () => body }
  }
  return { fetchImpl, hits, pages, wikiHits, searchHtml }
}

const noSleep = async () => {}
const base = { name: '霞', game: 'someday', sleepImpl: noSleep, delayMs: 0 }
const hitSearch = (hits) => hits.some((u) => u.includes('duckduckgo') || u.includes('search.test'))
// ⚠ 别用 endsWith('/api.php') —— 检索 URL **带 query 参数**，那样永远匹配不上
//   （第一版就是这个错，导致"该去问社区 Wiki"整批假失败）
const hitWiki = (hits) => hits.some((u) => u.includes('/api.php'))
/** 一个永远失败的 fetch：用来测"三级都拿不到"这类路径。 */
const deadFetch = async (url) => ({ ok: false, status: 503, url, text: async () => '' })

// ══════════════════ A. 三级定义 ══════════════════

test('★ 三级信源的顺序就是优先级：官方 → 社区 Wiki → 搜索', () => {
  assert.deepEqual([...TIER_IDS], ['official', 'community', 'search'])
  for (const t of SOURCE_TIERS) {
    assert.ok(t.label.length > 0, `${t.id} 缺中文名`)
    assert.ok(t.note.length > 6, `${t.id} 缺说明`)
    assert.ok(['user', 'mediawiki-search', 'web-search'].includes(t.discovered))
  }
  assert.equal(tierLabel('official'), '官方')
  assert.equal(tierLabel('community'), '社区 Wiki')
  assert.equal(tierLabel('search'), '搜索')
  assert.equal(tierById('nope'), null)
  assert.ok(Object.isFrozen(SOURCE_TIERS))
  assert.match(describeTiers(), /①|官方/)
})

// ══════════════════ B. 归类：不猜 ══════════════════

test('★ classifySource：认得出社区 Wiki 与已知厂商域名，**认不出就 unknown（不猜）**', () => {
  assert.equal(classifySource(FANDOM_PAGE).tier, 'community')
  assert.equal(classifySource('https://wiki.gg/x').tier, 'community')
  assert.equal(classifySource('https://zh.moegirl.org.cn/霞').tier, 'community')
  assert.equal(classifySource('https://www.nintendo.com/games/x').tier, 'official')
  assert.equal(classifySource('https://store.steampowered.com/app/1').tier, 'official')
  // ★ 关键：认不出的一律 unknown，绝不"看起来像官方"就当官方
  assert.equal(classifySource('https://official.test/xia').tier, 'unknown')
  assert.equal(classifySource(BLOG).tier, 'unknown')
  assert.equal(classifySource('不是 URL').tier, 'unknown')
  assert.equal(classifySource('').tier, 'unknown')
})

test('★ 用户按游戏配置的官方域名优先于启发式（官方域名不靠猜，靠配）', () => {
  const r = classifySource(BLOG, { officialHosts: ['blog.test'] })
  assert.equal(r.tier, 'official')
  assert.match(r.why, /用户配置/)
  // 配上之后子域也算
  assert.equal(classifySource('https://m.blog.test/x', { officialHosts: ['blog.test'] }).tier, 'official')
  assert.equal(classifySource('https://notblog.test/x', { officialHosts: ['blog.test'] }).tier, 'unknown')
})

test('COMMUNITY_WIKI_HOSTS 覆盖常见的社区 wiki 站', () => {
  for (const h of ['fandom.com', 'wiki.gg', 'huijiwiki.com', 'moegirl.org.cn']) {
    assert.ok(COMMUNITY_WIKI_HOSTS.includes(h), `缺 ${h}`)
  }
})

// ══════════════════ C. 检索与搜索构造 ══════════════════

test('★ MediaWiki opensearch：按标准构造，能解析返回', () => {
  const u = mediawikiSearchUrl('https://x.fandom.com', '霞', { limit: 3 })
  assert.match(u, /\/api\.php\?action=opensearch&format=json&limit=3&search=/)
  assert.ok(u.includes(encodeURIComponent('霞')))
  // 已经给了 api.php 就不重复拼
  assert.match(mediawikiSearchUrl('https://x.fandom.com/api.php', 'a'), /api\.php\?action=opensearch/)
  assert.equal(mediawikiSearchUrl('', 'a'), null)
  assert.equal(mediawikiSearchUrl(null, 'a'), null)

  const parsed = parseOpenSearch('["霞",["霞","霞(游戏)"],["",""],["https://x/wiki/霞","https://x/wiki/霞(游戏)"]]')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].title, '霞')
  assert.equal(parsed[1].url, 'https://x/wiki/霞(游戏)')
  assert.deepEqual(parseOpenSearch('坏数据'), [])
  assert.deepEqual(parseOpenSearch(null), [])
  assert.deepEqual(parseOpenSearch('{"query":[1,[],[]]}'), [])
})

test('★ 搜索 URL 与查询：角色名与游戏名都加引号（不然常见名字会搜串）', () => {
  const q = buildSearchQuery({ name: '霞', game: 'someday' })
  assert.equal(q, '"霞" "someday" 角色 介绍')
  const u = buildSearchUrl(q)
  assert.ok(u.startsWith('https://html.duckduckgo.com/html/?q='))
  assert.ok(u.includes(encodeURIComponent('"霞"')))
  // 可换端点
  assert.equal(buildSearchUrl('a b', { template: 'https://s.test/?q={q}' }), 'https://s.test/?q=a%20b')
  assert.equal(buildSearchUrl('a', { template: '没有占位符' }), null)
  assert.equal(buildSearchUrl(''), null)
  assert.ok(DEFAULT_SEARCH_TEMPLATE.includes('{q}'))
})

test('★ 搜索结果解析：只挑像角色资料的，且**同域最多两条**', () => {
  const html = `<html><body>
    <a href="https://a.test/xia">霞 角色介绍</a>
    <a href="https://a.test/xia2">霞 攻略</a>
    <a href="https://a.test/xia3">霞 讨论</a>
    <a href="https://b.test/other">完全无关的东西</a>
    <a href="https://xia.fandom.com/wiki/%E9%9C%9E">霞 - 霞 Wiki</a>
    <a href="https://html.duckduckgo.com/help">帮助</a>
  </body></html>`
  const picks = parseSearchResults(html, 'https://html.duckduckgo.com/html/?q=x', { name: '霞', game: 'someday', max: 6 })
  assert.ok(picks.length >= 2)
  assert.ok(!picks.some((p) => p.url.includes('duckduckgo.com/help')), '★ 搜索引擎自己的导航页要排掉')
  assert.ok(!picks.some((p) => p.url.includes('b.test/other')), '无关结果要排掉')
  const perHost = {}
  for (const p of picks) perHost[p.host] = (perHost[p.host] ?? 0) + 1
  for (const [h, n] of Object.entries(perHost)) assert.ok(n <= 2, `${h} 占了 ${n} 条（同域最多 2 条）`)
  assert.ok(picks[0].score >= picks[picks.length - 1].score, '要按分数降序')
})

test('★ 搜索结果解析认 DuckDuckGo 的跳转链接（uddg=）', () => {
  const html = `<body><a href="/l/?uddg=${encodeURIComponent('https://xia.fandom.com/wiki/%E9%9C%9E')}&rut=abc">霞 Wiki</a></body>`
  const picks = parseSearchResults(html, 'https://html.duckduckgo.com/html/?q=x', { name: '霞', max: 5 })
  assert.equal(picks.length, 1)
  assert.equal(picks[0].url, 'https://xia.fandom.com/wiki/%E9%9C%9E')
})

test('搜索结果解析对脏输入不崩', () => {
  for (const bad of [null, undefined, '', 42, {}, '<a href="">x</a>']) {
    assert.doesNotThrow(() => parseSearchResults(bad, 'https://x.test', { name: '霞' }))
  }
  assert.equal(isSearchEngineHost('html.duckduckgo.com'), true)
  assert.equal(isSearchEngineHost('www.bing.com'), true)
  assert.equal(isSearchEngineHost('xia.fandom.com'), false)
})

// ══════════════════ D. ★ 依次取用与够用即停 ══════════════════

test('★★ 官方给足了 ⇒ **不再问社区与搜索**（这才是"依次"）', async () => {
  const site = makeSite()
  const r = await gatherLore({
    ...base, officialUrls: [OFFICIAL], communityBases: [FANDOM, OTHER_WIKI],
    fetchImpl: site.fetchImpl, limits: { enoughChars: 300 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.stoppedAt, 'official', `该在官方这一级就停手，实际停在 ${r.stoppedAt}`)
  assert.ok(!hitWiki(site.hits), '★ 不该去问社区 Wiki')
  assert.ok(!hitSearch(site.hits), '★ 不该去问搜索引擎')
  assert.equal(site.hits.length, 1, `只该请求 1 次，实际 ${site.hits.length}`)
  assert.ok(r.notes.some((n) => n.includes('没有再去问下一级')), r.notes.join(' | '))
  assert.deepEqual([...new Set(r.sources.map((s) => s.tier))], ['official'])
})

test('★ 官方不够 ⇒ 落到社区 Wiki；社区够用 ⇒ **不再去搜索**', async () => {
  const site = makeSite({
    pages: { [OFFICIAL]: page('霞 - 官方角色页', '<p>只有一句话。</p>') },   // 太短
  })
  const r = await gatherLore({
    ...base, officialUrls: [OFFICIAL], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, limits: { enoughChars: 500 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.stoppedAt, 'community')
  assert.ok(hitWiki(site.hits), '该去问社区 Wiki')
  assert.ok(!hitSearch(site.hits), '★ 社区够用了就不该再问搜索引擎')
  // 短的那页也不该被丢掉 —— "不够"是"继续找"，不是"不要"
  assert.ok(r.sources.some((s) => s.tier === 'official' && s.chars > 0))
})

test('★ 官方与社区都不够 ⇒ 才用搜索引擎兜底', async () => {
  const site = makeSite()
  const r = await gatherLore({
    ...base, officialUrls: [], communityBases: [],
    fetchImpl: site.fetchImpl, limits: { enoughChars: 100 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.stoppedAt, 'search')
  assert.ok(hitSearch(site.hits))
  assert.deepEqual([...new Set(r.sources.map((s) => s.tier))], ['search'])
  assert.ok(r.notes.some((n) => n.includes('没给官方页面')), '要如实说明官方这一级为什么没跑')
  assert.ok(r.notes.some((n) => n.includes('没配站点')), '也要说明社区这一级为什么没跑')
})

test('★ 三级都试过但仍不够 ⇒ 如实说"没有哪一级让累计达到够用"', async () => {
  const site = makeSite({
    pages: {
      [OFFICIAL]: page('官方', '<p>一句话。</p>'),
      [BLOG]: page('博客', '<p>一句话。</p>'),
      [FORUM]: page('论坛', '<p>一句话。</p>'),
    },
    wikiHits: { [FANDOM_API]: JSON.stringify(['霞', ['霞'], [''], [FANDOM_PAGE]]) },
    searchHtml: `<body><a href="${BLOG}">霞 攻略</a><a href="${FORUM}">霞 讨论</a></body>`,
  })
  const r = await gatherLore({
    ...base, officialUrls: [OFFICIAL], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, limits: { enoughChars: 99999 },
  })
  assert.equal(r.ok, true)
  assert.equal(r.stoppedAt, null, '都没达到阈值 ⇒ 不停手')
  assert.ok(r.notes.some((n) => n.includes('三级都试过了')), r.notes.join(' | '))
})

test('★ 跨级去重：搜索结果里出现已经抓过的页面 ⇒ 不重复抓、不算两次字数', async () => {
  const site = makeSite({
    // 搜索只返回社区那一级已经抓过的那个页面
    searchHtml: `<body><a href="${FANDOM_PAGE}">霞 - 霞 Wiki</a></body>`,
    wikiHits: { [FANDOM_API]: JSON.stringify(['霞', ['霞'], [''], [FANDOM_PAGE]]) },
  })
  const r = await gatherLore({
    ...base, officialUrls: [], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, limits: { enoughChars: 99999, maxTotalBytes: 10 * 1024 * 1024 },
  })
  const fandomHits = site.hits.filter((u) => u === FANDOM_PAGE)
  assert.equal(fandomHits.length, 1, `同一个页面该只抓一次，实际 ${fandomHits.length} 次`)
  assert.equal(r.sources.filter((s) => s.url === FANDOM_PAGE).length, 1, '合并文本里也不该出现两遍')
  assert.ok(r.notes.some((n) => n.includes('已经取过')), r.notes.join(' | '))
})

test('★ onlyTiers 可以只用某几级（但仍按优先级顺序）', async () => {
  const site = makeSite()
  const r = await gatherLore({
    ...base, officialUrls: [OFFICIAL], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, onlyTiers: ['community', 'official'], limits: { enoughChars: 99999 },
  })
  assert.ok(hitWiki(site.hits))
  assert.ok(!hitSearch(site.hits), '没选 search 就不该用')
  // 顺序仍按 TIER_IDS（官方在社区之前），不是按传入顺序
  const tiersRun = r.tiers.map((t) => t.id)
  assert.deepEqual(tiersRun, ['official', 'community'])
})

test('★ 每一级失败都如实记下来，不静默少抓', async () => {
  const site = makeSite({
    wikiHits: { [FANDOM_API]: null },           // 社区 wiki 返回 500
    searchHtml: null,                            // 搜索被限流
  })
  const r = await gatherLore({
    ...base, officialUrls: [OFFICIAL], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, limits: { enoughChars: 99999 },
  })
  assert.equal(r.ok, true, '官方那一页还在，整体仍算成功')
  assert.ok(r.notes.some((n) => n.includes('检索失败')), r.notes.join(' | '))
  assert.ok(r.notes.some((n) => n.includes('请求失败')), r.notes.join(' | '))
  assert.ok(r.notes.some((n) => n.includes('限流') || n.includes('本就不保证可用')), r.notes.join(' | '))
})

test('三级全失败 ⇒ ok:false 且给出可读原因', async () => {
  const site = makeSite({ wikiHits: { [FANDOM_API]: null }, searchHtml: null })
  const r = await gatherLore({ ...base, officialUrls: [OFFICIAL_EMPTY], communityBases: [FANDOM], fetchImpl: site.fetchImpl })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('都没取到'))
  assert.deepEqual(r.sources, [])
})

test('★ 总字节上限会真的叫停', async () => {
  const big = page('官方', `<p>${'字'.repeat(5000)}</p>`)
  const site = makeSite({ pages: { [OFFICIAL]: big } })
  const r = await gatherLore({
    ...base, officialUrls: [OFFICIAL], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, limits: { enoughChars: 99999, maxTotalBytes: 100 },
  })
  assert.ok(!hitWiki(site.hits), '超了总字节上限就不该继续')
  assert.ok(r.notes.some((n) => n.includes('总字节上限')), r.notes.join(' | '))
})

test('gatherLore 对脏输入不崩', async () => {
  const site = makeSite()
  for (const bad of [null, undefined, 0, 'x', [], { name: null }, { officialUrls: 'x', communityBases: 42 }]) {
    assert.doesNotThrow(() => gatherLore(bad))
    const r = await gatherLore({ ...(bad && typeof bad === 'object' ? bad : {}), fetchImpl: site.fetchImpl, sleepImpl: noSleep, delayMs: 0 })
    assert.equal(typeof r.ok, 'boolean')
  }
})

// ══════════════════ E. ★ 逐条可追溯 ══════════════════

test('★ 合并文本按级打标，且能反查每条引文出自哪一级', async () => {
  const site = makeSite()
  const r = await gatherLore({
    ...base, officialUrls: [OFFICIAL], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, limits: { enoughChars: 99999 },
  })
  assert.match(r.text, /【官方 · 霞 - 官方角色页】/)
  assert.match(r.text, /【社区 Wiki · 霞 \| 霞 Wiki】/)
  assert.equal(locateTier(r.text, '她的口癖是「……才不是」。').tier, 'official')
  assert.equal(locateTier(r.text, '她从不说「谢谢」。').tier, 'community')
  assert.equal(locateTier(r.text, '这句话哪都没有').tier, null)
  assert.equal(locateTier(r.text, '').tier, null)
  assert.equal(locateTier('', '任意').tier, null)
})

test('★ 同一个事实在两级都出现 ⇒ 算**最高**那一级', () => {
  const text = renderTieredText([
    { tier: 'search', title: '论坛', text: '大家都说她的口癖是「……才不是」。' },
    { tier: 'official', title: '官方', text: '她的口癖是「……才不是」。' },
  ])
  assert.equal(locateTier(text, '她的口癖是「……才不是」。').tier, 'official', '官方也这么说 ⇒ 该算官方')
})

test('splitTierBlocks 能把合并文本切回"每级每页"', () => {
  const text = renderTieredText([
    { tier: 'official', title: 'A', text: '甲' },
    { tier: 'search', title: 'B', text: '乙' },
  ])
  const blocks = splitTierBlocks(text)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks.map((b) => b.tier), ['official', 'search'])
  assert.equal(blocks[0].text, '甲')
  assert.equal(blocks[1].title, 'B')
  assert.deepEqual(splitTierBlocks('没有标记的文本'), [])
})

test('★ urlKey 归一化（去尾斜杠/fragment/大小写）', () => {
  assert.equal(urlKey('https://A.test/x/'), urlKey('https://a.test/x'))
  assert.equal(urlKey('https://a.test/x#top'), urlKey('https://a.test/x'))
  assert.notEqual(urlKey('https://a.test/x'), urlKey('https://a.test/y'))
  assert.doesNotThrow(() => urlKey(null))
})

// ══════════════════ F. 端到端：三级 → 角色卡（每条带 tier） ══════════════════

test('★★ 端到端：三级依次取用 → 填表 → 每条提议都带出处层级', async () => {
  const site = makeSite()
  const card = draftCard({ name: '霞', game: 'someday' }).card
  const r = await fillCardFromSources({
    ...base, card,
    officialUrls: [OFFICIAL], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, forceHeuristic: true, limits: { enoughChars: 99999 },
  })
  assert.equal(r.source, 'heuristic')
  assert.ok(r.proposals.length >= 3, JSON.stringify(r.proposals.map((p) => p.path)))
  // ★ 有引文的提议必须能追溯；**没有引文的提议 tier 就该是 null** ——
  //   "这条没有出处"本身是实话，不该硬安一个层级上去
  const withEvidence = r.proposals.filter((p) => typeof p.evidence === 'string' && p.evidence.trim() !== '')
  assert.ok(withEvidence.length >= 3, `带引文的提议太少：${withEvidence.length}`)
  for (const p of withEvidence) {
    assert.ok(typeof p.tier === 'string' && p.tier !== '', `${p.path} 有引文却没有 tier`)
  }
  for (const p of r.proposals.filter((x) => !withEvidence.includes(x))) {
    assert.equal(p.tier, null, `${p.path} 没有引文 ⇒ tier 该是 null`)
  }
  const tics = r.proposals.find((p) => p.path === 'persona.hard.speechTics')
  assert.deepEqual(tics.value, ['……才不是'])
  assert.equal(tics.tier, 'official', '★ 口癖出自官方页 ⇒ 该标成官方')
  const forb = r.proposals.find((p) => p.path === 'persona.hard.forbiddenWords')
  assert.equal(forb.tier, 'community', '「谢谢」只在社区 wiki 里 ⇒ 该标成社区')
  assert.ok(r.byTier.official >= 1 && r.byTier.community >= 1, JSON.stringify(r.byTier))
  assert.ok(r.notes.some((n) => n.includes('逐条追溯')), r.notes.join(' | '))
  assert.equal(r.stoppedAt, null, '阈值放很大 ⇒ 三级都跑了')
  assert.deepEqual(r.tiers.map((t) => t.id), ['official', 'community', 'search'])
})

test('★★ 官方够用时：卡里的约束全部标成官方，且没碰过搜索引擎', async () => {
  const site = makeSite()
  const card = draftCard({ name: '霞', game: 'someday' }).card
  const r = await fillCardFromSources({
    ...base, card,
    officialUrls: [OFFICIAL], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, forceHeuristic: true, limits: { enoughChars: 300 },
  })
  assert.equal(r.stoppedAt, 'official')
  assert.ok(!hitWiki(site.hits) && !hitSearch(site.hits), '★ 一次都不该越过官方这一级')
  // 只跑了官方这一级；有引文的提议全部标成官方
  assert.deepEqual(r.tiers.map((t) => t.id), ['official', 'community', 'search'])
  assert.equal(r.tiers.filter((t) => t.attempted).map((t) => t.id).join(), 'official')
  const withEvidence = r.proposals.filter((p) => typeof p.evidence === 'string' && p.evidence.trim() !== '')
  for (const p of withEvidence) assert.equal(p.tier, 'official', `${p.path} 该是官方`)
  assert.equal(r.byTier.search, undefined)
})

test('★ 三级都拿不到 ⇒ 不硬凑，但仍给出空表（用户可手填）', async () => {
  const site = makeSite({ wikiHits: { [FANDOM_API]: null }, searchHtml: null })
  const r = await fillCardFromSources({
    ...base, card: draftCard({ name: '霞', game: 'g' }).card,
    officialUrls: [OFFICIAL_EMPTY], communityBases: [FANDOM],
    fetchImpl: site.fetchImpl, forceHeuristic: true,
  })
  assert.equal(r.source, 'none')
  assert.deepEqual(r.proposals, [])
  assert.deepEqual(r.sources, [])
  assert.ok(r.notes.some((n) => n.includes('都没拿到正文')), r.notes.join(' | '))
  assert.deepEqual(Object.keys(r.form.slots).sort(), Object.keys(fillForm().slots).sort())
})

test('★ 旧入口 fillCardFromWiki 仍可用（等价于"只给一个官方 URL"）', async () => {
  const site = makeSite()
  const r = await fillCardFromWiki({
    url: OFFICIAL, card: draftCard({ name: '霞', game: 'g' }).card,
    name: '霞', fetchImpl: site.fetchImpl, sleepImpl: noSleep, forceHeuristic: true,
    wiki: { delayMs: 0 },
  })
  assert.equal(r.source, 'heuristic')
  assert.ok(r.proposals.length >= 2)
  assert.ok(!hitSearch(site.hits), '旧入口不开搜索引擎')
  assert.ok(!hitWiki(site.hits), '旧入口不开社区 Wiki')
  // 只跑了官方这一级（另外两级即使被列在 tiers 里也不该 attempted）
  assert.equal(r.tiers.filter((t) => t.attempted).map((t) => t.id).join(), 'official')
  assert.ok(r.notes.some((n) => n.includes('调用方关掉了这一级')), r.notes.join(' | '))
})

test('fillCardFromSources 对脏输入不崩', async () => {
  for (const bad of [null, undefined, 0, 'x', {}, { url: null }]) {
    assert.doesNotThrow(() => fillCardFromSources(bad))
    // 用一个必然失败的 fetch：否则"搜索引擎兜底"会真的找到东西，source 就不是 none 了
    const r = await fillCardFromSources({
      ...(bad && typeof bad === 'object' ? bad : {}),
      fetchImpl: deadFetch, sleepImpl: noSleep, delayMs: 0,
    })
    assert.equal(r.source, 'none')
    assert.deepEqual(r.proposals, [])
  }
})

test('★ 关掉搜索引擎时：即便官方与社区都没料也不去搜（并说明是调用方关的）', async () => {
  const site = makeSite()
  const r = await gatherLore({
    ...base, officialUrls: [], communityBases: [], enableSearch: false,
    fetchImpl: site.fetchImpl,
  })
  assert.equal(r.ok, false, '不许用搜索兜底 ⇒ 没有材料')
  assert.ok(!hitSearch(site.hits), '★ 关掉了就不许请求搜索引擎')
  assert.ok(r.notes.some((n) => n.includes('调用方关掉了这一级')), r.notes.join(' | '))
})

test('describeGather 给出逐级一行摘要（界面直接用）', async () => {
  const site = makeSite()
  const r = await gatherLore({ ...base, officialUrls: [OFFICIAL], communityBases: [FANDOM], fetchImpl: site.fetchImpl, limits: { enoughChars: 99999 } })
  const s = describeGather(r)
  assert.match(s, /官方/)
  assert.match(s, /社区 Wiki/)
  assert.equal(describeGather(null), '')
})

test('GATHER_DEFAULTS 的边界是收紧的', () => {
  assert.ok(GATHER_DEFAULTS.enoughChars >= 200 && GATHER_DEFAULTS.enoughChars <= 2000)
  assert.ok(GATHER_DEFAULTS.maxTotalBytes <= 8 * 1024 * 1024)
  assert.ok(GATHER_DEFAULTS.delayMs >= 100, '请求之间该有间隔')
  assert.ok(GATHER_DEFAULTS.official.maxUrls <= 8)
  assert.ok(GATHER_DEFAULTS.search.maxResults <= 8)
})
