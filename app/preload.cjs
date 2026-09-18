// app/preload.cjs —— contextBridge：把主进程的能力以**最小面**暴露给渲染端
//
// 用 CommonJS（.cjs）：preload 在 contextIsolation 下走 CJS 最稳，也避免与
// 渲染端"没有 package.json type 字段"的脚本环境混乱。
//
// ⚠ 安全边界：渲染端**拿不到** Node（nodeIntegration: false），
//   只能调用这里白名单出来的几个方法。所以设置页即使被注入了脚本，
//   也读不到文件系统、读不到完整 apiKey（快照里已脱敏）。

const { contextBridge, ipcRenderer } = require('electron')

/** 允许渲染端调用的方法白名单。新增通道要在这里登记。 */
const CHANNELS = [
  'snapshot', 'pump', 'manual', 'endSession',
  'settings:set', 'card:set', 'card:get', 'card:validate', 'art:build',
  // 填表式生成：出表 → 抓取 → 填 → 逐格确认 → 写入
  'card:draft', 'card:form', 'lore:fetch', 'card:fill', 'card:apply',
  // ★ LLM 工具（执行 / 确认 / 拒绝 / 审计）
  'tool:run', 'tool:approve', 'tool:reject', 'tool:state',
  // ★ 启动器
  'launcher:list', 'launcher:launch', 'launcher:resolve', 'launcher:favorite',
  // ★ 分用途模型
  'llm:purposes', 'llm:config',
  // ★ Wiki 管线
  'wiki:fetch', 'wiki:fill',
  // ★ 三级信源（官方 → 社区 Wiki → 搜索）
  'sources:fill', 'sources:tiers',
  'games:list', 'game:inspect', 'game:patterns',
  'diag', 'pet:interactive', 'pet:move', 'pet:speak',
  'window:open', 'window:close',
]

const invoke = (name, ...args) => {
  if (!CHANNELS.includes(name)) return Promise.reject(new Error(`未登记的通道：${name}`))
  return ipcRenderer.invoke(`pet:${name}`, ...args)
}

contextBridge.exposeInMainWorld('petApi', {
  /** 当前状态快照（密钥已脱敏） */
  snapshot: () => invoke('snapshot'),
  /** 手动推进一次（调试用） */
  pump: () => invoke('pump'),
  /** 玩家主动搭话；text 为空表示"点了桌宠" */
  manual: (text) => invoke('manual', text ?? null),
  endSession: () => invoke('endSession'),

  setSettings: (patch) => invoke('settings:set', patch),
  setCard: (raw) => invoke('card:set', raw),
  getCard: () => invoke('card:get'),
  /** 只校验不保存 —— 界面上的「校验」按钮走这条 */
  validateCard: (raw) => invoke('card:validate', raw),
  buildArt: (o) => invoke('art:build', o ?? {}),

  // ---- 填表式生成角色卡 ----
  /** 建草稿卡（不落盘） */
  draftCard: (input) => invoke('card:draft', input ?? {}),
  /** 空表：有哪些格子、各该怎么填 */
  cardForm: () => invoke('card:form'),
  /** 抓「网上角色介绍」（只读静态 HTML，一个 URL，有上限） */
  fetchLore: (url) => invoke('lore:fetch', url),
  /** 出表并填（模型或启发式）—— **不写入任何东西** */
  fillCard: (input) => invoke('card:fill', input ?? {}),
  /** 逐格确认后写入卡（先校验，不合规不落盘） */
  applyFill: (input) => invoke('card:apply', input ?? {}),

  listGames: (o) => invoke('games:list', o ?? {}),
  inspectGame: (dir) => invoke('game:inspect', dir),
  suggestPatterns: (dir) => invoke('game:patterns', dir),

  diag: () => invoke('diag'),
  openWindow: (which) => invoke('window:open', which),
  closeWindow: () => invoke('window:close'),

  // ---- ★ LLM 工具 ----
  /** 执行一次工具调用（需要确认的会被挂起，返回 needsConfirm + pendingId） */
  runTool: (call) => invoke('tool:run', call ?? {}),
  /** 批准一条待确认的调用 */
  approveTool: (id) => invoke('tool:approve', id),
  /** 拒绝一条待确认的调用 */
  rejectTool: (id, reason) => invoke('tool:reject', id, reason ?? null),
  /** 待确认 / 审计历史 / 统计 */
  toolState: () => invoke('tool:state'),

  // ---- ★ 启动器 ----
  listLaunchables: (o) => invoke('launcher:list', o ?? {}),
  launchApp: (req) => invoke('launcher:launch', req ?? {}),
  resolveLaunchTarget: (q) => invoke('launcher:resolve', q),
  toggleFavorite: (entry) => invoke('launcher:favorite', entry ?? {}),

  // ---- ★ 分用途模型 ----
  listPurposes: () => invoke('llm:purposes'),
  llmConfig: (purpose) => invoke('llm:config', purpose),

  // ---- ★ Wiki 管线 ----
  fetchWiki: (url, o) => invoke('wiki:fetch', url, o ?? {}),
  fillCardFromWiki: (o) => invoke('wiki:fill', o ?? {}),
  /** ★ 三级信源依次取用并填表（官方 → 社区 Wiki → 搜索），每条提议带出处层级 */
  fillCardFromSources: (o) => invoke('sources:fill', o ?? {}),
  /** 三级信源的登记表（界面用来渲染说明） */
  listSourceTiers: () => invoke('sources:tiers'),

  /** 鼠标是否压在桌宠身上 —— 决定"穿透点击"开关（见 main.mjs） */
  setInteractive: (v) => invoke('pet:interactive', v === true),
  /** 拖动桌宠：传新的窗口左上角坐标 */
  moveTo: (x, y) => invoke('pet:move', Math.round(x), Math.round(y)),

  /** 订阅主进程推来的事件（说话 / 动作 / 状态变化）。返回退订函数。 */
  onEvent: (fn) => {
    const h = (_e, payload) => { try { fn(payload) } catch { /* 渲染端出错不影响主进程 */ } }
    ipcRenderer.on('pet:event', h)
    return () => ipcRenderer.removeListener('pet:event', h)
  },
})
