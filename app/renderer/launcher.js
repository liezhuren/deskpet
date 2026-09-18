// app/renderer/launcher.js —— 启动器页 + 工具确认面板
//
// 这一页有两个身份：
//   ① **启动器**：发现游戏、启动游戏、把存档目录设为监视对象
//   ② **模型那只手的刹车**：所有 confirm 级工具都挂在这里等人点头
//
// 设计上刻意让"待确认"排在最上面：它是**需要人介入**的东西，
// 而列表中已完成的事只是记录。把需要行动的事压在下面等于没有。

/* global petApi */
const $ = (id) => document.getElementById(id)

function show(id, text, kind = '') {
  const el = $(id)
  if (!el) return
  el.className = `msg ${kind}`
  el.textContent = text
}

function table(headers, rows, onRow) {
  const t = document.createElement('table')
  const th = document.createElement('thead')
  const tr = document.createElement('tr')
  for (const h of headers) { const c = document.createElement('th'); c.textContent = h; tr.appendChild(c) }
  th.appendChild(tr); t.appendChild(th)
  const tb = document.createElement('tbody')
  for (const r of rows) {
    const row = document.createElement('tr')
    for (const cell of r.cells) {
      const td = document.createElement('td')
      td.textContent = cell.text ?? String(cell)
      if (cell.cls) td.className = cell.cls
      row.appendChild(td)
    }
    if (onRow) { row.style.cursor = 'pointer'; row.addEventListener('click', () => onRow(r)) }
    tb.appendChild(row)
  }
  t.appendChild(tb)
  return t
}

// ---------- ① 待确认 ----------

async function refreshPending() {
  const st = await petApi.toolState()
  const wrap = $('pending')
  wrap.textContent = ''
  const list = st.pending ?? []
  if (list.length === 0) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = '（没有待确认的请求）'
    wrap.appendChild(p)
    return st
  }
  for (const item of list) {
    const box = document.createElement('div')
    box.style.border = '1px solid #5c4a2a'
    box.style.borderRadius = '8px'
    box.style.padding = '8px 10px'
    box.style.marginBottom = '8px'
    const title = document.createElement('div')
    title.innerHTML = `<span class="mono">${item.name}</span>　${JSON.stringify(item.args)}`
    const why = document.createElement('p')
    why.className = 'hint'
    why.textContent = item.reason ? `理由：${item.reason}` : '（模型没给理由）'
    const row = document.createElement('div')
    row.className = 'row tight'
    const ok = document.createElement('button')
    ok.className = 'primary'
    ok.textContent = '同意并执行'
    ok.addEventListener('click', async () => {
      const r = await petApi.approveTool(item.id)
      const inner = r?.result?.ok === false ? `执行了但被拒：${r.result.error}` : '已执行'
      show('scanMsg', `${item.name} —— ${inner}`, r?.result?.ok === false ? 'warn' : 'ok')
      refreshAll()
    })
    const no = document.createElement('button')
    no.className = 'ghost'
    no.textContent = '拒绝'
    no.addEventListener('click', async () => {
      await petApi.rejectTool(item.id, '用户在启动器里拒绝')
      show('scanMsg', `已拒绝 ${item.name}`, 'warn')
      refreshAll()
    })
    row.append(ok, no)
    box.append(title, why, row)
    wrap.appendChild(box)
  }
  return st
}

// ---------- ② 可启动清单 ----------

async function refreshLaunchables() {
  const includeSteam = $('optSteam').checked
  const r = await petApi.listLaunchables({ includeSteam })
  const wrap = $('launchables')
  wrap.textContent = ''
  if (!r.items || r.items.length === 0) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = '没有可启动的游戏。加到「收藏」后就会出现在这里；也可以在下面把某个存档目录加进来。'
    wrap.appendChild(p)
  } else {
    const rows = r.items.map((it) => ({
      item: it,
      cells: [
        { text: it.name },
        { text: it.launchable ? it.exeName : '（无 exe）', cls: 'mono' },
        { text: it.source === 'favorite' ? '收藏' : '扫描' },
        { text: it.launchable ? '可启动' : '仅监视' },
      ],
    }))
    wrap.appendChild(table(['名称', '可执行文件', '来源', '状态'], rows, async (row) => {
      const it = row.item
      if (!it.launchable) { show('scanMsg', `「${it.name}」没有登记 exe ⇒ 只能监视，不能启动`, 'warn'); return }
      const r2 = await petApi.launchApp({ id: it.id })
      if (r2.needsConfirm) { show('scanMsg', `启动「${it.name}」需要确认`, 'warn'); refreshAll(); return }
      if (!r2.ok) { show('scanMsg', `启动失败：${r2.error}`, 'err'); return }
      show('scanMsg', `已启动 ${it.name}${(r2.notes ?? []).length ? ` —— ${r2.notes.join('；')}` : ''}`, 'ok')
      refreshAll()
    }))
    const note = document.createElement('p')
    note.className = 'hint'
    note.textContent = `清单 ${r.items.length} 项 · 收藏 ${r.favorites} 项 · 扫描根目录 ${r.roots} 个`
    wrap.appendChild(note)
  }
  for (const n of r.notes ?? []) show('scanMsg', n, 'warn')
  return r
}

