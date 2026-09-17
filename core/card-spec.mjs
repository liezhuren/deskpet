// core/card-spec.mjs —— ★ 角色卡格式的**规范**（唯一事实来源）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么要有这个文件（用户的明确要求）
// ═══════════════════════════════════════════════════════════════════
// 原话：「我想要一个规范的角色卡格式，不要让 llm 即兴生成，而是让他类似于填表一样地生成角色卡。」
//
// 之前的做法是让模型输出一段 JSON 提议数组 —— 那正是"即兴生成"：模型自己决定
// 有哪些字段、叫什么名字、什么结构。于是每次跑出来的东西形状都可能不同，
// 而校验器只能事后挑毛病。**格式必须由我们定死，模型只负责往格子里填。**
//
// 所以这个文件把格式写成**数据**，然后由它派生三样东西，保证三者永不漂移：
//   ① 校验规则（core/card.mjs 的 validateCard 用 FIELDS 做类型/枚举检查）
//   ② 填表用的空表与提问文案（lore/fill.mjs）
//   ③ 人读的格式文档（docs/CARD.md，由 specToMarkdown() 生成，并有测试盯着它别过期）
//
// 每个字段都要回答四个问题（缺一个就会出现"看起来能填、其实没人管"的字段）：
//   · 它属于哪一层？      meta / animation / soft / hard
//   · 谁有资格填它？      derived（派生）/ user（用户）/ model（模型可填）
//   · 类型与取值范围？    类型 + 枚举 + 范围
//   · 填错会怎样？        required / evidence（是否必须给出处）
//
// ★ 「谁有资格填」这一项是这次改造的核心：
//   hard 层的字段**模型可以提议，但必须带出处**（evidence: true），且永远要用户确认；
//   id / game 之类由程序派生，**模型不许碰**（model 填了也直接丢）。

/** 卡格式版本。字段增删要同步 +1，并在 docs/CARD.md 记迁移说明。 */
export const CARD_VERSION = 1

/** 层的封闭集合。 */
export const LAYERS = Object.freeze(['meta', 'animation', 'soft', 'hard'])

/** 每种层的用途（写进文档与给模型的提示）。 */
export const LAYER_DOC = Object.freeze({
  meta: '标识与版本：由程序派生或用户指定，模型不许填',
  animation: '桌宠外观：画风与气质（气质决定需要哪些动作）',
  soft: '自由描写：喂给模型当表达依据，**不参与机器校验**',
  hard: '硬约束：会被校验器逐条检查，**只有这一层能验证**',
})

/**
 * 字段规格表。**唯一事实来源** —— 校验、填表、文档都从这里派生。
 *
 * `fill` 的取值：
 *   'derived' —— 程序派生（如 id），模型与用户都不该填
 *   'user'    —— 只能由用户指定（主观选择，没有"正确答案"可抽）
 *   'model'   —— 模型可以提议填入（hard 层还必须带出处）
 */
