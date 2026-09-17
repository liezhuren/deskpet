// art/actions.mjs —— 桌面宠物动作词汇表 + 「这张卡需要哪些动作」的推导 + 清单一致性检查
//
// ═══════════════════════════════════════════════════════════════════
// 为什么动作清单要由**角色卡**推出来，而不是写死一套
// ═══════════════════════════════════════════════════════════════════
// 用户要的是「不止傻站着，长时间不理人会做出无聊的动作」，并且
// 「根据角色的官方人设生成不同的动作，比如偏活泼一些的」。
// 所以"需要哪些动作"是**角色属性**：
//   · 活泼（lively）→ 需要 greeting / happy
//   · 冷静（calm）  → 需要 happy 就够
//   · 高冷（cool）  → 需要 worried 更合适，不需要 greeting
// 而 idle / idleBored / talk 是**所有桌宠都要**的（idleBored 尤其，
// 因为"长时间不理人"是用户明确点名的场景，不能由档位决定要不要）。
//
// ═══════════════════════════════════════════════════════════════════
// 三类一致性错误（都是"静默型"，不查就发现不了）
// ═══════════════════════════════════════════════════════════════════
//   1. missing      卡要求某动作，素材里没有 ⇒ 运行时只能退回 idle，玩家看到"它怎么不动"
//   2. extra        素材里有卡不要的动作 ⇒ 白花钱生成，且可能和卡的风格不符
//   3. inconsistent 动作声明有 N 帧，实际只有 M 帧 ⇒ 播放到第 M+1 帧就崩或卡住
// checkManifest() 把这三类都查出来，且**不抛异常**（它是个校验器）。

/** 动作词汇表（闭集）。新增动作要在这里登记，否则 manifest 检查会当成"未登记的第 4 类错误"。 */
export const ACTIONS = Object.freeze({
  idle:      Object.freeze({ label: '待机',   frames: 4, chinese: '轻微呼吸起伏', always: true }),
  idleBored: Object.freeze({ label: '无聊',   frames: 4, chinese: '长时间没人理时的动作', always: true }),
  talk:      Object.freeze({ label: '说话',   frames: 3, chinese: '开口时的口型/起伏', always: true }),
  happy:     Object.freeze({ label: '高兴',   frames: 3, chinese: '进度推进 / 打赢了' }),
  worried:   Object.freeze({ label: '担心',   frames: 3, chinese: '角色死亡 / 卡关' }),
  greeting:  Object.freeze({ label: '打招呼', frames: 3, chinese: '玩家主动搭话 / 刚开游戏' }),
  sleep:     Object.freeze({ label: '打盹',   frames: 2, chinese: '极长时间无人互动' }),
})

export const ACTION_IDS = Object.freeze(Object.keys(ACTIONS))

// 气质词表从 core/card.mjs 引入 —— 依赖方向是 art → core，反过来会把分层搞乱。
import { ANIMATION_TEMPERAMENTS } from '../core/card.mjs'

/** 气质 → 额外需要的动作。`always` 的那些不在这里（它们对所有卡都必需）。 */
export const TEMPERAMENT_ACTIONS = Object.freeze({
  lively: Object.freeze(['happy', 'greeting']),
  calm: Object.freeze(['happy']),
  cool: Object.freeze(['worried']),
})

/** 与 core/card.mjs 的 ANIMATION_TEMPERAMENTS 保持一致（同一份事实，只有一个来源）。 */
export const TEMPERAMENTS = ANIMATION_TEMPERAMENTS

/**
 * 由角色卡推出需要的动作。
 *
 * @param {object} card - 规范化后的角色卡（读 `card.animation`，缺省当 calm）
 * @returns {{required:string[], optional:string[], temperament:string, reasons:string[]}}
 */
export function actionsFor(card) {
  const anim = (card && typeof card === 'object' && card.animation) || {}
  const temperament = TEMPERAMENTS.includes(anim.temperament) ? anim.temperament : 'calm'
  const reasons = []

  const always = ACTION_IDS.filter((id) => ACTIONS[id].always)
  const required = new Set(always)
  reasons.push(`所有桌宠都需要：${always.join('、')}（idleBored 是用户点名的场景，不随档位变）`)

  for (const id of TEMPERAMENT_ACTIONS[temperament]) {
    required.add(id)
  }
  reasons.push(`气质「${temperament}」额外需要：${TEMPERAMENT_ACTIONS[temperament].join('、') || '（无）'}`)

  // 卡可以显式追加（但**不能删掉必需项** —— 删了运行时就没动作可播了）
  const extra = Array.isArray(anim.actions) ? anim.actions.filter((a) => ACTION_IDS.includes(a)) : []
  for (const id of extra) required.add(id)
  if (extra.length) reasons.push(`角色卡显式要求：${extra.join('、')}`)

  const optional = ACTION_IDS.filter((id) => !required.has(id))
  return { required: [...required].sort(), optional, temperament, reasons }
}

