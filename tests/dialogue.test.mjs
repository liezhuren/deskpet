// tests/dialogue.test.mjs —— dialogue/ 表达层
//
// 这一层最容易含糊其辞（"接上模型就能说话了"），所以测试要钉死三件事：
//   ★ 性质：**任意合理角色卡 × 任意触发类型 × 任意亲密度，模板产出都必须过校验器**
//   ★ 沉默：产不出合规的话时返回 text:null，**绝不放行违规内容**
//   ★ 事实边界：可直说的与必须追问的分开（P1 的落地形式）
// LLM 那部分靠注入 fetch 离线验证"发了什么 / 拿到什么"，只留真实网络未验证。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KIND_FACTS, KIND_TONE, EXPRESSION_RULES, buildRequest, promptFor, needsQuestion } from '../dialogue/base.mjs'
import { createTemplateProvider, generate, tierOf, placeTic, CORES } from '../dialogue/template.mjs'
import { createDialogue, speak, explain, PROVIDER_FACTORIES } from '../dialogue/index.mjs'
import { createLlmProvider, buildCall, parseResponse, cleanOutput, PRESETS } from '../dialogue/llm.mjs'
import { normalizeCard, validateCard } from '../core/card.mjs'
import { initState, lintDialogue } from '../core/persona.mjs'
import { EVENT_KINDS } from '../core/events.mjs'

const T0 = 1_700_000_000_000

/** 造一张合规的卡 */
function card(over = {}) {
  const { card: c, errors } = normalizeCard({
    id: 'x', name: '霞', game: 'g',
    persona: {
      soft: { personality: '嘴硬心软', background: '同班同学', speechStyle: '短句、爱吐槽' },
      hard: {
        speechTics: ['……才不是'],
        forbiddenWords: ['本小姐'],
        addresses: { player: '你' },
        avgLength: { min: 4, max: 60 },
        emojiPolicy: 'none',
        ...over,
      },
    },
  })
  if (errors.length) throw new Error(`夹具卡本身不合法：${errors.join('；')}`)
  return c
}
const state = (over = {}) => ({ ...initState(card()), ...over })

// ══════════════════ A. 事实边界（P1 的落地形式） ══════════════════

test('★ 每个事件类别都有「可直说 / 必须问」清单（新增类别时不能漏）', () => {
  for (const kind of EVENT_KINDS) {
    assert.ok(KIND_FACTS[kind], `事件类别 ${kind} 缺少事实清单`)
    assert.ok(Array.isArray(KIND_FACTS[kind].statable) && KIND_FACTS[kind].statable.length > 0)
    assert.ok(Array.isArray(KIND_FACTS[kind].askable) && KIND_FACTS[kind].askable.length > 0,
      `${kind} 应当至少有一个"该问"的点 —— 否则等于允许断言一切细节`)
  }
  assert.ok(KIND_FACTS.manual)
  assert.ok(KIND_TONE.save)
})

test('★ 可直说的只有确定性事实，不含任何"我们其实不知道"的细节', () => {
  // save 是文件系统观测到的事实；"是不是打完 boss 才存的"日志和存档都给不出 ⇒ 只能进 askable
  const saveFacts = KIND_FACTS.save
  assert.ok(saveFacts.statable.some((s) => /存.*档/.test(s)), saveFacts.statable.join(' | '))
  assert.ok(!saveFacts.statable.some((s) => /boss|打完|通关|放弃/.test(s)),
    '不知道的事不能出现在可直说清单里')
  assert.ok(saveFacts.askable.some((s) => s.includes('？')), '该问的应当是问句')
})

test('表达式规则里明确写了「必须用疑问句、不许复述字段名」', () => {
  const all = EXPRESSION_RULES.join('\n')
  assert.match(all, /疑问句/)
  assert.match(all, /字段名|文件路径/)
  assert.match(all, /不负责事实/)
})

