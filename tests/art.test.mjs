// tests/art.test.mjs —— art/ 素材层：PNG 编解码、感知哈希、动作清单、两条质量闸门
//
// 这一层最容易"声称做到了"。所以测试的重点是**让失败模式真的可判**：
//   · PNG 往返必须**像素级一致**（不是"看起来对"）
//   · 一个"所有动作返回同一张图"的偷懒 provider **必须被判不通过**
//   · "跑形"的 provider（每个动作一张完全不同的图）也**必须被判不通过**
//   · 帧数与词汇表不符、缺动作、多余动作都要能查出来

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  decodePng, encodePng, averageHash, hamming, meanAbsDiff, boxResize, translate,
  scaleBrightness, rotate, opaqueRatio, crc32,
  nearestResize, boxBlur, desaturate, lighten, toLineArt,
  distinctColors, highFrequencyEnergy, edgeRatio,
} from '../art/image.mjs'
import { synthStandingArt, framesFor, createProceduralProvider, RECIPES, paletteFor, hashSeed } from '../art/procedural.mjs'
import {
  ACTIONS, ACTION_IDS, actionsFor, checkManifest, describeManifestCheck,
  TEMPERAMENT_ACTIONS, TEMPERAMENTS,
} from '../art/actions.mjs'
import {
  STYLES, STYLE_IDS, DEFAULT_STYLE, applyStyle, resolveStyle, describeStyle, styleFingerprint,
} from '../art/styles.mjs'
import { ensureAssets, evaluateQuality, QUALITY_DEFAULTS } from '../art/index.mjs'
import { normalizeCard, validateCard, ANIMATION_TEMPERAMENTS } from '../core/card.mjs'

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'pet-art-'))
  return { dir: d, done: () => rmSync(d, { recursive: true, force: true }) }
}

function card(animation = {}, hard = {}) {
  const { card: c, errors } = normalizeCard({
    id: 'demo', name: '霞', game: 'g',
    animation,
    persona: {
      soft: { personality: 'p', background: 'b', speechStyle: 's' },
      hard: { speechTics: ['……才不是'], forbiddenWords: ['本小姐'], addresses: { player: '你' }, avgLength: { min: 4, max: 40 }, emojiPolicy: 'none', ...hard },
    },
  })
  if (errors.length) throw new Error(errors.join('；'))
  return c
}

