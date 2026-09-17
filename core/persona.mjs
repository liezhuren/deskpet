// core/persona.mjs —— 人格状态机 + 对话校验器（本项目核心，纯逻辑零依赖）
//
// 为什么这是核心（见 docs/HANDOFF.md §1）：
//   这个项目的真问题不是"能不能生成角色卡"，而是**怎么证明角色没跑偏**。
//   提示词是概率约束，本模块提供的是**硬约束**：
//     · 状态机 → "此刻角色处于什么状态"（确定性，模型不许改）
//     · 校验器 → "这句话违不违规"（可统计、可回归、可拒绝）
//
// 分工铁律：
//   core（本文件）= 事实与约束   |   dialogue/（模型） = 只负责表达
//   模型不得发明剧情、不得改状态。它产出的文本必须过 lintDialogue。

import { EVENT_KINDS } from './events.mjs'

/** 状态初值（相对中立，不预设性格） */
const NEUTRAL = Object.freeze({ mood: 0, affinity: 0.3 })

/**
 * 初始化人格状态。`seed.affinity` 可让角色一开始就更亲近/更疏远。
 * @param {object} card - 经 normalizeCard 的卡
 * @param {{mood?:number, affinity?:number}} [seed]
 */
export function initState(card, seed = {}) {
  return {
    cardId: card.id,
    name: card.name,
    // mood:     -1 低落 … 0 平静 … +1 高涨
    // affinity:  0 疏远 … 1 亲近（决定称呼与主动程度）
    mood: clamp(seed.mood ?? NEUTRAL.mood, -1, 1),
    affinity: clamp(seed.affinity ?? NEUTRAL.affinity, 0, 1),
    progress: { kind: 'unknown', note: null }, // 剧情进度（来自 progress 事件）
    flags: {},                                 // 角色专属状态位（见 markFlag）
    turns: 0,                                  // 已对话轮数
    log: [],                                   // 近期事件（有上限，见 MAX_LOG）
  }
}

const MAX_LOG = 50

/**
 * 把事件作用到状态上。**这是唯一允许改状态的入口** —— 模型不得直接改。
 *
 * 影响规则（有意做得简单、可解释、可测试；复杂情绪模型等有真实需要再加）：
 *   - 重要度越高的负面事件（death/combat 失败）压 mood 越狠
 *   - 正面事件（progress/item 达成）抬 mood
 *   - affinity 只被"互动"改变（对话轮数、被回应），不被战况改 —— 否则角色会显得势利
 * @param {object} state
 * @param {object} ev - 规范化事件
 * @returns {object} 新状态（不原地改，便于回放与测试）
 */
export function applyEvent(state, ev) {
  const s = clone(state)
  // 脏输入（null / 非对象）不该改状态，也不该抛 —— 状态机是唯一改状态的入口，
  // 它一崩整条链路就断了。原版在这里写 `ev.at`，传 null 会直接 TypeError。
  if (!ev || typeof ev !== 'object') return s
  const imp = Number.isFinite(ev.importance) ? ev.importance : 0
  switch (ev?.kind) {
    case 'death':
      s.mood = clamp(s.mood - 0.5 * imp, -1, 1)
      break
    case 'combat':
      // 战斗默认按"受挫"计（adapter 可在 data.outcome 里说明胜负）
      s.mood = clamp(s.mood + (ev.data?.outcome === 'win' ? 0.25 * imp : -0.25 * imp), -1, 1)
      break
    case 'progress':
      s.mood = clamp(s.mood + 0.35 * imp, -1, 1)
      s.progress = { kind: 'progress', note: ev.text }
      break
    case 'area':
      s.progress = { kind: 'area', note: ev.text }
      break
    case 'item':
      s.mood = clamp(s.mood + 0.15 * imp, -1, 1)
      break
    default:
      break // dialogue / system 不改 mood
  }
  s.log = [...state.log, {
    at: ev.at ?? null,
    kind: ev.kind,
    text: String(ev.text ?? ''),
    importance: imp,
  }].slice(-MAX_LOG)
  return s
}

/** 顺序回放一批事件。 */
export function applyEvents(state, events = []) {
  return events.reduce((acc, e) => applyEvent(acc, e), state)
}

