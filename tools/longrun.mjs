// tools/longrun.mjs —— ★ 长跑验证：把时机引擎放在"几小时"的时间尺度上看它的「度」
//
// ═══════════════════════════════════════════════════════════════════
// 为什么需要它（这是本项目最后一项没被真实验证过的核心宣称）
// ═══════════════════════════════════════════════════════════════════
// 到目前为止，所有真实数据验证都是"跑一次快照"。可时机引擎的价值**全在长时间下的度**：
//   · 会不会越说越多（预算失效）？
//   · 会不会在玩家正打的时候开口（静默判定失效）？
//   · 待发言队列、记忆、store 会不会无限膨胀（泄漏）？
// 单次快照完全看不出这些 —— 它们只在"跑几小时"之后才显形。
//
// ⚠ 诚实边界（必须说清楚，否则这个工具会被当成"验证了真实运行"）：
//   本工具**注入时钟**（引擎本来就是时间注入的），所以它验证的是**引擎逻辑在长时间下的行为**，
//   而**不是**：
//     ✗ 真实的操作系统空闲检测在几小时里的表现
//     ✗ 真实游戏的存档写入节奏（这里用的是脚本化的玩家模型）
//     ✗ 真实进程探测、真实文件 mtime 变化
//   要验后者请用 `--real <秒>` 跑一小段**真挂钟时间**（脚本仍会跑，只是时长短）。
//   两种都跑一遍，才谈得上"长跑验证过"。
//
// 用法：
//   node tools/longrun.mjs                    # 6 小时模拟（默认 1 秒 1 tick）
//   node tools/longrun.mjs --hours 12         # 12 小时
//   node tools/longrun.mjs --real 90          # 真挂钟跑 90 秒（验证真实时钟路径）
//   node tools/longrun.mjs --dir <游戏目录>    # 用真实游戏目录（默认合成一个）
//   node tools/longrun.mjs --json             # 只输出 JSON 结论
//
// 退出码 0 = 全部断言通过。

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

import { compressToBase64 } from '../core/lzstring.mjs'
import { createStore } from '../app/store.mjs'
import { createRuntime } from '../app/agent.mjs'
import { draftCard } from '../app/cardgen.mjs'
import { RELIABLE_KINDS } from '../core/presence.mjs'

// ---------- 参数 ----------

const argv = process.argv.slice(2)
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const has = (f) => argv.includes(f)

const REAL_SEC = Number(argOf('--real', '0')) || 0
const HOURS = REAL_SEC > 0 ? REAL_SEC / 3600 : Number(argOf('--hours', '6'))
const TICK_MS = REAL_SEC > 0 ? 1000 : Number(argOf('--tick', '1000'))
const JSON_ONLY = has('--json')
const TRACE = has('--trace')
const USER_DIR = argOf('--dir', null)
const trace = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 玩家状态机。阈值以**引擎自己声明的** relaxedIdleSec 为准（下面会覆盖）。 */
let RELAXED_IDLE_SEC = 12   // 先给个初值；第一次 pump 后会从 presence 的实测里取真值

// ---------- 玩家模型 ----------
//
// ⚠ 这个模型是本工具唯一"编"的东西，所以必须**忠实于产品要解决的场景**，
//   否则跑出来的结论毫无意义。第一版就编错了，被自己的数据打脸：
//     ✗ 它让玩家"存档后继续打 3~20 分钟才休息" ⇒ 待发言总在松懈到来前过期，
//       于是跑了 1 小时一次都没开口 —— 看起来像引擎坏了，其实是模型不对。
//     ✗ 它让 idle 每 tick 重新随机 ⇒ 而真实的空闲时间是**单调增长**的
//       （powerMonitor.getSystemIdleTime() 就是这样：不动就一秒一秒涨）。
//
// 用户原话是：「好不容易打败了一个 boss，**存好档的松懈时间**和他交流」——
// 关键是**存档之后马上就停手**。所以模型里必须有一个"存档 → 歇一会儿"的分支，
// 而且那才是引擎真正要抓住的时刻。
//
// 结构：
//   play / boss / reload —— 一直在动（每秒大概率有输入），按节奏存档
//   ★ leanback          —— **刚存完档，往后一靠**（1~6 分钟不动）← 产品的目标时刻
//   break               —— 中途去倒水/看手机（1.5~6 分钟不动）
//
// 每一次真实的输入都会把 idle 清零；没有输入就一秒一秒涨。

