// core/xml.mjs —— 零依赖 XML → JS 对象
//
// 为什么需要（实测得出，见 docs/ARCHITECTURE.md §2.2）：
//   · Noita 的存档是 XML：`<Entity _version="1" name="" tags="wand"><_Transform position.x="..."/>`
//   · Ultimate Chicken Horse 的 saveData.uch 是 **base64 包着的 XML**：
//     解开是 `<UCHSave version="1.11.01" creationDate="..." lastSaveDate="...">`
//   XML 是单机游戏存档里出现频率很高的格式，所以必须有这一层。
//
// 映射规则（刻意选得可预测，因为下游 core/diff.mjs 要按路径做规则匹配）：
//   · 属性       → `@名字`    例：$.Entity.@tags
//   · 子元素     → 同名键     例：$.UCHSave.settings.sound
//   · 同名重复   → 数组       例：$.Entity.children[3]
//   · 文本内容   → `#text`
// 用 `@` 前缀是为了**避免属性和同名子元素互相覆盖**（`<a b="1"><b/></a>` 这种情况真实存在）。
//
// 本解析器只求覆盖存档类 XML，**不是通用 XML 实现**：不处理命名空间语义、不做 DTD 校验、
// 不保留注释。遇到不确定的结构宁可保留原文，也不猜。

/** 实体解码。数值实体（&#NN; / &#xHH;）一并处理。 */
export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? safeFromCodePoint(code) : m
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
    return named[body] ?? m
  })
}

function safeFromCodePoint(code) {
  try { return String.fromCodePoint(code) } catch { return '' }
}

/**
 * 解析 XML 文本。
 * @param {string} text
 * @returns {object|null} 根元素映射（如 `{ Entity: {...} }`）；完全解析不出东西时返回 null
 */
export function parseXml(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  // 必须有至少一个标签，否则不是 XML
  if (!/<[A-Za-z_]/.test(src)) return null

  const root = {}
  const stack = [{ name: '#root', node: root }]
  let i = 0
  const n = src.length

  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break

    if (lt > i) addText(stack[stack.length - 1].node, src.slice(i, lt))

    // 注释
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt)
      i = end < 0 ? n : end + 3
      continue
    }
    // CDATA
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt)
      addRawText(stack[stack.length - 1].node, src.slice(lt + 9, end < 0 ? n : end))
      i = end < 0 ? n : end + 3
      continue
    }
    // 声明 / DOCTYPE
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt)
      i = end < 0 ? n : end + 2
      continue
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? n : end + 1
      continue
    }

    const gt = findTagEnd(src, lt)
    if (gt < 0) break
    const raw = src.slice(lt + 1, gt)
    i = gt + 1

    // 闭合标签
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim()
      while (stack.length > 1 && stack[stack.length - 1].name !== name) stack.pop()
      if (stack.length > 1) stack.pop()
      // 闭合标签后紧跟的文本（少见）由下一轮循环处理
      continue
    }

    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const { name, attrs } = parseTag(body)
    if (!name) continue

    const node = {}
    for (const [k, v] of attrs) node['@' + k] = decodeEntities(v)
    addChild(stack[stack.length - 1].node, name, node)
    if (!selfClosing) stack.push({ name, node })
  }

  return Object.keys(root).length > 0 ? root : null
}

// ---------- 内部 ----------

/** 找 `>`，跳过引号内的内容（属性值里可能出现 `>`）。 */
function findTagEnd(src, lt) {
  let quote = null
  for (let i = lt + 1; i < src.length; i++) {
    const ch = src[i]
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '>') return i
  }
  return -1
}

const ATTR_RE = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g

function parseTag(body) {
  const trimmed = body.trim()
  if (trimmed === '') return { name: '', attrs: [] }
  const ws = trimmed.search(/\s/)
  const name = ws < 0 ? trimmed : trimmed.slice(0, ws)
  const attrs = []
  if (ws >= 0) {
    const rest = trimmed.slice(ws)
    for (const m of rest.matchAll(ATTR_RE)) {
      attrs.push([m[1], m[3] ?? m[4] ?? m[5] ?? ''])
    }
  }
  return { name, attrs }
}

/** 同名子元素重复时自动转数组 —— 这样 diff 才能看到「列表长了」。 */
function addChild(node, name, child) {
  if (!(name in node)) { node[name] = child; return }
  const cur = node[name]
  if (Array.isArray(cur)) { cur.push(child); return }
  node[name] = [cur, child]
}

function addText(node, text) {
  const t = text.trim()
  if (t === '') return
  node['#text'] = (node['#text'] ?? '') + decodeEntities(t)
}

/** CDATA 内容不trim，且不解实体（CDATA 本就是原文）。 */
function addRawText(node, text) {
  if (text === '') return
  node['#text'] = (node['#text'] ?? '') + text
}
