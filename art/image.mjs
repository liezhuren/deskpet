// art/image.mjs —— 零依赖的 PNG 编解码 + 感知哈希
//
// ═══════════════════════════════════════════════════════════════════
// 为什么素材层需要自己写 PNG（ARCHITECTURE §7）
// ═══════════════════════════════════════════════════════════════════
// 「立绘 → 多风格多动作」最容易被含糊带过的地方是**质量**：
// 生成的六个动作是不是其实是同一张图？角色有没有跑形？
// 这两个问题只有落到**像素**上才能自动回答，所以必须有：
//   · decode —— 读用户的立绘（PNG 是最常见的分发格式）
//   · encode —— 程序化兜底要能产出真图，而不是"某处会生成"
//   · 哈希   —— 两张图像不像，需要一个可比较的量
// 零依赖是刻意的：Node 自带 zlib，PNG 剩下的部分（chunk / 滤波 / CRC）都是确定性代码，
// 自己写反而比引一个图像库更容易验证（而且 core/ 的零依赖立场要一致）。
//
// ⚠ 支持范围（如实说明，不假装支持全部）：
//   支持：bitDepth 8、colorType 0/2/3/4/6、非隔行、tRNS 透明色
//   不支持：隔行（Adam7）、bitDepth 1/2/4/16 —— 遇到会**明确抛错**，不静默出错图
//   编码：只产出 bitDepth 8 / colorType 6（RGBA），这也是桌宠素材最需要的

import { deflateSync, inflateSync } from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG 每个 colorType 的通道数。 */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

// ---------- CRC32（PNG chunk 校验用；也用来做"文件有没有坏"的检测） ----------

let CRC_TABLE = null
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  CRC_TABLE = t
  return t
}

export function crc32(buf) {
  const t = crcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------- 解码 ----------

/**
 * 解码 PNG → RGBA8 像素。
 * @param {Buffer|Uint8Array} input
 * @returns {{width:number, height:number, data:Uint8Array}} data 是 RGBA，每像素 4 字节
 */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG（签名不对）')

  let off = 8
  let ihdr = null
  const idat = []
  let palette = null
  let trns = null
  let sawIend = false

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const dataStart = off + 8
    const dataEnd = dataStart + len
    if (dataEnd + 4 > buf.length) throw new Error(`PNG 截断在 ${type} chunk`)
    const data = buf.subarray(dataStart, dataEnd)
    const wantCrc = buf.readUInt32BE(dataEnd)
    const gotCrc = crc32(buf.subarray(off + 4, dataEnd))
    if (wantCrc !== gotCrc) throw new Error(`${type} chunk 的 CRC 不符 —— 文件可能损坏`)

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      }
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      trns = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      sawIend = true
      break
    }
    off = dataEnd + 4
  }

  if (!ihdr) throw new Error('PNG 缺 IHDR')
  if (!sawIend) throw new Error('PNG 缺 IEND')
  if (ihdr.interlace !== 0) throw new Error('不支持隔行（Adam7）PNG')
  if (ihdr.bitDepth !== 8) throw new Error(`不支持 bitDepth ${ihdr.bitDepth}（只支持 8）`)
  if (ihdr.compression !== 0 || ihdr.filter !== 0) throw new Error('不支持非标准压缩/滤波方法')
  const ch = CHANNELS[ihdr.colorType]
  if (!ch) throw new Error(`不支持的 colorType ${ihdr.colorType}`)
  if (ihdr.colorType === 3 && !palette) throw new Error('调色板 PNG 缺 PLTE')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = ihdr.width * ch
  const expected = (stride + 1) * ihdr.height
  if (raw.length < expected) throw new Error(`IDAT 解压后长度不足：${raw.length} < ${expected}`)

  const pixels = unfilter(raw, ihdr.height, stride, ch)
  const data = toRgba(pixels, ihdr, ch, palette, trns)
  return { width: ihdr.width, height: ihdr.height, data }
}

