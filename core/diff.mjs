// core/diff.mjs —— 通用结构 diff（零依赖，纯函数）
//
// 为什么它在地基位置（见 docs/ARCHITECTURE.md §3、§6）：
//   整个项目的输入是「存档被更新了」。要把它变成有意义的事件，第一步就是把
//   「上一次的存档对象」和「这一次的存档对象」比出**可读的差异**。
//   而存档格式跨引擎天差地别，所以这一层必须**与引擎无关** —— 它只认 JS 值。
//
// 三种数组策略（这是本模块最要紧的设计，因为存档里数组极多）：
//   1) 原始值数组  → 集合 diff。例：Godot 存档里的 triggered_stories 是字符串数组，
//                    新增项就是「这一局推进了哪些剧情」。索引 diff 会把整个数组
//                    判成全线位移，毫无用处。
//   2) 带 id 的对象数组 → 按 key 配对，路径形如 $.items[id=sword].hp。
//                    这样「某个道具被消耗」是同一条路径上的数值变化，而不是全数组重排。
//   3) 其余        → 退化为索引 diff。
//
// 输出形状（三种 kind，消费方按 path 做规则匹配）：
//   { path: '$.player.level', kind: 'changed', before: 12, after: 13 }
//   { path: '$.unlocks',      kind: 'added',   value: 'sword', index: 7 }   // 集合型
//   { path: '$.player.mp',    kind: 'added',   after: 50 }                  // 键新增
//   { path: '$.player.old',   kind: 'removed', before: 1 }
//
//   ⚠ 集合型（原始值数组）的 added/removed 用 `value` 承载元素、用 `index` 承载位置，
//      `path` 指向**数组本身**（因为元素没有稳定身份）。其余情况 `path` 指向具体位置。
//      `added`/`removed` 在集合型下用 `value`，在键存在性下用 `after`/`before` —— 刻意区分，
//      `value` 表示「集合里多了这个元素」，`after` 表示「这个位置现在是这个值」。
//
// ★ 粒度规则：**一律展开到叶子，由消费方按路径前缀聚合。**
//   例：新增一个道具 `{id:'sword', atk:5}` 产出 `$.items[id=sword].id` 与
//   `$.items[id=sword].atk` 两条，而不是一整条元素。
//   理由：路径越细，消费方的规则越容易匹配到；**聚合容易，拆分难**。
//   要还原成「某个元素整体新增」，按 `$.items[id=sword]` 前缀聚合即可。
//   代价：首次建立基线时变更数会很多（会撞 maxChanges）—— 所以首帧只应作为基线，
//   不要当成事件（见 docs/ARCHITECTURE.md §5.2 的显著性过滤）。

/** 表示「该位置不存在」，用来区分"没有这个键"和"值是 undefined"。 */
const MISSING = Symbol('MISSING')

/** 判断对象数组时可以拿来当身份的键名（按优先级）。 */
export const DEFAULT_KEY_HINTS = Object.freeze([
  'id', 'name', 'key', 'uuid', 'guid', 'slot', 'index', 'type',
])

/**
 * 存档里天然高频变动、但**不表示任何进展**的字段名。
 * 不做显著性过滤的话，每次自动存档都会因为这类字段产生 diff，
 * 于是「存档变了」永远为真，时机引擎就被噪声淹没（见 ARCHITECTURE §5.2）。
 *
 * 这是**预设**，不是默认行为：调用方要显式传 `{ ignore: VOLATILE_DEFAULTS }`。
 * 刻意不默认开启 —— 太激进的黑名单会把真实进展也吃掉。
 */
export const VOLATILE_DEFAULTS = Object.freeze([
  'timestamp', 'time', 'savedAt', 'playtime', 'playTime', 'play_time',
  'elapsed', 'elapsedTime', 'duration', 'tick', 'ticks', 'frame', 'frames',
  'fps', 'deltaTime', 'rngSeed', 'seed', 'randomState', 'camera', 'camPos',
  'mousePosition', 'screenPosition', 'lastSaveDate', 'saveDate', 'date',
])

