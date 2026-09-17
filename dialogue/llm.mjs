// dialogue/llm.mjs —— LLM provider（可插拔；没配 key 就不可用）
//
// ═══════════════════════════════════════════════════════════════════
// 关于「验证过什么」（这一层最容易含糊，所以说清楚）
// ═══════════════════════════════════════════════════════════════════
// `fetch` 是**注入的**（opts.fetchImpl）。于是：
//   ✅ 可离线验证：提示词构造、请求体形状、响应解析、清洗、超时与错误处理
//      （测试里注入假的 fetch，断言"发了什么"和"拿到什么"）
//   ❌ 未验证：真实网络的连通性、各家 API 的实际返回差异、配额与限流
// 前者是代码正确性，后者是环境问题 —— 混在一起说"接好了"就是含糊其辞。
//
// 支持两种主流形状：
//   · openai     —— POST {baseUrl}/chat/completions，`choices[0].message.content`
//   · anthropic  —— POST {baseUrl}/v1/messages，`content[].text`，走 x-api-key
// 之所以都支持：本项目要"api 配置页"，而用户手里有什么 key 是未知的。

import { promptFor, EXPRESSION_RULES } from './base.mjs'

/** 各家的默认地址与模型。填错也不致命 —— 配置页里都能改。 */
export const PRESETS = Object.freeze({
  openai: Object.freeze({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', style: 'openai' }),
  deepseek: Object.freeze({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', style: 'openai' }),
  moonshot: Object.freeze({ baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', style: 'openai' }),
  anthropic: Object.freeze({ baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-haiku-latest', style: 'anthropic' }),
})

/**
 * 造一个 LLM provider。
 * @param {object} opts
 * @param {string} [opts.preset]     PRESETS 里的名字
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]
 * @param {'openai'|'anthropic'} [opts.style]
 * @param {number} [opts.timeoutMs=20000]
 * @param {number} [opts.temperature=0.8]
 * @param {Function} [opts.fetchImpl] 注入用（默认 globalThis.fetch）；测试靠它离线跑
 */
export function createLlmProvider(opts = {}) {
  const preset = PRESETS[opts.preset] ?? {}
  const cfg = {
    baseUrl: trimSlash(opts.baseUrl ?? preset.baseUrl ?? ''),
    model: opts.model ?? preset.model ?? '',
    apiKey: opts.apiKey ?? '',
    style: opts.style ?? preset.style ?? 'openai',
    timeoutMs: opts.timeoutMs ?? 20_000,
    temperature: opts.temperature ?? 0.8,
    maxTokens: opts.maxTokens ?? 200,
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch

  return {
    id: 'llm',
    name: `LLM（${cfg.model || '未配置'}）`,
    kind: 'llm',
    config: cfg,
    /** 没 key 或没 fetch 就不可用 —— 此时上层会退回模板档，而不是抛错。 */
    available: () => Boolean(cfg.apiKey && cfg.baseUrl && cfg.model && typeof fetchImpl === 'function'),

    /**
     * @param {object} request - dialogue/base.mjs 的 buildRequest 输出
     * @returns {Promise<{text:string, meta:object}>}
     */
    async generate(request, o = {}) {
      if (!cfg.apiKey) throw new Error('LLM provider 未配置 apiKey')
      // ★ 两种提示词来源：
      //   · 对话（默认）—— request 是 dialogue/base.mjs 的 buildRequest 输出，走 promptFor
      //   · **原始提示词**（request.rawPrompt）—— 角色卡"填表"用的就是这条：
      //     它要发的是整张空表 + 原文，不是一段对话请求。
      const prompt = (typeof request?.rawPrompt === 'string' && request.rawPrompt)
        ? request.rawPrompt
        : promptFor(request)
      const isForm = prompt === request?.rawPrompt
      // ⚠ maxTokens 要能按调用覆盖：闲聊的默认 200 够用，
      //   但"填表"的返回是几百 token 的 JSON —— 用 200 会被**从中间截断**，
      //   表现是"JSON 解析失败"这种看不出真因的错。
      const maxTokens = Number.isFinite(o.maxTokens) ? o.maxTokens : cfg.maxTokens
      const temperature = Number.isFinite(o.temperature) ? o.temperature : cfg.temperature
      const { url, init } = buildCall({ ...cfg, maxTokens, temperature }, prompt)
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = ctl ? setTimeout(() => ctl.abort(), cfg.timeoutMs) : null
      let res
      try {
        res = await fetchImpl(url, ctl ? { ...init, signal: ctl.signal } : init)
      } catch (e) {
        throw new Error(`请求失败：${e?.name === 'AbortError' ? `超时（${cfg.timeoutMs}ms）` : e.message}`)
      } finally {
        if (timer) clearTimeout(timer)
      }
      const bodyText = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}：${bodyText.slice(0, 200)}`)
      let json
      try { json = JSON.parse(bodyText) } catch { throw new Error(`响应不是 JSON：${bodyText.slice(0, 120)}`) }
      const raw = parseResponse(json, cfg.style)
      // 填表是 JSON，必须 keepWhole（否则带空行的 JSON 会被从中间截断）
      const text = (isForm ? cleanOutput(raw, { keepWhole: true }) : cleanOutput(raw))
      if (!text) throw new Error('模型返回了空内容')
      return { text, meta: { provider: 'llm', model: cfg.model, style: cfg.style, attempt: o.attempt ?? 0, promptChars: prompt.length, maxTokens, mode: isForm ? 'form' : 'dialogue' } }
    },
  }
}

/**
 * 造请求。**单独导出以便离线断言"到底发了什么"**。
 * @returns {{url:string, init:object}}
 */
export function buildCall(cfg, prompt) {
  const sys = EXPRESSION_RULES.join('\n')
  if (cfg.style === 'anthropic') {
    return {
      url: `${cfg.baseUrl}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens,
          temperature: cfg.temperature,
          system: sys,
          messages: [{ role: 'user', content: prompt }],
        }),
      },
    }
  }
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: prompt },
        ],
      }),
    },
  }
}

