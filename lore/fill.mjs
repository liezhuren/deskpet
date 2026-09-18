// lore/fill.mjs —— ★ 填表式生成角色卡（用户的明确要求）
//
// ═══════════════════════════════════════════════════════════════════
// 用户原话：「我想要一个规范的角色卡格式，不要让 llm 即兴生成，
//            而是让他类似于填表一样地生成角色卡。」
// ═══════════════════════════════════════════════════════════════════
// 之前的做法是让模型输出一段"提议数组" —— 那正是**即兴生成**：
// 模型自己决定有哪些字段、叫什么、什么结构，每次跑出来的形状都可能不同。
// 现在的做法是**先出表、再填**：
//
//   ① `blankForm()`（来自 core/card-spec.mjs）—— 格子由 spec 定死
//   ② 把空表 + 原文交给模型 —— 它的职责只是**把值填进已有的格子**
//   ③ `parseFilledForm()` —— 逐格解析；**出现未登记的格子直接拒**（这就是"不许即兴"）
//   ④ 逐格按 spec 校验类型 / 枚举 / 范围
//   ⑤ hard 层的格子**必须带 quote**，且 quote 必须真的能在原文里找到（verifyProposals）
//   ⑥ 每一步的结果都带状态（blank / filled / rejected + 原因），由用户逐格确认
//
// ★ 「未登记的格子直接拒」是这套做法的关键：
//   模型如果自作主张加了 `persona.hard.favoriteColor`，那不是"顺便多存一个字段"，
//   而是**它绕过了格式**。必须显式拒掉并报出来，否则格式就形同虚设。
//
// 与 propose.mjs 的关系：那里面已经有"提议 + 证据核验 + 确认才写入"的机制，
// 本文件只是把**输入形状**从"数组"换成"表"，然后复用那套机制 —— 不重复实现。

import {
  FIELDS, FIELD_PATHS, fieldByPath, blankForm, readPath, writePath,
  modelFillablePaths, evidenceRequiredPaths, LAYER_DOC, CARD_VERSION,
} from '../core/card-spec.mjs'
import {
  verifyProposals, applyProposals, mergeProposals, proposeHeuristic,
} from './propose.mjs'
import { fetchWiki } from './fetch.mjs'

/** 表的格式标识（写进表里，便于识别与将来的迁移）。 */
export const FORM_FORMAT = `game-pet-agent/form@${CARD_VERSION}`

/** 一格的状态。 */
export const SLOT_STATUS = Object.freeze({
  BLANK: 'blank',        // 模型留了 null —— 这是**正确**行为（没依据就别填）
  FILLED: 'filled',      // 填了值，且过了校验
  REJECTED: 'rejected',  // 填了但有问题（未登记的格子 / 类型不对 / 证据找不到）
})

/**
 * ★ 出空表。格子由 spec 决定，模型没有机会决定"有哪些字段"。
 * 只包含 `fill === 'model'` 的字段 —— derived 与 user 的字段不该交给模型填。
 *
 * @returns {{_format:string, _instructions:string, slots:Record<string, null>}}
 */
export function fillForm() {
  const form = {
    _format: FORM_FORMAT,
    _instructions: [
      '把值填进下面已有的格子里。**不要新增格子、不要改格子名。**',
      '没有依据的格子留 null —— 留空是正确行为，编一个才是错的。',
      '标了「需出处」的格子必须写成 {"value": ..., "quote": "从原文里逐字复制的片段"}；',
      'quote 如果不能在原文里找到，这一格会被程序丢掉。',
      `格子说明：${Object.entries(LAYER_DOC).map(([k, v]) => `${k}=${v}`).join('；')}`,
    ].join('\n'),
    slots: {},
  }
  for (const path of modelFillablePaths) {
    const field = fieldByPath(path)
    form.slots[path] = {
      _fill: null,
      _type: field.type,
      _values: field.values ?? undefined,
      _evidence: field.evidence || undefined,
      _ask: field.ask || field.desc,
      _hint: field.hint || undefined,
    }
  }
  return form
}

/** 空表里"哪些格子需要什么"的清单（给提示词与界面共用）。 */
export function slotBriefs() {
  return modelFillablePaths.map((path) => {
    const f = fieldByPath(path)
    return { path, type: f.type, values: f.values, evidence: f.evidence, ask: f.ask || f.desc, hint: f.hint }
  })
}

