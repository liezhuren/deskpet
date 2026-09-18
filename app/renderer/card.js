// app/renderer/card.js —— 人物卡页逻辑
//
// 这一页的核心不是"填表"，而是**让硬约束可见**：
// 用户改一行、就能看到"这行会被怎么校验"，否则他不知道自己在改什么。
// 所以下面有一条 buildHard() → validate 的即时回路，以及一块 explainCard() 的解释表。

/* global petApi */
const $ = (id) => document.getElementById(id)

/** 当前正在编辑的卡（草稿或已载入的）。 */
let current = null

/** 填表流程的状态：最后一次"出表并填"的结果。 */
let fillState = { lore: '', base: null, slots: [], confirmed: {} }

function show(id, text, kind = '') {
  const el = $(id)
  if (!el) return
  el.className = `msg ${kind}`
  el.textContent = text
}

const listOf = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// ══════════════════ ① 填表式生成 ══════════════════

/** ① 建草稿卡（不落盘）。后面所有填表都以它为底。 */
async function makeDraft() {
  const r = await petApi.draftCard({
    name: $('fName').value.trim(),
    game: $('fGame').value.trim(),
    temperament: $('fTemperament').value,
    address: $('fAddress').value.trim(),
  })
  if (!r.ok) { show('draftMsg', `不行：${r.errors.join('；')}`, 'err'); return null }
  fillState.base = r.card
  current = r.card
  writeForm(r.card)
  const gaps = r.gaps ?? []
  $('gapHint').textContent = gaps.length ? `还缺：${gaps.join('；')}` : '硬约束看着齐了。'
  show('draftMsg', `草稿卡已建（${r.card.id}）—— 硬约束还是中性默认值，接着往下填`, 'ok')
  return r.card
}

/** 抓「网上角色介绍」。正文太短时**如实报告**，不拿导航栏文字冒充。 */
async function fetchLore() {
  const url = $('loreUrl').value.trim()
  if (!url) { show('fillMsg', '先填一个网址；或者直接把原文粘到下面的框里', 'warn'); return }
  show('fillMsg', '抓取中…', '')
  const r = await petApi.fetchLore(url)
  if (!r.ok) {
    show('fillMsg', `抓取没能拿到正文：${r.error ?? (r.notes ?? []).join('；')}\n${(r.notes ?? []).join('\n')}`, 'err')
    return
  }
  $('loreText').value = r.text
  show('fillMsg', `抓到 ${r.chars} 字${r.title ? `（${r.title}）` : ''}${(r.notes ?? []).length ? `\n${r.notes.join('\n')}` : ''}`, 'ok')
}

/** ② 出表并填。**不写入任何东西** —— 结果只显示，等用户逐格确认。 */
async function runFill(forceHeuristic) {
  const lore = $('loreText').value.trim()
  if (!lore) { show('fillMsg', '先贴入原文（或从网址抓一次）', 'warn'); return }
  const base = fillState.base ?? await makeDraft()
  if (!base) return
  fillState.lore = lore
  show('fillMsg', '出表并填…', '')
  const r = await petApi.fillCard({ lore, card: base, forceHeuristic: forceHeuristic === true })
  fillState.slots = r.slots ?? []
  fillState.confirmed = Object.fromEntries(fillState.slots.map((s) => [s.path, true]))  // 默认全选（用户可逐格取消）
  renderSlots(r)
  renderBrief(r)
  const bad = (r.rejected ?? []).length
  show('fillMsg', `${r.providerLine}：填了 ${fillState.slots.length} 格${bad ? `，另有 ${bad} 格被拒` : ''}`
    + `\n${(r.notes ?? []).join('\n')}`, bad ? 'warn' : 'ok')
}

/** 把"有哪些格子、各该怎么填"显示出来（空表由主进程从 spec 派生）。 */
function renderBrief(r) {
  const empty = r.emptySlots ?? []
  $('formBrief').textContent = empty.length
    ? `没填到的格子（留空是正常的，可以手工补）：${empty.join('、')}`
    : '所有格子都填到了。'
}

