// tools/gen-card-doc.mjs —— 从 core/card-spec.mjs 生成 docs/CARD.md
//
// 为什么要有这个工具：**规范只能有一个事实来源**。
// 手写文档 + 手写校验，两者一定会漂移（"文档说必填、代码没查"这种）。
// 所以文档由 spec 生成，并有一道测试盯着生成结果与仓库里的文件逐字一致。
//
// 用法：
//   node tools/gen-card-doc.mjs            # 写入 docs/CARD.md
//   node tools/gen-card-doc.mjs --check    # 只检查是否一致（CI/测试用），不一致则退出码 1

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { specToMarkdown } from '../core/card-spec.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'docs', 'CARD.md')
const text = specToMarkdown()
const check = process.argv.includes('--check')

if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n').trimEnd() : null
  if (cur === null) { console.error('docs/CARD.md 不存在'); process.exit(1) }
  if (cur !== text.replace(/\r\n/g, '\n').trimEnd()) {
    console.error('docs/CARD.md 与 core/card-spec.mjs 不一致 —— 跑 `node tools/gen-card-doc.mjs` 重新生成')
    process.exit(1)
  }
  console.log('docs/CARD.md 与 spec 一致 ✅')
  process.exit(0)
}

writeFileSync(OUT, text, 'utf8')
console.log(`已写入 ${OUT}（${text.length} 字节，${text.split('\n').length} 行）`)
