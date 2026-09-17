// tools/art-check.mjs —— 素材层实测工具：生成素材、打印质量闸门的**实测值**
//
// 存在意义：`art/index.mjs` 里的质量阈值不该是拍脑袋定的，必须有实测依据。
// `--measure` 会打印动作间差异、与立绘的相似度等真实数字，阈值据此设定。
//
// 用法：
//   node tools/art-check.mjs --measure                # 打印实测值（不落盘）
//   node tools/art-check.mjs <输出目录>                # 真的生成一套素材并落盘
//   node tools/art-check.mjs <输出目录> --lively       # 用活泼气质
//   node tools/art-check.mjs <输出目录> --source a.png # 用指定立绘
//   node tools/art-check.mjs <目录> --lazy            # 故意用"偷懒的 provider"（应当被闸门拦下）

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureAssets, QUALITY_DEFAULTS, describeManifestCheck } from '../art/index.mjs'
import { actionsFor, ACTIONS } from '../art/actions.mjs'
import { createProceduralProvider, synthStandingArt, hashSeed } from '../art/procedural.mjs'
import { STYLE_IDS, STYLES, describeStyle } from '../art/styles.mjs'
import { decodePng, distinctColors, highFrequencyEnergy, edgeRatio } from '../art/image.mjs'
import { normalizeCard } from '../core/card.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

const styleArg = argOf('--style')
const card = buildCard(has('--lively') ? 'lively' : has('--cool') ? 'cool' : 'calm', styleArg)
const want = actionsFor(card)

function buildCard(temperament, style) {
  const { card: c, errors } = normalizeCard({
    id: 'demo', name: '霞', game: 'demo',
    animation: { temperament, style: style ?? 'soft' },
    persona: {
      soft: { personality: '嘴硬心软', background: '同班同学', speechStyle: '短句' },
      hard: { speechTics: ['……才不是'], forbiddenWords: ['本小姐'], addresses: { player: '你' }, avgLength: { min: 4, max: 40 }, emojiPolicy: 'none' },
    },
  })
  if (errors.length) throw new Error(errors.join('；'))
  return c
}

// "偷懒的 provider"：所有动作都返回同一张图 —— 用来确认闸门真的会拦下它
const lazyProvider = {
  id: 'lazy', name: '偷懒（所有动作同一张图）', kind: 'test', available: () => true,
  generate({ source }) { return { frames: [source, source, source], meta: { provider: 'lazy' } } },
}

const sourcePath = argOf('--source')
let source = null
if (sourcePath) {
  if (!existsSync(sourcePath)) { console.error(`立绘不存在：${sourcePath}`); process.exit(2) }
  source = decodePng(readFileSync(sourcePath))
}

const outDir = argv.find((a) => !a.startsWith('--') && a !== sourcePath) ?? null
const dryRun = has('--measure') || !outDir

const r = await ensureAssets({
  card,
  source,
  sourcePath: sourcePath ?? undefined,
  outDir: dryRun ? null : outDir,
  provider: has('--lazy') ? lazyProvider : createProceduralProvider(),
  style: styleArg ?? undefined,
  dryRun,
})

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, c) => a + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, n - w))
}

console.log(`角色卡：${card.name}（气质 ${want.temperament}）`)
console.log(`可用风格：${STYLE_IDS.join(' / ')}（当前 ${r.manifest.style}${r.manifest.source.styleFallbackFrom ? `，原指定「${r.manifest.source.styleFallbackFrom}」不认识` : ''}）`)
console.log(`  ${describeStyle(r.manifest.style)}`)
console.log(`需要动作：${want.required.join('、')}`)
for (const why of want.reasons) console.log(`  · ${why}`)
if (want.optional.length) console.log(`可选动作（不需要，不生成）：${want.optional.join('、')}`)

console.log(`\n立绘来源：${r.manifest.source.kind}${r.manifest.source.file ? ` (${r.manifest.source.file})` : ''} ${r.manifest.source.width}x${r.manifest.source.height}`)
console.log(`provider：${r.manifest.provider}`)
console.log(`风格：${r.manifest.style}（已作用于基准；原图哈希 ${String(r.manifest.source.originalHash).slice(0, 8)}… ≠ 基准 ${String(r.manifest.source.hash).slice(0, 8)}…）`)

// 三张代表性的图各报一次"风格指纹"——用它确认风格真的做了它名字说的事
const sig = r.framesByAction.idle?.[0]
if (sig) {
  console.log('\n=== 风格指纹（idle 首帧）===')
  console.log(`  颜色数 ${distinctColors(sig)} · 高频(均值) ${highFrequencyEnergy(sig).toFixed(3)} · 边缘占比 ${edgeRatio(sig).toFixed(3)}`)
  console.log('  参考：soft 颜色多而高频低；pixel 颜色不增；line 边缘占比与高频都最高')
}

const q = r.quality
console.log('\n=== 质量闸门实测值 ===')
console.log(`${pad('指标', 34)}${pad('实测', 12)}阈值`)
console.log('-'.repeat(66))
console.log(`${pad('动作间最小平均像素差', 34)}${pad(q.minPairDiff.toFixed(5), 12)}≥ ${QUALITY_DEFAULTS.minActionDiff}   ${q.worstPair ? `（最接近的一对：${q.worstPair.join(' / ')}）` : ''}`)
if (r.manifest.source.kind !== 'synthetic' || true) {
  console.log(`${pad('与立绘的最大哈希距离', 34)}${pad(String(q.maxSourceDistance), 12)}≤ ${QUALITY_DEFAULTS.maxSourceDistance}   ${q.worstAction ? `（最不像的：${q.worstAction}）` : ''}`)
}
for (const [id, a] of Object.entries(q.perAction)) {
  console.log(`  ${pad(id, 32)}帧 ${pad(a.frames, 4)}帧内最大差 ${pad(a.internalDiff.toFixed(5), 10)}距立绘 ${pad(String(a.fromSource ?? '-'), 6)}不透明占比 ${a.opaque.toFixed(3)}`)
}

console.log('\n=== 逐项判定 ===')
console.log(`素材清单一致性：${describeManifestCheck(r.check)}`)
console.log(`质量闸门：${q.ok ? '通过 ✅' : '不通过 ❌'}`)
for (const n of q.notes) console.log(`  · ${n}`)
for (const n of r.notes) if (!q.notes.includes(n)) console.log(`  · ${n}`)
console.log(`\n总判定：${r.ok ? 'OK ✅' : 'FAIL ❌'}`)

if (!dryRun) {
  console.log(`\n已写入 ${outDir}（${Object.keys(r.manifest.actions).length} 个动作，共 ${Object.values(r.manifest.actions).reduce((n, a) => n + a.frames.length, 0)} 帧 + manifest.json）`)
}
void ACTIONS
void synthStandingArt
void hashSeed
void join
process.exit(r.ok ? 0 : 1)
