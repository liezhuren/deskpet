// app/store.mjs —— 持久化（设置 / 监视状态 / 记忆 / 人格状态）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么用「JSON + 原子替换」而不是 node:sqlite（纠正一个我先前写下的判断）
// ═══════════════════════════════════════════════════════════════════
// HANDOFF 早先写过"正式版该用 node:sqlite"。真正动手时重新权衡，结论是**不用**：
//   · 数据量很小：记忆上限 3000 条 × 约 200 字节 ≈ 600KB；其余（设置/监视状态/人格）都是几 KB
//     （V2 把记忆上限从 400 提到 3000，量级仍然远在"JSON 够用"的范围内）
//   · 只有一个进程在写，不需要并发事务
//   · 召回逻辑（权重/时间衰减/关键词）本来就在 core/memory.mjs 里用 JS 算，
//     并没有"要用 SQL 才能做的查询"
//   · 为这点数据引入第二套存储 API 与第二套测试路径，收益不抵复杂度
// 于是用**原子替换**（先写 .tmp 再 rename）拿到"要么是旧内容、要么是新内容"的保证 ——
// 这才是 sqlite 在这里真正的价值（原子性），而不是 SQL 本身。
//
// ⚠ 更正一处我先前的说法：`node:sqlite` 在 Node 24 上**实测无需 flag 即可用**
//   （`new DatabaseSync(':memory:')` 直接跑通，没有实验警告）。
//   所以不用它的理由不是"API 不稳"，而是上面那三条。写下来免得后人以为是被技术限制卡的。
//
// 本文件设计成"换掉存储层不影响上层"：将来真要上 sqlite，只需替换本文件。
//
// ⚠ 密钥处理：设置里会存 LLM 的 apiKey。**读取时默认脱敏**，
//   只有明确要用来发请求时才取原文。设置页要展示、日志要打印时都用脱敏版本，
//   免得"随手把设置打到控制台"就泄露了 key。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ══════════════════════════════════════════════════════════════════
// ★ 分用途模型
// ══════════════════════════════════════════════════════════════════
// 为什么一件事要分几个"用途"：这个项目里模型在干**性质完全不同**的活 ——
//   说话（要小、要快、要便宜，一晚上可能几十次）
//   填角色卡（量大、要准、能慢，一天几次）
//   给记忆评分（只需判"重不重要"，可以用最便宜的模型甚至本地模型）
//   挑工具（要稳，输出必须是合法 JSON）
//   抽 Wiki（长上下文，最好用长窗口模型）
// 用同一个模型干这五件事，必然要么贵得离谱、要么在该稳的地方不稳。
// 所以每个用途可以**各自指定** provider / model / key；没指定的字段回落到默认 llm 配置。
//
// 设计上刻意保持"闭集"：用途名与可覆盖的字段都是登记过的常量，
// 于是设置页的白名单校验（unknownPaths）仍然有效 —— 写错字段名会被当场拒绝，
// 而不是静默存下一个没人读的键（那个坑本项目踩过：`animation.style` 曾是死字段）。

/** 用途登记表。**新增用途要在这里登记**，否则设置页写不进去。 */
export const LLM_PURPOSES = Object.freeze([
  Object.freeze({ id: 'dialogue', label: '互动对话', note: '桌宠开口说话 —— 调用最频繁，适合小模型' }),
  Object.freeze({ id: 'cardFill', label: '角色卡填表', note: '从介绍/Wiki 里往格子里填 —— 要准确，可以慢' }),
  Object.freeze({ id: 'memoryJudge', label: '记忆评分', note: '判断一条变化值不值得记 —— 只需轻重判断，可用最便宜的' }),
  Object.freeze({ id: 'tools', label: '工具调用', note: '决定调哪个工具、给什么参数 —— 输出必须是合法 JSON' }),
  Object.freeze({ id: 'wiki', label: 'Wiki 抽取', note: '把 Wiki 正文抽成结构化字段 —— 上下文长，适合长窗口模型' }),
])

