// app/main.mjs —— Electron 主进程
//
// ═══════════════════════════════════════════════════════════════════
// 这个文件的定位：**尽量薄**，且**必须可被自检脚本复用**
// ═══════════════════════════════════════════════════════════════════
// 所有业务逻辑都在 app/agent.mjs（可离线单测），这里只做三件事：
//   ① 建窗口（桌宠窗 / 设置页 / 人物卡页）
//   ② 把 Electron 的能力（powerMonitor、窗口操作）接进 runtime
//   ③ 把 runtime 的事件转成 IPC 推给渲染端
//
// ★ 窗口与 IPC 的建立封装在 `bootstrap()` 里，只有"作为入口直接运行时"才自动执行。
//   这样 app/smoke.mjs 能 import 它、跑**与生产完全相同的那条路径**。
//   最初 smoke 自己建窗口 + 自己注册 IPC，结果是它验的东西跟生产不是一回事
//   （渲染端一调 IPC 就 "No handler registered"）—— 那等于没验。
//
// ═══════════════════════════════════════════════════════════════════
// 桌宠窗的四个关键设置（少一个就不像"桌宠"）
// ═══════════════════════════════════════════════════════════════════
//   transparent: true        背景透明（否则是个白方块）
//   frame: false             没有标题栏
//   alwaysOnTop + 'screen-saver' 层级  要**盖在游戏全屏窗口之上**
//   setIgnoreMouseEvents(true, { forward: true })
//        —— 默认穿透点击（否则会挡住游戏操作！），
//        但 forward:true 仍会把鼠标位置转给渲染端，
//        于是渲染端能算出"指针是不是在桌宠身上"，在它身上时临时关掉穿透。
//        这是"既不挡游戏、又点得到桌宠"的唯一可行做法。

import { app, BrowserWindow, ipcMain, powerMonitor, screen } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname, resolve } from 'node:path'
import { createStore, redactSettings } from './store.mjs'
import { createProbe } from './probe.mjs'
import { createRuntime } from './agent.mjs'
import { suggestPatterns } from '../gameio/observe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDERER = join(HERE, 'renderer')

let petWin = null
let settingsWin = null
let cardWin = null
let launcherWin = null
let runtime = null
let timer = null
let probeRef = null

/** 由命令行覆盖状态目录（测试/多实例用）。 */
export function stateDirFrom(argv = process.argv) {
  const i = argv.indexOf('--state-dir')
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  return join(app.getPath('userData'), 'state')
}

/**
 * 建立整个应用（窗口 + IPC + 循环）。**假定 app 已 ready。**
 * @param {{stateDir?:string, startLoop?:boolean, focusable?:boolean}} [opts]
 */
export async function bootstrap(opts = {}) {
  const store = createStore({ dir: opts.stateDir ?? stateDirFrom() })
  const probe = createProbe()
  probeRef = probe

  // ★ 把 Electron 的 powerMonitor 接进来 —— 这是 Unity 场景下唯一可靠的"已松懈"信号。
  //   在此之前所有测试都靠注入假 reader；这里第一次接上真实来源。
  probe.setIdleReader(() => {
    try {
      const v = powerMonitor.getSystemIdleTime()
      return Number.isFinite(v) ? v : null
    } catch { return null }
  })

  runtime = createRuntime({
    store,
    probe,
    // ★ 只有外壳认识 BrowserWindow，所以 move_to 的**真实实现**在这里注入。
    //   运行时里的默认实现只发一个事件；工具契约、限流、确认、审计都在
    //   core/tools.mjs + app/tools.mjs 里，这里只补最后一步（真的挪窗口）。
    toolHandlers: { move_to: (args) => movePetWindow(args) },
  })
  runtime.on((ev) => broadcast(ev))

  registerIpc({ store, probe })
  createPetWindow(store, opts)

  if (opts.startLoop !== false) { runtime.start(); timer = true }

  return {
    store, probe, runtime,
    getPetWindow: () => (petWin && !petWin.isDestroyed() ? petWin : null),
    getSettingsWindow: () => (settingsWin && !settingsWin.isDestroyed() ? settingsWin : null),
    getCardWindow: () => (cardWin && !cardWin.isDestroyed() ? cardWin : null),
    openWindow,
    stop() {
      if (runtime) runtime.stop()
      timer = null
      for (const w of [petWin, settingsWin, cardWin, launcherWin]) { if (w && !w.isDestroyed()) w.destroy() }
      petWin = settingsWin = cardWin = launcherWin = null
    },
  }
}

// ---------- 窗口 ----------

/**
 * ★ `move_to` 工具的真实实现：把桌宠窗口挪到 (x, y)，并**钳制在可见范围内**。
 *
 * 为什么必须钳制：坐标是**模型给的**。模型完全可能算出 (99999, -500) 这种值 ——
 * 不钳的话桌宠就被挪到屏幕外，用户看到的是"桌宠消失了"，而且他自己找不回来。
 * 所以无论调用方是谁（模型/界面/用户），这一层都保证"它一定还在屏幕上"。
 *
 * @returns {{x:number, y:number, clamped:boolean, requested:{x:number,y:number}}}
 */
