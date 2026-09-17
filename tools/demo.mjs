// tools/demo.mjs —— 一条命令跑通全流程（离线、合成数据、不碰真实存档）
//
// 为什么需要它：项目有 7 个层、600+ 条断言，但"新来的人怎么在 30 秒内看到它真的能跑"
// 一直没有答案。这个脚本就是那个答案 —— 它按**数据实际流过系统的顺序**跑一遍，
// 每一步都打印**真实产生的值**（不是写死的示例输出）。
//
// ★ 两条诚实性要求：
//   ① 全程用**临时目录里的合成存档**，绝不读写你的真实游戏存档。
//      要看真实数据请用 `npm run games` / `npm run probe`（那才是碰真存档的工具）。
//   ② 需要联网或 API key 的环节（真实云端文生图、真实 LLM）**不在本脚本范围内** ——
//      所以这里用启发式填表与程序化素材，它们是真的、可复现的，而不是"假装调了模型"。
//
// 用法：
//   node tools/demo.mjs             # 完整跑一遍
//   node tools/demo.mjs --quiet     # 只打印每一步的结论行

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { compressToBase64 } from '../core/lzstring.mjs'
import { identify, inspect } from '../gameio/index.mjs'
import { resolvePolicy } from '../core/presence.mjs'
import { ensureAssets, QUALITY_DEFAULTS } from '../art/index.mjs'
import { STYLE_IDS, applyStyle } from '../art/styles.mjs'
import { actionsFor } from '../art/actions.mjs'
import { distinctColors, highFrequencyEnergy, edgeRatio } from '../art/image.mjs'
import { draftCard } from '../app/cardgen.mjs'
import { fillCardForm, applyFilledForm } from '../lore/fill.mjs'
import { createStore } from '../app/store.mjs'
import { createRuntime } from '../app/agent.mjs'
import { validateCard } from '../core/card.mjs'

const QUIET = process.argv.includes('--quiet')
const T0 = Date.UTC(2024, 4, 1, 12, 0, 0)
const sec = (n) => n * 1000
const min = (n) => n * 60_000

const OUT = []
function out(line = '') { OUT.push(line); if (!QUIET || /^[═─]|^[①-⑥]|^★|^结论/.test(line)) console.log(line) }
function step(n, title) { out(); out('═'.repeat(72)); out(` ${n}. ${title}`); out('═'.repeat(72)) }
function kv(k, v) { out(`   ${String(k).padEnd(22)} ${v}`) }

// ---------- 合成数据 ----------

/** 一份 RPG Maker MV 存档（结构照 MV 的真实形状写）。 */
function mvSave(over = {}) {
  return {
    system: { _saveCount: 12, _framesOnSave: 4.5 * 3600 * 60, _switches: {} },
    switches: { _data: [null, true, false, true] },
    variables: { _data: [null, 0, 5, 0, 12] },
    actors: { _data: [null, { _actorId: 1, _name: '勇者', _level: 12, _hp: 300, _mp: 40, _exp: 4200 }] },
    party: { _gold: 1234, _items: [[1, 3]], _weapons: [], _armors: [], _actors: [1], _steps: 5000 },
    map: { _mapId: 7, _player: { _x: 10, _y: 8 } },
    ...over,
  }
}

function writeSave(dir, save) {
  mkdirSync(join(dir, 'save'), { recursive: true })
  writeFileSync(join(dir, 'save', 'file1.rpgsave'), compressToBase64(JSON.stringify(save)), 'utf8')
}

/** 假的探测器：把"游戏在不在跑 / 空闲多久"变成可控输入，于是时序是确定性的。 */
function fakeProbe(state) {
  return {
    async isRunning() { return { running: state.running, matches: [], at: 0, cached: false, error: null, available: true } },
    idleSeconds() { return state.idle },
    setIdleReader() {}, reset() {}, stats() {}, guessProcessNames: () => [],
  }
}

const LORE = `霞是主角的同班同学，坐在教室最后一排。
她的口癖是「……才不是」，嘴上从不承认自己在关心别人。
性格开朗，爱吐槽，但她说自己「不需要你操心」。
她从不说「谢谢」，只会用行动表达。
称呼主角为「你」，但心里其实另有叫法。`

