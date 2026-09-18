// tests/memory-v2.test.mjs —— 记忆系统 V2：分型打分 / LLM 评分过滤 / hash 去重 /
// 命中强化 / 时间衰减 / 3000 条淘汰
//
// 这一层最容易"看起来做了、其实没生效"，所以每条要求都对着**可观测的行为**断言：
//   分型打分   ⇒ 同一时刻，设定类与流水账的分数差要能被指出来（并写进 why）
//   评分过滤   ⇒ 低分的**确实进不去**，而评分服务坏掉时**一条都不许丢**
//   hash 去重  ⇒ 标点不同、说法稍异的同一件事折叠成一条（而不是靠精确字符串相等）
//   命中强化   ⇒ 反复出现会加权，但**分型封顶**（流水账刷次数顶不到最前面）
//   时间衰减   ⇒ 半衰期按类型走（设定比流水账活得久）
//   3000 淘汰  ⇒ 超容量能收敛，且**批量**腾位（不然每次写入都要全量排序）

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MEMORY_DEFAULTS, MEMORY_KINDS, KIND_POLICY, DEFAULT_POLICY, JUDGE_SKIP_KINDS,
  createMemory, migrateMemory, remember, rememberAll, rememberEvents, consolidate,
  recall, scoreOf, markRecalled, forget, digest, stats, startSession,
  hashOf, policyFor, partitionByHash, weightFromScore,
  judgeImportance, parseJudgeScores, buildJudgePrompt, rememberScored,
} from '../core/memory.mjs'

const T0 = 1_700_000_000_000
const DAY = 24 * 3600_000
const HOUR = 3600_000

// ══════════════════ A. 分型策略表 ══════════════════

test('★ 每个记忆类别都有策略（不能有"没人管"的类别）', () => {
  for (const k of MEMORY_KINDS) {
    const p = policyFor(k)
    assert.ok(Number.isFinite(p.halfLifeMs) && p.halfLifeMs > 0, `${k} 缺半衰期`)
    assert.ok(p.weight >= 0 && p.weight <= 1, `${k} 权重越界`)
    assert.ok(p.reinforce >= 0, `${k} 缺强化上限`)
    assert.ok(p.evictBonus >= 0, `${k} 缺淘汰保护`)
  }
})

test('★ 分型的判据是"还值不值得提"的时间尺度：设定按年、流水账按天', () => {
  const y = (k) => policyFor(k).halfLifeMs / DAY
  assert.ok(y('fact') > y('summary'), '设定该比一局汇总活得更久')
  assert.ok(y('fact') > y('save'), '设定该比存档流水活得久')
  assert.ok(y('summary') > y('save'), '一局汇总该比存档流水活得久')
  assert.ok(y('save') <= 7, '存档流水必须衰减得很快，否则噪声会挤满召回位')
  assert.ok(y('fact') >= 300, '设定类该按年计')
})

test('★ 强化上限也分型：高频流水不许靠刷次数把自己顶上去', () => {
  assert.ok(policyFor('fact').reinforce > policyFor('save').reinforce)
  assert.ok(policyFor('player-said').reinforce > policyFor('save').reinforce)
})

test('★ 淘汰保护分：设定 > 玩家说过的话 > 汇总 > 存档', () => {
  const b = (k) => policyFor(k).evictBonus
  assert.ok(b('fact') > b('player-said'))
  assert.ok(b('player-said') > b('summary'))
  assert.ok(b('summary') > b('save'))
  assert.equal(b('save'), 0)
})

test('未登记类别退回兜底策略（而不是报错）', () => {
  assert.deepEqual(policyFor('不存在'), policyFor('__none__'))
  assert.equal(policyFor('__none__').halfLifeMs, DEFAULT_POLICY.halfLifeDays * DAY)
  assert.equal(policyFor(null).halfLifeMs, DEFAULT_POLICY.halfLifeDays * DAY)
})

test('KIND_POLICY 是冻结的（不许运行时被改）', () => {
  assert.ok(Object.isFrozen(KIND_POLICY))
  assert.throws(() => { KIND_POLICY.save = { weight: 9 } }, TypeError)
})

// ══════════════════ B. hash 去重 ══════════════════

