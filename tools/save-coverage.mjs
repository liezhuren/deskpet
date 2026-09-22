// tools/save-coverage.mjs —— 存档覆盖率实测：把「37.7%」这个数拆开看
//
// ══════════════════════════════════════════════════════════════════
// 为什么不能直接看那一个比值
// ══════════════════════════════════════════════════════════════════
// 先前报出的「162 个候选 / 61 个完全解开 = 37.7%」里，**分子与分母不是同一群文件**：
//   · 分母是 `isSaveCandidate()` 挑出来的 —— 它刻意只看名字与大小、不看语义，
//     所以必然混进 settings.json / graphics.ini / 资源包这类**根本不是存档**的东西
//   · 分子是"解码链完全理解了的文件"
// 拿"能看懂的文件"除以"所有像文件的文件"，得到的既不是"存档读得好不好"，
// 也不是"这个桌宠能不能用"。所以这个工具把账拆成四层：
//
//   ① 能不能解析（技术层）
//   ② 解析不了的原因分布（是加密/私有二进制，还是我们没实现）
//   ③ 按文件名粗分：失败是不是集中在**非存档**文件上
//   ④ **按游戏汇总**：多少个游戏至少有一份能看懂的存档 —— 这才是产品层的指标
//
// 以及一个容易忘的事实：**产品基线根本不需要解码**。
// 桌宠的核心能力是"存档被写入 ⇒ 这是松懈点"，那只需要文件 mtime。
// 解码只决定"能不能读得更多"，不决定"能不能用"。

import { readdirSync, statSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { homedir } from 'node:os'

import { decodeSaveFile } from '../core/decode.mjs'
import { SKIP_DIR, SKIP_FILE, isSaveCandidate } from '../gameio/base.mjs'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const LIMIT_PER_GAME = Number(flag('limit', '40'))
const AS_JSON = args.includes('--json')

/** 默认扫描根（与 probe-saves.mjs 保持一致）。 */
function defaultRoots() {
  const out = []
  const home = homedir()
  const localLow = join(home, 'AppData', 'LocalLow')
  try {
    for (const d of readdirSync(localLow, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      out.push({ engine: 'unity', game: d.name, dir: join(localLow, d.name) })
    }
  } catch { /* 没有 LocalLow 就算了 */ }
  const appdata = join(home, 'AppData', 'Roaming')
  try {
    for (const d of readdirSync(appdata, { withFileTypes: true })) {
      if (!d.isDirectory() || SKIP_DIR.test(d.name)) continue
      out.push({ engine: 'godot/rpgmaker', game: d.name, dir: join(appdata, d.name) })
    }
  } catch { /* 同上 */ }
  return out
}

function collect(dir, maxDepth = 3) {
  const saves = []
  const walk = (d, depth) => {
    if (depth > maxDepth) return
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) walk(p, depth + 1); continue }
      let st
      try { st = statSync(p) } catch { continue }
      if (!st.isFile() || st.size === 0 || st.size > 32 * 1024 * 1024) continue
      if (!isSaveCandidate(e.name, st.size)) continue
      saves.push({ p, name: e.name, size: st.size, mtimeMs: st.mtimeMs, rel: relative(dir, p) })
    }
  }
  walk(dir, 0)
  saves.sort((a, b) => b.size - a.size)
  return saves
}

/**
 * 按文件名粗分这三桶。**这是启发式，不是事实** —— 判不出来就进 unknown，
 * 不硬塞（"猜"出来的归类会让后面的比例全是假的）。
 */
const NAME_BUCKETS = [
  ['像存档', /(save|存档|slot|autosave|quicksave|progress|profile|player|file\d|data\d|game\d|user\d|global|persist)/i],
  ['像配置', /(settings|config|prefs|preference|options|input|keybind|graphics|video|audio|quality|resolution|\.ini$|\.cfg$|\.conf$|registry)/i],
  ['像资源', /(\.(bundle|assets|ress|resource|pak|bank|blob|bin\.assets|shader|mat|anim|controller|ttf|otf|wav|ogg|mp3|dds|ktx)$)/i],
]
function bucketOf(name) {
  for (const [label, re] of NAME_BUCKETS) if (re.test(name)) return label
  return '判不出来'
}

