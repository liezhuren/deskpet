// lore/gather.mjs —— ★ 三级信源"依次取用"：官方 → 社区 Wiki → 搜索
//
// ══════════════════════════════════════════════════════════════════
// 核心是"依次"两个字，它有两层含义
// ══════════════════════════════════════════════════════════════════
//  ① **按优先级取用**：先问官方，不够再问社区 Wiki，还不够才去搜搜索引擎。
//     —— 不是"三路并抓然后融一锅"，那样等于把搜索结果和官方设定同等对待。
//  ② **够用即停**：前一级给的材料够了，就**不去打扰下一级**。
//     这既省流量，也让"官方给够了"这件事本身成为结论（`stoppedAt`）。
//
// 合并时**按级打标**（【官方】【社区 Wiki】【搜索】），于是：
//   · 填进卡里的每条约束都能反查出它出自哪一级（`locateTier`）
//   · 同一个事实若在更高级也出现，算作更高级 —— **取最高那级**，
//     因为"官方也这么说"与"只有论坛这么说"是不同的可信度
//
// ⚠ 诚实边界：真实网络的可用性**未验证**。默认搜索端点（DuckDuckGo html）
//   会改版、会限流、也可能直接拒绝；社区 Wiki 的 opensearch 我只按 MediaWiki 标准
//   构造请求，没有对着真实站点跑过。所以：
//   · `fetchImpl`/`sleepImpl` 可注入 ⇒ 整条链路能离线穷举测完
//   · 每一次失败都**如实记进 notes**，绝不"静默少抓一点"让上层以为很顺利

import { fetchWiki } from './fetch.mjs'
import {
  SOURCE_TIERS, TIER_IDS, tierLabel, tierById, classifySource,
  mediawikiSearchUrl, parseOpenSearch, buildSearchUrl, parseSearchResults,
  buildSearchQuery, DEFAULT_SEARCH_TEMPLATE,
} from './sources.mjs'

/** 取用默认参数。 */
export const GATHER_DEFAULTS = Object.freeze({
  /** 官方这一级：用户给的 URL 优先抓；一个 URL 最多再跟几页子页 */
  official: Object.freeze({ subpages: 2, maxUrls: 4 }),
  /** 社区 Wiki：每个站点检索一次，取最匹配的一条；再跟几页子页 */
  community: Object.freeze({ subpages: 2, maxSites: 4, searchLimit: 3 }),
  /** 搜索：取前几条结果（结果本身最不可靠，所以跟的子页最少） */
  search: Object.freeze({ subpages: 0, maxResults: 4 }),
  /**
   * **够用即停**的阈值（字符数）。默认 600 —— 大致相当于"官方角色页正文"的量。
   * 调大 ⇒ 更倾向于榨干高优先级信源；调小 ⇒ 更快落到搜索引擎（也更不可靠）。
   */
  enoughChars: 600,
  maxTotalBytes: 3 * 1024 * 1024,
  delayMs: 250,
  minUsefulChars: 120,
})

/**
 * ★ 依次取用三级信源。
 *
 * @param {object} p
 * @param {string} p.name  角色名（检索与查询都要用）
 * @param {string} [p.game] 游戏标识/名（放进搜索查询，避免重名角色搜串）
 * @param {string[]} [p.officialUrls] 官方页面（**用户给的**；官方域名不猜）
 * @param {string[]} [p.officialHosts] 该游戏的官方域名（用于把某个 URL 归类到官方）
 * @param {string[]} [p.communityBases] 社区 Wiki 的站点地址（如 `https://x.fandom.com`）
 * @param {boolean} [p.enableSearch=true] 是否允许用搜索引擎兜底
 * @param {string} [p.searchTemplate] 搜索端点模板（含 `{q}`）
 * @param {Function} [p.fetchImpl] 注入的 fetch（离线测试用）
 * @param {Function} [p.sleepImpl] 注入的 sleep（测试时不要真等）
 * @param {string[]} [p.onlyTiers] 只用这几级（默认全用，仍按顺序）
 * @returns {Promise<{ok:boolean, text:string, chars:number, sources:Array, tiers:Array,
 *                    stoppedAt:string|null, notes:string[], error:string|null}>}
 */
