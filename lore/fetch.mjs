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
  out.bytes = Buffer.byteLength(body, 'utf8')
  if (D.maxBytes && out.bytes > D.maxBytes) {
    notes.push(`页面 ${out.bytes} 字节超过上限 ${D.maxBytes} ⇒ 只取前 ${D.maxBytes} 字节`)
    body = body.slice(0, D.maxBytes)
  }

  const parsed = htmlToText(body)
  out.title = parsed.title
  out.text = parsed.text
  out.chars = [...parsed.text].length
  for (const n of parsed.notes) notes.push(n)

  if (out.chars < D.minUsefulChars) {
    // ★ 这一条是**如实报告**，不是失败：能抓到的正文就这么点，
    //   多半是"正文由 JS 渲染"或"这页本来就不是介绍页"。宁可说清，也不要
    //   拿导航栏/页脚文字冒充角色介绍 —— 那会污染后面所有环节。
    notes.push(`只抽到 ${out.chars} 字正文（少于 ${D.minUsefulChars}）⇒ 这一页多半是前端渲染的，或者不是介绍页`)
    return out
  }

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

function makeSignal(ms) {
  if (!Number.isFinite(ms) || typeof AbortController !== 'function') return undefined
  const ctl = new AbortController()
  setTimeout(() => ctl.abort(), ms).unref?.()
  return ctl.signal
}