export const FIELDS = Object.freeze([
  // ---------- meta ----------
  f('id', 'meta', 'string', {
    required: true, fill: 'derived', minChars: 1, maxChars: 80,
    desc: '稳定标识。由 name + game 派生，保证同一张卡每次生成同一个 id',
    hint: '程序自动生成，不要手填',
  }),
  f('name', 'meta', 'string', {
    required: true, fill: 'user', minChars: 1, maxChars: 40,
    desc: '角色名（显示用）', ask: '这个角色叫什么？',
  }),
  f('game', 'meta', 'string', {
    required: true, fill: 'user', minChars: 1, maxChars: 80,
    desc: '游戏标识。记忆按它归属 —— 不同游戏的记忆不会互相串',
    ask: '这是哪款游戏？（随便一个稳定的名字即可，比如 someday）',
  }),
  f('version', 'meta', 'int', {
    default: CARD_VERSION, fill: 'derived',
    desc: '卡格式版本，用于将来的迁移',
  }),
  f('draft', 'meta', 'boolean', {
    default: false, fill: 'derived',
    desc: '是否还是草稿（hard 层没填完时为 true，界面据此提醒）',
  }),

  // ---------- animation ----------
  f('animation.temperament', 'animation', 'enum', {
    values: ['lively', 'calm', 'cool'], default: 'calm', fill: 'model', evidence: true,
    desc: '气质 —— 决定这个角色**需要哪些桌宠动作**：lively 要打招呼+高兴，calm 只要高兴，cool 要关心',
    ask: '这个角色的性格偏活泼、冷静，还是高冷？',
    hint: '只能填 lively / calm / cool 三个之一',
  }),
  f('animation.style', 'animation', 'enum', {
    values: ['soft', 'pixel', 'line'], default: 'soft', fill: 'user',
    desc: '桌宠画风：soft 柔和 / pixel 像素 / line 线稿',
    hint: '主观选择，没有"正确答案"可抽，所以只能由人指定',
  }),
  f('animation.actions', 'animation', 'string[]', {
    default: [], fill: 'user',
    desc: '额外要求的动作（idle / idleBored / talk 本来就必需，不用写）',
    hint: '可选：happy / worried / greeting / sleep',
  }),
  f('animation.scale', 'animation', 'number', {
    default: 1, min: 0.2, max: 4, fill: 'user',
    desc: '桌宠显示尺寸倍率',
  }),

  // ---------- soft（自由描写，不参与校验） ----------
  // ⚠ 这三个字段刻意是 `warnIfMissing` 而不是 `required`：
  //   soft 层本来就不参与机器校验，缺了只是"给模型的表达依据少一些"，
  //   不该让整张卡不通过 —— 那会过度约束创作者。旧实现就是这么定的，spec 要延续它。
  f('persona.soft.personality', 'soft', 'string', {
    warnIfMissing: true, fill: 'model', maxChars: 400,
    desc: '性格描写。**喂给模型当表达依据，不参与机器校验**',
    ask: '介绍一下这个角色的性格（可以概括，不必逐字引用）',
  }),
  f('persona.soft.background', 'soft', 'string', {
    // ★ 这一格**要求出处**：它的立场是"原样搬运，不做提炼"，
    //   所以必须能指回原文的哪一段。而下面两格是**概括**，强制出处只是负担。
    warnIfMissing: true, fill: 'model', evidence: true, maxChars: 1200,
    desc: '背景 / 官方人设。**原样搬运，不做"提炼"** —— 所以必须给出处',
    ask: '粘贴官方人设或背景介绍原文（这一格要指明出处）',
  }),
  f('persona.soft.speechStyle', 'soft', 'string', {
    warnIfMissing: true, fill: 'model', maxChars: 300,
    desc: '说话风格的描写（短句 / 爱吐槽 / 用敬语 …）',
    ask: '这个角色说话是什么风格？（可以概括）',
  }),

  // ---------- hard（会被逐条校验） ----------
  f('persona.hard.speechTics', 'hard', 'string[]', {
    default: [], fill: 'model', evidence: true, maxItems: 8, itemMaxChars: 12,
    desc: '口癖片段。**单句没有不判错**，但整批都没出现会被统计出来（lintBatch 的 ticRate）',
    ask: '这个角色的口癖是什么？（原文里最好有明确依据，比如"她的口癖是…"）',
    hint: '例：……才不是',
  }),
  f('persona.hard.forbiddenWords', 'hard', 'string[]', {
    default: [], fill: 'model', evidence: true, maxItems: 12, itemMaxChars: 16,
    desc: '这个角色**绝不会说**的词。出现即判 error —— 过不了校验就直接不说',
    ask: '这个角色绝不会说哪些词？（比如"从不说谢谢"）',
  }),
  f('persona.hard.addresses', 'hard', 'object', {
    default: {}, fill: 'model', evidence: true,
    desc: '称呼规则，形如 { player: "你" }。整句没用到只是 warning',
    ask: '这个角色怎么称呼玩家？',
  }),
  f('persona.hard.avgLength', 'hard', 'intRange', {
    default: { min: 4, max: 40 }, fill: 'model', evidence: true, min: 1, max: 400,
    desc: '回复长度区间（按码点算）。超出即 error —— 太长的角色扮演最劝退',
    ask: '这个角色说话长短如何？（话少就给小一点的 max）',
  }),
  f('persona.hard.emojiPolicy', 'hard', 'enum', {
    values: ['none', 'allow', 'require'], default: 'none', fill: 'user',
    desc: '表情策略：none 出现表情即 error；require 没有表情即 error',
    hint: '主观选择，由人指定',
  }),
  f('persona.hard.mustMention', 'hard', 'stringArrayMap', {
    default: {}, fill: 'user',
    desc: '特定场景必须提到的词，形如 { save: ["存档"] }',
    hint: '高级用法，需要人判断哪些场景该提什么',
  }),
])

