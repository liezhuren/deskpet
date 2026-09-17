// dialogue/template.mjs —— 无模型的模板 provider（默认档，必须永远可用）
//
// 为什么它是**默认**而不是兜底（ARCHITECTURE §4 的硬约束之一）：
//   「没接模型时全链路仍要能跑」。如果默认档是 LLM，那么没配 API key 的用户
//   连"桌宠会不会说话"都验不了，而这一层的价值恰恰是**能离线回归**。
//
// ═══════════════════════════════════════════════════════════════════
// 它必须满足角色卡的硬约束 —— 这一点是设计出来的，不是碰巧
// ═══════════════════════════════════════════════════════════════════
// 模板产出的每一句都要能过 `persona.lintDialogue`。所以生成过程是**按约束装配**的：
//   核心句（按触发类型 + 亲密度档选）
//   + 追问（来自 base.mjs 的 askable —— 这是把长度撑到 min 的正当来源）
//   + 称呼（卡里指定了就必须出现，否则 linter 给 warning）
//   + 口癖（同上；位置按口癖的形状决定，见 placeTic）
//   + 表情（emojiPolicy=require 时**必须**加，缺了是 error 不是 warning）
// 装配时按"内容最全 → 最精简"的顺序尝试，取第一个落在 [min, max] 内的组合。
// 于是「长度上限很紧的卡」也能说出一句合规的话，而不是直接违规。
//
// 口癖位置为什么有讲究：`……才不是` 这类要放句首（`……才不是，你存档了？`），
// 而 `呢` / `啦` 这类句尾助词必须放句尾。按首字符是不是省略号/波浪号来判断，
// 是覆盖常见情况的最小启发式（写在 placeTic 里，并且是纯函数，可单独测）。

/** 核心句。按亲密度分档：low 生疏、mid 逐渐熟络、high 亲近。 */
export const CORES = Object.freeze({
  save: {
    low: ['你存档了？', '……存好了？'],
    mid: ['存档了？', '刚存完档吧。'],
    high: ['又存一次，稳。', '存好了就行，别硬撑。'],
  },
  death: {
    low: ['你刚才没了？', '……没事吧。'],
    mid: ['又没了？', '这次栽哪儿了。'],
    high: ['没事，这关本来就阴。', '死了就死了，再来。'],
  },
  crash: {
    low: ['游戏好像不是正常退的。', '刚才是不是出问题了？'],
    mid: ['游戏崩了吧？', '这次退得不太对。'],
    high: ['又崩了啊。', '别慌，先看看存档。'],
  },
  combat: {
    low: ['刚打完一场？', '……打完了？'],
    mid: ['刚打完吧？', '打得怎么样。'],
    high: ['赢了吗？', '那场我看你打得挺凶。'],
  },
  progress: {
    low: ['有进展了？', '……往前走了？'],
    mid: ['推进了不少吧？', '看来是过关了。'],
    high: ['这波可以啊。', '我就说你能过。'],
  },
  area: {
    low: ['换地方了？', '……到新地方了？'],
    mid: ['这是到哪儿了？', '场景换了？'],
    high: ['新地图？带我看看。', '又跑哪儿去了。'],
  },
  item: {
    low: ['东西有变化？', '……捡到什么了？'],
    mid: ['捡到东西了？', '背包动过了吧。'],
    high: ['搞到什么好东西了？', '又进货了？'],
  },
  dialogue: {
    low: ['刚才是跟人说话？', '……聊完了？'],
    mid: ['刚跟人聊完？', '说到什么了？'],
    high: ['聊什么呢，说给我听听。', '跟谁聊上了。'],
  },
  exit: {
    low: ['游戏退出了。', '……今天到这儿？'],
    mid: ['不玩了？', '今天先这样？'],
    high: ['收工啦？', '歇着吧，明天再打。'],
  },
  // 每一档都留一条"不含『你』"的变体 —— 因为「禁止叫『你』、只叫搭档」是很常见的设定，
  // 而「你」是最容易出现在中文句子里的词。少了这条变体，那种卡就会永远只能沉默。
  manual: {
    low: ['你怎么了？', '……找我有事？'],
    mid: ['在呢，你说。', '找我？'],
    high: ['嗯？我在呢。', '怎么啦。'],
  },
  system: {
    low: ['游戏里有动静。', '……刚才是？'],
    mid: ['刚才在忙什么？', '有情况？'],
    high: ['怎么啦？', '又折腾什么呢。'],
  },
})

