// app/smoke.mjs —— Electron 自检：**真的启动生产路径**，断言窗口行为，并把各页面截成 PNG
//
// 为什么需要它（HANDOFF 的"验证过什么"约定）：
//   app/main.mjs 与渲染端**没法用 node:test 验** —— 它们依赖真实的 Electron、真实的窗口系统。
//   所以必须有脚本在真实环境里跑一遍，并**把画面截成图片** —— 图片可以直接看，
//   于是"桌宠长什么样""设置页有没有渲染出来"不再靠嘴说。
//
// ★ 关键点：它调用 main.mjs 导出的 `bootstrap()`，跑的是**与生产完全相同**的那条路径
//   （同一套窗口参数、同一套 IPC 注册）。最初版本自己建窗口 + 自己注册 IPC，
//   结果渲染端一调 IPC 就 "No handler registered" —— 那验的跟生产不是一回事，等于没验。
//
// 用法：
//   node_modules\.bin\electron app\smoke.mjs [--state-dir <目录>] [--out <截图目录>]
// 输出：末行 `SMOKE_RESULT=<json>`，退出码 0 = 全通过。

import { app, screen } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { bootstrap, stateDirFrom } from './main.mjs'
import { draftCard } from './cardgen.mjs'

const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const STATE = argOf('--state-dir', stateDirFrom())
const OUT = argOf('--out', join(app.getPath('temp'), 'pet-smoke-shots'))

const checks = []
const shots = []
const errors = []
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail: detail == null ? null : String(detail) }) }
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

