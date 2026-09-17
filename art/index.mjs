// art/index.mjs —— 素材层编排：立绘 → 动作帧 → 落盘 + 两条质量闸门
//
// ═══════════════════════════════════════════════════════════════════
// 两条闸门为什么必须存在（ARCHITECTURE §7）
// ═══════════════════════════════════════════════════════════════════
// 「立绘 → 多风格多动作」最容易被含糊带过的就是质量。AI 生图有两个经典失败模式：
//   ① **偷懒**：你一个动作要 3 帧、6 个动作，它给你 18 张几乎一样的图
//      ⇒ 桌宠看起来还是傻站着（正是用户明确抱怨过的）
//   ② **跑形**：每个动作都是一张新图，于是"同一个角色"长得前后不一致
// 两者都能自动判定，靠的是像素：
//   · 动作间差异下限  —— evaluateQuality().minPairDiff 必须够大
//   · 与立绘相似度下限 —— 每个动作与立绘的平均哈希距离必须够小
// 阈值不是拍脑袋：`npm run art -- --measure` 会打印实测值（见 tools/art-check.mjs）。
//
// ⚠ provider 契约（可插拔）：
//     { id, name, available(): boolean, generate({card, source, action}) → {frames, meta} }
//   frames 是 RGBA 图数组（{width,height,data}）。程序化 provider 见 procedural.mjs。
//   云端文生图 provider 只要满足这个契约就能直接换进来 —— **但本仓库没有实现它**
//   （没有 API key 就没法验证，见 docs/HANDOFF.md 的"验证过什么"约定）。

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  decodePng, encodePng, averageHash, hamming, meanAbsDiff, opaqueRatio,
  distinctColors, highFrequencyEnergy, edgeRatio,
} from './image.mjs'
import { actionsFor, checkManifest, describeManifestCheck, ACTIONS } from './actions.mjs'
import { createProceduralProvider, synthStandingArt, framesFor } from './procedural.mjs'
import { applyStyle, resolveStyle, STYLES, STYLE_IDS } from './styles.mjs'

/**
 * 质量闸门的默认阈值。
 * 数值来源：`node tools/art-check.mjs --measure` 对程序化 provider 的实测值
 * （动作间差实测 0.032、距立绘实测 11），阈值留在实测值的 1/3 ~ 1/2，两头都留余量。
 *
 * 为什么 minActionDiff 是 0.01 而不是"只要 > 0"：
 *   只要 > 0 只能抓"完全相同"，抓不住"只改了一点亮度"这种敷衍（那也还是傻站着）。
 *   0.01 相当于平均 1% 的像素变化，明显低于任何真实动作（实测 ≥ 0.032），
 *   又高于纯亮度微调（几个百分点亮度 ≈ 0.001 量级）。
 */
export const QUALITY_DEFAULTS = Object.freeze({
  minActionDiff: 0.01,       // 任意两个动作之间的平均像素差下限（实测约 0.032）
  maxSourceDistance: 24,     // 动作与立绘的最大平均哈希距离（64 位里允许差 24 位；实测最大 11）
  allowDuplicateActions: 0,  // 允许多少个动作共用同一张特征帧（默认一个都不许）
  minOpaqueRatio: 0.02,      // 每帧至少要有点不透明像素（防"生成了一张全透明的图"）
})

/**
 * 「两个动作其实是同一张图」用的哈希位数：16×16 = 256 位。
 * 为什么不用默认的 8×8（64 位）：实测太粗 —— 1~3 像素的位移平均到 8×8 之后就没了，
 * idle 与 talk 会算出同一个哈希，闸门于是误报。256 位下真正的差异分得开。
 */
export const SIG_SIZE = 16

/**
 * 评测一套动作帧的质量。
 *
 * @param {Record<string, Array<{width,height,data}>>} framesByAction
 * @param {object|null} source 立绘
 * @param {object} [opts] 覆盖 QUALITY_DEFAULTS
 * @returns {{ok:boolean, minPairDiff:number, worstPair:[string,string]|null,
 *            maxSourceDistance:number, worstAction:string|null,
 *            duplicateActions:string[][], emptyFrames:string[], perAction:object, notes:string[]}}
 */
