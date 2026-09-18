// tests/tools.test.mjs —— LLM 6 工具（契约 + 执行器）与启动器
//
// 这一层是全项目**唯一会执行外部程序**的地方，所以测试的重点不是"能不能启动"，
// 而是"**能不能拦住不该启动的**"：
//   · 未登记的目标 → 必须拒（模型不能构造路径）
//   · 黑名单（卸载器/运行库/崩溃处理器）→ 永远拒
//   · 需要确认而没批准 → 挂成待确认，**绝不执行**
//   · 参数里带 shell 元字符 → 不经过 shell，所以无害
// 以及一条工程底线：**失控的模型循环不许把窗口挪 100 次**（限流）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  TOOLS, TOOL_NAMES, TOOL_RISK, PARAM_TYPES, toolByName, needsConfirm,
  validateToolCall, buildToolsPrompt, parseToolCalls, describeTool,
} from '../core/tools.mjs'
import { createToolRunner, missingHandlers, TOOL_DEFAULTS } from '../app/tools.mjs'
import {
  LAUNCHER_DEFAULTS, DENY_EXE_PATTERNS, isDeniedExe, parseLibraryFolders, steamLibraryRoots,
  findExecutables, pickMainExe, launchableId, buildLaunchables, resolveLaunchTarget, launch, matchWatchDir,
} from '../app/launcher.mjs'

const T0 = 1_700_000_000_000

// ══════════════════ A. 工具契约 ══════════════════

test('★ 六个工具都在，且是登记过的闭集', () => {
  assert.equal(TOOLS.length, 6)
  for (const n of ['move_to', 'pet', 'interact', 'launch_app', 'cancel', 'generate_character_card']) {
    assert.ok(TOOL_NAMES.includes(n), `缺少工具 ${n}`)
  }
  assert.equal(new Set(TOOL_NAMES).size, 6)
  assert.ok(Object.isFrozen(TOOLS))
})

test('★ 每个工具都要交代清楚：名字 / 中文名 / 干什么 / 什么时候用 / 参数', () => {
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `${t.name} 不像工具名`)
    assert.ok(t.label.length > 0, `${t.name} 缺中文名`)
    assert.ok(t.desc.length >= 8, `${t.name} 说明太短（模型要靠它决定用不用）`)
    assert.ok(t.when && t.when.length > 4, `${t.name} 没写"什么时候用"`)
    assert.ok([TOOL_RISK.SAFE, TOOL_RISK.CONFIRM].includes(t.risk), `${t.name} 的危险分级不合法`)
    for (const s of t.params) {
      assert.ok(PARAM_TYPES.includes(s.type), `${t.name}.${s.name} 类型不合法`)
      assert.ok(s.desc.length > 0, `${t.name}.${s.name} 缺说明`)
      if (s.type === 'enum') assert.ok(Array.isArray(s.values) && s.values.length > 0)
    }
  }
})

test('★ 危险分级：只影响桌宠自己的是 safe，会动到桌宠之外的是 confirm', () => {
  assert.equal(toolByName('move_to').risk, TOOL_RISK.SAFE)
  assert.equal(toolByName('pet').risk, TOOL_RISK.SAFE)
  assert.equal(toolByName('interact').risk, TOOL_RISK.SAFE)
  assert.equal(toolByName('cancel').risk, TOOL_RISK.SAFE)
  assert.equal(toolByName('launch_app').risk, TOOL_RISK.CONFIRM, '启动程序必须确认')
  assert.equal(toolByName('generate_character_card').risk, TOOL_RISK.CONFIRM, '改角色卡必须确认')
})

test('★ 未登记的工具按"要确认"处理（漏判成安全的代价更大）', () => {
  assert.equal(needsConfirm('launch_app'), true)
  assert.equal(needsConfirm('move_to'), false)
  assert.equal(needsConfirm('根本不存在的工具'), true)
  assert.equal(needsConfirm(null), true)
})

// ══════════════════ B. 参数校验 ══════════════════

test('★ 校验：缺工具名 / 未登记 / 被禁用', () => {
  assert.equal(validateToolCall({}).ok, false)
  assert.match(validateToolCall({}).errors[0], /缺少工具名/)
  const un = validateToolCall({ name: 'rm_rf' })
  assert.equal(un.ok, false)
  assert.match(un.errors[0], /未登记的工具/)
  assert.equal(validateToolCall({ name: 'move_to', args: { x: 1, y: 1 } }, { allowlist: ['pet'] }).ok, false)
  assert.equal(validateToolCall({ name: 'pet', args: {} }, { allowlist: ['pet'] }).ok, true)
})