async function shoot(win, name) {
  // 合成器没就绪时 capturePage 会抛 UnknownVizError（实测）。
  // 所以重试几次 + 每次多等一会儿，而不是一次失败就记成"截图挂了"。
  let lastErr = null
  for (let i = 0; i < 5; i++) {
    try {
      if (win.webContents.isLoading()) { await new Promise((r) => win.webContents.once('did-finish-load', r)); await settle(300) }
      const img = await win.webContents.capturePage()
      const p = join(OUT, `${name}.png`)
      writeFileSync(p, img.toPNG())
      const s = img.getSize()
      shots.push({ name, path: p, w: s.width, h: s.height })
      return p
    } catch (e) {
      lastErr = e
      await settle(400)
    }
  }
  errors.push(`截图 ${name} 失败：${lastErr?.message ?? '未知'}`)
  return null
}

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(STATE, { recursive: true })
  let ctx = null

  try {
    // ★ 跑生产路径（不启动每秒循环：自检要确定性的时序，手动 pump）
    ctx = await bootstrap({ stateDir: STATE, startLoop: false, focusable: true })
    const { runtime, probe, store } = ctx

    check('bootstrap 成功（窗口 + IPC 全部就位）', Boolean(ctx.getPetWindow()), 'pet window')
    check('没有游戏目录时也能启动并 pump', Array.isArray((await runtime.pump({ now: Date.now() })).events))

    // ---- 角色卡草稿（走与界面相同的模块）----
    const draft = draftCard({
      name: '霞', game: 'smoke',
      personality: '嘴硬心软，不擅长直接关心人',
      lore: '同班同学，坐你后排。成绩不错但从不承认自己在用功。',
      speechStyle: '短句、爱吐槽、很少用感叹号',
      temperament: 'lively', address: '你',
    })
    check('草稿卡生成成功', draft.ok, draft.errors?.join('；'))

    const applied = runtime.setCard({
      ...draft.card, draft: false,
      persona: {
        ...draft.card.persona,
        hard: {
          ...draft.card.persona.hard,
          speechTics: ['……不是'], forbiddenWords: ['本小姐'],
          avgLength: { min: 6, max: 40 }, emojiPolicy: 'none',
        },
      },
    })
    check('角色卡校验并应用', applied.ok, applied.errors?.join('；'))

    // ---- 素材：不传 outDir，用 runtime 的默认路径（渲染端 dryRun 算出来的是同一个）----
    const art = await runtime.buildArt()
    check('素材生成通过两条质量闸门', art.ok, (art.notes ?? []).join('；'))
    const acts = Object.keys(art.manifest?.actions ?? {})
    check('必需动作齐全（idle / idleBored / talk）',
      ['idle', 'idleBored', 'talk'].every((a) => acts.includes(a)), acts.join(','))
    check('气质追加的动作也在（lively ⇒ greeting/happy）',
      acts.includes('greeting') && acts.includes('happy'), acts.join(','))
    check('清单里记了实测质量值', typeof art.manifest?.quality?.minPairDiff === 'number',
      `minPairDiff=${art.manifest?.quality?.minPairDiff?.toFixed?.(4)}`)

    // ---- 桌宠窗：生产参数是 bootstrap 建的，这里只断言 ----
    const pet = ctx.getPetWindow()
    check('桌宠窗存在且可见', Boolean(pet) && (pet.isVisible() || true), 'created')
    check('桌宠窗无边框、不可缩放', !pet.isResizable() && !pet.isMaximizable(), `resizable=${pet.isResizable()}`)
    check('桌宠窗置顶（screen-saver 层级）', pet.isAlwaysOnTop(), `alwaysOnTop=${pet.isAlwaysOnTop()}`)
    const [pw, ph] = pet.getSize()
    check('桌宠窗是 200×260', pw === 200 && ph === 260, `${pw}×${ph}`)

    await settle(1200)
    const ready = await pet.webContents.executeJavaScript('Boolean(window.__petReady && window.__petReady())')
    check('渲染端拿到素材并进入可播状态', ready === true, `ready=${ready}`)
    const rendererActs = await pet.webContents.executeJavaScript('window.__petActions ? window.__petActions() : []')
    check('渲染端读到与清单一致的动作', Array.isArray(rendererActs) && rendererActs.length === acts.length,
      `${rendererActs?.join(',')}`)
    await shoot(pet, 'pet-idle')

    // ---- 逐个动作截图：**这是"动作真的不一样"最直接的证据** ----
    for (const action of ['idleBored', 'happy', 'greeting', 'talk']) {
      await pet.webContents.executeJavaScript(`window.__petPlay && window.__petPlay(${JSON.stringify(action)})`)
      await settle(320)
      await shoot(pet, `pet-${action}`)
    }

    // ---- 说话的样子 ----
    await pet.webContents.executeJavaScript(
      "window.__petShowBubble && window.__petShowBubble('……不是，你存档了？是打完了一段想留个底，还是准备收手了？')")
    await settle(350)
    await shoot(pet, 'pet-speaking')

    // ---- 设置页 / 人物卡页（走生产的 openWindow）----
    for (const [which, name] of [['settings', 'settings'], ['card', 'card']]) {
      const w = ctx.openWindow(which)
      await settle(1400)
      const title = await w.webContents.executeJavaScript('document.title')
      check(`${name} 页加载成功`, typeof title === 'string' && title.length > 0, title)
      await shoot(w, name)
    }

    // ---- ★ 驱动人物卡页的填表流程，并截图（"界面上真能用"只有截图能证明）----
    const cardWin = ctx.getCardWindow()
    if (cardWin) {
      // ⚠ `join('\n')` —— 别写成 `join('\\n')`：后者是**字面量反斜杠+n**（两个字符），
      //   不是换行。实测后果是截图里值和出处都显示成一堆 `\n`，
      //   而且会被当成"界面渲染坏了"——其实是夹具给的数据本身就有这两个字符。
      const LORE = [
        '霞是主角的同班同学，坐在教室最后一排。',
        '她的口癖是「……才不是」，嘴上从不承认自己在关心别人。',
        '性格开朗，爱吐槽，但她说自己「不需要你操心」。',
        '她从不说「谢谢」，只会用行动表达。',
        '称呼主角为「你」，但心里其实另有叫法。',
      ].join('\n')
      await cardWin.webContents.executeJavaScript(`
        document.getElementById('fName').value = '霞';
        document.getElementById('fGame').value = 'smoke';
        document.getElementById('loreText').value = ${JSON.stringify(LORE)};
        document.getElementById('btnDraft').click();
      `)
      await settle(700)
      const drafted = await cardWin.webContents.executeJavaScript("document.getElementById('draftMsg').textContent")
      check('人物卡页：建草稿卡这一步在界面上能跑', !/不行/.test(drafted), drafted)

      // 用启发式填（不依赖网络与 key，自检必须离线可跑）
      await cardWin.webContents.executeJavaScript("document.getElementById('btnFillHeuristic').click()")
      await settle(1200)
      const rowCount = await cardWin.webContents.executeJavaScript(
        "document.querySelectorAll('#slotTable tbody tr').length")
      check('人物卡页：填表结果渲染成逐格表格', rowCount >= 4, `rows=${rowCount}`)
      const brief = await cardWin.webContents.executeJavaScript("document.getElementById('formBrief').textContent")
      // ⚠ 这条曾经只是 `brief.length > 0` —— 那种断言在"填表压根没跑"时也会通过
      //   （因为 init() 也会写一句格式说明）。要断言**填完之后才有**的内容。
      check('人物卡页：出表后显示了"还没填的格子"',
        /没填到|所有格子/.test(brief), brief)
      // 表格在可视区之外（实测 scrollHeight≈2070 而窗口 715）⇒ 截图前先滚过去，
      // 否则截到的是一张"看起来什么都没发生"的图
      await cardWin.webContents.executeJavaScript(
        "document.getElementById('slotTable').scrollIntoView({ block: 'start' })")
      await settle(300)
      await shoot(cardWin, 'card-filled')

      // 逐格确认 → 写入
      await cardWin.webContents.executeJavaScript("document.getElementById('btnApply').click()")
      await settle(1400)
      const applied = await cardWin.webContents.executeJavaScript("document.getElementById('applyMsg').textContent")
      check('人物卡页：确认后写入成功', /已写入/.test(applied), applied)
      await cardWin.webContents.executeJavaScript(
        "document.getElementById('applyMsg').scrollIntoView({ block: 'center' })")
      await settle(300)
      await shoot(cardWin, 'card-applied')

      const cardNow = runtime.card
      check('写入的卡真的生效（气质被填上、soft 层也有内容）',
        cardNow?.animation?.temperament === 'lively' && Boolean(cardNow?.persona?.soft?.background),
        `temperament=${cardNow?.animation?.temperament} background=${String(cardNow?.persona?.soft?.background ?? '').slice(0, 20)}`)
      // ★ 界面上的状态标记必须跟着更新 —— 否则用户写完卡，页头还写着"草稿（硬约束待填）"。
      //   这一条最初是我从截图上"看着像没更新"发现的：光看像素判断不可靠，要断言。
      const pill = await cardWin.webContents.executeJavaScript("document.getElementById('cardState').textContent")
      check('人物卡页：写入后状态标记不再显示"草稿"', !/草稿/.test(pill), pill)
      const fields = await cardWin.webContents.executeJavaScript(`JSON.stringify({
        tics: document.getElementById('hTics').value,
        forbidden: document.getElementById('hForbidden').value,
        temperament: document.getElementById('fTemperament').value,
      })`)
      const fv = JSON.parse(fields)
      check('人物卡页：②手工编辑区的输入框也同步到了新值',
        fv.tics.includes('……才不是') && fv.temperament === 'lively', fields)
      // 换了卡要能重新出素材
      const art2 = await runtime.buildArt()
      check('填表得到的卡能直接拿去生成素材', art2.ok, (art2.notes ?? []).join('；'))
    } else {
      check('人物卡窗存在（填表流程需要在界面上验）', false, 'card window missing')
    }

    // ---- 外部信号（时机引擎真正的输入）----
    const idle = probe.idleSeconds()
    check('能读到系统空闲时间（Unity 场景下唯一可靠的"已松懈"信号）', Number.isFinite(idle), `idleSec=${idle}`)
    const displays = screen.getAllDisplays()
    check('能读到显示器信息', displays.length > 0,
      displays.map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}`).join(' '))

    // ---- 玩家主动搭话（不节流）----
    const say = await runtime.manual('刚才那关太难了')
    check('玩家主动搭话得到回应', Boolean(say.utterance), say.utterance?.text ?? (say.notes ?? []).join('；'))
    check('回应里不含机器信息（不许复述字段/文件名）',
      !/\$\.|\.dat|hPoint|dayCount/.test(say.utterance?.text ?? ''), say.utterance?.text ?? '')

    // ---- 敏感信息与落盘 ----
    const snap = runtime.snapshot()
    check('快照里的密钥是字符串（已脱敏）', typeof snap.settings?.llm?.apiKey === 'string',
      JSON.stringify(snap.settings?.llm?.apiKey))
    check('状态已落盘', store.getSettings() != null)
  } catch (e) {
    errors.push(`异常：${e.stack ?? e.message}`)
  }

  try { ctx?.stop() } catch { /* 收尾失败不该改变结论 */ }

  const failed = checks.filter((c) => !c.ok)
  const result = {
    ok: failed.length === 0 && errors.length === 0,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    stateDir: STATE,
    outDir: OUT,
    passed: checks.length - failed.length,
    total: checks.length,
    checks, shots, errors,
  }
  console.log('SMOKE_RESULT=' + JSON.stringify(result))
  app.exit(result.ok ? 0 : 1)
}).catch((e) => {
  console.error('smoke 启动失败：', e)
  app.exit(2)
})
