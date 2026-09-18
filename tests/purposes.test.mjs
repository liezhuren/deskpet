// tests/purposes.test.mjs —— 分用途模型（以及顺带覆盖的启动器设置）
//
// 这一层的价值全在**回落规则**上：用户只改其中一两个字段是常态，
// 所以"没填的字段回落到默认"必须逐字段成立，而不是整体替换。
// 另外两条是安全与诚实：
//   · 每一处 apiKey 都要脱敏（分用途之后 key 变成了多处，最容易漏）
//   · 显式关掉某个用途时**不能**被默认配置兜回来（否则用户以为开关坏了）

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SETTINGS, SETTING_PATHS, LLM_PURPOSES, LLM_PURPOSE_FIELDS, PURPOSE_IDS,
  resolveLlmConfig, redactSettings, validateSettings, mergeSettings, unknownPaths,
  createStore,
} from '../app/store.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const withDefaults = (patch) => mergeSettings(DEFAULT_SETTINGS, patch)

// ══════════════════ A. 用途登记表 ══════════════════

test('★ 用途是登记过的闭集，id 唯一且都有说明', () => {
  assert.ok(LLM_PURPOSES.length >= 5)
  assert.equal(new Set(PURPOSE_IDS).size, PURPOSE_IDS.length, 'id 不能重复')
  for (const p of LLM_PURPOSES) {
    assert.match(p.id, /^[a-zA-Z][a-zA-Z0-9]*$/, `${p.id} 不像个 id`)
    assert.ok(p.label.length > 0, `${p.id} 缺中文名`)
    assert.ok(p.note.length > 4, `${p.id} 缺说明（界面要显示它来解释"这个用途用在哪"）`)
  }
  for (const id of ['dialogue', 'cardFill', 'memoryJudge', 'tools', 'wiki']) {
    assert.ok(PURPOSE_IDS.includes(id), `缺少用途 ${id}`)
  }
  assert.ok(Object.isFrozen(LLM_PURPOSES))
})

test('★ 每个用途 × 每个可覆盖字段都在白名单里（不然设置页根本写不进去）', () => {
  for (const id of PURPOSE_IDS) {
    for (const f of LLM_PURPOSE_FIELDS) {
      assert.ok(SETTING_PATHS.includes(`llm.purposes.${id}.${f}`), `缺路径 llm.purposes.${id}.${f}`)
    }
  }
  assert.equal(SETTING_PATHS.filter((p) => p.startsWith('llm.purposes.')).length,
    PURPOSE_IDS.length * LLM_PURPOSE_FIELDS.length)
})

test('★ 未登记的用途或字段被拒（不许静默存下一个没人读的键）', () => {
  assert.deepEqual(unknownPaths({ llm: { purposes: { dialogue: { model: 'x' } } } }), [])
  // 未登记的用途：在**用途**这一层就报出来（比逐字段报更清楚 —— 用户一眼知道是用途名错了）
  assert.deepEqual(unknownPaths({ llm: { purposes: { nope: { model: 'x' } } } }), ['llm.purposes.nope'])
  // 已登记的用途里写了未登记的字段：报到字段一级
  assert.deepEqual(unknownPaths({ llm: { purposes: { dialogue: { modle: 'x' } } } }), ['llm.purposes.dialogue.modle'])
  assert.deepEqual(unknownPaths({ launcher: { favorites: [] } }), [])
  assert.deepEqual(unknownPaths({ launcher: { nope: 1 } }), ['launcher.nope'])
})

// ══════════════════ B. 解析：回落规则 ══════════════════

test('★ 没配任何用途 ⇒ 全部用默认配置（老用户升级后行为不变）', () => {
  const s = withDefaults({ llm: { provider: 'llm', model: 'big', apiKey: 'k' } })
  for (const id of PURPOSE_IDS) {
    const r = resolveLlmConfig(s, id)
    assert.equal(r.provider, 'llm')
    assert.equal(r.model, 'big')
    assert.equal(r.apiKey, 'k')
    assert.equal(r.source, 'default', `${id} 不该被标记成有覆盖`)
    assert.deepEqual(r.overrides, [])
  }
})