/** 一张有结构的测试图（纯色图做哈希会退化，必须有明暗结构）。 */
function testImage(w = 32, h = 32, kind = 'block') {
  const d = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const on = kind === 'block'
        ? (x > w * 0.25 && x < w * 0.75 && y > h * 0.25 && y < h * 0.75)
        : ((x + y) % 8 < 4)
      d[i] = on ? 220 : 30; d[i + 1] = on ? 120 : 30; d[i + 2] = on ? 60 : 30; d[i + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

// ══════════════════ A. PNG 编解码 ══════════════════

test('★ PNG 往返是像素级一致（不是"看起来对"）', () => {
  for (const [w, h] of [[1, 1], [8, 8], [32, 32], [64, 96], [100, 7]]) {
    const img = testImage(w, h)
    const png = encodePng(img)
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', '签名')
    const back = decodePng(png)
    assert.equal(back.width, w)
    assert.equal(back.height, h)
    assert.equal(Buffer.compare(Buffer.from(back.data), Buffer.from(img.data)), 0, `${w}x${h} 往返不一致`)
  }
})

test('★ 随机像素也逐字节一致（不是只对规整图成立）', () => {
  const w = 40, h = 24
  const d = new Uint8Array(w * h * 4)
  let seed = 12345
  for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; d[i] = seed & 0xff }
  const img = { width: w, height: h, data: d }
  const back = decodePng(encodePng(img))
  assert.equal(Buffer.compare(Buffer.from(back.data), Buffer.from(d)), 0)
})

test('★ 损坏的 PNG 会被 CRC 检出，而不是静默给出错图', () => {
  const png = encodePng(testImage(16, 16))
  const bad = Buffer.from(png)
  bad[bad.length - 20] ^= 0xff   // 改掉 IDAT 里的一个字节
  assert.throws(() => decodePng(bad), /CRC|长度/)
})

test('非 PNG / 截断输入给可读错误', () => {
  assert.throws(() => decodePng(Buffer.from('不是 PNG')), /签名/)
  assert.throws(() => decodePng(encodePng(testImage(8, 8)).subarray(0, 20)))
})

test('编码参数非法时报错，而不是产出坏文件', () => {
  assert.throws(() => encodePng({ width: 0, height: 8, data: new Uint8Array(0) }), /正整数/)
  assert.throws(() => encodePng({ width: 8, height: 8, data: new Uint8Array(4) }), /长度不足/)
})

test('crc32 与已知值一致', () => {
  assert.equal(crc32(Buffer.alloc(0)), 0)
  assert.equal(crc32(Buffer.from('abc')).toString(16), '352441c2')
})

// ══════════════════ B. 图像操作与哈希 ══════════════════

test('★ 平均哈希：对缩放/亮度不敏感，对平移有一定敏感', () => {
  const img = testImage(64, 64)
  assert.equal(hamming(averageHash(img), averageHash(img)), 0)
  assert.equal(hamming(averageHash(img), averageHash(boxResize(img, 128, 128))), 0, '缩放不该改变哈希')
  assert.equal(hamming(averageHash(img), averageHash(scaleBrightness(img, 1.4))), 0, '整体亮度不该改变哈希')
  assert.ok(hamming(averageHash(img), averageHash(testImage(64, 64, 'stripe'))) > 8, '不同结构必须拉开距离')
})

test('hamming：空哈希视为"完全无法比较"，返回 Infinity 而不是 0', () => {
  // 返回 0 会把"没法比"伪装成"完全一样"，那是最危险的默认值（会让跑形检测静默通过）。
  // Infinity 则会让任何"距离必须够小"的判断都不通过 —— 宁可判严。
  assert.equal(hamming('', ''), Infinity)
  assert.equal(hamming(null, 'ab'), Infinity)
  assert.equal(hamming(undefined, undefined), Infinity)
  assert.ok(Number.isFinite(hamming('ab', 'abcd')), '非空但长度不同照样能比')
})

test('meanAbsDiff：自身为 0，尺寸不同也能比（先缩到公共尺寸）', () => {
  const a = testImage(32, 32)
  assert.equal(meanAbsDiff(a, a), 0)
  assert.ok(meanAbsDiff(a, boxResize(a, 16, 16)) < 0.05, '缩放后差异应当很小')
  assert.ok(meanAbsDiff(a, testImage(32, 32, 'stripe')) > 0.1)
})

test('平移与旋转都会改变像素（动作才可能"看得出来"）', () => {
  const a = testImage(32, 32)
  assert.ok(meanAbsDiff(a, translate(a, 2, 0)) > 0)
  assert.ok(meanAbsDiff(a, rotate(a, 10)) > 0)
  assert.deepEqual(rotate(a, 0), a, '转 0 度应当等价')
})

test('opaqueRatio 能识别全透明图', () => {
  assert.equal(opaqueRatio(testImage(8, 8)), 1)
  assert.equal(opaqueRatio({ width: 4, height: 4, data: new Uint8Array(64) }), 0)
})

// ══════════════════ C. 程序化立绘与动作帧 ══════════════════

test('★ 零输入也能画出立绘，且同一 seed 恒定', () => {
  const a = synthStandingArt({ seed: 7 })
  const b = synthStandingArt({ seed: 7 })
  const c = synthStandingArt({ seed: 200 })
  assert.equal(a.width, 64); assert.equal(a.height, 96)
  assert.equal(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)), 0, '同 seed 必须逐字节一致')
  assert.notEqual(Buffer.compare(Buffer.from(a.data), Buffer.from(c.data)), 0, '不同 seed 应当画出不同配色')
  assert.ok(opaqueRatio(a) > 0.3, `画出来的东西不能几乎是空的，实际 ${opaqueRatio(a)}`)
})

test('hashSeed 是确定性的', () => {
  assert.equal(hashSeed('kasumi'), hashSeed('kasumi'))
  assert.notEqual(hashSeed('kasumi'), hashSeed('另一位'))
  assert.ok(hashSeed('x') >= 0 && hashSeed('x') < 360)
})

test('每个已登记动作都有变换配方，且帧数与词汇表一致', () => {
  const src = synthStandingArt({ seed: 1 })
  for (const id of ACTION_IDS) {
    assert.ok(RECIPES[id], `动作 ${id} 缺变换配方`)
    assert.equal(RECIPES[id].length, ACTIONS[id].frames, `${id} 配方帧数与词汇表不一致`)
    const frames = framesFor(src, id)
    assert.equal(frames.length, ACTIONS[id].frames)
    for (const f of frames) assert.equal(f.data.length, src.data.length)
  }
  assert.throws(() => framesFor(src, '不存在的动作'), /没有/)
  assert.throws(() => framesFor(null, 'idle'), /缺立绘/)
})

