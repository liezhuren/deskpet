// lore/propose.mjs —— 从角色介绍里**提议** hard 约束（提议 ≠ 生效）
//
// ═══════════════════════════════════════════════════════════════════
// ★ 立场：模型只提议，不注入（与 app/cardgen.mjs 文件头同一条底线）
// ═══════════════════════════════════════════════════════════════════
// 「从介绍里抽出口癖/禁用词」这件事本身是合理的 —— 但抽出来的东西会**被当成硬约束执行**：
// 一旦写进卡里，校验器就拿它判生死，桌宠会说/不说某些话。
// 所以如果抽取环节编了一条，你不但察觉不到，还会以为"卡里就是这么写的"。
//
// 因此有三个必须的闸门：
//   ① **证据核验**：每条提议都要附一段出处，**出处必须真的能在原文里找到**；
//      找不到的直接拒掉（verifyProposals）。这是防幻觉的硬机制，不是提示词里的叮嘱。
//   ② **永不自动应用**：propose* 只返回提议，写不写进卡由用户点确认（applyProposals 才写）。
//   ③ **两条路径**：没有模型时也能抽（启发式），只是置信度更低、覆盖更窄。
//
// 启发式刻意只做**有明确语言标记**的几类（见 MARKERS），因为它们的证据是可核对的；
// 那种"读完全篇猜性格"的事不做 —— 猜错了会被当成约束执行。

import { EXPRESSION_RULES } from '../dialogue/base.mjs'
import { fieldByPath, readPath, writePath, modelFillablePaths, FIELD_PATHS } from '../core/card-spec.mjs'

/**
 * 可以出现在提议里的**字段名**。
 *
 * ⚠ 这份清单**从 spec 派生**，不再手写。
 *   早先它是手写数组（且不含 soft 层的 background/personality/speechStyle），
 *   于是 `persona.soft.background` 这种**完全合法**的格子会被 verifyProposals
 *   判成"字段未登记"直接丢掉 —— 表现是"用户确认了、却没写进去，还不报错"。
 *
 * 这与 `core/card.mjs` 的 HARD_KEYS、`applyProposals` 的分派是**同一类错误的第三次**：
 * 引入唯一事实来源之后，必须把所有手写副本都找出来，否则漏掉的那一处就会静默失守。
 */
export const PROPOSABLE_FIELDS = Object.freeze([...new Set(modelFillablePaths.map((p) => p.split('.').pop()))])

/** 老式提议（只有字段名、没有 path）→ 字段名反查路径。 */
const FIELD_TO_PATHS = Object.freeze(
  Object.fromEntries(PROPOSABLE_FIELDS.map((name) => [
    name,
    modelFillablePaths.filter((p) => p.split('.').pop() === name),
  ])),
)

/** 明确的语言标记 → 该提什么。每条都要能给出"句子级证据"。 */
const MARKERS = Object.freeze([
  {
    field: 'speechTics',
    // 口癖/口头禅的直接标记
    re: /(?:口癖|口头禅|常说|经常说|爱说|挂在嘴边|总会说|一句话)/,
    confidence: 0.85,
    note: '有"口癖/口头禅"这类明确标记',
  },
  {
    field: 'forbiddenWords',
    re: /(?:从不说|不会说|不说|忌口|禁用|绝口不提|从不叫|不会叫)/,
    confidence: 0.8,
    note: '有"从不说/不会叫"这类明确标记',
  },
  {
    field: 'addresses',
    re: /(?:称呼|叫作|叫他|叫她|管.{0,4}叫|称.{0,4}为)/,
    confidence: 0.75,
    note: '有"称呼/叫他"这类明确标记',
  },
])

/** 性格标记 → 气质（决定需要哪些动作）。 */
const TEMPERAMENT_MARKERS = Object.freeze([
  { id: 'lively', re: /(?:活泼|开朗|元气|外向|爱笑|话多|吵闹|热情)/, confidence: 0.7 },
  { id: 'cool', re: /(?:高冷|冷淡|冷漠|寡言|话少|沉默|内向|不爱说话|毒舌)/, confidence: 0.7 },
  { id: 'calm', re: /(?:冷静|沉稳|温和|平静|稳重|理性)/, confidence: 0.65 },
])

/** 长度标记 → 回复长度区间建议。 */
const LENGTH_MARKERS = Object.freeze([
  { max: 20, min: 4, re: /(?:话少|寡言|沉默|惜字如金|不爱说话|简短)/, confidence: 0.65 },
  { max: 60, min: 8, re: /(?:话多|絮叨|健谈|长篇大论|滔滔不绝)/, confidence: 0.65 },
])

