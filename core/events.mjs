// core/events.mjs —— 事件模型与归一化（纯逻辑，零依赖）
//
// 设计（见 docs/HANDOFF.md §3.4）：不同游戏的日志格式各异，但下游只认**一种**事件形状。
// adapter 负责翻译成这个形状；core/ 与 dialogue/ 不认识任何具体游戏。
//
// 事件形状：
//   { id, at, kind, text, data, importance }
// - `at`         时间（ISO 字符串或秒数字段；本项目不强绑时间类型，能排序即可）
// - `kind`       见 EVENT_KINDS，**闭集**：adapter 若要新增类别，先在这里登记
// - `importance` 0..1，决定它会不会被"主动聊天"挑中（越高越值得角色主动开口）

/**
 * 事件类别闭集。新增类别要在这里登记 —— 避免 adapter 各造一套词表。
 *
 * 后三类是**文件系统/进程表层面**的信号（不需要游戏配合就能拿到，见 ARCHITECTURE §5.1）：
 * 实测结论是日志读不出游戏内事件，这三类反而是最可靠的输入。
 */
export const EVENT_KINDS = Object.freeze([
  'progress',  // 剧情推进 / 章节到达
  'combat',    // 战斗（胜/败/受挫）
  'item',      // 获得物品 / 资源变化
  'death',     // 死亡 / 团灭 / 重大损失
  'dialogue',  // 与 NPC 的对话
  'area',      // 进入新区域
  'system',    // 系统消息（设置变更等）
  'save',      // ★ 存档被写入 / 存档内容有变化（文件系统观测，最可靠的泄压点）
  'exit',      // ★ 会话正常结束（游戏退出）
  'crash',     // ★ 会话异常结束（日志没走到收尾标记）
])

/** 各类别的默认重要度（adapter 未显式给出时用）。 */
export const DEFAULT_IMPORTANCE = Object.freeze({
  progress: 0.7,
  combat: 0.5,
  item: 0.3,
  death: 0.9,
  dialogue: 0.4,
  area: 0.35,
  system: 0.1,
  // 存档是玩家主动留 checkpoint ⇒ 天然是松弛点，重要度高
  save: 0.8,
  exit: 0.7,
  crash: 0.75,
})

/**
 * 构造一个规范化事件。所有字段都做兜底，**永不抛异常** ——
 * 日志是脏数据，解析层不该因为一条坏行整批失败（坏行交给 adapter 报告）。
 *
 * ⚠ 注意入参先用 `e && typeof e === 'object'` 兜一道，而不是靠默认参数：
 *   默认参数只对 `undefined` 生效，**传 null 照样会在 `e.kind` 上抛 TypeError**。
 *   （这个"永不抛异常"的契约真的被违反过 —— 是测试拿 null 打进去才暴露的。）
 * @param {object} e
 * @returns {object}
 */
export function createEvent(e) {
  const src = (e && typeof e === 'object') ? e : {}
  const kind = EVENT_KINDS.includes(src.kind) ? src.kind : 'system'
  // ⚠ 用 Number.isFinite 而不是 typeof === 'number'：NaN 也是 number，
  //   走 clamp01 会被静默夹成 0（= "最不重要"），于是一个本该被看见的事件彻底沉默。
  //   非有限数一律视为"没给"，退回该类别默认值。
  const importance = Number.isFinite(src.importance)
    ? clamp01(src.importance)
    : (DEFAULT_IMPORTANCE[kind] ?? 0.1)
  return {
    id: src.id != null ? String(src.id) : makeId(kind, src.at, src.text),
    at: src.at ?? null,
    kind,
    text: String(src.text ?? '').trim(),
    data: src.data ?? null,
    importance,
  }
}

/**
 * 归一化一批事件：构造 + 去重（按 id）+ 去空文本。
 * @param {object[]} list
 * @returns {{ events: object[], dropped: {empty:number, dup:number} }}
 */
export function normalizeEvents(list = []) {
  const seen = new Set()
  const events = []
  const dropped = { empty: 0, dup: 0 }
  for (const raw of list) {
    const ev = createEvent(raw)
    if (!ev.text) { dropped.empty++; continue }
    if (seen.has(ev.id)) { dropped.dup++; continue }
    seen.add(ev.id)
    events.push(ev)
  }
  return { events, dropped }
}

/**
 * 合并多个来源的事件流并排序（多份日志 / 日志+手动补充）。
 * 排序稳定性很重要：同一时间点的先后会影响叙事，故用**原始顺序**做次键。
 * @param {object[][]} streams
 */
export function mergeEvents(...streams) {
  const flat = []
  streams.forEach((s, si) => (s ?? []).forEach((e, i) => flat.push({ e, si, i })))
  flat.sort((a, b) => {
    const ta = sortKey(a.e.at)
    const tb = sortKey(b.e.at)
    if (ta !== tb) return ta < tb ? -1 : 1
    if (a.si !== b.si) return a.si - b.si
    return a.i - b.i
  })
  return flat.map((x) => x.e)
}

/** 按类别计数 —— 用于给角色卡/报告做"这批日志讲了什么"。 */
export function summarize(events = []) {
  const byKind = {}
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
  const top = [...events].sort((a, b) => b.importance - a.importance).slice(0, 5)
  return {
    total: events.length,
    byKind,
    from: events[0]?.at ?? null,
    to: events[events.length - 1]?.at ?? null,
    highlights: top,
  }
}

/**
 * 挑"值得主动开口"的事件 —— 主动聊天的输入（见 HANDOFF §4 未完成 3）。
 * 低于阈值的不打扰玩家；返回按重要度降序。
 */
export function pickNoteworthy(events = [], { minImportance = 0.6, limit = 3 } = {}) {
  return events
    .filter((e) => e.importance >= minImportance)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, limit)
}

// ---------- 内部 ----------

function clamp01(v) {
  if (!Number.isFinite(v)) return 0
  return Math.min(Math.max(v, 0), 1)
}

/** 时间排序键：能转数字就按数字，否则按字符串；null 排最前（未知时间不阻塞排序） */
function sortKey(at) {
  if (at == null) return ''
  if (typeof at === 'number') return at
  const n = Number(at)
  if (Number.isFinite(n)) return n
  return String(at)
}

/** 兜底 id：无 id 的日志行也要可去重，故用内容指纹 */
function makeId(kind, at, text) {
  const s = `${kind}|${at ?? ''}|${String(text ?? '').slice(0, 40)}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `ev_${(h >>> 0).toString(36)}`
}
