/**
 * core/lzstring.mjs
 *
 * LZString 兼容实现（零依赖 ESM）。
 *
 * ⚠ 关于版本号，说清楚已验证的范围（别把没验证的写成已验证的）：
 *   · 对拍基准 `tests/vendor/lz-string.js` 的文件内注释写的是 **1.4.5**
 *     （虽然 npm 包元数据标 1.5.0、版权头写 WTFPL v2 —— 三处不一致，以文件内注释为准）。
 *   · 四条编码路径（Base64 / UTF16 / Uint8Array / 16 位通用）已与它对拍，**逐字符码元一致**。
 *   · 但该文件的 `compress` **忽略 `bitsPerChar`**（实测 `compress(x,6) === compress(x,16)`），
 *     所以 `bitsPerChar` 非 16 的通用形式**只做了自洽往返验证，没有参考可对拍**。
 *     本项目真正要用的只有 `decompressFromBase64`（RPG Maker 走这一条），它已被交叉验证。
 *
 * 为什么需要它
 * ------------
 * RPG Maker MV / MZ 的存档文件（`global.rpgsave`、`file1.rpgsave`、`file1.rmmzsave` 等）
 * 存的不是 JSON 文本，而是 `LZString.compressToBase64(JSON.stringify(saveContents))`
 * 的结果：一个 UTF-16 字符流按每字符 6 bit 打包后再映射到 base64 字母表的字符串。
 * MZ 的 `StorageManager` 走的是同样的 compressToBase64 / decompressFromBase64 一对函数。
 * 所以桌宠要读存档，最小前置件就是一个能在 Node 里跑、行为与浏览器端 LZString
 * 完全一致的实现：多一个字节的差异都会让存档解不出来。
 *
 * 兼容范围
 * --------
 * 导出 compressToBase64 / decompressFromBase64、compressToUTF16 / decompressFromUTF16、
 * compressToUint8Array / decompressFromUint8Array，以及底层的
 * compress(input, bitsPerChar) / decompress(input, bitsPerChar)。
 * `bitsPerChar` 省略时为 16，即参考实现里 `compress` / `decompress` 的固定行为
 * （该版本没有 bitsPerChar 参数，后续版本才把它开放出来）。
 * 通用位宽形式是本实现的扩展，**未与参考对拍**（原因见上面的版本说明）。
 *
 * 编码细节（每条都与参考实现核对过，不是凭记忆写的）
 * --------------------------------------------------
 * - 压缩端字典用普通对象 + `Object.prototype.hasOwnProperty`，因此 `__proto__` 这类
 *   输入字符不会踩到原型链。
 * - 端标记的码值是 2，写在「当前 numBits」宽度里。
 * - **收尾至少写一个字符**：参考实现用的是
 *   `while(true){ val<<=1; if (pos==bitsPerChar-1){push;break;} pos++; }`，
 *   即使端标记正好落在字符边界上，它也会再补一个全 0 字符（base64 里表现为多一个 'A'）。
 *   写成 `while (bitLen !== 0)` 会少一个字符，压缩输出就对不上了。
 * - **位序是反直觉的**：参考实现从字符里取位是从最高位开始（`data.val & data.position`），
 *   但用 `bits |= (resb>0?1:0) * power; power <<= 1;` 组装，即读到的第 1 位成为结果的
 *   最低位。于是「码值」与「字面量」都按位流顺序低位优先组装。
 * - 解压端第一个码是 **2 位**（不是 3 位），其后的码才是 numBits 位。
 * - 解压端字典 0/1/2 号槽位是数字 0/1/2，查表用的是真值判断，0 号槽位会落到 else 分支；
 *   这条退化路径决定了畸形输入的返回值，必须保持一致。
 * - 解压端每字符位数 = `3 + floor(log2(resetValue))`，并校验 `2**n === resetValue`。
 * - 空输入：compress* 返回 ""（null/undefined 也返回 ""）；decompress* 对 "" 返回 null，
 *   对 null/undefined 返回 ""。数据非法时返回 "" 或 null，不抛异常。
 * - `compressToUint8Array` 用的是「每字符 16 bit」的原始 compress，再按 UCS-2 大端拆字节；
 *   奇数字节长度会让还原出的字符码变成 NaN，参考实现随即抛 RangeError，本实现同样抛出。
 *
 * 验证方式（实测，不是声明）
 * --------------------------
 * 参考实现：`tests/vendor/lz-string.js`（LZString 1.4.5，作者 Pieroxy，WTFPL 授权，
 * 许可证全文见 `tests/vendor/lz-string.LICENSE`）。测试文件：`tests/lzstring.test.mjs`，
 * 用 Node 内置 `node:test` + `node:assert/strict`，通过 `createRequire` 加载上述参考实现，
 * 固定种子（mulberry32）生成随机输入，对每个输入做：
 *   1. 自往返（compressToBase64 → decompressFromBase64 等）严格相等；
 *   2. 压缩输出与参考实现**字符串完全相等**（逐个 charCodeAt 核对）；
 *   3. 双向交叉解压（我的压缩 → 参考解压，参考压缩 → 我的解压）；
 *   4. 边界与非法输入行为对拍（空串、null/undefined、base64 特殊字符、截断数据）；
 *   5. 模拟 RPG Maker 存档的真实形状（数万字符 JSON）走完整链路。
 * 具体通过数见该测试文件的实际运行输出。
 *
 * 上游项目：http://pieroxy.net/blog/pages/lz-string/index.html
 */