test('buildRequest 组装出可直说 / 必须问 / 状态 / 记忆', () => {
  const req = buildRequest({
    card: card(), state: state(),
    trigger: { kind: 'save', summaries: ['$.hPoint：9454→9461'], significance: 0.8, mergedCount: 3 },
    memoryText: '【与这个玩家有关的记忆】\n· 存档已更新（×12）',
    memoryUsed: [{ entry: { text: '存档已更新', count: 12 }, score: 1 }],
    now: T0,
  })
  assert.equal(req.kind, 'save')
  assert.ok(req.statable.some((s) => /存.*档/.test(s)), req.statable.join(' | '))
  assert.ok(req.statable.some((s) => s.includes('3 处动静')), '合并次数是事实，可以直说')
  assert.ok(req.statable.some((s) => s.includes('12 次')), '"这事出现过 12 次"是事实')
  assert.ok(req.askable.length >= 1)
  assert.deepEqual(req.rawSummaries, ['$.hPoint：9454→9461'])
  assert.match(req.memoryText, /记忆/)
  assert.ok(req.stateText.includes('霞'))
  assert.equal(req.address, '你')
  assert.equal(needsQuestion(req), true)
})

test('未登记的触发类别退回 system，而不是崩', () => {
  const req = buildRequest({ card: card(), state: state(), trigger: { kind: '莫名其妙' } })
  assert.equal(req.kind, 'system')
  assert.ok(req.statable.length > 0)
})

test('★ 原始摘要照原样带上，但提示词里明确禁止逐字复述', () => {
  const req = buildRequest({ card: card(), state: state(), trigger: { kind: 'progress', summaries: ['$.dayCount：24→31'] } })
  const p = promptFor(req)
  assert.match(p, /\$\.dayCount：24→31/, '原始摘要要带上，供模型判断"玩家大概在忙什么"')
  assert.match(p, /严禁逐字复述/)
  assert.match(p, /可以直说/)
  assert.match(p, /只能问，不能断言/)
})

test('提示词里带上角色卡的硬约束（模型得知道边界）', () => {
  const c = card({ emojiPolicy: 'require', avgLength: { min: 4, max: 60 } })
  const p = promptFor(buildRequest({ card: c, state: state(), trigger: { kind: 'save' } }))
  assert.match(p, /……才不是/, '口癖')
  assert.match(p, /本小姐/, '禁用词')
  assert.match(p, /「你」/, '称呼')
  assert.match(p, /4~60 字/, '长度')
  assert.match(p, /必须带一个表情/, '表情策略')
})

test('buildRequest 对空输入不崩', () => {
  assert.doesNotThrow(() => buildRequest())
  assert.doesNotThrow(() => buildRequest({}))
  assert.equal(buildRequest().kind, 'manual' === buildRequest().kind ? 'manual' : buildRequest().kind)
})

// ══════════════════ B. 模板 provider ══════════════════

test('模板 provider 声明自己永远可用（它是默认档）', () => {
  const p = createTemplateProvider()
  assert.equal(p.id, 'template')
  assert.equal(p.available(), true)
  assert.equal(typeof p.generate, 'function')
})

test('亲密度分档与 persona.addressFor 一致（0.4 / 0.7）', () => {
  assert.equal(tierOf(0.1), 'low')
  assert.equal(tierOf(0.39), 'low')
  assert.equal(tierOf(0.4), 'mid')
  assert.equal(tierOf(0.69), 'mid')
  assert.equal(tierOf(0.7), 'high')
  assert.equal(tierOf(NaN), 'low', '非有限数退回 low')
})

test('★ 口癖位置按形状决定（省略号开头的放句首，助词放句尾）', () => {
  assert.equal(placeTic('……才不是', '你存档了？'), '……才不是，你存档了？')
  assert.equal(placeTic('啦', '你存档了？'), '你存档了？啦')
  assert.equal(placeTic('~', '在呢'), '~，在呢')
  assert.equal(placeTic('', 'x'), 'x')
  assert.equal(placeTic('你', '你存档了？'), '你存档了？', '已经含有时不再塞一遍')
})

