// core/card.mjs —— 角色卡：schema 校验 + 派生（纯逻辑，零依赖）
//
// 核心设计（见 docs/HANDOFF.md §3.1）：角色卡分两层
//   hard —— **可机器校验的硬约束**（口癖/禁用词/称呼/长度/表情策略）→ 进 persona 校验器
//   soft —— 自由描写（性格/背景/说话风格）→ 只喂给模型，不参与校验
// 只有 hard 层能被验证，所以"角色一致性"的可度量部分全部压在这里。

import { validateAgainstSpec, HARD_FIELD_PATHS, FIELD_PATHS, fieldByPath } from './card-spec.mjs'

/** hard 层允许出现的键 —— **从 spec 派生**，不再手写一份（两份事实必然漂移）。 */
export const HARD_KEYS = Object.freeze(HARD_FIELD_PATHS.map((p) => p.split('.').pop()))

/** 表情策略的可选值 —— 同样从 spec 取，避免两处各写一遍。 */
export const EMOJI_POLICIES = Object.freeze([...(fieldByPath('persona.hard.emojiPolicy')?.values ?? ['none', 'allow', 'require'])])

/**
 * 气质档 —— 决定这个角色**需要哪些桌宠动作**（活泼的要有打招呼，高冷的要有关心）。
 * 词表放在 core 而不是 art/ 里，是为了让依赖方向保持 core ← art：
 * art/actions.mjs 从这里 import，而不是反过来。
 */
export const ANIMATION_TEMPERAMENTS = Object.freeze([...(fieldByPath('animation.temperament')?.values ?? ['lively', 'calm', 'cool'])])

/**
 * `card.animation` 的已知键 —— 也从 spec 派生。
 * （手写过一版 `['temperament','actions','style','scale']`，
 *   与 `animation.*` 的字段清单是同一份知识的两份副本 —— 典型的下一个漂移点。）
 */
export const ANIMATION_KEYS = Object.freeze([...new Set(
  FIELD_PATHS.filter((p) => p.startsWith('animation.')).map((p) => p.split('.').pop()),
)])

/**
 * 校验角色卡。返回 `{ ok, errors, warnings }` —— **不抛异常**：
 * 校验的目的是给出可读的修正清单（同 arknights 项目自创干员 schema 的做法）。
 * @param {object} card
 */