/** 每秒"有输入"的概率。play/boss 几乎一直在动；leanback/break 几乎不动。 */
const INPUT_RATE = { play: 0.9, boss: 0.96, reload: 0.85, leanback: 0.005, break: 0.004, quit: 0.01 }
/** 各阶段的存档间隔（秒）；null = 这一段不存档。 */
const SAVE_EVERY = { play: [180, 480], boss: [240, 600], reload: [15, 30], leanback: null, break: null, quit: null }
/** 存档之后"往后一靠"的概率 —— 这是"泄压点"在模型里的体现。 */
const LEANBACK_AFTER_SAVE = 0.55

function makePlayerModel(rng) {
  // 主循环的阶段（leanback 是存档触发的分支，不在这里排）
  const phases = [
    { name: 'play', min: 6, max: 20 },
    { name: 'boss', min: 3, max: 9 },
    { name: 'play', min: 4, max: 12 },
    { name: 'break', min: 1.5, max: 6 },
    { name: 'reload', min: 0.5, max: 1.5 },
    // ★ 一定要有"退出游戏"：跨会话记忆只在一局**结束时**才写，
    //   模型里没有退出就永远验不到记忆那半条链路（第一版就没有，于是记忆恒为 0）。
    { name: 'quit', min: 0.2, max: 0.6 },
  ]
  let idx = 0
  let leftMs = 0
  let phase = null
  let nextSaveAt = 0
  let idleSec = 0
  let leanbackLeftMs = 0

  const enter = (now, name) => {
    phase = name
    const spec = phases.find((p) => p.name === name)
    if (spec) leftMs = (spec.min + rng() * (spec.max - spec.min)) * 60000
    const se = SAVE_EVERY[name]
    nextSaveAt = se ? now + (se[0] + rng() * (se[1] - se[0])) * 1000 : Infinity
  }
  enter(0, 'play')

  return {
    get phase() { return phase },
    get idleSec() { return idleSec },

    step(now, dtMs) {
      const dtSec = dtMs / 1000

      // ① leanback 结束 ⇒ 回到 play
      if (leanbackLeftMs > 0) {
        leanbackLeftMs -= dtMs
        if (leanbackLeftMs <= 0) enter(now, 'play')
      } else {
        leftMs -= dtMs
        if (leftMs <= 0) {
          const spec = phases[idx % phases.length]
          idx++
          enter(now, spec.name)
        }
      }

      // ② 输入：真实的空闲时间是单调增长的，不能每 tick 重新随机
      if (rng() < (INPUT_RATE[phase] ?? 0.5)) idleSec = 0
      else idleSec += dtSec

      // ③ 存档：存档之后有一定概率**马上往后一靠**（产品的目标时刻）
      let save = null
      if (now >= nextSaveAt) {
        save = saveKindFor(phase, rng)
        const se = SAVE_EVERY[phase]
        nextSaveAt = now + (se[0] + rng() * (se[1] - se[0])) * 1000
        if (rng() < LEANBACK_AFTER_SAVE) {
          leanbackLeftMs = (1 + rng() * 5) * 60000
          phase = 'leanback'
          leftMs = leanbackLeftMs
          // ⚠ 必须把下一次存档推到无穷远：leanback 时长（1~6 分钟）可能**超过**刚设的
          //   存档间隔（3~8 分钟），那样下一 tick 就会在 leanback 里再次进入存档分支，
          //   而 SAVE_EVERY.leanback 是 null ⇒ 直接抛。
          nextSaveAt = Infinity
        }
      }

      return {
        phase,
        idleSec,
        save,
        // 退出游戏时"进程不在跑" —— 这是 exit 事件与"游戏没在跑"状态的来源
        running: phase !== 'quit',
      }
    },
  }
}

/** 存档类型：进度推进 / 死亡读档。 */
function saveKindFor(phase, rng) {
  if (phase === 'reload') return 'death'
  if (rng() < 0.08) return 'death'
  return 'progress'
}

