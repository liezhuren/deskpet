// lore/fetch.mjs —— 抓取「网上角色介绍」（零依赖 HTML → 文本）
//
// ═══════════════════════════════════════════════════════════════════
// 这一层要**说清自己的边界**，因为它最容易让人产生过高期待
// ═══════════════════════════════════════════════════════════════════
// ① 只读**静态 HTML**。现在多数百科/攻略站是前端渲染的，抓到的是一个空壳
//    （正文由 JS 在浏览器里生成）——这种情况下我们能拿到的只有标题和零星 meta。
//    所以 fetchLore 会**如实报告**"抽到的正文很短"，而不是拿导航栏文字当角色介绍。
// ② 一次只抓**一个 URL**。不爬站、不跟链接、不猜下级页面。
// ③ 有大小与超时上限，且带一个可识别的 User-Agent。
// ④ 抓来的文字只是**素材**：它进 soft 层，或者作为"提议 hard 约束"的证据，
//    **绝不会被自动写进卡里生效**（见 lore/propose.mjs 的立场）。
//
// `fetch` 是**注入的**（opts.fetchImpl）。于是：
//   ✅ 可离线验证：HTML→文本、编码、错误分支、超限截断
//   ❌ 未验证：真实网络连通性、各站点的实际结构、反爬行为
// 这个区分很重要，不能含糊地说"能联网抓资料"。

/** 默认上限。 */
export const FETCH_DEFAULTS = Object.freeze({
  maxBytes: 512 * 1024,
  timeoutMs: 12_000,
  minUsefulChars: 120,   // 正文少于这个数就认为"没抽到有用的东西"
  userAgent: 'game-pet-agent/0.1 (personal project; reads one page for character lore)',
})

/**
 * 抓一个页面并抽出可读文本。
 * @param {string} url
 * @param {{fetchImpl?:Function, maxBytes?:number, timeoutMs?:number, userAgent?:string, minUsefulChars?:number}} [opts]
 * @returns {Promise<{ok:boolean, url:string, finalUrl:string|null, title:string|null, text:string, chars:number, bytes:number, notes:string[], error:string|null}>}
 */
export async function fetchLore(url, opts = {}) {
  const D = { ...FETCH_DEFAULTS, ...opts }
  const notes = []
  const out = { ok: false, url: String(url ?? ''), finalUrl: null, title: null, text: '', chars: 0, bytes: 0, notes, error: null }

  const u = String(url ?? '').trim()
  if (u === '') { out.error = 'URL 是空的'; return out }
  if (!/^https?:\/\//i.test(u)) { out.error = '只支持 http/https'; return out }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') { out.error = '没有可用的 fetch'; return out }

  let res
  try {
    res = await fetchImpl(u, {
      headers: { 'user-agent': D.userAgent, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: makeSignal(D.timeoutMs),
    })
  } catch (e) {
    out.error = e?.name === 'AbortError' ? `超时（${D.timeoutMs}ms）` : `请求失败：${e.message}`
    return out
  }

  if (!res || res.ok !== true) {
    out.error = `HTTP ${res?.status ?? '?'}`
    return out
  }
  out.finalUrl = res.url ?? u

  let body
  try {
    body = await res.text()
  } catch (e) {
    out.error = `读取响应失败：${e.message}`
    return out
  }
  const info = interpretBody(body, D)
  out.bytes = info.bytes
  out.title = info.title
  out.text = info.text
  out.chars = info.chars
  for (const n of info.notes) notes.push(n)
  if (!info.useful) return out
  out.ok = true
  return out
}

/**
 * HTML → 可读文本（零依赖）。
 * 做四件事：去脚本/样式/注释 → 块级标签转换行 → 去标签 → 解实体 + 压空白。
 * **不做正文识别**（不判断"哪块是正文"）：那需要模板库或启发式打分，
 * 而本项目宁可用"正文太短就如实报告"来兜住。
 *
 * @param {string} html
 * @returns {{title:string|null, text:string, notes:string[]}}
 */
export function htmlToText(html) {
  const notes = []
  let s = String(html ?? '')

  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()

  const before = s.length
  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  if (s.length < before * 0.6) notes.push('页面的脚本/样式占比很高（可能整页由 JS 渲染）')

  // meta description 当作补充（有些站的简介只在这里）
  const desc = s.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? s.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1]

  s = s
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|header|footer|main|blockquote|dd|dt)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  s = decodeEntities(s)
  s = s
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n')

  if (desc && desc.trim() !== '') {
    const d = decodeEntities(desc.trim())
    if (!s.includes(d.slice(0, 20))) s = `${d}\n${s}`
  }
  if (title) notes.push(`页面标题：${title}`)
  return { title: title || null, text: s, notes }
}

/** 实体解码：命名 + 十进制 + 十六进制。未知实体原样保留。 */
export function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–', middot: '·' }
  return String(s ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code)) return m
      try { return String.fromCodePoint(code) } catch { return m }
    }
    return named[body.toLowerCase()] ?? m
  })
}