/** 逐扫描线反滤波。bpp = 每像素字节数（bitDepth=8 时等于通道数）。 */
function unfilter(raw, height, stride, bpp) {
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      switch (ft) {
        case 0: break
        case 1: v = (v + a) & 0xff; break
        case 2: v = (v + b) & 0xff; break
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break
        case 4: v = (v + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`未知的滤波类型 ${ft}（第 ${y} 行）`)
      }
      cur[x] = v
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 统一转成 RGBA。 */
function toRgba(px, ihdr, ch, palette, trns) {
  const n = ihdr.width * ihdr.height
  const out = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const s = i * ch, d = i * 4
    switch (ihdr.colorType) {
      case 0: { // 灰度
        const g = px[s]
        out[d] = g; out[d + 1] = g; out[d + 2] = g
        out[d + 3] = trns && trns.length >= 2 && px[s] === trns.readUInt16BE(0) ? 0 : 255
        break
      }
      case 2: { // RGB
        out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]
        out[d + 3] = trns && trns.length >= 6 && px[s] === trns.readUInt16BE(0) &&
          px[s + 1] === trns.readUInt16BE(2) && px[s + 2] === trns.readUInt16BE(4) ? 0 : 255
        break
      }
      case 3: { // 调色板
        const idx = px[s]
        out[d] = palette[idx * 3] ?? 0
        out[d + 1] = palette[idx * 3 + 1] ?? 0
        out[d + 2] = palette[idx * 3 + 2] ?? 0
        out[d + 3] = trns && idx < trns.length ? trns[idx] : 255
        break
      }
      case 4: { // 灰度 + alpha
        const g = px[s]
        out[d] = g; out[d + 1] = g; out[d + 2] = g; out[d + 3] = px[s + 1]
        break
      }
      default: { // 6: RGBA
        out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3]
      }
    }
  }
  return out
}

// ---------- 编码 ----------

/**
 * 编码成 PNG（bitDepth 8 / RGBA / 非隔行 / 滤波全 0）。
 * 滤波刻意只用手册里最简单的 0，因为本项目的图都很小（桌宠帧），压缩率不是瓶颈，
 * 而"滤波器实现错了"是很容易引入又很难看出的 bug。
 * @param {{width:number, height:number, data:Uint8Array|Buffer}} img
 * @returns {Buffer}
 */
export function encodePng(img) {
  const { width, height } = img
  const data = Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('宽高必须是正整数')
  }
  if (data.length < width * height * 4) throw new Error('像素数据长度不足（需要 RGBA，每像素 4 字节）')

  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // 滤波类型 0
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

// ---------- 基础操作 ----------

/** 灰度值（Rec.601 亮度）。 */
export function grayAt(img, x, y) {
  const i = (y * img.width + x) * 4
  return (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2])
}

/** 面积平均缩放（比最近邻更适合做哈希：不会被单点噪声带偏）。 */
export function boxResize(img, w, h) {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3]; n++
        }
      }
      const d = (y * w + x) * 4
      out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n)
      out[d + 2] = Math.round(b / n); out[d + 3] = Math.round(a / n)
    }
  }
  return { width: w, height: h, data: out }
}

/** 平移（正数向右/向下），空出来的区域按透明填充。 */
export function translate(img, dx, dy) {
  const out = new Uint8Array(img.width * img.height * 4)
  for (let y = 0; y < img.height; y++) {
    const sy = y - dy
    if (sy < 0 || sy >= img.height) continue
    for (let x = 0; x < img.width; x++) {
      const sx = x - dx
      if (sx < 0 || sx >= img.width) continue
      const s = (sy * img.width + sx) * 4, d = (y * img.width + x) * 4
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]
      out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3]
    }
  }
  return { width: img.width, height: img.height, data: out }
}

/** 整图乘一个亮度系数（0..2），保留 alpha。用于"呼吸/高亮"这类变化。 */
export function scaleBrightness(img, factor) {
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = clamp8(img.data[i] * factor)
    out[i + 1] = clamp8(img.data[i + 1] * factor)
    out[i + 2] = clamp8(img.data[i + 2] * factor)
    out[i + 3] = img.data[i + 3]
  }
  return { width: img.width, height: img.height, data: out }
}

/**
 * 绕中心旋转（最近邻，尺寸不变，转出去的地方填透明）。
 * 为什么需要它：「倾斜」「挥手」这类动作靠平移表达不出来，
 * 而整套动作若只有位移和亮度差，很容易被质量闸门判成"几张图其实是同一张"（那是真该判的）。
 * 用最近邻是刻意的：双线性会引入新像素值，让"逐像素相同"这类判断变得模糊。
 */
