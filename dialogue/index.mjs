// dialogue/index.mjs —— 表达层的编排：生成 → 校验 → 重试 → 不达标就不说
//
// 这一层是「模型只负责表达，不负责事实」这条铁律的**执行处**：
//   1. 调 provider 生成一句话
//   2. 用 core/persona.mjs 的 lintDialogue 校验它（禁用词 / 长度 / 表情 / 场景必提词）
//   3. 不通过就重试（换 seed / 换措辞）
//   4. 仍然不通过 ⇒ **返回 text: null，不说**。
//
// 第 4 条是关键，也是与"随便套个角色扮演提示词"最本质的区别：
//   没有校验器的做法是"不管怎样总要说点什么"，于是违规内容照样发出去；
//   这里的做法是**宁可沉默**。这跟时机引擎的立场是一致的（见 ARCHITECTURE §3 原则 P1/P2）。
//   代价要认：一张配得自相矛盾的角色卡会导致桌宠一直不说话 —— 但那是**卡错了**，
//   而 validateCard 早就该在导入时把它拦下来（见 card.mjs 的 6 类矛盾检查）。

import { createTemplateProvider } from './template.mjs'
import { createLlmProvider } from './llm.mjs'
import { lintDialogue } from '../core/persona.mjs'
import { buildRequest, promptFor } from './base.mjs'

export { createTemplateProvider } from './template.mjs'
export { createLlmProvider } from './llm.mjs'
export { buildRequest, promptFor, KIND_FACTS, EXPRESSION_RULES } from './base.mjs'

/** 可用的 provider 工厂表。新增一家只要在这里登记。 */
export const PROVIDER_FACTORIES = Object.freeze({
  template: createTemplateProvider,
  llm: createLlmProvider,
})

/**
 * 建一个表达器。
 *
 * @param {object} [opts]
 * @param {string} [opts.provider='template'] 首选 provider id
 * @param {object} [opts.providerOptions]     传给 provider 工厂
 * @param {string} [opts.fallback='template'] 首选不可用时的退路（默认退回模板档）
 * @param {number} [opts.maxAttempts=3]
 * @returns {{primary:object, fallback:object|null, maxAttempts:number, speak:Function}}
 */
export function createDialogue(opts = {}) {
  const primary = makeProvider(opts.provider ?? 'template', opts.providerOptions)
  const fallbackId = opts.fallback ?? 'template'
  const fallback = fallbackId && fallbackId !== primary?.id
    ? makeProvider(fallbackId, opts.providerOptions)
    : null
  const dl = {
    primary,
    fallback,
    maxAttempts: opts.maxAttempts ?? 3,
    /** 实际会用的 provider：首选不可用就退路，都没有就 null（调用方据此判断"不能说话"） */
    active() {
      if (primary?.available()) return primary
      if (fallback?.available()) return fallback
      return null
    },
  }
  dl.speak = (request, o) => speak(request, { ...dl, ...o })
  return dl
}

function makeProvider(id, options) {
  const f = PROVIDER_FACTORIES[id]
  if (!f) return null
  try { return f(options ?? {}) } catch { return null }
}

/**
 * 生成一句**通过校验**的话。
 *
 * @param {object} request - buildRequest 的输出（也可直接传它的入参，内部会补建）
 * @param {object} opts
 * @param {object} opts.primary / opts.fallback   provider（createDialogue 会自动塞进来）
 * @param {number} [opts.maxAttempts]
 * @param {number} [opts.seed]
 * @returns {Promise<{ok:boolean, text:string|null, attempts:number, lint:object|null, providerId:string|null, notes:string[]}>}
 */
export async function speak(request, opts = {}) {
  const notes = []
  const req = request?.hard !== undefined ? request : buildRequest(request ?? {})
  const maxAttempts = opts.maxAttempts ?? 3
  const baseSeed = Number.isFinite(opts.seed) ? opts.seed : (Number.isFinite(req.seed) ? req.seed : 0)

  const primary = opts.primary ?? (opts.provider ? makeProvider(opts.provider, opts.providerOptions) : null) ?? createTemplateProvider()
  const candidates = [primary]
  // ⚠ 用 `'fallback' in opts` 而不是 `opts.fallback ?? ...`：
  //   显式传 `fallback: null` 的意思是"**不要**退路"（测试与严格模式都要用），
  //   而 `??` 会把 null 当成"没给"，于是模板档照样插进来，把违规内容"救"成合规。
  //   这个 bug 会让"模型越界就必须沉默"这条保证失效。
  const fb = ('fallback' in opts)
    ? opts.fallback
    : (primary?.id !== 'template' ? createTemplateProvider() : null)
  if (fb && fb !== primary) candidates.push(fb)

  let attempts = 0
  let lastLint = null
  for (const provider of candidates) {
    if (!provider || typeof provider.generate !== 'function') continue
    if (typeof provider.available === 'function' && !provider.available()) {
      notes.push(`${provider.id} 不可用（缺配置），跳过`)
      continue
    }
    for (let i = 0; i < maxAttempts; i++) {
      attempts++
      let out
      try {
        out = await provider.generate(req, { attempt: i, seed: baseSeed + i })
      } catch (e) {
        notes.push(`${provider.id} 第 ${i + 1} 次生成失败：${e.message}`)
        break  // provider 级别的错误（网络/配置）重试同一个没意义，换下一个
      }
      const text = typeof out === 'string' ? out : out?.text
      if (!text) { notes.push(`${provider.id} 第 ${i + 1} 次返回空内容`); continue }

      const lint = lintDialogue(text, req.card ?? {}, { state: req.state, triggerKind: req.kind })
      lastLint = lint
      if (lint.ok) {
        return {
          ok: true, text, attempts, lint, providerId: provider.id,
          meta: typeof out === 'object' ? out.meta : null,
          notes: notes.length ? notes : undefined,
        }
      }
      // 只有**确定性**的失败才值得重试（换 seed 换措辞）；
      // 每次都撞同一个硬约束（比如卡自相矛盾）时重试是浪费，最多试满 maxAttempts 就换档。
      notes.push(`${provider.id} 第 ${i + 1} 次未过校验：${lint.errors.map((e) => e.detail).join('；')}`)
    }
  }

  return {
    ok: false,
    text: null,
    attempts,
    lint: lastLint,
    providerId: null,
    notes: [...notes, '所有 provider 都没能产出合规的话 —— 按"宁可不说"处理，本次不开口'],
  }
}

/**
 * 把一次表达请求的**完整输入**摊开，供界面/调试查看"它到底基于什么在说话"。
 * 这一步让 P1（只报事实）变得可检查：能直接看到哪些是事实、哪些是要问的。
 */
export function explain(request) {
  const req = request?.hard !== undefined ? request : buildRequest(request ?? {})
  return {
    kind: req.kind,
    tone: req.tone,
    statable: req.statable,
    askable: req.askable,
    rawSummaries: req.rawSummaries,
    memoryText: req.memoryText,
    prompt: promptFor(req),
    hard: req.hard,
  }
}
