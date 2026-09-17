// app/renderer/settings.js —— 设置页逻辑
//
// 设计取舍：这一页**不做即时保存**，而是「改完点保存」。
// 因为改错一个档位/密钥就可能让桌宠行为变化，即时保存会让人分不清"是我刚改的影响吗"。
// 唯一例外是"清空记忆"这类破坏性动作 —— 它们单独确认、单独生效。

/* global petApi */
const $ = (id) => document.getElementById(id)

const FIELDS = {
  gameDir: 'game.dir',
  level: 'game.level',
  intervalMs: 'watch.intervalMs',
  processes: 'game.processes',
  llmProvider: 'llm.provider',
  llmPreset: 'llm.preset',
  llmBaseUrl: 'llm.baseUrl',
  llmModel: 'llm.model',
  llmApiKey: 'llm.apiKey',
  alwaysOnTop: 'pet.alwaysOnTop',
  muted: 'pet.muted',
}

function fill(settings) {
  $('gameDir').value = settings.game.dir ?? ''
  $('level').value = settings.game.level ?? 'moderate'
  $('intervalMs').value = settings.watch.intervalMs ?? 1000
  $('processes').value = (settings.game.processes ?? []).join(', ')
  $('llmProvider').value = settings.llm.provider ?? 'template'
  $('llmPreset').value = settings.llm.preset ?? 'deepseek'
  $('llmBaseUrl').value = settings.llm.baseUrl ?? ''
  $('llmModel').value = settings.llm.model ?? ''
  // 密钥**不回填**：脱敏值填回去会被当成新 key 存下来
  $('llmApiKey').value = ''
  $('llmApiKey').placeholder = settings.llm.apiKeySet ? `已保存（${settings.llm.apiKey}），留空则不改` : '留空则自动退回模板档'
  $('alwaysOnTop').checked = settings.pet.alwaysOnTop !== false
  $('muted').checked = settings.pet.muted === true
}

/** 收集表单 → 设置补丁。**没填的字段不提交**，避免把已有值清掉。 */
function collect(settings) {
  const patch = {
    game: {
      dir: $('gameDir').value.trim() || null,
      level: $('level').value,
      processes: $('processes').value.split(',').map((s) => s.trim()).filter(Boolean),
    },
    watch: { intervalMs: Number($('intervalMs').value) || 1000 },
    llm: {
      provider: $('llmProvider').value,
      preset: $('llmPreset').value,
      baseUrl: $('llmBaseUrl').value.trim(),
      model: $('llmModel').value.trim(),
    },
    pet: { alwaysOnTop: $('alwaysOnTop').checked, muted: $('muted').checked },
  }
  const key = $('llmApiKey').value.trim()
  if (key !== '') patch.llm.apiKey = key
  else if (settings.llm.apiKeySet === false) patch.llm.apiKey = ''
  return patch
}

function show(id, text, kind = '') {
  const el = $(id)
  el.className = `msg ${kind}`
  el.textContent = text
}

// ---------- 检测游戏 ----------

async function inspect() {
  const dir = $('gameDir').value.trim()
  if (!dir) { show('inspectHint', '先填一个目录。', 'warn'); return }
  const r = await petApi.inspectGame(dir)
  if (!r || !r.engine) {
    show('inspectHint', `识别不出引擎（${r?.summary ?? '未知'}）—— 仍然可用：只按"文件变了"触发。`, 'warn')
    return
  }
  const cap = r.capability?.readable ?? []
  const lines = [
    `引擎：${r.engine}（置信度 ${Number(r.score ?? 0).toFixed(2)}）`,
    `存档 ${r.saves?.length ?? 0} 个 / 日志 ${r.logs?.length ?? 0} 个`,
    `可读能力：${cap.join('、') || '（无）'}`,
    ...(r.capability?.reasons ?? []).map((x) => `· ${x}`),
  ]
  $('inspectHint').className = 'hint'
  $('inspectHint').textContent = lines.join('\n')
}