function f(path, layer, type, extra = {}) {
  return Object.freeze({
    path, layer, type,
    required: extra.required === true,
    warnIfMissing: extra.warnIfMissing === true,
    fill: extra.fill ?? 'user',
    evidence: extra.evidence === true,
    values: extra.values ? Object.freeze(extra.values) : undefined,
    default: extra.default,
    min: extra.min, max: extra.max,
    minChars: extra.minChars, maxChars: extra.maxChars,
    maxItems: extra.maxItems, itemMaxChars: extra.itemMaxChars,
    desc: extra.desc ?? '', ask: extra.ask ?? '', hint: extra.hint ?? '',
  })
}

/**
 * 必须存在的**容器**（哪怕里面的字段都能缺省）。
 * 只看字段的话，`persona.hard` 整个不见了也不会报错 —— 因为 hard 的字段都有默认值。
 * 但"没有 hard 层"与"hard 层是空的"是两件不同的事：前者是格式不对，后者是还没填。
 */
export const REQUIRED_CONTAINERS = Object.freeze(['persona', 'persona.soft', 'persona.hard'])

/** 从字段路径推出所有中间容器路径（`a.b.c` → `a`、`a.b`），并保持顺序稳定。 */
export const CONTAINER_PATHS = Object.freeze([...new Set(
  FIELDS.flatMap((x) => x.path.split('.').slice(0, -1).map((_, i, arr) => arr.slice(0, i + 1).join('.'))),
)])

// ---------- 查询 ----------

export const FIELD_PATHS = Object.freeze(FIELDS.map((x) => x.path))
export const fieldByPath = (path) => FIELDS.find((x) => x.path === path) ?? null
export const fieldsOfLayer = (layer) => FIELDS.filter((x) => x.layer === layer)
/** 模型可以提议填入的字段（hard 的那些还要带出处）。 */
export const modelFillablePaths = Object.freeze(FIELDS.filter((x) => x.fill === 'model').map((x) => x.path))
/** hard 层里模型可填的字段 —— 它们都必须带出处。 */
export const evidenceRequiredPaths = Object.freeze(FIELDS.filter((x) => x.evidence).map((x) => x.path))
/** hard 层的字段全路径（core/card.mjs 的 HARD_KEYS 从它派生）。 */
export const HARD_FIELD_PATHS = Object.freeze(fieldsOfLayerInList(FIELDS, 'hard'))
/** 必填字段。 */
export const requiredPaths = Object.freeze(FIELDS.filter((x) => x.required).map((x) => x.path))

function fieldsOfLayerInList(list, layer) {
  return list.filter((x) => x.layer === layer).map((x) => x.path)
}

/** 读取/写入点路径（blankForm 与 applyFilled 共用，避免两套实现漂移）。 */
export function readPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
export function writePath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
  return obj
}

/**
 * ★ 空表：所有格子按类型摆在明面上，值为 null（或默认值）。
 * 这是"填表"的物理形态 —— 模型看到的就是**这些格子**，
 * 它没有机会决定"有哪些字段"。
 *
 * @param {{withDefaults?:boolean}} [opts] withDefaults=true 时用 spec 的默认值而非 null
 */
export function blankForm(opts = {}) {
  const form = { _format: `game-pet-agent/card@${CARD_VERSION}`, _instructions: '只填下面的格子；没有依据的留 null，不要编' }
  for (const field of FIELDS) {
    if (field.fill === 'derived') continue          // 派生字段不进表
    writePath(form, field.path, opts.withDefaults ? structuredCloneish(field.default ?? null) : null)
  }
  return form
}