const KEY_STR_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

const BASE_REVERSE = new Map();

/** 字母表 → 字符 → 索引 的反查表（按字母表字符串缓存）。 */
function reverseAlphabet(alphabet) {
  let table = BASE_REVERSE.get(alphabet);
  if (table === undefined) {
    table = new Map();
    for (let i = 0; i < alphabet.length; i++) table.set(alphabet.charAt(i), i);
    BASE_REVERSE.set(alphabet, table);
  }
  return table;
}

/**
 * 校验 bitsPerChar 的合法形状：正整数（不必是 2 的幂，6 与 15 都在用）。
 * 与参考实现的差异：参考实现的形状检查只覆盖解压端（`Math.log(resetValue)` 得到 NaN 时
 * 抛 RangeError），这里在压缩端也做同样的检查，让位数传错时立刻失败而不是静默产出垃圾。
 */
function requirePositiveBits(bitsPerChar) {
  if (!Number.isInteger(bitsPerChar) || bitsPerChar <= 0) {
    throw new RangeError(`bitsPerChar must be a positive integer, got ${bitsPerChar}`);
  }
}

/** 压缩：把输入按 bitsPerChar 位一字符打包，返回由 getCharFromInt 生成的字符串。 */
function compressCore(input, bitsPerChar, getCharFromInt) {
  if (input == null) return '';

  const dictionary = new Map(); // 串 → 码值
  const pending = new Set(); // 已分配码值、但码字尚未输出的「新字面量」
  let dictSize = 3; // 0 / 1 / 2 被短码 0、1 与端标记 2 占用
  let numBits = 2;
  let enlargeIn = 2; // 抵消第一个不该计数的词条

  const out = [];
  let bitBuf = 0; // 待输出位缓冲，只占低 bitsPerChar 位
  let bitLen = 0;

  const pushBit = (bit) => {
    bitBuf = (bitBuf << 1) | bit;
    bitLen++;
    if (bitLen === bitsPerChar) {
      out.push(getCharFromInt(bitBuf));
      bitBuf = 0;
      bitLen = 0;
    }
  };

  /** 写 value 的低 count 位，低位在前。 */
  const pushBits = (value, count) => {
    for (let i = 0; i < count; i++) {
      pushBit(value & 1);
      value = Math.floor(value / 2);
    }
  };

  const writeCode = (value) => pushBits(value, numBits);

  const stepEnlarge = () => {
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  };

  /** 写出一个全新的字面量：短码 0/1 加 8/16 位字符码。 */
  const writeLiteral = (str) => {
    const code = str.charCodeAt(0);
    if (code < 256) {
      pushBits(0, numBits);
      pushBits(code, 8);
    } else {
      pushBits(1, numBits);
      pushBits(code, 16);
    }
    stepEnlarge();
  };

  let w = '';
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);

    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize++);
      pending.add(c);
    }

    const wc = w + c;
    if (dictionary.has(wc)) {
      w = wc;
      continue;
    }

    if (pending.has(w)) {
      writeLiteral(w);
      pending.delete(w);
    } else {
      writeCode(dictionary.get(w));
    }
    stepEnlarge();

    dictionary.set(wc, dictSize++);
    w = c;
  }

  if (w !== '') {
    if (pending.has(w)) {
      writeLiteral(w);
      pending.delete(w);
    } else {
      writeCode(dictionary.get(w));
    }
    stepEnlarge();
  }

  // 端标记（码值 2），写在当前码宽里
  writeCode(2);

  // 收尾至少写一个字符，见文件头「编码细节」：不能写成 while (bitLen !== 0)。
  do {
    pushBit(0);
  } while (bitLen !== 0);

  return out.join('');
}

