// art/styles.mjs —— 画风（立绘 → 桌宠素材的**多风格**那一半）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么"多风格"要真的实现，而不是卡上一个没人读的字段
// ═══════════════════════════════════════════════════════════════════
// 目标要求是「立绘 → **多风格**多动作」。此前角色卡里的 `animation.style` 只是个字段 ——
// 校验器收下了它、没人读它，于是"选了像素风"跟没选一样。
// 这种字段比缺失更糟：**它让人以为功能存在**。
//
// ★ 管线顺序：`立绘 → 风格化 → 动作帧`
//   风格化必须**在动作之前**做，理由是质量闸门：
//   「与立绘的相似度下限」是拿动作帧跟"立绘"比的。
//   如果风格化只作用于动作、不作用于比较基准，那么线稿风与柔和风都会因为
//   "跟原图差太远"而被判跑形 —— 那是把**风格差异误判成跑形**。
//   所以比较基准要用**风格化之后**的立绘，原图另存一份只作记录。
//
// 三种风格都是纯图像运算（零依赖、可单测），而且每种都有**方向性可验证**的性质：
//   pixel —— 颜色数明显更少、高频更高（方块化）
//   line  —— 边缘占比明显更高、颜色数很少（只有线与底色）
//   soft  —— 高频明显更低（模糊），亮度更高
// 测试断言的就是这些方向，而不是"输出不一样"（那太弱，改一个像素就满足）。

import {
  nearestResize, boxBlur, desaturate, lighten, toLineArt, boxResize,
} from './image.mjs'

/** 风格表。`card.animation.style` 取值必须在这里（core/card.mjs 会校验）。 */
export const STYLES = Object.freeze({
  soft: Object.freeze({
    id: 'soft',
    label: '柔和',
    note: '轻微模糊 + 稍亮，颜色偏淡。桌宠放在桌面上最不刺眼。',
    // 参数都在这里，便于调；测试用方向性性质而不是精确值
    blur: 1,
    lighten: 1.12,
    desaturate: 0.12,
  }),
  pixel: Object.freeze({
    id: 'pixel',
    label: '像素',
    note: '降采样再最近邻放大，得到方块感。适合本来就偏像素的游戏。',
    blockSize: 3,
  }),
  line: Object.freeze({
    id: 'line',
    label: '线稿',
    note: '只留边缘线 + 极淡的底色。最"轻"，也最不像原图 —— 但对桌宠来说省视觉噪音。',
    threshold: 0.16,
    fillAlpha: 110,
  }),
})

export const STYLE_IDS = Object.freeze(Object.keys(STYLES))

/** 取值非法时退回哪个风格。选 soft 是因为它对任何立绘都最安全（不会把图毁掉）。 */
export const DEFAULT_STYLE = 'soft'

/**
 * 把一个风格 id 归一化成合法值。
 * @returns {{id:string, style:object, fallbackFrom:string|null}}
 */
export function resolveStyle(id) {
  if (typeof id === 'string' && STYLES[id]) return { id, style: STYLES[id], fallbackFrom: null }
  return { id: DEFAULT_STYLE, style: STYLES[DEFAULT_STYLE], fallbackFrom: id == null ? null : String(id) }
}

/**
 * 给一张图套风格。**纯函数**（返回新图，不改入参）。
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {string} styleId
 * @returns {{image:object, meta:object}}
 */
export function applyStyle(img, styleId) {
  if (!img || !img.width || !img.height) throw new Error('applyStyle 需要一张图')
  const { id, style, fallbackFrom } = resolveStyle(styleId)
  let out = img
  switch (id) {
    case 'pixel': {
      const b = Math.max(2, style.blockSize)
      const w = Math.max(1, Math.round(img.width / b))
      const h = Math.max(1, Math.round(img.height / b))
      // ★ 两步都用**最近邻**，不要用面积平均（boxResize）。
      //   首先试的是"面积平均降采样 + 最近邻放大"，实测结果是**颜色反而变多了**
      //   （原图 4 色 → 36 色）：平均会在块边界造出一堆中间色。
      //   而像素风的本意是"**保留调色板** + 方块化"，所以降采样必须直接取样。
      out = nearestResize(nearestResize(img, w, h), img.width, img.height)
      break
    }
    case 'line':
      out = toLineArt(img, { threshold: style.threshold, keepFill: true, fillAlpha: style.fillAlpha })
      break
    case 'soft':
    default: {
      out = img
      if (style.blur > 0) out = boxBlur(out, style.blur)
      if (style.lighten !== 1) out = lighten(out, style.lighten)
      if (style.desaturate > 0) out = desaturate(out, style.desaturate)
      break
    }
  }
  return {
    image: out,
    meta: { style: id, label: style.label, fallbackFrom },
  }
}

/** 给界面用的一句话说明。 */
export function describeStyle(id) {
  const { id: sid, style, fallbackFrom } = resolveStyle(id)
  const warn = fallbackFrom ? `（不认识风格「${fallbackFrom}」，已退回 ${sid}）` : ''
  return `${style.label}：${style.note}${warn}`
}

/**
 * 判断一张图"看起来像不像"某个风格 —— 用于测试与自检，也可给界面做提示。
 * 方向性判据（不是精确值）：
 *   pixel ⇒ 颜色数少
 *   line  ⇒ 边缘占比高
 *   soft  ⇒ 高频低
 */
export function styleFingerprint(img, metrics) {
  const { distinctColors, highFrequencyEnergy, edgeRatio } = metrics
  return {
    colors: distinctColors(img),
    hf: highFrequencyEnergy(img),
    edges: Number(edgeRatio(img).toFixed(3)),
  }
}