/**
 * 比较两个已解析的存档值，产出差异列表。
 *
 * @param {*} before - 上一次的值（首次比较可传 undefined，此时全部记为 added）
 * @param {*} after  - 这一次的值
 * @param {object} [opts]
 * @param {number}   [opts.maxChanges=2000] 变更数上限；超出即截断并置 `truncated`
 * @param {Array<string|RegExp>} [opts.ignore=[]] 忽略的路径或字段名（见 pathMatches）
 * @param {number}   [opts.numberTolerance=0] 浮点容差；±tol 内视为未变（存档里的坐标抖动）
 * @param {string[]} [opts.keyHints=DEFAULT_KEY_HINTS] 对象数组的身份键候选
 * @param {number}   [opts.maxDepth=32] 递归深度上限，防御异常深的结构
 * @returns {{changes:Array, truncated:boolean, counts:{added:number,removed:number,changed:number,total:number}}}
 */
export function diffValues(before, after, opts = {}) {
  const st = {
    changes: [],
    truncated: false,
    maxChanges: Number.isFinite(opts.maxChanges) ? opts.maxChanges : 2000,
    ignore: opts.ignore ?? [],
    numberTolerance: Number.isFinite(opts.numberTolerance) ? Math.abs(opts.numberTolerance) : 0,
    keyHints: opts.keyHints ?? DEFAULT_KEY_HINTS,
    maxDepth: Number.isFinite(opts.maxDepth) ? opts.maxDepth : 32,
  }
  walk('$', before === undefined ? MISSING : before, after === undefined ? MISSING : after, st, 0)
  return { changes: st.changes, truncated: st.truncated, counts: countBy(st.changes) }
}

/** 统计各 kind 的数量 —— 时机引擎用它算「这次存档有没有实质变化」。 */
export function countBy(changes = []) {
  const counts = { added: 0, removed: 0, changed: 0, total: changes.length }
  for (const c of changes) counts[c.kind]++
  return counts
}

/**
 * 路径匹配：既支持结构化模式，也支持「就写个字段名」这种直觉写法。
 *
 *   pathMatches('$.player.level', 'level')        → true    （任一段等于该名字）
 *   pathMatches('$.player.level', '$.player.*')   → true    （段通配）
 *   pathMatches('$.a.b.c', '$.**.c')              → true    （** 跨任意层）
 *   pathMatches('$.a.b', /^\.a/)                  → true    （直接给正则，测原始路径串）
 *
 * 为什么允许「就写字段名」：黑名单（VOLATILE_DEFAULTS）实际就是一堆字段名，
 * 要求调用方写出完整路径既繁琐又容易写错。两种写法都支持，代价很小。
 */
export function pathMatches(path, pattern) {
  if (pattern instanceof RegExp) return pattern.test(path)
  const p = String(pattern)
  if (!p) return false

  // 无 $ 前缀 ⇒ 当作字段名 / 段模式，任意一段命中即可
  if (!p.startsWith('$')) {
    const segs = p.split('.')
    return toSegments(path).some((seg) => matchSegments([seg], segs))
  }
  return matchSegments(toSegments(path), toSegments(p))
}

/** 把 `$.a.b[0].c` 切成 ['a','b','0','c']。 */
export function toSegments(path) {
  return String(path)
    .replace(/^\$/, '')
    .replace(/\[([^\]]*)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0)
}

// ---------- 内部 ----------

function walk(path, a, b, st, depth) {
  if (a !== MISSING && b !== MISSING && isSame(a, b, st)) return
  if (isIgnored(path, st)) return
  if (st.changes.length >= st.maxChanges) { st.truncated = true; return }

  // 单边缺失：继续往下展开，让路径落在叶子上。
  // 为什么不在这一层直接记「整个对象新增」：那样首帧会变成一条巨大的 blob，
  // 消费方的路径规则（比如 $.triggered_stories）根本匹配不到，事件映射就废了。
  // 展开成叶子后，首帧与「中途新增一个键」产出的事件形状完全一致。
  if (a === MISSING || b === MISSING) return walkMissing(path, a, b, st, depth)

  // 到达深度上限：已经无法再细分，只能在当前粒度上判断**是否真的不同**。
  // 这里必须做一次深比较而不是直接记 changed —— 否则两个内容相同、只是深度超限的
  // 结构会被误报成变化，而这个误报会一路传成「存档有更新」的假信号。
  if (depth >= st.maxDepth) {
    if (deepEqual(a, b, st.numberTolerance)) return
    push(st, { path, kind: 'changed', before: a, after: b })
    return
  }

  if (isPlainObject(a) && isPlainObject(b)) return walkObject(path, a, b, st, depth)
  if (Array.isArray(a) && Array.isArray(b)) return walkArray(path, a, b, st, depth)
  push(st, { path, kind: 'changed', before: a, after: b })
}