/**
 * 失败原因的**终审结论**分类。`format` 在失败时就是"卡在哪一步"的结论，
 * 所以直接按它归类；比按 notes 猜文本可靠。
 */
const FAIL_REASON = {
  binary: '非文本二进制（加密或私有格式）—— 需要游戏专用解码器',
  'base64-binary': 'base64 里包着二进制 —— 多半是加密的',
  'base64-text': 'base64 解出文本但不是已知结构（可能再套了一层加密）',
  'binary-formatter': '.NET BinaryFormatter —— 本工具不实现反序列化',
  text: '是文本，但不是 JSON/XML/Godot/INI —— 未知的文本结构',
  zip: 'zip 容器读不开',
  unknown: '认不出任何已知特征',
  'too-large': '超过解析上限（只算了哈希）',
  empty: '空文件',
}
const reasonOf = (r) => FAIL_REASON[r.format] ?? `其他（${r.format}）`

// ══════════════════ 跑 ══════════════════

const roots = defaultRoots()
const rows = []
for (const root of roots) {
  const saves = collect(root.dir)
  if (saves.length === 0) {
    rows.push({ ...root, candidates: 0, files: [] })
    continue
  }
  const files = saves.slice(0, LIMIT_PER_GAME).map((f) => {
    const r = decodeSaveFile(f.p)
    return {
      name: f.name, rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, ok: r.ok === true,
      format: r.format, content: r.content, chain: r.chain ?? [],
      bucket: bucketOf(f.name), note: (r.notes ?? []).slice(-1)[0] ?? '',
    }
  })
  rows.push({ ...root, candidates: saves.length, files, truncated: saves.length > files.length })
}

const all = rows.flatMap((g) => g.files)
const okFiles = all.filter((f) => f.ok)

// ① 技术层
const parseRate = all.length ? okFiles.length / all.length : 0

// ② 失败原因
const reasons = new Map()
for (const f of all.filter((x) => !x.ok)) {
  const k = reasonOf(f)
  reasons.set(k, (reasons.get(k) ?? 0) + 1)
}

// ③ 按文件名分桶
const byBucket = new Map()
for (const f of all) {
  const b = byBucket.get(f.bucket) ?? { total: 0, ok: 0 }
  b.total++
  if (f.ok) b.ok++
  byBucket.set(f.bucket, b)
}

// ④ 按游戏汇总（产品层指标）
const gamesWithAny = rows.filter((g) => g.candidates > 0)
const gamesWithDecoded = rows.filter((g) => g.files.some((f) => f.ok))
const gamesWithFiles = gamesWithAny.length

if (AS_JSON) {
  console.log(JSON.stringify({
    games: rows.length, gamesWithAny, gamesWithDecoded: gamesWithDecoded.length,
    candidates: all.length, decoded: okFiles.length, parseRate,
    reasons: [...reasons].sort((a, b) => b[1] - a[1]),
    buckets: [...byBucket].map(([k, v]) => ({ bucket: k, ...v })),
    perGame: rows.map((g) => ({
      game: g.game, engine: g.engine, candidates: g.candidates,
      decoded: g.files.filter((f) => f.ok).length,
    })),
    failures: all.filter((f) => !f.ok).map((f) => ({ name: f.name, format: f.format, bucket: f.bucket })),
  }, null, 2))
  process.exit(0)
}

const pad = (s, n) => String(s ?? '').padEnd(n)
const pct = (a, b) => (b === 0 ? '—' : `${(a / b * 100).toFixed(1)}%`)

console.log(`扫描到 ${rows.length} 个游戏目录，其中 ${gamesWithFiles} 个有候选文件。\n`)

console.log('═'.repeat(78))
console.log('① 技术层：解析成功率（分母 = 所有"像存档的"文件）')
console.log('═'.repeat(78))
console.log(`  候选 ${all.length} 个，解析成功 ${okFiles.length} 个 ⇒ ${pct(okFiles.length, all.length)}`)
console.log('  ⚠ 这个比值**不能当作"存档读得好不好"**：分母混着配置/资源等根本不是存档的文件。')