export async function gatherLore(p = {}) {
  const o = (p && typeof p === 'object') ? p : {}
  const D = { ...GATHER_DEFAULTS, ...(o.limits ?? {}) }
  const sleep = typeof o.sleepImpl === 'function' ? o.sleepImpl : ((ms) => new Promise((r) => setTimeout(r, ms)))
  const fetchOpts = {
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.sleepImpl ? { sleepImpl: o.sleepImpl } : {}),
    delayMs: o.delayMs ?? D.delayMs,
    minUsefulChars: D.minUsefulChars,
  }
  const only = Array.isArray(o.onlyTiers) && o.onlyTiers.length ? new Set(o.onlyTiers) : null

  const notes = []
  const sources = []          // 所有取到的页面 { tier, url, title, chars, role }
  const tiers = []            // 每级的过程与结果
  const seenUrls = new Set()  // ★ 跨级去重：同一个页面不该在两级各抓一次
  let totalBytes = 0
  let stoppedAt = null

  const charsOf = (tier) => sources.filter((s) => s.tier === tier).reduce((a, s) => a + s.chars, 0)

  /** 抓一个候选 URL（含可选子页），并把结果记进 sources。 */
  async function take(url, tier, subpages, role = 'page') {
    // ★ 跨级去重。实测场景：搜索结果里第一条往往就是你刚在社区那一级抓过的页面 ——
    //   不去重的话它会被算两次字数、也会在合并文本里出现两遍（"够用"的判定被虚高）。
    const key = urlKey(url)
    if (seenUrls.has(key)) {
      notes.push(`[${tierLabel(tier)}] 这一页前面已经取过，跳过：${url}`)
      return 0
    }
    // ⚠ **不要在这里就把 key 记进 seenUrls** —— 第一版这么写了，于是下面逐页登记时
    //   种子页会被判断成"重复的它自己"，每一页都被跳掉、字数永远是 0。
    //   登记的时机放在下面拿到结果之后。
    if (totalBytes >= D.maxTotalBytes) {
      notes.push(`已达总字节上限 ${D.maxTotalBytes} ⇒ 停止抓取`)
      seenUrls.add(key)
      return 0
    }
    if (D.delayMs > 0 && sources.length > 0) await sleep(D.delayMs)
    const r = await fetchWiki(url, { ...fetchOpts, name: o.name, maxPages: Math.max(1, 1 + subpages) })
    if (!r.ok) {
      notes.push(`[${tierLabel(tier)}] 未取到正文：${url}（${r.error ?? (r.notes ?? []).join('；')}）`)
      sources.push({ tier, url, title: null, chars: 0, role, ok: false })
      seenUrls.add(key)
      return 0
    }
    let got = 0
    for (const page of r.pages.filter((x) => x.ok)) {
      const pk = urlKey(page.url)
      // 只有"别处已经取过"的才跳过；本次显式请求的这一页一定要收下
      if (pk !== key && seenUrls.has(pk)) continue
      seenUrls.add(pk)
      sources.push({ tier, url: page.url, title: page.title, chars: page.chars, role, ok: true, text: page.text })
      got += page.chars
    }
    seenUrls.add(key)
    totalBytes += (r.pages ?? []).reduce((a, x) => a + (x.bytes ?? 0), 0)
    return got
  }

  // ═══════════ 按优先级依次取用 ═══════════
  //
  // 写成数据驱动的循环而不是三段 if，为的是三件事：
  //   ① **每一级都留下一条记录**（含"没跑"的那几级与没跑的原因）。
  //      界面要能显示"官方给了 458 字 ⇒ 社区与搜索没跑"，而不是三行里只有一行。
  //   ② 早停只有一处判定：**累计达到阈值**。第一版在搜索那一级写成了
  //      "拿到东西就算停"，于是报告里出现"已达 1810 字（阈值 99999）⇒ 没有再去问下一级"
  //      这种自相矛盾的话。
  //   ③ 顺序只由 TIER_IDS 决定，调用方给 onlyTiers 也改不了优先级。
  const cumulative = () => sources.filter((s) => s.ok).reduce((a, s) => a + s.chars, 0)

  for (const id of TIER_IDS) {
    if (only && !only.has(id)) continue
    const t = { id, label: tierLabel(id), attempted: false, chars: 0, sources: 0, notes: [] }

    if (stoppedAt) {
      t.notes.push(`上一级累计已够用 ⇒ 这一级没跑（省一次请求）`)
      notes.push(`[${t.label}] 上一级已够用 ⇒ 跳过`)
      tiers.push(t)
      continue
    }

    // ★ 总字节上限是**全局刹车**，不只挡"抓页面"：连检索请求也不该再发。
    //   （第一版只在 take() 里挡了取正文，于是超限之后还会去打社区 wiki 的检索接口 ——
    //    "已达上限就停"应当是真的停。）
    if (totalBytes >= D.maxTotalBytes) {
      t.notes.push(`已达总字节上限 ${D.maxTotalBytes} ⇒ 这一级没跑`)
      notes.push(`[${t.label}] 已达总字节上限 ⇒ 跳过`)
      tiers.push(t)
      continue
    }

    // ─────── ① 官方 ───────
    if (id === 'official') {
      const urls = asArray(o.officialUrls).filter((u) => typeof u === 'string' && u.trim() !== '').slice(0, D.official.maxUrls)
      if (urls.length === 0) {
        t.notes.push('没给官方页面 ⇒ 跳过（**官方域名不能猜**，猜出来的是假权威）')
        notes.push('[官方] 没给官方页面 ⇒ 跳过（官方域名不猜）')
      } else {
        t.attempted = true
        for (const u of urls) {
          const c = await take(u, 'official', D.official.subpages, 'user-provided')
          t.chars += c
          if (c > 0) t.sources++
          if (cumulative() >= D.enoughChars) break
        }
        t.notes.push(`抓了 ${t.sources}/${urls.length} 个官方页面，共 ${t.chars} 字`)
      }
    }

    // ─────── ② 社区 Wiki ───────
    if (id === 'community') {
      const bases = asArray(o.communityBases).filter((u) => typeof u === 'string' && u.trim() !== '').slice(0, D.community.maxSites)
      if (bases.length === 0) {
        t.notes.push('没配社区 Wiki 站点 ⇒ 跳过（可以按游戏加 Fandom / wiki.gg / 萌娘等的站点地址）')
        notes.push('[社区 Wiki] 没配站点 ⇒ 跳过')
      } else if (!o.name) {
        t.notes.push('没有角色名 ⇒ 无法在社区 Wiki 里检索')
        notes.push('[社区 Wiki] 没有角色名 ⇒ 跳过')
      } else {
        t.attempted = true
        for (const siteBase of bases) {
          if (cumulative() >= D.enoughChars) break
          const searchUrl = mediawikiSearchUrl(siteBase, o.name, { limit: D.community.searchLimit })
          if (!searchUrl) { t.notes.push(`站点地址不像 MediaWiki：${siteBase}`); continue }
          if (D.delayMs > 0) await sleep(D.delayMs)
          let found = []
          try {
            const res = await (o.fetchImpl ?? globalThis.fetch)(searchUrl, { headers: { accept: 'application/json' } })
            if (!res || res.ok !== true) throw new Error(`HTTP ${res?.status ?? '?'}`)
            found = parseOpenSearch(await res.text())
          } catch (e) {
            t.notes.push(`${siteBase} 检索失败：${e.message}`)
            notes.push(`[社区 Wiki] ${siteBase} 检索失败：${e.message}`)
            continue
          }
          if (found.length === 0) { t.notes.push(`${siteBase} 里没搜到「${o.name}」`); continue }
          const c = await take(found[0].url, 'community', D.community.subpages, `mediawiki:${siteBase}`)
          t.chars += c
          if (c > 0) { t.sources++; t.notes.push(`${siteBase} → ${found[0].title}`) }
        }
        t.notes.push(`社区 Wiki 共 ${t.sources} 个站点有料，合计 ${t.chars} 字`)
      }
    }

    // ─────── ③ 搜索（兜底） ───────
    if (id === 'search') {
      if (o.enableSearch === false) {
        t.notes.push('调用方关掉了搜索引擎这一级')
        notes.push('[搜索] 调用方关掉了这一级 ⇒ 跳过')
      } else {
        const query = o.query ?? buildSearchQuery({ name: o.name, game: o.game })
        const searchUrl = buildSearchUrl(query, { template: o.searchTemplate ?? DEFAULT_SEARCH_TEMPLATE })
        if (!searchUrl) {
          t.notes.push('搜索模板不合法（必须含 {q}）')
          notes.push('[搜索] 模板不合法 ⇒ 跳过')
        } else {
          t.attempted = true
          if (D.delayMs > 0) await sleep(D.delayMs)
          let html = ''
          try {
            const res = await (o.fetchImpl ?? globalThis.fetch)(searchUrl, { headers: { accept: 'text/html' } })
            if (!res || res.ok !== true) throw new Error(`HTTP ${res?.status ?? '?'}`)
            html = await res.text()
          } catch (e) {
            t.notes.push(`搜索请求失败：${e.message}（搜索引擎会改版/限流，这条路径本就不保证可用）`)
            notes.push(`[搜索] 请求失败：${e.message}（搜索引擎会改版/限流，这条路径本就不保证可用）`)
          }
          const picks = html ? parseSearchResults(html, searchUrl, { name: o.name, game: o.game, max: D.search.maxResults }) : []
          if (html && picks.length === 0) t.notes.push('搜索结果里没挑出像角色资料页的链接')
          for (const pick of picks) {
            if (cumulative() >= D.enoughChars) break
            const c = await take(pick.url, 'search', D.search.subpages, `web:${pick.host}`)
            t.chars += c
            if (c > 0) t.sources++
          }
          t.notes.push(`搜索共取到 ${t.sources} 个页面，合计 ${t.chars} 字`)
        }
      }
    }

    tiers.push(t)
    // ★ 唯一的早停判据：**累计**达到阈值。拿到东西本身不算"够用"。
    if (cumulative() >= D.enoughChars) stoppedAt = id
  }

  // ─────── 合并（按级打标） ───────
  const good = sources.filter((s) => s.ok && s.text)
  if (good.length === 0) {
    return {
      ok: false, text: '', textPlain: '', chars: 0, sources: [], tiers, stoppedAt: null,
      notes: [...notes, '三级信源都没取到可用正文'],
      error: '三级信源都没取到可用正文',
    }
  }
  const text = renderTieredText(good)
  const textPlain = renderPlainText(good)
  const used = TIER_IDS.filter((id) => good.some((s) => s.tier === id))
  notes.push(`按顺序取用：${used.map((id) => tierLabel(id)).join(' → ')}；共 ${good.length} 页、${[...text].length} 字`)
  if (stoppedAt) {
    const cum = TIER_IDS.slice(0, TIER_IDS.indexOf(stoppedAt) + 1).reduce((a, id) => a + charsOf(id), 0)
    notes.push(`累计到「${tierLabel(stoppedAt)}」这一级已达 ${cum} 字（阈值 ${D.enoughChars}）⇒ 没有再去问下一级`)
  } else {
    notes.push('三级都试过了（没有哪一级让累计材料达到"够用"）')
  }

  return {
    ok: true, text, textPlain, chars: [...text].length,
    sources: good.map((s) => ({ tier: s.tier, url: s.url, title: s.title, chars: s.chars, role: s.role })),
    tiers, stoppedAt, notes, error: null,
  }
}