test('★ 每个动作内部都真的在动（循环动画可以有重复帧，但不能全部相同）', () => {
  const src = synthStandingArt({ seed: 3 })
  for (const id of ACTION_IDS) {
    const frames = framesFor(src, id)
    if (frames.length < 2) continue
    let maxD = 0
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) maxD = Math.max(maxD, meanAbsDiff(frames[i], frames[j]))
    }
    assert.ok(maxD > 0, `动作 ${id} 的多帧完全一样 —— 播起来是静止的`)
  }
})

test('paletteFor 给合法 RGBA', () => {
  for (const s of [0, 90, 359]) {
    const p = paletteFor(s)
    for (const k of ['skin', 'hair', 'body', 'eye']) {
      assert.equal(p[k].length, 4, k)
      for (const v of p[k]) assert.ok(v >= 0 && v <= 255, `${k} 越界`)
    }
  }
})

// ══════════════════ D. 动作清单：由角色属性推出 ══════════════════

test('★ 必需动作对所有气质都一样（idleBored 是用户点名的场景，不随档位变）', () => {
  for (const t of ANIMATION_TEMPERAMENTS) {
    const w = actionsFor(card({ temperament: t }))
    for (const must of ['idle', 'idleBored', 'talk']) assert.ok(w.required.includes(must), `${t} 缺 ${must}`)
  }
})

test('★ 气质决定额外动作', () => {
  assert.ok(actionsFor(card({ temperament: 'lively' })).required.includes('greeting'))
  assert.ok(actionsFor(card({ temperament: 'calm' })).required.includes('happy'))
  assert.ok(!actionsFor(card({ temperament: 'calm' })).required.includes('greeting'))
  assert.ok(actionsFor(card({ temperament: 'cool' })).required.includes('worried'))
  assert.deepEqual([...TEMPERAMENTS], [...ANIMATION_TEMPERAMENTS], '词表只有一个来源')
})

test('未给气质时按 calm 处理（宽松默认）', () => {
  const w = actionsFor(card())
  assert.equal(w.temperament, 'calm')
  assert.deepEqual(w.required, ['happy', 'idle', 'idleBored', 'talk'])
})

test('角色卡可以显式追加动作，但删不掉必需项', () => {
  const w = actionsFor(card({ temperament: 'lively', actions: ['sleep'] }))
  assert.ok(w.required.includes('sleep'))
  assert.ok(w.required.includes('idleBored'), '必需项不能被删')
  assert.ok(w.reasons.some((r) => r.includes('显式要求')))
})

test('未登记的动作名被忽略（不会悄悄进 required）', () => {
  const w = actionsFor(card({ actions: ['不存在的动作', 'sleep'] }))
  assert.ok(w.required.includes('sleep'))
  assert.ok(!w.required.includes('不存在的动作'))
})

test('actionsFor 对脏输入不崩', () => {
  for (const bad of [null, undefined, {}, { animation: null }, { animation: [] }, { animation: { temperament: '不存在' } }]) {
    assert.doesNotThrow(() => actionsFor(bad))
    assert.ok(actionsFor(bad).required.length >= 3)
  }
})

// ══════════════════ E. ★ 清单一致性（三类静默错误） ══════════════════

test('★ 缺动作 / 多余动作 / 帧数不符 都能查出来', () => {
  const want = actionsFor(card({ temperament: 'lively' }))
  const manifest = {
    actions: {
      idle: { frames: ['idle/0.png', 'idle/1.png', 'idle/2.png', 'idle/3.png'] },
      talk: { frames: ['talk/0.png', 'talk/1.png'] },          // 帧数不符（期望 3）
      sleep: { frames: ['sleep/0.png', 'sleep/1.png'] },       // 多余
      // 缺 happy / greeting / idleBored
    },
  }
  const r = checkManifest(manifest, want)
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing.sort(), ['greeting', 'happy', 'idleBored'])
  assert.deepEqual(r.extra, ['sleep'])
  assert.equal(r.inconsistent.length, 1)
  assert.match(r.inconsistent[0].detail, /帧数期望 3|期望 3 帧/)
  assert.ok(r.notes.some((n) => n.includes('缺')))
  assert.ok(r.notes.some((n) => n.includes('白生成') || n.includes('多出')))
})