export function evaluateQuality(framesByAction, source, opts = {}) {
  const Q = { ...QUALITY_DEFAULTS, ...opts }
  const notes = []
  const ids = Object.keys(framesByAction ?? {}).filter((id) => Array.isArray(framesByAction[id]) && framesByAction[id].length > 0)

  const perAction = {}
  for (const id of ids) {
    const frames = framesByAction[id]
    const hashes = frames.map((f) => averageHash(f))
    const si = signatureIndex(frames, source)
    perAction[id] = {
      frames: frames.length,
      hash: hashes[0],
      // ★ 用**特征帧**（与立绘差得最远的那一帧）代表这个动作，而不是首帧。
      //   理由是实测逼出来的：idle / idleBored / talk 的首帧**本来就是同一张**
      //   —— 它们都从"静止站姿"开始，这是自然的，不是偷懒。
      //   若拿首帧比，就会把"所有动作都从站姿起手"误判成"provider 在偷懒"。
      signatureIndex: si,
      // ⚠ 特征帧哈希用 **16×16（256 位）** 而不是默认的 8×8（64 位）。
      //   实测 64 位太粗：位移只有 1~3 像素的 idle 与 talk 会算出**同一个**哈希，
      //   于是闸门误报"这两个动作共用同一张图" —— 但它们是真的不同，只是差异细到
      //   8×8 平均之后就没了。判断"是不是同一张图"需要更细的度量。
      signatureHash: averageHash(frames[si], SIG_SIZE),
      // ★ 帧内差异取**最大**而不是最小：循环动画天然含重复帧（[A,B,A,C]），
      //   取最小值必然为 0，于是每个循环动作都被误报成"静止"。要问的是"动没动"。
      internalDiff: frames.length > 1 ? maxPairwise(frames) : 0,
      fromSource: source ? hamming(hashes[si], averageHash(source)) : null,
      opaque: Math.min(...frames.map((f) => opaqueRatio(f))),
    }
  }

  // ① 空帧：全透明或几乎没有内容 —— 生图失败的常见形态
  const emptyFrames = ids.filter((id) => perAction[id].opaque < Q.minOpaqueRatio)
  if (emptyFrames.length) notes.push(`这些动作的帧几乎是空的：${emptyFrames.join('、')}`)

  // ② 动作之间必须真的不同（比的是各自的**特征帧**，见 perAction.signatureIndex 的说明）
  let minPairDiff = Infinity
  let worstPair = null
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = framesByAction[ids[i]][perAction[ids[i]].signatureIndex]
      const b = framesByAction[ids[j]][perAction[ids[j]].signatureIndex]
      const d = meanAbsDiff(a, b)
      if (d < minPairDiff) { minPairDiff = d; worstPair = [ids[i], ids[j]] }
    }
  }
  if (!Number.isFinite(minPairDiff)) minPairDiff = 0
  if (ids.length >= 2 && minPairDiff < Q.minActionDiff) {
    notes.push(`动作 ${worstPair[0]} 与 ${worstPair[1]} 的差异只有 ${minPairDiff.toFixed(4)}，低于下限 ${Q.minActionDiff} —— 看起来还是"傻站着"`)
  }

  // ③ 同一个动作内部必须真的在动（取最大帧内差，理由见 perAction.internalDiff 的说明）
  for (const id of ids) {
    if (ACTIONS[id]?.frames > 1 && perAction[id].internalDiff === 0) {
      notes.push(`动作 ${id} 的多帧完全一样 —— 播起来是静止的`)
    }
  }

  // ④ 特征帧哈希重复的动作（偷懒最直接的证据）
  const byHash = new Map()
  for (const id of ids) {
    const h = perAction[id].signatureHash
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h).push(id)
  }
  const duplicateActions = [...byHash.values()].filter((g) => g.length > 1)
  // 允许 allowDuplicateActions 个"撞车"（默认 0）：一组里有 n 个动作共用同一首帧，
  // 就有 n-1 次多余的重复，累加起来不超过允许值才算过。
  const redundant = duplicateActions.reduce((n, g) => n + g.length - 1, 0)
  const dupViolations = redundant > Q.allowDuplicateActions ? duplicateActions : []
  if (dupViolations.length) {
    notes.push(`这些动作共用同一张特征帧：${dupViolations.map((g) => g.join('/')).join('、')} —— provider 在偷懒`)
  }

  // ⑤ 不能跑形
  let maxSourceDistance = 0
  let worstAction = null
  if (source) {
    for (const id of ids) {
      const d = perAction[id].fromSource ?? 0
      if (d > maxSourceDistance) { maxSourceDistance = d; worstAction = id }
    }
    if (maxSourceDistance > Q.maxSourceDistance) {
      notes.push(`动作 ${worstAction} 与立绘的哈希距离 ${maxSourceDistance} 超过上限 ${Q.maxSourceDistance} —— 角色跑形了`)
    }
  } else {
    notes.push('没有立绘可比，跳过"跑形"检查')
  }

  return {
    ok: emptyFrames.length === 0 &&
      (ids.length < 2 || minPairDiff >= Q.minActionDiff) &&
      dupViolations.length === 0 &&
      (!source || maxSourceDistance <= Q.maxSourceDistance),
    minPairDiff, worstPair,
    maxSourceDistance, worstAction,
    duplicateActions: dupViolations,
    emptyFrames,
    perAction,
    notes,
  }
}

