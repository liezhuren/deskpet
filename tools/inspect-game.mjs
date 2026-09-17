// tools/inspect-game.mjs —— 对一个（或本机全部）游戏目录跑完整链路并打印报告
//
// 存在意义：这是 ARCHITECTURE M9 那条「不能跳」的链路的**可复现证据**。
// 各层都有自己的测试，但"各层都绿"不等于链路通 —— 这个工具跑的是：
//   identify → findSaves/findLogs → decode → normalize → diff → events → presence 决策
//
// 用法：
//   node tools/inspect-game.mjs --list                  列出本机可识别的游戏
//   node tools/inspect-game.mjs <目录>                   对某目录做一次探测报告
//   node tools/inspect-game.mjs <目录> --patterns        列出日志里"认不出来"的行（写规则的依据）
//   node tools/inspect-game.mjs <目录> --store S.json    带持久化状态：第二次运行才会 diff 出事件
//   node tools/inspect-game.mjs --list --json
//
// 路径全部经环境变量推导，不写死绝对路径（上个项目踩过硬编码路径的坑）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { discoverGames, identify } from '../gameio/index.mjs'
import { observe, createStore, suggestPatterns } from '../gameio/observe.mjs'
import { resolvePolicy, initPresence, step, summarize } from '../core/presence.mjs'
import { summarize as summarizeEvents } from '../core/events.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const AS_JSON = has('--json')
const STORE = argOf('--store', null)
const dirArg = argv.find((a) => !a.startsWith('--') && a !== STORE)

// ---------- 子命令：列出本机游戏 ----------

if (has('--list') || !dirArg) {
  const games = discoverGames({ limit: 400 })
  if (AS_JSON) {
    console.log(JSON.stringify(games, null, 2))
  } else {
    const pad = (s, n) => {
      const w = [...String(s)].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0)
      return String(s) + ' '.repeat(Math.max(0, n - w))
    }
    console.log(`${games.length} 个可识别的游戏目录（按置信度排序）\n`)
    console.log(pad('引擎', 12) + pad('置信度', 9) + pad('存档', 6) + '目录')
    console.log('-'.repeat(100))
    for (const g of games) {
      const short = g.dir.replace(/^.*AppData[\\/](LocalLow|Roaming)[\\/]/, '')
      console.log(pad(g.engine, 12) + pad(g.score.toFixed(2), 9) + pad(g.saves, 6) + short)
    }
    const by = {}
    for (const g of games) by[g.engine] = (by[g.engine] ?? 0) + 1
    console.log('\n按引擎：' + Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · '))
    if (STORE) console.log(`\n提示：加 --store <文件> 可以把监视状态持久化，第二次运行就能看到事件 diff`)
  }
  process.exit(0)
}

// ---------- 子命令：对单个目录做报告 ----------

if (!existsSync(dirArg)) {
  console.error(`目录不存在：${dirArg}`)
  process.exit(2)
}

if (has('--patterns')) {
  const r = suggestPatterns(dirArg)
  if (AS_JSON) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }
  console.log(`引擎：${r.engine ?? '（识别不出）'}`)
  console.log(`\n日志里"认不出来"的行（按出现次数降序，共 ${r.lines.length} 条）—— 这些就是可以配规则的候选：\n`)
  for (const l of r.lines.slice(0, 30)) console.log(`  ${String(l.count).padStart(6)} 次  ${l.line.slice(0, 110)}`)
  console.log('\n示例：把某一行配成规则后，它就会变成事件（见 gameio/base.mjs 的 patterns 用法）')
  process.exit(0)
}

const store = STORE && existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : createStore()
const r = observe(dirArg, { store, now: Date.now() })

if (AS_JSON) {
  console.log(JSON.stringify({ ...r, store: STORE ? undefined : r.store }, null, 2))
} else {
  const found = identify(dirArg)
  console.log(`目录：${dirArg}`)
  console.log(`引擎：${r.engine ?? '（识别不出 —— 退化为纯文件监视，仍然可用）'}   置信度 ${r.score.toFixed(2)}`)
  for (const e of r.evidence) console.log(`  · ${e}`)
  if (found.candidates.length > 1) {
    console.log('  其它候选：' + found.candidates.slice(1).map((c) => `${c.id}(${c.score.toFixed(2)})`).join('、'))
  }

  if (r.session) {
    const s = r.session
    console.log(`\n会话：版本 ${s.version ?? '?'} · cleanExit ${s.cleanExit === null ? '不确定' : s.cleanExit}` +
      (s.playerName ? ` · 玩家 ${s.playerName}` : ''))
    for (const n of s.notes ?? []) console.log(`  · ${n}`)
  }

  console.log(`\n存档：找到 ${r.savesSeen} 个，本次解出 ${r.savesDecoded} 个`)
  console.log(`日志：本次新增事件类型 ${r.logKinds.length ? r.logKinds.join('、') : '（无）'}`)

  const cap = r.capability
  const pol = resolvePolicy({ level: 'moderate', capability: cap })
  console.log(`\n可读能力（runtime 判定）：${cap.readable.join('、')}`)
  for (const why of cap.reasons) console.log(`  · ${why}`)
  console.log(`判定档位：请求 moderate ⇒ 生效 ${pol.level}${pol.capped ? '（被封顶）' : ''}`)
  if (pol.capped) console.log(`  原因：${pol.why}`)
  console.log(`阈值：静默 ${pol.thresholds.settleMs / 1000}s · 全局冷却 ${pol.thresholds.globalCooldownMs / 60000}min · 每小时预算 ${pol.thresholds.budgetPerHour} · 空闲门槛 ${pol.thresholds.relaxedIdleSec}s`)

  if (r.baselineOnly) {
    console.log('\n★ 本次是首次观测：只建立基线，不产事件（否则会对一个刚认识的游戏开口）')
  } else {
    console.log(`\n事件 ${r.events.length} 条：`)
    for (const e of r.events) console.log(`  [${e.kind}] ${e.text}  (重要度 ${e.importance.toFixed(2)})`)
    const sum = summarizeEvents(r.events)
    if (sum.byKind && Object.keys(sum.byKind).length) {
      console.log('  按类别：' + Object.entries(sum.byKind).map(([k, v]) => `${k} ${v}`).join('、'))
    }

    // 真正把事件喂进时机引擎，看它决定说什么
    const st0 = initPresence()
    let st = st0
    for (const tr of r.triggers) st = step(st, tr, pol).state
    const out = step(st, { type: 'tick', at: r.now + 1000, idleSec: 30, gameRunning: true }, pol)
    console.log(`\n时机引擎：${out.speak ? `开口 —— ${out.speak.summaries.join(' / ')}` : '不说话'}`)
    for (const n of out.notes) console.log(`  · ${n}`)
    const m = summarize(out.state, { policy: pol })
    console.log(`  指标：触发 ${m.triggers} · 开口 ${m.spoke} · 合并 ${m.merged} · 延迟 ${Math.round(m.triggerLatencyMs / 1000)}s · 专注期发言 ${m.silenceDuringPlay}`)
  }

  if (r.notes.length) {
    console.log('\n说明：')
    for (const n of r.notes) console.log(`  · ${n}`)
  }
}

if (STORE) {
  writeFileSync(STORE, JSON.stringify(r.store, null, 1), 'utf8')
  console.log(`\n（监视状态已写入 ${basename(STORE)} —— 下次再运行就会拿它做 diff）`)
}
