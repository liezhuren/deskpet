// core/decode.mjs —— 存档解码链（零依赖，纯逻辑）
//
// 为什么需要它（见 docs/ARCHITECTURE.md §2.2、§6）：
//   实测本机 60+ 款 Unity 游戏的存档后可以确认：存档格式是一个**谱系** ——
//     明文 JSON（森林之子 PlayerProfile.json）
//     → 纯文本资源（Godot .tres / .ini）
//     → zip 容器（森林之子 SaveData.zip）
//     → LZString+base64（RPG Maker MV/MZ .rpgsave）
//     → .NET BinaryFormatter（空洞骑士 user1.dat，magic 00 01 00 00 00 ff ff ff ff）
//     → 高熵加密块（致命公司 LCGeneralSaveData，magic 18 d0 06 a2 …）
//   不可能靠一个解析器通吃，所以本模块是**一条可降级的链**：逐级尝试，任一级失败就往下走。
//
// ★ 设计要点：**认不出来不是失败。**
//   无论内容能否解析，`decodeSaveFile` 永远返回 sha256 与 size —— 光凭「这个文件被写入了」
//   就足以驱动时机引擎（ARCHITECTURE §3 原则 P2）。内容解析只是锦上添花。
//   因此本模块对「正常解不开」**不抛异常**，而是返回 ok:false + notes 说明卡在哪一步。
//
// ★ 按内容嗅探，不按扩展名。实测教训：致命公司的存档没有扩展名，森林之子用 .zip，
//   空洞骑士用 .dat 但其实是 BinaryFormatter。扩展名会骗人。

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { gunzipSync, inflateSync, inflateRawSync } from 'node:zlib'
import { decompressFromBase64 } from './lzstring.mjs'
import { parseXml } from './xml.mjs'

/** 单次解码尝试的默认上限。 */
export const DEFAULTS = Object.freeze({
  maxBytes: 64 * 1024 * 1024, // 超过就不解析内容（实测有 40MB 的日志/补丁文件）
  maxDepth: 4,                // 容器套容器的层数上限
  zipMaxEntries: 64,
  zipMaxEntryBytes: 8 * 1024 * 1024,
})

/** 已识别的格式标识（chain 里的每一节）。 */
export const FORMAT = Object.freeze({
  JSON: 'json',
  JSON_OFFSET: 'json@offset',
  GZIP: 'gzip',
  ZLIB: 'zlib',
  ZIP: 'zip',
  LZSTRING: 'lzstring',
  BASE64: 'base64',
  BASE64_TEXT: 'base64-text',
  BASE64_BINARY: 'base64-binary',
  XML: 'xml',
  GODOT_RES: 'godot-resource',
  INI: 'ini',
  TEXT: 'text',
  BINARY_FORMATTER: 'dotnet-binaryformatter',
  BINARY: 'binary',
  EMPTY: 'empty',
  TOO_LARGE: 'too-large',
  UNKNOWN: 'unknown',
})

// ---------- 对外入口 ----------

/**
 * 从文件路径解码。除解码内容外，**永远**附带 size / sha256 / mtimeMs。
 * @param {string} filePath
 * @param {object} [opts] 见 DEFAULTS
 * @returns {object} 见 decodeSaveBuffer
 */
export function decodeSaveFile(filePath, opts = {}) {
  const d = { ...DEFAULTS, ...opts }
  let st
  try {
    st = statSync(filePath)
  } catch (e) {
    return base({ ok: false, format: FORMAT.UNKNOWN, path: filePath, notes: [`stat 失败：${e.code ?? e.message}`] })
  }
  if (!st.isFile()) {
    return base({ ok: false, format: FORMAT.UNKNOWN, path: filePath, notes: ['不是普通文件（可能是目录）'] })
  }

  let buf
  try {
    buf = readFileSync(filePath)
  } catch (e) {
    return base({ ok: false, format: FORMAT.UNKNOWN, path: filePath, size: st.size, notes: [`读取失败：${e.code ?? e.message}`] })
  }

  const r = decodeSaveBuffer(buf, d)
  return { ...r, path: filePath, size: st.size, mtimeMs: st.mtimeMs }
}