test('★ hashOf 确定性、16 位十六进制、对 kind/game 敏感', () => {
  const a = hashOf('存档已更新', 'save', 'g1')
  assert.equal(a, hashOf('存档已更新', 'save', 'g1'), '同输入必须同输出')
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, hashOf('存档已更新', 'save', 'g2'), '不同游戏要分开')
  assert.notEqual(a, hashOf('存档已更新', 'death', 'g1'), '不同类别要分开')
  assert.notEqual(a, hashOf('存档已更新的', 'save', 'g1'))
})

test('★ hash 对空白与标点不敏感（「存档已更新。」与「存档已更新」是同一件事）', () => {
  assert.equal(hashOf('存档已更新。', 'save', 'g'), hashOf('存档已更新', 'save', 'g'))
  assert.equal(hashOf('  角色 #1 倒下了 ', 'death', 'g'), hashOf('角色 #1 倒下了', 'death', 'g'))
  assert.equal(hashOf('a，b、c', 'item', 'g'), hashOf('abc', 'item', 'g'))
})

test('hashOf 对空/脏输入不崩', () => {
  for (const bad of [null, undefined, '', 0, {}, []]) {
    assert.doesNotThrow(() => hashOf(bad, 'save', 'g'))
    assert.match(hashOf(bad, 'save', 'g'), /^[0-9a-f]{16}$/)
  }
})

test('★ 同 hash 写入 ⇒ 折叠成一条（不是新增）', () => {
  let m = createMemory()
  m = remember(m, { kind: 'save', text: '存档已更新', at: T0 })
  m = remember(m, { kind: 'save', text: '存档已更新。', at: T0 + HOUR })   // 只差一个句号
  m = remember(m, { kind: 'save', text: ' 存档已更新 ', at: T0 + 2 * HOUR })
  assert.equal(m.entries.length, 1, '同一件事必须折叠')
  assert.equal(m.entries[0].count, 3, '命中要强化计数')
  assert.equal(m.entries[0].lastSeenAt, T0 + 2 * HOUR, '时间要刷到最近')
  assert.equal(m.entries[0].at, T0 + 2 * HOUR)
  assert.equal(m.entries[0].firstAt, T0, '首次时间要保留')
})

test('★ 条目在写入时就带上 hash 与 policy（策略随条目固定）', () => {
  const m = remember(createMemory(), { kind: 'fact', text: '她怕黑', at: T0 })
  const e = m.entries[0]
  assert.match(e.hash, /^[0-9a-f]{16}$/)
  assert.deepEqual(e.policy, policyFor('fact'))
  assert.equal(e.policy.halfLifeMs, 365 * DAY)
})

test('★ 基础权重取「调用方给的」与「类别下限」的较高者', () => {
  const strong = remember(createMemory(), { kind: 'fact', text: 'x', weight: 0.95, at: T0 })
  assert.equal(strong.entries[0].weight, 0.95, '调用方给得更高就用它')
  const noWeight = remember(createMemory(), { kind: 'fact', text: 'y', at: T0 })
  assert.equal(noWeight.entries[0].weight, 0.90, '没给 weight 时不该退化成流水账')
  const noise = remember(createMemory(), { kind: 'save', text: 'z', weight: 0.9, at: T0 })
  assert.equal(noise.entries[0].weight, 0.9, '调用方给的权重仍然被尊重')
})

test('partitionByHash 分出"新的"与"已见过的"', () => {
  let m = remember(createMemory(), { kind: 'death', text: '角色倒下了', at: T0 })
  const { fresh, dup } = partitionByHash(m, [
    { kind: 'death', text: '角色倒下了' },       // 已见
    { kind: 'item', text: '拿到一把剑' },        // 新
    { kind: 'item', text: '' },                  // 空文本应被丢掉
    null,
  ])
  assert.equal(dup.length, 1)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].text, '拿到一把剑')
})

// ══════════════════ C. 时间衰减（分型） ══════════════════

