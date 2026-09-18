// lore/sources.mjs —— ★ 三级信源：官方 → 游戏社区 Wiki → 普通搜索引擎
//
// ══════════════════════════════════════════════════════════════════
// 为什么是"三级依次"而不是"多抓几页"
// ══════════════════════════════════════════════════════════════════
// 我第一版把这条管线理解成了"抓一个 wiki 页 + 它的同域子页" —— 那是**一个站点内爬深一点**。
// 用户要的是另一件事：**按可信度依次找料**。
//   ① 官方（官网角色页、官方设定集、厂商 wiki）—— 权威，但常常只有寥寥几句
//   ② 游戏社区 Wiki（Fandom / wiki.gg / 萌娘百科 / 灰机 …）—— 信息最全，是最常用的一级
//   ③ 普通搜索引擎 —— 兜底；官方与社区都没有时才用，且结果最不可靠
// 这三级不是"越多越好"，而是**够用就停**：官方给够了就不必去问搜索引擎。
//
// ══════════════════════════════════════════════════════════════════
// 每条约束都要能追溯到自己出自哪一级
// ══════════════════════════════════════════════════════════════════
// 这是"依次"真正的价值：同样是"她的口癖是「……才不是」"，
//   出自官方设定集 与 出自某论坛搜索结果，可信度完全不同。
// 所以合并文本时会**按级打标**（【官方】【社区 Wiki】【搜索】），
// 填表后每条提议都能通过"它的引文落在哪一段"反查出层级。
// 用户于是能一眼看出：这张卡里哪几条是有权威依据的，哪几条只是网上有人说。
//
// ══════════════════════════════════════════════════════════════════
// 诚实边界（写在这里，不藏在实现里）
// ══════════════════════════════════════════════════════════════════
//   · **官方域名不猜**：没人能可靠地"猜出"某游戏的官网。官方这一级只吃
//     **用户给的 URL** 或**按游戏配置的域名白名单**。猜出来的官方 = 假权威，比没有更糟。
//   · **社区 Wiki 用标准 API**：MediaWiki 系的站（Fandom / wiki.gg / 萌娘 / 灰机 …）
//     都有 `api.php?action=opensearch`，返回 JSON —— 比抓搜索框的 HTML 稳得多。
//   · **搜索引擎走可配置的模板**：默认 DuckDuckGo 的 html 端点，但**不保证可用**：
//     搜索引擎会改版、会限流、也可能直接拒绝。所以模板可换、失败必降级、且
//     `fetchImpl` 可注入 —— 离线能把整条链路穷举测完，真实端点则如实标注"未验证"。

/** 三级信源。**顺序就是优先级**，不要随意重排。 */
export const SOURCE_TIERS = Object.freeze([
  Object.freeze({
    id: 'official',
    label: '官方',
    note: '官网角色页 / 官方设定资料 —— 最权威，但往往信息最少',
    /** 官方域名不猜：只吃用户给的 URL 或按游戏配置的白名单 */
    discovered: 'user',
  }),
  Object.freeze({
    id: 'community',
    label: '社区 Wiki',
    note: 'Fandom / wiki.gg / 萌娘百科 / 灰机等 —— 信息最全的一级',
    discovered: 'mediawiki-search',
  }),
  Object.freeze({
    id: 'search',
    label: '搜索',
    note: '普通搜索引擎 —— 兜底用，结果最不可靠',
    discovered: 'web-search',
  }),
])

export const TIER_IDS = Object.freeze(SOURCE_TIERS.map((t) => t.id))
export const tierById = (id) => SOURCE_TIERS.find((t) => t.id === id) ?? null
export const tierLabel = (id) => tierById(id)?.label ?? String(id ?? '未知')

/**
 * 已知的社区 Wiki 站点（**按域后缀识别**）。
 * 这不是"完整列表"，而是"认得出就归类"——认不出的会被当作普通网页（unknown），
 * 而不是硬塞进某一级。
 */
export const COMMUNITY_WIKI_HOSTS = Object.freeze([
  'fandom.com', 'wikia.org', 'gamepedia.com',
  'wiki.gg', 'huijiwiki.com', 'moegirl.org.cn', 'moegirl.org',
  'wikipedia.org', 'wiktionary.org',
  'bulbapedia.bulbagarden.net', 'zeldawiki.wiki', 'strategywiki.org',
  'bilibili.com', 'gamekee.com', 'doyo.cn',
])

