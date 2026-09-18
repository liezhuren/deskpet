// app/agent.mjs —— 桌宠运行时：把会话、外部信号探测、持久化、事件串起来
//
// 这是**主进程里唯一有状态的编排层**，Electron 相关的东西（窗口 / IPC / powerMonitor）
// 全部挡在外面，靠依赖注入进来。于是它能被 node:test 完整单测：
//   · 注入假时钟与假探测 → 离线跑「存档变化 → 该不该说 → 说出来」
//   · 注入假 store      → 不碰真实磁盘
// main.mjs 只负责：建窗口、把 IPC 接到这里、把 powerMonitor 与进程探测喂进来。
//
// ═══════════════════════════════════════════════════════════════════
// 三条职责边界（写下来免得被越界）
// ═══════════════════════════════════════════════════════════════════
// ① **该不该说**由 core/presence.mjs 决定，本层不插嘴（只是把外部信号喂进去）。   // arch:1
// ② **确定性与否**：模型只参与「怎么说」，状态（mood/affinity/记忆/待发言）全由本层的
//    确定性代码改。所以 pump() 不依赖任何网络 —— utter() 才是可能走网络的那一步。 // arch:2
// ③ **读不到空闲时间 + 游戏在跑 ⇒ 视为专注（不说话）**。宁可漏说，不可打扰。        // arch:3

import { join } from 'node:path'
import { createSession, tick, utter, endSession, endSessionScored, cancelSpeech, recallFor, describeSession } from '../agent/session.mjs'
import { createDialogue } from '../dialogue/index.mjs'
import { normalizeCard, validateCard } from '../core/card.mjs'
import { summarize as presenceSummary } from '../core/presence.mjs'
import { stats as memoryStats } from '../core/memory.mjs'
import { discoverGames, inspect } from '../gameio/index.mjs'
import { resolvePolicy } from '../core/presence.mjs'
import { ensureAssets, actionsFor } from '../art/index.mjs'
import { createStore, DEFAULT_SETTINGS, redactSettings, resolveLlmConfig, PURPOSE_IDS } from './store.mjs'
import { createProbe, resolveProcessNames } from './probe.mjs'
import { draftCard as makeDraft, draftGaps } from './cardgen.mjs'
import { fetchLore, fetchWiki } from '../lore/fetch.mjs'
import { fillCardForm as runFillForm, applyFilledForm, fillForm, fillCardFromWiki, fillCardFromSources } from '../lore/fill.mjs'
import { SOURCE_TIERS, tierLabel } from '../lore/sources.mjs'
import { modelFillablePaths, blankForm } from '../core/card-spec.mjs'
import { createLlmProvider } from '../dialogue/llm.mjs'
import { createToolRunner, missingHandlers } from './tools.mjs'
import { TOOL_NAMES } from '../core/tools.mjs'
import {
  buildLaunchables, resolveLaunchTarget, launch as launchTarget,
  steamLibraryRoots, matchWatchDir, LAUNCHER_DEFAULTS,
} from './launcher.mjs'

/** 动作名映射：时机引擎的 act / 说话的事件类别 → 素材层的动作 id。 */
export function artActionFor({ presenceAction = null, speakKind = null } = {}) {
  if (speakKind) {
    if (speakKind === 'death' || speakKind === 'crash') return 'worried'
    if (speakKind === 'progress' || speakKind === 'item') return 'happy'
    if (speakKind === 'manual') return 'greeting'
    return 'talk'
  }
  if (presenceAction === 'bored') return 'idleBored'
  return 'idle'
}

/** interact 工具的动作 → 桌宠动作 id。表意动作里"没有对应素材"的退回 idle。 */
export const INTERACT_ACTION = Object.freeze({
  greet: 'greeting',
  nod: 'talk',
  shake: 'worried',
  approach: 'idle',
  retreat: 'idle',
  look: 'idle',
  offer: 'happy',
})

/**
 * 抚摸对人格状态的影响。**刻意只做正向的事**：亲密度上升、mood 变好。
 * 这些字段只有确定性代码能改（模型不许直接写它），所以工具也只能通过这里影响它。
 */