test('★ 一年之后，设定类还在、存档流水基本淡没', () => {
  const mk = (kind) => ({ weight: 0.5, at: T0, count: 1, kind, text: 'x', lastHitAt: null, policy: policyFor(kind) })
  const later = T0 + 365 * DAY
  const fact = scoreOf(mk('fact'), { now: later }).score
  const save = scoreOf(mk('save'), { now: later }).score
  assert.ok(fact > save, `设定(${fact.toFixed(3)}) 该比存档(${save.toFixed(3)}) 活得久`)
  assert.ok(save < 0.51, '存档流水一年后该几乎只剩基础权重')
  // fact 的半衰期正好 365 天 ⇒ 一年后时间项恰好衰减一半（0.5）
  assert.ok(Math.abs(fact - 1.0) < 1e-9, `设定一年后应剩 weight 0.5 + 衰减 0.5 = 1.0，实际 ${fact}`)
  assert.ok(fact - save >= 0.45, '两者的差距应当明显')
})

test('★ 分型衰减在 why 里可解释（能看出用的是哪条半衰期）', () => {
  const e = { weight: 0.5, at: T0, count: 1, kind: 'fact', text: 'x', lastHitAt: null, policy: policyFor('fact') }
  const { why } = scoreOf(e, { now: T0 + DAY })
  assert.ok(why.some((w) => w.includes('半衰期') && w.includes('365')), why.join(' | '))
})

test('★ 没有 policy 的条目（手写/老库）行为与 V1 完全一致 —— 全局一周半衰期', () => {
  const e = { weight: 0.5, at: T0, count: 1, kind: 'save', text: 'x', lastHitAt: null }
  assert.equal(scoreOf(e, {}).score, 0.5, '不给 now 就只有权重')
  const half = scoreOf(e, { now: T0 + 7 * DAY }).score
  assert.ok(Math.abs(half - 1.0) < 1e-9, `一周后应正好衰减一半：${half}`)
  const { why } = scoreOf(e, { now: T0 + DAY })
  assert.ok(!why.some((w) => w.includes('半衰期')), '没有策略就不该打印分型说明')
})

// ══════════════════ D. 命中强化（分型封顶） ══════════════════

test('★ 反复出现会加权，但流水账有封顶 —— 刷次数顶不到设定前面', () => {
  const noise = {
    weight: 0.2, at: T0, count: 30, kind: 'save', text: '存档已更新', lastHitAt: null,
    policy: policyFor('save'),
  }
  const { score, why } = scoreOf(noise, { now: T0 })
  // save 的 reinforce=1 ⇒ 封顶 0.1
  assert.ok(score <= 0.2 + 1 + 0.1 + 1e-9, `封顶失效：${score}`)
  assert.ok(why.some((w) => w.includes('已封顶')), why.join(' | '))

  const fact = {
    weight: 0.9, at: T0, count: 3, kind: 'fact', text: '她怕黑', lastHitAt: null,
    policy: policyFor('fact'),
  }
  assert.ok(scoreOf(fact, { now: T0 }).score > score, '设定该压过刷了 30 次的流水账')
})

test('★ 强化上限确实按类型区分（fact 能比 save 拿到更多强化分）', () => {
  const mk = (kind, count) => ({
    weight: 0.3, at: T0, count, kind, text: 'x', lastHitAt: null, policy: policyFor(kind),
  })
  const factGain = scoreOf(mk('fact', 20), { now: T0 }).score - scoreOf(mk('fact', 1), { now: T0 }).score
  const saveGain = scoreOf(mk('save', 20), { now: T0 }).score - scoreOf(mk('save', 1), { now: T0 }).score
  assert.ok(factGain > saveGain, `fact 强化(${factGain.toFixed(2)}) 该大于 save(${saveGain.toFixed(2)})`)
  assert.ok(Math.abs(saveGain - 0.1) < 1e-9, `save 的强化该正好封在 0.10：${saveGain}`)
})

test('★ remember 的强化路径不会丢掉 hash / policy（强化后仍分型）', () => {
  let m = remember(createMemory(), { kind: 'fact', text: '她怕黑', at: T0 })
  m = remember(m, { kind: 'fact', text: '她怕黑。', at: T0 + DAY, weight: 0.5 })
  assert.equal(m.entries.length, 1)
  assert.ok(m.entries[0].hash, 'hash 不能被抹掉')
  assert.deepEqual(m.entries[0].policy, policyFor('fact'), 'policy 不能被抹掉')
  assert.equal(m.entries[0].count, 2)
})

// ══════════════════ E. 淘汰（3000 条 + 批量 + 分型保护） ══════════════════