// ══════════════════════════════════════════════════════════════════
// ★ Wiki 管线：从"一个页面"到"够填一张卡的材料"
// ══════════════════════════════════════════════════════════════════
// 单页通常不够：角色 wiki 的正文常拆在「简介 / 语音 / 档案 / 剧情」几个子页里，
// 而口癖这类东西恰恰在语音页。所以要抓几页。
//
// 但"多抓几页"离"爬虫"只有一步，所以边界写死在这里、不靠调用方自觉：
//   · **只走同域**（跨站一律不跟）—— 跟着跟着就跑到广告与镜像站去了
//   · **只走一层**（种子页 + 种子页上的链接），不做递归
//   · **页数与总字节都有硬上限**
//   · **请求之间有间隔**（对站点基本的礼貌；sleep 可注入，测试不真的等）
//   · 每页都**如实报告**；抓不到就说抓不到，不拿别的页硬凑

/** Wiki 抓取默认参数。 */
export const WIKI_DEFAULTS = Object.freeze({
  maxPages: 4,                       // 种子页 + 最多 3 个子页
  maxTotalBytes: 2 * 1024 * 1024,
  delayMs: 250,                      // 两次请求之间的间隔
  maxLinksPerPage: 60,
  minUsefulChars: 120,
  /** 子页关键词：命中这些的链接优先（中英日都放一点） */
  subpageWords: Object.freeze([
    '语音', '台词', '档案', '资料', '简介', '设定', '剧情', '故事', '人物', '经历',
    'voice', 'lines', 'profile', 'story', 'lore', 'bio', 'intro', 'quotes',
  ]),
})

/**
 * 从 HTML 里抽链接（零依赖、够用即止）。只认 `<a href="...">锚文本</a>`；
 * 不解析 CSS 选择器、不执行 JS、不跟 `#`/`javascript:`/`mailto:`。
 *
 * @returns {Array<{href:string, text:string, sameHost:boolean}>} 已绝对化、已去重
 */