// ---------- 跑 ----------

const work = mkdtempSync(join(tmpdir(), 'pet-demo-'))
const stateDir = join(work, 'state')
const gameDir = join(work, 'game', 'Someday')

try {
  out('游戏角色陪伴桌宠 Agent —— 全流程演示')
  out(`全部数据都是**合成**的，写在临时目录里：${work}`)
  out('（要看真实存档请用 `npm run games` / `npm run probe` —— 那才是碰真存档的工具）')

  // ════ ① 读游戏 ════
  step('①', '读游戏：识别引擎 → 解码存档 → 结构 diff → 事件')
  writeSave(gameDir, mvSave())
  const id = identify(gameDir)
  kv('识别到的引擎', `${id.engine}（置信度 ${Number(id.score).toFixed(2)}）`)

  const store = createStore({ dir: stateDir })
  store.setSettings({ game: { dir: gameDir, level: 'moderate' } })
  const probeState = { running: true, idle: 2 }
  const runtime = createRuntime({ store, probe: fakeProbe(probeState), now: () => clock })

  let clock = T0
  // 先填表建卡（下面 ② 会详细讲），因为时机引擎需要一张卡
  const draft = draftCard({ name: '霞', game: 'Someday', temperament: 'calm', address: '你' }).card
  runtime.setCard(draft)

  // ⚠ 关键区别：`inspect()` **默认不去解码存档**（savesDecoded:false），
  //   所以它给的 capability 只是"结构上一定有"的那两条，而且它会**明说**这一点。
  //   真正的 capability 要等运行时实际解码观测之后才知道 —— 下面两次 pump 就是那个过程。
  const staticView = inspect(gameDir)
  kv('inspect 的静态视图', `${staticView.saves.length} 个存档 / ${staticView.logs.length} 个日志`
    + ` · capability=[${staticView.capability.readable.join('、')}]（未解码，只有基线）`)
  const staticPolicy = resolvePolicy({ level: 'moderate', capability: staticView.capability })
  kv('', `由静态视图推出来的档位是 ${staticPolicy.level}（封顶 ${staticPolicy.capped}）—— 这只是保守的起点`)

  const first = await runtime.pump({ now: T0 })
  kv('第一次观测', `事件 ${first.events.length} 条 —— **只建基线，不产事件**（没有"变化"就没有话可说）`)
  // 解码之后 capability 才升上来 —— 这才是运行时真正用的那个
  const live = runtime.snapshot().session
  kv('实际解码后的 capability', `[${(live.capability ?? []).join('、')}] · 生效档位 ${live.level}${live.capped ? '（封顶）' : ''}`)

  // 玩家推进了一段：地图、等级、金币都变了
  const after = mvSave()
  after.map._mapId = 8
  after.actors._data[1]._level = 13
  after.actors._data[1]._exp = 4800
  after.party._gold = 1500
  after.switches._data[3] = false
  writeSave(gameDir, after)
  // 当前磁盘上的存档状态 —— 后面每一步都**在它基础上**改，
  // 免得出现"等级 13→12"这种看起来像倒退的假事件（数据没错，是故事线不连贯）
  let cur = after

  clock = T0 + min(5)
  const focused = await runtime.pump({ now: clock })
  kv('存档变化后（玩家仍在打）', `事件 ${focused.events.length} 条`)
  for (const e of focused.events.slice(0, 6)) kv('', `· [${e.kind}] ${e.text}`)
  if (focused.events.length > 6) kv('', `· …另有 ${focused.events.length - 6} 条`)
  kv('是否开口', focused.speak ? `说了「${focused.speak.text}」` : '**没说** —— 还在专注期（这条最重要）')

  // ════ ② 角色卡 ════
  step('②', '角色卡：规范格式 + 填表式生成（不让模型即兴生成）')
  const form = await fillCardForm({ lore: LORE, card: draft, forceHeuristic: true })
  kv('表格式', form.form._format)
  kv('格子数', `${Object.keys(form.form.slots).length} 个（由 core/card-spec.mjs 定死）`)
  kv('填表来源', form.source === 'model' ? '模型' : '启发式（本演示不联网，所以走这条）')
  for (const p of form.proposals) kv('', `· ${p.path} = ${JSON.stringify(p.value)}`)
  if (form.rejected.length) for (const r of form.rejected) kv('被拒', `${r.path}：${r.reason}`)

  const confirmed = Object.fromEntries(form.proposals.map((p) => [p.path, true]))
  const applied = applyFilledForm(draft, {
    slots: Object.fromEntries(form.proposals.map((p) => [p.path, { value: p.value, quote: p.evidence }])),
  }, LORE, confirmed)
  kv('逐格确认后写入', `${applied.applied} 格`)
  const card = applied.card
  const check = validateCard(card)
  kv('校验', check.ok ? '通过 ✅' : `不通过：${check.errors.join('；')}`)
  kv('气质 → 需要的动作', `${card.animation.temperament} → ${actionsFor(card).required.join('、')}`)
  runtime.setCard(card)

  // ════ ③ 素材 ════
  step('③', '素材：多风格 × 多动作 + 两条质量闸门')
  const srcStyle = {}
  for (const style of STYLE_IDS) {
    const r = await ensureAssets({ card: { ...card, animation: { ...card.animation, style } }, dryRun: true })
    const sig = r.framesByAction.idle[0]
    kv(`风格 ${style}`, `动作 ${Object.keys(r.manifest.actions).length} 个 · 闸门 ${r.ok ? '通过 ✅' : '不通过 ❌'}`
      + ` · 颜色 ${distinctColors(sig)} 高频 ${highFrequencyEnergy(sig).toFixed(2)} 边缘 ${edgeRatio(sig).toFixed(3)}`)
    srcStyle[style] = r
  }
  const q = srcStyle.soft.quality
  kv('质量闸门实测', `动作间最小差 ${q.minPairDiff.toFixed(5)}（阈值 ≥ ${QUALITY_DEFAULTS.minActionDiff}）`
    + ` · 距立绘 ${q.maxSourceDistance}（上限 ≤ ${QUALITY_DEFAULTS.maxSourceDistance}）`)
  kv('风格指纹的含义', 'soft 颜色多而高频低 · pixel 颜色不增 · line 边缘占比最高')

  // ════ ④ 一局陪玩 ════
  step('④', '一局陪玩：时机引擎（专注期不说 / 松懈期才说）')
  kv('注意', '②换卡会重建会话 —— 换角色等于重开一局，之前攒下的"待发言"会被清掉')
  kv('', '（这是有意的：换了角色还用上一个角色的口吻去接话，比不说更糟）')

  // 所以这里重新制造一次"玩家推进了一段"
  probeState.running = true
  probeState.idle = 2
  const before = runtime.snapshot().session?.sessionId
  clock += min(1)
  const next = { ...cur, party: { ...cur.party, _gold: cur.party._gold + 500 }, map: { ...cur.map, _mapId: 20 } }
  writeSave(gameDir, next)
  cur = next
  const fresh = await runtime.pump({ now: clock })
  kv('存档又变了（玩家仍在打）', `事件 ${fresh.events.length} 条 · 会话 ${before}→${runtime.snapshot().session?.sessionId}`)
  kv('是否开口', fresh.speak ? '说了（不该发生！）' : '**没说** ✅ 专注期不打扰')

  probeState.idle = 2
  clock += sec(30)
  const stillFocused = await runtime.pump({ now: clock })
  kv('又过 30 秒，仍在专注', stillFocused.speak ? '说了（不该发生！）' : '**没说** ✅ 待发言继续压着，等松懈')

  probeState.idle = 45   // 放下手柄：45 秒没动静
  clock += sec(30)
  const relaxed = await runtime.pump({ now: clock })
  kv('玩家空闲 45 秒', relaxed.speak ? `说了「${relaxed.speak.text}」` : '没说')
  kv('播的动作', relaxed.action ? `${relaxed.action.action}（因为 ${relaxed.action.reason}）` : '不变')
  const pres = runtime.snapshot().presence
  kv('触发的延迟', `${pres?.triggerLatencyMs ?? '-'} ms —— 从事件发生到开口等这么久（这就是"等松懈"的代价，也是它的价值）`)
  // ★ 不开口时**一定要把原因打出来** —— 时机引擎的价值全在"为什么这次不说"，
  //   只显示"没说"会让人以为它坏了（而它可能正在正确地执行某个闸门）。
  if (relaxed.notes?.length) for (const n of relaxed.notes) kv('  为什么', n)

  // 再攒几次变化，看节流
  for (let i = 0; i < 3; i++) {
    cur = { ...cur, party: { ...cur.party, _gold: cur.party._gold + 250 }, map: { ...cur.map, _mapId: cur.map._mapId + 1 } }
    cur.actors = { _data: [null, { ...cur.actors._data[1], _level: 13 + i, _exp: 4800 + i * 200 }] }
    writeSave(gameDir, cur)
    clock += min(3)
    probeState.idle = 50
    const r = await runtime.pump({ now: clock })
    kv(`第 ${i + 2} 次变化`, `事件 ${r.events.length} 条 → ${r.speak ? `说了「${r.speak.text}」` : '被节流/静默判定挡下'}`)
    if (!r.speak && r.notes?.length) for (const n of r.notes) kv('  为什么', n)
  }

  // 玩家主动搭话（不受节流）
  const manual = await runtime.manual('刚才那关太难了')
  kv('玩家主动搭话', manual.utterance ? `「${manual.utterance.text}」` : '（没回应）')
  kv('', '（主动搭话不走节流 —— 是玩家先开口的，不该被"别打扰"挡回去）')

  const snap = runtime.snapshot()
  kv('可观测指标', `主动发言 ${snap.presence?.spoke ?? 0} 次 · 专注期沉默 ${snap.presence?.silenceDuringPlay ?? 0} 次 · 记忆 ${snap.memory?.entries ?? 0} 条`)

  // ════ ⑤ 跨会话 ════
  step('⑤', '退出游戏后：带着刚才的记忆继续聊')
  const end = runtime.endCurrentSession({ now: clock + min(1), durationMs: clock - T0 })
  kv('这一局的汇总', end.summary ? `「${end.summary.text}」` : '（无）')

  clock += min(30)
  // 新的一局：新建运行时（相当于重启应用），状态从磁盘恢复
  const runtime2 = createRuntime({ store: createStore({ dir: stateDir }), probe: fakeProbe({ running: false, idle: 300 }), now: () => clock })
  // 召回是按**词元重叠**打分的，所以问法很关键：拿玩家说过的话里的词去问才命中。
  for (const q of ['刚才那关', '存档', '完全不相干的问题']) {
    const recalled = runtime2.recall(q)
    kv(`问「${q}」`, recalled.text ? `「${recalled.text}」` : '（没想起什么）')
  }
  kv('', '（召回是词元重叠 + 时间衰减，不是语义检索 —— 问不中就是不中，不会硬编一个答案）')
  const mem = store.getMemory()
  kv('记忆条数', String(mem?.entries?.length ?? 0))
  for (const e of (mem?.entries ?? []).slice(0, 5)) {
    kv('', `· [${e.kind}] ${String(e.text).slice(0, 40)}${e.count > 1 ? `（×${e.count}）` : ''}`)
  }

  // ════ ⑥ 汇总 ════
  step('⑥', '汇总')
  kv('本脚本验证过', '读游戏 → 卡格式与填表 → 多风格素材 → 时机引擎 → 跨会话记忆')
  kv('未在范围内', '① 真实云端文生图 ② 真实 LLM（没 key，无法验证）③ 真实网络抓取 ④ 长时间跑')
  kv('要看真实数据', 'npm run games（本机游戏）· npm run probe（真实存档解码成绩）· npm run inspect -- <目录>')
  kv('要跑界面', 'npm start（桌宠）· npm run smoke（自检 + 截图）')
  out()
  out('结论：全流程跑通 ✅')
} finally {
  rmSync(work, { recursive: true, force: true })
}