/** 表情池（只在 emojiPolicy=require 时用）。刻意用最普通的。 */
const EMOJIS = ['🙂', '😌', '👀', '💪', '🌙']

/**
 * 模板 provider。
 * @returns {{id:string, name:string, kind:string, available:()=>boolean, generate:(req:object)=>object}}
 */
export function createTemplateProvider() {
  return {
    id: 'template',
    name: '模板（无模型）',
    kind: 'template',
    available: () => true,
    generate,
  }
}

/**
 * 生成一句话。
 * @param {object} request - dialogue/base.mjs 的 buildRequest 输出
 * @param {{seed?:number}} [opts]
 * @returns {{text:string, meta:object}}
 */
export function generate(request, opts = {}) {
  const r = request ?? {}
  const hard = r.hard ?? {}
  const { min, max } = hard.avgLength ?? { min: 1, max: 400 }
  const seed = Number.isFinite(opts.seed) ? opts.seed : (Number.isFinite(r.seed) ? r.seed : 0)
  const tier = tierOf(r.state?.affinity)
  const forbidden = Array.isArray(hard.forbiddenWords) ? hard.forbiddenWords.filter((w) => typeof w === 'string' && w) : []
  const pool = CORES[r.kind]?.[tier] ?? CORES[r.kind]?.mid ?? CORES.system.mid
  // ★ 先按禁用词过滤**核心句池**，再从中挑。
  //   只在"装饰后的候选"上过滤是不够的：若核心句本身含禁用词（比如核心句里有"你"、
  //   而这张卡禁用"你"），那么它的所有装饰版本都会被滤光，于是退回未滤列表又选中了违规的。
  //   每一档因此都要留至少一条"不含最常见禁用词"的变体。
  const usablePool = forbidden.length ? pool.filter((c) => !forbidden.some((w) => c.includes(w))) : pool
  const pickFrom = usablePool.length ? usablePool : pool
  const coreIdx = idxOf(seed, pickFrom.length)
  let core = pickFrom[coreIdx]

  // 场景必提词：卡里声明了就必须出现，所以优先挑含它的核心句，挑不到就自己补
  const must = (r.hard?.mustMention ?? {})[r.kind]
  const mustWord = Array.isArray(must) ? must.find((w) => typeof w === 'string' && w) : null
  if (mustWord && !core.includes(mustWord)) {
    const better = pickFrom.find((c) => c.includes(mustWord))
    if (better) core = better
    else core = `${core}${mustWord}`
  }

  const tics = Array.isArray(hard.speechTics) ? hard.speechTics.filter((t) => typeof t === 'string' && t) : []
  const tic = tics.length ? tics[idxOf(seed + 1, tics.length)] : null
  const hasAddrRule = hard.addresses && Object.keys(hard.addresses).length > 0
  const addr = hasAddrRule && typeof r.address === 'string' && r.address ? r.address : null
  const emoji = hard.emojiPolicy === 'require' ? EMOJIS[idxOf(seed + 2, EMOJIS.length)] : null

  const ask = (r.askable ?? []).length ? r.askable[idxOf(seed + 3, r.askable.length)] : null

  const decorate = (body) => {
    const out = []
    const push = (t) => { if (t && !out.includes(t)) out.push(t) }
    const ticPrefix = Boolean(tic) && /^[….。~〜～]/.test(tic)
    /**
     * 称呼的落点：句首的前置口癖**之后**。
     * 例：口癖「……不是」+ 称呼「你」+ 核心「找我有事？」 ⇒ `……不是，你找我有事？`
     * 而不是 `你，……不是，找我有事？` —— 后者读起来像两个逗号挤在一起，很不自然。
     * （这个不自然是自检脚本把桌宠实际说出的话截图出来之后才看出来的。）
     */
    const withAddr = (t) => {
      if (!addr || t.includes(addr)) return t
      if (ticPrefix && t.startsWith(`${tic}，`)) return `${tic}，${addr}${t.slice(tic.length + 1)}`
      return `${addr}，${t}`
    }
    const withTic = (t) => (tic ? placeTic(tic, t) : t)
    const withEmoji = (t) => (emoji && !t.includes(emoji) ? `${t}${emoji}` : t)
    // 从"内容最全"到"最精简" —— 取第一个落在长度区间内的
    push(withEmoji(withTic(withAddr(body))))
    push(withEmoji(withAddr(body)))
    push(withEmoji(withTic(body)))
    push(withTic(withAddr(body)))
    push(withEmoji(body))
    push(withTic(body))
    push(withAddr(body))
    push(body)
    return out
  }

  // 先试"核心 + 追问"（更容易满足 min），再退回"只说核心"
  const candidates = [...decorate(ask ? `${core}${ask}` : core), ...decorate(core)]
  // ★ 先在候选里把**明显违规**的滤掉，再按长度挑。
  //   为什么必要：核心句是"所有人共用"的，而卡可以禁用任意词 ——
  //   比如一张卡写 `forbiddenWords: ['你']` + `addresses: {player: '搭档'}`（从不叫"你"），
  //   那么含"你"的核心句必然违规。不滤的话就会选中它、然后被校验器打回，白白沉默一次。
  //   全被滤光时退回未滤列表：那样至少还有一句能交给校验器报出原因，而不是返回空。
  const clean = forbidden.length ? candidates.filter((t) => !forbidden.some((w) => t.includes(w))) : candidates
  const text = pickFitting(clean.length ? clean : candidates, min, max)

  return {
    text,
    meta: {
      provider: 'template',
      kind: r.kind,
      tier,
      variant: coreIdx,
      core,
      usedAddress: Boolean(addr && text.includes(addr)),
      usedTic: Boolean(tic && text.includes(tic)),
      usedEmoji: Boolean(emoji && text.includes(emoji)),
      usedAsk: Boolean(ask && text.includes(ask)),
    },
  }
}