/**
 * 从 Buffer 解码。返回值形状：
 *
 *   {
 *     ok: boolean,          // 内容是否解析成功
 *     format: string,       // 最外层容器格式（= chain[0]）
 *     content: string,      // 最终解出的格式（= chain 末节）；未解开时等于 format
 *     chain: string[],      // 实际走过的容器链，如 ['gzip','json'] 或 ['base64','xml']
 *     value: any|null,      // 解析出的 JS 值（可直接喂给 core/diff.mjs）
 *     text: string|null,    // 文本型格式的原文（便于诊断）
 *     entries: Array|null,  // zip 的条目清单
 *     sha256: string,       // ★ 永远有
 *     size: number,         // ★ 永远有
 *     notes: string[],      // 每一步的说明与失败原因（诊断用）
 *   }
 */
export function decodeSaveBuffer(buf, opts = {}) {
  const d = { ...DEFAULTS, ...opts }
  const notes = []
  const sha256 = sha256Of(buf)
  const size = buf.length
  if (!Buffer.isBuffer(buf)) { notes.push('入参不是 Buffer'); return base({ ok: false, format: FORMAT.UNKNOWN, size, sha256, notes }) }
  if (size === 0) { notes.push('空文件'); return base({ ok: false, format: FORMAT.EMPTY, size, sha256, notes }) }
  if (size > d.maxBytes) {
    notes.push(`超过 maxBytes(${d.maxBytes})，只计算哈希不解析内容`)
    return base({ ok: false, format: FORMAT.TOO_LARGE, size, sha256, notes })
  }

  const inner = tryDecode(buf, d, notes, 0)
  const chain = inner.chain ?? []
  // format = 最外层容器（chain[0]），content = 最终解出来的格式（chain 末节）。
  // 两个都要给：zip 里装 JSON 时，问「这是什么文件」和「里面是什么」是两个不同的问题。
  return base({
    ...inner,
    format: chain[0] ?? FORMAT.UNKNOWN,
    content: chain[chain.length - 1] ?? FORMAT.UNKNOWN,
    size,
    sha256,
    notes,
  })
}

// ---------- 解码主链 ----------

function tryDecode(buf, d, notes, depth) {
  // 0) 先剥掉 UTF-8 BOM。**必须在这里做**：否则 BOM 的 ef bb bf 会被 tryJsonAtOffset
  //    当成「前 3 字节是二进制头部」，把一份普通 JSON 误报成 json@offset。
  //    这不是纸上谈兵 —— 实测 Mogurasoft/costume.sav 开头就是 ef bb bf，Windows 侧工具很爱加 BOM。
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    notes.push('剥掉 UTF-8 BOM')
    buf = buf.subarray(3)
  }

  // 1) 压缩容器：先脱壳，再对内容重新走一遍链
  const magic = sniffMagic(buf)

  if (magic === 'gzip' || magic === 'zlib') {
    if (depth >= d.maxDepth) {
      notes.push(`嵌套超过 maxDepth(${d.maxDepth})，停止脱壳`)
      return { ok: false, format: magic, chain: [magic], value: null, text: null, entries: null }
    }
    try {
      const out = magic === 'gzip' ? gunzipSync(buf) : inflateSync(buf)
      notes.push(`${magic} 解压成功：${buf.length} → ${out.length} 字节`)
      const inner = tryDecode(out, d, notes, depth + 1)
      return { ...inner, chain: [magic, ...inner.chain] }
    } catch (e) {
      notes.push(`${magic} 解压失败：${e.code ?? e.message}`)
      return { ok: false, format: magic, chain: [magic], value: null, text: null, entries: null }
    }
  }

  if (magic === 'zip') return decodeZip(buf, d, notes, depth)

  // 2) 明确识别但无法解析的二进制格式 —— 认出来本身就是有价值的信息
  if (magic === 'binary-formatter') {
    notes.push('识别为 .NET BinaryFormatter（SerializationHeaderRecord）。本工具不实现二进制反序列化，' +
      '将退回「只知道文件变了」—— 这对时机引擎已经够用。')
    return { ok: false, format: FORMAT.BINARY_FORMATTER, chain: [FORMAT.BINARY_FORMATTER], value: null, text: null, entries: null }
  }

  // 3) 前几字节是二进制头部，其后是明文 JSON。
  //    实测：Hunter Studio《失落城堡》的 game_save.sav 开头是 b7 41，紧接着就是
  //    {"record":[{"gameRound":19,... —— 前面那 2 字节像是版本/长度头。
  //    只试第一个 { 或 [，且只在头部无 NUL 时尝试，避免在真二进制上乱猜。
  if (magic === null) {
    const off = tryJsonAtOffset(buf)
    if (off) {
      notes.push(`前 ${off.offset} 字节是二进制头部，其后为明文 JSON`)
      return { ok: true, format: FORMAT.JSON_OFFSET, chain: [FORMAT.JSON_OFFSET, FORMAT.JSON], value: off.value, text: null, entries: null }
    }
  }

  // 4) 其它二进制：不再尝试文本解析
  if (looksBinary(buf)) {
    notes.push('内容非文本（含 NUL 或大量控制字符），可能是加密或私有二进制格式')
    return { ok: false, format: FORMAT.BINARY, chain: [FORMAT.BINARY], value: null, text: null, entries: null }
  }

  // 5) 文本链
  return decodeText(buf, d, notes, depth)
}