test('★ 默认容量是 3000', () => {
  assert.equal(MEMORY_DEFAULTS.maxEntries, 3000)
  assert.equal(createMemory().maxEntries, 3000)
})

test('★ 超容量会收敛，且是**批量**腾位（不是每写一条丢一条）', () => {
  let m = createMemory({ maxEntries: 100 })
  for (let i = 0; i < 101; i++) m = remember(m, { kind: 'item', text: `第 ${i} 件`, at: T0 + i })
  const r = forget(m, { now: T0 + 200 })
  // evictBatchRatio 0.05 ⇒ 目标 100 - 5 = 95
  assert.equal(r.target, 95)
  assert.equal(r.memory.entries.length, 95)
  assert.equal(r.dropped.length, 6)
  // 再写几条不该立刻又触发淘汰
  let m2 = r.memory
  for (let i = 0; i < 4; i++) m2 = remember(m2, { kind: 'item', text: `补 ${i}`, at: T0 + 300 + i })
  assert.equal(forget(m2, { now: T0 + 400 }).dropped.length, 0, '批量腾位应该吸收掉后续若干条写入')
})

test('★ 容量没超时不动任何东西', () => {
  let m = createMemory({ maxEntries: 10 })
  for (let i = 0; i < 10; i++) m = remember(m, { kind: 'item', text: `x${i}`, at: T0 })
  const r = forget(m, { now: T0 })
  assert.deepEqual(r.dropped, [])
  assert.equal(r.memory.entries.length, 10)
})

test('★ 分型保护分真的救得下设定：同样权重同样时间，先丢流水账', () => {
  let m = createMemory({ maxEntries: 3 })
  m = remember(m, { kind: 'save', text: '存档流水 A', weight: 0.5, at: T0 })
  m = remember(m, { kind: 'save', text: '存档流水 B', weight: 0.5, at: T0 })
  m = remember(m, { kind: 'fact', text: '她的本名叫霞', weight: 0.5, at: T0 })
  m = remember(m, { kind: 'save', text: '存档流水 C', weight: 0.5, at: T0 })
  const r = forget(m, { now: T0 })
  const kept = r.memory.entries.map((e) => e.text)
  assert.ok(kept.includes('她的本名叫霞'), `设定被丢了：${kept.join('、')}`)
  assert.equal(r.memory.entries.length, 3)
})

test('pinned 的条目永不淘汰（哪怕权重极低）', () => {
  let m = createMemory({ maxEntries: 3 })
  m = remember(m, { kind: 'fact', text: '钉住的设定', weight: 0.01, at: T0, pinned: true })
  for (let i = 0; i < 10; i++) m = remember(m, { kind: 'save', text: `流水 ${i}`, weight: 0.9, at: T0 + i })
  const r = forget(m, { now: T0 + 100 })
  assert.ok(r.memory.entries.some((e) => e.text === '钉住的设定'), 'pinned 被淘汰了')
})

test('★ 3000 条规模下淘汰可用（真实规模、不超时）', () => {
  let m = createMemory()
  const t0 = Date.now()
  for (let i = 0; i < 3100; i++) {
    m = remember(m, { kind: 'item', text: `事件 ${i}`, at: T0 + i * 1000 })
  }
  assert.equal(m.entries.length, 3100)
  const r = forget(m, { now: T0 + 3100 * 1000 })
  assert.equal(r.target, 3000 - Math.floor(3000 * 0.05))
  assert.ok(r.memory.entries.length <= 3000)
  assert.ok(Date.now() - t0 < 20000, '3000 条规模不该慢到超时')
})

// ══════════════════ F. LLM 评分过滤 ══════════════════

function fakeProvider(reply, { available = true, throws = false } = {}) {
  return {
    id: 'fake-judge',
    available: () => available,
    async generate(request) {
      assert.ok(typeof request.rawPrompt === 'string' && request.rawPrompt.length > 0, '必须发原始提示词')
      if (throws) throw new Error('judge 服务炸了')
      return { text: typeof reply === 'function' ? reply(request) : reply }
    },
  }
}