/** 把 spec 里每个字段的"该怎么填"摊开（给模型与界面共用）。 */
export function fieldBriefs({ layers = null, onlyModel = false } = {}) {
  return FIELDS
    .filter((x) => x.fill !== 'derived')
    .filter((x) => !layers || layers.includes(x.layer))
    .filter((x) => !onlyModel || x.fill === 'model')
    .map((x) => ({
      path: x.path, layer: x.layer, type: x.type, values: x.values,
      required: x.required, evidence: x.evidence,
      ask: x.ask || x.desc, hint: x.hint, desc: x.desc,
    }))
}

// ---------- 与 spec 对表的校验 ----------

/**
 * 按 spec 做**类型与取值范围**检查。
 * 刻意只做"格式"这一半 —— 语义矛盾（口癖含禁用词之类）由 core/card.mjs 负责，
 * 因为那需要跨字段推理，不是 spec 能表达的。
 *
 * @param {object} card
 * @returns {{errors:string[], warnings:string[], checked:number}}
 */
export function validateAgainstSpec(card) {
  const errors = []
  const warnings = []
  let checked = 0
  if (!card || typeof card !== 'object') return { errors: ['角色卡必须是对象'], warnings, checked }

  // ① 必填容器（"没有 hard 层"与"hard 层是空的"是两件事）
  for (const path of REQUIRED_CONTAINERS) {
    const v = readPath(card, path)
    if (v === undefined || v === null) errors.push(`缺少 ${path}（${path === 'persona.soft' ? '自由描写层' : path === 'persona.hard' ? '硬约束层' : 'persona 对象'}必填）`)
    else if (typeof v !== 'object' || Array.isArray(v)) errors.push(`${path} 必须是对象`)
  }
  // 其它容器若存在，也必须是对象（例如 animation）
  for (const path of CONTAINER_PATHS) {
    if (REQUIRED_CONTAINERS.includes(path)) continue
    const v = readPath(card, path)
    if (v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))) {
      errors.push(`${path} 必须是对象`)
    }
  }

  for (const field of FIELDS) {
    const v = readPath(card, field.path)
    const present = v !== undefined && v !== null
    if (!present) {
      // ⚠ 显式写成 `null` 与"整个键不写"要分开处理：
      //   前者是**填错了**（值没了），后者是**还没填**。
      //   空表里用 null 表示"这个格子没填"，但空表是**输入**，
      //   落到卡上的 null 只会来自手写错误 —— 所以卡里出现 null 一律报错。
      if (v === null) { errors.push(`${field.path} 不能为 null —— 要么给值，要么整个键不写`); continue }
      if (field.required) errors.push(`缺少必填字段 ${field.path}（${field.desc}）`)
      else if (field.warnIfMissing) warnings.push(`缺 ${field.path} —— 会给模型较少的表达依据（不阻塞）`)
      continue
    }
    checked++

    switch (field.type) {
      case 'string':
        if (typeof v !== 'string') { errors.push(`${field.path} 必须是字符串`); break }
        // 用 trim 后的长度判定下限：只有空白的字符串等于没填
        if (field.minChars != null && [...v.trim()].length < field.minChars) errors.push(`${field.path} 太短（至少 ${field.minChars} 个非空白字符）`)
        if (field.maxChars != null && [...v].length > field.maxChars) warnings.push(`${field.path} 有 ${[...v].length} 字，超过建议上限 ${field.maxChars}`)
        break
      case 'int':
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${field.path} 必须是数字`); break }
        if (field.type === 'int' && !Number.isInteger(v)) errors.push(`${field.path} 必须是整数`)
        if (field.min != null && v < field.min) errors.push(`${field.path} 不能小于 ${field.min}`)
        if (field.max != null && v > field.max) errors.push(`${field.path} 不能大于 ${field.max}`)
        break
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`${field.path} 必须是布尔值`)
        break
      case 'enum':
        if (!field.values.includes(v)) {
          errors.push(`${field.path} 必须是 ${field.values.join(' / ')} 之一，收到 ${JSON.stringify(v)}`)
        }
        break
      case 'string[]': {
        if (!Array.isArray(v)) { errors.push(`${field.path} 必须是字符串数组`); break }
        if (v.some((x) => typeof x !== 'string')) { errors.push(`${field.path} 里必须全是字符串`); break }
        if (field.maxItems != null && v.length > field.maxItems) errors.push(`${field.path} 最多 ${field.maxItems} 条，收到 ${v.length}`)
        for (const s of v) {
          if (field.itemMaxChars != null && [...s].length > field.itemMaxChars) {
            warnings.push(`${field.path} 里的 ${JSON.stringify(s)} 有 ${[...s].length} 字，偏长（建议 ≤ ${field.itemMaxChars}）`)
          }
        }
        break
      }
      case 'intRange': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${field.path} 必须是 { min, max } 对象`); break }
        if (typeof v.min !== 'number' || typeof v.max !== 'number') { errors.push(`${field.path} 需要数字 min / max`); break }
        if (v.min > v.max) errors.push(`${field.path} 的 min(${v.min}) 不能大于 max(${v.max})`)
        if (field.min != null && v.min < field.min) errors.push(`${field.path}.min 不能小于 ${field.min}`)
        if (field.max != null && v.max > field.max) errors.push(`${field.path}.max 不能大于 ${field.max}`)
        break
      }
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v)) errors.push(`${field.path} 必须是对象`)
        break
      case 'stringArrayMap': {
        // 形如 { 事件类别: ["词", ...] } —— 光查"是对象"不够，内层的值也要查，
        // 否则 { combat: [1] } 这种会静默通过，然后在 lintDialogue 里什么都不匹配。
        if (typeof v !== 'object' || Array.isArray(v)) { errors.push(`${field.path} 必须是对象（{ 事件类别: [词] }）`); break }
        for (const [k, arr] of Object.entries(v)) {
          if (!Array.isArray(arr)) { errors.push(`${field.path}.${k} 必须是字符串数组`); continue }
          if (arr.some((x) => typeof x !== 'string')) errors.push(`${field.path}.${k} 里必须全是字符串`)
        }
        break
      }
      default:
        warnings.push(`${field.path} 的类型 ${field.type} 没有对应的检查实现（spec 与代码不同步？）`)
    }
  }

  // ★ 闭集检查：卡里出现 spec 没登记的字段 ⇒ 报警告。
  //   这条是"规范格式"的关键：模型不能自己加字段，加了要么删、要么先在 spec 里登记。
  //
  //   ⚠ 这里**不能**再用"路径以 persona/animation 开头就跳过"那种前缀过滤 ——
  //     那样会把 `persona.hard.favColour` 这类真正该报的路径一起跳掉，检查等于没做。
  //     判断"是不是卡自己的字段"只用 `isCardishPath`，而"是否登记过"只查 FIELD_PATHS。
  for (const p of listLeafPaths(card)) {
    if (p.startsWith('_')) continue
    if (isKnownPath(p)) continue
    if (isCardishPath(p)) {
      warnings.push(`卡里有未登记的字段 ${p} —— 不会有任何校验覆盖它，建议删掉或先在 core/card-spec.mjs 登记`)
    }
  }
  return { errors, warnings, checked }
}