function decodeText(buf, d, notes, depth = 0) {
  const text = stripBom(buf.toString('utf8'))

  // 5a) 明文 JSON
  const j = tryJson(text)
  if (j !== undefined) {
    notes.push('按明文 JSON 解析成功')
    return { ok: true, format: FORMAT.JSON, chain: [FORMAT.JSON], value: j, text, entries: null }
  }

  // 5b) XML —— 实测 Noita 的存档是 XML
  const looksXml = /^\s*<\?xml\b/.test(text) || /^\s*<[A-Za-z_][\w.:-]*[\s/>]/.test(text)
  if (looksXml) {
    const x = parseXml(text)
    if (x) {
      notes.push(`按 XML 解析成功：根元素 ${Object.keys(x).join('、')}`)
      return { ok: true, format: FORMAT.XML, chain: [FORMAT.XML], value: x, text, entries: null }
    }
    notes.push('看起来像 XML 但没解析出元素')
  }

  // 5c) Godot 资源（.tres / .tscn）—— 实测这是信息量最大的格式
  if (/^\s*\[gd_(resource|scene)\b/.test(text) || /^\s*\[resource\]\s*$/m.test(text)) {
    const parsed = parseGodotResource(text)
    if (parsed) {
      notes.push(`按 Godot 资源解析成功：${Object.keys(parsed.props).length} 个属性`)
      return { ok: true, format: FORMAT.GODOT_RES, chain: [FORMAT.GODOT_RES], value: parsed.props, text, entries: null, godot: parsed }
    }
    notes.push('看起来像 Godot 资源但没解析出属性')
  }

  // 5d) INI / ConfigFile
  if (/^\s*\[[^\]]+\]\s*$/m.test(text) && /^\s*[\w.]+\s*=/m.test(text)) {
    const ini = parseIni(text)
    notes.push(`按 INI 解析成功：${Object.keys(ini).length} 个节`)
    return { ok: true, format: FORMAT.INI, chain: [FORMAT.INI], value: ini, text, entries: null }
  }

  // 5e) LZString + base64（RPG Maker MV/MZ 的 .rpgsave / .rmmzsave）
  const lz = tryLzString(text)
  if (lz !== undefined) {
    notes.push('按 LZString(base64) 解出 JSON —— RPG Maker MV/MZ 存档格式')
    return { ok: true, format: FORMAT.LZSTRING, chain: [FORMAT.LZSTRING, FORMAT.JSON], value: lz, text, entries: null }
  }

  // 5f) 通用 base64 解包：解开后若是文本，重新走一遍文本链。
  //     实测：Ultimate Chicken Horse 的 saveData.uch 就是 base64 包着的 XML：
  //     解开得到 <UCHSave version="1.11.01" creationDate="..." lastSaveDate="...">
  if (isBase64Blob(text) && depth < d.maxDepth) {
    const decoded = Buffer.from(text.trim(), 'base64')
    if (!looksBinary(decoded)) {
      const inner = decodeText(decoded, d, notes, depth + 1)
      if (inner.ok) {
        notes.push('base64 解包后是文本，已重新解析')
        return { ...inner, chain: [FORMAT.BASE64, ...inner.chain] }
      }
      notes.push('是 base64，解出来是文本但不是已知结构（可能被额外加密）')
      // 注意这里 chain 只有一节：base64-text 是**终审结论**，不是容器层级 ——
      // 链条表示「走到了哪里」，而这里根本没走到任何可识别的内部结构。
      return { ok: false, format: FORMAT.BASE64_TEXT, chain: [FORMAT.BASE64_TEXT], value: null, text, entries: null }
    }
    notes.push(`是单行 base64（${text.trim().length} 字符），但解出来不是文本 —— 多半是加密的`)
    return { ok: false, format: FORMAT.BASE64_BINARY, chain: [FORMAT.BASE64_BINARY], value: null, text, entries: null }
  }

  notes.push('是文本，但不是 JSON / XML / Godot 资源 / INI，也不是 LZString 或 base64')
  return { ok: false, format: FORMAT.TEXT, chain: [FORMAT.TEXT], value: null, text, entries: null }
}

