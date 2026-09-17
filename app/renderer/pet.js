// app/renderer/pet.js —— 桌宠窗的渲染端
//
// 三件事：
//   ① 播动作（按 art manifest 逐帧换图）
//   ② 显示角色说的话（气泡）
//   ③ **命中判定**：把"指针是不是压在身上"告诉主进程，用来开关穿透点击
//
// 关于 ③（这是桌宠最容易做错的一处）：
//   桌宠窗默认是**穿透点击**的，否则它会挡住游戏操作 —— 那就成了病毒而不是桌宠。
//   但全穿透又点不到它。做法是 Electron 的 `setIgnoreMouseEvents(true, { forward: true })`：
//   即使穿透，鼠标位置仍会转给渲染端；渲染端算出指针是否落在精灵的矩形内，
//   在它身上时临时关掉穿透。**用户感知上就是"能点中桌宠、点空白处穿过去"。**
//
// 命中判定刻意用**矩形**而不是逐像素 alpha：精灵是 64×96 的小图，
// 矩形误差只有几个像素，而逐像素要读 canvas，代价与复杂度都不值。

/* global petApi */
const sprite = document.getElementById('sprite')
const bubble = document.getElementById('bubble')
const hud = document.getElementById('hud')

let manifest = null          // { actions: { idle: { frames: [...] } } }
let assetBase = null         // 素材目录的 file:// URL 前缀
let currentAction = 'idle'
let frameIndex = 0
let frameTimer = null
let hudTimer = null
let bubbleTimer = null
let dragging = null
let pressed = null

// ---------- 素材 ----------

async function loadSnapshot() {
  const s = await petApi.snapshot()
  applyArt(s)
  updateHud(s)
  if (s.lastUtterance) showBubble(s.lastUtterance.text)
  if (s.action?.action) playAction(s.action.action)
  return s
}

function applyArt(s) {
  // 主进程只给动作名与来源；帧路径通过 art:build 的返回拿到。
  // 这里用一次 buildArt(dryRun) 的返回，避免另开一条只读通道。
  if (!s.art || !s.art.actions || s.art.actions.length === 0) {
    document.body.classList.add('no-art')
    return
  }
  document.body.classList.remove('no-art')
}

/** 从主进程拿一次完整清单（含帧的相对路径），拼成可加载的 URL。 */
async function fetchManifest() {
  const r = await petApi.buildArt({ dryRun: true })
  if (!r || !r.ok || !r.manifest) { document.body.classList.add('no-art'); return }
  manifest = r.manifest
  const dir = (r.outDir ?? '').replace(/\\/g, '/')
  assetBase = dir ? `file:///${dir}/` : null
  document.body.classList.remove('no-art')
  playAction('idle')
}

function framePath(action, i) {
  const a = manifest?.actions?.[action]
  if (!a || !a.frames?.length) return null
  return assetBase ? assetBase + a.frames[i % a.frames.length] : null
}

// ---------- 动作播放 ----------

/** 每个动作的播放节奏（毫秒/帧）。数字是刻意调的：待机要慢而轻，说话要跟得上句子。 */
const FRAME_MS = { idle: 520, idleBored: 620, talk: 180, happy: 200, worried: 420, greeting: 240, sleep: 900 }

function playAction(action) {
  if (!manifest?.actions?.[action]) return
  const changed = action !== currentAction
  currentAction = action
  if (changed) frameIndex = 0
  if (frameTimer) clearTimeout(frameTimer)
  tickFrame()
}

function tickFrame() {
  const frames = manifest?.actions?.[currentAction]?.frames ?? []
  if (frames.length === 0) return
  const src = framePath(currentAction, frameIndex)
  if (src) sprite.src = src
  frameIndex = (frameIndex + 1) % frames.length
  frameTimer = setTimeout(tickFrame, FRAME_MS[currentAction] ?? 400)
}

// ---------- 气泡 ----------

function showBubble(text, ms = 9000) {
  if (!text) return
  bubble.textContent = text
  bubble.classList.add('show')
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms)
}

// ---------- HUD（按住 Alt 才显示，平时完全隐形）----------