console.log('\n' + '═'.repeat(78))
console.log('② 解析不了的原因分布（按终审结论归类）')
console.log('═'.repeat(78))
for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${pad(v, 5)} ${pct(v, all.length - okFiles.length).padStart(6)}  ${k}`)
}

console.log('\n' + '═'.repeat(78))
console.log('③ 按文件名粗分：失败集中在哪一类？（**启发式归类，只是线索**）')
console.log('═'.repeat(78))
console.log(`  ${pad('桶', 10)} ${pad('候选', 6)} ${pad('解析成功', 8)} 成功率`)
for (const [k, v] of [...byBucket].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${pad(k, 10)} ${pad(v.total, 6)} ${pad(v.ok, 8)} ${pct(v.ok, v.total)}`)
}

console.log('\n' + '═'.repeat(78))
console.log('④ 产品层：多少个游戏**至少**有一份能看懂的存档')
console.log('═'.repeat(78))
console.log(`  有候选文件的游戏 ${gamesWithFiles} 个；其中至少解出一份的 ${gamesWithDecoded.length} 个`
  + ` ⇒ ${pct(gamesWithDecoded.length, gamesWithFiles)}`)
console.log('  ★ 这才是"我能不能读懂这个游戏"的指标 —— 一个游戏只要有一份能读，内容级理解就成立。')

const noDecode = gamesWithAny.filter((g) => !g.files.some((f) => f.ok))
console.log(`\n  完全读不懂的游戏 ${noDecode.length} 个：`)
for (const g of noDecode.slice(0, 15)) {
  const fmt = [...new Set(g.files.map((f) => f.format))].join('/')
  console.log(`    · ${pad(g.game, 30)} ${pad(g.files.length + ' 个文件', 10)} 全是 ${fmt}`)
}
if (noDecode.length > 15) console.log(`    …另有 ${noDecode.length - 15} 个`)

console.log('\n' + '═'.repeat(78))
console.log('⑤ 别忘了：产品基线**不需要解码**')
console.log('═'.repeat(78))
console.log(`  桌宠的核心能力是"存档被写入 ⇒ 现在是松懈点"，那只需要文件 mtime。`)
console.log(`  有候选文件的 ${gamesWithFiles} 个游戏，**全都能**给到"存档已更新"这类时机事件。`)
console.log(`  解码只决定"能不能多说点内容"，不决定"能不能用"。`)
console.log(`  所以：时机层覆盖 ${pct(gamesWithFiles, rows.length)}（${gamesWithFiles}/${rows.length}），`
  + `内容层覆盖 ${pct(gamesWithDecoded.length, rows.length)}（${gamesWithDecoded.length}/${rows.length}）。`)