/**
 * 把各页正文按级打标合并。同一级内按取用顺序。
 * 标注形如 `【官方 · 霞 - 角色介绍】`，既给人看，也让 `locateTier` 能反查。
 *
 * ⚠ 这是**给人看与追溯**的版本。喂给填表/模型的必须是 `renderPlainText`
 *   —— 第一版把带标注的文本直接交给了填表流程，于是 soft.background 那个格子
 *   被填成了"【官方 · 霞 - 官方角色页】\n<整页原文>"，**标注头变成了卡片内容**。
 */
export function renderTieredText(sources) {
  const parts = []
  for (const s of sources) {
    const head = `【${tierLabel(s.tier)} · ${s.title ?? s.url}】`
    parts.push(`${head}\n${String(s.text).trim()}`)
  }
  return parts.join('\n\n')
}

/** 不带任何标注的纯正文（喂给填表/模型用）。 */
export function renderPlainText(sources) {
  return sources.map((s) => String(s.text).trim()).join('\n\n')
}

/**
 * ★ 反查一段文字出自哪一级。
 * 多级都含这句时**返回最高那级** —— "官方也这么说"与"只有论坛这么说"可信度不同。
 *
 * @param {string} mergedText gatherLore 的 text
 * @param {string} quote 待查文字（会先归一化空白与标点再比）
 * @returns {{tier:string|null, label:string|null, title:string|null}}
 */
