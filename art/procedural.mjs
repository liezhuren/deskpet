// art/procedural.mjs —— 程序化素材 provider（零 API 的兜底，且是默认档）
//
// ═══════════════════════════════════════════════════════════════════
// 它兜的是什么底
// ═══════════════════════════════════════════════════════════════════
// 与 dialogue 的模板 provider 同一个立场：**没有外部服务时，全链路仍要能跑通**。
// 具体到素材层，它保证两件事：
//   ① 有立绘 ⇒ 从这一张图推导出每个动作的每一帧（不要求生成立绘）
//   ② **连立绘都没有** ⇒ synthStandingArt() 现画一个（见文件末尾），
//      于是"零输入"也能得到一套能播的动作，链路不会因为缺素材而断
//
// ═══════════════════════════════════════════════════════════════════
// 有意为之的取舍：它产出的是**几何变换**，不是"新画的画"
// ═══════════════════════════════════════════════════════════════════
// 变换只有三类：位移、旋转、亮度。它们**不可能画出原图里没有的姿势**（比如真正的挥手）。
// 这是刻意的：本层的价值不是"生成好看的画"，而是
//   · 把"动作清单 ↔ 实际素材"的一致性变成可检查的（art/actions.mjs）
//   · 把"同角色不同动作必须真的不同""不能跑形"变成可自动判定的质量闸门（art/index.mjs）
// 想要真正的多姿势，那是生成 provider（云端文生图 + 参考图）的活 —— 接口在 art/index.mjs 里留好了。
// **说清楚这一点，比假装程序化兜底能替代文生图要诚实。**

import {
  boxResize, translate, scaleBrightness, rotate, encodePng, decodePng,
} from './image.mjs'
import { applyStyle, resolveStyle } from './styles.mjs'

/**
 * 每个动作的逐帧变换配方。
 *
 * 数值是实测调出来的，有两条约束同时要满足（见 tools/art-check.mjs --measure）：
 *   · 动作**之间**必须够不同 —— 尤其 idle 与 talk 曾经只差一点亮度（1.02 vs 1.04），
 *     实测被判成"同一个动作"。所以 talk 改成有明显位移的点头。
 *   · 每个动作与立绘的距离不能太大 —— 否则触发"跑形"闸门。当前最大约 10/64。
 * 另外每个配方的**第一帧刻意都是静止站姿**（恒等变换）：
 *   桌宠从站姿起手是自然的，闸门比的是"特征帧"（差得最远的那一帧），不会被这一点骗到。
 */
export const RECIPES = Object.freeze({
  idle: Object.freeze([
    { dy: 0, bright: 1.00 },
    { dy: -1, bright: 1.02 },
    { dy: 0, bright: 1.00 },
    { dy: 1, bright: 0.98 },
  ]),
  idleBored: Object.freeze([
    { dy: 0, bright: 1.00 },
    { deg: -5, dx: -2, bright: 0.95 },
    { dy: 1, bright: 1.00 },
    { deg: 5, dx: 2, bright: 0.95 },
  ]),
  // 点头：与 idle 的"呼吸"必须一眼看得出区别，所以位移更大、还带亮度脉冲
  talk: Object.freeze([
    { dy: 0, bright: 1.00 },
    { dy: -3, bright: 1.06 },
    { dy: 0, bright: 1.00 },
  ]),
  happy: Object.freeze([
    { deg: -6, dy: -2, bright: 1.10 },
    { deg: 0, dy: -5, bright: 1.14 },
    { deg: 6, dy: -2, bright: 1.10 },
  ]),
  worried: Object.freeze([
    { dx: -2, dy: 1, bright: 0.90 },
    { dx: 0, dy: 2, bright: 0.85 },
    { dx: 2, dy: 1, bright: 0.90 },
  ]),
  greeting: Object.freeze([
    { deg: -12, dy: -1, bright: 1.05 },
    { deg: 0, dy: -2, bright: 1.08 },
    { deg: 12, dy: -1, bright: 1.05 },
  ]),
  sleep: Object.freeze([
    { dy: 3, bright: 0.76 },
    { dy: 4, bright: 0.68 },
  ]),
})

/**
 * 从一张立绘推导某个动作的全部帧。
 * @param {{width:number,height:number,data:Uint8Array}} source
 * @param {string} actionId
 * @returns {Array<{width:number,height:number,data:Uint8Array}>}
 */
export function framesFor(source, actionId) {
  if (!source || !source.width || !source.height) throw new Error('缺立绘')
  const recipe = RECIPES[actionId]
  if (!recipe) throw new Error(`没有 ${actionId} 的变换配方（动作未登记？）`)
  return recipe.map((r) => {
    let img = source
    if (r.deg) img = rotate(img, r.deg)
    if (r.dx || r.dy) img = translate(img, r.dx ?? 0, r.dy ?? 0)
    if (r.bright && r.bright !== 1) img = scaleBrightness(img, r.bright)
    return img
  })
}

/**
 * 程序化 provider。接口与生成 provider 一致，便于互换。
 *
 * ★ 关于风格：**风格化不在这里做，由编排层（art/index.mjs）先做好再传进来。**
 *   理由是质量闸门的比较基准：程序化 provider 是"从源图推导帧"，
 *   所以基准必须是**风格化之后**的源图，否则线稿风会被当成"跑形"。
 *   编排层同时掌握着源图与闸门，所以由它来保证"基准与帧同风格"最自然。
 *   （对照：生成式 provider 的基准应当是**原图** —— 那才是"角色别跑形"的本意。
 *     两者的区别由 provider 的 `kind` 表达：`generative` 时编排层不做风格化。）
 */