/**
 * 把空表 + 原文渲染成提示词。**导出以便离线断言"到底发了什么"**。
 * @param {string} lore
 * @param {{name?:string, maxChars?:number}} [opts]
 */
export function buildFillPrompt(lore, opts = {}) {
  const form = fillForm()
  const briefs = slotBriefs()
  const lines = [
    '你的任务是**填表**，不是自由创作。下面是一张空的角色卡表格和一段原文。',
    opts.name ? `角色名：${opts.name}` : '',
    '',
    '规矩（按重要性排序）：',
    '1. **只填表里已有的格子**。不要新增格子，不要改格子名 —— 未登记的格子会被程序直接丢掉。',
    '2. **没有依据就留 null**。留空是正确行为；编一个听起来合理但原文没有的东西，会被证据核验挡下。',
    '3. 标了「需出处」的格子必须写成 {"value": <值>, "quote": "<从原文里逐字复制的片段>"}。',
    '   quote 必须能在原文里找到，且**至少 4 个字**（太短的引文证明不了任何事，会被丢掉）。',
    '   **不要改写、不要润色 quote** —— 要能逐字对上。',
    '4. 值的类型按 `_type` 来：string[] 就给数组，enum 只能取 `_values` 里的值。',
    '5. 只输出 JSON，形如 {"slots": {"<格子名>": {"value": ..., "quote": ...}}}。',
    '',
    '【表格】',
    JSON.stringify({ slots: Object.fromEntries(briefs.map((b) => [b.path, {
      _type: b.type, _values: b.values, _evidence: b.evidence || undefined, _ask: b.ask, _hint: b.hint,
    }])) }, null, 1),
    '',
    '【原文】',
    String(lore ?? '').slice(0, opts.maxChars ?? 8000),
    '',
    `（表格格式标识：${form._format}）`,
  ]
  return lines.filter((x) => x !== '').join('\n')
}

/**
 * 解析模型填好的表。
 *
 * 宽容与严格并存：
 *   · 宽容 —— 允许包在代码块里；允许省略 value 直接给字面量；允许 string[] 处给单个字符串
 *   · 严格 —— **未登记的格子直接进 rejected**（不许即兴），值超范围也拒
 *
 * @returns {{ok:boolean, slots:Record<string,object>, rejected:Array, blank:number, error:string|null}}
 */