/**
 * 单行 base64 判定。要求「够长 + 无空白 + 纯 base64 字符集 + 长度是 4 的倍数」。
 * 门槛刻意收紧：普通英文单词也可能全落在 base64 字符集里，短串上做这个判断必然误报。
 */
function isBase64Blob(text) {
  const t = text.trim()
  if (t.length < 32) return false
  if (/\s/.test(t)) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return false
  return t.length % 4 === 0
}

/**
 * 见 tryDecode 第 3 步。只在第一个 { 或 [ 处尝试一次。
 *
 * ⚠ 前导**空白**必须排除：`"  \r\n{"a":1}"` 里 `{` 也在偏移 4，但那是普通 JSON 的缩进，
 * 不是二进制头部。少了这条判断，一份带前导空白的 JSON 就会被误报成 json@offset。
 * （BOM 已在 tryDecode 开头剥掉，不会走到这里。）
 */
function tryJsonAtOffset(buf, maxScan = 64) {
  const limit = Math.min(buf.length, maxScan)
  for (let i = 1; i < limit; i++) {
    const c = buf[i]
    if (c !== 0x7b && c !== 0x5b) continue
    for (let k = 0; k < i; k++) {
      if (buf[k] === 0) return null                                   // 头部有 NUL ⇒ 真二进制
      if (!isAsciiWhitespace(buf[k])) {
        const v = tryJson(buf.toString('utf8', i))
        return v === undefined ? null : { offset: i, value: v }
      }
    }
    return null                                                       // 整个前缀都是空白 ⇒ 交给常规 JSON 分支
  }
  return null
}

const isAsciiWhitespace = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c || b === 0x0b