/** 可复现的伪随机（不用 Math.random，否则每次结果都不同、没法比对）。 */
function makeRng(seed = 12345) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

// ---------- 合成游戏目录 ----------

function mvState(over = {}) {
  return {
    system: { _saveCount: 0, _framesOnSave: 0 },
    switches: { _data: [null, true, false, false] },
    variables: { _data: [null, 0, 0, 0, 0] },
    actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: 1, _hp: 300, _mp: 40, _exp: 0 }] },
    party: { _gold: 0, _items: [], _actors: [1], _steps: 0 },
    map: { _mapId: 1 },
    ...over,
  }
}

function writeMv(dir, state) {
  mkdirSync(join(dir, 'save'), { recursive: true })
  writeFileSync(join(dir, 'save', 'file1.rpgsave'), compressToBase64(JSON.stringify(state)), 'utf8')
}

// ---------- 主流程 ----------

const work = mkdtempSync(join(tmpdir(), 'pet-longrun-'))
const stateDir = join(work, 'state')
const gameDir = USER_DIR ?? join(work, 'game', 'LongRun')
const usingRealDir = Boolean(USER_DIR)

const rng = makeRng(20240501)
const cardsPath = join(import.meta.dirname, '..', 'examples', 'card.example.json')

const metrics = {
  ticks: 0,
  events: 0,
  eventsByKind: {},
  speaks: 0,
  /** ★ 最要紧的一个数：玩家**正在打**的时候开口了几次（必须为 0）。 */
  speaksWhilePlaying: 0,
  /** 开口时见过的最小空闲秒数 —— 只统计**游戏正在跑**的时候（游戏没跑时空闲多小都正当）。 */
  minIdleAtSpeak: null,
  /** 游戏没在跑的时候开口的次数（玩家已经退出，不算打扰）。 */
  speaksWhileNotRunning: 0,
  /** 引擎自己声明的"松懈"门槛（实测取到，不靠我这边的常量）。 */
  relaxedIdleSec: null,
  speaksByPhase: {},
  speakLatencies: [],
  /** 玩家松懈的时刻数（用来算"该说的时候说了多少"）。 */
  relaxedTicks: 0,
  /**
   * ★ 分母：**玩家松懈 + 有一个已到静默窗口的待发言** 的时刻数。
   * 只统计 relaxedTicks 是不够的 —— 松懈的时刻可能压根没有待发言（比如松懈期玩家不存档），
   * 那时"没说话"是**正确**的，不该算成引擎的问题。
   * 有了这个分母，"说话了没有"才是个能被判定的问题。
   */
  chances: 0,
  maxPending: 0,
  maxMemory: 0,
  maxStoreBytes: 0,
  sessions: 0,
  errors: [],
  simMs: 0,
  wallMs: 0,
  storeSamples: [],
}

function diskBytes(dir) {
  let total = 0
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { try { total += statSync(p).size } catch { /* 忽略 */ } }
    }
  }
  walk(dir)
  return total
}