export function extractLinks(html, baseUrl) {
  const out = []
  const seen = new Set()
  let base
  try { base = new URL(String(baseUrl)) } catch { return out }
  for (const m of String(html ?? '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawHref = m[1].trim()
    if (!rawHref || rawHref.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(rawHref)) continue
    let u
    try { u = new URL(rawHref, base) } catch { continue }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    u.hash = ''
    const href = u.toString()
    if (seen.has(href)) continue
    seen.add(href)
    out.push({
      href,
      text: htmlToText(m[2]).text.replace(/\s+/g, ' ').trim().slice(0, 80),
      sameHost: u.host.toLowerCase() === base.host.toLowerCase(),
    })
  }
  return out
}

/**
 * 从链接里挑"值得跟着抓"的子页。排序规则**可解释**：
 *   锚文本含角色名(+6) > URL 含角色名(+4) > 锚文本命中子页关键词(+3) > URL 命中关键词(+2)，
 *   路径过深的略扣分。**同域的才算候选**，种子页自身排除。
 */
export function pickSubpageLinks(links, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {}
  const seed = String(o.seedUrl ?? '')
  const name = String(o.name ?? '').trim().toLowerCase()
  const words = o.subpageWords ?? WIKI_DEFAULTS.subpageWords
  const max = o.max ?? WIKI_DEFAULTS.maxLinksPerPage
  const scored = []
  for (const l of links ?? []) {
    if (!l || !l.href) continue
    if (!l.sameHost) continue
    if (l.href === seed) continue
    const text = String(l.text ?? '').toLowerCase()
    let hrefDecoded = String(l.href).toLowerCase()
    try { hrefDecoded = decodeURIComponent(hrefDecoded) } catch { /* 解码失败就用原串 */ }
    let score = 0
    if (name && text.includes(name)) score += 6
    if (name && hrefDecoded.includes(name)) score += 4
    if (words.some((w) => text.includes(String(w).toLowerCase()))) score += 3
    if (words.some((w) => hrefDecoded.includes(String(w).toLowerCase()))) score += 2
    if (score <= 0) continue
    score -= Math.max(0, hrefDecoded.split('/').length - 5) * 0.2
    scored.push({ href: l.href, text: l.text, why: `name=${name && (text.includes(name) || hrefDecoded.includes(name)) ? 'y' : 'n'}`, score: Number(score.toFixed(2)) })
  }
  scored.sort((a, b) => b.score - a.score || a.href.localeCompare(b.href))
  return scored.slice(0, max)
}

/** 抓一个 URL，返回**含原始 HTML** 的结果（wiki 管线要用它抽链接）。 */
export async function fetchPage(url, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {}
  const D = { ...FETCH_DEFAULTS, ...o }
  const notes = []
  const out = { ok: false, url: String(url ?? ''), finalUrl: null, title: null, text: '', html: '', chars: 0, bytes: 0, notes, error: null }

  const u = String(url ?? '').trim()
  if (u === '') { out.error = 'URL 是空的'; return out }
  if (!/^https?:\/\//i.test(u)) { out.error = '只支持 http/https'; return out }
  const fetchImpl = o.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') { out.error = '没有可用的 fetch'; return out }

  let res
  try {
    res = await fetchImpl(u, {
      headers: { 'user-agent': D.userAgent, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: makeSignal(D.timeoutMs),
    })
  } catch (e) {
    out.error = e?.name === 'AbortError' ? `超时（${D.timeoutMs}ms）` : `请求失败：${e.message}`
    return out
  }
  if (!res || res.ok !== true) { out.error = `HTTP ${res?.status ?? '?'}`; return out }
  out.finalUrl = res.url ?? u

  let body
  try { body = await res.text() } catch (e) { out.error = `读取响应失败：${e.message}`; return out }
  const info = interpretBody(body, D)
  Object.assign(out, { bytes: info.bytes, title: info.title, text: info.text, chars: info.chars, html: info.html })
  for (const n of info.notes) notes.push(n)
  out.ok = info.useful
  return out
}

/**
 * ★ 抓一个 Wiki 角色页 + 它的若干子页，合并成一段供"出表填表"用的材料。
 *
 * @param {string} seedUrl
 * @param {{fetchImpl?:Function, sleepImpl?:Function, name?:string, maxPages?:number,
 *          delayMs?:number, maxTotalBytes?:number, minUsefulChars?:number}} [opts]
 * @returns {Promise<{ok:boolean, text:string, chars:number, pages:Array, notes:string[], error:string|null}>}
 */
export async function fetchWiki(seedUrl, opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {}
  const D = { ...WIKI_DEFAULTS, ...o }
  const sleep = typeof o.sleepImpl === 'function' ? o.sleepImpl : ((ms) => new Promise((r) => setTimeout(r, ms)))
  const notes = []
  const pages = []

  const seed = await fetchPage(seedUrl, o)
  pages.push({ url: seed.finalUrl ?? String(seedUrl), title: seed.title, chars: seed.chars, bytes: seed.bytes, ok: seed.ok, role: 'seed', text: seed.text })
  for (const n of seed.notes) notes.push(n)
  if (!seed.ok) {
    return { ok: false, text: '', chars: 0, pages, notes, error: seed.error ?? '种子页没抓到正文' }
  }

  const links = extractLinks(seed.html, seed.finalUrl ?? seedUrl)
  const picks = pickSubpageLinks(links, { seedUrl: seed.finalUrl ?? seedUrl, name: o.name, max: Math.max(0, D.maxPages - 1) })
  if (links.length && picks.length === 0) {
    notes.push(`页面上有 ${links.length} 个链接，但没有一个像是这个角色的子页 ⇒ 只用手上的正文`)
  }

  let totalBytes = seed.bytes
  for (const pick of picks) {
    if (totalBytes >= D.maxTotalBytes) { notes.push(`已达总字节上限 ${D.maxTotalBytes} ⇒ 停止抓取`); break }
    if (D.delayMs > 0) await sleep(D.delayMs)
    const r = await fetchPage(pick.href, o)
    pages.push({ url: pick.href, title: r.title, chars: r.chars, bytes: r.bytes, ok: r.ok, role: 'subpage', score: pick.score, text: r.text })
    if (!r.ok) { notes.push(`子页未取到正文：${pick.href}（${r.error ?? (r.notes ?? []).join('；')}）`); continue }
    totalBytes += r.bytes
  }

  const good = pages.filter((p) => p.ok)
  // 合并：种子页在前；子页带来源标注 —— 既方便人核对，也让"证据核验"能指回具体一页
  const parts = [good[0].text]
  for (let i = 1; i < good.length; i++) {
    parts.push(`【补充资料：${good[i].title ?? good[i].url}】\n${good[i].text}`)
  }
  const text = parts.join('\n\n')
  notes.push(`合并 ${good.length} 页（共请求 ${pages.length} 次），${[...text].length} 字`)
  return { ok: true, text, chars: [...text].length, pages, notes, error: null }
}

/** 把一个响应体转成"可读文本 + 大小 + 判断"这堆东西。抓取与 wiki 管线共用。 */
export function interpretBody(body, D) {
  const notes = []
  const bytes = Buffer.byteLength(body, 'utf8')
  let text = body
  if (D.maxBytes && bytes > D.maxBytes) {
    notes.push(`页面 ${bytes} 字节超过上限 ${D.maxBytes} ⇒ 只取前 ${D.maxBytes} 字节`)
    text = body.slice(0, D.maxBytes)
  }
  const parsed = htmlToText(text)
  const chars = [...parsed.text].length
  for (const n of parsed.notes) notes.push(n)
  const useful = chars >= D.minUsefulChars
  if (!useful) {
    // ★ 这一条是**如实报告**，不是失败：能抓到的正文就这么点，
    //   多半是"正文由 JS 渲染"或"这页本来就不是介绍页"。宁可说清，也不要
    //   拿导航栏/页脚文字冒充角色介绍 —— 那会污染后面所有环节。
    notes.push(`只抽到 ${chars} 字正文（少于 ${D.minUsefulChars}）⇒ 这一页多半是前端渲染的，或者不是介绍页`)
  }
  return { bytes, title: parsed.title, text: parsed.text, chars, useful, notes, html: text }
}

function makeSignal(ms) {
  if (!Number.isFinite(ms) || typeof AbortController !== 'function') return undefined
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), ms).unref?.()
  return ctl.signal
}