export function createProceduralProvider() {
  return {
    id: 'procedural',
    name: '程序化（无 API）',
    kind: 'procedural',           // ← 关键：说明"帧是从源图推导来的"，不是重新生成的
    /** 帧由源图推导而来 ⇒ 质量闸门的基准要用（风格化后的）源图。 */
    derivesFromSource: true,
    available: () => true,
    /**
     * @param {object} p
     * @param {object} p.source   立绘（**已风格化**；缺省时由调用方先 synthStandingArt 补上）
     * @param {string} p.action   动作 id
     * @param {object} [p.card]
     * @param {string} [p.style]  仅用于写进 meta（真正的风格化在编排层做）
     * @returns {{frames:Array, meta:object}}
     */
    generate({ source, action, card, style } = {}) {
      const src = source ?? synthStandingArt({ seed: hashSeed(card?.id ?? card?.name ?? 'pet') })
      const { id, fallbackFrom } = resolveStyle(style ?? card?.animation?.style)
      return {
        frames: framesFor(src, action),
        meta: {
          provider: 'procedural',
          action,
          fromSource: Boolean(source),
          style: id,
          styleFallbackFrom: fallbackFrom,
          recipe: RECIPES[action]?.length ?? 0,
        },
      }
    },
  }
}

/** 风格化一张立绘（编排层用它把"基准"也换成同一个风格）。 */
export function styleSource(source, styleId) {
  return applyStyle(source, styleId)
}

export { resolveStyle }

// ---------- 零输入兜底：现画一个角色 ----------

/**
 * 程序化画一个立绘。**不是为了让画面好看**，而是让"完全没有素材"时链路仍然成立，
 * 并且给测试一个稳定的、有结构的源图（有结构才谈得上"动作之间要不一样"）。
 *
 * 画的东西很朴素：头（圆）+ 身体（圆角矩形）+ 两只眼睛 + 一块刘海。
 * 颜色由 seed 决定 —— 同一张卡每次画出同一个角色（确定性，便于复现与对比）。
 *
 * @param {{width?:number, height?:number, seed?:number, palette?:object}} [opts]
 */
export function synthStandingArt(opts = {}) {
  const W = opts.width ?? 64
  const H = opts.height ?? 96
  const seed = Number.isFinite(opts.seed) ? opts.seed : 7
  const pal = opts.palette ?? paletteFor(seed)
  const img = { width: W, height: H, data: new Uint8Array(W * H * 4) }

  const cx = Math.floor(W / 2)
  const headR = Math.floor(W * 0.26)
  const headCy = headR + Math.floor(H * 0.06)
  const bodyTop = headCy + headR - 2
  const bodyW = Math.floor(W * 0.62)
  const bodyH = H - bodyTop - Math.floor(H * 0.06)

  // 身体
  fillRoundRect(img, cx - Math.floor(bodyW / 2), bodyTop, bodyW, bodyH, Math.floor(W * 0.14), pal.body)
  // 头
  fillCircle(img, cx, headCy, headR, pal.skin)
  // 刘海
  fillCircle(img, cx, headCy - Math.floor(headR * 0.52), headR, pal.hair)
  fillRect(img, cx - headR, headCy - Math.floor(headR * 0.86), headR * 2, Math.floor(headR * 0.42), pal.hair)
  // 眼睛
  const eyeDx = Math.floor(headR * 0.38)
  const eyeR = Math.max(1, Math.floor(headR * 0.14))
  fillCircle(img, cx - eyeDx, headCy + Math.floor(headR * 0.10), eyeR, pal.eye)
  fillCircle(img, cx + eyeDx, headCy + Math.floor(headR * 0.10), eyeR, pal.eye)
  return img
}

/** 由 seed 派生一组颜色（同一 seed 恒定）。 */
export function paletteFor(seed) {
  const h = ((seed % 360) + 360) % 360
  return {
    skin: hsl(h, 0.22, 0.82),
    hair: hsl((h + 200) % 360, 0.35, 0.42),
    body: hsl((h + 30) % 360, 0.38, 0.55),
    eye: [40, 40, 48, 255],
  }
}

function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [Math.round((t[0] + m) * 255), Math.round((t[1] + m) * 255), Math.round((t[2] + m) * 255), 255]
}

// ---------- 极简光栅化（只够画上面那个形状） ----------

/** 直接覆盖（不做混合）：程序化立绘是"画上去"的，不是"叠上去"的，简单可预测更重要。 */
function put(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return
  const i = (y * img.width + x) * 4
  img.data[i] = rgba[0]; img.data[i + 1] = rgba[1]; img.data[i + 2] = rgba[2]
  img.data[i + 3] = rgba.length > 3 ? rgba[3] : 255
}

function fillRect(img, x, y, w, h, rgba) {
  for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
    for (let xx = Math.round(x); xx < Math.round(x + w); xx++) put(img, xx, yy, rgba)
  }
}

function fillCircle(img, cx, cy, r, rgba) {
  const r2 = r * r
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dy = y - cy
      if (dx * dx + dy * dy <= r2) put(img, x, y, rgba)
    }
  }
}

function fillRoundRect(img, x, y, w, h, r, rgba) {
  fillRect(img, x + r, y, w - 2 * r, h, rgba)
  fillRect(img, x, y + r, w, h - 2 * r, rgba)
  fillCircle(img, x + r, y + r, r, rgba)
  fillCircle(img, x + w - r - 1, y + r, r, rgba)
  fillCircle(img, x + r, y + h - r - 1, r, rgba)
  fillCircle(img, x + w - r - 1, y + h - r - 1, r, rgba)
}

/** 字符串 → 稳定 seed（同一张卡每次画出同一个角色）。 */
export function hashSeed(s) {
  let h = 2166136261
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return (h >>> 0) % 360
}

export { encodePng, decodePng, boxResize }
