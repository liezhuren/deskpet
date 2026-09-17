// gameio/index.mjs —— engine adapter 注册表与统一入口
//
// 上层（app / tools）只认这个模块，不直接 import 具体 adapter ——
// 这样新增引擎只需要在这里登记一行。

import * as unity from './unity.mjs'
import * as godot from './godot.mjs'
import * as rpgmaker from './rpgmaker.mjs'
import { detectEngine, inferCapability, walkFiles, describeDetection, SKIP_DIR } from './base.mjs'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 已登记的 adapter。顺序不影响探测结果（detectEngine 按分数排序）。 */
export const ADAPTERS = Object.freeze([unity, godot, rpgmaker])

export const ADAPTER_IDS = Object.freeze(ADAPTERS.map((a) => a.id))

/** 按 id 取 adapter（大小写不敏感）。 */
export function adapterById(id) {
  const k = String(id ?? '').toLowerCase()
  return ADAPTERS.find((a) => a.id === k) ?? null
}

/**
 * 扫一个目录，判断它是哪个引擎的游戏，并给出结论与证据。
 *
 * ★ 显式指定 `opts.adapter` 时**无条件采用**，不看 detect 打分。
 *   理由：用户说"我知道这是 Unity"就是比启发式更可靠的证据 ——
 *   本项目的整体立场就是"把不确定的部分交给用户配"。
 *   最初版本里强制指定仍会被 detect 分数否决（比如一个只有 save.json 的目录，
 *   Unity 的 detect 得 0 分），结果是"我明确指定了却还被当成没识别出来"。
 *
 * @param {string} dir
 * @param {{minScore?:number, adapter?:string}} [opts]
 * @returns {{dir:string, engine:string|null, adapter:object|null, score:number, evidence:string[], candidates:Array, summary:string}}
 */
export function identify(dir, opts = {}) {
  if (opts.adapter) {
    const a = adapterById(opts.adapter)
    if (a) {
      const d = safe(() => a.detect(dir, opts), { score: 0, evidence: [] })
      return {
        dir, engine: a.id, adapter: a,
        score: d?.score ?? 0,
        evidence: [...(d?.evidence ?? []), `引擎由调用方显式指定为 ${a.id}（未走自动探测）`],
        candidates: [{ id: a.id, name: a.name, adapter: a, score: d?.score ?? 0, evidence: d?.evidence ?? [] }],
        summary: `手动指定 ${a.name}（${a.id}）`,
      }
    }
  }
  const minScore = opts.minScore ?? 0.35
  const ranked = detectEngine(dir, ADAPTERS, opts)
  const top = ranked[0] && ranked[0].score >= minScore ? ranked[0] : null
  return {
    dir,
    engine: top?.id ?? null,
    adapter: top?.adapter ?? null,
    score: top?.score ?? 0,
    evidence: top?.evidence ?? [],
    candidates: ranked,
    summary: describeDetection(ranked),
  }
}

/**
 * ★ 一次完整的「了解这个游戏」：探测 → 列日志/存档 → 读会话 → 推出实际可读能力。
 *
 * 返回的 `capability` 就是该交给 core/presence.mjs 的 resolvePolicy 的东西 ——
 * 它决定了这个游戏能不能用非保守档位（见 ARCHITECTURE §5.5）。
 *
 * 注意：`evidence.savesDecoded` 需要**调用方真的解码过至少一个存档**才能传进来，
 * 本函数不替它猜 —— 猜的话就等于绕过「读不出信息就别装作读得出」这条约束。
 *
 * @param {string} dir
 * @param {{adapter?:string, savesDecoded?:boolean, logKinds?:string[], decodeTried?:number}} [opts]
 */
export function inspect(dir, opts = {}) {
  const found = opts.adapter ? { engine: opts.adapter, adapter: adapterById(opts.adapter) } : identify(dir, opts)
  if (!found.adapter) {
    return {
      dir, engine: null, adapter: null, score: 0, evidence: [],
      logs: [], saves: [], session: null, capability: inferCapability(null, {}),
      summary: '没有识别出引擎，只能按纯文件监视处理（仍然可用：存档一变就能触发）',
    }
  }
  const a = found.adapter
  const logs = safe(() => a.findLogs(dir), [])
  const saves = safe(() => a.findSaves(dir), [])
  const session = typeof a.readSession === 'function' ? safe(() => a.readSession(dir), null) : null
  const capability = inferCapability(a, {
    savesDecoded: opts.savesDecoded === true,
    logKinds: opts.logKinds ?? [],
    notes: opts.savesDecoded === true ? [] : ['存档尚未解出结构（或全部解不开）⇒ 只按"文件变了"处理'],
  })
  return { dir, engine: a.id, adapter: a, score: found.score ?? 0, evidence: found.evidence ?? [], logs, saves, session, capability }
}

/** 顺带给出目录里的文件概况，便于界面展示与排查。 */
export function overview(dir) {
  const { saves, logs, other } = walkFiles(dir, { maxDepth: 3, limit: 200 })
  return { saves: saves.length, logs: logs.length, other: other.length, totalBytes: [...saves, ...logs].reduce((s, f) => s + f.size, 0) }
}

/**
 * 自动发现本机游戏目录。
 *
 * 实测要处理两种形状（两种都真实存在）：
 *   `LocalLow\<公司>\<产品>\`   —— 绝大多数 Unity 游戏（Team Cherry\Hollow Knight）
 *   `LocalLow\<公司>\`          —— 有些游戏直接把 Player.log 放在公司目录下（实测 HyperGryph）
 * 另外 Godot 的落点是 `%APPDATA%\Godot\app_userdata\<项目名>\`。
 *
 * @param {{roots?:string[], minScore?:number, limit?:number}} [opts]
 * @returns {Array<{dir:string, engine:string|null, score:number, evidence:string[], saves:number}>}
 */
export function discoverGames(opts = {}) {
  const minScore = opts.minScore ?? 0.35
  const limit = opts.limit ?? 500
  const roots = opts.roots ?? defaultRoots()
  const out = []
  const seen = new Set()

  const consider = (dir) => {
    if (out.length >= limit || seen.has(dir)) return
    seen.add(dir)
    const r = identify(dir, { minScore })
    if (!r.engine) return
    const a = r.adapter
    const saves = safe(() => a.findSaves(dir).length, 0)
    out.push({ dir, engine: r.engine, score: r.score, evidence: r.evidence, saves })
  }

  for (const root of roots) {
    let companies
    try { companies = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const co of companies) {
      if (!co.isDirectory() || SKIP_DIR.test(co.name)) continue
      const companyDir = join(root, co.name)
      // 形状一：公司目录下就是游戏本身
      consider(companyDir)
      // 形状二：公司目录下还有产品目录
      let products
      try { products = readdirSync(companyDir, { withFileTypes: true }) } catch { continue }
      for (const pr of products) {
        if (!pr.isDirectory() || SKIP_DIR.test(pr.name)) continue
        consider(join(companyDir, pr.name))
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir))
}

/** 本机默认扫描根。路径全部经环境变量推导，不写死绝对路径。 */
export function defaultRoots() {
  const roots = []
  const low = join(homedir(), 'AppData', 'LocalLow')
  if (existsSync(low)) roots.push(low)
  const roaming = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const godot = join(roaming, 'Godot', 'app_userdata')
  if (existsSync(godot)) roots.push(godot)
  return roots
}

function safe(fn, dflt) {
  try { return fn() } catch { return dflt }
}

export { unity, godot, rpgmaker }
export { SKIP_DIR }