/** 亲密度分档 —— 与 persona.addressFor 的分档保持一致（0.4 / 0.7）。 */
export function tierOf(affinity) {
  const a = Number.isFinite(affinity) ? affinity : 0.3
  if (a >= 0.7) return 'high'
  if (a >= 0.4) return 'mid'
  return 'low'
}

/**
 * 口癖该放句首还是句尾。
 * `……才不是` 这类以省略号/波浪号开头，放句首才读得通（`……才不是，你存档了？`）；
 * `呢` / `啦` / `嘛` 这类句尾助词放了句首就成了病句。
 */
export function placeTic(tic, text) {
  const t = String(text ?? '')
  const s = String(tic ?? '')
  if (!s || t.includes(s)) return t
  return /^[….。~〜～]/.test(s) ? `${s}，${t}` : `${t}${s}`
}

// ---------- 内部 ----------

/** 确定性下标：同一个 seed 永远选出同一条，便于测试与复现。 */
function idxOf(seed, len) {
  if (!Number.isFinite(len) || len <= 0) return 0
  const s = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0
  return s % len
}

/**
 * 取第一个落在 [min, max] 内的候选；都不在区间内时取"离区间最近"的。
 * 后者是兜底：真正越界了要由 lint 报出来（不该发生），**不能静默返回一个越界句**。
 */
function pickFitting(candidates, min, max) {
  const uniq = [...new Set((candidates ?? []).filter((t) => typeof t === 'string' && t !== ''))]
  if (uniq.length === 0) return ''
  const lo = Number.isFinite(min) ? min : 1
  const hi = Number.isFinite(max) ? max : 400
  const inRange = uniq.find((t) => { const n = [...t].length; return n >= lo && n <= hi })
  if (inRange) return inRange
  const dist = (t) => {
    const n = [...t].length
    return n < lo ? lo - n : n - hi
  }
  return uniq.reduce((best, t) => (dist(t) < dist(best) ? t : best), uniq[0])
}

export default createTemplateProvider