test('★ 声明帧数与实际帧数不一致也算错', () => {
  const want = actionsFor(card())
  const manifest = {
    actions: {
      idle: { frames: ['idle/0.png', 'idle/1.png', 'idle/2.png', 'idle/3.png'], declaredFrames: 6 },
      talk: { frames: ['t/0.png', 't/1.png', 't/2.png'] },
      idleBored: { frames: ['b/0.png', 'b/1.png', 'b/2.png', 'b/3.png'] },
      happy: { frames: ['h/0.png', 'h/1.png', 'h/2.png'] },
    },
  }
  const r = checkManifest(manifest, want)
  assert.equal(r.ok, false)
  assert.ok(r.inconsistent.some((i) => i.action === 'idle' && i.declared === 6))
})

test('未登记的动作会被单列出来（不会有任何校验覆盖它）', () => {
  const want = actionsFor(card())
  const r = checkManifest({ actions: { idle: { frames: ['a'] }, 未登记动作: { frames: ['b'] } } }, want)
  assert.ok(r.malformed.some((m) => m.includes('未在 ACTIONS 里登记')))
})

test('清单结构坏掉时返回可读结果而不是抛异常', () => {
  const want = actionsFor(card())
  for (const bad of [null, undefined, 0, 'x', [], {}, { actions: null }, { actions: [] }]) {
    assert.doesNotThrow(() => checkManifest(bad, want))
    assert.equal(checkManifest(bad, want).ok, false)
  }
  assert.doesNotThrow(() => checkManifest({ actions: { idle: 'x' } }, want))
  assert.doesNotThrow(() => checkManifest({ actions: { idle: { frames: [] } } }, want))
  assert.doesNotThrow(() => checkManifest({ actions: { idle: { frames: [''] } } }, want))
})

test('describeManifestCheck 给出人话', () => {
  const want = actionsFor(card())
  assert.match(describeManifestCheck({ ok: true, missing: [], extra: [], inconsistent: [], malformed: [], notes: [] }), /一致/)
  assert.match(describeManifestCheck({ ok: false, missing: ['happy'], extra: [], inconsistent: [], malformed: [], notes: [] }), /缺动作：happy/)
})

// ══════════════════ F. ★ 两条质量闸门 ══════════════════

test('★ 闸门能判出"所有动作其实是同一张图"（偷懒）', () => {
  const src = synthStandingArt({ seed: 5 })
  const same = { idle: [src, src], talk: [src, src], idleBored: [src, src] }
  const q = evaluateQuality(same, src)
  assert.equal(q.ok, false)
  assert.equal(q.minPairDiff, 0)
  assert.ok(q.duplicateActions.length > 0, '应当报出共用特征帧')
  assert.ok(q.notes.some((n) => n.includes('偷懒')))
  assert.ok(q.notes.some((n) => n.includes('静止')))
})

test('★ 闸门能判出"每个动作都是一张全新图"（跑形）', () => {
  const src = synthStandingArt({ seed: 5 })
  // 造三张与立绘毫无关系的图
  const alien = (k) => {
    const d = new Uint8Array(src.data.length)
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4
        d[i] = (x * 7 + k * 90) % 256; d[i + 1] = (y * 11 + k * 40) % 256; d[i + 2] = (x + y) % 256; d[i + 3] = 255
      }
    }
    return { width: src.width, height: src.height, data: d }
  }
  const q = evaluateQuality({ idle: [alien(0)], talk: [alien(1)], idleBored: [alien(2)] }, src)
  assert.equal(q.ok, false)
  assert.ok(q.maxSourceDistance > QUALITY_DEFAULTS.maxSourceDistance, `实测距离 ${q.maxSourceDistance}`)
  assert.ok(q.notes.some((n) => n.includes('跑形')))
})

test('★ 闸门能判出空帧（生图失败的常见形态）', () => {
  const src = synthStandingArt({ seed: 5 })
  const blank = { width: src.width, height: src.height, data: new Uint8Array(src.data.length) }
  const q = evaluateQuality({ idle: [blank], talk: [src] }, src)
  assert.equal(q.ok, false)
  assert.deepEqual(q.emptyFrames, ['idle'])
})

test('★ 程序化 provider 的产出实测通过闸门（不是"声称通过"）', () => {
  const src = synthStandingArt({ seed: 9 })
  const frames = {}
  for (const id of ACTION_IDS) frames[id] = framesFor(src, id)
  const q = evaluateQuality(frames, src)
  assert.equal(q.ok, true, q.notes.join(' | '))
  assert.ok(q.minPairDiff >= QUALITY_DEFAULTS.minActionDiff,
    `动作间最小差 ${q.minPairDiff} 应当不低于阈值 ${QUALITY_DEFAULTS.minActionDiff}`)
  assert.ok(q.maxSourceDistance <= QUALITY_DEFAULTS.maxSourceDistance,
    `距立绘最大 ${q.maxSourceDistance} 应当不超过上限 ${QUALITY_DEFAULTS.maxSourceDistance}`)
  assert.equal(q.duplicateActions.length, 0)
  assert.equal(q.emptyFrames.length, 0)
})