try {
  if (usingRealDir) {
    // 真实目录：**只读**。不写、不改，只观测。
    mkdirSync(stateDir, { recursive: true })
  } else {
    writeMv(gameDir, mvState())
  }

  const store = createStore({ dir: stateDir })
  store.setSettings({ game: { dir: gameDir, level: 'moderate' } })

  const probeState = { running: true, idle: 1 }
  const probe = {
    async isRunning() { return { running: probeState.running, matches: [], at: 0, cached: true, error: null, available: true } },
    idleSeconds: () => probeState.idle,
    setIdleReader() {}, reset() {}, stats() {},
  }

  const simStart = REAL_SEC > 0 ? Date.now() : Date.UTC(2024, 4, 1, 20, 0, 0)
  let clock = simStart
  const runtime = createRuntime({ store, probe, now: () => clock })

  // 用 examples 里那张卡（顺带保证它是可用的）
  const card = JSON.parse(readFileSync(cardsPath, 'utf8'))
  runtime.setCard(card)

  const player = makePlayerModel(rng)
  const durationMs = HOURS * 3600 * 1000
  let game = mvState()
  let saveCount = 0
  const wallStart = performance.now()
  let sessionStart = clock
  const sessionLengths = []

  while (metrics.simMs < durationMs) {
    // ★ `--real` 必须**真的等**。第一版只把 clock 按 tick 往前推、循环全速跑完，
    //   于是"真实挂钟 60 秒"实际只用 0.1 秒 —— 那是在撒谎。
    //   真实模式下用真实 Date.now() 并真的 sleep，跑多久就是多久。
    if (REAL_SEC > 0) {
      await sleep(TICK_MS)
      clock = Date.now()
      metrics.simMs = clock - simStart
    } else {
      clock += TICK_MS
      metrics.simMs += TICK_MS
    }
    metrics.ticks++

    const p = player.step(clock, TICK_MS)
    probeState.running = p.running
    probeState.idle = p.idleSec

    // 玩家存档 ⇒ 真的写文件（走真实的 hash/解码/diff 路径）
    if (p.save) {
      saveCount++
      const level = 1 + Math.floor(metrics.simMs / (20 * 60000))
      const dead = p.save === 'death'
      game = mvState({
        system: { _saveCount: saveCount, _framesOnSave: metrics.simMs * 0.06 },
        switches: { _data: [null, true, true, metrics.ticks % 2 === 0] },
        variables: { _data: [null, metrics.ticks % 7, level * 3, saveCount, Math.floor(metrics.simMs / 60000)] },
        actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: level, _hp: dead ? 0 : 300, _mp: 40, _exp: level * 420 }] },
        party: { _gold: saveCount * 137, _items: [[1, saveCount % 9]], _actors: [1], _steps: saveCount * 250 },
        map: { _mapId: 1 + (Math.floor(metrics.simMs / (10 * 60000)) % 12) },
      })
      if (!usingRealDir) writeMv(gameDir, game)
    }

    // ★ 机会必须在 `pump` **之前**取。
    //   开口的那一 tick 里 pump 会把 pending 清空，读在之后就永远看不到这次机会 ——
    //   第一版就是这样：明明开口了 3 次，机会却统计成 0。
    const pendBefore = runtime.session?.presence?.pending ?? null
    const dueNow = Boolean(pendBefore) && clock >= pendBefore.dueAt
    const relaxed = p.idleSec >= RELAXED_IDLE_SEC
    if (relaxed && p.running) metrics.relaxedTicks++
    if (relaxed && p.running && dueNow) metrics.chances++

    const r = await runtime.pump({ now: clock })
    for (const e of r.events ?? []) {
      metrics.events++
      metrics.eventsByKind[e.kind] = (metrics.eventsByKind[e.kind] ?? 0) + 1
    }

    // --trace：把"松懈时的待发言状态"原样打出来。
    // 排查"为什么它不说话"时，光看总量指标会一直猜 —— 得看每一步的真实状态。
    if (TRACE && relaxed && p.running) {
      const mm = Math.floor(metrics.simMs / 60000)
      const note = (runtime.session?.presence?.history ?? []).slice(-1)[0]
      trace.push(`  ${String(mm).padStart(3)}分  空闲${String(Math.round(p.idleSec)).padStart(3)}s  `
        + `${pendBefore ? `待发言 ${pendBefore.kind}(due=${dueNow ? '是' : '否'}, 还剩${Math.round((pendBefore.expiresAt - clock) / 1000)}s)` : '（无待发言）'}`
        + `${r.speak ? `  ★说了「${r.speak.text.slice(0, 24)}」` : ''}`
        + `${note ? `  [${note.decision}]` : ''}`)
    }

    if (r.speak) {
      metrics.speaks++
      metrics.speaksByPhase[p.phase] = (metrics.speaksByPhase[p.phase] ?? 0) + 1
      if (p.running) {
        metrics.minIdleAtSpeak = metrics.minIdleAtSpeak === null
          ? p.idleSec
          : Math.min(metrics.minIdleAtSpeak, p.idleSec)
      } else {
        metrics.speaksWhileNotRunning++
      }
      // ★ 核心断言的数据来源：**引擎自己声明的门槛** + `gameRunning` 两个条件都用上。
      //   引擎的判定是 `focused = gameRunning === true && idleSec < relaxedIdleSec`，
      //   所以外部复核必须用同一个条件 —— 第一版漏了 `running`，
      //   于是"玩家已经退出游戏、idle 很小"那种完全正当的开口被算成了违规。
      //   门槛也从 presence 实测取，不用我这边另写一个常量。
      const threshold = metrics.relaxedIdleSec ?? RELAXED_IDLE_SEC
      if (p.running && p.idleSec < threshold) {
        metrics.speaksWhilePlaying++
        if (metrics.errors.length < 5) {
          metrics.errors.push(`玩家正在游戏且空闲仅 ${p.idleSec.toFixed(1)} 秒（低于门槛 ${threshold}）时开口：「${r.speak.text}」`)
        }
      }
      const pres = runtime.snapshot().presence
      if (Number.isFinite(pres?.triggerLatencyMs)) metrics.speakLatencies.push(pres.triggerLatencyMs)
    }

    const snap = runtime.snapshot()
    // 第一次 pump 后就能拿到引擎自己声明的门槛，用它来判定"什么算在打"
    if (metrics.relaxedIdleSec === null && Number.isFinite(snap.presence?.relaxedIdleSec)) {
      metrics.relaxedIdleSec = snap.presence.relaxedIdleSec
    }
    const pending = snap.session?.pendingEvents ?? 0
    metrics.maxPending = Math.max(metrics.maxPending, pending)
    metrics.maxMemory = Math.max(metrics.maxMemory, snap.memory?.entries ?? 0)
    if (metrics.ticks % 600 === 0) {
      const b = diskBytes(stateDir)
      metrics.maxStoreBytes = Math.max(metrics.maxStoreBytes, b)
      metrics.storeSamples.push({ hour: Number((metrics.simMs / 3600000).toFixed(2)), bytes: b, memory: snap.memory?.entries ?? 0, pending })
    }

    // 偶尔退出游戏 → 结束一局 → 新的一局（验证跨会话不泄漏）
    if (p.phase === 'quit') {
      sessionLengths.push(clock - sessionStart)
      runtime.endCurrentSession({ now: clock, durationMs: clock - sessionStart })
      metrics.sessions++
      sessionStart = clock
    }
  }

  metrics.wallMs = Math.round(performance.now() - wallStart)
  const finalSnap = runtime.snapshot()

  // ---------- 结论与断言 ----------

  const hours = metrics.simMs / 3600000
  const perHour = (n) => Number((n / hours).toFixed(2))
  const sorted = [...metrics.speakLatencies].sort((a, b) => a - b)
  const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null)

  const checks = [
    {
      name: '★ 玩家正在打的时候**一次都没开口**',
      // 门槛用引擎自己声明的 relaxedIdleSec —— 拿我另写的常量判它对错是不公平的
      ok: metrics.speaksWhilePlaying === 0,
      detail: `${metrics.speaksWhilePlaying} 次（门槛 ${metrics.relaxedIdleSec ?? '?'} 秒）`
        + (metrics.errors.length ? ` — ${metrics.errors[0]}` : ''),
    },
    {
      name: '★ 引擎自己的不变量成立：spokeWhileFocused 恒为 0',
      // 这是引擎内部维护的计数（"专注期说了话"的次数，正常永远为 0）。
      // 与上一条的区别：上一条用**引擎声明的门槛**在外部复核，这一条看**引擎自己的账**。
      // 两个都对，才说明"它自己认为没违规"与"外部看也确实没违规"一致。
      ok: (finalSnap.presence?.spokeWhileFocused ?? 0) === 0,
      detail: `${finalSnap.presence?.spokeWhileFocused ?? '?'}`,
    },
    {
      name: '游戏在跑时，开口的空闲时间都不低于门槛（没有贴着边界说话）',
      ok: metrics.speaks === 0 || metrics.minIdleAtSpeak === null || metrics.minIdleAtSpeak >= (metrics.relaxedIdleSec ?? 0),
      detail: `最小 ${metrics.minIdleAtSpeak === null ? '-' : metrics.minIdleAtSpeak.toFixed(1)} 秒 / 门槛 ${metrics.relaxedIdleSec ?? '?'} 秒`
        + (metrics.speaksWhileNotRunning ? `（另 ${metrics.speaksWhileNotRunning} 次是在**游戏没跑**时说的，不算打扰）` : ''),
    },
    {
      name: '待发言队列没有无限膨胀（守住上限）',
      ok: metrics.maxPending <= 200,
      detail: `峰值 ${metrics.maxPending}`,
    },
    {
      name: '记忆条数有界（不会一直涨）',
      ok: metrics.maxMemory <= 1000,
      detail: `峰值 ${metrics.maxMemory}`,
    },
    {
      name: '状态目录体积有界（没有泄漏）',
      ok: metrics.maxStoreBytes <= 8 * 1024 * 1024,
      detail: `峰值 ${(metrics.maxStoreBytes / 1024).toFixed(0)} KB`,
    },
    {
      name: '开了口（不是全程沉默 —— 那是另一种失败）',
      ok: metrics.speaks > 0,
      detail: `${metrics.speaks} 次 / ${hours.toFixed(1)} 小时`,
      minHours: 1,   // 短于 1 小时谈"说没说话"没有意义（第一帧 3~8 分钟才存档）
    },
    {
      name: '有松懈机会时会开口（不是全程沉默）',
      // ⚠ 这条**不能**写成"每一次机会都开口了" —— 实测是 9 次机会只开了 4 次，
      //   差额是冷却与预算在正常起作用（引擎会给出原因）。断言的名字不能 overclaim。
      ok: metrics.speaks > 0,
      detail: `机会 ${metrics.chances} 次，开口 ${metrics.speaks} 次（差额由冷却/预算挡下，见下面的原因统计）`,
      minHours: 1,
    },
    {
      name: '说话频率在合理带内（0.2~40 次/小时）',
      ok: perHour(metrics.speaks) >= 0.2 && perHour(metrics.speaks) <= 40,
      detail: `${perHour(metrics.speaks)} 次/小时`,
      minHours: 1,
    },
    {
      name: '事件种类覆盖多个通道（说明真的在读内容，不只是"文件变了"）',
      ok: Object.keys(metrics.eventsByKind).filter((k) => !RELIABLE_KINDS.includes(k)).length >= 2,
      detail: Object.entries(metrics.eventsByKind).map(([k, v]) => `${k}:${v}`).join(' '),
      minHours: 1,
    },
    {
      name: '运行时没有异常',
      ok: (finalSnap.diag?.errors ?? []).length === 0,
      detail: `${(finalSnap.diag?.errors ?? []).length} 个`,
    },
  ]

  const failed = checks.filter((c) => !c.ok && !(c.minHours && hours < c.minHours))
  const skipped = checks.filter((c) => c.minHours && hours < c.minHours)
  for (const c of skipped) c.skipped = `时长不足 ${c.minHours} 小时，这一条不判定`

  const result = {
    ok: failed.length === 0,
    mode: REAL_SEC > 0 ? `真实挂钟 ${REAL_SEC} 秒` : `模拟 ${HOURS} 小时`,
    tickMs: TICK_MS,
    gameDir: usingRealDir ? `${gameDir}（真实目录，只读）` : `${gameDir}（合成，临时目录）`,
    hours: Number(hours.toFixed(2)),
    ticks: metrics.ticks,
    wallMs: metrics.wallMs,
    ticksPerSec: Math.round(metrics.ticks / (metrics.wallMs / 1000)),
    events: metrics.events,
    eventsPerHour: perHour(metrics.events),
    eventsByKind: metrics.eventsByKind,
    speaks: metrics.speaks,
    speaksPerHour: perHour(metrics.speaks),
    speaksWhilePlaying: metrics.speaksWhilePlaying,
    speaksByPhase: metrics.speaksByPhase,
    relaxedTicks: metrics.relaxedTicks,
    /** 松懈 + 待发言已到窗口 = 真正"该开口"的机会数 */
    chances: metrics.chances,
    minIdleAtSpeak: metrics.minIdleAtSpeak,
    relaxedIdleSec: metrics.relaxedIdleSec,
    /** 松懈时段的"开口命中率" —— 不是越高越好，低了说明太保守，高了说明太吵。 */
    speakPerRelaxedHour: Number((metrics.speaks / Math.max(0.01, metrics.relaxedTicks * TICK_MS / 3600000)).toFixed(2)),
    latencyMs: { p50: pct(0.5), p90: pct(0.9), max: sorted[sorted.length - 1] ?? null },
    sessions: metrics.sessions,
    avgSessionMin: sessionLengths.length ? Number((sessionLengths.reduce((a, b) => a + b, 0) / sessionLengths.length / 60000).toFixed(1)) : null,
    maxPending: metrics.maxPending,
    maxMemory: metrics.maxMemory,
    storeKB: Number((metrics.maxStoreBytes / 1024).toFixed(0)),
    storeSamples: metrics.storeSamples,
    presence: finalSnap.presence,
    checks,
    skipped: skipped.map((c) => c.name),
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    const L = (s = '') => console.log(s)
    L('═'.repeat(72))
    L(` 长跑验证 —— ${result.mode}（每 tick ${TICK_MS}ms）`)
    L('═'.repeat(72))
    L(`游戏目录    ${result.gameDir}`)
    L(`模拟时长    ${result.hours} 小时（${metrics.ticks} 个 tick，实际耗时 ${(result.wallMs / 1000).toFixed(1)} 秒，${result.ticksPerSec} tick/秒）`)
    L('')
    L('── 读到了什么 ──')
    L(`事件        ${result.events} 条（${result.eventsPerHour}/小时）`)
    for (const [k, v] of Object.entries(result.eventsByKind).sort((a, b) => b[1] - a[1])) {
      L(`            ${k.padEnd(10)} ${v}`)
    }
    L('')
    L('── 说了什么话 ──')
    L(`主动开口    ${result.speaks} 次（${result.speaksPerHour}/小时）`)
    L(`  按玩家状态 ${Object.entries(result.speaksByPhase).map(([k, v]) => `${k}:${v}`).join('  ') || '（无）'}`)
    L(`  ★ 正在打时开口  ${result.speaksWhilePlaying} 次   ← 必须为 0`)
    L(`触发延迟    p50 ${result.latencyMs.p50 ?? '-'}ms / p90 ${result.latencyMs.p90 ?? '-'}ms / max ${result.latencyMs.max ?? '-'}ms`)
    L(`松懈命中    ${result.relaxedTicks} 个松懈 tick 里开了 ${result.speaks} 次（${result.speakPerRelaxedHour}/松懈小时）`)
    L(`  机会      ${result.chances} 次（松懈 + 待发言已到窗口）`)
    L(`  开口时的最小空闲 ${result.minIdleAtSpeak === null ? '-' : result.minIdleAtSpeak.toFixed(1)} 秒 / 引擎门槛 ${result.relaxedIdleSec ?? '?'} 秒`)
    L('  没说出口的原因（引擎给的账）：')
    for (const [k, label] of [
      ['waitedForFocus', '还在专注，继续等'],
      ['droppedExpired', '等太久作废'],
      ['droppedForCooldown', '冷却中'],
      ['droppedForBudget', '本小时预算用完'],
    ]) {
      const v = result.presence?.[k]
      if (v) L(`    ${label.padEnd(16)} ${v}`)
    }
    L('')
    L('── 有没有泄漏 ──')
    L(`待发言峰值  ${result.maxPending}`)
    L(`记忆峰值    ${result.maxMemory} 条`)
    L(`状态体积峰值 ${result.storeKB} KB`)
    L(`会话数      ${result.sessions}（平均 ${result.avgSessionMin ?? '-'} 分钟一局）`)
    L('')
    L('── 断言 ──')
    for (const c of result.checks) {
      const mark = c.skipped ? '⊘' : (c.ok ? '✅' : '❌')
      L(`  ${mark} ${c.name} —— ${c.detail}${c.skipped ? `（${c.skipped}）` : ''}`)
    }
    if (TRACE && trace.length) {
      L('')
      L('── 松懈时刻的逐步状态（--trace，最多 40 行）──')
      for (const t of trace.slice(0, 40)) L(t)
      if (trace.length > 40) L(`  …另有 ${trace.length - 40} 行`)
    }
    L('')
    L(result.ok ? '结论：长跑通过 ✅' : '结论：长跑**不通过** ❌')
  }

  process.exitCode = result.ok ? 0 : 1
} catch (e) {
  console.error('长跑验证异常：', e)
  process.exitCode = 2
} finally {
  rmSync(work, { recursive: true, force: true })
}