/** 认得出来的"官方"域名特征（只是**辅助判断**，绝不用于凭空构造 URL）。 */
export const OFFICIAL_HOST_HINTS = Object.freeze([
  /(^|\.)nintendo\.(com|co\.jp)$/i, /(^|\.)playstation\.com$/i, /(^|\.)xbox\.com$/i,
  /(^|\.)steam(community|powered)?\.com$/i, /(^|\.)steampowered\.com$/i,
  /(^|\.)square-enix\.com$/i, /(^|\.)capcom\.com$/i, /(^|\.)bandainamco/i,
  /(^|\.)fromsoftware\.jp$/i, /(^|\.)hoyolab\.com$/i, /(^|\.)mihoyo\.com$/i,
  /(^|\.)hypergryph\.com$/i, /(^|\.)atlus\.com$/i, /(^|\.)sega\.com$/i,
])

/**
 * 给一个 URL 归类。**认不出就返回 unknown**，不猜 —— 把搜索结果冒充官方是最糟的错。
 * @param {string} url
 * @param {{officialHosts?:string[]}} [opts] 用户按游戏配置的官方域名（这些优先于启发式）
 * @returns {{tier:string, why:string}}
 */
export function classifySource(url, opts = {}) {
  let u
  try { u = new URL(String(url)) } catch { return { tier: 'unknown', why: 'URL 不合法' } }
  const host = u.host.toLowerCase()
  const officialHosts = (opts.officialHosts ?? []).map((h) => String(h).toLowerCase().replace(/^\.+/, ''))
  if (officialHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { tier: 'official', why: '命中用户配置的官方域名' }
  }
  if (COMMUNITY_WIKI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { tier: 'community', why: '已知的社区 Wiki 站点' }
  }
  if (OFFICIAL_HOST_HINTS.some((re) => re.test(host))) return { tier: 'official', why: '已知的厂商域名' }
  return { tier: 'unknown', why: '认不出这是哪一级站点（不猜）' }
}

// ---------- 社区 Wiki：MediaWiki 标准检索 ----------

/** MediaWiki 系站点的 opensearch 接口地址（Fandom / wiki.gg / 萌娘 / 灰机都支持）。 */
export function mediawikiSearchUrl(base, term, { limit = 5 } = {}) {
  const b = String(base ?? '').trim().replace(/\/+$/, '')
  if (b === '') return null
  // Fandom 与多数站的入口在 /api.php；wiki.gg 在 /api.php 也在根下
  const api = /\/api\.php$/i.test(b) ? b : `${b}/api.php`
  return `${api}?action=opensearch&format=json&limit=${Math.max(1, Math.min(20, limit))}&search=${encodeURIComponent(String(term ?? ''))}`
}

/**
 * 解析 opensearch 的返回：`[term, [titles], [descs], [urls]]`。
 * 宽容：也接受 `{query:[...]}` 之类的包装。
 */
export function parseOpenSearch(json) {
  let arr = json
  if (typeof json === 'string') { try { arr = JSON.parse(json) } catch { return [] } }
  if (arr && !Array.isArray(arr)) arr = arr.query ?? arr.result ?? null
  if (!Array.isArray(arr)) return []
  const titles = Array.isArray(arr[1]) ? arr[1] : []
  const urls = Array.isArray(arr[3]) ? arr[3] : []
  const out = []
  for (let i = 0; i < Math.min(titles.length, urls.length); i++) {
    if (typeof urls[i] !== 'string' || urls[i] === '') continue
    out.push({ title: String(titles[i] ?? ''), url: urls[i], rank: i })
  }
  return out
}

// ---------- 搜索引擎：可配置模板 ----------

/** 默认搜索端点。**可换** —— 搜索引擎会改版/限流，硬编码一个就等着坏。 */
export const DEFAULT_SEARCH_TEMPLATE = 'https://html.duckduckgo.com/html/?q={q}'

/** 按模板构造搜索 URL。模板里用 `{q}` 占位。 */
export function buildSearchUrl(query, { template = DEFAULT_SEARCH_TEMPLATE } = {}) {
  const q = String(query ?? '').trim()
  if (q === '') return null
  const t = String(template ?? DEFAULT_SEARCH_TEMPLATE)
  if (!t.includes('{q}')) return null
  return t.replace('{q}', encodeURIComponent(q))
}