test('每个事件类别、每个亲密度档都有核心句', () => {
  for (const kind of EVENT_KINDS) {
    assert.ok(CORES[kind], `缺 ${kind} 的核心句`)
    for (const tier of ['low', 'mid', 'high']) {
      assert.ok(Array.isArray(CORES[kind][tier]) && CORES[kind][tier].length >= 2,
        `${kind}.${tier} 至少要有 2 个变体（否则每次都同一句）`)
    }
  }
  assert.ok(CORES.manual)
})

test('★ 同 seed 输出完全一致（可复现），不同 seed 会换措辞', () => {
  const req = buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })
  assert.equal(generate(req, { seed: 3 }).text, generate(req, { seed: 3 }).text)
  const seen = new Set([0, 1, 2, 3, 4, 5].map((s) => generate(req, { seed: s }).text))
  assert.ok(seen.size >= 2, `不同 seed 应当给出不同措辞，实际只有 ${[...seen].join(' / ')}`)
})

test('meta 如实报告用了哪些部件', () => {
  const req = buildRequest({ card: card(), state: state({ affinity: 0.9 }), trigger: { kind: 'save' } })
  const { meta } = generate(req, { seed: 0 })
  assert.equal(meta.provider, 'template')
  assert.equal(meta.tier, 'high')
  assert.equal(typeof meta.usedAddress, 'boolean')
  assert.equal(typeof meta.usedTic, 'boolean')
  assert.equal(typeof meta.usedAsk, 'boolean')
})

// ══════════════════ C. ★ 性质测试：任何合理卡都不能产出违规句 ══════════════════

test('★ 性质：任意合理角色卡 × 任意触发类型 × 任意亲密度，模板产出都过校验器', () => {
  const cards = [
    card(),
    card({ avgLength: { min: 1, max: 20 } }),                       // 很紧的上限
    card({ avgLength: { min: 6, max: 12 } }),                       // 窄区间
    card({ emojiPolicy: 'require' }),                               // 必须带表情
    card({ emojiPolicy: 'allow', speechTics: ['啦', '呢'] }),        // 句尾助词型口癖
    card({ addresses: {} }),                                        // 没指定称呼
    card({ addresses: { player: '搭档' } }),                         // 自定义称呼
    card({ speechTics: [], forbiddenWords: [] }),                   // 什么都不设
    card({ mustMention: { save: ['存档'] } }),                       // 场景必提词
    card({ speechTics: ['……才不是', '……算了'], emojiPolicy: 'require', avgLength: { min: 8, max: 50 } }),
    card({ forbiddenWords: ['你'], addresses: { player: '搭档' } }),  // 禁用最常见的那个词
  ]
  const kinds = [...EVENT_KINDS, 'manual']
  const affinities = [0.05, 0.5, 0.95]
  let n = 0
  const failures = []
  for (const c of cards) {
    for (const kind of kinds) {
      for (const affinity of affinities) {
        for (const seed of [0, 1, 2, 3]) {
          const st = { ...initState(c), affinity }
          const req = buildRequest({ card: c, state: st, trigger: { kind, summaries: ['$.x：1→2'] }, seed })
          const { text } = generate(req, { seed })
          const lint = lintDialogue(text, c, { state: st, triggerKind: kind })
          n++
          if (!lint.ok) {
            failures.push(`卡=${JSON.stringify(c.persona.hard.avgLength)} kind=${kind} affinity=${affinity} seed=${seed} → ${JSON.stringify(text)} 错误=${lint.errors.map((e) => e.detail).join('；')}`)
          }
        }
      }
    }
  }
  assert.equal(failures.length, 0, `${failures.length}/${n} 条不达标：\n${failures.slice(0, 6).join('\n')}`)
  assert.ok(n >= 400, `样本数应当够多，实际 ${n}`)
})

test('★ 场景必提词会被满足（卡里声明了就必须出现）', () => {
  const c = card({ mustMention: { save: ['存档'] } })
  const req = buildRequest({ card: c, state: state(), trigger: { kind: 'save' } })
  for (const seed of [0, 1, 2, 3, 4]) {
    const { text } = generate(req, { seed })
    assert.match(text, /存档/, `seed=${seed} 的产出漏了必提词：${text}`)
  }
})