/**
 * 路径是否"被 spec 覆盖"。
 *
 * ⚠ 必须把**字段对象内部的子键**也算作已知：`persona.hard.avgLength` 是 intRange，
 *   落到卡上会被展开成 `persona.hard.avgLength.min` / `.max`；
 *   `addresses.player`、`mustMention.save` 更是任意键。
 *   只比对 FIELD_PATHS 的精确相等，会把它们全误报成"未登记的字段"
 *   （实测就是这么翻车的：一张正常的卡报出 avgLength.min/max 未登记）。
 */
function isKnownPath(p) {
  return FIELD_PATHS.some((fp) => p === fp || p.startsWith(`${fp}.`))
}

/**
 * 判断某个路径是否属于"卡自己的字段"。
 * 用来区分「模型/用户往卡里塞了未登记的字段」与「用户自己挂在卡上的笔记」——
 * 后者不必报警（卡是用户的资产，多带几个自己的键无妨）。
 */
function isCardishPath(p) {
  return /^(animation|persona)(\.|$)/.test(p) || ['id', 'name', 'game', 'version', 'draft'].includes(p)
}

/** 列出对象的所有叶子路径。 */
export function listLeafPaths(obj, prefix = '') {
  const out = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return prefix ? [prefix] : []
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) out.push(...listLeafPaths(v, p))
    else out.push(p)
  }
  return out
}