export function rotate(img, deg) {
  const rad = (Number(deg) || 0) * Math.PI / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  const cx = (img.width - 1) / 2, cy = (img.height - 1) / 2
  const out = new Uint8Array(img.width * img.height * 4)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = x - cx, dy = y - cy
      // 逆变换：目标点反向旋转回源坐标
      const sx = Math.round(cx + dx * cos + dy * sin)
      const sy = Math.round(cy - dx * sin + dy * cos)
      if (sx < 0 || sx >= img.width || sy < 0 || sy >= img.height) continue
      const s = (sy * img.width + sx) * 4, d = (y * img.width + x) * 4
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]
      out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3]
    }
  }
  return { width: img.width, height: img.height, data: out }
}

const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)))

// ---------- 感知哈希与相似度（两条质量底线的度量） ----------

/**
 * 平均哈希：缩到 size×size 灰度 → 与均值比较 → 每像素 1 bit → 十六进制串。
 * 对缩放、轻微位移、亮度变化不敏感，正好用来问"这两张图画的是不是同一个角色"。
 * @returns {string} size=8 时是 16 个十六进制字符
 */
export function averageHash(img, size = 8) {
  const small = boxResize(img, size, size)
  const g = new Float64Array(size * size)
  let sum = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = grayAt(small, x, y)
      g[y * size + x] = v
      sum += v
    }
  }
  const mean = sum / (size * size)
  let hex = ''
  for (let i = 0; i < size * size; i += 4) {
    let nib = 0
    for (let b = 0; b < 4; b++) if (g[i + b] > mean) nib |= 1 << (3 - b)
    hex += nib.toString(16)
  }
  return hex
}

/** 汉明距离（两个等长十六进制哈希之间不同的 bit 数）。 */
export function hamming(hexA, hexB) {
  const a = String(hexA ?? ''), b = String(hexB ?? '')
  const n = Math.min(a.length, b.length)
  if (n === 0) return Infinity
  let d = Math.abs(a.length - b.length) * 4
  for (let i = 0; i < n; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>>= 1 }
  }
  return d
}

/**
 * 归一化平均绝对差（0 = 完全一样，1 = 完全不同）。
 * 只有在两张图尺寸相同时才逐像素比；不同则先缩到公共尺寸 —— 这一步要显式做，
 * 免得"尺寸不同就返回 1"，那会把"图不一样"和"没法比"混为一谈。
 */
export function meanAbsDiff(a, b) {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const x = (a.width === w && a.height === h) ? a : boxResize(a, w, h)
  const y = (b.width === w && b.height === h) ? b : boxResize(b, w, h)
  let sum = 0
  for (let i = 0; i < w * h * 4; i++) sum += Math.abs(x.data[i] - y.data[i])
  return sum / (w * h * 4 * 255)
}

/** 不透明像素占比 —— 用来判断"这张图是不是空的/几乎全透明"。 */
export function opaqueRatio(img, threshold = 16) {
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > threshold) n++
  return n / (img.width * img.height)
}

// ---------- 风格化原语（art/styles.mjs 靠它们实现"多风格"） ----------

/** 最近邻缩放。**像素风必须用它**：boxResize 是面积平均，会把方块糊成渐变。 */
export function nearestResize(img, w, h) {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w))
      const s = (sy * img.width + sx) * 4, d = (y * w + x) * 4
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]
      out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3]
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * 盒式模糊。
 * ⚠ 只对**不透明像素**按 alpha 加权取平均：否则透明区域的黑色会被算进来，
 *   角色边缘会出现一圈脏黑。
 */
export function boxBlur(img, radius = 1) {
  const { width: w, height: h } = img
  const out = new Uint8Array(img.data.length)
  const n = radius * 2 + 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, wsum = 0
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx, sy = y + dy
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
          const i = (sy * w + sx) * 4
          const aw = img.data[i + 3] / 255
          r += img.data[i] * aw; g += img.data[i + 1] * aw; b += img.data[i + 2] * aw
          a += img.data[i + 3]; wsum += aw
        }
      }
      const d = (y * w + x) * 4
      out[d] = wsum > 0 ? clamp8(r / wsum) : 0
      out[d + 1] = wsum > 0 ? clamp8(g / wsum) : 0
      out[d + 2] = wsum > 0 ? clamp8(b / wsum) : 0
      out[d + 3] = clamp8(a / (n * n))
    }
  }
  return { width: w, height: h, data: out }
}

