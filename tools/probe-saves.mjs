// tools/probe-saves.mjs —— 扫描本机真实存档/日志，报告解码链的识别结果
//
// 存在意义：存档格式跨游戏差异极大，**离线造的假数据证明不了什么**。
// 这个工具拿本机真实游戏文件对拍，用来回答「解码链在真实世界到底能认出多少」。
//
// 用法：
//   node tools/probe-saves.mjs                 # 扫描默认位置（LocalLow + Godot userdata）
//   node tools/probe-saves.mjs --limit 40      # 限制每款游戏取样文件数
//   node tools/probe-saves.mjs --root <dir>    # 指定额外扫描根目录
//   node tools/probe-saves.mjs --json          # 输出 JSON（便于做统计）
//
// 路径全部经 os.homedir()/环境变量推导，不写死绝对路径（上个项目踩过硬编码路径的坑）。

import { readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { decodeSaveFile } from '../core/decode.mjs'
import { SKIP_DIR, SKIP_FILE, isSaveCandidate } from '../gameio/base.mjs'

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const LIMIT = Number(argOf('--limit', '12'))
const AS_JSON = argv.includes('--json')
const extraRoots = []
for (let i = 0; i < argv.length; i++) if (argv[i] === '--root' && argv[i + 1]) extraRoots.push(argv[i + 1])

// 扫描规则统一从 gameio/base.mjs 引入（那里是单一事实来源，且规则是拿真实文件试出来的）

/** 默认扫描根：Unity (LocalLow\<公司>\<产品>) 与 Godot (appdata\Godot\app_userdata\<项目>)。 */
function defaultRoots() {
  const roots = []
  const low = join(homedir(), 'AppData', 'LocalLow')
  try {
    for (const d of readdirSync(low)) {
      if (SKIP_DIR.test(d)) continue
      const p = join(low, d)
      try { if (statSync(p).isDirectory()) roots.push({ engine: 'unity', company: d, dir: p }) } catch { /* 无权限 */ }
    }
  } catch { /* 目录不存在 */ }
  const gd = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Godot', 'app_userdata')
  try {
    for (const d of readdirSync(gd)) {
      const p = join(gd, d)
      try {
        if (statSync(p).isDirectory() && !SKIP_DIR.test(d)) roots.push({ engine: 'godot', company: 'Godot', dir: p })
      } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
  return roots
}

/** 在游戏目录里收集候选文件（存档优先，日志单独归类）。 */
function collect(dir, maxDepth = 3) {
  const saves = []
  const logs = []
  const walk = (d, depth) => {
    if (depth > maxDepth) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(e.name)) walk(p, depth + 1)
        continue
      }
      let st
      try { st = statSync(p) } catch { continue }
      if (!st.isFile() || st.size === 0 || st.size > 32 * 1024 * 1024) continue
      if (/^Player(-prev)?\.log$/i.test(e.name)) { logs.push({ p, size: st.size }); continue }
      if (!isSaveCandidate(e.name, st.size)) continue
      saves.push({ p, size: st.size })
    }
  }
  walk(dir, 0)
  saves.sort((a, b) => b.size - a.size)
  logs.sort((a, b) => b.size - a.size)
  return { saves, logs }
}

const roots = [...defaultRoots(), ...extraRoots.map((dir) => ({ engine: 'custom', company: '(指定)', dir }))]
const rows = []

for (const root of roots) {
  const { saves, logs } = collect(root.dir)
  const picked = saves.slice(0, LIMIT)
  for (const f of picked) {
    const r = decodeSaveFile(f.p)
    rows.push({
      engine: root.engine,
      game: root.company,
      file: basename(f.p),
      rel: f.p.slice(root.dir.length + 1).replace(/\\/g, '/'),
      size: f.size,
      format: r.format,     // 最外层容器
      content: r.content,   // 最终解出的格式 —— 统计用这个才有意义
      chain: r.chain.join(' > '),
      ok: r.ok,
      fields: r.value && typeof r.value === 'object' ? Object.keys(r.value).length : 0,
      sha: r.sha256.slice(0, 8),
      note: r.notes[0] ?? '',
    })
  }
  if (logs.length > 0) {
    rows.push({
      engine: root.engine, game: root.company, file: basename(logs[0].p),
      rel: logs[0].p.slice(root.dir.length + 1).replace(/\\/g, '/'),
      size: logs[0].size, format: '(日志)', content: '(日志，未解码)', chain: '', ok: null, fields: 0, sha: '', note: '',
    })
  }
}

if (AS_JSON) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const pad = (s, n) => {
    const w = [...String(s)].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0)
    return String(s) + ' '.repeat(Math.max(0, n - w))
  }
  console.log(pad('引擎', 8) + pad('游戏/公司', 26) + pad('文件', 30) + pad('大小', 10) + pad('识别为', 24) + '字段')
  console.log('-'.repeat(118))
  for (const r of rows) {
    console.log(
      pad(r.engine, 8) + pad(r.game.slice(0, 24), 26) + pad(r.file.slice(0, 28), 30) +
      pad(`${(r.size / 1024).toFixed(1)}K`, 10) + pad(r.content, 24) + (r.fields || (r.ok === null ? '-' : 0)),
    )
  }

  const byFormat = new Map()
  for (const r of rows) byFormat.set(r.content, (byFormat.get(r.content) ?? 0) + 1)
  console.log('\n解出的内容格式分布（content）：')
  for (const [f, n] of [...byFormat].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(f, 26)} ${n}`)

  console.log('\n可解析（ok=true）的样本举例：')
  let shown = 0
  for (const r of rows) {
    if (!r.ok || r.ok === null) continue
    console.log(`  [${r.chain || r.format}] ${r.game} / ${r.rel}`)
    if (++shown >= 8) break
  }
  if (shown === 0) console.log('  （一个都没有 —— 说明解码链还没接对，必须查）')
}