test('★ 逐字段回落：只改 model 时，key / preset / baseUrl 仍来自默认', () => {
  const s = withDefaults({
    llm: { provider: 'llm', preset: 'openai', baseUrl: 'https://a/v1', model: 'big', apiKey: 'sk-key' },
  })
  const s2 = mergeSettings(s, { llm: { purposes: { memoryJudge: { model: 'tiny' } } } })
  const r = resolveLlmConfig(s2, 'memoryJudge')
  assert.equal(r.model, 'tiny', '覆盖生效')
  assert.equal(r.apiKey, 'sk-key', 'key 该回落默认')
  assert.equal(r.preset, 'openai', 'preset 该回落默认')
  assert.equal(r.baseUrl, 'https://a/v1', 'baseUrl 该回落默认')
  assert.equal(r.provider, 'llm')
  assert.equal(r.source, 'purpose:memoryJudge')
  assert.deepEqual(r.overrides, ['model'], '只把真正覆盖的字段记进 overrides')
})

test('★ 每个用途互不影响（改 A 不动 B）', () => {
  const s = withDefaults({
    llm: {
      provider: 'llm', model: 'big', apiKey: 'k',
      purposes: { memoryJudge: { model: 'tiny' }, wiki: { model: 'long', baseUrl: 'https://local/v1' } },
    },
  })
  assert.equal(resolveLlmConfig(s, 'memoryJudge').model, 'tiny')
  assert.equal(resolveLlmConfig(s, 'wiki').model, 'long')
  assert.equal(resolveLlmConfig(s, 'wiki').baseUrl, 'https://local/v1')
  assert.equal(resolveLlmConfig(s, 'wiki').apiKey, 'k', 'wiki 没填 key，该回落')
  assert.equal(resolveLlmConfig(s, 'dialogue').model, 'big', '没覆盖的用途不受影响')
  assert.equal(resolveLlmConfig(s, 'dialogue').baseUrl, '', 'dialogue 不该沾上 wiki 的 baseUrl')
})

test('★ 显式关掉某用途 ⇒ 强制模板档，且**不被默认配置兜回来**', () => {
  const s = withDefaults({
    llm: { provider: 'llm', model: 'big', apiKey: 'k', purposes: { dialogue: { enabled: false } } },
  })
  const r = resolveLlmConfig(s, 'dialogue')
  assert.equal(r.provider, 'template', '关掉就该是模板档')
  assert.equal(r.model, '', '关掉时不该带出默认的 model')
  assert.equal(r.apiKey, '', '关掉时更不该带出 key')
  assert.equal(r.source, 'disabled')
  // 其他用途不受影响
  assert.equal(resolveLlmConfig(s, 'cardFill').provider, 'llm')
})