export function parseFilledForm(text) {
  const json = extractJson(text)
  if (!json.ok) return { ok: false, slots: {}, rejected: [], blank: 0, error: json.error }
  const rawSlots = json.value?.slots ?? (looksLikeSlots(json.value) ? json.value : null)
  if (!rawSlots || typeof rawSlots !== 'object' || Array.isArray(rawSlots)) {
    return { ok: false, slots: {}, rejected: [], blank: 0, error: '返回的 JSON 里没有 slots 对象' }
  }

  const slots = {}
  const rejected = []
  let blank = 0

  for (const [key, raw] of Object.entries(rawSlots)) {
    // 表里自带的说明字段（_type/_ask 之类）忽略掉 —— 有些模型会把它们抄回来
    if (key.startsWith('_')) continue

    const field = fieldByPath(key)
    if (!field) {
      // ★ 关键：未登记的格子**显式拒掉并报出来**，不静默忽略
      rejected.push({ path: key, reason: '未登记的格子 —— 格式由 spec 定死，模型不能自己加字段', value: describeRaw(raw) })
      continue
    }
    if (field.fill !== 'model') {
      rejected.push({ path: key, reason: `这一格不是给模型填的（fill=${field.fill}）`, value: describeRaw(raw) })
      continue
    }

    const { value, quote, hadValue } = unpackSlot(raw)
    if (!hadValue || value === null || (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'string' && value.trim() === '') ||
        (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) {
      blank++                                   // 留空是正确行为，不记为失败
      continue
    }

    if (field.evidence && (!quote || [...String(quote).trim()].length < 4)) {
      rejected.push({ path: key, reason: '这一格需要出处（quote），但没给或太短', value: value })
      continue
    }

    const coerced = coerceValue(field, value)
    if (!coerced.ok) { rejected.push({ path: key, reason: coerced.reason, value }); continue }

    slots[key] = { value: coerced.value, quote: quote ? String(quote).trim() : null, path: key }
  }

  return { ok: true, slots, rejected, blank, error: null }
}

/**
 * ★ 把填好的表落成"提议 → 确认 → 写入"。
 *
 * @param {object} card
 * @param {{slots:object}} parsed       parseFilledForm 的结果
 * @param {string} lore                 原文（用于证据核验）
 * @param {Record<string, boolean>} confirmed 逐格确认（key = 格子路径）
 * @returns {{card:object, applied:number, skipped:number, proposals:Array, rejected:Array, notes:string[]}}
 */
export function applyFilledForm(card, parsed, lore, confirmed = {}) {
  const notes = []
  const slots = parsed?.slots ?? {}
  const proposals = Object.entries(slots).map(([path, s]) => ({
    key: path,
    field: fieldNameOf(path),
    value: s.value,
    evidence: s.quote ?? '',
    confidence: evidenceRequiredPaths.includes(path) ? 0.9 : 0.6,
    source: 'form',
    path,
  }))

  // hard 层的格子走证据核验（soft 层不参与校验，不需要出处）
  const needEvidence = proposals.filter((p) => evidenceRequiredPaths.includes(p.path))
  const noEvidence = proposals.filter((p) => !evidenceRequiredPaths.includes(p.path))
  const { accepted, rejected } = verifyProposals(needEvidence, lore)
  if (rejected.length) {
    notes.push(`⚠ 拒掉了 ${rejected.length} 格：出处不成立`)
    for (const r of rejected) notes.push(`  · ${r.path}（${r.reason}）`)
  }

  const ok = [...noEvidence, ...accepted]
  const { card: next, applied, skipped } = applyProposals(card, ok, confirmed)

  // 气质这一格会改 animation，而 applyProposals 是按 field 名分派的 —— 这里补一句说明
  if (notes.length === 0) notes.push(`${ok.length} 格通过校验，等待确认`)
  return { card: next, applied, skipped, proposals: ok, rejected, notes }
}

/**
 * ★ 一条龙：出表 → 填表（模型或启发式）→ 解析 → 校验。
 * **不写入任何东西** —— 返回的是带状态的、等待用户确认的结果。
 *
 * @param {object} p
 * @param {object} p.card
 * @param {string} p.lore
 * @param {object} [p.provider]  有 generate/available 就用模型填；否则用启发式
 * @param {boolean} [p.forceHeuristic]
 * @returns {Promise<{form:object, parsed:object|null, proposals:Array, rejected:Array, source:string, notes:string[]}>}
 */
export async function fillCardForm(p = {}) {
  const map = fillForm()
  const notes = []
  const lore = String(p?.lore ?? '')
  if (lore.trim() === '') {
    return { form: map, parsed: null, proposals: [], rejected: [], source: 'none', notes: ['没有原文可填'] }
  }

  const useModel = !p.forceHeuristic && p.provider && typeof p.provider.generate === 'function'
    && (typeof p.provider.available !== 'function' || p.provider.available())

  if (useModel) {
    let text
    try {
      const prompt = buildFillPrompt(lore, { name: p.name })
      const out = await p.provider.generate({ prompt, rawPrompt: prompt })
      text = typeof out === 'string' ? out : out?.text
    } catch (e) {
      notes.push(`模型填表失败：${e.message} ⇒ 退回启发式`)
      const h = heuristicFill(map, lore)
      return { form: map, parsed: null, proposals: h.proposals, rejected: h.rejected, source: 'heuristic', notes: [...notes, ...h.notes] }
    }
    const parsed = parseFilledForm(text)
    if (!parsed.ok) {
      notes.push(`模型返回的表解析不了：${parsed.error} ⇒ 退回启发式`)
      const h = heuristicFill(map, lore)
      return { form: map, parsed: null, proposals: h.proposals, rejected: h.rejected, source: 'heuristic', notes: [...notes, ...h.notes] }
    }
    if (parsed.rejected.length) {
      notes.push(`模型填了 ${parsed.rejected.length} 处不合格的格子：`)
      for (const r of parsed.rejected.slice(0, 5)) notes.push(`  · ${r.path}：${r.reason}`)
    }
    notes.push(`模型填了 ${Object.keys(parsed.slots).length} 格，留空 ${parsed.blank} 格（留空是正确行为）`)
    const built = applyFilledForm(p.card ?? null, parsed, lore, {})
    return {
      form: map, parsed,
      proposals: built.proposals,
      rejected: [...parsed.rejected, ...built.rejected],
      source: 'model',
      notes: [...notes, ...built.notes],
    }
  }

  notes.push(p.forceHeuristic ? '按请求使用启发式填表' : '没有可用的模型 ⇒ 用启发式填表')
  const h = heuristicFill(map, lore)
  return { form: map, parsed: null, proposals: h.proposals, rejected: h.rejected, source: 'heuristic', notes: [...notes, ...h.notes] }
}

/**
 * ★ Wiki 管线接进填表流程：抓页面（含子页）→ 合并 → 出表并填。
 *
 * 只是把 `fetchWiki` 与 `fillCardForm` 组合起来，**不重复实现任何一步** ——
 * 于是"抓取"与"填表"各自的行为与边界仍然只有一处定义。
 * 抓不到正文时**不硬凑**：直接把失败原因带回去，让界面显示"这一页没抓到"。
 *
 * @param {{url:string, card?:object, provider?:object, name?:string, forceHeuristic?:boolean,
 *          fetchImpl?:Function, sleepImpl?:Function, wiki?:object}} p
 * @returns {Promise<object>} 同 fillCardForm，另加 `wiki` 字段（逐页的成功/失败与说明）
 */
export async function fillCardFromWiki(p = {}) {
  const o = (p && typeof p === 'object') ? p : {}
  const fetched = await fetchWiki(o.url, {
    ...(o.wiki && typeof o.wiki === 'object' ? o.wiki : {}),
    name: o.name ?? o.card?.name,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.sleepImpl ? { sleepImpl: o.sleepImpl } : {}),
  })
  if (!fetched.ok) {
    return {
      form: fillForm(), parsed: null, proposals: [], rejected: [],
      source: 'none', wiki: fetched,
      notes: [`Wiki 抓取没拿到正文：${fetched.error}`, ...fetched.notes],
    }
  }
  const filled = await fillCardForm({
    lore: fetched.text,
    card: o.card,
    provider: o.provider,
    name: o.name ?? o.card?.name,
    forceHeuristic: o.forceHeuristic === true,
  })
  return { ...filled, wiki: fetched, notes: [...fetched.notes, ...filled.notes] }
}