test('★ 校验：必填缺失 / args 不是对象', () => {
  const r = validateToolCall({ name: 'move_to', args: { x: 1 } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('缺必填参数') || e.includes('缺少必填参数') && e.includes('y')), r.errors.join(' | '))
  assert.equal(validateToolCall({ name: 'move_to', args: [] }).ok, false)
  assert.equal(validateToolCall({ name: 'move_to', args: 'x' }).ok, false)
  assert.equal(validateToolCall({ name: 'move_to' }).ok, false, '完全没有 args 也该报缺参数')
})

test('★ 校验：无歧义的笔误修掉，有歧义的报错', () => {
  // 字符串数字 ⇒ 数字（模型常见写法）
  const r1 = validateToolCall({ name: 'move_to', args: { x: '1600', y: '800' } })
  assert.equal(r1.ok, true)
  assert.deepEqual(r1.call.args, { x: 1600, y: 800 })
  // 小数坐标 ⇒ 四舍五入并给警告
  const r2 = validateToolCall({ name: 'move_to', args: { x: 10.6, y: 20.2 } })
  assert.equal(r2.ok, true)
  assert.equal(r2.call.args.x, 11)
  assert.ok(r2.warnings.some((w) => w.includes('四舍五入')), r2.warnings.join(' | '))
  // 非数字 ⇒ 报错
  assert.equal(validateToolCall({ name: 'move_to', args: { x: '左边', y: 1 } }).ok, false)
  // 超出范围 ⇒ 报错
  assert.equal(validateToolCall({ name: 'pet', args: { times: 99 } }).ok, false)
  // 枚举大小写归一
  const r3 = validateToolCall({ name: 'interact', args: { kind: 'NOD' } })
  assert.equal(r3.ok, true)
  assert.equal(r3.call.args.kind, 'nod')
  // 枚举写错 ⇒ 报错并列出可选值
  const r4 = validateToolCall({ name: 'interact', args: { kind: '跳舞' } })
  assert.equal(r4.ok, false)
  assert.ok(r4.errors[0].includes('greet'), r4.errors.join(' | '))
})

test('★ 未声明的参数只警告、不阻塞，且**不会传给实现**', () => {
  const r = validateToolCall({ name: 'pet', args: { times: 2, 乱写的: 'x' } })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.includes('乱写的')))
  assert.deepEqual(Object.keys(r.call.args), ['times'])
})

test('超长字符串截断并警告（不让一个字段把日志撑爆）', () => {
  const long = 'x'.repeat(200)
  const r = validateToolCall({ name: 'cancel', args: { reason: long } })
  assert.equal(r.ok, true)
  assert.equal([...r.call.args.reason].length, 60)
  assert.ok(r.warnings.some((w) => w.includes('超长')))
})

test('validateToolCall 对脏输入不崩', () => {
  for (const bad of [null, undefined, 0, 'x', [], { name: 42 }, { name: 'pet', args: 5 }]) {
    assert.doesNotThrow(() => validateToolCall(bad))
    assert.equal(typeof validateToolCall(bad).ok, 'boolean')
  }
})

// ══════════════════ C. 提示词与解析 ══════════════════

test('★ 提示词从工具表派生：名字、参数、必填、需确认都在', () => {
  const p = buildToolsPrompt()
  for (const t of TOOLS) {
    assert.ok(p.includes(t.name), `提示词缺 ${t.name}`)
    for (const s of t.params) assert.ok(p.includes(s.name), `提示词缺 ${t.name}.${s.name}`)
  }
  assert.ok(p.includes('需要玩家确认'))
  assert.match(p, /只输出一行 JSON/)
  assert.match(p, /不需要调用工具时，正常说话即可/)
})

test('提示词可以只列指定工具', () => {
  const p = buildToolsPrompt({ only: ['pet'] })
  assert.ok(p.includes('pet'))
  assert.ok(!p.includes('launch_app'), '不该出现未选中的工具')
})