test('阈值可覆盖（便于接入不同画风的 provider 时重新标定）', () => {
  const src = synthStandingArt({ seed: 2 })
  const q = evaluateQuality({ idle: [src], talk: [rotate(src, 2)] }, src, { minActionDiff: 0.5 })
  assert.equal(q.ok, false, '把阈值抬到不合理的高度就该不通过')
  assert.equal(evaluateQuality({ idle: [src], talk: [rotate(src, 2)] }, src, { minActionDiff: 0.0000001, maxSourceDistance: 64 }).ok, true)
})

// ══════════════════ G. ★ 端到端：生成 → 落盘 → 清单可查 ══════════════════

test('★ ensureAssets 落盘真 PNG，清单与文件一一对应', async () => {
  const t = tmp()
  try {
    const c = card({ temperament: 'lively', style: 'soft' })
    const r = await ensureAssets({ card: c, outDir: t.dir })
    assert.equal(r.ok, true, r.notes.join(' | '))
    assert.equal(r.manifest.character, 'demo')
    assert.equal(r.manifest.temperament, 'lively')
    assert.equal(r.manifest.provider, 'procedural')

    // 清单里每个路径都要真的存在，且是能解回来的 PNG
    let n = 0
    for (const [action, a] of Object.entries(r.manifest.actions)) {
      assert.equal(a.frames.length, ACTIONS[action].frames, `${action} 帧数应与词汇表一致`)
      for (const rel of a.frames) {
        const p = join(t.dir, rel)
        assert.ok(existsSync(p), `缺文件 ${rel}`)
        const img = decodePng(readFileSync(p))
        assert.ok(img.width > 0 && img.height > 0)
        n++
      }
    }
    assert.ok(n >= 3, `应当写出若干帧，实际 ${n}`)
    assert.ok(existsSync(join(t.dir, 'manifest.json')))
    const onDisk = JSON.parse(readFileSync(join(t.dir, 'manifest.json'), 'utf8'))
    assert.deepEqual(onDisk.actions.idle.frames, r.manifest.actions.idle.frames)
  } finally { t.done() }
})

test('★ 零输入：连立绘都没有也能得到一整套可播的动作', async () => {
  const t = tmp()
  try {
    const r = await ensureAssets({ card: card(), outDir: t.dir })
    assert.equal(r.ok, true)
    assert.equal(r.manifest.source.kind, 'synthetic', '应当如实标注立绘是程序化生成的')
    assert.ok(r.notes.some((n) => n.includes('兜底')))
  } finally { t.done() }
})

test('★ 用户给了立绘就用它，并记录下来', async () => {
  const t = tmp()
  try {
    const src = synthStandingArt({ seed: 42, width: 80, height: 120 })
    const srcPath = join(t.dir, 'standing.png')
    writeFileSync(srcPath, encodePng(src))
    const r = await ensureAssets({ card: card(), sourcePath: srcPath, outDir: join(t.dir, 'assets') })
    assert.equal(r.ok, true)
    assert.equal(r.manifest.source.kind, 'file')
    assert.equal(r.manifest.source.width, 80)
    // ⚠ 注意区分两个哈希：`hash` 是**风格化之后**的基准（闸门跟它比），
    //   `originalHash` 才是用户那张立绘本身。风格化之后两者必然不同。
    assert.equal(r.manifest.source.originalHash, averageHash(src), '原图哈希要等于用户给的立绘')
    assert.equal(r.manifest.source.style, r.manifest.style)
  } finally { t.done() }
})

test('★ 立绘路径不存在时退回程序化，并如实说明（不让链路断掉）', async () => {
  const t = tmp()
  try {
    const r = await ensureAssets({ card: card(), sourcePath: join(t.dir, '不存在.png'), outDir: join(t.dir, 'assets') })
    assert.ok(r.notes.some((n) => n.includes('不存在')))
    assert.equal(r.manifest.source.kind, 'synthetic')
  } finally { t.done() }
})