// ---------- 生成人读的格式文档 ----------

/**
 * 生成 docs/CARD.md 的内容。
 * **有测试盯着它别过期**（重新生成的内容必须与仓库里的文件逐字一致）——
 * 否则文档与 spec 一定会漂移，而"规范"最怕的就是文档说的和代码做的不是一回事。
 */
export function specToMarkdown() {
  const lines = []
  lines.push('# 角色卡格式（规范）')
  lines.push('')
  lines.push('> ⚠ 本文由 `core/card-spec.mjs` 的 `specToMarkdown()` **自动生成**。')
  lines.push('> 要改格式请改那份 spec —— 有一道测试盯着本文与 spec 是否一致，手改本文会测试失败。')
  lines.push('')
  lines.push(`**格式版本**：\`game-pet-agent/card@${CARD_VERSION}\``)
  lines.push('')
  lines.push('## 设计立场')
  lines.push('')
  lines.push('角色卡分两层，**只有 hard 层能被机器校验**：')
  lines.push('')
  for (const layer of LAYERS) lines.push(`- \`${layer}\` —— ${LAYER_DOC[layer]}`)
  lines.push('')
  lines.push('「谁有资格填」是这套格式的核心：')
  lines.push('')
  lines.push('| fill | 含义 |')
  lines.push('|---|---|')
  lines.push('| `derived` | 程序派生（如 id），**模型与用户都不该填** |')
  lines.push('| `user` | 只能由用户指定（主观选择，没有"正确答案"可抽） |')
  lines.push('| `model` | 模型可以提议填入；标了「需出处」的还必须给出能在原文里找到的引文 |')
  lines.push('')
  lines.push('**模型不许新增字段。** 卡里出现 spec 未登记的字段会被告警 —— 要么删掉，要么先在 spec 里登记。')
  lines.push('')

  for (const layer of LAYERS) {
    const fs = fieldsOfLayer(layer)
    if (fs.length === 0) continue
    lines.push(`## ${layer} —— ${LAYER_DOC[layer]}`)
    lines.push('')
    lines.push('| 字段 | 类型 | 必填 | 谁填 | 需出处 | 默认 | 说明 |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const x of fs) {
      const type = x.type === 'enum' ? `enum(${x.values.join(' / ')})`
        : x.type === 'intRange' ? '{min,max}'
          : x.type === 'string[]' ? 'string[]'
            : x.type
      const def = x.default === undefined ? '——' : `\`${JSON.stringify(x.default)}\``
      lines.push(`| \`${x.path}\` | ${type} | ${x.required ? '✅' : ''} | \`${x.fill}\` | ${x.evidence ? '✅' : ''} | ${def} | ${x.desc} |`)
    }
    lines.push('')
    const asks = fs.filter((x) => x.ask)
    if (asks.length) {
      lines.push('**填表时的提问：**')
      lines.push('')
      for (const x of asks) lines.push(`- \`${x.path}\` —— ${x.ask}${x.hint ? `（${x.hint}）` : ''}`)
      lines.push('')
    }
  }

  lines.push('## 空表（填表流程的物理形态）')
  lines.push('')
  lines.push('填表时交给模型的**就是这份空表**：格子由 spec 决定，模型的职责只是把值填进去，')
  lines.push('**没有机会决定"有哪些字段"**。没有依据的格子留 `null`，不要编。')
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify(blankForm(), null, 2))
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

function structuredCloneish(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v))
}