/** LZString 分支：必须解出来还得是 JSON，否则就说明这不是 LZString 存档（避免误判）。 */
function tryLzString(text) {
  const t = text.trim()
  if (t.length < 8) return undefined
  if (!/^[A-Za-z0-9+/=]+$/.test(t)) return undefined // base64 字符集
  if (/^\s*[[{]/.test(t)) return undefined           // 明显是 JSON，别抢
  let out
  try {
    out = decompressFromBase64(t)
  } catch {
    return undefined
  }
  if (typeof out !== 'string' || out.length === 0) return undefined
  return tryJson(out)
}

// ---------- zip ----------

/**
 * zip 容器。实测森林之子用 SaveData.zip（6,735B）存世界存档，并保留带时间戳的备份 zip。
 *
 * 产出 `value` = 以条目名为键的对象：每个条目要么是解出来的内部值，要么是它的 sha256。
 * 这样两次存档可以直接做结构 diff —— 「哪个内部文件变了」自然就成了路径差异。
 */
function decodeZip(buf, d, notes, depth) {
  let entries
  try {
    entries = readZipEntries(buf)
  } catch (e) {
    notes.push(`zip 目录解析失败：${e.message}`)
    return { ok: false, format: FORMAT.ZIP, chain: [FORMAT.ZIP], value: null, text: null, entries: null }
  }
  notes.push(`zip 容器，共 ${entries.length} 个条目`)

  const list = entries.slice(0, d.zipMaxEntries)
  if (entries.length > list.length) notes.push(`条目过多，只解析前 ${list.length} 个`)

  const value = {}
  for (const e of list) {
    if (e.size > d.zipMaxEntryBytes) {
      value[e.name] = { __sha256: sha256Of(extractZipEntry(buf, e)), __size: e.size }
      notes.push(`条目 ${e.name} 过大，只记哈希`)
      continue
    }
    let data
    try {
      data = extractZipEntry(buf, e)
    } catch (err) {
      value[e.name] = { __error: err.message }
      continue
    }
    if (depth < d.maxDepth) {
      const inner = tryDecode(data, d, notes, depth + 1)
      if (inner.ok) { value[e.name] = inner.value; continue }
    }
    value[e.name] = { __sha256: sha256Of(data), __size: data.length }
  }
  return { ok: true, format: FORMAT.ZIP, chain: [FORMAT.ZIP], value, text: null, entries }
}

/**
 * 读 zip 的中央目录。用中央目录而不是顺序扫本地头，因为前者带条目总数且更可靠。
 * 不支持 zip64（遇到 0xffffffff 会记一条说明）。
 */
export function readZipEntries(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('找不到 End of Central Directory')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compressedSize = buf.readUInt32LE(off + 20)
    const size = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('该 zip 使用了 zip64，暂不支持')
    }
    out.push({ name, method, compressedSize, size, localOffset })
    off += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 取某个条目的内容。method 0 = 存储，8 = deflate。 */
export function extractZipEntry(buf, entry) {
  const lo = entry.localOffset
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地文件头签名不对')
  const nameLen = buf.readUInt16LE(lo + 26)
  const extraLen = buf.readUInt16LE(lo + 28)
  const start = lo + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`不支持的压缩方法 ${entry.method}`)
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

// ---------- Godot 资源解析 ----------

/**
 * 解析 Godot 的 .tres / .tscn 文本资源。
 *
 * 实测一款真实 Godot 游戏的 savegame0.tres（3,236B）里有：
 *   slot_info_saved_day = "2025-05-01"        ← 现实时间的存档点
 *   current_scene = "Home"                    ← 玩家在哪个场景
 *   triggered_stories = Array[String]([...])  ← 43 条剧情 flag，**新增项就是这局推进了什么**
 *   *_route = 24                              ← 角色关系数值
 * 这是三种引擎里信息量最大的存档格式，所以单独认真实现。
 *
 * @returns {{header:object, props:object, extResources:Array, sections:string[]}|null}
 */
export function parseGodotResource(text) {
  const props = {}
  const extResources = []
  const sections = []
  let header = null
  let inResource = false
  let sawAnything = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';')) continue

    const sec = line.match(/^\[([^\]]*)\]\s*$/)
    if (sec) {
      const body = sec[1].trim()
      sections.push(body)
      if (body === 'resource') { inResource = true; continue }
      inResource = false
      if (/^gd_(resource|scene)\b/.test(body)) { header = parseGodotHeader(body); sawAnything = true; continue }
      if (/^ext_resource\b/.test(body)) { extResources.push(parseGodotHeader(body)); sawAnything = true; continue }
      continue
    }

    const kv = line.match(/^([A-Za-z_]\w*)\s*=\s*(.*)$/)
    if (!kv) continue
    if (!inResource) continue
    sawAnything = true
    props[kv[1]] = parseGodotValue(kv[2])
  }

  return sawAnything ? { header, props, extResources, sections } : null
}

/** `gd_resource type="Resource" script_class="SavedGame" load_steps=2 format=3` → 属性对象 */
function parseGodotHeader(body) {
  const [kind, ...rest] = body.split(/\s+/)
  const attrs = {}
  for (const m of rest.join(' ').matchAll(/([\w:]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s]+)/g)) {
    attrs[m[1]] = parseGodotValue(m[2])
  }
  return { kind, ...attrs }
}

const GD_STRING = /^"(?:[^"\\]|\\.)*"$/

function parseGodotValue(v) {
  const s = String(v).trim()
  if (s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (GD_STRING.test(s)) return unquoteGd(s)
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d*\.\d+(e[-+]?\d+)?$/i.test(s)) return Number(s)

  // Array[String]([...]) / PackedStringArray(...) / PackedInt32Array(...)
  const typed = s.match(/^(?:Array\[[^\]]*\]|Packed\w*Array)\((.*)\)$/s)
  if (typed) return parseGodotArray(typed[1])

  // ExtResource("1") / SubResource("x") → 保留引用关系
  const ref = s.match(/^(ExtResource|SubResource)\(\s*"([^"]*)"\s*\)$/)
  if (ref) return { __ref: ref[1], id: ref[2] }

  // Vector2(1, 2) 之类：保留类型与原始参数，不假装理解它
  const ctor = s.match(/^([A-Za-z_]\w*)\((.*)\)$/s)
  if (ctor) return { __gd: ctor[1], raw: ctor[2] }

  return s
}