export function locateTier(mergedText, quote) {
  const q = normalize(String(quote ?? ''))
  // 太短的串（一两个字）到处都能撞上，追出来的层级没有意义
  if (q.length < 4) return { tier: null, label: null, title: null }
  const blocks = splitTierBlocks(mergedText)
  for (const tier of TIER_IDS) {
    const hit = blocks.find((b) => b.tier === tier && normalize(b.text).includes(q))
    if (hit) return { tier, label: tierLabel(tier), title: hit.title }
  }
  return { tier: null, label: null, title: null }
}

/** 把合并文本切回"每级每页"的小块（给 locateTier 与界面用）。 */
export function splitTierBlocks(mergedText) {
  const out = []
  const s = String(mergedText ?? '')
  for (const m of s.matchAll(/^【([^·】]+) · ([^】]*)】$/gm)) {
    out.push({ label: m[1].trim(), title: m[2].trim(), start: m.index, headerLen: m[0].length })
  }
  for (let i = 0; i < out.length; i++) {
    const from = out[i].start + out[i].headerLen
    const to = i + 1 < out.length ? out[i + 1].start : s.length
    out[i].text = s.slice(from, to).trim()
    out[i].tier = TIER_IDS.find((id) => tierLabel(id) === out[i].label) ?? 'unknown'
  }
  return out
}