/**
 * 检查素材清单与卡的要求是否一致。**不抛异常**，返回可读的问题清单。
 *
 * @param {object} manifest - 见 art/index.mjs 的产物
 * @param {{required:string[]}} want  - actionsFor() 的结果
 * @returns {{ok:boolean, missing:string[], extra:string[], inconsistent:Array, malformed:Array, notes:string[]}}
 */
export function checkManifest(manifest, want) {
  const missing = []
  const extra = []
  const inconsistent = []
  const malformed = []
  const notes = []

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, missing: [...(want?.required ?? [])], extra: [], inconsistent: [], malformed: ['清单不是对象'], notes: [] }
  }
  const acts = manifest.actions
  if (!acts || typeof acts !== 'object' || Array.isArray(acts)) {
    return { ok: false, missing: [...(want?.required ?? [])], extra: [], inconsistent: [], malformed: ['manifest.actions 缺失或不是对象'], notes: [] }
  }

  const required = new Set(want?.required ?? [])
  const present = new Set(Object.keys(acts))

  for (const id of required) if (!present.has(id)) missing.push(id)
  for (const id of present) if (!required.has(id)) extra.push(id)

  for (const [id, a] of Object.entries(acts)) {
    if (!ACTION_IDS.includes(id)) {
      malformed.push(`动作 ${id} 未在 ACTIONS 里登记 —— 不会有任何校验覆盖它`)
    }
    if (!a || typeof a !== 'object') { malformed.push(`动作 ${id} 的条目不是对象`); continue }
    if (!Array.isArray(a.frames)) { malformed.push(`动作 ${id} 的 frames 不是数组`); continue }
    if (a.frames.length === 0) { malformed.push(`动作 ${id} 没有任何帧`); continue }
    for (const f of a.frames) {
      if (typeof f !== 'string' || f.trim() === '') malformed.push(`动作 ${id} 有空的帧路径`)
    }
    // ★ 声明帧数与实际帧数不一致：运行时播到后面就会卡住或崩，而且**不报错**
    const declared = ACTIONS[id]?.frames
    if (Number.isFinite(declared) && a.frames.length !== declared) {
      inconsistent.push({ action: id, declared: a.frames.length, expected: declared, detail: `动作 ${id} 有 ${a.frames.length} 帧，词汇表期望 ${declared} 帧` })
    }
    if (a.declaredFrames !== undefined && a.declaredFrames !== a.frames.length) {
      inconsistent.push({ action: id, declared: a.declaredFrames, expected: a.frames.length, detail: `动作 ${id} 声明 ${a.declaredFrames} 帧但给了 ${a.frames.length} 个路径` })
    }
  }

  if (extra.length) notes.push(`多出 ${extra.length} 个动作：白生成，且可能与卡的风格不符`)
  if (missing.length) notes.push(`缺 ${missing.length} 个动作：运行时只能退回 idle，玩家会觉得"它怎么不动"`)

  return {
    ok: missing.length === 0 && inconsistent.length === 0 && malformed.length === 0,
    missing, extra, inconsistent, malformed, notes,
  }
}

/** 把检查结果渲染成人话（给界面/CLI 用）。 */
export function describeManifestCheck(r) {
  if (!r) return '（无结果）'
  if (r.ok && r.extra.length === 0) return '素材清单与角色卡要求一致 ✅'
  const lines = []
  if (r.missing.length) lines.push(`缺动作：${r.missing.join('、')}`)
  if (r.extra.length) lines.push(`多余动作：${r.extra.join('、')}`)
  for (const i of r.inconsistent) lines.push(`帧数不符：${i.detail}`)
  for (const m of r.malformed) lines.push(`清单有问题：${m}`)
  return lines.length ? lines.join('\n') : '素材清单与角色卡要求一致 ✅'
}