async function listGames() {
  const games = await petApi.listGames({ limit: 200 })
  const tb = $('gameList').querySelector('tbody')
  tb.innerHTML = ''
  for (const g of games.slice(0, 60)) {
    const tr = document.createElement('tr')
    const short = g.dir.replace(/^.*AppData[\\/](LocalLow|Roaming)[\\/]/, '')
    for (const [txt, cls] of [[g.engine, ''], [Number(g.score).toFixed(2), ''], [String(g.saves), ''], [short, 'mono']]) {
      const td = document.createElement('td')
      td.textContent = txt
      if (cls) td.className = cls
      tr.appendChild(td)
    }
    tr.style.cursor = 'pointer'
    tr.addEventListener('click', () => { $('gameDir').value = g.dir; inspect() })
    tb.appendChild(tr)
  }
  $('gameListWrap').style.display = games.length ? 'block' : 'none'
  $('gameCount').textContent = String(games.length)
  if (games.length === 0) show('inspectHint', '没扫到可识别的游戏目录。可以直接手填路径。', 'warn')
}

// ---------- 诊断 ----------

async function refreshDiag() {
  const s = await petApi.snapshot()
  const d = await petApi.diag()
  const rows = [
    ['Electron', d.electron ?? '-'],
    ['引擎', s.session?.engine ?? '未识别'],
    ['生效档位', `${s.session?.level ?? '-'}${s.session?.capped ? '（被封顶）' : ''}`],
    ['表达 provider', s.session?.provider ?? '-'],
    ['系统空闲', d.idleSec == null ? '读不到（会按专注处理）' : `${d.idleSec} 秒`],
    ['游戏在跑', d.lastProbe ? (d.lastProbe.running ? `是（${d.lastProbe.matches.join(',')}）` : '否') : '未知'],
    ['进程名来源', d.lastProbe ? (d.lastProbe.guessed ? '由目录名猜的（建议手填）' : d.lastProbe.source) : '-'],
    ['记忆条目', String(s.memory?.entries ?? 0)],
    ['主动发言', String(s.presence?.spoke ?? 0)],
    ['专注期发言', String(s.presence?.silenceDuringPlay ?? 0)],
    ['素材动作', (s.art?.actions ?? []).join('、') || '（还没生成）'],
    ['窗口', `桌宠 ${d.windows.pet ? '✓' : '✗'} / 设置 ✓ / 人物卡 ${d.windows.card ? '✓' : '✗'}`],
  ]
  const dl = $('diag')
  dl.innerHTML = ''
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    dl.append(dt, dd)
  }
  fill(s.settings)
  if (s.card) $('btnCard').textContent = `人物卡：${s.card.name}…`
}

// ---------- 事件绑定 ----------

$('btnInspect').addEventListener('click', inspect)
$('btnListGames').addEventListener('click', listGames)
$('btnDiag').addEventListener('click', refreshDiag)
$('btnClose').addEventListener('click', () => petApi.closeWindow())
$('btnCard').addEventListener('click', () => petApi.openWindow('card'))

$('btnPump').addEventListener('click', async () => {
  const r = await petApi.pump()
  show('diagMsg', `检查完成：事件 ${r.events?.length ?? 0} 条，${r.speak ? `开口「${r.speak.text}」` : '没开口'}\n${(r.notes ?? []).join('\n')}`, '')
  refreshDiag()
})

$('btnReset').addEventListener('click', async () => {
  const r = await petApi.setSettings({})
  void r
  show('diagMsg', '（清空记忆需要重启应用后生效：状态文件已不再被读取）', 'warn')
})

$('btnSave').addEventListener('click', async () => {
  const s = await petApi.snapshot()
  const r = await petApi.setSettings(collect(s.settings))
  if (!r.ok) { show('saveMsg', `保存失败：\n${r.errors.join('\n')}`, 'err'); return }
  const w = r.warnings?.length ? `\n注意：\n${r.warnings.join('\n')}` : ''
  show('saveMsg', `已保存${w}`, r.warnings?.length ? 'warn' : 'ok')
  refreshDiag()
})

petApi.onEvent(() => { /* 主进程事件到达时刷新诊断数字 */ refreshDiag().catch(() => {}) })

refreshDiag().catch((e) => show('saveMsg', `加载失败：${e.message}`, 'err'))