/** 记一个状态位（如 "已表白" / "知道她是公主"）—— 供条件化台词用。 */
export function markFlag(state, key, value = true) {
  const s = clone(state)
  s.flags = { ...s.flags, [key]: value }
  return s
}

/** 对话轮数 +1（会被 affinity 使用，故单独一个入口，语义清楚）。 */
export function countTurn(state, { affinityGain = 0.02 } = {}) {
  const s = clone(state)
  s.turns = state.turns + 1
  s.affinity = clamp(s.affinity + affinityGain, 0, 1)
  return s
}

/**
 * 当前该用哪个称呼 —— **确定性**，不交给模型猜。
 * 规则：hard.addresses 里优先精确键；否则按 affinity 分档（越亲近越随意）。
 */
export function addressFor(state, card, target = 'player') {
  const map = card?.persona?.hard?.addresses ?? {}
  if (map[target]) return { text: map[target], from: 'card' }
  if (state.affinity >= 0.7) return { text: '你', from: 'affinity-high' }
  if (state.affinity >= 0.4) return { text: '你', from: 'affinity-mid' }
  return { text: '您', from: 'affinity-low' }
}

/**
 * 把状态渲染成给模型看的**一段事实**（而非让模型自己推导）。
 * 这段文本是"模型唯一的事实来源" —— 它不许在这之外发明剧情。
 */
export function describeState(state, card) {
  const moodWord = state.mood > 0.4 ? '心情不错' : state.mood < -0.4 ? '情绪低落' : '情绪平稳'
  const relWord = state.affinity >= 0.7 ? '很亲近' : state.affinity >= 0.4 ? '逐渐熟络' : '还比较生疏'
  const addr = addressFor(state, card)
  const lines = [
    `角色：${card.name}`,
    `当前${moodWord}（mood=${state.mood.toFixed(2)}），与玩家${relWord}（affinity=${state.affinity.toFixed(2)}）`,
    `称呼玩家：「${addr.text}」（按角色卡指定，不要改）`,
  ]
  if (state.progress.note) lines.push(`剧情进度：${state.progress.note}`)
  const flags = Object.entries(state.flags).filter(([, v]) => v).map(([k]) => k)
  if (flags.length) lines.push(`已知事实：${flags.join('、')}`)
  const recent = state.log.slice(-3).map((l) => `- [${l.kind}] ${l.text}`)
  if (recent.length) lines.push('最近发生：', ...recent)
  return lines.join('\n')
}

// ---------- 对话校验器 ----------

/**
 * 校验模型产出的一句话。
 *
 * 分级：
 *   error   —— 明确违规（打回重试），计入违规率
 *   warning —— 风格偏离（不阻断，但要计入统计）
 *
 * 检查项与来源：
 *   forbiddenWords → error    出现即违规
 *   avgLength      → error    超出区间（这是硬约束：太长的角色扮演最劝退）
 *   emojiPolicy    → error    none 出现表情 / require 没有表情
 *   mustMention    → error    卡里声明了"该场景必须提到的词"却一个都没出现
 *   addresses      → warning  卡片指定了称呼但整句没用到
 *   speechTics     → warning  单句没口癖是正常的，**不判 error**（否则每句都报）
 *
 * ⚠ `mustMention` 需要 `ctx.triggerKind` 才知道该查哪一组词 ——
 *   不传就跳过。**这里曾经是个缺口**：card.mjs 定义了 mustMention 并校验了它的形状，
 *   但校验器从来没检查过它，于是"卡里声明了硬约束、实际没人执行"。
 *   这类"schema 承诺了、实现没做"的缺口不会报错，只会让卡看起来比实际更严。
 *
 * @param {string} text - 模型产出
 * @param {object} card - 角色卡
 * @param {object} [ctx] - { state, triggerKind?: string, expectTics?: boolean }
 * @returns {{ ok:boolean, errors:Array, warnings:Array, stats:object }}
 */