test('★ parseToolCalls：认多种写法', () => {
  assert.deepEqual(parseToolCalls('{"tool":"pet","args":{"times":2}}').calls, [{ name: 'pet', args: { times: 2 } }])
  assert.deepEqual(parseToolCalls('{"name":"pet","arguments":{"times":1}}').calls, [{ name: 'pet', args: { times: 1 } }])
  assert.deepEqual(parseToolCalls('{"pet":{}}').calls, [{ name: 'pet', args: {} }])
  assert.deepEqual(parseToolCalls('```json\n{"tool":"cancel","args":{}}\n```').calls, [{ name: 'cancel', args: {} }])
  assert.deepEqual(parseToolCalls('好的，我挪一下 {"tool":"move_to","args":{"x":100,"y":200}} 这样不挡了').calls,
    [{ name: 'move_to', args: { x: 100, y: 200 } }])
  assert.deepEqual(parseToolCalls('{"tool":"move_to"}').calls, [{ name: 'move_to', args: {} }], '缺 args 当空对象')
})

test('★ parseToolCalls：模型只是说了句话 ⇒ 没有工具调用，**不是错误**', () => {
  for (const text of ['', '今天天气不错', '{"随便":"json"}', '{"tool":"不存在的工具"}', 'null', '[]']) {
    const r = parseToolCalls(text)
    assert.deepEqual(r.calls, [], JSON.stringify(text))
    assert.equal(r.error, null, '解析不出工具调用是正常情况，不该报错')
  }
})

test('parseToolCalls 对脏输入不崩', () => {
  for (const bad of [null, undefined, 0, {}, []]) {
    assert.doesNotThrow(() => parseToolCalls(bad))
  }
})

test('describeTool 给出人话', () => {
  const s = describeTool('launch_app')
  assert.ok(s.includes('launch_app'))
  assert.ok(s.includes('需确认'))
  assert.ok(s.includes('target'))
  assert.match(describeTool('不存在'), /未登记/)
})

// ══════════════════ D. 执行器 ══════════════════

function makeRunner(over = {}) {
  const calls = []
  const handlers = {
    move_to: (a) => { calls.push(['move_to', a]); return { moved: true } },
    pet: (a) => { calls.push(['pet', a]); return { affinity: 0.6 } },
    interact: (a) => { calls.push(['interact', a]); return { kind: a.kind } },
    cancel: (a) => { calls.push(['cancel', a]); return { canceled: true } },
    launch_app: (a) => { calls.push(['launch_app', a]); return { pid: 1234 } },
    generate_character_card: (a) => { calls.push(['generate_character_card', a]); return { applied: 6 } },
    ...(over.handlers ?? {}),
  }
  let clock = T0
  const runner = createToolRunner({ handlers, now: () => clock, ...over.opts })
  return { runner, calls, tick: (ms = 1000) => { clock += ms } }
}

test('★ 安全工具直接执行，并记进审计', async () => {
  const { runner, calls } = makeRunner()
  const r = await runner.run({ name: 'pet', args: { times: 2 } })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [['pet', { times: 2 }]])
  const h = runner.history()
  assert.equal(h.length, 1)
  assert.equal(h[0].decision, 'ok')
  assert.equal(h[0].name, 'pet')
})

test('★ 需要确认的工具：没批准 ⇒ **不执行**，挂成待确认', async () => {
  const { runner, calls } = makeRunner()
  const r = await runner.run({ name: 'launch_app', args: { target: 'Hollow Knight' } })
  assert.equal(r.ok, false)
  assert.equal(r.needsConfirm, true)
  assert.ok(r.pendingId)
  assert.deepEqual(calls, [], '没批准就不许执行')
  assert.equal(runner.pending().length, 1)
  const h = runner.history()
  assert.equal(h[0].decision, 'needs-confirm')
})

test('★ 待确认的请求可以被批准后执行 / 被拒绝', async () => {
  const { runner, calls } = makeRunner()
  const r1 = await runner.run({ name: 'launch_app', args: { target: 'A' } })
  const done = await runner.approvePending(r1.pendingId)
  assert.equal(done.ok, true)
  assert.deepEqual(calls, [['launch_app', { target: 'A' }]])
  assert.equal(runner.pending().length, 0)

  const r2 = await runner.run({ name: 'generate_character_card', args: { name: '霞', game: 'g' } })
  assert.equal(runner.rejectPending(r2.pendingId), true)
  assert.equal(runner.pending().length, 0)
  assert.ok(runner.history().some((x) => x.decision === 'rejected'))
  assert.deepEqual(calls.filter((c) => c[0] === 'generate_character_card'), [], '拒绝了就不能执行')
})

