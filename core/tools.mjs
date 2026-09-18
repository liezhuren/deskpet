// core/tools.mjs —— LLM 可以调用的 6 个工具（**只定义契约，不执行副作用**）
//
// ══════════════════════════════════════════════════════════════════
// 为什么契约与执行要分开
// ══════════════════════════════════════════════════════════════════
// 这个文件是**纯数据 + 纯函数**：工具叫什么、收什么参数、参数怎么校验、
// 怎么从模型输出里把调用解析出来。它不移动窗口、不启动程序、不写磁盘。
// 副作用全在 app/tools.mjs 的执行器里，靠注入的 handlers 完成。
// 这样切的两个好处：
//   · core/ 保持零依赖，且**能在渲染端复用**（设置页要展示"这个工具能干什么"）
//   · 校验逻辑可以离线穷举测试，"真去启动一个程序"则永远需要人确认
//
// ══════════════════════════════════════════════════════════════════
// 危险分级：`safe` / `confirm`
// ══════════════════════════════════════════════════════════════════
// 让模型能调用工具，就等于给了它一只**能操作你电脑的手**。所以每个工具必须声明：
//   safe    —— 只影响桌宠自己（挪个位置、做个表情、取消发言），出错也只是不好看
//   confirm —— 会动到桌宠之外的东西（启动程序、改角色卡），**必须经用户确认**
// 默认是 confirm：新增工具时忘了声明，会落到"要确认"那一侧 —— 漏判成安全的代价
// 远大于漏判成危险的代价（后者只是多点一下）。
//
// ══════════════════════════════════════════════════════════════════
// 参数校验：闭集 + 类型 + 范围，一处定义、三处复用
// ══════════════════════════════════════════════════════════════════
// 与角色卡 spec（core/card-spec.mjs）同一套做法：参数表写一次，
// 提示词生成、运行时校验、界面展示都从它派生 —— 于是不可能出现
// "提示词里那么写、代码里这么查"的漂移。

/** 工具的危险分级。 */
export const TOOL_RISK = Object.freeze({ SAFE: 'safe', CONFIRM: 'confirm' })

/** 参数类型（闭集）。 */
export const PARAM_TYPES = Object.freeze(['number', 'integer', 'string', 'enum', 'boolean'])

const p = (name, type, extra = {}) => Object.freeze({
  name, type,
  required: extra.required === true,
  desc: extra.desc ?? '',
  values: extra.values ? Object.freeze(extra.values) : undefined,
  min: extra.min, max: extra.max,
  maxChars: extra.maxChars,
  example: extra.example,
})

/**
 * ★ 6 个工具。**这是唯一的事实来源** —— 提示词、校验、界面都从它派生。
 *
 * 语义刻意写清楚，因为"pet 和 interact 有什么区别"这种事必须由定义回答，
 * 不能让模型自己猜（猜错的表现是它反复调用错的工具）。
 */