/** 用途可以覆盖的字段（与默认 llm 块一致，闭集）。 */
export const LLM_PURPOSE_FIELDS = Object.freeze(['provider', 'preset', 'baseUrl', 'model', 'apiKey', 'enabled'])

/** 全部用途 id。 */
export const PURPOSE_IDS = Object.freeze(LLM_PURPOSES.map((p) => p.id))

/** 设置的结构与默认值。设置页只能改这里声明过的字段。 */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  game: Object.freeze({
    dir: null,          // 监视中的游戏目录
    adapter: null,      // 手动指定引擎（null = 自动探测）
    level: 'moderate',  // 想要的主动档位（会被 capability 封顶）
    cardId: null,       // 当前角色卡
    processes: [],      // 该游戏的进程名（空 = 由目录名猜，界面要显示这个猜测）
    logPatterns: [],    // 每游戏日志规则：[{ re, kind, label }]
    saveRules: [],      // 每游戏存档规则：[{ re, kind, text }]
    exePath: null,      // 该游戏的可执行文件（启动器用；null = 没登记过）
  }),
  llm: Object.freeze({
    provider: 'template',       // 'template' | 'llm'
    preset: 'deepseek',         // dialogue/llm.mjs 的 PRESETS 名
    baseUrl: '',
    model: '',
    apiKey: '',
    // 分用途覆盖：{ [purposeId]: { provider?, preset?, baseUrl?, model?, apiKey?, enabled? } }
    // 空对象 = 全部用途都用上面的默认配置（老用户升级后行为不变）
    purposes: Object.freeze({}),
  }),
  art: Object.freeze({ provider: 'procedural', style: 'soft', scale: 1 }),
  pet: Object.freeze({ position: null, clickThrough: false, alwaysOnTop: true, muted: false }),
  watch: Object.freeze({ enabled: true, intervalMs: 1000, processes: [] }),
  // 启动器：登记过的游戏（自动发现 + 手动添加）
  launcher: Object.freeze({ favorites: [], lastLaunched: null, autoStartWatch: true, confirmBeforeLaunch: true }),
})

const PURPOSE_PATHS = PURPOSE_IDS.flatMap((id) => LLM_PURPOSE_FIELDS.map((f) => `llm.purposes.${id}.${f}`))

export const SETTING_PATHS = Object.freeze([
  'game.dir', 'game.adapter', 'game.level', 'game.cardId', 'game.processes', 'game.logPatterns', 'game.saveRules', 'game.exePath',
  'llm.provider', 'llm.preset', 'llm.baseUrl', 'llm.model', 'llm.apiKey',
  ...PURPOSE_PATHS,
  'art.provider', 'art.style', 'art.scale',
  'pet.position', 'pet.clickThrough', 'pet.alwaysOnTop', 'pet.muted',
  'watch.enabled', 'watch.intervalMs', 'watch.processes',
  'launcher.favorites', 'launcher.lastLaunched', 'launcher.autoStartWatch', 'launcher.confirmBeforeLaunch',
])

const LEVELS = ['conservative', 'moderate']
const WRITABLE_FILES = ['settings', 'watch', 'memory', 'persona', 'art', 'card']

/**
 * 建一个存储。
 * @param {{dir:string, fs?:object}} p
 */