function renderSlots(r) {
  const wrap = $('slotTable')
  wrap.innerHTML = ''
  if (fillState.slots.length === 0 && (r.rejected ?? []).length === 0) return

  const table = document.createElement('table')
  table.innerHTML = '<thead><tr><th style="width:26px"></th><th>格子</th><th>值</th><th>出处</th></tr></thead>'
  const tb = document.createElement('tbody')
  for (const s of fillState.slots) {
    const tr = document.createElement('tr')
    const tdChk = document.createElement('td')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = fillState.confirmed[s.path] === true
    cb.addEventListener('change', () => { fillState.confirmed[s.path] = cb.checked })
    tdChk.appendChild(cb)

    const tdPath = document.createElement('td')
    tdPath.className = 'mono'
    tdPath.textContent = s.path

    const tdVal = document.createElement('td')
    tdVal.textContent = typeof s.value === 'object' ? JSON.stringify(s.value) : String(s.value)

    const tdEv = document.createElement('td')
    tdEv.textContent = s.evidence ? s.evidence : '（这一格不需要出处）'
    tdEv.style.color = s.evidence ? '' : 'var(--dim)'
    // ★ 出处层级：这条约束是从哪一级信源来的（官方 / 社区 Wiki / 搜索）
    if (s.tierLabel) {
      const badge = document.createElement('span')
      badge.className = 'mono'
      badge.textContent = ` 【${s.tierLabel}】`
      badge.style.color = TIER_COLOR[s.tier] ?? 'var(--dim)'
      badge.title = s.tierTitle ? `出自：${s.tierTitle}${s.tierVia === 'value' ? '（按值反查）' : ''}` : ''
      tdEv.appendChild(badge)
    } else if (s.evidence) {
      const badge = document.createElement('span')
      badge.className = 'mono'
      badge.textContent = ' 【出处不明】'
      badge.style.color = 'var(--dim)'
      badge.title = '这一格的引文没能在取到的材料里定位到 —— 如实标出来，不硬安层级'
      tdEv.appendChild(badge)
    }

    tr.append(tdChk, tdPath, tdVal, tdEv)
    tb.appendChild(tr)
  }
  table.appendChild(tb)
  wrap.appendChild(table)

  if ((r.rejected ?? []).length) {
    const pre = document.createElement('pre')
    pre.className = 'mono'
    pre.style.whiteSpace = 'pre-wrap'
    pre.style.margin = '8px 0 0'
    pre.style.color = 'var(--err)'
    pre.textContent = '被拒掉的格子：\n' + r.rejected.map((x) => `  ${x.path} —— ${x.reason}`).join('\n')
    wrap.appendChild(pre)
  }
}

/** ③ 逐格确认后写入。 */
async function applyFill() {
  const base = fillState.base ?? current
  if (!base) { show('applyMsg', '还没有草稿卡', 'warn'); return }
  if (fillState.slots.length === 0) { show('applyMsg', '还没有填过表', 'warn'); return }
  const r = await petApi.applyFill({ card: base, lore: fillState.lore, slots: fillState.slots, confirmed: fillState.confirmed })
  if (!r.ok) {
    show('applyMsg', `写入失败：\n${(r.errors ?? []).join('\n')}`, 'err')
    return
  }
  current = r.card
  writeForm(r.card)
  renderExplain(r.card)
  const rejected = (r.rejected ?? []).length
  show('applyMsg', `已写入 ${r.applied} 格 ✅${rejected ? `（另 ${rejected} 格因出处不成立被拒）` : ''}`, rejected ? 'warn' : 'ok')
  show('rejectMsg', rejected ? r.rejected.map((x) => `· ${x.path}：${x.reason}`).join('\n') : '')
  show('gapHint', '已写入 —— 需要的话在下面②继续手工微调')
}

// ---------- ★ 三级信源：官方 → 社区 Wiki → 搜索 ----------
//
// 这一栏是"依次取用"的操作面板：配置三级各自的入口，一次把料取齐、填表、出提议。
// 结果区**逐级显示**（哪一级给了多少字、停在哪一级），外加每条提议的出处层级 ——
// 用户于是能判断：这张卡里哪些格子是有权威依据的，哪些只是网上有人说。

const TIER_COLOR = { official: '#7fc8a9', community: '#89b4e8', search: '#e0b060', unknown: 'var(--dim)' }