export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'move_to',
    label: '移动到',
    risk: TOOL_RISK.SAFE,
    desc: '把桌宠窗口移到屏幕上的某个位置。用于躲开玩家正在看的内容，或者靠过去。',
    when: '玩家的视线被挡住、或者你想靠近某个东西时',
    params: Object.freeze([
      p('x', 'integer', { required: true, desc: '屏幕 X 坐标（像素）', example: 1600 }),
      p('y', 'integer', { required: true, desc: '屏幕 Y 坐标（像素）', example: 800 }),
      p('reason', 'string', { desc: '为什么挪（一句话，会记进日志）', maxChars: 40 }),
    ]),
  }),
  Object.freeze({
    name: 'pet',
    label: '被抚摸',
    risk: TOOL_RISK.SAFE,
    desc: '做一次"被抚摸"的反应：开心、亲密度上升、播 happy 动作。',
    when: '玩家点了桌宠、或者刚经历了一段紧张的游玩之后',
    params: Object.freeze([
      p('times', 'integer', { desc: '摸几下（1~5，默认 1）', min: 1, max: 5, example: 1 }),
    ]),
  }),
  Object.freeze({
    name: 'interact',
    label: '做个动作',
    risk: TOOL_RISK.SAFE,
    desc: '做一个**表意动作**（不说话的那种）：打招呼、点头、摇头、靠近、后退、看你一眼、递东西。',
    when: '你想表达态度但不想开口时，或者玩家主动搭话时先给个反应',
    params: Object.freeze([
      p('kind', 'enum', {
        required: true, desc: '动作种类',
        values: ['greet', 'nod', 'shake', 'approach', 'retreat', 'look', 'offer'],
        example: 'nod',
      }),
      p('note', 'string', { desc: '这个动作的意思（一句话，用于日志与无障碍）', maxChars: 60 }),
    ]),
  }),
  Object.freeze({
    name: 'launch_app',
    label: '启动游戏/应用',
    risk: TOOL_RISK.CONFIRM,
    desc: '启动一个**已经登记过**的游戏或应用。不能启动任意路径。',
    when: '玩家想玩某个游戏、或者你建议他换一款时（必须先征得同意）',
    params: Object.freeze([
      p('target', 'string', { required: true, desc: '登记过的游戏名或目录名（不是路径）', maxChars: 120, example: 'Hollow Knight' }),
      p('args', 'string', { desc: '附加命令行参数（一般留空）', maxChars: 200 }),
    ]),
  }),
  Object.freeze({
    name: 'cancel',
    label: '取消当前动作',
    risk: TOOL_RISK.SAFE,
    desc: '取消正在排队的发言与正在播的动作，回到待机。',
    when: '玩家明显在忙、你判断现在不该打扰时（这是"我闭嘴"的工具）',
    params: Object.freeze([
      p('reason', 'string', { desc: '为什么取消', maxChars: 60 }),
    ]),
  }),
  Object.freeze({
    name: 'generate_character_card',
    label: '生成角色卡',
    risk: TOOL_RISK.CONFIRM,
    desc: '从 Wiki 页面或一段介绍生成一张角色卡（hard/soft 两层，逐格确认后生效）。',
    when: '玩家说"把某个角色做成桌宠"、或者当前没有卡而你只有一段介绍时',
    params: Object.freeze([
      p('name', 'string', { required: true, desc: '角色名', maxChars: 40, example: '霞' }),
      p('game', 'string', { required: true, desc: '游戏标识（记忆按它归属）', maxChars: 80, example: 'someday' }),
      p('wikiUrl', 'string', { desc: 'Wiki 页面地址（给了就抓取；不给就用原文）', maxChars: 300 }),
      p('lore', 'string', { desc: '角色介绍原文（没有 wikiUrl 时用这个）', maxChars: 8000 }),
      p('temperament', 'enum', { desc: '气质，决定需要哪些动作', values: ['lively', 'calm', 'cool'] }),
    ]),
  }),
])

export const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name))
export const toolByName = (name) => TOOLS.find((t) => t.name === name) ?? null

/** 这个工具要不要用户确认。**未登记的工具一律按"要确认"处理**（见文件头的分级说明）。 */
export function needsConfirm(name) {
  const t = toolByName(name)
  if (!t) return true
  return t.risk === TOOL_RISK.CONFIRM
}

// ---------- 校验 ----------

/**
 * 校验一次工具调用。**不抛异常** —— 返回可读的问题清单，好让模型（或用户）改正。
 *
 * @param {{name?:string, args?:object}} call
 * @param {{allowlist?:string[]}} [opts] 额外限制可用的工具（执行器会传入当前允许集合）
 * @returns {{ok:boolean, errors:string[], warnings:string[], call:{name:string,args:object}|null,
 *            tool:object|null, needsConfirm:boolean}}
 */