export function createStore({ dir, fs = null } = {}) {
  if (!dir) throw new Error('createStore 需要 dir')
  const io = fs ?? { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync }
  const file = (name) => join(dir, `${name}.json`)

  function ensureDir() {
    if (!io.existsSync(dir)) io.mkdirSync(dir, { recursive: true })
  }

  /**
   * 原子写：先写 `.tmp` 再 rename。
   * rename 在同一文件系统内是原子的 ⇒ 读到的永远是"完整的旧内容"或"完整的新内容"，
   * 不会出现"写了一半被断电/被杀进程"留下的半截 JSON。
   */
  function write(name, value) {
    if (!WRITABLE_FILES.includes(name)) throw new Error(`未知的存储名 ${name}（不在白名单里）`)
    ensureDir()
    const tmp = `${file(name)}.tmp`
    io.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8')
    io.renameSync(tmp, file(name))
    return value
  }

  function read(name, fallback = null) {
    try {
      const raw = io.readFileSync(file(name), 'utf8')
      const v = JSON.parse(raw)
      return v ?? fallback
    } catch {
      return fallback   // 文件不存在 / 坏了 / 不是 JSON ⇒ 一律退回默认值，不抛
    }
  }

  return {
    dir,
    path: file,
    write,
    read,

    /** 读设置（缺字段用默认值补；坏文件退回全默认）。 */
    getSettings() {
      const saved = read('settings', {}) ?? {}
      return mergeSettings(DEFAULT_SETTINGS, saved)
    },
    /** 只接受白名单路径（见 SETTING_PATHS），非法值不写入 —— 返回 errors 让界面显示，而不是静默丢弃。 */
    setSettings(patch) {
      const unknown = unknownPaths(patch)
      if (unknown.length) {
        return { ok: false, settings: this.getSettings(), errors: [`未登记的设置路径：${unknown.join('、')}`], warnings: [] }
      }
      const current = this.getSettings()
      const next = mergeSettings(current, patch)
      const check = validateSettings(next)
      if (!check.ok) return { ok: false, settings: current, errors: check.errors, warnings: check.warnings }
      write('settings', next)
      return { ok: true, settings: next, errors: [], warnings: check.warnings }
    },

    getCard() { return read('card', null) },
    setCard(v) { return write('card', v) },

    getWatch() { return read('watch', null) },
    setWatch(v) { return write('watch', v) },
    getMemory() { return read('memory', null) },
    setMemory(v) { return write('memory', v) },
    getPersona() { return read('persona', null) },
    setPersona(v) { return write('persona', v) },
    getArt() { return read('art', null) },
    setArt(v) { return write('art', v) },

    /** 清掉全部状态（保留设置）—— 设置页的"重置记忆"用。 */
    resetState() {
      const removed = []
      for (const name of ['watch', 'memory', 'persona']) {
        try { if (io.existsSync(file(name))) { unlinkSync(file(name)); removed.push(name) } } catch { /* 忽略 */ }
      }
      return removed
    },
  }
}