/** 多行文本 → 字符串数组（去空行与首尾空白）。 */
const lines = (v) => String(v ?? '').split('\n').map((s) => s.trim()).filter((s) => s !== '')
/** 逗号/中文逗号/空白分隔 → 字符串数组。 */
const words = (v) => String(v ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter((s) => s !== '')

const collectSources = () => ({
  officialUrls: lines($('srcOfficial').value),
  officialHosts: words($('srcHosts').value),
  communityBases: lines($('srcCommunity').value),
  enableSearch: $('srcSearch').checked,
  searchTemplate: $('srcTemplate').value.trim() || undefined,
  enoughChars: Number($('srcEnough').value) || undefined,
})

async function runSourceFill() {
  const base = fillState.base ?? await makeDraft()
  if (!base) return
  show('srcMsg', '按顺序取用信源…', '')
  const r = await petApi.fillCardFromSources({
    card: base,
    name: $('fName').value.trim() || undefined,
    game: $('fGame').value.trim() || undefined,
    ...collectSources(),
  })
  fillState.slots = r.proposals ?? []
  fillState.confirmed = Object.fromEntries(fillState.slots.map((s) => [s.path, true]))
  renderSlots(r)
  renderBrief(r)
  renderSourceReport(r)
  if (r.source === 'none') {
    show('srcMsg', `三级信源都没拿到正文：${(r.notes ?? []).join('\n')}`, 'err')
  } else {
    const bits = Object.entries(r.byTier ?? {}).map(([k, v]) => `${k} ${v} 格`).join('，')
    show('srcMsg', `填了 ${fillState.slots.length} 格（逐条出处：${bits || '—'}）`, 'ok')
  }
}

/** 把"逐级取用"的过程显示出来：哪一级有料、停在哪一级、为什么。 */
function renderSourceReport(r) {
  const wrap = $('srcReport')
  wrap.innerHTML = ''
  if (!r?.tiers?.length) return

  const table = document.createElement('table')
  table.innerHTML = '<thead><tr><th>顺序</th><th>信源</th><th>结果</th><th>说明</th></tr></thead>'
  const tb = document.createElement('tbody')
  for (const [i, t] of r.tiers.entries()) {
    const tr = document.createElement('tr')
    const mark = t.chars > 0 ? '✓ 取到' : (t.attempted ? '· 没取到' : '— 没跑')
    const cells = [
      { text: String(i + 1) },
      { text: t.label },
      { text: `${mark}　${t.chars} 字${t.sources ? `（${t.sources} 页）` : ''}`, cls: 'mono' },
      { text: (t.notes ?? []).join('；') },
    ]
    for (const c of cells) {
      const td = document.createElement('td')
      td.textContent = c.text
      if (c.cls) td.className = c.cls
      tr.appendChild(td)
    }
    tr.style.color = t.chars > 0 ? TIER_COLOR[t.id] : 'var(--dim)'
    tb.appendChild(tr)
  }
  table.appendChild(tb)
  wrap.appendChild(table)

  const foot = document.createElement('p')
  foot.className = 'hint'
  const stoppedLabel = r.tiers.find((t) => t.id === r.stoppedAt)?.label ?? r.stoppedAt
  foot.textContent = (r.stoppedAt
    ? `★ 停在「${stoppedLabel}」这一级 —— 累计材料已经够用，没有再去问下一级。`
    : '★ 三级都跑过了（没有哪一级让累计材料达到「够用」阈值）。')
    + `\n取到的页面：${(r.sources ?? []).map((s) => `${s.tier}:${s.title ?? s.url}`).join(' | ') || '无'}`
  foot.style.whiteSpace = 'pre-wrap'
  wrap.appendChild(foot)
}

$('btnSrcFill').addEventListener('click', () => runSourceFill().catch((e) => show('srcMsg', e.message, 'err')))
$('btnSrcSave').addEventListener('click', async () => {
  const r = await petApi.setSettings({ sources: collectSources() })
  show('srcMsg', r.ok ? '信源配置已保存' : `保存失败：${(r.errors ?? []).join('；')}`, r.ok ? 'ok' : 'err')
})

// ---------- 表单 ↔ 卡 ----------

function readForm() {
  let must = {}
  const rawMust = $('hMust').value.trim()
  if (rawMust) {
    try { must = JSON.parse(rawMust) } catch { must = undefined }
  }
  return {
    name: $('fName').value.trim(),
    game: $('fGame').value.trim(),
    temperament: $('fTemperament').value,
    address: $('fAddress').value.trim(),
    hard: {
      speechTics: listOf($('hTics').value),
      forbiddenWords: listOf($('hForbidden').value),
      avgLength: { min: Number($('hMin').value) || 4, max: Number($('hMax').value) || 40 },
      emojiPolicy: $('hEmoji').value,
      mustMention: must,
    },
    mustBroken: rawMust !== '' && must === undefined,
  }
}

function writeForm(card) {
  if (!card) return
  $('fName').value = card.name ?? ''
  $('fGame').value = card.game ?? ''
  $('fTemperament').value = card.animation?.temperament ?? 'calm'
  const h = card.persona?.hard ?? {}
  $('fAddress').value = Object.values(h.addresses ?? {})[0] ?? ''
  // soft 层（性格/背景/说话风格）不在这里编辑 —— 它们由①的填表流程写入。
  // 硬要放回输入框反而危险：手改的 soft 文本没有出处，会绕过证据核验那套机制。
  $('hTics').value = (h.speechTics ?? []).join(', ')
  $('hForbidden').value = (h.forbiddenWords ?? []).join(', ')
  $('hMin').value = h.avgLength?.min ?? 4
  $('hMax').value = h.avgLength?.max ?? 40
  $('hEmoji').value = h.emojiPolicy ?? 'none'
  $('hMust').value = Object.keys(h.mustMention ?? {}).length ? JSON.stringify(h.mustMention) : ''
  const soft = card.persona?.soft ?? {}
  const softLine = ['personality', 'background', 'speechStyle']
    .map((k) => (soft[k] ? `${k}：${String(soft[k]).slice(0, 24)}…` : `${k}：（空）`))
    .join(' · ')
  $('cardState').textContent = card.draft ? '草稿（硬约束待填）' : `已载入：${card.name}`
  $('cardState').className = `pill ${card.draft ? 'warn' : 'ok'}`
  $('gapHint').textContent = `soft 层：${softLine}`
}

/** 把表单 + 当前卡合成一张待校验的卡（f 段编辑的是 hard，其余沿用草稿）。 */
function compose() {
  const f = readForm()
  const base = current ?? { persona: { soft: {}, hard: {} }, animation: {} }
  return {
    ...base,
    id: base.id,
    name: f.name || base.name,
    game: f.game || base.game,
    draft: false,
    animation: { ...(base.animation ?? {}), temperament: f.temperament, style: base.animation?.style ?? 'soft' },
    persona: {
      soft: {
        ...(base.persona?.soft ?? {}),
        personality: f.personality || base.persona?.soft?.personality,
        speechStyle: f.speechStyle || base.persona?.soft?.speechStyle,
        background: f.lore || base.persona?.soft?.background,
      },
      hard: {
        ...f.hard,
        addresses: f.address ? { player: f.address } : (base.persona?.hard?.addresses ?? {}),
      },
    },
  }
}

// ---------- 动作 ----------

// ⚠ 这里原先有一份**渲染端自己的**草稿生成（localDraft/localGaps/simpleHash），
//   理由是"渲染端不能 import Node 模块"。那是一份**重复实现**：
//   它与 app/cardgen.mjs 的规则必须一致，但只要有人改了一边就会悄悄分叉
//   （而且两份产出的 id 算法若不慎改不同，同一张卡会得到两个 id）。
//   现在草稿由主进程的 `card:draft` 通道生成 —— 一份实现，两处使用。

// ---------- 校验与解释 ----------

let explainers = null
async function renderExplain(card) {
  const h = card?.persona?.hard ?? {}
  const rows = [
    ['speechTics', (h.speechTics ?? []).join('、') || '（空）', '单句没有不判错；整批都没出现会被统计出来'],
    ['forbiddenWords', (h.forbiddenWords ?? []).join('、') || '（空）', '出现即判失败 —— 过不了就不说话'],
    ['addresses', JSON.stringify(h.addresses ?? {}), '整句没用到只是警告'],
    ['avgLength', `${h.avgLength?.min}~${h.avgLength?.max} 字`, '按码点算；超出即判失败'],
    ['emojiPolicy', h.emojiPolicy, 'none 出现表情即失败；require 没有表情即失败'],
    ['mustMention', JSON.stringify(h.mustMention ?? {}), '声明了就必须出现'],
  ]
  const el = $('hardExplain')
  el.innerHTML = ''
  const t = document.createElement('table')
  const th = document.createElement('thead')
  th.innerHTML = '<tr><th>约束</th><th>当前值</th><th>会被怎么校验</th></tr>'
  t.appendChild(th)
  const tb = document.createElement('tbody')
  for (const [k, v, note] of rows) {
    const tr = document.createElement('tr')
    for (const [txt, cls] of [[k, 'mono'], [v, ''], [note, '']]) {
      const td = document.createElement('td'); td.textContent = txt; if (cls) td.className = cls; tr.appendChild(td)
    }
    tb.appendChild(tr)
  }
  t.appendChild(tb)
  el.appendChild(t)
  explainers = rows
}

async function validate() {
  const f = readForm()
  if (f.mustBroken) { show('validateMsg', '场景必提词不是合法 JSON', 'err'); return null }
  const card = compose()
  // ★ 「校验」**绝不能落盘** —— 最初图省事复用了 setCard（它保存），
  //   于是点一下"校验"就把半成品卡应用给桌宠了。这种"按钮名与副作用不符"的错很容易犯，
  //   所以单独开了一条只读通道 card:validate。
  renderExplain(card)
  const r = await petApi.validateCard(card)
  if (!r.ok) {
    show('validateMsg', `不通过：\n${r.errors.join('\n')}`, 'err')
    $('cardState').textContent = '校验不通过'
    $('cardState').className = 'pill err'
    return null
  }
  if (r.warnings?.length) show('validateMsg', `通过，但有提醒：\n${r.warnings.join('\n')}`, 'warn')
  else show('validateMsg', '通过 ✅（还没保存 —— 点「保存并应用」才会生效）', 'ok')
  current = r.card ?? card
  writeForm(current)
  renderExplain(current)
  return current
}

// ---------- 导入导出 ----------

async function exportCard() {
  const card = await petApi.getCard()
  if (!card) { show('ioMsg', '还没有卡可导出（先保存）', 'warn'); return }
  $('ioText').value = JSON.stringify(card, null, 2)
  show('ioMsg', '已导出到下面的文本框', 'ok')
}

async function importCard() {
  const text = $('ioText').value.trim()
  if (!text) { show('ioMsg', '先把 JSON 粘进来', 'warn'); return }
  let raw
  try { raw = JSON.parse(text) } catch (e) { show('ioMsg', `不是合法 JSON：${e.message}`, 'err'); return }
  const r = await petApi.setCard(raw)
  if (!r.ok) { show('ioMsg', `导入失败：\n${r.errors.join('\n')}`, 'err'); return }
  current = raw
  writeForm(raw)
  renderExplain(raw)
  show('ioMsg', `已导入并应用：${r.card?.name ?? raw.name}${r.warnings?.length ? `\n注意：${r.warnings.join('；')}` : ''}`, r.warnings?.length ? 'warn' : 'ok')
}

// ---------- 素材 ----------

async function buildArt(dryRun) {
  const src = $('artSource').value.trim()
  show('artMsg', '生成中…（程序化 provider 是纯本地计算，很快）', '')
  const r = await petApi.buildArt({ dryRun, sourcePath: src || null })
  const el = $('artResult')
  el.textContent = ''
  if (!r.ok) {
    show('artMsg', `不通过 ❌\n${(r.notes ?? []).join('\n')}`, 'err')
    return
  }
  const q = r.quality
  const lines = [
    `动作：${Object.keys(r.manifest.actions).join('、')}`,
    `provider：${r.manifest.provider} · 立绘来源：${r.manifest.source.kind}`,
    `动作间最小像素差：${q.minPairDiff.toFixed(4)}（阈值 ≥ ${0.01}）${q.worstPair ? ` 最接近的一对：${q.worstPair.join('/')}` : ''}`,
    `与立绘最大哈希距离：${q.maxSourceDistance}（上限 ≤ 24）${q.worstAction ? ` 最不像：${q.worstAction}` : ''}`,
  ]
  if (r.outDir) lines.push(`已写入：${r.outDir}`)
  show('artMsg', dryRun ? '试算通过 ✅（未落盘）' : '已生成 ✅', 'ok')
  const pre = document.createElement('pre')
  pre.className = 'mono'
  pre.style.whiteSpace = 'pre-wrap'
  pre.style.margin = '8px 0 0'
  pre.textContent = lines.join('\n')
  el.appendChild(pre)
}

// ---------- 绑定 ----------

// ① 填表式生成
$('btnDraft').addEventListener('click', () => { makeDraft().catch((e) => show('draftMsg', e.message, 'err')) })
$('btnFetch').addEventListener('click', () => { fetchLore().catch((e) => show('fillMsg', `抓取异常：${e.message}`, 'err')) })
$('btnFill').addEventListener('click', () => { runFill(false).catch((e) => show('fillMsg', e.message, 'err')) })
$('btnFillHeuristic').addEventListener('click', () => { runFill(true).catch((e) => show('fillMsg', e.message, 'err')) })
$('btnApply').addEventListener('click', () => { applyFill().catch((e) => show('applyMsg', e.message, 'err')) })
$('btnAll').addEventListener('click', () => {
  for (const s of fillState.slots) fillState.confirmed[s.path] = true
  renderSlots({})
})
$('btnNone').addEventListener('click', () => {
  for (const s of fillState.slots) fillState.confirmed[s.path] = false
  renderSlots({})
})

// ② 手工编辑
$('btnValidate').addEventListener('click', validate)
$('btnSaveCard').addEventListener('click', async () => {
  const card = await validate()
  if (!card) return
  const r = await petApi.setCard({ ...card, draft: false })
  if (!r.ok) { show('validateMsg', `保存失败：\n${r.errors.join('\n')}`, 'err'); return }
  $('cardState').textContent = `已应用：${r.card?.name ?? card.name}`
  $('cardState').className = 'pill ok'
  show('validateMsg', '已保存并应用 ✅（桌宠会立刻换用这张卡）', 'ok')
})
$('btnExport').addEventListener('click', exportCard)
$('btnImport').addEventListener('click', importCard)
$('btnArt').addEventListener('click', () => buildArt(false))
$('btnArtDry').addEventListener('click', () => buildArt(true))
$('btnClose').addEventListener('click', () => petApi.closeWindow())
$('btnSettings').addEventListener('click', () => petApi.openWindow('settings'))

/** 把已保存的信源配置回填到表单里。 */
function loadSources(settings) {
  const sc = settings?.sources
  if (!sc) return
  $('srcOfficial').value = (sc.officialUrls ?? []).join('\n')
  $('srcHosts').value = (sc.officialHosts ?? []).join(', ')
  $('srcCommunity').value = (sc.communityBases ?? []).join('\n')
  $('srcSearch').checked = sc.enableSearch !== false
  if (sc.searchTemplate) $('srcTemplate').value = sc.searchTemplate
  if (Number.isFinite(sc.enoughChars)) $('srcEnough').value = String(sc.enoughChars)
}

async function init() {
  const s = await petApi.snapshot()
  // 先把"表里有哪些格子"显示出来 —— 让用户一开始就看见格式是定死的
  try {
    const form = await petApi.cardForm()
    $('formBrief').textContent = `格式 ${form.format}：共 ${Object.keys(form.slots).length} 个格子（由 core/card-spec.mjs 定死）。`
  } catch { /* 显示不出来不影响主流程 */ }
  loadSources(s.settings)
  // 三级信源的说明从登记表来（不在渲染端重复写一份文案）
  try {
    const tiers = await petApi.listSourceTiers()
    if (Array.isArray(tiers) && tiers.length) {
      $('srcBox').querySelector('summary').textContent =
        `信源（依次取用：${tiers.map((t) => t.label).join(' → ')}）`
    }
  } catch { /* 拿不到就不改标题 */ }
  if (s.card) {
    const full = await petApi.getCard()
    current = full ?? null
    fillState.base = full ?? null
    writeForm(full ? { ...full, draft: false } : null)
    renderExplain(full)
  }
  const dir = s.settings?.game?.dir
  if (dir && !$('fGame').value) $('fGame').value = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}
init().catch((e) => show('draftMsg', `载入失败：${e.message}`, 'err'))