export function validateToolCall(call, opts = {}) {
  const errors = []
  const warnings = []
  const name = typeof call?.name === 'string' ? call.name.trim() : ''
  const tool = toolByName(name)
  if (!name) return { ok: false, errors: ['缺少工具名'], warnings, call: null, tool: null, needsConfirm: true }
  if (!tool) {
    return { ok: false, errors: [`未登记的工具「${name}」（可用：${TOOL_NAMES.join(' / ')}）`], warnings, call: null, tool: null, needsConfirm: true }
  }
  if (opts.allowlist && !opts.allowlist.includes(name)) {
    return { ok: false, errors: [`工具「${name}」在当前场景被禁用`], warnings, call: null, tool, needsConfirm: needsConfirm(name) }
  }
  const raw = call.args
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, errors: ['args 必须是对象'], warnings, call: null, tool, needsConfirm: needsConfirm(name) }
  }
  const args = raw ?? {}

  // 未知参数：只警告（模型偶尔多写一个字段不该让整次调用作废），但**不会传给 handler**
  for (const k of Object.keys(args)) {
    if (!tool.params.some((x) => x.name === k)) warnings.push(`忽略未声明的参数 ${k}`)
  }

  const clean = {}
  for (const spec of tool.params) {
    const v = args[spec.name]
    const missing = v === undefined || v === null || v === ''
    if (missing) {
      if (spec.required) errors.push(`缺少必填参数 ${spec.name}（${spec.desc}）`)
      continue
    }
    const r = coerceParam(spec, v)
    if (r.error) { errors.push(r.error); continue }
    clean[spec.name] = r.value
    if (r.warning) warnings.push(r.warning)
  }

  return {
    ok: errors.length === 0,
    errors, warnings,
    call: errors.length === 0 ? { name, args: clean } : null,
    tool,
    needsConfirm: needsConfirm(name),
  }
}

/** 单个参数的收敛：**只做无歧义的修正**（字符串数字转数字、布尔串归一），有歧义就报错。 */
function coerceParam(spec, v) {
  switch (spec.type) {
    case 'integer':
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim())
      if (!Number.isFinite(n)) return { error: `${spec.name} 必须是数字，收到 ${JSON.stringify(v)}` }
      if (spec.type === 'integer' && !Number.isInteger(n)) {
        // 坐标给小数没有意义，半径收敛（不报错），但要说明
        return { value: Math.round(n), warning: `${spec.name} 应为整数，已四舍五入为 ${Math.round(n)}` }
      }
      if (spec.min != null && n < spec.min) return { error: `${spec.name} 不能小于 ${spec.min}` }
      if (spec.max != null && n > spec.max) return { error: `${spec.name} 不能大于 ${spec.max}` }
      return { value: n }
    }
    case 'boolean': {
      if (typeof v === 'boolean') return { value: v }
      const s = String(v).trim().toLowerCase()
      if (['true', '1', 'yes', '是'].includes(s)) return { value: true }
      if (['false', '0', 'no', '否'].includes(s)) return { value: false }
      return { error: `${spec.name} 必须是布尔值` }
    }
    case 'enum': {
      if (typeof v !== 'string') return { error: `${spec.name} 必须是 ${spec.values.join(' / ')} 之一` }
      const hit = spec.values.find((x) => x.toLowerCase() === v.trim().toLowerCase())
      if (!hit) return { error: `${spec.name} 只能是 ${spec.values.join(' / ')}，收到 ${JSON.stringify(v)}` }
      return { value: hit }
    }
    case 'string':
    default: {
      if (typeof v !== 'string') return { error: `${spec.name} 必须是字符串` }
      const t = v.trim()
      if (spec.maxChars != null && [...t].length > spec.maxChars) {
        return { value: t.slice(0, spec.maxChars), warning: `${spec.name} 超长，已截到 ${spec.maxChars} 字` }
      }
      return { value: t }
    }
  }
}

// ---------- 提示词 ----------

