// app/cardgen.mjs —— 角色卡草稿生成 + 导入导出（纯逻辑，可单测）
//
// ═══════════════════════════════════════════════════════════════════
// ★ 这里有一条容易越界的底线：**不替用户编设定**
// ═══════════════════════════════════════════════════════════════════
// 「根据官方人设生成角色卡」听起来像"把一段介绍喂进去、让它自动抽出性格与口癖"。
// 但那正是本项目一直在防的事：模型（或任何启发式）**编出来的口癖会被当成硬约束执行**，
// 于是桌宠会说一些角色根本不会说的话 —— 而且你没法察觉，因为"卡里就是这么写的"。
//
// 所以这里的做法是：
//   · 用户给的文字 → 原样进 `soft`（自由描写，喂给模型，**不参与校验**）
//   · `hard`（会被机器校验的那一层）**只填中性默认值**，具体口癖/禁用词/称呼由用户填
//   · 生成出来的卡明确带上 `draft: true`，界面要显示"这是草稿，硬约束还没填"
// 如果之后接上 LLM 来做抽取，那也是"**提议** hard 约束、由用户确认"，
// 而不是直接写进卡里生效 —— 与本项目「模型只提议、不注入」的一贯立场一致。

import { validateCard, normalizeCard, HARD_KEYS, EMOJI_POLICIES, ANIMATION_TEMPERAMENTS } from '../core/card.mjs'
import { HARD_FIELD_PATHS, fieldByPath } from '../core/card-spec.mjs'
import { actionsFor } from '../art/actions.mjs'

/**
 * 中性默认值：全是"不约束"的取值。
 *
 * ⚠ **从 spec 的 default 派生**，不再手写。
 *   手写的话就又多一份"hard 层有哪些字段"的副本 —— 而这个项目里
 *   这种副本已经被证实会静默失守（见 docs/HANDOFF.md §5 坑 53/55）。
 */
export const NEUTRAL_HARD = Object.freeze(Object.fromEntries(
  HARD_FIELD_PATHS.map((p) => [p.split('.').pop(), structuredCloneish(fieldByPath(p).default ?? null)]),
))

function structuredCloneish(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v))
}

/**
 * 由用户的输入造一张**草稿卡**。
 *
 * ⚠ 入参要用 `input && typeof input === 'object'` 兜一道，**不能只靠默认参数**：
 *   默认参数只对 `undefined` 生效，传 `null` 照样会在 `p.name` 上抛 TypeError。
 *   （本轮这是第三次踩同一个坑 —— core/events 的 createEvent、core/card 的 validateCard 也栽在这。）
 *
 * @param {object} p
 * @param {string} p.name        角色名（必填）
 * @param {string} p.game        游戏标识（必填，记忆按它归属）
 * @param {string} [p.id]        不填则由 name+game 派生（稳定，便于复现）
 * @param {string} [p.lore]      官方人设/介绍原文 → 原样进 soft.background
 * @param {string} [p.personality] 性格描述 → soft.personality
 * @param {string} [p.speechStyle] 说话风格 → soft.speechStyle
 * @param {string} [p.temperament] 气质（决定需要哪些动作）
 * @param {string} [p.address]   称呼玩家的方式 → hard.addresses.player
 * @returns {{ok:boolean, card:object|null, errors:string[], warnings:string[], draft:boolean}}
 */
export function draftCard(input = {}) {
  const p = (input && typeof input === 'object') ? input : {}
  const name = str(p.name)
  const game = str(p.game)
  const errors = []
  if (!name) errors.push('缺少角色名')
  if (!game) errors.push('缺少游戏标识（记忆按它归属，不同游戏的记忆不会互相串）')
  const temperament = ANIMATION_TEMPERAMENTS.includes(p.temperament) ? p.temperament : 'calm'
  if (errors.length) return { ok: false, card: null, errors, warnings: [], draft: true }

  const address = str(p.address)
  const raw = {
    id: p.id ? str(p.id) : makeId(name, game),
    name,
    game,
    draft: true,                       // ★ 标记：硬约束还没填，界面要提醒
    animation: { temperament, style: p.style ? str(p.style) : 'soft' },
    persona: {
      soft: {
        // 原样搬运，不做"提炼" —— 提炼就等于替用户编
        personality: str(p.personality) || '（待填：这个角色的性格）',
        background: str(p.lore) || '（待填：官方人设/背景）',
        speechStyle: str(p.speechStyle) || '（待填：说话风格）',
      },
      hard: { ...NEUTRAL_HARD, ...(address ? { addresses: { player: address } } : {}) },
    },
  }
  const check = validateCard(raw)
  const { card } = normalizeCard(raw)
  return {
    ok: check.ok && Boolean(card),
    card,
    errors: check.errors,
    warnings: check.warnings,
    draft: true,
  }
}