export function movePetWindow(args = {}) {
  const w = petWin && !petWin.isDestroyed() ? petWin : null
  const requested = { x: Math.round(Number(args.x) || 0), y: Math.round(Number(args.y) || 0) }
  if (!w) return { ...requested, clamped: false, note: '桌宠窗不存在' }
  const [W, H] = w.getSize()
  const disp = screen.getDisplayNearestPoint({ x: requested.x, y: requested.y })
  const area = disp.workArea
  // 至少留 40px 在屏幕内，否则用户根本抓不到它
  const keep = 40
  const x = Math.min(Math.max(requested.x, area.x - W + keep), area.x + area.width - keep)
  const y = Math.min(Math.max(requested.y, area.y - H + keep), area.y + area.height - keep)
  w.setPosition(x, y)
  return { x, y, clamped: x !== requested.x || y !== requested.y, requested }
}

export function createPetWindow(store, opts = {}) {
  const s = store.getSettings()
  const pos = Array.isArray(s.pet.position) ? { x: s.pet.position[0], y: s.pet.position[1] } : {}
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const W = 200, H = 260

  petWin = new BrowserWindow({
    width: W,
    height: H,
    x: pos.x ?? (sw - W - 40),
    y: pos.y ?? (sh - H - 40),
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // 默认不可聚焦：桌宠不该抢走游戏的键盘焦点。
    // （自检脚本传 focusable:true，否则离线环境里可能拿不到渲染帧）
    focusable: opts.focusable === true || process.env.PET_FOCUSABLE === '1',
    show: false,
    title: '桌宠',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  petWin.setAlwaysOnTop(true, 'screen-saver')   // 盖在游戏全屏窗口之上
  petWin.setVisibleOnAllWorkspaces(true)
  petWin.setIgnoreMouseEvents(true, { forward: true })   // 默认穿透点击
  petWin.once('ready-to-show', () => { if (petWin && !petWin.isDestroyed()) petWin.showInactive() })

  petWin.on('moved', () => {
    if (!petWin || petWin.isDestroyed()) return
    const [x, y] = petWin.getPosition()
    store.setSettings({ pet: { position: [x, y] } })
  })
  petWin.on('closed', () => { petWin = null })

  petWin.loadFile(join(RENDERER, 'pet.html'))
  return petWin
}

export function openWindow(which) {
  const isSettings = which === 'settings'
  const isCard = which === 'card'
  const existing = isSettings ? settingsWin : isCard ? cardWin : launcherWin
  if (existing && !existing.isDestroyed()) { existing.focus(); return existing }
  const size = isSettings ? [720, 760] : isCard ? [860, 780] : [900, 720]
  const title = isSettings ? '桌宠设置' : isCard ? '人物卡' : '启动器'
  const file = isSettings ? 'settings.html' : isCard ? 'card.html' : 'launcher.html'
  const win = new BrowserWindow({
    width: size[0],
    height: size[1],
    title,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadFile(join(RENDERER, file))
  win.on('closed', () => {
    if (isSettings) settingsWin = null
    else if (isCard) cardWin = null
    else launcherWin = null
  })
  if (isSettings) settingsWin = win
  else if (isCard) cardWin = win
  else launcherWin = win
  return win
}

function broadcast(ev) {
  for (const w of [petWin, settingsWin, cardWin, launcherWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('pet:event', ev)
  }
}

// ---------- IPC ----------

export function registerIpc({ store, probe }) {
  // 两种注册方式，刻意分开：需要"是谁在调"的通道才用带 event 的那个，
  // 免得所有 handler 都被多塞一个用不到的参数（读起来也容易搞混）。
  const handle = (name, fn) => ipcMain.handle(`pet:${name}`, (_e, ...args) => fn(...args))
  const handleWithEvent = (name, fn) => ipcMain.handle(`pet:${name}`, (e, ...args) => fn(e, ...args))

  handle('snapshot', () => runtime.snapshot())
  handle('pump', () => runtime.pump({ force: true }))
  handle('manual', (text) => runtime.manual(text))
  handle('endSession', () => runtime.endCurrentSession())

  handle('settings:set', (patch) => {
    const r = runtime.applySettings(patch)
    return { ok: r.ok, errors: r.errors, warnings: r.warnings, settings: r.settings ? redactSettings(r.settings) : runtime.settings }
  })
  handle('card:get', () => runtime.card)
  // 只校验、不保存。界面上的「校验」按钮必须有这条通道 ——
  // 否则只能复用 card:set（它会保存），于是点一下"校验"就把半成品卡应用给桌宠了。
  handle('card:validate', (raw) => runtime.validateCard(raw))
  // ---- 填表式生成（用户的明确要求）：出表 → 填 → 逐格确认 → 写入 ----
  handle('card:draft', (input) => runtime.draftCard(input ?? {}))
  handle('card:form', () => runtime.cardForm())
  handle('lore:fetch', (url) => runtime.fetchLore(url))
  handle('card:fill', (input) => runtime.fillCard(input ?? {}))
  handle('card:apply', (input) => runtime.applyFill(input ?? {}))
  handle('card:set', (raw) => {
    const r = runtime.setCard(raw)
    // 换了卡要重建素材，否则渲染端还在播上一个角色的图
    if (r.ok) runtime.buildArt().catch(() => {})
    return { ok: r.ok, errors: r.errors, warnings: r.warnings, card: r.card ? { id: r.card.id, name: r.card.name } : null }
  })
  handle('art:build', (o) => runtime.buildArt(o ?? {}))

  handle('games:list', (o) => runtime.listGames(o ?? {}))
  handle('game:inspect', (dir) => (dir ? runtime.inspectGame(dir) : { engine: null, summary: '没有目录' }))
  handle('game:patterns', (dir) => (dir ? suggestPatterns(dir) : { engine: null, lines: [] }))

  handle('diag', () => ({
    ...runtime.diagnostics(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    idleSec: probe.idleSeconds(),
    displays: screen.getAllDisplays().map((d) => ({ w: d.size.width, h: d.size.height, scale: d.scaleFactor })),
    windows: {
      pet: Boolean(petWin && !petWin.isDestroyed()),
      settings: Boolean(settingsWin && !settingsWin.isDestroyed()),
      card: Boolean(cardWin && !cardWin.isDestroyed()),
      launcher: Boolean(launcherWin && !launcherWin.isDestroyed()),
    },
    tools: runtime.toolState ? runtime.toolState().stats : null,
  }))

  handle('pet:interactive', (on) => {
    if (petWin && !petWin.isDestroyed()) petWin.setIgnoreMouseEvents(on !== true, { forward: true })
    return true
  })
  handle('pet:move', (x, y) => {
    if (petWin && !petWin.isDestroyed() && Number.isFinite(x) && Number.isFinite(y)) petWin.setPosition(x, y)
    return true
  })
  handle('window:open', (which) => { openWindow(which); return true })
  // 关闭"调用它的那个窗口"（设置页/人物卡页里的关闭按钮用它）
  handleWithEvent('window:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed()) w.close()
    return true
  })

  // ---- ★ LLM 工具（①）----
  handle('tool:run', (call) => runtime.runTool(call ?? {}))
  handle('tool:approve', (id) => runtime.approveTool(id))
  handle('tool:reject', (id, reason) => runtime.rejectTool(id, reason))
  handle('tool:state', () => runtime.toolState())

  // ---- ★ 启动器（⑤）----
  handle('launcher:list', (o) => runtime.listLaunchables(o ?? {}))
  handle('launcher:launch', (req) => runtime.launchApp(req ?? {}))
  handle('launcher:resolve', (q) => runtime.resolveLaunchTarget(q))
  handle('launcher:favorite', (entry) => {
    // 收藏/取消收藏一个游戏目录（界面上的"加到启动器"）
    const cur = store.getSettings().launcher?.favorites ?? []
    const dir = entry?.dir
    if (typeof dir !== 'string' || dir === '') return { ok: false, error: '缺少目录' }
    const key = (d) => String(d).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
    const exists = cur.some((f) => key(f.dir) === key(dir))
    const next = exists
      ? cur.filter((f) => key(f.dir) !== key(dir))
      : [...cur, { dir, name: entry.name ?? null, exe: entry.exe ?? null }]
    const r = runtime.applySettings({ launcher: { favorites: next } })
    return { ok: r.ok, errors: r.errors ?? [], favorites: next.length, action: exists ? 'removed' : 'added' }
  })

  // ---- ★ 分用途模型（③）----
  handle('llm:purposes', () => runtime.purposes())
  handle('llm:config', (purpose) => runtime.llmConfig(purpose))

  // ---- ★ Wiki 管线（②）----
  handle('wiki:fetch', (url, o) => runtime.fetchWiki(url, o ?? {}))
  handle('wiki:fill', (o) => runtime.fillCardFromWiki(o ?? {}))
  // ---- ★ 三级信源（官方 → 社区 Wiki → 搜索）----
  handle('sources:fill', (o) => runtime.fillCardFromSources(o ?? {}))
  handle('sources:tiers', () => runtime.sourceTiers())
}

// ---------- 作为入口直接运行时 ----------

function isEntry() {
  const arg = process.argv[1]
  if (!arg) return false
  try { return pathToFileURL(resolve(arg)).href === import.meta.url } catch { return false }
}

if (isEntry()) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    // 桌宠只该有一个实例：多开会得到两只互相抢窗口的桌宠
    app.quit()
  } else {
    app.on('second-instance', () => {
      const w = petWin && !petWin.isDestroyed() ? petWin : null
      if (w) w.showInactive()
    })
    app.whenReady().then(() => bootstrap())
    app.on('window-all-closed', () => { /* 桌宠常驻，不因关掉设置页退出 */ })
    app.on('before-quit', () => {
      // ⚠ `runtime.stop()` 里会先 `endCurrentSession()` —— 那一步把本局事件压成记忆。
      //   漏了它，玩几小时关掉应用 = 一点记忆都不剩（记忆只在一局结束时写）。
      try { runtime?.stop() } catch { /* 退出时不值得因为清理失败而卡住 */ }
    })
  }
}

export { probeRef }