export function validateCard(card) {
  const errors = []
  const warnings = []
  const need = (cond, msg) => { if (!cond) errors.push(msg) }

  if (!card || typeof card !== 'object') return { ok: false, errors: ['角色卡必须是对象'], warnings }

  // ══ ① 类型 / 枚举 / 范围 / 必填 / 闭集 —— **全部从 core/card-spec.mjs 派生** ══
  // 这一步是"规范格式"的落地：格式只在 spec 里写一次，
  // 校验、填表、文档三处都从它派生，于是**不可能出现"文档说的"与"代码查的"不是一回事**。
  // （旧实现在这里手写了七八条类型检查，与 spec 是两份独立的事实 —— 一定会有漂移的一天。）
  const spec = validateAgainstSpec(card)
  for (const e of spec.errors) errors.push(e)
  for (const w of spec.warnings) warnings.push(w)

  const p = card.persona ?? {}
  const h = p.hard ?? {}

  // ---- 自相矛盾检查（这类错人工很难发现，机器一查就出来）----
  //
  // ⚠ 这一段**必须先做形状过滤**。最初版本直接 `for (const t of h.speechTics)`，
  //   遇到 `speechTics: [1, 2]` 就在 `t.includes(...)` 上抛 TypeError ——
  //   而本函数的契约是「不抛异常」（类型错已经由上面的检查报出来了，
  //   这里只负责查矛盾，不该因为脏数据把自己搞崩）。
  //   把字符串当数组（`speechTics: '不是数组'`）更阴：for...of 会逐字符迭代，
  //   于是"矛盾检查"在拿单字去比对禁用词，静默地什么都查不出来。
  const tics = Array.isArray(h.speechTics) ? h.speechTics.filter(isNonEmptyStr) : []
  const bad = Array.isArray(h.forbiddenWords) ? h.forbiddenWords.filter(isNonEmptyStr) : []
  for (const t of tics) {
    if (bad.includes(t)) errors.push(`口癖 ${JSON.stringify(t)} 同时出现在 forbiddenWords 里 —— 角色卡自相矛盾`)
    const hit = bad.filter((w) => t.includes(w))
    if (hit.length) {
      errors.push(`口癖 ${JSON.stringify(t)} 含有禁用词（${hit.join('、')}）—— 按此卡无法通过校验`)
    }
  }

  // 称呼与禁用词冲突：校验器**要求**句中出现称呼，而禁用词又禁止它 ⇒ 每句必违规。
  // 这条比口癖那条更隐蔽，因为称呼通常只有一两个，很容易和禁用词列表撞上。
  for (const [target, addr] of addressEntries(h.addresses)) {
    if (bad.includes(addr)) {
      errors.push(`称呼 ${JSON.stringify(addr)}（addresses.${target}）本身是禁用词 —— 校验器要求出现它、禁用词又禁止它，每句都会违规`)
    }
  }

  // 长度上限与"必须提到 / 必须用称呼"冲突：词比整句允许的长度还长 ⇒ 物理上写不出来。
  const amax = typeof h.avgLength?.max === 'number' ? h.avgLength.max : null
  if (amax !== null) {
    for (const [kind, words] of Object.entries(isPlainObject(h.mustMention) ? h.mustMention : {})) {
      for (const w of Array.isArray(words) ? words : []) {
        if (isNonEmptyStr(w) && [...w].length > amax) {
          errors.push(`mustMention.${kind} 里的 ${JSON.stringify(w)} 有 ${[...w].length} 字，超过 avgLength.max(${amax}) —— 不可能同时满足`)
        }
      }
    }
    for (const [target, addr] of addressEntries(h.addresses)) {
      if ([...addr].length > amax) {
        errors.push(`称呼 ${JSON.stringify(addr)}（addresses.${target}）有 ${[...addr].length} 字，超过 avgLength.max(${amax}) —— 不可能同时满足`)
      }
    }
  }

  // 要求必须带表情，但长度上限容不下一个表情（表情至少占 1 个字符）
  if (h.emojiPolicy === 'require' && amax !== null && amax < 2) {
    errors.push(`emojiPolicy 是 require 但 avgLength.max 只有 ${amax} —— 装不下任何表情`)
  }

  // ---- soft 层只做存在性提醒（不参与校验，别过度约束创作者）----
  const softFields = ['personality', 'background', 'speechStyle']
  const missingSoft = softFields.filter((k) => !p.soft?.[k])
  if (missingSoft.length) warnings.push(`persona.soft 缺少 ${missingSoft.join(' / ')} —— 会给模型较少的表达依据`)

  // ---- 动画（决定"需要哪些桌宠动作"，见 art/actions.mjs）----
  if (has(card, 'animation')) {
    const a = card.animation
    const okObj = a && typeof a === 'object' && !Array.isArray(a)
    need(okObj, 'animation 必须是对象')
    if (okObj) {
      for (const k of Object.keys(a)) {
        if (!ANIMATION_KEYS.includes(k)) {
          warnings.push(`animation 含未登记的键 ${k} —— 不会有任何东西读它，建议删掉或先登记`)
        }
      }
      if (has(a, 'temperament')) {
        need(ANIMATION_TEMPERAMENTS.includes(a.temperament),
          `animation.temperament 必须是 ${ANIMATION_TEMPERAMENTS.join(' / ')} 之一，收到 ${JSON.stringify(a.temperament)}（它决定需要哪些动作）`)
      }
      if (has(a, 'actions')) {
        need(isStrArray(a.actions), 'animation.actions 必须是字符串数组')
        // 不许**删掉**必需动作：删了运行时就没动作可播，只能退回 idle
        for (const must of ['idle', 'idleBored', 'talk']) {
          if (Array.isArray(a.actions) && !a.actions.includes(must) && a.actions.length > 0) {
            // 这里只提醒：actions 是"追加"，真正的必需项由 actionsFor() 保证
            warnings.push(`animation.actions 没提 ${must} —— 但它是必需动作，actionsFor() 会自动带上（无需手写）`)
          }
        }
      }
      if (has(a, 'scale')) {
        need(Number.isFinite(a.scale) && a.scale > 0, 'animation.scale 必须是正数')
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 校验并归一化：给缺失的可选字段补默认值，保证下游不必到处判空。
 * ⚠ 不做"猜测式修复"（比如自动补口癖）—— 只补**中性默认**。
 * @returns {{ card: object, errors: string[], warnings: string[] }}
 */
export function normalizeCard(card) {
  const { errors, warnings } = validateCard(card)
  if (errors.length) return { card: null, errors, warnings }
  const h = { ...(card.persona.hard ?? {}) }
  const out = {
    ...card,
    persona: {
      ...card.persona,
      hard: {
        speechTics: h.speechTics ?? [],
        forbiddenWords: h.forbiddenWords ?? [],
        addresses: h.addresses ?? {},
        avgLength: h.avgLength ?? { min: 1, max: 400 },
        emojiPolicy: h.emojiPolicy ?? 'allow',
        mustMention: h.mustMention ?? {},
      },
    },
  }
  return { card: out, errors, warnings }
}

// ---------- 内部 ----------
const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k)
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isNonEmptyStr = (v) => typeof v === 'string' && v !== ''
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 只从"真的是个普通对象"的 addresses 里取字符串称呼，其余一律跳过（脏数据不该让校验器崩）。 */
function* addressEntries(addresses) {
  if (!isPlainObject(addresses)) return
  for (const [target, addr] of Object.entries(addresses)) {
    if (isNonEmptyStr(addr)) yield [target, addr]
  }
}