test('★ approve 回调说"同意"就直接执行（界面弹框那条路）', async () => {
  const { runner, calls } = makeRunner({ opts: { approve: () => true } })
  const r = await runner.run({ name: 'launch_app', args: { target: 'A' } })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [['launch_app', { target: 'A' }]])
  const deny = makeRunner({ opts: { approve: () => false } })
  assert.equal((await deny.runner.run({ name: 'launch_app', args: { target: 'A' } })).ok, false)
  const boom = makeRunner({ opts: { approve: () => { throw new Error('弹框炸了') } } })
  const rb = await boom.runner.run({ name: 'launch_app', args: { target: 'A' } })
  assert.equal(rb.ok, false, 'approve 自己抛异常时应当按"没批准"处理')
  assert.equal(rb.needsConfirm, true)
})

test('★ 待确认堆积会被挡住（防模型刷屏式请求启动程序）', async () => {
  const { runner } = makeRunner()
  for (let i = 0; i < TOOL_DEFAULTS.maxPending; i++) {
    assert.equal((await runner.run({ name: 'launch_app', args: { target: `A${i}` } })).needsConfirm, true)
  }
  const over = await runner.run({ name: 'launch_app', args: { target: 'overflow' } })
  assert.equal(over.ok, false)
  assert.ok(over.error.includes('待确认的请求太多'), over.error)
  assert.ok(runner.history().some((x) => x.decision === 'pending-overflow'))
})

test('★ 限流：同一工具的最小间隔', async () => {
  const { runner, tick } = makeRunner()
  assert.equal((await runner.run({ name: 'move_to', args: { x: 1, y: 1 } })).ok, true)
  const second = await runner.run({ name: 'move_to', args: { x: 2, y: 2 } })
  assert.equal(second.ok, false)
  assert.ok(second.error.includes('太频繁'), second.error)
  tick(TOOL_DEFAULTS.minIntervalMs.move_to)
  assert.equal((await runner.run({ name: 'move_to', args: { x: 3, y: 3 } })).ok, true)
  assert.ok(runner.stats().throttled >= 1)
})

test('★ 限流：全局每分钟上限（失控循环的兜底）', async () => {
  const { runner, tick } = makeRunner({ opts: { limits: { maxPerMinute: 3, defaultIntervalMs: 0, minIntervalMs: {} } } })
  for (let i = 0; i < 3; i++) {
    tick(10)
    assert.equal((await runner.run({ name: 'pet', args: {} })).ok, true)
  }
  tick(10)
  const over = await runner.run({ name: 'pet', args: {} })
  assert.equal(over.ok, false)
  assert.ok(over.error.includes('上限'), over.error)
})

test('★ 校验不过的调用被记成 invalid，且不落到 handler', async () => {
  const { runner, calls } = makeRunner()
  const r = await runner.run({ name: 'move_to', args: { x: '左边' } })
  assert.equal(r.ok, false)
  assert.deepEqual(calls, [])
  assert.equal(runner.history()[0].decision, 'invalid')
})

test('缺实现 / 实现抛异常 ⇒ 可读错误，不崩', async () => {
  const bare = createToolRunner({ handlers: {}, now: () => T0 })
  const r = await bare.run({ name: 'pet', args: {} })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('还没有接上实现'), r.error)

  const boom = makeRunner({ handlers: { pet: () => { throw new Error('窗口没了') } } })
  const r2 = await boom.runner.run({ name: 'pet', args: {} })
  assert.equal(r2.ok, false)
  assert.ok(r2.error.includes('窗口没了'))
  assert.equal(boom.runner.history()[0].decision, 'error')
})

test('★ 审计历史有上限、统计可用', async () => {
  const { runner, tick } = makeRunner({ opts: { limits: { maxAudit: 5, minIntervalMs: {}, defaultIntervalMs: 0, maxPerMinute: 999 } } })
  for (let i = 0; i < 12; i++) { tick(10); await runner.run({ name: 'pet', args: {} }) }
  assert.equal(runner.history(100).length, 5, '历史必须封顶')
  const s = runner.stats()
  assert.equal(s.ok, 5, '统计只看保留下来的那些')
  assert.equal(s.total, 5)
})

test('★ runner 对垃圾输入永不抛', async () => {
  const { runner } = makeRunner()
  for (const bad of [null, undefined, 0, 'x', [], {}, { name: null }, { name: 'pet', args: NaN }]) {
    const r = await runner.run(bad)
    assert.equal(r.ok, false)
  }
  assert.equal((await runner.approvePending('不存在')).ok, false, 'approvePending 是 async —— 别漏 await')
  assert.equal(runner.rejectPending('不存在'), false)
})

