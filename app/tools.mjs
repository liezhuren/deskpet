// app/tools.mjs —— 工具执行器：把 core/tools.mjs 的**契约**接到真实能力上
//
// ══════════════════════════════════════════════════════════════════
// 这里只有四件事，但每一件都不能省
// ══════════════════════════════════════════════════════════════════
//   ① **校验** —— 一律先过 core/tools.mjs 的 validateToolCall（参数闭集、类型、范围）
//   ② **确认** —— 需要确认的工具，没批准就**不执行**，而是挂成一条"待确认"
//   ③ **限流** —— 工具是模型驱动的，一个失控的循环能在 1 秒里把窗口挪 100 次。
//      每工具有最小间隔，整体有每分钟上限；超了就**拒绝并说明**，不排队（排队更糟）
//   ④ **审计** —— 每一次调用（含被拒的）都进历史。用户必须能查到"你的桌宠刚才试过做什么"。
//      被拒的记录尤其重要：那是"模型想干但被拦住"的证据，比成功记录更有信息量。
//
// 另外一条设计：**handlers 是注入的**。执行器自己不认识 Electron、不认识窗口，
// 只认识"有个叫 move_to 的能力，收 {x,y}"。于是整条路径可以离线测完 ——
// 而真正会碰到操作系统的只有 launcher.launch 一处。

import {
  TOOLS, TOOL_NAMES, TOOL_RISK, toolByName, needsConfirm, validateToolCall, buildToolsPrompt,
  parseToolCalls, describeTool,
} from '../core/tools.mjs'

/** 执行器默认参数。 */
export const TOOL_DEFAULTS = Object.freeze({
  /** 每个工具的最小调用间隔（毫秒）。挪窗口最频繁，其余放宽。 */
  minIntervalMs: Object.freeze({
    move_to: 400,
    pet: 800,
    interact: 600,
    launch_app: 5000,
    cancel: 200,
    generate_character_card: 10000,
  }),
  defaultIntervalMs: 500,
  /** 全局：一分钟内最多执行多少次工具（不含被拒的）。 */
  maxPerMinute: 30,
  /** 审计历史保留多少条。 */
  maxAudit: 200,
  /** 待确认的请求最多挂几条（防止模型刷屏式请求启动程序）。 */
  maxPending: 5,
})

/**
 * 建执行器。
 *
 * @param {object} p
 * @param {Record<string,Function>} [p.handlers] 工具名 → 执行函数（收 args，返回任意结果）
 * @param {(info:object)=>boolean} [p.approve] 需要确认时问用户；返回 true 才执行。
 *        不传 ⇒ 需要确认的工具一律**拒绝**（安全默认：没人能批准就别做）
 * @param {()=>number} [p.now]
 * @param {object} [p.limits] TOOL_DEFAULTS 的覆盖
 */