/** 草稿卡还缺什么 —— 界面据此提示"去填硬约束"。 */
export function draftGaps(card) {
  const h = card?.persona?.hard ?? {}
  const gaps = []
  if (!h.speechTics?.length) gaps.push('口癖（speechTics）：没有的话角色说话会没有辨识度')
  if (!h.forbiddenWords?.length) gaps.push('禁用词（forbiddenWords）：没有的话模型可能说出角色不会说的话')
  if (!Object.keys(h.addresses ?? {}).length) gaps.push('称呼（addresses）：决定角色怎么叫玩家')
  if (!card?.persona?.soft?.background || card.persona.soft.background.startsWith('（待填')) gaps.push('背景：喂给模型的表达依据')
  return gaps
}

/**
 * 导出成可分享的 JSON 文本。
 * 校验不通过**也允许导出**（草稿本来就不完整），但结果里会带上问题清单。
 * 理由：卡是用户的资产，不该因为校验器不喜欢就导不出来。
 */
export function exportCard(card, { pretty = true } = {}) {
  if (!card || typeof card !== 'object') return { ok: false, text: '', errors: ['没有卡可导出'] }
  const check = validateCard(card)
  return {
    ok: true,
    text: JSON.stringify(card, null, pretty ? 2 : 0),
    errors: check.errors,
    warnings: check.warnings,
  }
}

/**
 * 从 JSON 文本导入。**不抛异常**，返回可读的问题。
 * @param {string} text
 * @returns {{ok:boolean, card:object|null, errors:string[], warnings:string[]}}
 */
export function importCard(text) {
  const s = String(text ?? '').trim()
  if (s === '') return { ok: false, card: null, errors: ['内容是空的'], warnings: [] }
  let raw
  try {
    raw = JSON.parse(s)
  } catch (e) {
    return { ok: false, card: null, errors: [`不是合法 JSON：${e.message}`], warnings: [] }
  }
  const check = validateCard(raw)
  if (!check.ok) return { ok: false, card: null, errors: check.errors, warnings: check.warnings }
  const { card, errors } = normalizeCard(raw)
  return { ok: Boolean(card), card, errors, warnings: check.warnings }
}

/**
 * 把硬约束逐条摊开，供界面显示"这张卡会被怎么校验"。
 * 让约束可见是很重要的：否则用户不知道"改这一行会影响什么"。
 */
export function explainCard(card) {
  const h = card?.persona?.hard ?? {}
  const want = actionsFor(card)
  return {
    hard: HARD_KEYS.map((k) => ({
      key: k,
      value: h[k],
      present: Array.isArray(h[k]) ? h[k].length > 0 : (h[k] && typeof h[k] === 'object' ? Object.keys(h[k]).length > 0 : h[k] != null),
      note: HARD_NOTES[k] ?? '',
    })),
    emojiPolicies: [...EMOJI_POLICIES],
    animation: { temperament: want.temperament, required: want.required, reasons: want.reasons },
    soft: Object.keys(card?.persona?.soft ?? {}),
  }
}

const HARD_NOTES = Object.freeze({
  speechTics: '期望出现的口癖片段。**单句没有不判错**，但整批都没出现会被统计出来（lintBatch 的 ticRate）',
  forbiddenWords: '出现即判 error —— 这是最硬的一条，模型输出过不了就直接不说',
  addresses: '称呼玩家的方式。整句没用到只是 warning（偶尔省略是自然的）',
  avgLength: '字符数区间（按码点算）。超出即 error —— 太长的角色扮演最劝退',
  emojiPolicy: 'none = 出现表情即 error；require = 没有表情即 error',
  mustMention: '特定场景必须提到的词（按事件类别）—— 声明了就必须出现，否则 error',
})

/** id 由 name+game 派生：同一张卡每次生成同一个 id，便于复现与去重。 */
export function makeId(name, game) {
  const s = `${game}::${name}`
  let h = 2166136261
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return `card_${(h >>> 0).toString(36)}`
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')
