// dialogue/base.mjs —— 表达层的公共契约：把"事实"与"必须追问的部分"分开
//
// ═══════════════════════════════════════════════════════════════════
// 这一层唯一的硬约束（ARCHITECTURE §3 原则 P1）
// ═══════════════════════════════════════════════════════════════════
//   「只报事实，其余用问的。」
//
// 但"只报事实"如果只写成一句提示词，模型照样会编（而且你没法验证它编了）。
// 所以本模块把这条原则**变成数据结构**：每个触发类型都显式列出
//   · statable —— 确定性代码**确实知道**的事实，可以直说
//   · askable  —— 我们**不知道**的细节，只能问
// 表达层（模板或 LLM）拿到的就是这两份清单，而不是一堆原始日志。
//
// 为什么这件事重要：实测那款真实游戏的存档字段叫 `dayCount` / `hPoint` / `totalPoint`，
// 我们**根本不知道**它的语义。若让模型自由发挥，它会一本正经地说"你打到第 31 天了"——
// 而"第 31 天"到底是天数、章节还是别的，我们没有依据。
// 说成「打到第 31 天了？」是**在问**，说成「你已经打到第 31 天了」是**在断言**，两者完全不同。

import { describeState, addressFor } from '../core/persona.mjs'

/**
 * 每个触发类型的「能直说 / 必须问」清单。
 *
 * 写清单时的判断标准：**这句话的依据是不是确定性代码给的事实？**
 *   · "玩家刚存了档" ← 文件系统观测到了，是事实 ⇒ 可直说
 *   · "打完了 boss 才存档" ← 日志和存档都给不出这个结论 ⇒ 必须问
 */
export const KIND_FACTS = Object.freeze({
  save: Object.freeze({
    statable: Object.freeze(['玩家刚刚存了档']),
    askable: Object.freeze(['是打完了一段想留个底，还是准备收手了？']),
  }),
  death: Object.freeze({
    statable: Object.freeze(['角色刚死了一次']),
    askable: Object.freeze(['这次是卡在哪儿了？', '要不要先歇会儿？']),
  }),
  combat: Object.freeze({
    statable: Object.freeze(['刚打了一场']),
    askable: Object.freeze(['结果怎么样？']),
  }),
  progress: Object.freeze({
    statable: Object.freeze(['这一局有进展']),
    askable: Object.freeze(['顺利吗？']),
  }),
  area: Object.freeze({
    statable: Object.freeze(['换地方了']),
    askable: Object.freeze(['这是到哪儿了？']),
  }),
  item: Object.freeze({
    statable: Object.freeze(['东西有变化']),
    askable: Object.freeze(['是捡到还是用掉了？']),
  }),
  dialogue: Object.freeze({
    statable: Object.freeze(['刚和游戏里的角色说过话']),
    askable: Object.freeze(['聊了些什么？']),
  }),
  exit: Object.freeze({
    statable: Object.freeze(['游戏已经退出了']),
    askable: Object.freeze(['今天先到这儿？']),
  }),
  crash: Object.freeze({
    statable: Object.freeze(['游戏不是正常退出的']),
    askable: Object.freeze(['刚才是不是崩了？', '存档还在吧？']),
  }),
  manual: Object.freeze({
    statable: Object.freeze(['玩家主动来找你说话了']),
    askable: Object.freeze(['想聊点什么？']),
  }),
  system: Object.freeze({
    statable: Object.freeze(['游戏有动静']),
    askable: Object.freeze(['刚才在忙什么？']),
  }),
})

/** 触发类型 → 该用什么语气（表达层据此选措辞，不是随机）。 */
export const KIND_TONE = Object.freeze({
  save: '轻松、不催',
  death: '先接住情绪，别急着给建议',
  combat: '中性偏关心',
  progress: '替他高兴，但别夸奖过头',
  area: '好奇',
  item: '随口一问',
  dialogue: '别打听剧情，随口接一句',
  exit: '陪着收尾',
  crash: '关心存档有没有丢，不要调侃',
  manual: '直接回应，别绕',
  system: '随口一问',
})

/** 系统提示里对模型的硬性要求。措辞刻意写成"禁令 + 替代做法"，避免只管住不给出路。 */
export const EXPRESSION_RULES = Object.freeze([
  '你只负责表达，不负责事实。下面「可以直说」之外的一切都不得断言。',
  '想提到细节时，必须用疑问句（「打到第 31 天了？」），不能陈述（「你已经打到第 31 天了」）。',
  '不要复述字段名、文件路径、数字变化这类机器信息；不确定就问。',
  '不要给长篇攻略。一次只问一件事。',
  '保持角色口吻；称呼与口癖必须按角色卡的硬约束来。',
  '宁可只说一句「你刚存档了」，也不要编一个听起来很具体的情节。',
])