/** 一侧整体不存在时的展开。空容器仍保留一条记录，避免「新出现一个空对象」被吞掉。 */
function walkMissing(path, a, b, st, depth) {
  const isAdd = a === MISSING
  const node = isAdd ? b : a

  if (depth < st.maxDepth) {
    if (isPlainObject(node)) {
      const keys = Object.keys(node)
      if (keys.length === 0) { push(st, { path, kind: isAdd ? 'added' : 'removed', ...(isAdd ? { after: node } : { before: node }) }); return }
      for (const k of keys) walk(`${path}.${k}`, isAdd ? MISSING : node[k], isAdd ? node[k] : MISSING, st, depth + 1)
      return
    }
    if (Array.isArray(node) && node.length > 0) {
      for (let i = 0; i < node.length; i++) walk(`${path}[${i}]`, isAdd ? MISSING : node[i], isAdd ? node[i] : MISSING, st, depth + 1)
      return
    }
  }
  push(st, { path, kind: isAdd ? 'added' : 'removed', ...(isAdd ? { after: node } : { before: node }) })
}

/**
 * 对象：先按 after 的键序走（保留存档原有的字段顺序，输出可复现），
 * 再补上只在 before 里出现的键。
 */
function walkObject(path, a, b, st, depth) {
  const seen = new Set()
  for (const k of Object.keys(b)) {
    seen.add(k)
    walk(`${path}.${k}`, k in a ? a[k] : MISSING, b[k], st, depth + 1)
  }
  for (const k of Object.keys(a)) {
    if (seen.has(k)) continue
    walk(`${path}.${k}`, a[k], MISSING, st, depth + 1)
  }
}

function walkArray(path, a, b, st, depth) {
  if (a.length === 0 && b.length === 0) return

  // 策略 1：原始值数组 → 集合 diff
  if (isPrimitiveArray(a) && isPrimitiveArray(b)) return walkSet(path, a, b, st)

  // 策略 2：带身份键的对象数组 → 按 key 配对
  const hint = findKeyHint(a, b, st.keyHints)
  if (hint) return walkKeyed(path, a, b, hint, st, depth)

  // 策略 3：索引 diff
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    walk(`${path}[${i}]`, i < a.length ? a[i] : MISSING, i < b.length ? b[i] : MISSING, st, depth + 1)
  }
}

/**
 * 集合 diff。重复元素会被折叠 —— 对存档里的「已解锁列表」这类数据这是正确语义
 * （它本来就是集合）。若某游戏用数组表示**有序且允许重复**的背包，
 * 这一策略会低估变化，此时应通过 keyHints 让它走 keyed 分支。
 */
function walkSet(path, a, b, st) {
  const beforeSet = new Set(a)
  const afterSet = new Set(b)
  for (let i = 0; i < b.length; i++) {
    if (!beforeSet.has(b[i])) push(st, { path, kind: 'added', value: b[i], index: i })
  }
  for (let i = 0; i < a.length; i++) {
    if (!afterSet.has(a[i])) push(st, { path, kind: 'removed', value: a[i], index: i })
  }
}

/** 找出两边都能用作唯一身份的键名。 */
function findKeyHint(a, b, hints) {
  for (const h of hints) {
    if (isUniqueKeyedBy(a, h) && isUniqueKeyedBy(b, h)) return h
  }
  return null
}

function isUniqueKeyedBy(arr, key) {
  if (arr.length === 0) return false
  const seen = new Set()
  for (const item of arr) {
    if (!isPlainObject(item)) return false
    const v = item[key]
    if (typeof v !== 'string' && typeof v !== 'number') return false
    const k = String(v)
    if (seen.has(k)) return false // 不唯一 ⇒ 不能当身份
    seen.add(k)
  }
  return true
}