test('★ 没有 provider ⇒ 明确返回"未评分"，绝不丢记忆', async () => {
  const r = await judgeImportance([{ kind: 'death', text: '倒下了' }], {})
  assert.equal(r.ok, false)
  assert.deepEqual(r.scores, [null])
  assert.ok(r.notes.some((n) => n.includes('不评分')), r.notes.join(' | '))
})

test('★ provider 不可用 / 抛异常 / 返回垃圾 ⇒ 都是"未评分"，不抛', async () => {
  const items = [{ kind: 'death', text: '倒下了' }]
  const unavailable = await judgeImportance(items, { provider: fakeProvider('', { available: false }) })
  assert.equal(unavailable.ok, false)
  assert.ok(unavailable.notes.some((n) => n.includes('不可用')))

  const boom = await judgeImportance(items, { provider: fakeProvider(null, { throws: true }) })
  assert.equal(boom.ok, false)
  assert.ok(boom.notes.some((n) => n.includes('炸了')), boom.notes.join(' | '))

  const junk = await judgeImportance(items, { provider: fakeProvider('我觉得还行吧') })
  assert.equal(junk.ok, false)
  assert.ok(junk.notes.some((n) => n.includes('解析不了')))
})

test('★ 流水账类别不送去评分（省 token，且它们本来就不需要判）', async () => {
  let sawPrompt = null
  const p = {
    available: () => true,
    async generate(r) { sawPrompt = r.rawPrompt; return { text: '[{"i":0,"score":0.9}]' } },
  }
  const r = await judgeImportance([
    { kind: 'save', text: '存档已更新' },
    { kind: 'exit', text: '游戏退出' },
    { kind: 'system', text: '系统消息' },
    { kind: 'death', text: '角色倒下了' },
  ], { provider: p })
  assert.equal(r.ok, true)
  assert.ok(!sawPrompt.includes('存档已更新'), '流水账不该进提示词')
  assert.ok(sawPrompt.includes('角色倒下了'))
  assert.equal(r.scores[0], null, 'save 不参与评分 ⇒ null')
  assert.equal(r.scores[1], null)
  assert.equal(r.scores[2], null)
  assert.equal(r.scores[3], 0.9)
  assert.equal(r.usage.skipped, 3)
})

test('候选全是流水账 ⇒ 不调用模型', async () => {
  let called = 0
  const p = { available: () => true, async generate() { called++; return { text: '[]' } } }
  const r = await judgeImportance([{ kind: 'save', text: '存档已更新' }], { provider: p })
  assert.equal(called, 0)
  assert.equal(r.ok, false)
  assert.ok(r.notes.some((n) => n.includes('不值得评分')))
})