test('★ 用途可以指定完全不同的服务商（本地模型 + 云端模型并存）', () => {
  const s = withDefaults({
    llm: {
      provider: 'llm', preset: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-cloud',
      purposes: { memoryJudge: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b', apiKey: 'ollama' } },
    },
  })
  const judge = resolveLlmConfig(s, 'memoryJudge')
  assert.equal(judge.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.equal(judge.model, 'qwen2.5:3b')
  const talk = resolveLlmConfig(s, 'dialogue')
  assert.equal(talk.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(talk.model, 'deepseek-chat')
})

test('未登记用途 / 空用途名 ⇒ 退回默认并**如实标注**', () => {
  const s = withDefaults({ llm: { provider: 'llm', model: 'big' } })
  const un = resolveLlmConfig(s, 'nope')
  assert.equal(un.unknownPurpose, true)
  assert.equal(un.source, 'default')
  assert.equal(un.model, 'big')
  assert.equal(resolveLlmConfig(s, null).unknownPurpose, false, '不传用途不算"未登记"')
  assert.equal(resolveLlmConfig(s, '').source, 'default')
})

test('resolveLlmConfig 对脏设置不崩', () => {
  for (const bad of [null, undefined, 0, 'x', {}, { llm: null }, { llm: { purposes: 'x' } }]) {
    assert.doesNotThrow(() => resolveLlmConfig(bad, 'dialogue'))
    assert.equal(typeof resolveLlmConfig(bad, 'dialogue').provider, 'string')
  }
})

// ══════════════════ C. 校验 ══════════════════

test('★ 未登记的用途与字段都是**错误**（不是警告）', () => {
  const bad1 = validateSettings(withDefaults({ llm: { purposes: { 瞎写: { model: 'x' } } } }))
  assert.equal(bad1.ok, false)
  assert.ok(bad1.errors.some((e) => e.includes('未登记的用途')), bad1.errors.join(' | '))

  const bad2 = validateSettings(withDefaults({ llm: { purposes: { dialogue: { 瞎写: 1 } } } }))
  assert.equal(bad2.ok, false)
  assert.ok(bad2.errors.some((e) => e.includes('不是可覆盖的字段')), bad2.errors.join(' | '))
})

test('★ 类型也要查（provider 枚举、enabled 布尔、其余字符串）', () => {
  assert.equal(validateSettings(withDefaults({ llm: { purposes: { dialogue: { provider: '瞎写' } } } })).ok, false)
  assert.equal(validateSettings(withDefaults({ llm: { purposes: { dialogue: { enabled: 'yes' } } } })).ok, false)
  assert.equal(validateSettings(withDefaults({ llm: { purposes: { dialogue: { model: 42 } } } })).ok, false)
  assert.equal(validateSettings(withDefaults({ llm: { purposes: { dialogue: { enabled: false } } } })).ok, true)
  assert.equal(validateSettings(withDefaults({ llm: { purposes: {} } })).ok, true, '空对象是合法的（= 全用默认）')
})

test('★ 某用途选了 llm 但**解析下来没有任何 key** ⇒ 给警告（因为那一路会退回模板档）', () => {
  // 默认没 key，cardFill 自己也没 key
  const s = withDefaults({ llm: { provider: 'llm', model: 'big', apiKey: '', purposes: { cardFill: { model: 'x' } } } })
  const v = validateSettings(s)
  assert.ok(v.warnings.some((w) => w.includes('cardFill')), v.warnings.join(' | '))

  // cardFill 自己带了 key ⇒ 不该再警告
  const s2 = withDefaults({ llm: { provider: 'llm', apiKey: '', purposes: { cardFill: { apiKey: 'sk-x' } } } })
  assert.ok(!validateSettings(s2).warnings.some((w) => w.includes('cardFill')))

  // 显式关掉的用途不该被警告
  const s3 = withDefaults({ llm: { provider: 'llm', apiKey: '', purposes: { dialogue: { enabled: false } } } })
  assert.ok(!validateSettings(s3).warnings.some((w) => w.includes('dialogue')))
})

// ══════════════════ D. 脱敏（多处 key） ══════════════════

test('★ 默认 key 与**每一个用途的 key** 都要脱敏', () => {
  const s = withDefaults({
    llm: {
      provider: 'llm', apiKey: 'sk-default-9876',
      purposes: { memoryJudge: { apiKey: 'sk-judge-5555' }, wiki: { model: 'long' } },
    },
  })
  const red = redactSettings(s)
  assert.equal(red.llm.apiKey, 'sk-d****9876')
  assert.equal(red.llm.apiKeySet, true)
  assert.equal(red.llm.purposes.memoryJudge.apiKey, 'sk-j****5555')
  assert.equal(red.llm.purposes.memoryJudge.apiKeySet, true)
  assert.equal(red.llm.purposes.wiki.apiKeySet, false, '没配 key 的用途该明确是 false')
  const json = JSON.stringify(red)
  for (const secret of ['sk-default-9876', 'sk-judge-5555']) {
    assert.ok(!json.includes(secret), `脱敏后仍含明文 ${secret}`)
  }
})

test('短 key 也脱敏（不给长度信息）', () => {
  const red = redactSettings(withDefaults({ llm: { apiKey: 'short', purposes: { wiki: { apiKey: 'abc' } } } }))
  assert.equal(red.llm.apiKey, '****')
  assert.equal(red.llm.purposes.wiki.apiKey, '****')
})

test('脱敏不破坏其他字段，且不改入参', () => {
  const s = withDefaults({ llm: { model: 'big', purposes: { wiki: { model: 'long', baseUrl: 'https://x/v1' } } } })
  const before = JSON.stringify(s)
  const red = redactSettings(s)
  assert.equal(JSON.stringify(s), before, '入参不许被改')
  assert.equal(red.llm.model, 'big')
  assert.equal(red.llm.purposes.wiki.model, 'long')
  assert.equal(red.llm.purposes.wiki.baseUrl, 'https://x/v1')
})

// ══════════════════ E. 合并与持久化 ══════════════════

test('★ 合并是逐用途深合并：后加一个用途不影响已有的', () => {
  let s = withDefaults({ llm: { purposes: { memoryJudge: { model: 'tiny' } } } })
  s = mergeSettings(s, { llm: { purposes: { wiki: { model: 'long' } } } })
  assert.equal(s.llm.purposes.memoryJudge.model, 'tiny', '已存在的用途被覆盖掉了')
  assert.equal(s.llm.purposes.wiki.model, 'long')
})

test('★ 同一用途内也是深合并（改 model 不会把 key 抹掉）', () => {
  let s = withDefaults({ llm: { purposes: { cardFill: { model: 'a', apiKey: 'sk-1' } } } })
  s = mergeSettings(s, { llm: { purposes: { cardFill: { model: 'b' } } } })
  assert.equal(s.llm.purposes.cardFill.model, 'b')
  assert.equal(s.llm.purposes.cardFill.apiKey, 'sk-1', '同一用途内的其他字段不该被抹掉')
})

test('★ 经由 store 存盘再读回，分用途配置与脱敏都成立', () => {
  const d = mkdtempSync(join(tmpdir(), 'pet-purpose-'))
  try {
    const store = createStore({ dir: d })
    const r = store.setSettings({
      llm: {
        provider: 'llm', model: 'big', apiKey: 'sk-default-1111',
        purposes: { memoryJudge: { model: 'tiny', apiKey: 'sk-judge-2222' }, tools: { model: 'strict' } },
      },
    })
    assert.equal(r.ok, true, (r.errors ?? []).join(' | '))
    const back = store.getSettings()
    assert.equal(resolveLlmConfig(back, 'memoryJudge').model, 'tiny')
    assert.equal(resolveLlmConfig(back, 'memoryJudge').apiKey, 'sk-judge-2222', '存盘后原文必须还在')
    assert.equal(resolveLlmConfig(back, 'tools').apiKey, 'sk-default-1111')
    // 快照（界面用）必须是脱敏的
    assert.ok(!JSON.stringify(redactSettings(back)).includes('sk-judge-2222'))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('★ 写入未登记用途会被 store 拒掉（白名单真的在生效）', () => {
  const d = mkdtempSync(join(tmpdir(), 'pet-purpose2-'))
  try {
    const store = createStore({ dir: d })
    const r = store.setSettings({ llm: { purposes: { 瞎写: { model: 'x' } } } })
    assert.equal(r.ok, false)
    assert.ok(r.errors.some((e) => e.includes('未登记')), r.errors.join(' | '))
    assert.deepEqual(store.getSettings().llm.purposes, {}, '不该被写进去')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ══════════════════ F. 启动器设置 ══════════════════

test('★ 启动器设置：默认值合理，且收藏必须带 dir', () => {
  const d = DEFAULT_SETTINGS.launcher
  assert.deepEqual([...d.favorites], [])
  assert.equal(d.autoStartWatch, true, '启动后应当自动开始监视 —— 那才是"启动器"的意义')
  assert.equal(d.confirmBeforeLaunch, true, '启动可执行文件是有副作用的动作，默认要确认')
  assert.equal(validateSettings(withDefaults({})).ok, true)
  assert.equal(validateSettings(withDefaults({ launcher: { favorites: [{}] } })).ok, false)
  assert.equal(validateSettings(withDefaults({ launcher: { favorites: [{ dir: 'E:\\a', name: 'x' }] } })).ok, true)
  assert.equal(validateSettings(withDefaults({ launcher: { autoStartWatch: 'yes' } })).ok, true, '布尔项类型暂不深查（宽松）')
  assert.equal(validateSettings(withDefaults({ game: { exePath: 42 } })).ok, false)
})