function applyPet(persona, times) {
  if (!persona || typeof persona !== 'object') return persona
  const n = Number.isFinite(times) ? Math.max(1, Math.min(5, times)) : 1
  const affinity = Math.min(1, (Number.isFinite(persona.affinity) ? persona.affinity : 0.5) + 0.03 * n)
  const mood = Math.min(1, (Number.isFinite(persona.mood) ? persona.mood : 0.5) + 0.08 * n)
  return { ...persona, affinity, mood, lastPetAt: null }
}

/**
 * 建运行时。
 * @param {object} p
 * @param {object} p.store        app/store.mjs 的 store
 * @param {object} [p.probe]      探测器（默认真实现）
 * @param {()=>number} [p.now]
 * @param {object} [p.timers]     { setInterval, clearInterval } 便于测试
 * @param {(fn:Function,ms:number)=>any} [p.setInterval]
 */
export function createRuntime(p = {}) {
  const store = p.store ?? createStore({ dir: join(process.cwd(), '.pet-state') })
  const probe = p.probe ?? createProbe()
  const now = p.now ?? (() => Date.now())
  const setIntervalImpl = p.setInterval ?? setInterval
  const clearIntervalImpl = p.clearInterval ?? clearInterval

  let settings = store.getSettings()
  let card = loadCardFromStore(store)
  let session = null
  let timer = null
  let lastUtterance = null
  let lastAction = { action: 'idle', at: null, reason: 'initial' }
  let artManifest = store.getArt()
  const listeners = new Set()
  const diag = { pumps: 0, speaks: 0, actions: 0, errors: [], lastProbe: null, lastIdleSec: null, lastTickAt: null }

  function emit(ev) {
    for (const fn of listeners) { try { fn(ev) } catch { /* 订阅者出错不影响主循环 */ } }
  }
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn) }

  /** 建/重建会话（换了游戏目录、换了卡、或首次启动时调用）。 */
  function buildSession() {
    const memory = store.getMemory()
    const personaState = store.getPersona()
    const dialogue = makeDialogue()
    session = createSession({
      dir: settings.game.dir,
      game: gameKeyFor(settings.game.dir),
      card,
      level: settings.game.level,
      memory: memory ?? undefined,
      personaState: personaState ?? undefined,
      store: store.getWatch() ?? undefined,
      dialogue,
      // ★ 记忆 V2：一局结束压缩时用「记忆评分」那个用途的模型给候选打分
      judgeProvider: providerFor('memoryJudge'),
      now: now(),
    })
    return session
  }

  /**
   * ★ 按用途取 provider 配置（分用途模型）。
   * 「互动对话」走 dialogue、「填表」走 cardFill、「记忆评分」走 memoryJudge、
   * 「工具调用」走 tools、「Wiki 抽取」走 wiki —— 没单独配的字段回落到默认 llm 配置。
   */
  function llmFor(purpose) {
    return resolveLlmConfig(settings, purpose)
  }

  /**
   * 造一个 provider（给非对话用途用：填表 / 评分 / 工具 / wiki）。
   * ★ `p.providers` 可以按用途注入替身 —— 于是"评分过滤""Wiki 填表"这些
   *   需要模型的路径都能离线测（否则只能真联网，那就等于没测）。
   */
  function providerFor(purpose) {
    const injected = p.providers?.[purpose]
    if (injected !== undefined) return injected
    const c = llmFor(purpose)
    if (c.provider !== 'llm') return null
    return createLlmProvider({
      preset: c.preset,
      baseUrl: c.baseUrl || undefined,
      model: c.model || undefined,
      apiKey: c.apiKey || '',
    })
  }

  function makeDialogue() {
    const c = llmFor('dialogue')
    return createDialogue({
      provider: c.provider === 'llm' ? 'llm' : 'template',
      fallback: 'template',
      providerOptions: {
        preset: c.preset,
        baseUrl: c.baseUrl || undefined,
        model: c.model || undefined,
        apiKey: c.apiKey || '',
      },
    })
  }

  /** 把探测到的东西落盘（会话结束后才写记忆；监视状态每次都写）。 */
  function persist({ memory = true } = {}) {
    if (!session) return
    try {
      store.setWatch(session.store)
      if (memory) {
        store.setMemory(session.memory)
        store.setPersona(session.persona)
      }
    } catch (e) {
      diag.errors.push({ at: now(), where: 'persist', message: e.message })
    }
  }

  /**
   * ★ 推进一次。**不依赖网络**（表达层的调用在 utter 之后，且失败不影响本步）。
   * @param {{now?:number, force?:boolean}} [o]
   * @returns {Promise<object>} 本次的事件摘要
   */
  async function pump(o = {}) {
    const t = Number.isFinite(o.now) ? o.now : now()
    diag.pumps++
    diag.lastTickAt = t
    const out = { at: t, speak: null, action: null, events: [], notes: [], idleSec: null, gameRunning: null, provider: null }

    try {
      if (!session) buildSession()

      // ---- 1) 外部信号：游戏在不在跑 / 玩家空闲了多久 ----
      const { names, guessed, source } = resolveProcessNames({
        configured: settings.watch.processes,
        dir: settings.game.dir,
      })
      let running = null
      if (settings.game.dir) {
        const r = await probe.isRunning(names, { force: o.force })
        running = r.running
        diag.lastProbe = { at: t, running, matches: r.matches, error: r.error, guessed, source, names }
        out.gameRunning = running
      }
      const idle = probe.idleSeconds()
      diag.lastIdleSec = idle
      out.idleSec = idle

      // ★ 读不到空闲时间而游戏在跑 ⇒ 当成"专注"（宁可漏说，不可打扰）。
      //   给一个不可能达到放松门槛的值，让 presence 的 relaxed 判定自然为假。
      const idleForPresence = (idle === null && running === true) ? 0 : (idle === null ? 0 : idle)
      if (idle === null && running === true) out.notes.push('读不到系统空闲时间，且游戏在跑 ⇒ 按专注处理')

      // ---- 2) 决策（确定性，无网络）----
      const r = tick(session, {
        now: t,
        idleSec: idleForPresence,
        gameRunning: running === true,
        patterns: settings.game.logPatterns,
        saveRules: settings.game.saveRules,
      })
      session = r.session
      out.events = r.events
      out.notes.push(...r.notes)

      if (r.act) {
        const action = artActionFor({ presenceAction: r.act.action })
        if (action !== lastAction.action) {
          lastAction = { action, at: t, reason: `presence:${r.act.action}` }
          diag.actions++
          out.action = lastAction
        }
      }

      // ---- 3) 表达（可能走网络；失败不影响决策结果）----
      if (r.speak) {
        const u = await utter(r, { seed: Math.floor(t / 1000) })
        session = r.session
        if (u.ok) {
          lastUtterance = { text: u.text, at: t, kind: r.speak.kind, providerId: u.providerId, manual: !!r.speak.manual }
          diag.speaks++
          out.speak = lastUtterance
          const action = artActionFor({ speakKind: r.speak.kind })
          lastAction = { action, at: t, reason: `speak:${r.speak.kind}` }
          out.action = lastAction
          emit({ type: 'speak', utterance: lastUtterance, action: lastAction })
        } else {
          // 没产出合规的话 ⇒ 不开口。这是设计行为（dialogue 的"宁可不说"），但要如实记下来
          out.notes.push(...(u.notes ?? ['表达层没能产出合规的话']))
          emit({ type: 'silent', reason: 'dialogue-rejected', notes: u.notes ?? [] })
        }
      }

      // 记忆与监视状态落盘：每次都写监视状态；记忆只在有变化时写，避免每秒一次磁盘写
      persist({ memory: out.events.length > 0 || diag.pumps % 30 === 0 })
      emit({ type: 'pump', at: t, events: out.events.length, action: out.action })
    } catch (e) {
      diag.errors.push({ at: t, where: 'pump', message: e.message })
      out.notes.push(`pump 出错：${e.message}`)
      emit({ type: 'error', where: 'pump', message: e.message })
    }
    return out
  }

  /** 玩家主动搭话（点桌宠 / 在输入框里说话）。**不节流**。 */
  async function manual(text = null) {
    const t = now()
    if (!session) buildSession()
    const r = tick(session, { now: t, manual: true, summary: text ? null : '玩家点了桌宠', reply: text ?? undefined })
    session = r.session
    let utterance = null
    if (r.speak) {
      const u = await utter(r, { seed: Math.floor(t / 1000) })
      session = r.session
      if (u.ok) {
        utterance = { text: u.text, at: t, kind: 'manual', providerId: u.providerId, manual: true }
        lastUtterance = utterance
        lastAction = { action: artActionFor({ speakKind: 'manual' }), at: t, reason: 'manual' }
        emit({ type: 'speak', utterance, action: lastAction })
      }
    }
    persist()
    return { at: t, utterance, notes: r.notes }
  }

  /**
   * 结束当前这一局（退出游戏时调用）→ 压缩记忆。
   * ★ 用异步版 endSessionScored：让「记忆评分」用途的模型给个体候选打分过滤。
   *   没有配评分模型时它会直接返回（不联网），所以这条路径在默认配置下也是即时的。
   */
  async function endCurrentSession(o = {}) {
    if (!session) return { summary: null }
    const r = await endSessionScored(session, {
      now: o.now ?? now(),
      durationMs: o.durationMs,
      judgeProvider: providerFor('memoryJudge'),
    })
    session = r.session
    persist()
    emit({ type: 'session-end', summary: r.summary, judged: r.judged, filtered: r.filtered })
    return r
  }

  // ══════════════════════════════════════════════════════════════════
  // ★ 启动器（⑤）与 LLM 工具（①）
  // ══════════════════════════════════════════════════════════════════
  // 启动器负责"发现 + 启动"，工具层负责"模型怎么请求它"。
  // `launch_app` 是两者唯一的交点，而它是 confirm 级工具 —— 也就是说：
  // **模型不能自己启动任何东西，它只能发起一个待确认请求。**

  /** 收集可启动清单（收藏 + Steam 库 + 本机游戏目录）。纯发现，不启动。 */
  function listLaunchables(o = {}) {
    const favorites = settings.launcher?.favorites ?? []
    const roots = []
    const notes = []
    if (o.includeSteam !== false) {
      try {
        const st = steamLibraryRoots(o.steamOpts ?? {})
        roots.push(...st.roots)
        notes.push(...st.notes)
      } catch (e) { notes.push(`找 Steam 库失败：${e.message}`) }
    }
    const found = buildLaunchables({ favorites, roots, maxPerRoot: o.maxPerRoot ?? LAUNCHER_DEFAULTS.maxPerRoot })
    for (const n of found.notes) notes.push(n)
    return { items: found.items, notes, favorites: favorites.length, roots: roots.length }
  }

  /** 启动一个**登记过**的目标。confirmRequired 由设置决定；未批准一律拒绝。 */
  function launchApp(req = {}, o = {}) {
    const list = o.items ?? listLaunchables().items
    const r = launchTarget(req, {
      items: list,
      approve: o.approve === true,
      confirmRequired: settings.launcher?.confirmBeforeLaunch !== false,
      spawnImpl: o.spawnImpl,
      existsImpl: o.existsImpl,
    })
    if (r.ok) {
      store.setSettings({ launcher: { lastLaunched: r.item.id } })
      settings = store.getSettings()
      // 启动成功后：把监视目录对到这个游戏（对不上就说对不上，不硬指一个）
      if (settings.launcher?.autoStartWatch !== false && o.autoWatch !== false) {
        const discovered = discoverGames({ limit: 200 })
        const dir = matchWatchDir(r.item.name, discovered)
        if (dir) {
          store.setSettings({ game: { dir, exePath: r.item.exe } })
          settings = store.getSettings()
          session = null
          r.notes.push(`已开始监视：${dir}`)
        } else {
          r.notes.push('没找到对应的存档目录 ⇒ 暂不自动监视（可以在设置里手动指定）')
        }
      }
    }
    emit({ type: 'launch', ok: r.ok, name: r.item?.name ?? null, needsConfirm: r.needsConfirm === true })
    return r
  }

  /**
   * ★ 6 个工具的处理器。
   * 默认实现只做"运行时能做的事"（改人格状态、发动作、记审计）；
   * **真正碰窗口的动作（move_to）由 main.mjs 覆盖** —— 因为只有它认识 BrowserWindow。
   * 覆盖方式：createRuntime({ toolHandlers: { move_to } })。没覆盖时 move_to 只发一个
   * `pet:move` 事件，渲染端也可以自己处理。
   */
  const defaultToolHandlers = {
    move_to: (args) => {
      emit({ type: 'pet:move', x: args.x, y: args.y, reason: args.reason ?? null })
      lastAction = { action: 'idle', at: now(), reason: 'tool:move_to' }
      return { requested: { x: args.x, y: args.y }, note: '已请求移动（真正挪窗口由外壳执行）' }
    },
    pet: (args) => {
      const times = args.times ?? 1
      if (session) {
        // 抚摸是**正向**互动：亲密度上升、mood 变好（这些字段只有确定性代码能改）
        session = { ...session, persona: applyPet(session.persona, times) }
      }
      lastAction = { action: 'happy', at: now(), reason: `tool:pet×${times}` }
      emit({ type: 'pet:action', action: 'happy', reason: 'pet' })
      return { times, affinity: session?.persona?.affinity ?? null }
    },
    interact: (args) => {
      const action = INTERACT_ACTION[args.kind] ?? 'idle'
      lastAction = { action, at: now(), reason: `tool:interact:${args.kind}` }
      emit({ type: 'pet:action', action, reason: `interact:${args.kind}`, note: args.note ?? null })
      return { kind: args.kind, action, note: args.note ?? null }
    },
    cancel: (args) => {
      if (!session) return { canceled: false, note: '还没有会话' }
      const r = cancelSpeech(session, { now: now(), reason: args.reason ?? 'tool:cancel' })
      session = r.session
      lastAction = { action: 'idle', at: now(), reason: 'tool:cancel' }
      emit({ type: 'pet:action', action: 'idle', reason: 'cancel' })
      return { canceled: true, notes: r.notes }
    },
    launch_app: (args) => launchApp({ target: args.target, args: args.args }, { approve: true }),
    generate_character_card: async (args) => {
      // ★ 这里**只产出提议**，不落盘 —— 落盘要用户在人物卡页逐格确认。
      //   工具能做的上限就是"把表填好端上来"。
      const base = draftCardFor({ name: args.name, game: args.game, temperament: args.temperament })
      if (!base.ok) return { ok: false, errors: base.errors }
      const filled = args.wikiUrl
        ? await fillCardFromWiki({ url: args.wikiUrl, card: base.card, provider: providerFor('cardFill'), name: args.name })
        : await runFillForm({ lore: args.lore ?? '', card: base.card, name: args.name, provider: providerFor('cardFill') })
      emit({ type: 'card:proposed', source: filled.source, slots: filled.proposals.length })
      return {
        ok: filled.proposals.length > 0,
        source: filled.source,
        proposals: filled.proposals.length,
        rejected: filled.rejected.length,
        notes: filled.notes.slice(0, 6),
        hint: '提议已生成，需要在「人物卡」页逐格确认后才会写入',
      }
    },
  }

  const toolHandlers = { ...defaultToolHandlers, ...(p.toolHandlers ?? {}) }
  const toolRunner = createToolRunner({
    handlers: toolHandlers,
    approve: typeof p.approveTool === 'function' ? p.approveTool : undefined,
    now: () => now(),
  })

  /** 给界面用的快照。**密钥一律脱敏。** */
  function snapshot() {
    if (!session) buildSession()   // 懒建：否则换完卡的瞬间界面会显示一堆 "-"
    const d = session ? describeSession(session) : null
    const p = session ? presenceSummary(session.presence, { policy: session.policy }) : null
    return {
      at: now(),
      settings: redactSettings(settings),
      card: card ? { id: card.id, name: card.name, hard: card.persona?.hard ?? null, animation: card.animation ?? null } : null,
      session: d,
      presence: p,
      memory: session ? memoryStats(session.memory) : null,
      lastUtterance,
      action: lastAction,
      art: artManifest ? { actions: Object.keys(artManifest.actions ?? {}), source: artManifest.source?.kind ?? null, provider: artManifest.provider } : null,
      diag: { ...diag, errors: diag.errors.slice(-5) },
    }
  }

  /** 更新设置：会重建会话（因为卡 / 档位 / provider 都可能变了）。 */
  function applySettings(patch) {
    const r = store.setSettings(patch)
    if (!r.ok) return r
    settings = r.settings
    session = null            // 下次 pump 重建
    emit({ type: 'settings', settings: redactSettings(settings) })
    return r
  }

  /** 建一张草稿卡（**不落盘**）—— "填表"流程的第一步。 */
  function draftCardFor(input) {
    const r = makeDraft(input)
    return { ...r, gaps: r.card ? draftGaps(r.card) : [] }
  }

  /** 出空表（界面要显示"有哪些格子、各该怎么填"）。 */
  function cardForm() {
    const form = fillForm()
    return { format: form._format, slots: form.slots }
  }

  /**
   * 抓「网上角色介绍」。
   * ⚠ 只读静态 HTML、只抓一个 URL、有大小与超时上限。
   *   正文太短时**如实报告**，不拿导航栏文字冒充介绍（见 lore/fetch.mjs 文件头）。
   */
  async function fetchLoreText(url) {
    // fetchImpl 可注入 —— 于是"抓取 → 抽文本 → 提议"整条链路能离线测，
    // 而真实网络连通性仍然**未验证**（如实写在 lore/fetch.mjs 文件头）。
    const r = await fetchLore(url, p.fetchImpl ? { fetchImpl: p.fetchImpl } : undefined)
    emit({ type: 'lore', url: r.url, ok: r.ok, chars: r.chars })
    return r
  }

  /** 造表达层用的 provider（填表与说话共用配置）。 */
  function makeLlmProvider() {
    return providerFor('cardFill')
  }

  /**
   * ★ 出表并填（模型或启发式），**绝不写入任何东西**。
   * 返回的是"逐格状态 + 等确认"，写入要另走 applyFill。
   */
  async function fillCard(input = {}) {
    const base = (input.card && typeof input.card === 'object') ? input.card : (card ?? null)
    const provider = input.provider ?? makeLlmProvider()
    const r = await runFillForm({
      lore: input.lore,
      card: base,
      name: base?.name,
      provider,
      forceHeuristic: input.forceHeuristic === true,
    })
    const usingModel = r.source === 'model'
    return {
      source: r.source,
      // 逐格结果，界面直接渲染这张表
      slots: (r.proposals ?? []).map((p) => ({
        path: p.path, field: p.field, value: p.value, evidence: p.evidence,
        confidence: p.confidence, status: 'filled',
      })),
      rejected: r.rejected ?? [],
      notes: r.notes ?? [],
      // 空表也带上：界面要能显示"还有哪些格子是空的"
      emptySlots: modelFillablePaths.filter((p) => !(r.proposals ?? []).some((x) => x.path === p)),
      providerLine: usingModel ? `用模型填（${provider?.name ?? 'llm'}）` : '用启发式填（没配模型，或按要求强制）',
    }
  }

  /**
   * 逐格确认后写入卡：先按 spec 校验，不合规**不落盘**。
   * @param {{card?:object, lore?:string, confirmed:Record<string,boolean>, slots?:Array}} input
   */
  function applyFill(input = {}) {
    const base = (input.card && typeof input.card === 'object') ? input.card : card
    // 从"确认过的逐格结果"重建成 applyFilledForm 认的表形状
    const slots = {}
    for (const s of Array.isArray(input.slots) ? input.slots : []) {
      if (input.confirmed?.[s.path] !== true) continue
      slots[s.path] = { value: s.value, quote: s.evidence ?? '' }
    }
    if (Object.keys(slots).length === 0) {
      return { ok: false, applied: 0, card: null, errors: ['没有确认任何格子'], warnings: [], rejected: [] }
    }
    const r = applyFilledForm(base, { slots }, input.lore ?? '', Object.fromEntries(Object.keys(slots).map((k) => [k, true])))
    const check = validateCard(r.card)
    if (!check.ok) {
      return { ok: false, applied: 0, card: null, errors: check.errors, warnings: check.warnings, rejected: r.rejected ?? [] }
    }
    const { card: normalized, errors } = normalizeCard(r.card)
    if (!normalized) return { ok: false, applied: 0, card: null, errors, warnings: check.warnings, rejected: r.rejected ?? [] }
    card = normalized
    store.setCard(normalized)
    store.setSettings({ game: { cardId: normalized.id } })
    settings = store.getSettings()
    store.setPersona(null)
    session = null
    emit({ type: 'card', card: { id: card.id, name: card.name } })
    return { ok: true, applied: r.applied, card: normalized, errors: [], warnings: check.warnings, rejected: r.rejected ?? [] }
  }

  /**
   * 只校验、不落盘（界面上的「校验」按钮走这条）。
   * 单独开一条的原因：`setCard` 会保存并应用，如果界面图省事复用它，
   * 点一下"校验"就把半成品卡应用给桌宠了 —— 按钮名与副作用不符是最容易犯的错之一。
   */
  function validateCardOnly(raw) {
    const check = validateCard(raw)
    if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings, card: null }
    const { card: normalized, errors } = normalizeCard(raw)
    return { ok: Boolean(normalized), errors, warnings: check.warnings, card: normalized }
  }

  /** 存角色卡（先校验，不合规不落盘）。 */
  function setCard(raw) {
    const check = validateCard(raw)
    if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings, card: null }
    const { card: normalized, errors } = normalizeCard(raw)
    if (!normalized) return { ok: false, errors, warnings: check.warnings, card: null }
    card = normalized
    store.setCard(normalized)                      // 卡单独存一份（可能较大，不塞进 settings）
    store.setSettings({ game: { cardId: normalized.id } })
    settings = store.getSettings()
    store.setPersona(null)                         // 换了角色 ⇒ 旧的人格状态不再适用
    session = null
    emit({ type: 'card', card: { id: card.id, name: card.name } })
    return { ok: true, card: normalized, errors: [], warnings: check.warnings }
  }

  /** 生成 / 刷新素材（默认程序化；缺动作会被查出来）。 */
  async function buildArt(o = {}) {
    if (!card) return { ok: false, notes: ['还没有角色卡，无法生成素材'] }
    const outDir = o.outDir ?? join(store.dir, 'assets', card.id ?? 'card')
    const r = await ensureAssets({ card, sourcePath: o.sourcePath ?? null, outDir, dryRun: o.dryRun === true })
    if (!r.ok) {
      const lines = []
      if (r.check?.missing?.length) lines.push(`缺动作：${r.check.missing.join('、')}`)
      for (const n of (r.check?.malformed ?? [])) lines.push(n)
      for (const n of r.quality?.notes ?? []) lines.push(n)
      for (const n of r.notes ?? []) lines.push(n)
      return { ok: false, notes: lines, manifest: r.manifest, quality: r.quality }
    }
    artManifest = r.manifest
    if (!o.dryRun) store.setArt(r.manifest)
    emit({ type: 'art', actions: Object.keys(r.manifest.actions) })
    return { ok: true, notes: r.notes, manifest: r.manifest, quality: r.quality, outDir }
  }

  /** 当前该播哪个动作的哪一帧（渲染端用）。 */
  function frameFor(actionId, frameIndex = 0) {
    const a = artManifest?.actions?.[actionId]
    if (!a || !Array.isArray(a.frames) || a.frames.length === 0) return null
    return a.frames[frameIndex % a.frames.length]
  }

  function start(o = {}) {
    if (timer) return
    const ms = Math.max(250, o.intervalMs ?? settings.watch.intervalMs ?? 1000)
    timer = setIntervalImpl(() => { pump().catch(() => {}) }, ms)
    buildSession()
    emit({ type: 'started', intervalMs: ms })
  }
  /**
   * 退出前收尾。**刻意走同步路径**（不调模型评分）：
   *   退出时进程可能随时结束，异步的评分+落盘不保证跑得完 ——
   *   而"玩了几小时的记忆"绝不能因为一个可选的模型调用没来得及而丢掉。
   *   所以这里用同步的 endSession：压缩、写盘一步到位，宁可少一层过滤。
   *   （游戏正常退出、应用还活着时走的是 endCurrentSession，那条会带评分。）
   */
  function stop() {
    if (timer) { clearIntervalImpl(timer); timer = null }
    try {
      if (session) {
        const r = endSession(session, { now: now() })
        session = r.session
        emit({ type: 'session-end', summary: r.summary, judged: 0, filtered: 0, sync: true })
      }
    } catch (e) {
      diag.errors.push({ at: now(), where: 'stop', message: e.message })
    }
    persist()
    emit({ type: 'stopped' })
  }
  function diagnostics() { return { ...diag, errors: diag.errors.slice(-20), settings: redactSettings(settings) } }

  return {
    pump, manual, endCurrentSession, snapshot, applySettings, setCard, validateCard: validateCardOnly, buildArt,
    draftCard: draftCardFor, cardForm, fetchLore: fetchLoreText, fillCard, applyFill,
    // ⚠ 注入的 fetchImpl 必须**穿过这一层传下去** —— 否则"离线可跑"的承诺在
    //   wiki 这条路上直接失效（旧的 fetchLore 包装传了、新的两个忘了，真踩过）。
    fetchWiki: (url, o) => fetchWiki(url, {
      name: card?.name,
      ...(p.fetchImpl ? { fetchImpl: p.fetchImpl } : {}),
      ...(o ?? {}),
    }),
    /**
     * ★ 三级信源生成角色卡：官方 → 社区 Wiki → 搜索，够用即停。
     * 信源配置来自设置（`sources.*`），调用方可以逐个覆盖（界面上那一栏就是干这个的）。
     */
    fillCardFromSources: (o) => {
      const sc = settings.sources ?? {}
      const opt = (o && typeof o === 'object') ? o : {}
      return fillCardFromSources({
        card,
        name: opt.name ?? card?.name,
        game: opt.game ?? gameKeyFor(settings.game.dir),
        provider: providerFor('cardFill'),
        officialUrls: opt.officialUrls ?? sc.officialUrls ?? [],
        officialHosts: opt.officialHosts ?? sc.officialHosts ?? [],
        communityBases: opt.communityBases ?? sc.communityBases ?? [],
        enableSearch: opt.enableSearch ?? sc.enableSearch !== false,
        searchTemplate: opt.searchTemplate ?? sc.searchTemplate,
        forceHeuristic: opt.forceHeuristic,
        limits: {
          enoughChars: opt.enoughChars ?? sc.enoughChars,
          ...(opt.limits ?? {}),
        },
        ...(p.fetchImpl ? { fetchImpl: p.fetchImpl } : {}),
        ...(opt.sleepImpl ? { sleepImpl: opt.sleepImpl } : {}),
      })
    },
    fillCardFromWiki: (o) => fillCardFromWiki({
      card,
      provider: providerFor('cardFill'),
      ...(p.fetchImpl ? { fetchImpl: p.fetchImpl } : {}),
      ...(o ?? {}),
    }),
    /** 三级信源的登记表（界面用来渲染"依次取用"那一栏） */
    sourceTiers: () => SOURCE_TIERS.map((t) => ({ id: t.id, label: t.label, note: t.note })),
    // ---- 启动器 ----
    listLaunchables, launchApp, resolveLaunchTarget: (q, items) => resolveLaunchTarget(q, items ?? listLaunchables().items),
    // ---- LLM 工具 ----
    runTool: (call) => toolRunner.run(call),
    approveTool: (id) => toolRunner.approvePending(id),
    rejectTool: (id, reason) => toolRunner.rejectPending(id, reason),
    toolState: () => ({ pending: toolRunner.pending(), history: toolRunner.history(20), stats: toolRunner.stats(), missing: missingHandlers(toolHandlers), total: TOOL_NAMES.length }),
    // ---- 分用途模型 ----
    llmConfig: (purpose) => llmFor(purpose),
    purposes: () => PURPOSE_IDS.map((id) => ({ id, ...llmFor(id) })),
    frameFor, start, stop, on, diagnostics,
    listGames: (o) => discoverGames(o),
    inspectGame: (dir, o) => inspect(dir, o),
    // ⚠ 也要懒建会话：早先写成 `session ? recallFor(...) : {used:[],text:''}`，
    //   于是在"重启应用后还没 pump 过"时调 recall，会**静默返回空** ——
    //   看起来像"什么都想不起来"，其实是会话压根没建。snapshot() 早就有这个懒建，recall 漏了。
    recall: (q, o) => {
      if (!session) buildSession()
      return session ? recallFor(session, q, o) : { used: [], text: '' }
    },
    get settings() { return redactSettings(settings) },
    get session() { return session },
    get card() { return card },
  }
}

// ---------- 内部 ----------

function loadCardFromStore(store) {
  // 角色卡单独存一份（可能较大，不塞进 settings）
  const saved = store.getCard()
  if (!saved) return null
  const { card } = normalizeCard(saved)
  return card
}

/** 游戏标识：用目录的最后一段（记忆按它归属）。 */
function gameKeyFor(dir) {
  if (!dir || typeof dir !== 'string') return null
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || null
}

export { createStore, DEFAULT_SETTINGS, createProbe, actionsFor, resolvePolicy }
