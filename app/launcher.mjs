// app/launcher.mjs —— 启动器（发现游戏 → 选一个 → 启动 → 开始监视）
//
// ══════════════════════════════════════════════════════════════════
// 这一层为什么必须以"安全"为主轴
// ══════════════════════════════════════════════════════════════════
// 启动器是全项目**唯一会执行外部程序**的地方，而它同时又是 LLM 工具（launch_app）的后端。
// 也就是说：一个可能被幻觉影响的组件，被接到了"能在你电脑上启动进程"的能力上。
// 所以规则是硬性的，不靠提示词自觉：
//
//   ① **只启动登记过的目标**。`launch()` 收的是 launchables 里的 id/名字，
//      不是路径 —— 模型没法构造一个路径来启动任意程序。
//   ② **黑名单永远先生效**：卸载器、运行库安装器、崩溃处理器一律拒绝，
//      哪怕它出现在登记列表里（用户可能手滑加进来）。
//   ③ **默认要人确认**。`confirmBeforeLaunch` 默认 true，调用方必须显式带上批准。
//   ④ **不经过 shell**：spawn 传参数数组、`shell: false`，
//      参数里的元字符不会被解释（否则 args 就成了注入点）。
//
// 与其它层一样：**发现**是纯函数（可离线测、可注入 fs），**启动**是注入的 spawnImpl。
// 于是"发现逻辑"能被穷举测试，"真的启动进程"则永远需要真实调用方点头。

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, basename, extname, sep } from 'node:path'
import { spawn } from 'node:child_process'

/** 启动器的默认参数。 */
export const LAUNCHER_DEFAULTS = Object.freeze({
  maxDepth: 3,        // 在游戏目录里往下找 .exe 的层数
  maxExes: 40,        // 单个目录最多收集多少个候选
  maxPerRoot: 200,    // 单个根目录最多发现多少个游戏
})

/**
 * ★ 永远不准启动的可执行文件（**在黑名单面前没有例外**）。
 * 这些不是游戏本体，启动它们轻则打扰用户（弹安装器），重则改动系统。
 */
export const DENY_EXE_PATTERNS = Object.freeze([
  /^unins/i,                    // unins000.exe 之类
  /^setup/i, /^install/i,
  /vcredist/i, /dxsetup/i, /directx/i, /dotnet/i, /^vc_redist/i,
  /crashpad/i, /crashreport/i, /crashhandler/i, /UnityCrashHandler/i,
  /^steam\.exe$/i, /^steamwebhelper/i, /^steamservice/i,
  /^epicgameslauncher/i, /^galaxyclient/i, /^upc\.exe$/i,
  /^launcher$/i,                // 泛用的 launcher.exe 常见于更新器
  /^python/i, /^node\.exe$/i, /^cmd\.exe$/i, /^powershell/i,
  /^7z/i, /^winrar/i, /^javaw?\.exe$/i,
])

/** 这个 exe 是否被禁止启动。 */
export function isDeniedExe(fileName) {
  const n = basename(String(fileName ?? ''))
  if (extname(n).toLowerCase() !== '.exe') return true       // 非 exe 一律不当候选
  return DENY_EXE_PATTERNS.some((re) => re.test(n))
}

// ---------- Steam 库发现 ----------

/**
 * 从 `libraryfolders.vdf` 里抽出库路径（零依赖、容错解析）。
 * ⚠ 刻意不写完整的 VDF 解析器：我们只要 `"path" "<值>"` 这一种键，
 *   正则足够且**不会因为遇到没见过的结构就整个失败**。真实文件的写法见过两种：
 *   老版 `"1" "D:\\SteamLibrary"`，新版嵌套成 `"1" { "path" "D:\\SteamLibrary" }`。
 *   两种都靠同一条正则覆盖（都含 `"path"` 或直接是 `"数字" "路径"`）。
 */
export function parseLibraryFolders(text) {
  const out = []
  const src = String(text ?? '')
  // 新版： "path"  "D:\\SteamLibrary"
  for (const m of src.matchAll(/"path"\s+"([^"]+)"/gi)) out.push(m[1])
  // 老版：  "1"     "D:\\SteamLibrary"   （键是数字、值是看起来像路径的串）
  for (const m of src.matchAll(/"\d+"\s+"([A-Za-z]:[^"]*)"/g)) out.push(m[1])
  const uniq = []
  for (const raw of out) {
    const p = String(raw).replace(/\\\\/g, '\\').replace(/\/+$/, '').trim()
    if (p && !uniq.includes(p)) uniq.push(p)
  }
  return uniq
}