function updateHud(s) {
  const d = s.session ?? {}
  const parts = []
  parts.push(`引擎 <b>${d.engine ?? '未识别'}</b>`)
  parts.push(`档位 <b>${d.level ?? '-'}</b>${d.capped ? ' <span class="warn">(封顶)</span>' : ''}`)
  parts.push(`表达 <b>${d.provider ?? '-'}</b>`)
  if (s.diag?.lastIdleSec != null) parts.push(`空闲 ${s.diag.lastIdleSec}s`)
  if (s.diag?.lastProbe) parts.push(s.diag.lastProbe.running ? '<b>游戏在跑</b>' : '游戏没跑')
  if (s.memory) parts.push(`记忆 ${s.memory.entries}`)
  parts.push(`说了 ${d.presence?.spoke ?? 0} 次`)
  hud.innerHTML = parts.join(' · ')
}

// ---------- 命中判定 / 拖动 / 点击 ----------

function spriteRect() {
  const r = sprite.getBoundingClientRect()
  return r
}

function isOverSprite(x, y) {
  if (document.body.classList.contains('no-art')) {
    const r = document.getElementById('placeholder').getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }
  const r = spriteRect()
  if (r.width === 0) return false
  // 留一点余量，让边缘也好点中
  const pad = 4
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
}

let lastInteractive = null
window.addEventListener('mousemove', (e) => {
  const over = isOverSprite(e.clientX, e.clientY)
  if (over !== lastInteractive) {
    lastInteractive = over
    petApi.setInteractive(over)
  }
  if (dragging && over) {
    const nx = e.screenX - dragging.dx
    const ny = e.screenY - dragging.dy
    petApi.moveTo(nx, ny)
  }
})

window.addEventListener('mousedown', (e) => {
  if (!isOverSprite(e.clientX, e.clientY)) return
  pressed = { x: e.screenX, y: e.screenY }
  dragging = { dx: e.clientX, dy: e.clientY }
  e.preventDefault()
})

window.addEventListener('mouseup', async (e) => {
  if (pressed) {
    const moved = Math.hypot(e.screenX - pressed.x, e.screenY - pressed.y)
    pressed = null
    dragging = null
    // 位移很小 ⇒ 当成"点了一下"（点桌宠 = 玩家主动搭话）
    if (moved < 4) {
      const r = await petApi.manual(null)
      if (r?.utterance) showBubble(r.utterance.text)
    }
  }
})

// 双击打开设置页；右键打开人物卡页（不给桌宠加任何可见按钮）
window.addEventListener('dblclick', (e) => {
  if (isOverSprite(e.clientX, e.clientY)) petApi.openWindow('settings')
})
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (isOverSprite(e.clientX, e.clientY)) petApi.openWindow('card')
})

// 按住 Alt 显示 HUD
window.addEventListener('keydown', (e) => { if (e.altKey) document.body.classList.add('hud-on') })
window.addEventListener('keyup', (e) => { if (!e.altKey) document.body.classList.remove('hud-on') })

// ---------- 主进程推来的事件 ----------

petApi.onEvent((ev) => {
  if (ev.type === 'speak' && ev.utterance) {
    showBubble(ev.utterance.text)
    playAction(ev.action?.action ?? 'talk')
  } else if (ev.type === 'pump' && ev.action) {
    playAction(ev.action.action)
  } else if (ev.type === 'session-end') {
    playAction('idle')
  } else if (ev.type === 'pump') {
    // 空闲时可能切到 idleBored —— 由主进程的动作事件驱动，这里只在没有动作事件时兜底
  }
  petApi.snapshot().then(updateHud).catch(() => {})
})

// ---------- 启动 ----------

fetchManifest().then(loadSnapshot).catch(() => {
  document.body.classList.add('no-art')
})

// HUD 定期刷新（它只在按住 Alt 时可见，但内容要新）
hudTimer = setInterval(() => { petApi.snapshot().then(updateHud).catch(() => {}) }, 3000)
window.addEventListener('beforeunload', () => { if (hudTimer) clearInterval(hudTimer); if (frameTimer) clearTimeout(frameTimer) })

// ---------- 测试钩子 ----------
// 给 app/smoke.mjs 用：让"切换动作 / 显示气泡"可以被外部驱动。
// 没有它的话，截图只能截到 idle，而**动作是否真的不同**这件事就验证不了 ——
// 那恰恰是素材层最容易糊弄过去的地方（"六个动作其实是一张图"）。
// 只暴露这几个纯展示函数，不暴露任何数据或能力。
window.__petPlay = (action) => { playAction(action); return currentAction }
window.__petShowBubble = (text) => { showBubble(text, 60000); return true }
window.__petReady = () => Boolean(manifest && assetBase)
window.__petActions = () => Object.keys(manifest?.actions ?? {})