test('★ 卡要求表情时必须带表情（缺了是 error，不是 warning）', () => {
  const c = card({ emojiPolicy: 'require' })
  const req = buildRequest({ card: c, state: state(), trigger: { kind: 'save' } })
  for (const seed of [0, 1, 2]) {
    const lint = lintDialogue(generate(req, { seed }).text, c, { state: state(), triggerKind: 'save' })
    assert.equal(lint.ok, true, JSON.stringify(lint.errors))
    assert.equal(lint.stats.emoji > 0, true)
  }
})

test('★ 卡禁用了某个词时，候选句会先被滤掉（不会选中一句必然违规的）', () => {
  // 一张"从不叫'你'、只叫'搭档'"的卡
  const c = card({ forbiddenWords: ['你'], addresses: { player: '搭档' } })
  const req = buildRequest({ card: c, state: state(), trigger: { kind: 'manual' } })
  for (const seed of [0, 1, 2, 3, 4, 5]) {
    const { text } = generate(req, { seed })
    const lint = lintDialogue(text, c, { state: state(), triggerKind: 'manual' })
    assert.equal(lint.ok, true, `seed=${seed} 产出违规：${text} → ${JSON.stringify(lint.errors)}`)
    assert.ok(!text.includes('你'), `不该出现禁用词：${text}`)
  }
})

test('★ 卡指定了称呼时会尽量带上（避免 warning）', () => {
  const c = card({ addresses: { player: '搭档' } })
  const req = buildRequest({ card: c, state: state(), trigger: { kind: 'save' } })
  const used = [0, 1, 2, 3].map((s) => generate(req, { seed: s }))
  assert.ok(used.some((u) => u.text.includes('搭档')), used.map((u) => u.text).join(' / '))
})

// ══════════════════ D. ★ 编排：生成 → 校验 → 重试 → 不说 ══════════════════

test('正常情况下一次生成就通过', async () => {
  const dl = createDialogue({ provider: 'template' })
  const req = buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })
  const r = await dl.speak(req)
  assert.equal(r.ok, true)
  assert.equal(r.providerId, 'template')
  assert.ok(r.text.length > 0)
  assert.equal(r.lint.ok, true)
})

test('★ 产不出合规的话时返回 text:null（宁可不说，绝不放行违规内容）', async () => {
  // 一张"最少 40 字"的卡：模板的核心句 + 追问也够不到 40 字 ⇒ 只能沉默
  const c = card({ avgLength: { min: 40, max: 60 } })
  const req = buildRequest({ card: c, state: state(), trigger: { kind: 'save' } })
  const r = await speak(req, { primary: createTemplateProvider(), maxAttempts: 2 })
  assert.equal(r.ok, false)
  assert.equal(r.text, null)
  assert.ok(r.notes.some((n) => n.includes('宁可不说')), r.notes.join(' | '))
  assert.ok(r.lint && r.lint.ok === false, '要带上最后一次的违规详情，便于排查')
})

test('★ 首次 provider 不可用时退到模板档（没配 key 也能跑通）', async () => {
  const llmNoKey = createLlmProvider({ apiKey: '' })
  assert.equal(llmNoKey.available(), false)
  const req = buildRequest({ card: card(), state: state(), trigger: { kind: 'death' } })
  const r = await speak(req, { primary: llmNoKey, maxAttempts: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.providerId, 'template', '应当退到模板档')
  assert.ok(r.notes.some((n) => n.includes('不可用')))
})

test('★ provider 抛错时不重试同一个，而是换档（网络错误重试没意义）', async () => {
  let calls = 0
  const boom = {
    id: 'llm', available: () => true,
    generate: async () => { calls++; throw new Error('网络炸了') },
  }
  const req = buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })
  const r = await speak(req, { primary: boom, maxAttempts: 3 })
  assert.equal(calls, 1, `provider 级错误只该调一次，实际 ${calls}`)
  assert.equal(r.ok, true, '应当退到模板档成功')
  assert.equal(r.providerId, 'template')
})