/**
 * 解压：与 compressCore 对称。resetValue 是每个字符能装下的位数（= 2 的幂）。
 *
 * 位序与首码宽度见文件头注释；这里的 readBits 刻意写成低位优先，
 * 对应参考实现的 `bits |= (resb>0?1:0) * power; power <<= 1;`。
 */
function decompressCore(length, resetValue, getNextValue) {
  const bitsPerChar = Math.round(Math.log(resetValue) / Math.LN2);
  if (2 ** bitsPerChar !== resetValue) {
    throw new RangeError(`resetValue must be a power of two, got ${resetValue}`);
  }

  // 0/1/2 三个槽位被短码占用；w 用 null 表示参考实现里「尚未确立」的 undefined
  const dictionary = [0, 1, 2];
  let dictSize = 4;
  let numBits = 3;
  let enlargeIn = 4;
  const result = [];

  let val = getNextValue(0);
  let position = resetValue;
  let index = 1;

  const readBit = () => {
    const bit = val & position ? 1 : 0;
    position >>= 1;
    if (position === 0) {
      position = resetValue;
      val = getNextValue(index++);
    }
    return bit;
  };

  /** 读 count 位，位流里的第 1 位成为结果的最低位。 */
  const readBits = (count) => {
    let value = 0;
    for (let i = 0; i < count; i++) value |= readBit() << i;
    return value;
  };

  // ---- 流首：2 位短码 + 8/16 位字面量 ----
  let code = readBits(2);
  if (code === 2) return '';
  const first = String.fromCharCode(readBits(code === 0 ? 8 : 16));
  dictionary[3] = first;
  let w = first;
  result.push(first);

  while (index <= length) {
    code = readBits(numBits);

    if (code === 0 || code === 1) {
      const literal = String.fromCharCode(readBits(code === 0 ? 8 : 16));
      dictionary[dictSize] = literal;
      code = dictSize; // 本轮按这个码值取词条
      dictSize++;
      enlargeIn--;
    } else if (code === 2) {
      return result.join('');
    }

    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }

    // 真值判断（不是 !== undefined）：字典 0 号槽位是数字 0（falsy），
    // 畸形输入的退化路径依赖它落到 else 里，行为才与参考实现一致。
    const entry = dictionary[code] ? dictionary[code] : code === dictSize ? w + w.charAt(0) : null;
    if (entry === null) return null;
    result.push(entry);

    // 把 w+entry[0] 补进字典
    dictionary[dictSize] = w + entry.charAt(0);
    dictSize++;
    enlargeIn--;

    w = entry;

    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }

  // 长度耗尽但没读到端标记
  return '';
}

/**
 * 压缩为 base64（RPG Maker 存档用的就是这个）。
 * 尾部补 `=` 把长度凑成 4 的倍数（`length % 4` 为 1 补 3 个、为 2 补 2 个、为 3 补 1 个）。
 */
export function compressToBase64(input) {
  if (input == null) return '';
  const res = compressCore(input, 6, (a) => KEY_STR_BASE64.charAt(a));
  switch (res.length % 4) {
    case 1:
      return `${res}===`;
    case 2:
      return `${res}==`;
    case 3:
      return `${res}=`;
    default:
      return res;
  }
}