/** 常见的 Steam 安装位置（存在才算）。 */
export function defaultSteamRoots(env = process.env) {
  const pf = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const pf64 = env['ProgramFiles'] ?? 'C:\\Program Files'
  return [
    join(pf, 'Steam'),
    join(pf64, 'Steam'),
    'C:\\Steam',
    'D:\\Steam',
    'D:\\SteamLibrary',
    'E:\\SteamLibrary',
  ]
}

/**
 * 找出所有 Steam 库目录（含 `steamapps/common`）。全部走注入的 fs，便于离线测。
 * @returns {{roots:string[], steamInstalls:string[], notes:string[]}}
 */
export function steamLibraryRoots({ fs = defaultFs(), steamRoots = defaultSteamRoots() } = {}) {
  const notes = []
  const installs = []
  const roots = []
  for (const base of steamRoots) {
    if (!fs.exists(join(base, 'steamapps'))) continue
    installs.push(base)
    roots.push(join(base, 'steamapps', 'common'))
    const vdf = join(base, 'steamapps', 'libraryfolders.vdf')
    if (fs.exists(vdf)) {
      try {
        for (const lib of parseLibraryFolders(fs.readText(vdf))) {
          const common = join(lib, 'steamapps', 'common')
          if (fs.exists(common)) roots.push(common)
        }
      } catch (e) {
        notes.push(`读 libraryfolders.vdf 失败：${e.message}`)
      }
    }
  }
  const uniq = []
  for (const r of roots) if (!uniq.includes(r)) uniq.push(r)
  if (installs.length === 0) notes.push('没找到 Steam 安装（不影响：可以手动登记游戏目录）')
  return { roots: uniq, steamInstalls: installs, notes }
}

// ---------- 在目录里找 exe ----------

/**
 * 在目录里找可启动的 .exe（限深、限量、过黑名单）。
 * @returns {Array<{path:string, name:string, size:number, depth:number}>}
 */
export function findExecutables(dir, opts = {}) {
  // ⚠ 显式兜 null：默认参数只挡 undefined（这个坑本项目踩过多次）
  const o = (opts && typeof opts === 'object') ? opts : {}
  const D = { ...LAUNCHER_DEFAULTS, ...o }
  const fs = (o.fs && typeof o.fs === 'object') ? o.fs : defaultFs()
  const found = []
  const walk = (d, depth) => {
    if (depth > D.maxDepth || found.length >= D.maxExes) return
    let entries = []
    try { entries = fs.list(d) } catch { return }
    for (const e of entries) {
      if (found.length >= D.maxExes) return
      if (e.isDir) {
        if (e.name.startsWith('.')) continue
        walk(join(d, e.name), depth + 1)
        continue
      }
      if (isDeniedExe(e.name)) continue
      found.push({ path: join(d, e.name), name: e.name, size: e.size ?? 0, depth })
    }
  }
  walk(dir, 0)
  return found
}

/**
 * 从候选里挑"最像本体"的那个 exe。
 * 评分：目录名与文件名相似度高者优先；体积大的优先（游戏本体远大于工具）；
 * 层级浅的优先。**不猜也不编** —— 挑不出来就返回 null，让用户自己指定。
 */
export function pickMainExe(exes, gameName = '') {
  if (!Array.isArray(exes) || exes.length === 0) return null
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
  const want = norm(gameName)
  let best = null
  for (const e of exes) {
    const stem = norm(basename(e.name, extname(e.name)))
    let score = 0
    if (want && stem === want) score += 10
    else if (want && (stem.includes(want) || want.includes(stem)) && stem.length >= 3) score += 6
    // 体积：按对数给分，避免一个 100GB 的无关文件压过一切
    score += Math.min(3, Math.log10(Math.max(1, e.size ?? 1)) / 2)
    score -= (e.depth ?? 0) * 0.5
    if (!best || score > best.score) best = { ...e, score }
  }
  return best ? { path: best.path, name: best.name, size: best.size, score: Number(best.score.toFixed(2)) } : null
}