const normalize = (s) => String(s).replace(/[\s\u00a0\u3000，。、！？；：,.!?;:'"「」『』（）()【】\[\]…—–~〜～·]+/g, '')

/** URL 归一化（去尾斜杠、去 fragment、大小写无关），用于跨级去重。 */
export function urlKey(url) {
  try {
    const u = new URL(String(url))
    u.hash = ''
    const s = u.toString()
    return (s.endsWith('/') ? s.slice(0, -1) : s).toLowerCase()
  } catch { return String(url ?? '').trim().toLowerCase() }
}

/**
 * 只接受数组。**传字符串时按"一个元素"处理**，而不是让 `.filter` 崩掉 ——
 * 界面与 LLM 工具都可能把单个 URL 直接传成字符串（实测踩过）。
 */
function asArray(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return v.trim() === '' ? [] : [v]
  return []
}

/** 给界面用：这次取用过程的逐级摘要（一行一级）。 */
export function describeGather(result) {
  if (!result) return ''
  return (result.tiers ?? []).map((t) => {
    const mark = t.chars > 0 ? '✓' : (t.attempted ? '·' : '—')
    return `${mark} ${t.label}：${t.chars} 字${t.sources ? `（${t.sources} 页）` : ''}`
  }).join('\n')
}

export { SOURCE_TIERS, TIER_IDS, tierLabel, tierById, classifySource }