/**
 * 从搜索结果页里挑出候选链接。
 * **刻意保守**：只留看起来像"角色资料页"的结果，且**同域结果只留一条**（避免一个站占满名额）。
 * 搜索引擎的结果页结构会变，所以这里用的是"宽松抽取 + 打分筛选"，而不是精确的 DOM 选择器。
 */
export function parseSearchResults(html, baseUrl, { name = '', game = '', max = 5 } = {}) {
  const links = extractLinksLoose(html, baseUrl)
  const want = [name, game].map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean)
  const scored = []
  const seenHost = new Map()
  for (const l of links) {
    let u
    try { u = new URL(l.href) } catch { continue }
    // 跳过搜索引擎自己的导航/广告位
    if (isSearchEngineHost(u.host)) continue
    const text = String(l.text ?? '').toLowerCase()
    const href = decodeURIComponentSafe(u.href.toLowerCase())
    let score = 0
    for (const w of want) {
      if (w && text.includes(w)) score += 4
      if (w && href.includes(w)) score += 3
    }
    if (/(wiki|攻略|角色|人物|character|profile)/i.test(text + ' ' + href)) score += 2
    if (score <= 0) continue
    const host = u.host.toLowerCase()
    const n = (seenHost.get(host) ?? 0) + 1
    seenHost.set(host, n)
    if (n > 1) score -= 2      // 同域第二条要弱一些，但不完全排除
    scored.push({ url: l.href, title: l.text, score: Number(score.toFixed(2)), host })
  }
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
  // 同一域名最多留 2 条
  const perHost = new Map()
  const out = []
  for (const r of scored) {
    const n = perHost.get(r.host) ?? 0
    if (n >= 2) continue
    perHost.set(r.host, n + 1)
    out.push(r)
    if (out.length >= max) break
  }
  return out
}

const SEARCH_ENGINE_HOSTS = ['duckduckgo.com', 'google.', 'bing.com', 'baidu.com', 'yandex.', 'sogou.com', 'so.com', 'startpage.com', 'search.brave.com', 'ecosia.org']
export function isSearchEngineHost(host) {
  const h = String(host ?? '').toLowerCase()
  return SEARCH_ENGINE_HOSTS.some((x) => h.includes(x))
}

/** 宽松抽链接：`<a href>` 与搜索结果页常见的裸 URL 都认。 */
function extractLinksLoose(html, baseUrl) {
  const out = []
  const seen = new Set()
  const s = String(html ?? '')
  // ① 标准 <a href>
  for (const m of s.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    push(m[1], m[2])
  }
  // ② DuckDuckGo 的跳转链 `uddg=<encoded>`
  for (const m of s.matchAll(/uddg=([^&"']+)/g)) {
    let target = m[1]
    try { target = decodeURIComponent(target) } catch { /* 保持原样 */ }
    push(target, '')
  }
  function push(rawHref, inner) {
    if (!rawHref) return
    let u
    try { u = new URL(String(rawHref).trim(), baseUrl) } catch { return }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return
    u.hash = ''
    const href = u.toString()
    if (seen.has(href)) return
    seen.add(href)
    const text = String(inner ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    out.push({ href, text, host: u.host.toLowerCase() })
  }
  return out
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

// ---------- 搜索查询构造 ----------

/**
 * 构造搜索查询。**刻意把游戏名放进引号** —— 不然一个常见角色名会搜出一堆无关结果。
 * @param {{name:string, game?:string, extra?:string}} p
 */
export function buildSearchQuery({ name, game, extra } = {}) {
  const parts = []
  if (name) parts.push(`"${String(name).trim()}"`)
  if (game) parts.push(`"${String(game).trim()}"`)
  parts.push(extra ?? '角色 介绍')
  return parts.join(' ').trim()
}

/** 给界面用的一行说明。 */
export function describeTiers(opts = {}) {
  return SOURCE_TIERS.map((t) => {
    const on = opts.enabled ? opts.enabled.includes(t.id) : true
    return `${on ? '✓' : '✗'} ${t.label}（${t.id}）—— ${t.note}`
  }).join('\n')
}