/**
 * 启发式提议（不需要模型）。
 * @param {{lore:string, name?:string}} p
 * @returns {{proposals:Array, notes:string[]}}
 */
export function proposeHeuristic(p = {}) {
  const lore = String(p?.lore ?? '')
  const notes = []
  const out = []
  if (lore.trim() === '') return { proposals: [], notes: ['没有介绍文本可抽'] }

  const sentences = splitSentences(lore)

  // ① 引号里的短语 —— 在有明确标记的句子里才提为口癖（置信度高）
  for (const s of sentences) {
    for (const m of MARKERS) {
      if (!m.re.test(s)) continue
      const quoted = quotedPhrases(s)
      if (quoted.length === 0) continue
      for (const q of quoted) {
        if (m.field === 'addresses') {
          const target = /他|她|对方|玩家|主角/.test(s) ? 'player' : 'player'
          out.push(mk('addresses', { [target]: q }, s, m.confidence, `heuristic:${m.note}`))
        } else {
          out.push(mk(m.field, q, s, m.confidence, `heuristic:${m.note}`))
        }
      }
    }
  }

  // ② 光有引号、没有标记：低置信度地提为口癖候选（让用户自己判断）
  if (out.length === 0) {
    for (const s of sentences) {
      for (const q of quotedPhrases(s)) {
        if ([...q].length < 2 || [...q].length > 12) continue
        out.push(mk('speechTics', q, s, 0.35, 'heuristic:仅凭引号（置信度低，需人工确认）'))
      }
    }
  }

  // ③ 气质（决定需要哪些动作）
  for (const t of TEMPERAMENT_MARKERS) {
    const s = sentences.find((x) => t.re.test(x))
    if (s) out.push(mk('temperament', t.id, s, t.confidence, 'heuristic:性格标记'))
  }

  // ④ 长度建议
  for (const l of LENGTH_MARKERS) {
    const s = sentences.find((x) => l.re.test(x))
    if (s) out.push(mk('avgLength', { min: l.min, max: l.max }, s, l.confidence, 'heuristic:说话长度标记'))
  }

  if (out.length === 0) notes.push('启发式没抽出任何可提议的约束 —— 介绍里没有明显的语言标记（这很正常，接着人工填就行）')
  return { proposals: dedupe(out), notes }
}

/**
 * 用 LLM 提议。**要求每条都带 quote**，并逐条核验 quote 真的出现在原文里。
 *
 * @param {{lore:string, name?:string, provider:object, maxChars?:number}} p
 *        provider 需满足 `{ available(), generate(request) }`（见 dialogue/llm.mjs）
 * @returns {Promise<{proposals:Array, notes:string[], rejected:Array}>}
 */
export async function proposeWithLlm(p = {}) {
  const notes = []
  const lore = String(p?.lore ?? '')
  const provider = p.provider
  if (!provider || typeof provider.generate !== 'function') {
    return { proposals: [], notes: ['没有可用的 provider'], rejected: [] }
  }
  if (typeof provider.available === 'function' && !provider.available()) {
    return { proposals: [], notes: ['provider 不可用（没配 key？）—— 可以用启发式那条路'], rejected: [] }
  }
  if (lore.trim() === '') return { proposals: [], notes: ['没有介绍文本可抽'], rejected: [] }

  const prompt = buildProposalPrompt(lore, p.name, p.maxChars ?? 6000)
  let raw
  try {
    const out = await provider.generate({ prompt, rawPrompt: prompt })
    raw = typeof out === 'string' ? out : out?.text
  } catch (e) {
    return { proposals: [], notes: [`调用失败：${e.message}`], rejected: [] }
  }

  const parsed = parseProposals(raw)
  if (!parsed.ok) return { proposals: [], notes: [parsed.error], rejected: [] }

  const { accepted, rejected } = verifyProposals(parsed.proposals, lore)
  if (rejected.length) {
    notes.push(`⚠ 拒掉了 ${rejected.length} 条**证据在原文里找不到**的提议 —— 这就是防幻觉的那道闸门`)
    for (const r of rejected.slice(0, 3)) notes.push(`  · ${r.field}=${JSON.stringify(r.value)}（引文：${String(r.evidence).slice(0, 40)}…）`)
  }
  return { proposals: accepted, notes, rejected }
}