/**
 * 从立绘生成一整套动作素材，落盘并留下清单。
 *
 * @param {object} p
 * @param {object} p.card            规范化后的角色卡（读 card.animation）
 * @param {string} p.outDir          素材输出目录
 * @param {object|null} [p.source]   立绘（已解码的 RGBA）；不给则按 sourcePath 读，再不济现画
 * @param {string} [p.sourcePath]    立绘路径（PNG）
 * @param {object} [p.provider]      素材 provider（默认程序化）
 * @param {boolean} [p.dryRun]       只算不落盘（用于评测/测试）
 * @param {object} [p.quality]       覆盖质量阈值
 * @returns {Promise<{ok:boolean, manifest:object, check:object, quality:object, generated:string[], notes:string[], framesByAction:object, source:object}>}
 */
export async function ensureAssets(p = {}) {
  const notes = []
  const want = actionsFor(p.card)
  const provider = p.provider ?? createProceduralProvider()

  // ---- 立绘：给了就用，给了路径就读，都没有就现画（零输入兜底）----
  let source = p.source ?? null
  let sourceMeta = { kind: 'none', file: null }
  if (!source && p.sourcePath) {
    if (existsSync(p.sourcePath)) {
      try {
        source = decodePng(readFileSync(p.sourcePath))
        sourceMeta = { kind: 'file', file: p.sourcePath, width: source.width, height: source.height }
      } catch (e) {
        notes.push(`读立绘失败（${e.message}），改用程序化立绘`)
      }
    } else {
      notes.push(`立绘路径不存在：${p.sourcePath}`)
    }
  }
  if (!source) {
    source = synthStandingArt({ seed: hashOfCard(p.card) })
    sourceMeta = { kind: 'synthetic', file: null, width: source.width, height: source.height }
    notes.push('没有可用立绘 ⇒ 用程序化生成的立绘兜底（链路不会因此断掉）')
  }
  const rawSource = source

  // ---- ★ 风格化：必须在动作之前 ----
  // 「与立绘的相似度下限」这道闸门是拿动作帧跟**基准**比的。
  // 对"从源图推导帧"的 provider（程序化），基准必须是**风格化之后**的源图，
  // 否则线稿风与柔和风都会被判成"跟原图差太远" ⇒ 把**风格差异误判成跑形**。
  // 对照：生成式 provider 是"照参考图重新画"，那时基准应当是**原图** ——
  // 因为"别跑形"的本意正是"别画得不像原本的角色"。
  // 两者的区别用 provider 的 `derivesFromSource` 表达（谁都不是靠猜的）。
  const styleId = p.style ?? p.card?.animation?.style
  const derives = provider?.derivesFromSource === true || provider?.kind === 'procedural'
  const resolved = resolveStyle(styleId)
  let styleMeta = { style: resolved.id, fallbackFrom: resolved.fallbackFrom, applied: false }
  if (derives) {
    const styled = applyStyle(rawSource, styleId)
    source = styled.image
    styleMeta = { ...styled.meta, applied: true }
    notes.push(`按风格「${styleMeta.label ?? styleMeta.style}」风格化了立绘（原图另存为记录）`)
    if (styleMeta.fallbackFrom) notes.push(`风格「${styleMeta.fallbackFrom}」不认识 ⇒ 退回 ${styleMeta.style}`)
  } else {
    notes.push(`provider 是生成式的 ⇒ 风格「${resolved.id}」写进提示词、基准用**原图**比较（这才是"别跑形"的本意）`)
  }
  sourceMeta.originalHash = averageHash(rawSource)
  sourceMeta.style = styleMeta.style
  sourceMeta.styleFallbackFrom = styleMeta.fallbackFrom ?? null

  // ---- 逐个动作生成 ----
  const framesByAction = {}
  const generated = []
  for (const action of want.required) {
    let frames
    try {
      if (typeof provider.generate === 'function') {
        const out = await provider.generate({ card: p.card, source, action, style: styleMeta.style })
        frames = Array.isArray(out) ? out : out?.frames
      }
      if (!Array.isArray(frames) || frames.length === 0) throw new Error('provider 没给出帧')
      // provider 可能给出任意帧数；以词汇表为准，多了截断、少了补（补法是循环，且要记一笔）
      const expected = ACTIONS[action]?.frames
      if (Number.isFinite(expected) && frames.length !== expected) {
        notes.push(`provider 给 ${action} 出了 ${frames.length} 帧，词汇表期望 ${expected} 帧 ⇒ 已校正`)
        frames = expected <= frames.length
          ? frames.slice(0, expected)
          : Array.from({ length: expected }, (_, i) => frames[i % frames.length])
      }
      framesByAction[action] = frames
      generated.push(action)
    } catch (e) {
      notes.push(`动作 ${action} 生成失败：${e.message}`)
    }
  }

  const quality = evaluateQuality(framesByAction, source, p.quality)
  for (const n of quality.notes) notes.push(n)

  // ---- 落盘 ----
  const manifest = buildManifest({ card: p.card, want, source, sourceMeta, framesByAction, provider, quality })
  if (!p.dryRun && p.outDir) {
    mkdirSync(p.outDir, { recursive: true })
    for (const [action, frames] of Object.entries(framesByAction)) {
      frames.forEach((f, i) => {
        const rel = manifest.actions[action].frames[i]      // 清单里已经算好了路径
        const abs = join(p.outDir, rel)
        // ⚠ 必须建出动作子目录：重构写盘循环时漏过这一行，
        //   结果是 ENOENT: .../greeting/0.png —— 而且只在"有子目录的动作"上才炸。
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, encodePng(f))
      })
    }
    writeFileSync(join(p.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  }

  const check = checkManifest(manifest, want)
  return {
    ok: check.ok && quality.ok,
    manifest, check, quality, generated, notes,
    framesByAction, source, want,
  }
}

/** 组装清单。帧路径按 `<动作>/<序号>.png` 直接算出来 —— 这样 dryRun 也能得到一份**完整可检查**的清单。 */
export function buildManifest({ card, want, source, sourceMeta, framesByAction, provider, quality }) {
  const actions = {}
  for (const [action, frames] of Object.entries(framesByAction ?? {})) {
    const si = signatureIndex(frames, source)
    actions[action] = {
      frames: frames.map((_, i) => `${action}/${i}.png`),
      declaredFrames: ACTIONS[action]?.frames ?? frames.length,
      hash: averageHash(frames[si]),
      fromSource: source ? hamming(averageHash(frames[si]), averageHash(source)) : null,
    }
  }
  return {
    version: 1,
    character: card?.id ?? card?.name ?? null,
    provider: provider?.id ?? 'unknown',
    // 风格是"这张卡选的画风"，也记进清单，便于"同一角色两套风格"并存时区分
    style: sourceMeta?.style ?? card?.animation?.style ?? null,
    temperament: want?.temperament ?? null,
    source: {
      kind: sourceMeta?.kind ?? 'none',
      file: sourceMeta?.file ?? null,
      width: source?.width ?? null,
      height: source?.height ?? null,
      // 这个基准是**风格化之后**的图，所以它自己的风格也要记在这里 ——
      // "动作跟基准像不像"这道闸门只有在同风格下才有意义。
      style: sourceMeta?.style ?? null,
      hash: source ? averageHash(source) : null,
      // 风格化之后原图就没进过清单，所以把原图哈希也记下来：
      // 这样"同一张立绘、两种风格"可以被识别出来（也能查出立绘被换过）
      originalHash: sourceMeta?.originalHash ?? null,
      styleFallbackFrom: sourceMeta?.styleFallbackFrom ?? null,
    },
    quality: quality ? { minPairDiff: quality.minPairDiff, maxSourceDistance: quality.maxSourceDistance, ok: quality.ok } : null,
    actions,
  }
}

// ---------- 内部 ----------

/**
 * 特征帧的下标：与立绘（没有立绘时与首帧）差得最远的那一帧。
 * 这个动作"最像它自己"的样子就是这一帧，所以拿它代表整个动作。
 */
function signatureIndex(frames, source) {
  if (frames.length <= 1) return 0
  const ref = source ? averageHash(source) : averageHash(frames[0])
  let best = 0
  let bestD = -1
  frames.forEach((f, i) => {
    const d = hamming(averageHash(f), ref)
    if (d > bestD) { bestD = d; best = i }
  })
  return best
}

/** 帧内两两比较里**最大**的那个差：回答"这个动作到底动没动"。 */
function maxPairwise(frames) {
  let diff = 0
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const d = meanAbsDiff(frames[i], frames[j])
      if (d > diff) diff = d
    }
  }
  return diff
}

function hashOfCard(card) {
  const s = String(card?.id ?? card?.name ?? 'pet')
  let h = 2166136261
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return (h >>> 0) % 360
}

export { actionsFor, checkManifest, describeManifestCheck, ACTIONS, createProceduralProvider, synthStandingArt, framesFor }
export { applyStyle, resolveStyle, STYLES, STYLE_IDS }
export { averageHash, hamming, meanAbsDiff, encodePng, decodePng, opaqueRatio, distinctColors, highFrequencyEnergy, edgeRatio }
export { dirname }