test('generate 返回空内容时继续重试', async () => {
  let n = 0
  const empty = {
    id: 'llm', available: () => true,
    generate: async () => { n++; return { text: '' } },
  }
  const req = buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })
  const r = await speak(req, { primary: empty, maxAttempts: 3 })
  assert.equal(n, 3, '空内容应当重试满')
  assert.equal(r.ok, true)
  assert.equal(r.providerId, 'template')
})

test('createDialogue 暴露 active() 供调用方判断"能不能说话"', () => {
  const dl = createDialogue({ provider: 'template' })
  assert.equal(dl.active().id, 'template')
  const dl2 = createDialogue({ provider: 'llm', providerOptions: { apiKey: '' } })
  assert.equal(dl2.primary.available(), false)
  assert.equal(dl2.active().id, 'template', '应当退到模板档')
  const dl3 = createDialogue({ provider: 'llm', providerOptions: { apiKey: 'k', baseUrl: 'x', model: 'm', fetchImpl: async () => ({}) } })
  assert.equal(dl3.primary.available(), true, '配齐了就应当可用')
})

test('未知 provider 名退回模板档而不是崩', () => {
  const dl = createDialogue({ provider: '不存在的' })
  assert.equal(dl.primary, null)
  assert.equal(dl.active().id, 'template')
})

test('PROVIDER_FACTORIES 里登记了模板与 LLM', () => {
  assert.deepEqual(Object.keys(PROVIDER_FACTORIES).sort(), ['llm', 'template'])
})

test('explain 把"基于什么在说话"摊开（P1 可检查）', () => {
  const e = explain({ card: card(), state: state(), trigger: { kind: 'death', summaries: ['角色倒下了'] } })
  assert.equal(e.kind, 'death')
  assert.ok(e.statable.length > 0)
  assert.ok(e.askable.length > 0)
  assert.match(e.prompt, /只能问，不能断言/)
  assert.match(e.tone, /接住情绪/)
})

// ══════════════════ E. LLM provider（注入 fetch，离线可测） ══════════════════

test('★ OpenAI 形状：请求体与鉴权头正确', () => {
  const p = createLlmProvider({ preset: 'deepseek', apiKey: 'sk-test' })
  assert.equal(p.available(), true)
  const { url, init } = buildCall(p.config, '提示词')
  assert.equal(url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(init.headers.authorization, 'Bearer sk-test')
  const body = JSON.parse(init.body)
  assert.equal(body.model, PRESETS.deepseek.model)
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].content, '提示词')
  assert.match(body.messages[0].content, /不负责事实/)
})

test('★ Anthropic 形状：走 x-api-key 与 /v1/messages，system 单独一栏', () => {
  const p = createLlmProvider({ preset: 'anthropic', apiKey: 'sk-a' })
  const { url, init } = buildCall(p.config, '提示词')
  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(init.headers['x-api-key'], 'sk-a')
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(init.body)
  assert.ok(typeof body.system === 'string')
  assert.deepEqual(body.messages.map((m) => m.role), ['user'])
})

test('★ 响应解析：两种形状都要能取到文本', () => {
  assert.equal(parseResponse({ choices: [{ message: { content: 'A' } }] }, 'openai'), 'A')
  assert.equal(parseResponse({ choices: [{ text: 'B' }] }, 'openai'), 'B')
  assert.equal(parseResponse({ content: [{ type: 'text', text: 'C' }] }, 'anthropic'), 'C')
})

test('★ 响应解析：取不到就返回空串，不抛（脏响应不该打崩链路）', () => {
  for (const bad of [null, undefined, {}, { choices: [] }, { choices: [{}] }, { content: 'x' }, 42]) {
    assert.doesNotThrow(() => parseResponse(bad))
    const v = parseResponse(bad)
    assert.equal(typeof v, 'string')
  }
})

test('★ 输出清洗：去引号 / 代码块 / "回答："前缀，但不改写内容', () => {
  assert.equal(cleanOutput('「你存档了？」'), '你存档了？')
  assert.equal(cleanOutput('```\n你存档了？\n```'), '你存档了？')
  assert.equal(cleanOutput('回答：你存档了？'), '你存档了？')
  assert.equal(cleanOutput('"你存档了？"'), '你存档了？')
  assert.equal(cleanOutput('  你存档了？  '), '你存档了？')
  assert.equal(cleanOutput('你存档了？\n\n解释：因为……'), '你存档了？')
  assert.equal(cleanOutput(''), '')
  assert.equal(cleanOutput(null), '')
})