// ---------- ③ 本机游戏目录 ----------

async function listGames() {
  show('gamesMsg', '扫描中…')
  const games = await petApi.listGames({ limit: 200 })
  const wrap = $('games')
  wrap.textContent = ''
  if (!games.length) { show('gamesMsg', '没扫到可识别的游戏目录', 'warn'); return }
  const rows = games.map((g) => ({
    game: g,
    cells: [
      { text: g.engine ?? '未识别' },
      { text: String(g.saves ?? 0) },
      { text: g.dir.replace(/^.*AppData[\\/](LocalLow|Roaming)[\\/]/, ''), cls: 'mono' },
    ],
  }))
  wrap.appendChild(table(['引擎', '存档', '目录'], rows, async (row) => {
    const g = row.game
    // 设为监视对象（读日志与存档）。exe 无从得知就先留空。
    const r = await petApi.setSettings({ game: { dir: g.dir } })
    show('gamesMsg', r.ok ? `已设为监视对象：${g.dir}` : `设置失败：${(r.errors ?? []).join('；')}`, r.ok ? 'ok' : 'err')
    // 顺便加进收藏（这样它也会出现在启动清单里，虽然可能没有 exe）
    await petApi.toggleFavorite({ dir: g.dir, name: g.dir.split(/[\\/]/).pop() })
    refreshAll()
  }))
  show('gamesMsg', `共 ${games.length} 个`, 'ok')
}

// ---------- ④ 工具审计 ----------

function renderToolStats(st) {
  const dl = $('toolStats')
  dl.innerHTML = ''
  const rows = [
    ['总调用', st.total],
    ['成功', st.ok],
    ['待人确认', st.needsConfirm],
    ['已拒绝', st.rejected],
    ['被限流', st.throttled],
    ['参数不合法', st.invalid],
    ['实现出错', st.error],
    ['当前待确认', st.pending],
  ]
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = String(v)
    dl.append(dt, dd)
  }
}

function renderToolHistory(st) {
  const wrap = $('toolHistory')
  wrap.textContent = ''
  const h = (st.history ?? []).slice().reverse()
  if (!h.length) {
    const p = document.createElement('p'); p.className = 'hint'; p.textContent = '（还没有工具调用）'
    wrap.appendChild(p); return
  }
  const rows = h.map((x) => ({
    cells: [
      { text: new Date(x.at).toLocaleTimeString('zh-CN') },
      { text: x.name ?? '—', cls: 'mono' },
      { text: x.decision, cls: x.decision === 'ok' ? 'mono' : '' },
      { text: x.args ? JSON.stringify(x.args).slice(0, 60) : '' },
      { text: (x.reasons ?? []).join('；').slice(0, 60) },
    ],
  }))
  wrap.appendChild(table(['时间', '工具', '结果', '参数', '说明'], rows))
}

// ---------- 汇总刷新 ----------

async function refreshAll() {
  const st = await refreshPending()
  if (st) { renderToolStats(st.stats ?? {}); renderToolHistory(st) }
  const snap = await petApi.snapshot()
  const t = snap.diag?.tools
  $('sum').textContent = `工具 ${t ? `${t.ok}/${t.total}` : '—'} · 待人确认 ${st?.pending?.length ?? 0}`
  await refreshLaunchables()
}

$('btnScan').addEventListener('click', () => refreshAll().catch((e) => show('scanMsg', e.message, 'err')))
$('optSteam').addEventListener('change', () => refreshLaunchables().catch(() => {}))
$('btnGames').addEventListener('click', () => listGames().catch((e) => show('gamesMsg', e.message, 'err')))
$('btnClose').addEventListener('click', () => petApi.closeWindow())
$('btnSettings').addEventListener('click', () => petApi.openWindow('settings'))
$('btnCards').addEventListener('click', () => petApi.openWindow('card'))

petApi.onEvent((ev) => {
  // 有待确认 / 启动结果 / 工具执行时自动刷新 —— 用户不用手动点
  if (['session-end', 'launch', 'settings', 'card', 'stopped'].includes(ev.type)) refreshAll().catch(() => {})
  else if (ev.type === 'pump' && (ev.action || ev.speak)) return
  else refreshPending().then((st) => { if (st) { renderToolStats(st.stats ?? {}); renderToolHistory(st) } }).catch(() => {})
})

refreshAll().catch((e) => show('scanMsg', `加载失败：${e.message}`, 'err'))