/** 深合并（只合并普通对象；数组整体替换）。 */
export function mergeSettings(base, patch) {
  if (!patch || typeof patch !== 'object') return clone(base)
  const out = clone(base)
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeSettings(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 校验设置。**不抛异常** —— 它是给界面用的，要能给出可读的修正清单。
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateSettings(s) {
  const errors = []
  const warnings = []
  const need = (cond, msg) => { if (!cond) errors.push(msg) }
  if (!s || typeof s !== 'object') return { ok: false, errors: ['设置不是对象'], warnings }

  need(LEVELS.includes(s.game?.level), `game.level 必须是 ${LEVELS.join(' / ')}`)
  need(['template', 'llm'].includes(s.llm?.provider), 'llm.provider 必须是 template / llm')
  need(Number.isFinite(s.watch?.intervalMs) && s.watch.intervalMs >= 250,
    'watch.intervalMs 必须 ≥ 250（更快的轮询只是白烧 CPU —— 静默窗口是按秒算的）')
  need(watchIntervalWarn(s) === null, `watch.intervalMs ${s.watch?.intervalMs} 偏大：时机引擎的静默判定会变迟钝`)

  if (s.game?.dir != null) need(typeof s.game.dir === 'string', 'game.dir 必须是字符串或 null')
  if (s.llm?.provider === 'llm') {
    // 配了 llm 却没配 key ⇒ 只是警告：运行时会自动退回模板档（这是设计好的降级路径）
    if (!s.llm.apiKey) warnings.push('llm.provider 选了 llm 但没填 apiKey ⇒ 运行时会自动退回模板档')
    if (!s.llm.model) warnings.push('没填 model ⇒ 可能无法调用')
  }
  need(['procedural'].includes(s.art?.provider) || typeof s.art?.provider === 'string', 'art.provider 必须是字符串')
  if (s.art?.provider && s.art.provider !== 'procedural') {
    // 云端图像 provider 本仓库没实现（没有 API key 无法验证），所以要如实提醒
    warnings.push(`art.provider「${s.art.provider}」没有内置实现 ⇒ 会退回程序化 provider`)
  }
  need(s.pet?.position === null || (Array.isArray(s.pet.position) && s.pet.position.length === 2 &&
    s.pet.position.every((n) => Number.isFinite(n))), 'pet.position 必须是 null 或 [x, y]')

  // ---- 分用途模型 ----
  const purposes = s.llm?.purposes
  if (purposes != null && (typeof purposes !== 'object' || Array.isArray(purposes))) {
    errors.push('llm.purposes 必须是对象（{ 用途: { model, apiKey, … } }）')
  } else {
    for (const [id, cfg] of Object.entries(purposes ?? {})) {
      if (!PURPOSE_IDS.includes(id)) {
        errors.push(`llm.purposes 里有未登记的用途「${id}」（已登记的：${PURPOSE_IDS.join(' / ')}）`)
        continue
      }
      if (cfg != null && (typeof cfg !== 'object' || Array.isArray(cfg))) {
        errors.push(`llm.purposes.${id} 必须是对象`)
        continue
      }
      for (const [k, v] of Object.entries(cfg ?? {})) {
        if (!LLM_PURPOSE_FIELDS.includes(k)) {
          errors.push(`llm.purposes.${id}.${k} 不是可覆盖的字段（只能覆盖 ${LLM_PURPOSE_FIELDS.join(' / ')}）`)
          continue
        }
        if (k === 'enabled') need(typeof v === 'boolean', `llm.purposes.${id}.enabled 必须是布尔值`)
        else if (k === 'provider') need(['template', 'llm'].includes(v), `llm.purposes.${id}.provider 必须是 template / llm`)
        else need(typeof v === 'string', `llm.purposes.${id}.${k} 必须是字符串`)
      }
      // 只覆盖了"半套"配置时提醒：最常见的是换了 model 却忘了 key
      const merged = resolveLlmConfig(s, id)
      if (cfg?.enabled !== false && merged.provider === 'llm' && !merged.apiKey) {
        warnings.push(`用途「${id}」选了 llm 但解析下来没有 apiKey ⇒ 该用途会退回模板档`)
      }
    }
  }

  // ---- 启动器 ----
  const favs = s.launcher?.favorites
  if (favs != null) {
    if (!Array.isArray(favs)) errors.push('launcher.favorites 必须是数组')
    else for (const f of favs) {
      if (!f || typeof f !== 'object') { errors.push('launcher.favorites 里的条目必须是对象'); break }
      if (typeof f.dir !== 'string' || f.dir === '') { errors.push('launcher.favorites 的条目缺 dir'); break }
    }
  }
  if (s.game?.exePath != null) need(typeof s.game.exePath === 'string', 'game.exePath 必须是字符串或 null')
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * ★ 分用途模型的核心：把"某个用途最终该用哪套配置"解析出来。
 *
 * 规则（按优先级）：
 *   1. 该用途**显式关掉**（`enabled: false`）⇒ 直接返回 template（别去读默认配置，
 *      否则"关掉"会被默认的 llm 配置兜回来，用户会以为开关坏了）
 *   2. 该用途自己填的字段优先
 *   3. 没填的字段回落到默认 llm 配置
 *
 * @param {object} s 设置
 * @param {string} purpose LLM_PURPOSES 里的 id（未登记的 id 会**退回默认**并标注）
 * @returns {{provider:string, preset:string, baseUrl:string, model:string, apiKey:string,
 *            source:string, overrides:string[], unknownPurpose:boolean}}
 */
export function resolveLlmConfig(s, purpose) {
  const base = s?.llm ?? {}
  const out = {
    provider: base.provider ?? 'template',
    preset: base.preset ?? 'deepseek',
    baseUrl: base.baseUrl ?? '',
    model: base.model ?? '',
    apiKey: base.apiKey ?? '',
    source: 'default',
    overrides: [],
    unknownPurpose: false,
  }
  if (!purpose) return out
  if (!PURPOSE_IDS.includes(purpose)) {
    out.unknownPurpose = true
    return out
  }
  const cfg = base.purposes?.[purpose]
  if (!cfg || typeof cfg !== 'object') return out
  if (cfg.enabled === false) {
    // 显式关掉 ⇒ 强制模板档，且**不读默认配置**（见上面规则 1）
    return { provider: 'template', preset: out.preset, baseUrl: '', model: '', apiKey: '', source: 'disabled', overrides: [], unknownPurpose: false }
  }
  for (const f of LLM_PURPOSE_FIELDS) {
    if (f === 'enabled') continue
    const v = cfg[f]
    if (v === undefined || v === null || v === '') continue
    out[f] = v
    out.overrides.push(f)
  }
  if (out.overrides.length) out.source = `purpose:${purpose}`
  return out
}

function watchIntervalWarn(s) {
  const ms = s.watch?.intervalMs
  if (!Number.isFinite(ms)) return null
  return ms > 10_000 ? ms : null
}

/**
 * 脱敏：给界面展示 / 打日志用。
 * 只保留头尾各 4 位，中间固定长度（不泄露真实长度）。
 *
 * ★ 分用途之后**每一处 key 都要脱敏**：默认配置一份，每个用途各一份。
 *   漏掉任何一处，"随手把设置打到控制台"就会泄露 —— 而用途配置正是最容易被漏掉的那种。
 */
export function redactSettings(s) {
  const out = clone(s)
  if (out?.llm) {
    out.llm = { ...out.llm, ...maskKey(out.llm.apiKey) }
    if (out.llm.purposes && typeof out.llm.purposes === 'object') {
      const next = {}
      for (const [id, cfg] of Object.entries(out.llm.purposes)) {
        next[id] = (cfg && typeof cfg === 'object') ? { ...cfg, ...maskKey(cfg.apiKey) } : cfg
      }
      out.llm.purposes = next
    }
  }
  return out
}

/** 单处密钥的脱敏结果（`apiKey` 与 `apiKeySet` 两个字段）。 */
function maskKey(k) {
  if (typeof k === 'string' && k !== '') {
    return { apiKey: k.length <= 8 ? '****' : `${k.slice(0, 4)}****${k.slice(-4)}`, apiKeySet: true }
  }
  return { apiKey: '', apiKeySet: false }
}

/** 列出存储目录里有哪些文件（诊断用）。 */
export function listStoreFiles(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return [] }
}

function clone(v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(clone)
  const o = {}
  for (const [k, x] of Object.entries(v)) o[k] = clone(x)
  return o
}

/**
 * 找出 patch 里**未登记**的叶子路径。
 * 注释里说"只接受白名单路径"就必须真的做 —— 否则设置页写错一个字段名会静默地什么都不发生
 * （那种"看起来存上了、其实没生效"最难查）。
 */
export function unknownPaths(patch, prefix = '') {
  const out = []
  if (!patch || typeof patch !== 'object') return out
  for (const [k, v] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${k}` : k
    const isBranch = v && typeof v === 'object' && !Array.isArray(v)
    const hasDescendants = SETTING_PATHS.some((p) => p.startsWith(`${path}.`))
    if (isBranch) {
      if (hasDescendants) out.push(...unknownPaths(v, path))
      else if (!SETTING_PATHS.includes(path)) out.push(path)
    } else if (!SETTING_PATHS.includes(path)) {
      out.push(path)
    }
  }
  return out
}