test('★ 送评条数有上限（一局几百条事件不许把 token 打爆）', async () => {
  let seen = 0
  const p = {
    available: () => true,
    async generate(r) {
      seen = (r.rawPrompt.match(/^\d+\. \[/gm) ?? []).length
      return { text: JSON.stringify(Array.from({ length: seen }, (_, i) => ({ i, score: 0.5 }))) }
    },
  }
  const items = Array.from({ length: 80 }, (_, i) => ({ kind: 'item', text: `事件 ${i}` }))
  const r = await judgeImportance(items, { provider: p, maxItems: 10 })
  assert.equal(seen, 10, `只该送 10 条，实际 ${seen}`)
  assert.equal(r.ok, true)
  assert.equal(r.scores.filter((s) => s !== null).length, 10)
  assert.equal(r.scores.filter((s) => s === null).length, 70, '超出上限的那些应当留空')
})

test('parseJudgeScores：裸数组 / {i,score} / 代码块 / 乱序下标', () => {
  assert.deepEqual(parseJudgeScores('[0.9,0.1]', 2).scores, [0.9, 0.1])
  assert.deepEqual(parseJudgeScores('[{"i":0,"score":0.7}]', 1).scores, [0.7])
  assert.deepEqual(parseJudgeScores('[{"i":1,"score":0.3},{"i":0,"score":0.6}]', 2).scores, [0.6, 0.3], '按 i 归位')
  assert.deepEqual(parseJudgeScores('```json\n[0.5]\n```', 1).scores, [0.5])
  // 越界下标：**丢掉而不是错位**；全都越界 ≡「没有可用分数」
  assert.deepEqual(parseJudgeScores('[{"i":0,"score":0.6},{"i":5,"score":0.9}]', 2).scores, [0.6, null])
  assert.equal(parseJudgeScores('[{"i":5,"score":0.9}]', 2).ok, false)
  assert.deepEqual(parseJudgeScores('[{"score":-1}]', 1).scores, [0], '负数夹到 0')
})

test('★ parseJudgeScores 的刻度识别：按批判定、且只缩放 >1 的值', () => {
  // 全是 0~1 ⇒ 原样
  assert.equal(parseJudgeScores('[0.9,0.1]', 2).scale, 1)
  // 有 >10 的值 ⇒ 百分制
  assert.deepEqual(parseJudgeScores('[{"i":0,"score":85}]', 1).scores, [0.85])
  assert.equal(parseJudgeScores('[{"i":0,"score":85}]', 1).scale, 100)
  // 有 >1 但不 >10 ⇒ 十分制（同一个 `2`，按批判定才不会两边都猜错）
  assert.deepEqual(parseJudgeScores('[{"i":0,"score":2}]', 1).scores, [0.2])
  assert.equal(parseJudgeScores('[{"i":0,"score":2}]', 1).scale, 10)
  // ★ 混着写的时候：只缩放 >1 的值，别把本来正确的 0.9 毁掉
  assert.deepEqual(parseJudgeScores('[0.9, 85]', 2).scores, [0.9, 0.85])
  assert.deepEqual(parseJudgeScores('[0.9, 2]', 2).scores, [0.9, 0.2])
  // 夹紧
  assert.deepEqual(parseJudgeScores('[{"i":0,"score":150}]', 1).scores, [1])
})

test('parseJudgeScores：坏输入给可读错误，不抛', () => {
  for (const bad of ['', '随便说说', '{坏}', '[]', '[{"nope":1}]', null, undefined]) {
    assert.doesNotThrow(() => parseJudgeScores(bad, 2), JSON.stringify(bad))
    assert.equal(parseJudgeScores(bad, 2).ok, false, JSON.stringify(bad))
  }
  assert.match(parseJudgeScores('', 1).error, /空内容/)
  assert.match(parseJudgeScores('随便', 1).error, /没有 JSON 数组/)
})

test('★ 权重取「分型下限」与「模型分」的较高者（模型能把重要性抬高，但压不掉类别下限）', () => {
  assert.equal(weightFromScore('fact', 0.2), policyFor('fact').weight, '低分不该把设定压成流水账')
  assert.equal(weightFromScore('fact', 0.99), 0.99, '高分要采用')
  assert.equal(weightFromScore('save', 0.9), 0.9, '高分的流水账也可以是重要的（那天他通关了）')
  assert.equal(weightFromScore('item', null), policyFor('item').weight, '没分就用类别下限')
  assert.equal(weightFromScore('item', NaN), policyFor('item').weight)
})

test('buildJudgePrompt：要求只输出 JSON 数组、长度一致，并带上打分标准', () => {
  const p = buildJudgePrompt([{ kind: 'death', text: '角色倒下' }, { kind: 'progress', text: '等级 12→13' }])
  assert.match(p, /只输出 JSON 数组/)
  assert.match(p, /长度与输入一致/)
  assert.match(p, /0\.8~1\.0/)
  assert.ok(p.includes('角色倒下'))
  assert.ok(p.includes('[progress] 等级 12→13'))
})

// ══════════════════ G. V2 入库主流程 ══════════════════

test('★ rememberScored：低分的被过滤、高分的入库，并给出计数', async () => {
  const p = fakeProvider(JSON.stringify([{ i: 0, score: 0.9 }, { i: 1, score: 0.05 }]))
  const r = await rememberScored(createMemory(), [
    { kind: 'death', text: '关键角色倒下了' },
    { kind: 'item', text: '捡到一块石头' },
  ], { provider: p, now: T0 })
  assert.equal(r.judged, 2)
  assert.equal(r.filtered, 1)
  assert.equal(r.admitted, 1)
  assert.equal(r.memory.entries.length, 1)
  assert.equal(r.memory.entries[0].text, '关键角色倒下了')
  assert.equal(r.memory.entries[0].weight, 0.9, '模型的高分应当成为权重')
  assert.ok(r.notes.some((n) => n.includes('低于门槛')))
})

test('★ rememberScored：评分服务坏掉时**一条都不丢**（这是硬要求）', async () => {
  const r = await rememberScored(createMemory(), [
    { kind: 'death', text: '倒下了' },
    { kind: 'item', text: '捡到石头' },
  ], { provider: fakeProvider(null, { throws: true }), now: T0 })
  assert.equal(r.admitted, 2, '评分失败绝不能导致记忆丢失')
  assert.equal(r.filtered, 0)
  assert.equal(r.judged, 0)
  assert.equal(r.memory.entries.length, 2)
  assert.ok(r.notes.some((n) => n.includes('炸了')))
})

test('★ rememberScored：没有 provider 也要正常入库（降级路径）', async () => {
  const r = await rememberScored(createMemory(), [{ kind: 'fact', text: '她怕黑' }], { now: T0 })
  assert.equal(r.admitted, 1)
  assert.equal(r.memory.entries[0].weight, policyFor('fact').weight)
  assert.ok(r.notes.some((n) => n.includes('不评分')))
})

test('★ rememberScored：同 hash 的重复只强化、不送评分（省 token 且不会被判掉）', async () => {
  let called = 0
  const p = { available: () => true, async generate() { called++; return { text: '[{"i":0,"score":0.9}]' } } }
  let m = remember(createMemory(), { kind: 'death', text: '倒下了', at: T0 })
  const r = await rememberScored(m, [
    { kind: 'death', text: '倒下了' },        // 已在库里
    { kind: 'item', text: '新东西' },         // 新的 ⇒ 才需要评
  ], { provider: p, now: T0 + HOUR })
  assert.equal(called, 1, '只该为"新的"那一条调用模型')
  assert.equal(r.reinforced, 1)
  assert.equal(r.admitted, 1)
  const death = r.memory.entries.find((e) => e.kind === 'death')
  assert.equal(death.count, 2, '重复出现要强化计数')
})

test('★ rememberScored：容量超了会淘汰，并在 notes 里说明', async () => {
  let m = createMemory({ maxEntries: 5 })
  for (let i = 0; i < 5; i++) m = remember(m, { kind: 'item', text: `旧 ${i}`, at: T0 })
  const r = await rememberScored(m, [
    { kind: 'progress', text: '新进展 A' },
    { kind: 'progress', text: '新进展 B' },
  ], { now: T0 + HOUR })
  assert.equal(r.dropped > 0, true)
  assert.ok(r.notes.some((n) => n.includes('淘汰')))
  assert.ok(r.memory.entries.length <= 5)
})

test('rememberScored 对脏输入不崩', async () => {
  for (const bad of [null, undefined, [], [null], ['x'], [{}]]) {
    assert.doesNotThrow(() => rememberScored(createMemory(), bad, {}))
    const r = await rememberScored(createMemory(), bad, {})
    assert.equal(r.admitted, 0)
  }
})

// ══════════════════ H. 迁移（V1 → V2） ══════════════════

test('★ migrateMemory：补 hash 与 policy，但**不动已有数值**', () => {
  const v1 = {
    version: 1,
    entries: [
      { id: 'a', fingerprint: 'save|g|存档已更新', kind: 'save', game: 'g', text: '存档已更新', weight: 0.8123, count: 7, at: T0, firstAt: T0, lastSeenAt: T0 + HOUR, hits: 3, lastHitAt: T0, pinned: false, data: null },
    ],
    maxEntries: 400,
    game: 'g',
    sessionCount: 2,
  }
  const { memory, migrated, already } = migrateMemory(v1)
  assert.equal(migrated, 1)
  assert.equal(already, false)
  assert.equal(memory.version, 2)
  const e = memory.entries[0]
  assert.match(e.hash, /^[0-9a-f]{16}$/)
  assert.deepEqual(e.policy, policyFor('save'))
  // 数值零漂移
  assert.equal(e.weight, 0.8123, '权重不许被重算')
  assert.equal(e.count, 7)
  assert.equal(e.hits, 3)
  assert.equal(e.at, T0)
  assert.equal(memory.maxEntries, 400, '用户的容量设置不许被覆盖')
})

test('★ migrateMemory 幂等：跑第二次什么都不改', () => {
  const v1 = { version: 1, entries: [{ kind: 'save', text: 'x', weight: 0.5, count: 1, at: T0 }], maxEntries: 400 }
  const once = migrateMemory(v1).memory
  const twice = migrateMemory(once)
  assert.equal(twice.already, true)
  assert.equal(twice.migrated, 0)
  assert.deepEqual(twice.memory, once)
})

test('migrateMemory 对脏输入不崩', () => {
  for (const bad of [null, undefined, 0, 'x', {}, { entries: null }]) {
    assert.doesNotThrow(() => migrateMemory(bad))
  }
  assert.equal(migrateMemory(null).memory.version, 2)
})

test('★ 迁移之后老条目开始享受分型（设定类的衰减变慢）', () => {
  const v1 = {
    version: 1,
    entries: [{ kind: 'fact', text: '她的本名叫霞', weight: 0.5, count: 1, at: T0, hits: 0, lastHitAt: null }],
  }
  const before = scoreOf(v1.entries[0], { now: T0 + 200 * DAY }).score
  const after = scoreOf(migrateMemory(v1).memory.entries[0], { now: T0 + 200 * DAY }).score
  assert.ok(after > before, `迁移后设定该更耐久：${before} -> ${after}`)
})

// ══════════════════ I. 与既有能力的一致性 ══════════════════

test('★ V1 的既有契约没有被破坏（召回/摘要/统计/会话）', () => {
  let m = createMemory()
  const s = startSession(m)
  m = s.memory
  m = rememberEvents(m, [
    { kind: 'death', text: '角色 #1 倒下了', importance: 0.9, at: T0 },
    { kind: 'save', text: '存档已更新', importance: 0.3, at: T0 },
  ], { now: T0, game: 'g', session: s.session })
  const r = recall(m, { terms: ['倒下'], now: T0 + HOUR })
  assert.ok(r.length >= 1)
  assert.equal(r[0].entry.kind, 'death')
  const d = digest(m, {}, { now: T0 + HOUR })
  assert.match(d.text, /与这个玩家有关的记忆/)
  assert.ok(stats(m).entries >= 2)
})

test('★ 一局压缩出来的记忆也带 hash/policy（consolidate 走的是同一条写入路径）', () => {
  const events = [
    { kind: 'death', text: '角色倒下了', importance: 0.9, at: T0 },
    { kind: 'save', text: '存档已更新', importance: 0.3, at: T0 + HOUR },
    { kind: 'progress', text: '等级 12→13', importance: 0.5, at: T0 + 2 * HOUR },
  ]
  const { memory } = consolidate(createMemory(), events, { now: T0 + 3 * HOUR, game: 'g', session: 's1' })
  for (const e of memory.entries) {
    assert.ok(e.hash, `${e.text} 缺 hash`)
    assert.ok(e.policy, `${e.text} 缺 policy`)
  }
  const summary = memory.entries.find((e) => e.kind === 'summary')
  assert.equal(summary.policy.halfLifeMs, 60 * DAY, '汇总该走自己的半衰期')
})

test('★ 3000 条记忆仍能召回（规模下不退化）', () => {
  let m = createMemory()
  for (let i = 0; i < 3000; i++) {
    m = remember(m, { kind: 'item', text: `事件 ${i} 号`, at: T0 + i * 1000 })
  }
  m = remember(m, { kind: 'fact', text: '她的本名叫霞', weight: 0.9, at: T0 + 1e6 })
  const r = recall(m, { terms: ['本名'], now: T0 + 1e6 + HOUR })
  assert.ok(r.length >= 1, '3000 条里该找得到那条设定')
  assert.equal(r[0].entry.text, '她的本名叫霞')
})

test('markRecalled 仍然生效（念叨惩罚依赖它）', () => {
  let m = remember(createMemory(), { kind: 'death', text: 'x', at: T0 })
  const first = recall(m, { now: T0 })
  assert.equal(first.length, 1)
  m = markRecalled(m, first, T0 + 1000)
  assert.equal(m.entries[0].hits, 1)
  assert.equal(m.entries[0].lastHitAt, T0 + 1000)
  const after = scoreOf(m.entries[0], { now: T0 + 2000 })
  assert.ok(after.why.some((w) => w.includes('刚说过')), after.why.join(' | '))
})