test('★ 收选项对象的入口都要挡 null（默认参数只挡 undefined —— 这个坑踩过多次）', () => {
  assert.doesNotThrow(() => createToolRunner(null))
  assert.doesNotThrow(() => createToolRunner(undefined))
  assert.doesNotThrow(() => createToolRunner({ handlers: null, limits: null, approve: 'x' }))
  assert.equal(missingHandlers(null).length, 6)
  assert.equal(missingHandlers('x').length, 6)
  assert.doesNotThrow(() => launch(null, { items: [] }))
  assert.doesNotThrow(() => launch(undefined, { items: [] }))
  assert.doesNotThrow(() => launch(0, { items: [] }))
  assert.doesNotThrow(() => buildLaunchables(null))
  assert.doesNotThrow(() => buildLaunchables({ favorites: null, roots: null }))
  assert.doesNotThrow(() => findExecutables('x', { fs: null }))
  assert.doesNotThrow(() => pickMainExe(null, null))
})

test('missingHandlers 能报出缺哪些实现', () => {
  assert.equal(missingHandlers({ move_to: () => {}, pet: () => {}, interact: () => {}, launch_app: () => {}, cancel: () => {}, generate_character_card: () => {} }).length, 0)
  const miss = missingHandlers({ pet: () => {} })
  assert.equal(miss.length, 5)
  assert.ok(miss.includes('launch_app'))
})

// ══════════════════ E. 启动器：黑名单与发现 ══════════════════

test('★ 黑名单：卸载器 / 运行库 / 崩溃处理器 / 解释器一律拒绝，永远没有例外', () => {
  for (const n of ['unins000.exe', 'setup.exe', 'vcredist_x64.exe', 'dxsetup.exe', 'UnityCrashHandler64.exe',
    'crashpad_handler.exe', 'steam.exe', 'steamwebhelper.exe', 'EpicGamesLauncher.exe', 'python.exe',
    'node.exe', 'cmd.exe', 'powershell.exe', '7z.exe', 'javaw.exe']) {
    assert.equal(isDeniedExe(n), true, `${n} 该被拒绝`)
  }
  for (const n of ['HollowKnight.exe', 'Game.exe', 'someday.exe', 'Undertale.exe']) {
    assert.equal(isDeniedExe(n), false, `${n} 该被放行`)
  }
  assert.equal(isDeniedExe('readme.txt'), true, '非 exe 一律不当候选')
  assert.equal(isDeniedExe(''), true)
  assert.equal(isDeniedExe(null), true)
  assert.ok(DENY_EXE_PATTERNS.length >= 8)
})

function fakeFs(tree) {
  // tree: { '/a': { 'b.exe': 10, sub: { 'c.exe': 20 } } }
  const dirs = new Map()
  const files = new Map()
  const walk = (prefix, node) => {
    const here = []
    for (const [k, v] of Object.entries(node)) {
      const p = prefix === '' ? k : `${prefix}/${k}`
      if (typeof v === 'number') { files.set(p, v); here.push({ name: k, isDir: false, size: v }) }
      else { dirs.set(p, true); here.push({ name: k, isDir: true, size: 0 }); walk(p, v) }
    }
    dirs.set(prefix === '' ? '.' : prefix, here)
  }
  walk('', tree)
  return {
    exists: (p) => files.has(norm(p)) || dirs.has(norm(p)),
    readText: (p) => { const v = files.get(norm(p)); if (v === undefined || typeof v === 'number') throw new Error('ENOENT'); return v },
    list: (p) => { const v = dirs.get(norm(p)); if (!v) throw new Error('ENOENT'); return v },
    join,
  }
}
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '')