function walkKeyed(path, a, b, hint, st, depth) {
  const aMap = new Map(a.map((x) => [String(x[hint]), x]))
  const bMap = new Map(b.map((x) => [String(x[hint]), x]))
  for (const [k, v] of bMap) {
    const seg = `${path}[${hint}=${k}]`
    walk(seg, aMap.has(k) ? aMap.get(k) : MISSING, v, st, depth + 1)
  }
  for (const [k, v] of aMap) {
    if (bMap.has(k)) continue
    walk(`${path}[${hint}=${k}]`, v, MISSING, st, depth + 1)
  }
}

function push(st, change) {
  if (st.changes.length >= st.maxChanges) { st.truncated = true; return }
  st.changes.push(change)
}

function isIgnored(path, st) {
  if (st.ignore.length === 0) return false
  for (const p of st.ignore) if (pathMatches(path, p)) return true
  return false
}

/** 叶子级相等判断。数字走容差；其余走 Object.is（NaN 与 -0 都有确定行为）。 */
function isSame(a, b, st) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return true
    if (Number.isNaN(a) && Number.isNaN(b)) return true
    return st.numberTolerance > 0 && Math.abs(a - b) <= st.numberTolerance
  }
  if (Array.isArray(a) && Array.isArray(b)) return a === b
  if (isPlainObject(a) && isPlainObject(b)) return a === b
  return Object.is(a, b)
}

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

/**
 * 深比较，只在「到达 maxDepth、无法再细分」时兜底使用。**用显式栈实现，没有递归深度上限**
 * —— 否则兜底逻辑自己会有一条深度红线，超过它就把相同结构误报成变化，
 * 而这个误报会一路传成「存档有更新」的假信号（就是本模块最该避免的东西）。
 * 节点预算用完时保守返回 false（宁可多报一次变化，也不要漏报真实变化）。
 * 注意：不做键序无关比较 —— JSON 对象的键序稳定，且顺序本身有时是有意义的。
 */
function deepEqual(a, b, tol) {
  const stack = [[a, b]]
  let budget = 200000
  while (stack.length > 0) {
    if (--budget < 0) return false
    const [x, y] = stack.pop()
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') {
      if (Number.isNaN(x) && Number.isNaN(y)) continue
      if (tol > 0 && Math.abs(x - y) <= tol) continue
      return false
    }
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false
    if (Array.isArray(x) !== Array.isArray(y)) return false
    if (Array.isArray(x)) {
      if (x.length !== y.length) return false
      for (let i = 0; i < x.length; i++) stack.push([x[i], y[i]])
      continue
    }
    const kx = Object.keys(x)
    if (kx.length !== Object.keys(y).length) return false
    for (const k of kx) {
      if (!Object.prototype.hasOwnProperty.call(y, k)) return false
      stack.push([x[k], y[k]])
    }
  }
  return true
}

const isPrimitive = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)

const isPrimitiveArray = (arr) => arr.every(isPrimitive)

/** 段模式匹配：支持 `*`（一段）与 `**`（任意段，含零段）。 */
function matchSegments(pathSegs, patSegs) {
  const memo = new Map()
  const go = (i, j) => {
    const key = `${i}:${j}`
    if (memo.has(key)) return memo.get(key)
    let r
    if (j === patSegs.length) r = i === pathSegs.length
    else if (patSegs[j] === '**') r = go(i, j + 1) || (i < pathSegs.length && go(i + 1, j))
    else if (i >= pathSegs.length) r = false
    else r = segEq(pathSegs[i], patSegs[j]) && go(i + 1, j + 1)
    memo.set(key, r)
    return r
  }
  return go(0, 0)
}

/** 单段匹配：`*` 通配任意（不跨段）。 */
function segEq(seg, pat) {
  if (pat === '*') return true
  if (!pat.includes('*')) return seg === pat
  const rx = new RegExp('^' + pat.split('*').map(escapeRe).join('[^.]*') + '$')
  return rx.test(seg)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