/** 启发式填表：把 proposeHeuristic 的输出**投影到同一张表上**，于是两条路下游完全一致。 */
function heuristicFill(map, lore) {
  const notes = []
  const { proposals, notes: hNotes } = proposeHeuristic({ lore })
  for (const n of hNotes) notes.push(n)
  const toPath = {
    speechTics: 'persona.hard.speechTics', forbiddenWords: 'persona.hard.forbiddenWords',
    addresses: 'persona.hard.addresses', avgLength: 'persona.hard.avgLength',
    temperament: 'animation.temperament',
  }
  const grouped = {}
  const rejected = []
  for (const prop of proposals) {
    const path = toPath[prop.field]
    if (!path || !modelFillablePaths.includes(path)) { rejected.push({ path: prop.field, reason: '启发式抽到的字段没有对应的格子' }); continue }
    if (path.endsWith('speechTics') || path.endsWith('forbiddenWords')) {
      const cur = grouped[path]
      grouped[path] = { value: [...(cur?.value ?? []), prop.value], quote: cur?.quote ?? prop.evidence, path }
    } else {
      grouped[path] = { value: prop.value, quote: prop.evidence, path }
    }
  }

  // ★ soft 层也要填：用户粘过来的原文应当**原样**进 background。
  //   不填的话，"填表"出来的卡 soft 层是空的，模型就没有表达依据了。
  //   出处用原文的第一句 —— 它必然在原文里，所以证据核验一定通过（这是它的正当性，不是绕过）。
  const trimmed = String(lore).trim()
  if (trimmed !== '' && !grouped['persona.soft.background']) {
    grouped['persona.soft.background'] = { value: trimmed.slice(0, 1200), quote: firstSentence(trimmed), path: 'persona.soft.background' }
  }
  // 性格与说话风格：只在启发式**确实命中标记**时填（没命中就留空，不硬填）
  if (!grouped['persona.soft.personality']) {
    const s = firstSentenceMatching(trimmed, /(?:性格|为人|脾气|开朗|内向|冷静|高冷|温柔|毒舌)/)
    if (s) grouped['persona.soft.personality'] = { value: s, quote: s, path: 'persona.soft.personality' }
  }
  if (!grouped['persona.soft.speechStyle']) {
    const s = firstSentenceMatching(trimmed, /(?:说话|语气|口吻|话少|话多|寡言|简短|絮叨|敬语)/)
    if (s) grouped['persona.soft.speechStyle'] = { value: s, quote: s, path: 'persona.soft.speechStyle' }
  }

  notes.push(`启发式填了 ${Object.keys(grouped).length} 格（置信度都不高，请逐格确认）`)
  return {
    proposals: Object.values(grouped).map((s) => ({
      key: s.path, field: fieldNameOf(s.path), value: s.value, evidence: s.quote ?? '',
      confidence: 0.5, source: 'heuristic', path: s.path,
    })),
    rejected,
    filled: grouped,
    notes,
  }
}