/** 解压 base64。空串返回 null，null/undefined 返回 ''。 */
export function decompressFromBase64(input) {
  if (input == null) return '';
  if (input === '') return null;
  const table = reverseAlphabet(KEY_STR_BASE64);
  return decompressCore(input.length, 32, (i) => {
    const v = table.get(input.charAt(i));
    // 字母表外的字符：参考实现拿到 undefined，`undefined & position` 退化成 0；
    // 这里显式给 NaN，进入 `val & position` 后同样是 0，行为一致。
    return v === undefined ? NaN : v;
  });
}

/** 压缩为 UTF-16（每个 15 bit 值偏移 +32 存成一个字符，末尾再补一个空格）。 */
export function compressToUTF16(input) {
  if (input == null) return '';
  return `${compressCore(input, 15, (a) => String.fromCharCode(a + 32))} `;
}

/** 解压 UTF-16（resetValue 16384 = 2**14，对应每字符 15 bit）。 */
export function decompressFromUTF16(compressed) {
  if (compressed == null) return '';
  if (compressed === '') return null;
  return decompressCore(compressed.length, 16384, (i) => compressed.charCodeAt(i) - 32);
}

/**
 * 压缩为 Uint8Array（每字符 16 bit 的原始压缩流，按 UCS-2 大端拆成字节）。
 * 这里刻意不走 compress() 的位数校验：位数传成非法值时，参考实现会因
 * `new Uint8Array(NaN)` 抛 RangeError，本实现保持同样的失败方式。
 */
export function compressToUint8Array(uncompressed, bitsPerChar = 16) {
  const compressed = compressCore(uncompressed, bitsPerChar, (a) => String.fromCharCode(a));
  const buf = new Uint8Array(compressed.length * 2);
  for (let i = 0; i < compressed.length; i++) {
    const value = compressed.charCodeAt(i);
    buf[i * 2] = value >>> 8;
    buf[i * 2 + 1] = value % 256;
  }
  return buf;
}

/**
 * 从 Uint8Array 解压。null/undefined 原样落到 decompress，返回 ''。
 * 奇数字节长度无法两两拼成 UCS-2 字符，参考实现会在读出 NaN 后抛 RangeError
 * （半个字符 → undefined 参与运算 → NaN 长度）；这里显式抛出同类型的错误。
 */
export function decompressFromUint8Array(compressed, bitsPerChar = 16) {
  if (compressed === null || compressed === undefined) {
    return decompress(compressed, bitsPerChar);
  }
  if (compressed.length % 2 !== 0) {
    throw new RangeError(`Uint8Array length must be even, got ${compressed.length}`);
  }
  const chars = [];
  for (let i = 0; i < compressed.length / 2; i++) {
    const value = compressed[i * 2] * 256 + compressed[i * 2 + 1];
    chars.push(String.fromCharCode(value));
  }
  return decompress(chars.join(''), bitsPerChar);
}

/** 底层通用压缩。bitsPerChar 省略时为 16，即 LZString 1.4.5 的 compress。 */
export function compress(input, bitsPerChar = 16) {
  requirePositiveBits(bitsPerChar);
  return compressCore(input, bitsPerChar, (a) => String.fromCharCode(a));
}

/**
 * 底层通用解压，与 compress(input, bitsPerChar) 对称。空串返回 null，
 * null/undefined 返回 ''。省略 bitsPerChar 时按 16 处理，即 LZString 1.4.5 的 decompress。
 *
 * 重置位 = `2 ** (bitsPerChar - 1)`：16 → 32768，与 1.4.5 里写死的 32768 一致。
 * （注意不是 `2 ** bitsPerChar`；差一位会让整个位流错位。）
 */
export function decompress(compressed, bitsPerChar = 16) {
  requirePositiveBits(bitsPerChar);
  if (compressed == null) return '';
  if (compressed === '') return null;
  return decompressCore(compressed.length, 2 ** (bitsPerChar - 1), (i) => compressed.charCodeAt(i));
}