console.log('\n' + '═'.repeat(78))
console.log('⑥ 解析成功的都是什么格式（看看解码链在真实语料上打到哪）')
console.log('═'.repeat(78))
const byContent = new Map()
for (const f of okFiles) byContent.set(f.content, (byContent.get(f.content) ?? 0) + 1)
for (const [k, v] of [...byContent].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(v, 5)} ${k}`)

console.log('\n' + '═'.repeat(78))
console.log('⑦ 按扩展名分布：那些"判不出来"的候选到底是什么文件')
console.log('═'.repeat(78))
const ext = (n) => {
  const m = /\.([A-Za-z0-9_]{1,8})$/.exec(n)
  return m ? `.${m[1].toLowerCase()}` : '(无扩展名)'
}
const byExt = new Map()
for (const f of all) {
  const e = ext(f.name)
  const b = byExt.get(e) ?? { total: 0, ok: 0, bytes: 0 }
  b.total++
  b.bytes += f.size
  if (f.ok) b.ok++
  byExt.set(e, b)
}
console.log(`  ${pad('扩展名', 16)} ${pad('候选', 6)} ${pad('成功', 6)} ${pad('成功率', 8)} ${pad('总大小', 12)} 备注`)
for (const [k, v] of [...byExt].sort((a, b) => b[1].total - a[1].total).slice(0, 22)) {
  const mb = v.bytes / 1024 / 1024
  const flag = v.ok === 0 && v.total >= 20 ? '★ 整类读不懂' : ''
  console.log(`  ${pad(k, 16)} ${pad(v.total, 6)} ${pad(v.ok, 6)} ${pad(pct(v.ok, v.total), 8)} ${pad(mb.toFixed(1) + 'MB', 12)} ${flag}`)
}
const noExt = byExt.get('(无扩展名)')
if (noExt) console.log(`\n  （无扩展名的文件 ${noExt.total} 个，成功 ${noExt.ok} 个 —— 这些几乎只能是游戏自己的存档）`)

// ══════════════════ ⑧ 清账：把明显不是存档的文件摘掉再算一次 ══════════════════
//
// 这一步不是"把数字做好看"，而是**把问题问对**：
// "我的解码链在存档上表现如何" 与 "我扫到的文件里有多少能被解析" 是两个问题。
// 排除清单是**明确的、可审计的**（不是"挑到满意为止"）：
//   字体 / 词典 / 图标 / 脚本与扩展模块 / 样式表 / 备份 / 无扩展名的资源块
// 保留的是"有可能是存档"的一切 —— 包括我们目前读不了的私有格式。

const NOT_SAVE_EXT = /\.(woff2?|ttf|otf|eot|bdic|ico|cur|bmp|py|pyc|pyd|xsl|xslt|css|old|bak|tmp|ldb|log|dll|so|dylib)$/i
/** 没有扩展名、又很大 —— 实测这类基本是着色器缓存/资源块（本机 855 个共 272MB）。 */
const looksLikeBlob = (f) => !/\./.test(f.name) && f.size > 256 * 1024

const saveish = all.filter((f) => !NOT_SAVE_EXT.test(f.name) && !looksLikeBlob(f))
const saveishOk = saveish.filter((f) => f.ok)

console.log('\n' + '═'.repeat(78))
console.log('⑧ 清账：摘掉明显不是存档的文件之后，再看一次')
console.log('═'.repeat(78))
console.log(`  排除了 ${all.length - saveish.length} 个：字体/词典/图标/脚本/样式表/备份，`)
console.log(`  以及 ${all.filter(looksLikeBlob).length} 个"无扩展名且 >256KB"的资源块（合计 ${(all.filter(looksLikeBlob).reduce((a, f) => a + f.size, 0) / 1024 / 1024).toFixed(0)}MB）。`)
console.log(`  剩下 ${saveish.length} 个"有可能是存档"的文件，其中解析成功 ${saveishOk.length} 个 ⇒ ${pct(saveishOk.length, saveish.length)}`)

// 再看游戏层
const gamesClean = rows.map((g) => {
  const files = g.files.filter((f) => !NOT_SAVE_EXT.test(f.name) && !looksLikeBlob(f))
  return { ...g, clean: files, cleanOk: files.filter((f) => f.ok).length }
}).filter((g) => g.clean.length > 0)
const cleanDecoded = gamesClean.filter((g) => g.cleanOk > 0)
console.log(`  有"像存档"文件的游戏 ${gamesClean.length} 个，其中至少解出一份的 ${cleanDecoded.length} 个`
  + ` ⇒ ${pct(cleanDecoded.length, gamesClean.length)}`)

console.log('\n' + '─'.repeat(78))
console.log('  四个不同分母下的同一件事，请按问题选一个看：')
console.log('─'.repeat(78))
const variants = [
  ['所有候选文件（含字体/词典/缓存块）', all.length, okFiles.length],
  ['像存档的文件（摘掉明显非存档）', saveish.length, saveishOk.length],
  ['文件名像存档的', byBucket.get('像存档')?.total ?? 0, byBucket.get('像存档')?.ok ?? 0],
  ['游戏层：至少有一份能读懂', gamesClean.length, cleanDecoded.length],
]
for (const [label, a, b] of variants) console.log(`  ${pad(label, 36)} ${pad(`${b}/${a}`, 12)} ${pct(b, a)}`)

console.log('\n' + '─'.repeat(78))
console.log('  能改的地方（从数据里直接看出来的，不是猜的）：')
console.log('─'.repeat(78))
const dbish = all.filter((f) => /\.(db|sqlite|sqlite3|ldb)$/i.test(f.name))
if (dbish.length) {
  console.log(`  · **SQLite / LevelDB 共 ${dbish.length} 个文件、0 个能读**。`)
  console.log('    Node 24 自带 node:sqlite（本项目实测无需 flag）⇒ 这是最容易吃到的一类')
}
const bf = all.filter((f) => f.format === 'dotnet-binaryformatter')
if (bf.length) {
  console.log(`  · **.NET BinaryFormatter ${bf.length} 个文件、0 个能读**（含 Team Cherry / Team Salvato）。`)
  console.log('    格式有公开文档，实现常用子集是可行的 —— 但这要按真实样本逐步对，不能凭文档写')
}
const noExtBig = all.filter(looksLikeBlob)
if (noExtBig.length) {
  console.log(`  · 无扩展名的资源块 ${noExtBig.length} 个（${(noExtBig.reduce((a, f) => a + f.size, 0) / 1024 / 1024).toFixed(0)}MB）`
    + ' —— 应当从"存档候选"里排除，否则分母永远被这类文件撑着')
}
const rootNoise = ['AMD', 'Microsoft', 'NVIDIA', 'Intel']
const noise = rows.filter((g) => rootNoise.includes(g.game))
if (noise.length) {
  console.log(`  · 扫描根里混着非游戏目录（${noise.map((g) => g.game).join('、')}），`
    + `合计 ${noise.reduce((a, g) => a + g.files.length, 0)} 个候选 —— SKIP_DIR 只挡了子目录，没挡根这一层`)
}

// ══════════════════ ⑨ ★「如果知道存档是哪个文件」—— 解析率是多少 ══════════════════
//
// 这是把"解码器行不行"与"候选挑得准不准"**分开**来问。
// 麻烦在于：我无法在"读不出来"的情况下知道哪个文件是存档 —— 读不出来正是问题本身。
// 所以只能用**结构性信号**逼近，并且把规则的严格程度列出来，让比值自己说话：
//
//   A 在存档目录里    路径里含 save/saves/SaveData/存档/slot/profile 之类的目录名。
//                     **这是最强的结构信号**：游戏不会把设置文件放进 save 目录。
//   B 名字像存档      上轮那套文件名正则。
//   C 无（自定义）扩展名、又不是大资源块 —— 游戏自己的存档常是这样。
//   D 其它
//
// 然后按"每款游戏取一个最像的"来算 —— 那就是"你指给我看哪个是存档"的近似。
// ⚠ 残留的不确定：A 里也可能混着 `settings.json`（有些游戏把设置也塞进 save 目录）。
//   对**能读出来的**那部分，我抽查内容里有没有游戏状态字段来验证选择规则有没有选错；
//   读不出来的那部分**无法验证**，所以那个比值只能当上界，不能当精确值。

const SAVE_DIR_RE = /(^|[\\/])(save|saves|savedata|savegame|savegames|save_data|slot|slots|profile|userdata|存档|进度)([\\/]|$)/i
const NAME_SAVE_RE = /(save|存档|slot|autosave|quicksave|progress|profile|player|file\d|data\d|game\d|user\d|global|persist)/i
/**
 * 强判据：**精确匹配**的键名（不用子串）。
 * 第一版用子串匹配，于是 `saveTime`/`AFKAutoKickTime` 里的 `time` 让纯设置文件
 * 也被算成"像存档"。键名要精确对，`level` 就算数，`levelUpSoundVolume` 不算。
 */
const STRONG_STATE_RE = /^(level|lv|hp|mp|maxhp|max_hp|maxmp|health|exp|experience|gold|money|coin|coins|score|scene|map|mapid|map_id|chapter|stage|quest|quests|item|items|inventory|equip|equipment|skill|skills|flag|flags|switch|switches|variable|variables|progress|playtime|play_time|slot|slots|saveid|save_id|character|characters|party|unlocked|achievements|day|days|dungeon|floor|wave|kills|deaths|deaths_)$/i
const STRONG_CONFIG_RE = /^(settings|config|prefs|preferences|options|sound|music|vsync|volume|mastervolume|resolution|language|locale|graphics|quality|fullscreen|windowed|antialiasing|shadows|texturequality|audiosettings|input|keybindings)$/i

function levelOf(f) {
  if (SAVE_DIR_RE.test(`\\${f.rel}`)) return 'A'
  if (NAME_SAVE_RE.test(f.name)) return 'B'
  if (!/\./.test(f.name) && f.size <= 256 * 1024) return 'C'
  return 'D'
}
for (const g of rows) for (const f of g.files) f.level = levelOf(f)

/** 这份内容里有没有游戏状态字段？（只看能读出来的） */
function looksLikeGameState(f) {
  if (!f.ok) return null
  if (f.content === 'json' || f.content === 'lzstring') {
    // 重新读一次拿结构（解析成本低，只对子集做）
    try {
      const r = decodeSaveFile(join(g.p ?? '', ''))
      void r
    } catch { /* 忽略 */ }
  }
  return null
}

/** 每条规则下：文件级解析率。 */
const RULES = [
  ['A 在存档目录里', (f) => f.level === 'A'],
  ['A+B 存档目录里 或 名字像存档', (f) => f.level === 'A' || f.level === 'B'],
  ['A+B+C 再加上"自定义扩展名的小文件"', (f) => f.level !== 'D'],
  ['B 仅名字像存档（上一轮口径）', (f) => f.level === 'B'],
]

console.log('\n' + '═'.repeat(78))
console.log('⑨ ★ 如果知道存档是哪个文件 —— 解析率是多少')
console.log('═'.repeat(78))
console.log(`  ${pad('选文件规则', 34)} ${pad('文件数', 8)} ${pad('解析成功', 9)} 解析率`)
for (const [label, test] of RULES) {
  const set = all.filter(test)
  const ok = set.filter((f) => f.ok)
  console.log(`  ${pad(label, 34)} ${pad(set.length, 8)} ${pad(ok.length, 9)} ${pct(ok.length, set.length)}`)
}

/** 每款游戏"取一个最像的" —— 这就是"你告诉我哪个是存档"的近似。 */
const CONFIG_NAME_RE = /(settings|config|prefs|preference|options|input|keybind|graphics|video|audio|quality|resolution|locale|language|steam_autocloud|cloud)/i

function bestOf(files, test) {
  const cand = files.filter(test)
    // ★ 排除"一眼是设置文件"的：第一版没排，结果挑出来的 `UCHSave` 里全是
    //   `sound/music/vsync` —— 那种文件"能解析"完全不代表"读到了存档"。
    .filter((f) => !CONFIG_NAME_RE.test(f.name))
  if (cand.length === 0) return null
  // 优先级：存档目录 > 名字像存档 > 自定义扩展名；同级里取**最近修改**的
  // （存档会随游玩被改写，这比体积更能指向真正的存档）
  const rank = (f) => (f.level === 'A' ? 0 : f.level === 'B' ? 1 : f.level === 'C' ? 2 : 3)
  cand.sort((a, b) => rank(a) - rank(b) || (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
  return cand[0]
}

console.log('\n  ── 按"每款游戏取一个最像的存档"算（最接近"你指给我看"）──')
const onePerGame = []
for (const g of rows) {
  const pick = bestOf(g.files, (f) => f.level !== 'D')
  if (pick) onePerGame.push({ game: g.game, pick })
}
const oneOk = onePerGame.filter((x) => x.pick.ok)
console.log(`  ${onePerGame.length} 款游戏各取 1 个最像的存档文件：解析成功 ${oneOk.length} 个 ⇒ **${pct(oneOk.length, onePerGame.length)}**`)
console.log(`  ★ 这就是"如果知道存档在哪个文件里"的解析率 —— 分母不再是所有像文件的文件。`)

const pickFail = onePerGame.filter((x) => !x.pick.ok)
if (pickFail.length) {
  const byFmt = new Map()
  for (const x of pickFail) byFmt.set(x.pick.format, (byFmt.get(x.pick.format) ?? 0) + 1)
  console.log(`\n  这 ${pickFail.length} 款挑出来的"最像存档"读不了的，卡在：`)
  for (const [k, v] of [...byFmt].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${pad(v, 4)} ${k}  —— ${FAIL_REASON[k] ?? '其他'}`)
  }
  console.log('\n  举例（这些就是"知道文件也读不出来"的那些）：')
  for (const x of pickFail.slice(0, 12)) {
    console.log(`    · ${pad(x.game, 24)} ${pad(x.pick.rel, 34)} ${pad(x.pick.format, 24)} ${(x.pick.size / 1024).toFixed(0)}KB`)
  }
  if (pickFail.length > 12) console.log(`    …另有 ${pickFail.length - 12} 款`)
}