/** 稳定的短 id（用于界面与工具参数引用）。 */
export function launchableId(dir, exe) {
  const s = `${dir}\u0000${exe ?? ''}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return `app_${h.toString(36)}`
}

/**
 * ★ 组装"可启动清单"。这是 `launch()` 唯一认的来源 —— 模型不能凭空给路径。
 *
 * ⚠ 去重键必须**归一化**（大小写 + 分隔符 + 末尾斜杠）。
 *   实测踩过：收藏里写 `lib/Hollow Knight`、扫描出来是 `lib\Hollow Knight`，
 *   两个字符串不相等 ⇒ 同一个游戏被登记两次，界面上出现两行。
 *   在 Windows 上这几乎必然发生（join 用反斜杠，用户手输常用正斜杠）。
 *
 * @param {{favorites?:Array<{dir:string,name?:string,exe?:string}>, roots?:string[],
 *          maxPerRoot?:number, fs?:object}} [opts]
 * @returns {{items:Array, notes:string[]}}
 */
export function buildLaunchables(opts = {}) {
  const o = (opts && typeof opts === 'object') ? opts : {}
  const D = { ...LAUNCHER_DEFAULTS, ...o }
  const fs = (o.fs && typeof o.fs === 'object') ? o.fs : defaultFs()
  const items = []
  const notes = []
  const seen = new Set()

  const add = (dir, name, source, exeHint) => {
    if (items.length >= D.maxPerRoot) return
    if (!dir || typeof dir !== 'string') return
    const key = dirKey(dir)
    if (seen.has(key)) return
    seen.add(key)
    const label = name ?? basename(dir)
    let exes = []
    try { exes = findExecutables(dir, { ...D, fs }) } catch { /* 读不了就当作没有 */ }
    const main = exeHint && fs.exists(exeHint) && !isDeniedExe(exeHint)
      ? { path: exeHint, name: basename(exeHint), size: 0, score: null }
      : pickMainExe(exes, label)
    if (!main) {
      // ★ 没找到 exe **也要登记**：它仍然可以被监视（读日志与存档是本项目的主线能力），
      //   只是不能由启动器负责启动。提示语说的"仍可用于监视"必须是真的 —— 否则就是骗人。
      notes.push(`「${label}」里没找到可启动的 exe ⇒ 只能监视；要启动的话需要手动指定`)
      items.push({
        id: launchableId(dir, null), name: label, dir,
        exe: null, exeName: null, source, candidates: exes.length, launchable: false,
      })
      return
    }
    items.push({
      id: launchableId(dir, main.path),
      name: label,
      dir,
      exe: main.path,
      exeName: main.name,
      source,
      candidates: exes.length,
      launchable: true,
    })
  }

  for (const f of o.favorites ?? []) {
    if (!f || typeof f !== 'object' || typeof f.dir !== 'string' || f.dir === '') continue
    add(f.dir, f.name, 'favorite', typeof f.exe === 'string' ? f.exe : null)
  }
  for (const root of o.roots ?? []) {
    if (typeof root !== 'string' || root === '') continue
    let entries = []
    try { entries = fs.list(root) } catch { notes.push(`读不了目录：${root}`); continue }
    for (const e of entries) {
      if (!e.isDir) continue
      if (items.length >= D.maxPerRoot) break
      add(join(root, e.name), e.name, 'scan')
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name))
  return { items, notes }
}

/** 目录的归一化去重键（Windows 路径大小写无关，分隔符与末尾斜杠统一）。 */
export function dirKey(dir) {
  return String(dir ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 按名字/目录名/id 找启动目标。**模型只能通过这个函数间接引用 exe**。
 * 完全匹配优先，其次唯一的前缀/子串匹配；**多个候选命中就拒绝**（不猜）。
 */
export function resolveLaunchTarget(query, items = []) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return { ok: false, error: '没给目标名', matches: [] }
  const exact = items.filter((i) => i.id.toLowerCase() === q || i.name.toLowerCase() === q || basename(i.dir).toLowerCase() === q)
  if (exact.length === 1) return { ok: true, item: exact[0], matches: exact }
  if (exact.length > 1) return { ok: false, error: `「${query}」匹配到多个（${exact.map((i) => i.name).join('、')}），请说得更具体`, matches: exact }
  const partial = items.filter((i) => i.name.toLowerCase().includes(q) || basename(i.dir).toLowerCase().includes(q))
  if (partial.length === 1) return { ok: true, item: partial[0], matches: partial }
  if (partial.length > 1) return { ok: false, error: `「${query}」匹配到多个（${partial.map((i) => i.name).join('、')}），请说得更具体`, matches: partial }
  return { ok: false, error: `没有登记过叫「${query}」的游戏`, matches: [] }
}

// ---------- 启动 ----------

/**
 * ★ 启动一个**已登记**的目标。
 *
 * 拒绝的四种情况（都要给出可读原因，不静默失败）：
 *   ① 不在登记清单里（模型没法构造路径）
 *   ② 命中黑名单
 *   ③ 需要确认但没拿到批准（`confirmBeforeLaunch` 默认 true）
 *   ④ exe 文件不存在
 *
 * @param {{id?:string, name?:string, args?:string}} req
 * @param {{items:Array, approve?:boolean, confirmRequired?:boolean,
 *          spawnImpl?:Function, existsImpl?:Function}} opts
 * @returns {{ok:boolean, pid?:number, item?:object, error?:string, needsConfirm?:boolean, notes:string[]}}
 */
export function launch(req = {}, opts = {}) {
  // ⚠ 默认参数只挡 undefined，不挡 null —— 这个坑本项目踩过好几次，这里显式兜住。
  const request = (req && typeof req === 'object') ? req : {}
  const notes = []
  const items = opts.items ?? []
  const key = request.id ?? request.name ?? request.target
  const r = resolveLaunchTarget(key, items)
  if (!r.ok) return { ok: false, error: r.error, notes }

  const item = r.item
  if (!item.exe) {
    return { ok: false, error: `「${item.name}」还没指定可执行文件（可以在启动器里手动选一个）`, item, notes }
  }
  if (isDeniedExe(item.exe)) {
    return { ok: false, error: `「${item.exeName ?? item.exe}」在禁止启动的名单里（不是游戏本体）`, item, notes }
  }
  const existsImpl = opts.existsImpl ?? existsSync
  if (!existsImpl(item.exe)) {
    return { ok: false, error: `可执行文件不存在：${item.exe}`, item, notes }
  }

  const confirmRequired = opts.confirmRequired !== false    // 默认要求确认
  if (confirmRequired && opts.approve !== true) {
    return { ok: false, needsConfirm: true, item, error: `启动「${item.name}」需要先确认`, notes }
  }

  // 参数：字符串按空白切分。**不经过 shell**，所以元字符不会被解释 ——
  // 这也是为什么这里可以安全地接受模型给的 args。
  const args = typeof request.args === 'string' && request.args.trim() !== ''
    ? request.args.trim().split(/\s+/).slice(0, 20)
    : []

  const spawnImpl = opts.spawnImpl ?? ((cmd, argv, o) => spawn(cmd, argv, o))
  try {
    const child = spawnImpl(item.exe, args, { detached: true, stdio: 'ignore', shell: false, cwd: item.dir })
    const pid = child?.pid ?? null
    if (typeof child?.unref === 'function') child.unref()
    notes.push(`已启动 ${item.name}${args.length ? `（参数：${args.join(' ')}）` : ''}`)
    return { ok: true, pid, item, notes }
  } catch (e) {
    return { ok: false, error: `启动失败：${e.message}`, item, notes }
  }
}

/** 把游戏目录与"实际在写存档的目录"对起来（启动之后要开始监视的那一个）。 */
export function matchWatchDir(gameName, discovered = []) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
  const want = norm(gameName)
  if (!want) return null
  const exact = discovered.filter((g) => norm(g.dir.split(/[\\/]/).pop()) === want)
  if (exact.length === 1) return exact[0].dir
  const partial = discovered.filter((g) => {
    const tail = norm(g.dir.split(/[\\/]/).pop())
    return tail.length >= 3 && (tail.includes(want) || want.includes(tail))
  })
  return partial.length === 1 ? partial[0].dir : null
}

// ---------- 真实 fs（可注入，便于测试） ----------

export function defaultFs() {
  return {
    exists: (p) => { try { return existsSync(p) } catch { return false } },
    readText: (p) => readFileSync(p, 'utf8'),
    list: (d) => readdirSync(d, { withFileTypes: true }).map((e) => {
      let size = 0
      if (!e.isDirectory()) { try { size = statSync(join(d, e.name)).size } catch { size = 0 } }
      return { name: e.name, isDir: e.isDirectory(), size }
    }),
    join,
    sep,
  }
}