test('★ provider 给的帧数与词汇表不符时会被校正并记录', async () => {
  const t = tmp()
  try {
    const sloppy = {
      id: 'sloppy', available: () => true,
      generate({ source, action }) { return { frames: [source, rotate(source, 3)] } },  // 永远给 2 帧
    }
    const r = await ensureAssets({ card: card(), outDir: t.dir, provider: sloppy })
    assert.ok(r.notes.some((n) => n.includes('已校正')))
    for (const [action, a] of Object.entries(r.manifest.actions)) {
      assert.equal(a.frames.length, ACTIONS[action].frames)
    }
  } finally { t.done() }
})

test('★ provider 抛异常时如实记录，不让整批失败', async () => {
  const t = tmp()
  try {
    let n = 0
    const flaky = {
      id: 'flaky', available: () => true,
      generate({ source, action }) { if (n++ === 0) throw new Error('这个动作炸了'); return { frames: framesFor(source, action) } },
    }
    const r = await ensureAssets({ card: card(), outDir: t.dir, provider: flaky })
    assert.ok(r.notes.some((x) => x.includes('生成失败')))
    assert.equal(r.check.missing.length, 1, '失败的那个动作应当被报成"缺"')
    assert.equal(r.ok, false, '缺动作 ⇒ 总判定不通过')
  } finally { t.done() }
})

test('dryRun 不落盘，但清单依然完整可查', async () => {
  const t = tmp()
  try {
    const r = await ensureAssets({ card: card(), outDir: t.dir, dryRun: true })
    assert.equal(r.ok, true)
    assert.equal(existsSync(join(t.dir, 'manifest.json')), false, 'dryRun 不该写文件')
    assert.equal(r.check.ok, true, 'dryRun 的清单也应当是可检查的')
    assert.ok(r.manifest.actions.idle.frames.every((f) => f.includes('idle/')))
  } finally { t.done() }
})

// ══════════════════ I. ★ 多风格：断言"风格真的做了它名字说的事" ══════════════════

test('★ 三种风格的性质是**方向性正确**的（不是"输出不一样"这种弱断言）', () => {
  // 「输出不一样」改一个像素就满足了。这里断言的是每种风格**应该**有的性质：
  //   soft  ⇒ 模糊造出中间色（颜色变多）、高频变低
  //   pixel ⇒ 保留调色板（颜色不增）、方块化
  //   line  ⇒ 边缘占比最高、高频最高（只留线）
  // 两个不同的源图各测一遍 —— 性质必须跨样本稳定，否则只是碰巧。
  for (const seed of [11, 200]) {
    const src = synthStandingArt({ seed, width: 64, height: 96 })
    const base = { colors: distinctColors(src), hf: highFrequencyEnergy(src), edges: edgeRatio(src) }
    const soft = applyStyle(src, 'soft').image
    const pixel = applyStyle(src, 'pixel').image
    const line = applyStyle(src, 'line').image

    const m = {
      soft: { colors: distinctColors(soft), hf: highFrequencyEnergy(soft), edges: edgeRatio(soft) },
      pixel: { colors: distinctColors(pixel), hf: highFrequencyEnergy(pixel), edges: edgeRatio(pixel) },
      line: { colors: distinctColors(line), hf: highFrequencyEnergy(line), edges: edgeRatio(line) },
    }

    assert.ok(m.soft.colors > base.colors, `seed=${seed} soft 应因模糊多出中间色：${m.soft.colors} vs ${base.colors}`)
    assert.ok(m.soft.hf < base.hf, `seed=${seed} soft 高频应更低：${m.soft.hf} vs ${base.hf}`)
    assert.ok(m.soft.edges <= base.edges, `seed=${seed} soft 边缘占比不该升高：${m.soft.edges} vs ${base.edges}`)

    assert.ok(m.pixel.colors <= base.colors, `seed=${seed} pixel 应保留调色板（颜色不增）：${m.pixel.colors} vs ${base.colors}`)
    assert.ok(meanAbsDiff(pixel, src) > 0.005, `seed=${seed} pixel 应看得出变化`)

    assert.ok(m.line.edges > base.edges, `seed=${seed} line 边缘占比该更高：${m.line.edges} vs ${base.edges}`)
    assert.ok(m.line.edges > m.soft.edges && m.line.edges > m.pixel.edges,
      `seed=${seed} line 边缘占比该是三者最高：line=${m.line.edges} soft=${m.soft.edges} pixel=${m.pixel.edges}`)
    assert.ok(m.line.hf > base.hf, `seed=${seed} line 高频该更高（只剩线）：${m.line.hf} vs ${base.hf}`)

    assert.ok(meanAbsDiff(soft, pixel) > 0.02)
    assert.ok(meanAbsDiff(soft, line) > 0.02)
    assert.ok(meanAbsDiff(pixel, line) > 0.02)
  }
})