/**
 * ★ 证据核验：每条提议的 evidence 必须真的出现在原文里，否则拒掉。
 *
 * 判据刻意做得**保守**：
 *   · 归一化后（去空白与标点）做子串匹配 —— 允许原文里的空格/换行差异
 *   · evidence 太短（< 4 字）也拒 —— 否则一句"她"就能"证明"任何事
 * 这是本项目一贯的做法：**不信任模型的自述，只信可核对的证据**。
 *
 * @returns {{accepted:Array, rejected:Array}}
 */
export function verifyProposals(proposals, lore) {
  const hay = normalize(lore)
  const accepted = []
  const rejected = []
  for (const p of proposals ?? []) {
    if (!p || typeof p !== 'object') { rejected.push({ ...p, reason: '提议不是对象' }); continue }
    // ★ 有 path 就**按路径查 spec**（权威）；没有 path 才退回按字段名查。
    //   只看字段名会漏判 soft 层这类"字段名不带上下文"的情况。
    const known = p.path
      ? FIELD_PATHS.includes(p.path)
      : PROPOSABLE_FIELDS.includes(p.field) && (FIELD_TO_PATHS[p.field]?.length ?? 0) > 0
    if (!known) { rejected.push({ ...p, reason: p.path ? `路径 ${p.path} 未在 spec 登记` : `字段 ${p.field} 未登记` }); continue }
    const ev = String(p.evidence ?? '')
    const needle = normalize(ev)
    if ([...needle].length < 4) { rejected.push({ ...p, reason: '证据太短（<4 字），不足以证明' }); continue }
    if (!hay.includes(needle)) { rejected.push({ ...p, reason: '证据在原文里找不到' }); continue }
    accepted.push({ ...p, verified: true })
  }
  return { accepted, rejected }
}

/** 合并多条来源的提议（同字段同值去重，保留更高置信度）。 */
export function mergeProposals(...lists) {
  const map = new Map()
  for (const list of lists) {
    for (const p of list ?? []) {
      if (!p || !PROPOSABLE_FIELDS.includes(p.field)) continue
      const key = `${p.field}|${JSON.stringify(p.value)}`
      const prev = map.get(key)
      if (!prev || (p.confidence ?? 0) > (prev.confidence ?? 0)) map.set(key, p)
    }
  }
  return [...map.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
}

/**
 * ★ 把用户确认过的提议写进卡里。
 * **只接受布尔 true 的确认**，其余一律不写 —— 这样"没点确认"与"点了拒绝"都是安全默认。
 *
 * ⚠ 分派**按 spec 的字段路径**来，不再手写 switch。
 *   早先的 switch 只认得 hard 层那几个字段名，于是 soft 层（personality/speechStyle/background）
 *   被静默算成"跳过" —— 用户点了确认却没写进去，而且不报错。
 *   spec 既然已经是格式的唯一来源，这里就该从它派生：
 *   新增一个字段、两处都不用改。
 *
 * @param {object} card
 * @param {Array} proposals
 * @param {Record<string|number, boolean>} confirmed 按提议的 key（或下标）确认
 * @returns {{card:object, applied:number, skipped:number}}
 */
export function applyProposals(card, proposals, confirmed = {}) {
  // ⚠ 卡可能是 null —— "先生成、再填表"的流程里就是这样（还没有卡可写）。
  //   早先直接 structuredCloneish(card) 再取 .persona，于是传 null 就抛。
  //   这是一个"只提议、不注入"的纯函数，任何入参都不该让它崩。
  const next = (card && typeof card === 'object') ? structuredCloneish(card) : {}
  let applied = 0
  let skipped = 0
  const list = Array.isArray(proposals) ? proposals : []

  for (const [i, p] of list.entries()) {
    const key = p?.key ?? i
    if (confirmed[key] !== true) { skipped++; continue }

    const path = p?.path ?? PATH_BY_FIELD[p?.field]
    const field = path ? fieldByPath(path) : null
    if (!field || field.fill === 'derived') { skipped++; continue }

    const cur = readPath(next, path)
    switch (field.type) {
      case 'string[]': {
        const add = Array.isArray(p.value) ? p.value : [p.value]
        writePath(next, path, uniq([...(Array.isArray(cur) ? cur : []), ...add.filter((x) => x != null)].map(String)))
        break
      }
      case 'object':
      case 'stringArrayMap':
      case 'intRange': {
        if (!p.value || typeof p.value !== 'object') { skipped++; continue }
        writePath(next, path, { ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}), ...p.value })
        break
      }
      default:
        writePath(next, path, p.value)
    }
    applied++
  }

  // 确认过硬约束之后就不再是草稿 —— 界面据此停止"硬约束还没填"的提醒
  if (applied > 0) next.draft = false
  return { card: next, applied, skipped }
}