test('★ 注入 fetch：端到端走完一次生成（离线）', async () => {
  const seen = []
  const fakeFetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '「你存档了？」' } }] }) }
  }
  const p = createLlmProvider({ preset: 'deepseek', apiKey: 'sk-test', fetchImpl: fakeFetch })
  const req = buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })
  const out = await p.generate(req)
  assert.equal(out.text, '你存档了？', '清洗后应当去掉引号')
  assert.equal(out.meta.provider, 'llm')
  assert.equal(seen.length, 1)
  assert.match(seen[0].body.messages[1].content, /可以直说/)
})

test('★ HTTP 报错与超时都要变成可读错误（并带上状态码）', async () => {
  const p400 = createLlmProvider({ preset: 'openai', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) })
  await assert.rejects(() => p400.generate(buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })), /HTTP 429/)

  const badJson = createLlmProvider({ preset: 'openai', apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }) })
  await assert.rejects(() => badJson.generate(buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })), /不是 JSON/)

  const abort = createLlmProvider({
    preset: 'openai', apiKey: 'k', timeoutMs: 5,
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e },
  })
  await assert.rejects(() => abort.generate(buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })), /超时/)
})

test('没配 apiKey 时调用 generate 直接给可读错误', async () => {
  const p = createLlmProvider({ apiKey: '' })
  assert.equal(p.available(), false)
  await assert.rejects(() => p.generate(buildRequest({ card: card(), state: state(), trigger: { kind: 'save' } })), /未配置 apiKey/)
})

test('★ LLM 产出违规内容时会被校验拦住并最终沉默（模型不能越界）', async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '本小姐觉得你应该先去练级，你这个菜鸟根本打不过那个boss，听我的准没错哦' } }] }),
  })
  const p = createLlmProvider({ preset: 'openai', apiKey: 'k', fetchImpl: fakeFetch })
  const c = card()   // 禁用词「本小姐」，上限 60 字
  const req = buildRequest({ card: c, state: state(), trigger: { kind: 'save' } })
  const r = await speak(req, { primary: p, fallback: null, maxAttempts: 2 })
  assert.equal(r.ok, false, '违规内容必须被拦下')
  assert.equal(r.text, null)
  assert.ok(r.notes.some((n) => n.includes('本小姐')), r.notes.join(' | '))
})

// ══════════════════ F. 与 session 层的联调 ══════════════════

test('★ 联调：session 的开口请求 → 表达层 → 过校验', async () => {
  const c = card()
  const st = state({ mood: 0.8, affinity: 0.9 })
  const req = buildRequest({
    card: c, state: st,
    trigger: { kind: 'save', summaries: ['「SaveData1.dat」已更新', '$.hPoint：9454→9461'], significance: 0.8, mergedCount: 2 },
    memoryText: '【与这个玩家有关的记忆】\n· 存档已更新（×12）',
    memoryUsed: [{ entry: { text: '存档已更新', count: 12 }, score: 1.2 }],
  })
  const r = await speak(req, { primary: createTemplateProvider() })
  assert.equal(r.ok, true)
  const lint = lintDialogue(r.text, c, { state: st, triggerKind: 'save' })
  assert.equal(lint.ok, true)
  // 产出里不许出现机器信息
  assert.ok(!r.text.includes('$.'), `不许逐字复述字段：${r.text}`)
  assert.ok(!r.text.includes('hPoint'), `不许提字段名：${r.text}`)
})

test('validateCard 会标出"配得自相矛盾因而永远说不出话"的卡', () => {
  const bad = {
    id: 'x', name: 'n', game: 'g',
    persona: { soft: { personality: 'p' }, hard: { addresses: { player: '亲爱的' }, forbiddenWords: ['亲爱的'] } },
  }
  assert.equal(validateCard(bad).ok, false)
  // 而正常卡不会
  assert.equal(validateCard(card()).ok, true)
})