/**
 * 生成"有哪些工具可用"的说明。**从 TOOLS 派生**，所以改了参数表提示词自动跟上。
 * @param {{only?:string[], includeConfirm?:boolean, lang?:string}} [opts]
 */
export function buildToolsPrompt(opts = {}) {
  const list = TOOLS.filter((t) => !opts.only || opts.only.includes(t.name))
  const lines = [
    '你可以调用下面这些工具来做事情。需要时**只输出一行 JSON**：',
    '{"tool":"工具名","args":{...}}',
    '不需要调用工具时，正常说话即可，不要输出 JSON。',
    '',
  ]
  for (const t of list) {
    const risk = t.risk === TOOL_RISK.CONFIRM ? '（需要玩家确认后才会执行）' : ''
    lines.push(`· ${t.name}${risk} —— ${t.desc}`)
    if (t.when) lines.push(`   什么时候用：${t.when}`)
    if (t.params.length) {
      for (const s of t.params) {
        const req = s.required ? '必填' : '可选'
        const val = s.values ? `（${s.values.join(' / ')}）` : ''
        const range = (s.min != null || s.max != null) ? `（${s.min ?? '-∞'}~${s.max ?? '∞'}）` : ''
        const ex = s.example !== undefined ? `，例 ${JSON.stringify(s.example)}` : ''
        lines.push(`   - ${s.name}: ${s.type}${val}${range} ${req} ${s.desc}${ex}`)
      }
    }
  }
  return lines.join('\n')
}

// ---------- 解析模型输出 ----------

/**
 * 从模型输出里解析工具调用。**宽容但这几种都认**：
 *   {"tool":"pet","args":{}} / {"name":"pet","arguments":{}} / 裸 {"pet":{...}}
 *   包在代码块里 / 前后有说明文字
 * 解析不出来就当"没有工具调用"（模型只是说了句话）—— 那是正常情况，不是错误。
 *
 * @returns {{calls:Array<{name:string,args:object}>, raw:object|null, error:string|null}}
 */
export function parseToolCalls(text) {
  const s = String(text ?? '').trim()
  if (s === '') return { calls: [], raw: null, error: null }
  const body = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()

  const candidates = []
  // 先试整段
  const whole = tryJson(body)
  if (whole) candidates.push(whole)
  // 再试每一个 {...} 片段（模型爱在 JSON 前后加解释）
  for (const m of body.matchAll(/\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\}/g)) {
    const j = tryJson(m[0])
    if (j) candidates.push(j)
  }

  for (const c of candidates) {
    const norm = normalizeCall(c)
    if (norm) return { calls: [norm], raw: c, error: null }
  }
  return { calls: [], raw: null, error: null }
}

function tryJson(s) {
  try { return JSON.parse(s) } catch { return null }
}

function normalizeCall(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  // {"tool": "...", "args": {...}}
  for (const key of ['tool', 'name', 'tool_name', 'function']) {
    if (typeof obj[key] === 'string' && TOOL_NAMES.includes(obj[key])) {
      const args = obj.args ?? obj.arguments ?? obj.parameters ?? {}
      return { name: obj[key], args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} }
    }
  }
  // 裸 {"pet": {...}} —— 只认单个键，且键必须是登记过的工具名
  const keys = Object.keys(obj)
  if (keys.length === 1 && TOOL_NAMES.includes(keys[0])) {
    const v = obj[keys[0]]
    return { name: keys[0], args: (v && typeof v === 'object' && !Array.isArray(v)) ? v : {} }
  }
  return null
}

/** 给界面用的一行说明。 */
export function describeTool(name) {
  const t = toolByName(name)
  if (!t) return `未登记的工具「${name}」`
  const req = t.params.filter((x) => x.required).map((x) => x.name)
  return `${t.name}（${t.label}）${t.risk === TOOL_RISK.CONFIRM ? ' · 需确认' : ''} —— ${t.desc}`
    + (req.length ? ` 必填：${req.join('、')}` : '')
}