export function lintDialogue(text, card, ctx = {}) {
  const t = String(text ?? '')
  const h = card?.persona?.hard ?? {}
  const errors = []
  const warnings = []

  // 1) 禁用词
  for (const w of h.forbiddenWords ?? []) {
    if (w && t.includes(w)) errors.push({ rule: 'forbiddenWords', detail: `出现禁用词「${w}」` })
  }

  // 2) 长度（按字符数，中文语境下 >100 字的角色扮演回复基本读不完）
  const len = [...t].length
  const a = h.avgLength
  if (a) {
    if (len < a.min) errors.push({ rule: 'avgLength', detail: `过短：${len} 字 < ${a.min}` })
    if (len > a.max) errors.push({ rule: 'avgLength', detail: `过长：${len} 字 > ${a.max}` })
  }

  // 3) 表情策略（表情符号用码点区间判，不依赖正则库）
  const emojiCount = countEmoji(t)
  if (h.emojiPolicy === 'none' && emojiCount > 0) {
    errors.push({ rule: 'emojiPolicy', detail: `出现 ${emojiCount} 个表情，但策略是 none` })
  }
  if (h.emojiPolicy === 'require' && emojiCount === 0) {
    errors.push({ rule: 'emojiPolicy', detail: '策略是 require，但没出现表情' })
  }

  // 4) 称呼（warning：偶尔省略是自然的）
  const addr = ctx.state ? addressFor(ctx.state, card) : null
  if (addr && Object.keys(h.addresses ?? {}).length && !t.includes(addr.text)) {
    warnings.push({ rule: 'addresses', detail: `未出现卡片指定的称呼「${addr.text}」` })
  }

  // 5) 场景必提词（error：这是卡里明确声明的硬约束）
  if (ctx.triggerKind && h.mustMention && typeof h.mustMention === 'object') {
    const words = h.mustMention[ctx.triggerKind]
    if (Array.isArray(words) && words.length > 0) {
      const hitAny = words.some((w) => typeof w === 'string' && w && t.includes(w))
      if (!hitAny) {
        errors.push({
          rule: 'mustMention',
          detail: `场景 ${ctx.triggerKind} 要求提到 ${words.map((w) => `「${w}」`).join(' 或 ')}，但都没出现`,
        })
      }
    }
  }

  // 6) 口癖（warning；批级统计由 lintBatch 负责）
  const tics = (h.speechTics ?? []).filter(Boolean)
  const hitTics = tics.filter((x) => t.includes(x))
  if (tics.length && hitTics.length === 0) {
    warnings.push({ rule: 'speechTics', detail: `未出现任何口癖（共 ${tics.length} 个）` })
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { length: len, emoji: emojiCount, ticsHit: hitTics },
  }
}

/**
 * 批量校验 —— **这才是量化"这版提示词比上版好多少"的地方**。
 * 单句没口癖不算问题；一批回复里口癖从不出现才是问题。
 * @param {string[]} lines
 */
export function lintBatch(lines = [], card, ctx = {}) {
  const results = lines.map((l) => lintDialogue(l, card, ctx))
  const n = Math.max(lines.length, 1)
  const errCount = results.reduce((s, r) => s + r.errors.length, 0)
  const ticRate = results.filter((r) => r.stats.ticsHit.length > 0).length / n
  const byRule = {}
  for (const r of results) {
    for (const e of r.errors) byRule[e.rule] = (byRule[e.rule] ?? 0) + 1
    for (const w of r.warnings) byRule[w.rule] = (byRule[w.rule] ?? 0) + 1
  }
  return {
    count: lines.length,
    passRate: results.filter((r) => r.ok).length / n, // 无 error 的比例
    errorRate: errCount / n,                          // 平均每句 error 数
    ticRate,                                          // 含口癖的句子比例
    byRule,
    results,
  }
}

// ---------- 内部 ----------

const clamp = (v, lo, hi) => Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi)

const clone = (s) => ({
  ...s,
  progress: { ...s.progress },
  flags: { ...s.flags },
  log: [...s.log],
})

/** 粗判表情：常见 emoji 码点区间 + 变体选择符。够用即可，不追求 Unicode 全表。 */
function countEmoji(s) {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (
      (c >= 0x1f300 && c <= 0x1faff) || // 表情/符号/补充符号
      (c >= 0x2600 && c <= 0x27bf) ||   // 杂项符号与装饰
      c === 0xfe0f                        // 变体选择符
    ) n++
  }
  return n
}

export { EVENT_KINDS }