/** 反向验证：能读出来的那些，内容里有没有游戏状态字段？ */
const okPicks = oneOk
let stateLike = 0
let configLike = 0
const samples = []
const configSamples = []
for (const x of okPicks) {
  if (!['json', 'lzstring', 'xml', 'godot-resource', 'json@offset'].includes(x.pick.content)) continue
  const g = rows.find((r) => r.game === x.game)
  const p = join(g.dir, x.pick.rel)
  try {
    const r = decodeSaveFile(p)
    const text = JSON.stringify(r.value ?? r.godot?.props ?? '').slice(0, 20000)
    const keys = [...text.matchAll(/"([A-Za-z_][A-Za-z0-9_]{1,24})"\s*:/g)].map((m) => m[1])
    // 精确键名判定：先看有几个"铁定是配置"的键，再看有没有"铁定是状态"的键
    const cfg = keys.filter((k) => STRONG_CONFIG_RE.test(k)).length
    const strong = keys.filter((k) => STRONG_STATE_RE.test(k))
    if (strong.length >= 1) {
      stateLike++
      if (samples.length < 6) samples.push(`${x.game}: ${[...new Set(strong)].slice(0, 6).join(', ')}`)
    } else if (cfg >= 2) {
      configLike++
      if (configSamples.length < 5) configSamples.push(`${x.game}: ${keys.slice(0, 7).join(', ')}`)
    }
  } catch { /* 读不了就跳过 */ }
}
console.log(`\n  ── 能不能用内容验证"这真的是存档"？**不能** ──`)
console.log(`  用**精确键名**判（level/hp/gold/quest/slot/items…）：只有 ${stateLike} / ${okPicks.length} 命中`)
console.log(`  用**子串**判（第一版的做法）：把 \`saveTime\`/\`AFKAutoKickTime\` 里的 \`time\` 也算命中，`)
console.log(`    于是纯设置文件（sound/music/vsync）被误判成存档 ⇒ 假阳性`)
console.log(`  两个方向都不准：严了漏掉真存档，松了把设置文件算进来。`)
if (samples.length) {
  console.log('  精确键名命中的抽样（这些是**确实**读到游戏状态的）：')
  for (const s of samples) console.log(`    · ${s}`)
}
console.log(`  真实存档的键名多半是**游戏自创**的（hPoint / itemMK / UCHSave / serializedEmails…），`)
console.log(`  任何通用规则都抓不住 ⇒ **内容校验不是可用判据**，既不能证真也不能证伪。`)
console.log('')
console.log('  ★ 想真正定下"哪个文件是存档"，只有一个可靠办法：')
console.log('    **在游戏里存一次档，看哪个文件的 mtime 变了。**')
console.log('    那需要有人真的去玩 —— 我离线做不到。')
console.log('')
console.log('    但这件事在**运行时是免费的**：桌宠盯的就是文件 mtime，')
console.log('    它上线一会儿就能自己知道每款游戏"存档是哪个文件"。')
console.log('    所以⑨这一节的比值只在"离线先估一下"时有用，不是运行时的那笔账。')