export function createToolRunner(p = {}) {
  // ⚠ `p = {}` 只挡 undefined，不挡 null —— 这个坑在本项目里反复出现，
  //   所以每个收选项对象的新函数都要显式兜住（不然 createToolRunner(null) 直接抛）。
  const opts = (p && typeof p === 'object') ? p : {}
  const handlers = (opts.handlers && typeof opts.handlers === 'object') ? opts.handlers : {}
  const now = typeof opts.now === 'function' ? opts.now : (() => Date.now())
  const L = { ...TOOL_DEFAULTS, ...(opts.limits && typeof opts.limits === 'object' ? opts.limits : {}) }
  const approveFn = typeof opts.approve === 'function' ? opts.approve : null
  const audit = []
  const pending = []
  const lastAt = {}
  let runTimes = []
  let seq = 0

  function record(entry) {
    audit.push({ seq: ++seq, at: now(), ...entry })
    while (audit.length > L.maxAudit) audit.shift()
  }

  function intervalFor(name) {
    return L.minIntervalMs?.[name] ?? L.defaultIntervalMs
  }

  /** 限流检查。返回 null 表示放行，否则返回拒绝原因。 */
  function throttled(name) {
    const t = now()
    const last = lastAt[name]
    const gap = intervalFor(name)
    if (Number.isFinite(last) && t - last < gap) {
      return `「${name}」调用太频繁（最小间隔 ${gap}ms，距上次 ${t - last}ms）`
    }
    runTimes = runTimes.filter((x) => t - x < 60_000)
    if (runTimes.length >= L.maxPerMinute) {
      return `一分钟内已经调用过 ${runTimes.length} 次工具（上限 ${L.maxPerMinute}），先停一停`
    }
    return null
  }

  /**
   * 执行一次工具调用。**永不抛异常**。
   *
   * @param {{name:string, args?:object, approved?:boolean, reason?:string}} call
   * @returns {Promise<{ok:boolean, name:string, result?:any, error?:string,
   *                    needsConfirm?:boolean, pendingId?:string, notes:string[]}>}
   */
  async function run(call) {
    const notes = []
    const v = validateToolCall(call)
    const name = String(call?.name ?? '')

    if (!v.ok) {
      for (const e of v.errors) notes.push(e)
      record({ name, args: call?.args ?? null, decision: 'invalid', reasons: v.errors })
      return { ok: false, name, error: v.errors[0], notes }
    }
    for (const w of v.warnings) notes.push(w)

    // 需要确认但没批准 ⇒ 挂成待确认（而不是直接扔掉：用户可能稍后同意）
    if (v.needsConfirm && call?.approved !== true) {
      let approved = false
      if (approveFn) {
        try { approved = approveFn({ name: v.call.name, args: v.call.args, tool: v.tool, reason: call?.reason }) === true } catch { approved = false }
      }
      if (!approved) {
        if (pending.length >= L.maxPending) {
          record({ name, args: v.call.args, decision: 'pending-overflow', reasons: ['待确认过多'] })
          return { ok: false, name, error: `待确认的请求太多（${pending.length}），先处理掉再试`, needsConfirm: true, notes }
        }
        const id = `tc_${++seq}`
        pending.push({ id, name: v.call.name, args: v.call.args, at: now(), reason: call?.reason ?? null })
        record({ name, args: v.call.args, decision: 'needs-confirm', pendingId: id, reasons: [call?.reason ?? '未批准'] })
        return { ok: false, name, error: `「${v.tool.label}」需要你确认`, needsConfirm: true, pendingId: id, notes }
      }
    }

    const gate = throttled(v.call.name)
    if (gate) {
      record({ name: v.call.name, args: v.call.args, decision: 'throttled', reasons: [gate] })
      return { ok: false, name: v.call.name, error: gate, notes }
    }

    const h = handlers[v.call.name]
    if (typeof h !== 'function') {
      record({ name: v.call.name, args: v.call.args, decision: 'no-handler' })
      return { ok: false, name: v.call.name, error: `工具「${v.call.name}」还没有接上实现`, notes }
    }

    try {
      const result = await h(v.call.args, { name: v.call.name, tool: v.tool, reason: call?.reason })
      lastAt[v.call.name] = now()
      runTimes.push(now())
      record({ name: v.call.name, args: v.call.args, decision: 'ok', result: summarize(result), reasons: call?.reason ? [call.reason] : [] })
      return { ok: true, name: v.call.name, result, notes }
    } catch (e) {
      lastAt[v.call.name] = now()
      record({ name: v.call.name, args: v.call.args, decision: 'error', reasons: [e.message] })
      return { ok: false, name: v.call.name, error: `执行失败：${e.message}`, notes }
    }
  }

  /** 批准并执行一条待确认的请求。 */
  async function approvePending(id) {
    const i = pending.findIndex((x) => x.id === id)
    if (i < 0) return { ok: false, name: null, error: `没有待确认的请求 ${id}`, notes: [] }
    const item = pending.splice(i, 1)[0]
    return run({ name: item.name, args: item.args, approved: true, reason: item.reason ?? '用户已确认' })
  }

  /** 拒绝掉一条待确认的请求。 */
  function rejectPending(id, reason = '用户拒绝') {
    const i = pending.findIndex((x) => x.id === id)
    if (i < 0) return false
    const item = pending.splice(i, 1)[0]
    record({ name: item.name, args: item.args, decision: 'rejected', reasons: [reason] })
    return true
  }

  return {
    run,
    approvePending,
    rejectPending,
    pending: () => pending.map((x) => ({ ...x })),
    history: (n = 20) => audit.slice(-n).map((x) => ({ ...x })),
    /** 统计：成功 / 被拒 / 被限流 各多少（给界面与长跑看） */
    stats: () => {
      const s = { total: audit.length, ok: 0, needsConfirm: 0, rejected: 0, throttled: 0, invalid: 0, error: 0, pending: pending.length }
      for (const a of audit) {
        if (a.decision === 'ok') s.ok++
        else if (a.decision === 'needs-confirm') s.needsConfirm++
        else if (a.decision === 'rejected') s.rejected++
        else if (a.decision === 'throttled') s.throttled++
        else if (a.decision === 'invalid') s.invalid++
        else if (a.decision === 'error') s.error++
      }
      return s
    },
    reset() { audit.length = 0; pending.length = 0; runTimes = [] },
  }
}

/** 审计里的结果摘要（不要把整个对象塞进历史，避免记忆/日志膨胀）。 */
function summarize(result) {
  if (result == null) return null
  if (typeof result !== 'object') return String(result).slice(0, 120)
  const out = {}
  for (const [k, v] of Object.entries(result)) {
    if (v == null) continue
    if (typeof v === 'object') { out[k] = Array.isArray(v) ? `[${v.length} 项]` : '{…}'; continue }
    out[k] = typeof v === 'string' ? v.slice(0, 120) : v
  }
  return out
}

/** 执行器的能力是否齐全（缺哪些工具的实现）。 */
export function missingHandlers(handlers = {}) {
  const h = (handlers && typeof handlers === 'object') ? handlers : {}
  return TOOL_NAMES.filter((n) => typeof h[n] !== 'function')
}

export { TOOLS, TOOL_NAMES, TOOL_RISK, toolByName, needsConfirm, validateToolCall, buildToolsPrompt, parseToolCalls, describeTool }