test('★ parseLibraryFolders 两种真实写法都认', () => {
  const vdfNew = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"D:\\\\SteamLibrary"\n\t}\n}`
  assert.deepEqual(parseLibraryFolders(vdfNew), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary'])
  const vdfOld = `"libraryfolders"\n{\n\t"1"\t\t"D:\\\\Games\\\\Steam"\n\t"2"\t\t"E:\\\\SteamLibrary"\n}`
  assert.deepEqual(parseLibraryFolders(vdfOld), ['D:\\Games\\Steam', 'E:\\SteamLibrary'])
  assert.deepEqual(parseLibraryFolders(''), [])
  assert.deepEqual(parseLibraryFolders(null), [])
  assert.deepEqual(parseLibraryFolders('"path" "D:\\\\X"\n"path" "D:\\\\X"'), ['D:\\X'], '要按路径去重')
})

test('★ steamLibraryRoots：找不到 Steam 时如实说明，而不是抛', () => {
  const empty = fakeFs({})
  const r = steamLibraryRoots({ fs: empty, steamRoots: ['C:/Steam'] })
  assert.deepEqual(r.roots, [])
  assert.ok(r.notes.some((n) => n.includes('没找到 Steam')))
})

test('★ findExecutables：限深、过黑名单、限量', () => {
  const fs = fakeFs({
    game: {
      'Game.exe': 5000,
      'unins000.exe': 100,
      'readme.txt': 10,
      bin: { 'helper.exe': 300, 'UnityCrashHandler64.exe': 50 },
      deep: { a: { b: { c: { 'far.exe': 10 } } } },
    },
  })
  const got = findExecutables('game', { fs, maxDepth: 2 })
  const names = got.map((x) => x.name).sort()
  assert.deepEqual(names, ['Game.exe', 'helper.exe'], `黑名单/限深失效：${names.join(',')}`)
  const limited = findExecutables('game', { fs, maxDepth: 3, maxExes: 1 })
  assert.equal(limited.length, 1)
})

test('★ pickMainExe：目录名相似者优先，体积与层级参与排序，挑不出就返回 null', () => {
  const exes = [
    { path: 'C:/g/tool.exe', name: 'tool.exe', size: 90000, depth: 0 },
    { path: 'C:/g/HollowKnight.exe', name: 'HollowKnight.exe', size: 2000, depth: 0 },
  ]
  const pick = pickMainExe(exes, 'Hollow Knight')
  assert.equal(pick.name, 'HollowKnight.exe', '名字匹配该压过体积')
  const big = pickMainExe([
    { path: 'C:/g/a.exe', name: 'a.exe', size: 10, depth: 0 },
    { path: 'C:/g/b.exe', name: 'b.exe', size: 10_000_000, depth: 0 },
  ], 'zzz')
  assert.equal(big.name, 'b.exe', '都没名字匹配时体积说话')
  const shallow = pickMainExe([
    { path: 'C:/g/a.exe', name: 'a.exe', size: 1000, depth: 0 },
    { path: 'C:/g/x/y/b.exe', name: 'b.exe', size: 1000, depth: 2 },
  ], 'zzz')
  assert.equal(shallow.name, 'a.exe', '同分时浅层优先')
  assert.equal(pickMainExe([], 'x'), null)
  assert.equal(pickMainExe(null, 'x'), null)
})

test('★ buildLaunchables：收藏 + 扫描合并，找不到 exe 也登记目录（仍可用于监视）', () => {
  const fs = fakeFs({
    lib: { 'Hollow Knight': { 'hollow_knight.exe': 5000 }, 'NoExe Game': { 'readme.txt': 1 } },
  })
  const r = buildLaunchables({ fs, favorites: [{ dir: 'lib/Hollow Knight', name: '空洞骑士' }], roots: ['lib'] })
  const names = r.items.map((x) => x.name).sort()
  assert.deepEqual(names, ['NoExe Game', '空洞骑士'])
  const hk = r.items.find((x) => x.name === '空洞骑士')
  assert.equal(hk.source, 'favorite')
  assert.ok(hk.exe.endsWith('hollow_knight.exe'))
  assert.ok(r.notes.some((n) => n.includes('NoExe Game')), '该如实说明没找到 exe')
  assert.equal(new Set(r.items.map((x) => x.id)).size, r.items.length, 'id 不能重复')
})

test('收藏里显式指定的 exe 优先（用户比启发式可信）', () => {
  const fs = fakeFs({ g: { 'a.exe': 1, 'b.exe': 99999 } })
  const r = buildLaunchables({ fs, favorites: [{ dir: 'g', name: 'G', exe: join('g', 'a.exe') }] })
  assert.ok(r.items[0].exe.endsWith('a.exe'), '显式指定的应当胜过体积启发式')
  // 显式指定了一个黑名单 exe ⇒ 退回启发式
  const r2 = buildLaunchables({ fs, favorites: [{ dir: 'g', name: 'G', exe: join('g', 'unins000.exe') }] })
  assert.ok(r2.items[0].exe.endsWith('b.exe'), '黑名单不能被显式指定绕过')
})

test('buildLaunchables 对脏输入不崩', () => {
  for (const bad of [null, undefined, {}, { favorites: [null, {}, { dir: '' }, { dir: 42 }] }, { roots: 'x' }]) {
    assert.doesNotThrow(() => buildLaunchables({ ...(bad ?? {}), fs: fakeFs({}) }))
  }
})

test('★ resolveLaunchTarget：精确优先；**多个候选命中就拒绝**（不猜）', () => {
  const items = [
    { id: 'app_a', name: 'Hollow Knight', dir: 'D:/g/HollowKnight' },
    { id: 'app_b', name: 'Hollow Knight Silksong', dir: 'D:/g/Silksong' },
    { id: 'app_c', name: 'Celeste', dir: 'D:/g/Celeste' },
  ]
  assert.equal(resolveLaunchTarget('Hollow Knight', items).item.id, 'app_a', '精确匹配优先')
  assert.equal(resolveLaunchTarget('celeste', items).item.id, 'app_c', '大小写无关')
  assert.equal(resolveLaunchTarget('app_b', items).item.id, 'app_b', 'id 也能用')
  assert.equal(resolveLaunchTarget('Celeste', items).matches.length, 1)
  const amb = resolveLaunchTarget('Hollow', items)
  assert.equal(amb.ok, false)
  assert.ok(amb.error.includes('多个'), amb.error)
  assert.equal(resolveLaunchTarget('不存在', items).ok, false)
  assert.equal(resolveLaunchTarget('', items).ok, false)
})

// ══════════════════ F. 启动器：启动（安全为主） ══════════════════

function spawnRecorder() {
  const calls = []
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { pid: 4242, unref: () => calls.push({ unref: true }) }
  }
  return { calls, impl }
}

const item = { id: 'app_a', name: 'Hollow Knight', dir: 'D:/g/HK', exe: 'D:/g/HK/hk.exe', exeName: 'hk.exe' }

test('★ 未登记的目标一律拒绝（模型没法构造路径来启动任意程序）', () => {
  const { impl, calls } = spawnRecorder()
  const r = launch({ target: 'C:/Windows/System32/cmd.exe' }, { items: [item], approve: true, spawnImpl: impl, existsImpl: () => true })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('没有登记过'), r.error)
  assert.deepEqual(calls, [])
})

test('★ 黑名单在启动口也要拦一次（纵深防御）', () => {
  const { impl, calls } = spawnRecorder()
  const bad = { id: 'app_x', name: 'X', dir: 'D:/g/X', exe: 'D:/g/X/unins000.exe', exeName: 'unins000.exe' }
  const r = launch({ id: 'app_x' }, { items: [bad], approve: true, spawnImpl: impl, existsImpl: () => true })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('禁止启动'), r.error)
  assert.deepEqual(calls, [])
})

test('★ 文件不存在 ⇒ 拒绝并说明', () => {
  const { impl, calls } = spawnRecorder()
  const r = launch({ id: 'app_a' }, { items: [item], approve: true, spawnImpl: impl, existsImpl: () => false })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('不存在'), r.error)
  assert.deepEqual(calls, [])
})

test('★ 默认要求确认：不给 approve 就不启动', () => {
  const { impl, calls } = spawnRecorder()
  const r = launch({ id: 'app_a' }, { items: [item], spawnImpl: impl, existsImpl: () => true })
  assert.equal(r.ok, false)
  assert.equal(r.needsConfirm, true)
  assert.deepEqual(calls, [])
  // 显式关掉确认（用户自己改的设置）才放行
  const r2 = launch({ id: 'app_a' }, { items: [item], confirmRequired: false, spawnImpl: impl, existsImpl: () => true })
  assert.equal(r2.ok, true)
})

test('★ 启动成功：不经过 shell、参数按数组传、detached + unref', () => {
  const { impl, calls } = spawnRecorder()
  const r = launch({ id: 'app_a', args: '-windowed  --foo' }, { items: [item], approve: true, spawnImpl: impl, existsImpl: () => true })
  assert.equal(r.ok, true)
  assert.equal(r.pid, 4242)
  const c = calls.find((x) => x.cmd)
  assert.equal(c.cmd, 'D:/g/HK/hk.exe')
  assert.deepEqual(c.args, ['-windowed', '--foo'])
  assert.equal(c.opts.shell, false, '★ 绝不能经过 shell —— 否则 args 就是注入点')
  assert.equal(c.opts.detached, true)
  assert.equal(c.opts.cwd, 'D:/g/HK')
  assert.ok(calls.some((x) => x.unref), '要 unref，否则父进程退出会被子进程拖住')
})

test('★ 参数里的 shell 元字符不会被解释（因为根本不经过 shell）', () => {
  const { impl, calls } = spawnRecorder()
  launch({ id: 'app_a', args: 'a; rm -rf / && echo pwned' }, { items: [item], approve: true, spawnImpl: impl, existsImpl: () => true })
  const c = calls.find((x) => x.cmd)
  assert.equal(c.opts.shell, false)
  assert.ok(c.args.join(' ').includes('rm -rf'), '原样作为参数传给游戏，不由 shell 解释')
})

test('spawn 抛异常 ⇒ 可读错误，不崩', () => {
  const r = launch({ id: 'app_a' }, { items: [item], approve: true, existsImpl: () => true, spawnImpl: () => { throw new Error('EACCES') } })
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('EACCES'), r.error)
})

test('launch 对脏输入不崩', () => {
  for (const bad of [null, undefined, 0, {}, { target: 42 }]) {
    assert.doesNotThrow(() => launch(bad, { items: [item], approve: true, existsImpl: () => true, spawnImpl: spawnRecorder().impl }))
    assert.equal(launch(bad, { items: [item], approve: true, existsImpl: () => true, spawnImpl: spawnRecorder().impl }).ok, false)
  }
})

test('★ matchWatchDir：把启动的游戏与"实际在写存档的目录"对上，对不上就 null（不猜）', () => {
  const discovered = [
    { dir: 'C:/LocalLow/Team17/Hollow Knight' },
    { dir: 'C:/LocalLow/Other/Game' },
  ]
  assert.equal(matchWatchDir('Hollow Knight', discovered), 'C:/LocalLow/Team17/Hollow Knight')
  assert.equal(matchWatchDir('hollowknight', discovered), 'C:/LocalLow/Team17/Hollow Knight')
  assert.equal(matchWatchDir('完全不相干', discovered), null)
  assert.equal(matchWatchDir('', discovered), null)
  assert.equal(matchWatchDir('Hollow', [
    { dir: 'C:/LocalLow/A/Hollow Knight' },
    { dir: 'C:/LocalLow/B/Hollow Knight Silksong' },
  ]), null, '多个候选时不许猜')
})

test('launchableId 稳定且对 exe 敏感', () => {
  assert.equal(launchableId('D:/g/HK', 'D:/g/HK/a.exe'), launchableId('D:/g/HK', 'D:/g/HK/a.exe'))
  assert.notEqual(launchableId('D:/g/HK', 'D:/g/HK/a.exe'), launchableId('D:/g/HK', 'D:/g/HK/b.exe'))
  assert.match(launchableId('x', 'y'), /^app_[0-9a-z]+$/)
})

test('LAUNCHER_DEFAULTS 有界（不会把整个磁盘扫一遍）', () => {
  assert.ok(LAUNCHER_DEFAULTS.maxDepth <= 4)
  assert.ok(LAUNCHER_DEFAULTS.maxExes <= 100)
  assert.ok(LAUNCHER_DEFAULTS.maxPerRoot <= 1000)
})

// ══════════════════ G. 与真实磁盘接一次（临时目录） ══════════════════

test('★ 真实 fs：能在临时目录里发现并挑出 exe（证明注入的假 fs 没骗自己）', () => {
  const d = mkdtempSync(join(tmpdir(), 'pet-launch-'))
  try {
    const game = join(d, 'MyGame')
    mkdirSync(join(game, 'bin'), { recursive: true })
    writeFileSync(join(game, 'unins000.exe'), 'x')
    writeFileSync(join(game, 'MyGame.exe'), 'M'.repeat(4096))
    writeFileSync(join(game, 'bin', 'helper.exe'), 'h'.repeat(100))
    const exes = findExecutables(game, { maxDepth: 2 })
    assert.deepEqual(exes.map((x) => x.name).sort(), ['MyGame.exe', 'helper.exe'])
    const pick = pickMainExe(exes, 'MyGame')
    assert.equal(pick.name, 'MyGame.exe')
    const built = buildLaunchables({ favorites: [{ dir: game, name: '我的游戏' }] })
    assert.equal(built.items.length, 1)
    assert.ok(built.items[0].exe.endsWith('MyGame.exe'))
    assert.equal(resolveLaunchTarget('我的游戏', built.items).ok, true)
  } finally { rmSync(d, { recursive: true, force: true }) }
})