test('风格化用的原语各自可单测', () => {
  const src = synthStandingArt({ seed: 3 })
  assert.equal(nearestResize(src, 16, 16).width, 16)
  assert.equal(nearestResize(src, src.width, src.height).data.length, src.data.length)
  assert.equal(boxBlur(src, 1).data.length, src.data.length)
  assert.equal(desaturate(src, 1).data.length, src.data.length)
  assert.equal(lighten(src, 1.5).data.length, src.data.length)
  assert.equal(toLineArt(src).data.length, src.data.length)
  // 去饱和到 1 时三通道应相等
  const gray = desaturate(src, 1)
  for (let i = 0; i < gray.data.length; i += 4) {
    if (gray.data[i + 3] === 0) continue
    assert.ok(Math.abs(gray.data[i] - gray.data[i + 1]) <= 1 && Math.abs(gray.data[i + 1] - gray.data[i + 2]) <= 1)
  }
  assert.equal(toLineArt({ width: 2, height: 2, data: new Uint8Array(16) }).data.length, 16)
})

test('applyStyle 是纯函数，且不认识风格时退回 soft 并如实报告', () => {
  const src = synthStandingArt({ seed: 5 })
  const snap = Buffer.from(src.data)
  const r = applyStyle(src, 'soft')
  assert.equal(Buffer.compare(Buffer.from(src.data), snap), 0, '不该改入参')
  assert.equal(r.meta.style, 'soft')
  assert.equal(r.meta.fallbackFrom, null)

  for (const bad of ['赛博朋克', '', null, undefined, 42, {}]) {
    const q = applyStyle(src, bad)
    assert.equal(q.meta.style, 'soft', String(bad))
    assert.equal(q.image.data.length, src.data.length)
  }
  assert.equal(applyStyle(src, '赛博朋克').meta.fallbackFrom, '赛博朋克')
  assert.throws(() => applyStyle(null, 'soft'), /需要一张图/)
})

test('resolveStyle / describeStyle 给出可用信息', () => {
  assert.deepEqual([...STYLE_IDS].sort(), ['line', 'pixel', 'soft'])
  assert.equal(resolveStyle('pixel').id, 'pixel')
  assert.equal(resolveStyle('nope').id, DEFAULT_STYLE)
  assert.equal(resolveStyle(undefined).fallbackFrom, null, 'undefined 不算"不认识"')
  assert.match(describeStyle('line'), /线稿/)
  assert.match(describeStyle('nope'), /不认识风格/)
  for (const id of STYLE_IDS) assert.ok(STYLES[id].note.length > 5, `${id} 缺说明`)
})

test('styleFingerprint 输出三项度量且都在合理范围', () => {
  const src = synthStandingArt({ seed: 7 })
  const f = styleFingerprint(src, { distinctColors, highFrequencyEnergy, edgeRatio })
  assert.ok(f.colors >= 1)
  assert.ok(Number.isFinite(f.hf))
  assert.ok(f.edges >= 0 && f.edges <= 1)
})

// ══════════════════ J. ★ 风格接进管线（顺序：风格化 → 动作） ══════════════════

test('★ 同一风格两次生成逐字节一致（可复现）', async () => {
  const t = tmp()
  try {
    const c = card({ temperament: 'calm', style: 'pixel' })
    const a = await ensureAssets({ card: c, dryRun: true })
    const b = await ensureAssets({ card: c, dryRun: true })
    assert.equal(a.manifest.style, 'pixel')
    assert.equal(a.manifest.source.hash, b.manifest.source.hash)
    assert.equal(a.manifest.actions.idle.hash, b.manifest.actions.idle.hash)
  } finally { t.done() }
})

test('★ 不同风格产出不同的素材，且清单里记下风格', async () => {
  const t = tmp()
  try {
    const outs = {}
    for (const style of STYLE_IDS) {
      const r = await ensureAssets({ card: card({ style }), dryRun: true })
      assert.equal(r.ok, true, `${style}: ${r.notes.join(' | ')}`)
      assert.equal(r.manifest.style, style)
      assert.equal(r.manifest.source.style, style)
      outs[style] = r.framesByAction.idle[0]
    }
    assert.ok(meanAbsDiff(outs.soft, outs.line) > 0.05, '两种风格的素材应明显不同')
    assert.ok(meanAbsDiff(outs.soft, outs.pixel) > 0.02)
  } finally { t.done() }
})