/** 字段名 → spec 路径（给没有 path 的老式提议兜底）。 */
const PATH_BY_FIELD = Object.freeze({
  speechTics: 'persona.hard.speechTics',
  forbiddenWords: 'persona.hard.forbiddenWords',
  addresses: 'persona.hard.addresses',
  avgLength: 'persona.hard.avgLength',
  emojiPolicy: 'persona.hard.emojiPolicy',
  mustMention: 'persona.hard.mustMention',
  temperament: 'animation.temperament',
  style: 'animation.style',
  personality: 'persona.soft.personality',
  background: 'persona.soft.background',
  speechStyle: 'persona.soft.speechStyle',
})

/** 给人看的一行摘要。 */
export function describeProposal(p) {
  const v = typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value)
  const c = Math.round((p.confidence ?? 0) * 100)
  return `[${p.field}] ${v}  （置信度 ${c}%）出处：${String(p.evidence).slice(0, 60)}`
}

/** 给 LLM 的提示词（导出以便离线断言"到底发了什么"）。 */
export function buildProposalPrompt(lore, name, maxChars = 6000) {
  const text = String(lore).slice(0, maxChars)
  return [
    '下面是一段游戏角色的官方介绍。请从中**抽取**能作为「硬约束」的要素。',
    name ? `角色名：${name}` : '',
    '',
    '要求：',
    '· 只输出 JSON，形如 {"proposals":[{"field":"speechTics","value":"……才不是","quote":"原文片段","confidence":0.8}]}',
    `· field 只能是这几个之一：${PROPOSABLE_FIELDS.join(' / ')}`,
    '· **每一条都必须带 quote**，且 quote 必须是从下面原文里**逐字复制的片段**；',
    '  找不到出处的条目会被程序拒掉，所以不要凭印象写。',
    '· 拿不准就不要提 —— 少提几条比编几条好得多。',
    '· speechTics 是口癖片段，forbiddenWords 是这个角色**绝不会说**的词，',
    '  addresses 形如 {"player":"你"}，avgLength 形如 {"min":4,"max":40}，',
    '  temperament 只能是 lively / calm / cool。',
    '',
    '【原文】',
    text,
  ].filter((x) => x !== '').join('\n')
}

/** 解析模型返回的 JSON（宽容：允许包在代码块里）。 */
export function parseProposals(raw) {
  let s = String(raw ?? '').trim()
  if (s === '') return { ok: false, error: '模型返回了空内容', proposals: [] }
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: '返回里没有 JSON 对象', proposals: [] }
  let json
  try {
    json = JSON.parse(s.slice(start, end + 1))
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e.message}`, proposals: [] }
  }
  const list = Array.isArray(json) ? json : json.proposals
  if (!Array.isArray(list)) return { ok: false, error: 'JSON 里没有 proposals 数组', proposals: [] }
  const proposals = list
    .filter((x) => x && typeof x === 'object')
    .map((x) => mk(x.field, x.value, x.quote ?? x.evidence ?? '', Number.isFinite(x.confidence) ? x.confidence : 0.5, 'llm'))
  return { ok: true, proposals, error: null }
}

// ---------- 内部 ----------

function mk(field, value, evidence, confidence, note) {
  return { field, value, evidence: String(evidence ?? '').trim(), confidence, source: note.startsWith('llm') ? 'llm' : 'heuristic', note }
}

/** 归一化：去空白与常见标点，用于证据核验。 */
function normalize(s) {
  return String(s ?? '').replace(/[\s\u00a0\u3000，。、！？；：,.!?;:'"「」『』（）()【】\[\]…—–~〜～·]+/g, '')
}

function quotedPhrases(s) {
  const out = []
  for (const m of String(s).matchAll(/[「『“"']([^」』”"']{1,24})[」』”"']/g)) out.push(m[1].trim())
  // 中文里「」成对出现；上面那条够用了，不再处理嵌套
  return out.filter((x) => x !== '')
}

function splitSentences(text) {
  return String(text).split(/[\n。！？!?；;]+/).map((s) => s.trim()).filter((s) => s !== '')
}

function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const p of list) {
    const k = `${p.field}|${JSON.stringify(p.value)}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
}

const uniq = (a) => [...new Set(a)]

function structuredCloneish(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v))
}

export { EXPRESSION_RULES }