/** 从各家响应里取出文本。取不到就返回空串（由调用方判空），不抛。 */
export function parseResponse(json, style = 'openai') {
  if (!json || typeof json !== 'object') return ''
  if (style === 'anthropic') {
    const parts = Array.isArray(json.content) ? json.content : []
    return parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('')
  }
  const c = json.choices?.[0]
  if (typeof c?.message?.content === 'string') return c.message.content
  // 有些兼容实现用 text 或 delta
  if (typeof c?.text === 'string') return c.text
  if (typeof c?.delta?.content === 'string') return c.delta.content
  return ''
}

/**
 * 清洗模型输出。模型很爱加引号、代码块、"回答："前缀，这些会污染校验（比如把长度算多）。
 * 只做**保守**的剥离，不做改写 —— 改写了就等于我们在替模型说话。
 *
 * @param {string} raw
 * @param {{keepWhole?:boolean}} [opts]
 *   keepWhole —— **不要只取第一段**。填表（JSON）必须用它：
 *   `split(/\n\s*\n/)[0]` 会把带空行的 JSON 从中间截断，
 *   而报出来的错是"JSON 解析失败"，看不出真因。
 */
export function cleanOutput(raw, opts = {}) {
  let t = String(raw ?? '').trim()
  if (!t) return ''
  // 去掉代码块围栏
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  // 去掉"回答："/"台词："之类的前缀
  t = t.replace(/^(回答|台词|输出|回复|Answer|Response)\s*[:：]\s*/i, '').trim()
  // 去掉整体包裹的成对引号（中英文都要）
  for (const [a, b] of [['"', '"'], ["'", "'"], ['「', '」'], ['“', '”'], ['『', '』']]) {
    if (t.startsWith(a) && t.endsWith(b) && t.length > a.length + b.length) {
      t = t.slice(a.length, t.length - b.length).trim()
      break
    }
  }
  if (opts.keepWhole) return t
  // 模型有时会多写一行解释；只取第一段非空行
  const firstPara = t.split(/\n\s*\n/)[0].trim()
  return firstPara || t
}

const trimSlash = (s) => String(s ?? '').replace(/\/+$/, '')

export default createLlmProvider