test('★ 质量闸门的基准是"风格化之后的立绘"（否则风格差异会被误判成跑形）', async () => {
  const t = tmp()
  try {
    // line 风格与原图差得最远；基准若用原图，它必然被误判成跑形
    const r = await ensureAssets({ card: card({ style: 'line' }), dryRun: true })
    assert.equal(r.ok, true, `线稿风不该被判跑形：${r.notes.join(' | ')}`)
    assert.ok(r.quality.maxSourceDistance <= QUALITY_DEFAULTS.maxSourceDistance,
      `距基准 ${r.quality.maxSourceDistance} 应在上限内`)
    assert.ok(typeof r.manifest.source.originalHash === 'string' && r.manifest.source.originalHash.length > 0,
      '原图哈希要单独记下来（同一张立绘两种风格要能识别）')
    assert.notEqual(r.manifest.source.hash, r.manifest.source.originalHash, '风格化后的哈希应与原图不同')
  } finally { t.done() }
})

test('★ 生成式 provider 的基准用**原图**（那才是"别跑形"的本意）', async () => {
  const t = tmp()
  try {
    const gen = {
      id: 'fake-gen', kind: 'generative', available: () => true,
      generate({ source }) {
        const d = new Uint8Array(source.data.length)
        for (let i = 0; i < d.length; i += 4) { d[i] = 200; d[i + 1] = 80; d[i + 2] = 90; d[i + 3] = 255 }
        const img = { width: source.width, height: source.height, data: d }
        return { frames: [img, img, img, img] }
      },
    }
    const r = await ensureAssets({ card: card({ style: 'soft' }), provider: gen, dryRun: true })
    assert.ok(r.notes.some((n) => n.includes('生成式')), r.notes.join(' | '))
    assert.equal(r.manifest.provider, 'fake-gen')
  } finally { t.done() }
})

test('没登记的风格会让整条链路退回 soft，并如实记一笔', async () => {
  const t = tmp()
  try {
    // ⚠ 用卡本身携带非法风格已经不行了：spec 把 animation.style 定成枚举，
    //   `normalizeCard` 会直接判它不合法（这是**更早、更清楚**的失败，是好事）。
    //   所以这里走 `style` 覆盖参数来测素材层的容错 ——
    //   真实场景是"旧卡文件里存着一个将来才有的风格名"，那种情况下素材层不该崩。
    const r = await ensureAssets({ card: card(), style: '赛博朋克', dryRun: true })
    assert.equal(r.manifest.style, 'soft')
    assert.equal(r.manifest.source.styleFallbackFrom, '赛博朋克')
    assert.ok(r.notes.some((n) => n.includes('不认识')), r.notes.join(' | '))
  } finally { t.done() }
})

test('★ 卡里写非法风格会在校验阶段就被拦下（比素材层容错更早）', () => {
  const base = {
    id: 'x', name: 'n', game: 'g',
    persona: { soft: { personality: 'p', background: 'b', speechStyle: 's' }, hard: {} },
  }
  assert.equal(validateCard({ ...base, animation: { style: '赛博朋克' } }).ok, false)
  assert.equal(validateCard({ ...base, animation: { style: 'pixel' } }).ok, true)
})

// ══════════════════ H. 角色卡里的动画字段 ══════════════════

test('★ card.mjs 会校验 animation（每个卡字段都要有人管）', () => {
  const base = {
    id: 'x', name: 'n', game: 'g',
    persona: { soft: { personality: 'p', background: 'b', speechStyle: 's' }, hard: {} },
  }
  assert.equal(validateCard({ ...base, animation: { temperament: 'lively' } }).ok, true)
  assert.equal(validateCard({ ...base, animation: { temperament: '暴躁' } }).ok, false, '未登记的气质要报错')
  assert.equal(validateCard({ ...base, animation: [] }).ok, false, '不是对象要报错')
  assert.equal(validateCard({ ...base, animation: { actions: 'sleep' } }).ok, false, 'actions 必须是数组')
  assert.equal(validateCard({ ...base, animation: { scale: -1 } }).ok, false, 'scale 必须是正数')
  const w = validateCard({ ...base, animation: { 未知键: 1 } })
  assert.equal(w.ok, true, '未登记的键只提醒不阻塞')
  assert.ok(w.warnings.some((x) => x.includes('未登记的键')))
})

test('animation 缺失完全合法（默认气质 calm）', () => {
  const base = { id: 'x', name: 'n', game: 'g', persona: { soft: { personality: 'p', background: 'b', speechStyle: 's' }, hard: {} } }
  assert.equal(validateCard(base).ok, true)
  assert.equal(actionsFor(normalizeCard(base).card).temperament, 'calm')
})