/**
 * 组装一次表达请求 —— 这是模板 provider 与 LLM provider **共用**的输入。
 *
 * @param {object} p
 * @param {object} p.card      规范化后的角色卡
 * @param {object} p.state     persona 状态
 * @param {object} p.trigger   { kind, summaries, significance, at, mergedCount }
 * @param {string} [p.memoryText]  相关记忆的摘要（core/memory.mjs 的 digest 输出）
 * @param {Array}  [p.memoryUsed]  被召回的记忆条目（带 score）
 * @param {object} [p.session]     会话概况（describeSession 的输出，可选）
 * @param {number} [p.now]
 * @param {number} [p.seed]        确定性选择的种子（便于测试与复现）
 * @returns {object} request
 */
export function buildRequest(p = {}) {
  const card = p.card
  const state = p.state
  const trigger = p.trigger ?? { kind: 'manual', summaries: [], significance: 0.5 }
  const kind = KIND_FACTS[trigger.kind] ? trigger.kind : 'system'
  const facts = KIND_FACTS[kind]

  // 记忆里"这件事发生过几次"是**事实**，可以直说；但只在它确实出现过时才提
  const repeats = (p.memoryUsed ?? [])
    .filter((m) => m?.entry?.count > 1)
    .map((m) => ({ text: m.entry.text, count: m.entry.count }))

  return {
    kind,
    tone: KIND_TONE[kind],
    // ★ `card` 与 `state` 必须原样带出去。
    //   最初漏了这两个字段，后果是 speak() 里 `lintDialogue(text, req.card ?? {}, …)`
    //   在拿**空卡**校验 —— 于是「校验器拦住模型」这个机制在生产路径上完全空转，
    //   禁用词、长度、表情一律不生效。单测没发现，因为性质测试是直接拿真卡 lint 的；
    //   只有走 speak() 那条路、喂一段故意违规的模型输出，才会暴露。
    card,
    state,
    // 确定性事实：可以直说
    statable: [
      ...facts.statable,
      ...(trigger.mergedCount > 1 ? [`这次一共 ${trigger.mergedCount} 处动静`] : []),
      ...repeats.map((r) => `这件事之前也出现过（累计 ${r.count} 次）`),
    ],
    // 我们不知道的：只能问
    askable: [...facts.askable],
    // 原始摘要照原样带上 —— 表达层**不许逐字复述**，但可以参考它判断"玩家大概在忙什么"
    rawSummaries: [...(trigger.summaries ?? [])],
    memoryText: p.memoryText ?? '',
    stateText: card && state ? describeState(state, card) : '',
    address: card && state ? addressFor(state, card).text : '你',
    hard: card?.persona?.hard ?? null,
    soft: card?.persona?.soft ?? null,
    trigger,
    now: p.now ?? null,
    seed: p.seed ?? null,
  }
}

/**
 * 把 request 渲染成给 LLM 的提示词。
 * **纯函数、可离线测** —— 网络那一段在 dialogue/llm.mjs，这一半不该依赖网络。
 *
 * @param {object} request - buildRequest 的输出
 * @param {{maxChars?:number}} [opts]
 */
export function promptFor(request, opts = {}) {
  const r = request
  const lines = []
  lines.push('【角色】')
  if (r.soft) {
    if (r.soft.personality) lines.push(`性格：${r.soft.personality}`)
    if (r.soft.speechStyle) lines.push(`说话风格：${r.soft.speechStyle}`)
    if (r.soft.background) lines.push(`背景：${r.soft.background}`)
  }
  if (r.stateText) lines.push('', '【此刻的状态】', r.stateText)

  lines.push('', '【现在发生的事（可以直说）】')
  for (const s of r.statable) lines.push(`· ${s}`)
  lines.push(`语气参考：${r.tone}`)

  lines.push('', '【我们不知道的部分（只能问，不能断言）】')
  for (const a of r.askable) lines.push(`· ${a}`)
  if (r.rawSummaries.length) {
    lines.push('', '【机器观测到的原始摘要 —— 严禁逐字复述，也不要提字段名】')
    for (const s of r.rawSummaries) lines.push(`· ${s}`)
  }
  if (r.memoryText) lines.push('', r.memoryText)

  const hard = r.hard ?? {}
  lines.push('', '【硬约束（必须满足，否则会被校验器打回）】')
  if (hard.speechTics?.length) lines.push(`· 口癖：${hard.speechTics.join(' / ')}（偶尔用，不必每句都用）`)
  if (hard.forbiddenWords?.length) lines.push(`· 禁用词（出现即失败）：${hard.forbiddenWords.join(' / ')}`)
  lines.push(`· 称呼玩家：「${r.address}」`)
  if (hard.avgLength) lines.push(`· 长度：${hard.avgLength.min}~${hard.avgLength.max} 字`)
  if (hard.emojiPolicy === 'none') lines.push('· 不要使用表情符号')
  if (hard.emojiPolicy === 'require') lines.push('· 必须带一个表情符号')

  lines.push('', '【规矩】')
  for (const rule of EXPRESSION_RULES) lines.push(`· ${rule}`)
  lines.push('', `直接输出要说的话本身（不超过 ${opts.maxChars ?? 120} 字），不要加引号、不要解释。`)

  return lines.join('\n')
}

/** 供 provider 自检：这次请求里有没有"必须用疑问句"的部分。 */
export function needsQuestion(request) {
  return (request?.askable?.length ?? 0) > 0
}