function firstSentence(text) {
  return String(text).split(/[\n。！？!?]/).map((s) => s.trim()).find((s) => s.length >= 4) ?? String(text).slice(0, 40)
}

function firstSentenceMatching(text, re) {
  return String(text).split(/[\n。！？!?]/).map((s) => s.trim()).find((s) => s.length >= 4 && re.test(s)) ?? null
}

// ---------- 内部 ----------

function fieldNameOf(path) {
  if (path === 'animation.temperament') return 'temperament'
  return path.split('.').pop()
}

function looksLikeSlots(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  return Object.keys(o).some((k) => FIELD_PATHS.includes(k))
}

/** 从各种可能的返回形状里取出 JSON 对象。 */
function extractJson(text) {
  let s = String(text ?? '').trim()
  if (s === '') return { ok: false, error: '模型返回了空内容' }
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: '返回里没有 JSON 对象' }
  try {
    return { ok: true, value: JSON.parse(s.slice(start, end + 1)) }
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e.message}` }
  }
}

/**
 * 一格可能是三种写法，都认：
 *   { value, quote }        标准
 *   { _fill: v, quote }     照抄了表结构（模型很爱这么干）
 *   直接给字面量            偷懒写法
 */
function unpackSlot(raw) {
  if (raw === null || raw === undefined) return { value: null, quote: null, hadValue: false }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, quote: null, hadValue: true }
  const hasValueKey = 'value' in raw || '_fill' in raw
  if (!hasValueKey) return { value: raw, quote: raw.quote ?? null, hadValue: true }
  const v = 'value' in raw ? raw.value : raw._fill
  return { value: v, quote: raw.quote ?? raw.evidence ?? null, hadValue: v !== null && v !== undefined }
}

/** 按 spec 做**保守**类型收敛：只接受无歧义的修正，其余拒掉。 */
function coerceValue(field, value) {
  switch (field.type) {
    case 'string':
      if (typeof value === 'string') return { ok: true, value: value.trim() }
      return { ok: false, reason: `需要字符串，收到 ${typeName(value)}` }
    case 'string[]': {
      // 单个字符串 ⇒ 包成一元素数组（这是模型最常见的笔误，且无歧义）
      if (typeof value === 'string') return { ok: true, value: [value.trim()] }
      if (!Array.isArray(value)) return { ok: false, reason: `需要字符串数组，收到 ${typeName(value)}` }
      if (value.some((x) => typeof x !== 'string')) return { ok: false, reason: '数组里必须全是字符串' }
      return { ok: true, value: value.map((x) => x.trim()).filter(Boolean) }
    }
    case 'enum': {
      if (typeof value !== 'string') return { ok: false, reason: `需要 ${field.values.join(' / ')} 之一，收到 ${typeName(value)}` }
      const hit = field.values.find((v) => v.toLowerCase() === value.trim().toLowerCase())
      if (!hit) return { ok: false, reason: `只能是 ${field.values.join(' / ')}，收到 ${JSON.stringify(value)}` }
      return { ok: true, value: hit }
    }
    case 'intRange': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: '需要 { min, max }' }
      const min = Number(value.min); const max = Number(value.max)
      if (!Number.isFinite(min) || !Number.isFinite(max)) return { ok: false, reason: '{ min, max } 必须是数字' }
      if (min > max) return { ok: false, reason: `min(${min}) 不能大于 max(${max})` }
      return { ok: true, value: { min, max } }
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: '需要对象' }
      return { ok: true, value }
    }
    case 'stringArrayMap': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: '需要 { 键: [词] }' }
      const out = {}
      for (const [k, arr] of Object.entries(value)) {
        if (typeof arr === 'string') { out[k] = [arr]; continue }
        if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) return { ok: false, reason: `${k} 必须是字符串数组` }
        out[k] = arr
      }
      return { ok: true, value: out }
    }
    default:
      return { ok: true, value }
  }
}

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const describeRaw = (v) => (typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60))

export { blankForm, readPath, writePath, mergeProposals }