/** 去饱和：amount 0 = 原色，1 = 全灰。alpha 不动。 */
export function desaturate(img, amount = 1) {
  const k = Math.max(0, Math.min(1, amount))
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    const g = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
    out[i] = clamp8(img.data[i] * (1 - k) + g * k)
    out[i + 1] = clamp8(img.data[i + 1] * (1 - k) + g * k)
    out[i + 2] = clamp8(img.data[i + 2] * (1 - k) + g * k)
    out[i + 3] = img.data[i + 3]
  }
  return { width: img.width, height: img.height, data: out }
}

/** 提亮（factor > 1 变亮），保留 alpha。 */
export function lighten(img, factor = 1.1) {
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    out[i] = clamp8(255 - (255 - img.data[i]) / factor)
    out[i + 1] = clamp8(255 - (255 - img.data[i + 1]) / factor)
    out[i + 2] = clamp8(255 - (255 - img.data[i + 2]) / factor)
    out[i + 3] = img.data[i + 3]
  }
  return { width: img.width, height: img.height, data: out }
}

/** 每像素的梯度强度（0..1）—— 线稿化与"边缘占比"都用它。 */
export function edgeMagnitude(img) {
  const { width: w, height: h } = img
  const lum = new Float64Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lum[y * w + x] = grayAt(img, x, y)
  const mag = new Float64Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx = lum[y * w + x + 1] - lum[y * w + x - 1]
      const gy = lum[(y + 1) * w + x] - lum[(y - 1) * w + x]
      mag[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 255)
    }
  }
  return { mag, width: w, height: h }
}

/**
 * 线稿化：边缘画深线，其余按 keepFill 决定留不留淡填充。
 * @param {{threshold?:number, color?:number[], keepFill?:boolean, fillAlpha?:number}} [opts]
 */
export function toLineArt(img, opts = {}) {
  const threshold = opts.threshold ?? 0.16
  const color = opts.color ?? [38, 36, 46]
  const keepFill = opts.keepFill === true
  const fillAlpha = opts.fillAlpha ?? 120
  const { mag, width: w, height: h } = edgeMagnitude(img)
  const pale = desaturate(lighten(img, 1.35), 0.75)
  const out = new Uint8Array(img.data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (img.data[i + 3] === 0) continue
      if (mag[y * w + x] >= threshold) {
        out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2]; out[i + 3] = 255
      } else if (keepFill) {
        out[i] = pale.data[i]; out[i + 1] = pale.data[i + 1]; out[i + 2] = pale.data[i + 2]
        out[i + 3] = clamp8(fillAlpha * (img.data[i + 3] / 255))
      }
    }
  }
  return { width: w, height: h, data: out }
}

// ---------- 用来**验证风格真的生效**的度量 ----------
// 「输出不一样」这种断言太弱 —— 随便改一个像素就满足了。
// 下面三个度量让测试能断言"像素风颜色更少""柔和风高频更低"这类**方向性**的性质。

/** 不重复颜色数（只数不透明像素；max 便于早停）。像素风应当明显更少。 */
export function distinctColors(img, max = 4096) {
  const set = new Set()
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 16) continue
    set.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2])
    if (set.size >= max) break
  }
  return set.size
}

/**
 * 相邻像素水平差的**均值** —— 模糊会降低它，像素化/线稿会提高它。
 * ⚠ 用均值而不是中位数：桌宠素材里大片是纯色，中位数恒为 0，
 *   于是这个度量对"糊没糊"完全不敏感（实测三种风格都是 0）。
 *   均值虽然也被大片纯色稀释，但至少能分出方向。
 */
export function highFrequencyEnergy(img) {
  const { width: w, height: h } = img
  let sum = 0, n = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4
      if (img.data[i + 3] < 16 || img.data[i + 7] < 16) continue
      sum += Math.abs(img.data[i] - img.data[i + 4])
      n++
    }
  }
  return n === 0 ? 0 : sum / n
}

/** 边缘像素占比（相对不透明像素）—— 线稿应当明显更高。 */
export function edgeRatio(img, threshold = 0.16) {
  const { mag, width: w, height: h } = edgeMagnitude(img)
  let edge = 0, solid = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (img.data[(y * w + x) * 4 + 3] < 16) continue
      solid++
      if (mag[y * w + x] >= threshold) edge++
    }
  }
  return solid === 0 ? 0 : edge / solid
}