function parseGodotArray(inner) {
  const t = inner.trim()
  if (t === '') return []
  // Godot 写的是合法 JSON 数组（["a", "b"]），优先直接 JSON.parse
  const direct = tryJson(t)
  if (direct !== undefined && Array.isArray(direct)) return direct
  // 退回顶层逗号切分（元素含 ExtResource(...) 等非 JSON 构造时）
  return splitTopLevel(t).map((x) => parseGodotValue(x))
}

/** 按顶层逗号切分，忽略引号与括号内部。 */
function splitTopLevel(s) {
  const out = []
  let depth = 0, inStr = false, cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      cur += ch
      if (ch === '\\') { cur += s[++i] ?? ''; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; cur += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}

function unquoteGd(s) {
  const body = s.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue }
    const n = body[++i]
    if (n === 'n') out += '\n'
    else if (n === 't') out += '\t'
    else if (n === 'r') out += '\r'
    else if (n === 'u') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16)); i += 4 }
    else out += n
  }
  return out
}

// ---------- INI 解析 ----------

/**
 * 解析 INI / Godot ConfigFile。实测 `settings.ini` 形如：
 *   [Ending]
 *   MinaseA=false
 * 值只做**安全**类型推断：`true`/`false` 转布尔，能原样往返的数字转数字。
 * "1.0" 保持字符串（因为 String(Number("1.0")) === "1" ≠ "1.0"），避免把版本号变成 1。
 */
export function parseIni(text) {
  const out = {}
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const sec = line.match(/^\[([^\]]*)\]\s*$/)
    if (sec) { section = sec[1].trim(); if (!(section in out)) out[section] = {}; continue }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const k = line.slice(0, eq).trim()
    const v = line.slice(eq + 1).trim()
    if (!(section in out)) out[section] = {}
    out[section][k] = coerceScalar(v)
  }
  return out
}

function coerceScalar(v) {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) && String(Number(v)) === v) return Number(v)
  if (GD_STRING.test(v)) return unquoteGd(v)
  return v
}

// ---------- 嗅探工具 ----------

/** 按 magic bytes 判定容器类型。注意：这是唯一允许「看开头几字节就下结论」的地方。 */
export function sniffMagic(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip'
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
      (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06)) {
    return buf[2] === 0x03 ? 'zip' : 'zip-eocd-only'
  }
  if (isZlibHeader(buf)) return 'zlib'
  if (buf.length >= 9 &&
      buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00 && buf[4] === 0x00 &&
      buf[5] === 0xff && buf[6] === 0xff && buf[7] === 0xff && buf[8] === 0xff) return 'binary-formatter'
  return null
}

/** zlib: CMF 低 4 位为 8（deflate），且 (CMF<<8|FLG) % 31 === 0。 */
function isZlibHeader(buf) {
  if (buf.length < 2) return false
  const cmf = buf[0], flg = buf[1]
  if ((cmf & 0x0f) !== 8) return false
  return ((cmf << 8) | flg) % 31 === 0
}

/** 粗判二进制：出现 NUL 直接判定；控制字符占比过高也判二进制。 */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 4096)
  if (n === 0) return false
  let bad = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) bad++
  }
  return bad / n > 0.05
}

function tryJson(text) {
  const t = text.trim()
  if (t === '') return undefined
  const c = t[0]
  if (c !== '{' && c !== '[' && c !== '"' && !/[\d\-tfn]/.test(c)) return undefined
  try {
    const v = JSON.parse(t)
    return v === undefined ? undefined : v
  } catch {
    return undefined
  }
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function base(o) {
  return {
    ok: false, format: FORMAT.UNKNOWN, content: FORMAT.UNKNOWN, chain: [],
    value: null, text: null, entries: null,
    path: null, size: 0, sha256: '', mtimeMs: null, notes: [], ...o,
  }
}
