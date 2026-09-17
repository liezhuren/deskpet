/**
 * tests/lzstring.test.mjs
 *
 * 对拍测试：core/lzstring.mjs（被测） vs tests/vendor/lz-string.js（参考实现，LZString 1.4.5）。
 *
 * 覆盖：
 *   1. 自往返一致性（随机 + 固定边界串）
 *   2. 压缩输出与参考实现字符串完全相等（逐字符码元核对）
 *   3. 双向交叉解压
 *   4. 模拟 RPG Maker 存档形状（数万字符 JSON）的完整链路
 *   5. 空串 / null / undefined / base64 特殊字符 / 非法输入的行为对拍
 *   6. compressToUTF16 与 compressToUint8Array 系列
 *
 * 随机输入用固定种子（mulberry32），可复现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  compress,
  decompress,
  compressToBase64,
  decompressFromBase64,
  compressToUTF16,
  decompressFromUTF16,
  compressToUint8Array,
  decompressFromUint8Array,
} from '../core/lzstring.mjs';

const require = createRequire(import.meta.url);
const ref = require('./vendor/lz-string.js');

// ---------------------------------------------------------------------------
// 确定性 PRNG（mulberry32）+ 采样工具
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x5eed1234);
const randInt = (n) => Math.floor(rand() * n);

/** 全码点范围取样，跳过代理区（0xD800-0xDFFF），保证是合法单字符。 */
function randomChar() {
  for (;;) {
    const cp = randInt(0x110000);
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    return String.fromCodePoint(cp);
  }
}

const ASCII = 'The quick brown fox jumps over the lazy dog. 0123456789';
const CJK = '角色扮演游戏存档：生命值魔法值金钱道具装备地图坐标事件开关变量';
const EMOJI = '🐱🐶🐉🎮💾🧪🌙✨';
const CTRL = '\u0000\u0001\u0007\u0008\u0009\u000a\u000d\u001b\u001f\u007f\u0080\u009f\u00ff\u2028\u2029';

const FIXED_CASES = [
  ['空串', ''],
  ['单字符 ASCII', 'a'],
  ['单字符 中文', '角'],
  ['单字符 emoji', '🐱'],
  ['单字符 控制符', '\u0000'],
  ['单字符 BMP 高位', '\uffff'],
  ['单字符 增补平面', '\u{10FFFF}'],
  ['NUL 重复', '\u0000\u0000\u0000\u0000\u0000'],
  ['含 __proto__', '__proto__ constructor prototype hasOwnProperty'],
  ['含 toString/valueOf', 'toString valueOf __defineGetter__ 0 1 2 3'],
  ['含代理对', '𠮷野家🎌𩸽'],
  ['全控制字符', CTRL],
  ['数字字符串', '123456789012345678901234567890'],
  ['长 ASCII', 'abcdefghijklmnopqrstuvwxyz'.repeat(40)],
  ['长重复', 'ab'.repeat(500)],
];

/** 生成若干类随机串，覆盖纯 ASCII / 中文 / emoji / 控制符 / 混合 / 高重复 / 超长。 */
function randomString(i) {
  switch (i % 7) {
    case 0:
      return Array.from({ length: randInt(400) }, () => ASCII[randInt(ASCII.length)]).join('');
    case 1:
      return Array.from({ length: randInt(400) }, () => CJK[randInt(CJK.length)]).join('');
    case 2:
      return Array.from({ length: randInt(200) }, () => EMOJI[randInt(EMOJI.length)]).join('');
    case 3:
      return Array.from({ length: randInt(200) }, () => CTRL[randInt(CTRL.length)]).join('');
    case 4:
      return Array.from({ length: randInt(120) }, randomChar).join('');
    case 5: {
      // 极端重复：打满字典增长分支
      const unit = Array.from({ length: 1 + randInt(4) }, randomChar).join('');
      return unit.repeat(1 + randInt(300));
    }
    default: {
      // 混合大串
      const parts = [];
      const n = 200 + randInt(1800);
      for (let k = 0; k < n; k++) {
        const bucket = randInt(5);
        if (bucket === 0) parts.push(ASCII[randInt(ASCII.length)]);
        else if (bucket === 1) parts.push(CJK[randInt(CJK.length)]);
        else if (bucket === 2) parts.push(EMOJI[randInt(EMOJI.length)]);
        else if (bucket === 3) parts.push(CTRL[randInt(CTRL.length)]);
        else parts.push(randomChar());
      }
      return parts.join('');
    }
  }
}

const RANDOM_CASES = [];
for (let i = 0; i < 200; i++) RANDOM_CASES.push([`随机#${i}`, randomString(i)]);
const ALL_CASES = [...FIXED_CASES, ...RANDOM_CASES];

const describe = (label, s) =>
  `${label} (len=${s.length}, head=${JSON.stringify(s.slice(0, 30))})`;

/** 把异常也变成可比较的值，便于对拍“谁抛了什么”。 */
const attempt = (fn, ...args) => {
  try {
    return fn(...args);
  } catch (e) {
    return `THROW:${e.constructor.name}`;
  }
};

// ---------------------------------------------------------------------------
// 0. API 形状
// ---------------------------------------------------------------------------

test('API 形状：参考实现导出所需函数，被测模块导出同名函数', () => {
  const names = [
    'compress',
    'decompress',
    'compressToBase64',
    'decompressFromBase64',
    'compressToUTF16',
    'decompressFromUTF16',
    'compressToUint8Array',
    'decompressFromUint8Array',
  ];
  for (const name of names) {
    assert.equal(typeof ref[name], 'function', `参考实现缺少 ${name}`);
  }
  assert.equal(typeof compress, 'function');
  assert.equal(typeof decompress, 'function');
  assert.equal(typeof compressToBase64, 'function');
  assert.equal(typeof decompressFromBase64, 'function');
  assert.equal(typeof compressToUTF16, 'function');
  assert.equal(typeof decompressFromUTF16, 'function');
  assert.equal(typeof compressToUint8Array, 'function');
  assert.equal(typeof decompressFromUint8Array, 'function');
});

// ---------------------------------------------------------------------------
// 1. 自往返一致性
// ---------------------------------------------------------------------------

test('往返：compressToBase64 → decompressFromBase64', () => {
  for (const [label, input] of ALL_CASES) {
    const packed = compressToBase64(input);
    assert.equal(typeof packed, 'string', describe(label, input));
    assert.equal(decompressFromBase64(packed), input, describe(label, input));
  }
});

test('往返：compressToUTF16 → decompressFromUTF16', () => {
  for (const [label, input] of ALL_CASES) {
    const packed = compressToUTF16(input);
    assert.equal(typeof packed, 'string', describe(label, input));
    assert.equal(packed.endsWith(' '), true, describe(label, input));
    assert.equal(decompressFromUTF16(packed), input, describe(label, input));
  }
});

test('往返：compressToUint8Array → decompressFromUint8Array', () => {
  for (const [label, input] of ALL_CASES) {
    const packed = compressToUint8Array(input);
    assert.equal(packed instanceof Uint8Array, true, describe(label, input));
    assert.equal(packed.length % 2, 0, describe(label, input));
    assert.equal(decompressFromUint8Array(packed), input, describe(label, input));
  }
});

test('往返：底层 compress(…) → decompress(…)（含多种位宽）', () => {
  const samples = [
    '',
    'a',
    'hello',
    '存档🎮',
    'The quick brown fox jumps over the lazy dog',
    '角色扮演'.repeat(50),
  ];
  for (const bits of [4, 6, 8, 12, 15, 16]) {
    for (const input of samples) {
      const packed = compress(input, bits);
      assert.equal(typeof packed, 'string');
      assert.equal(decompress(packed, bits), input, `bits=${bits} ${JSON.stringify(input.slice(0, 12))}`);
    }
  }
});

test('往返：compress(input) 与 compress(input, undefined) 一致（默认参数）', () => {
  for (const [label, input] of ALL_CASES.slice(0, 40)) {
    assert.equal(compress(input, undefined), compress(input), describe(label, input));
    assert.equal(decompress(compress(input), undefined), input, describe(label, input));
  }
});

test('往返：compress(input, 6) 映射到 base64 字母后与 compressToBase64 同码流', () => {
  // compress(input, 6) 产出「字符码 = 6 位值」的原始流（\x10 对应字母 'Q'），
  // 映射到 base64 字母表、去掉 padding 后应与 compressToBase64 完全一致。
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const toLetters = (raw) => Array.from(raw, (ch) => B64.charAt(ch.charCodeAt(0))).join('');
  for (const [label, input] of ALL_CASES.slice(0, 60)) {
    assert.equal(
      toLetters(compress(input, 6)),
      compressToBase64(input).replace(/=+$/, ''),
      describe(label, input),
    );
  }
});

// ---------------------------------------------------------------------------
// 2. 与参考实现逐字符对拍（压缩输出）
// ---------------------------------------------------------------------------

/** 逐字符码元比较，失败时报出第一个不同的位置。 */
function assertSameString(mine, theirs, label) {
  assert.equal(typeof mine, typeof theirs, label);
  assert.equal(mine.length, theirs.length, `${label}（长度不同）`);
  for (let i = 0; i < theirs.length; i++) {
    if (mine.charCodeAt(i) !== theirs.charCodeAt(i)) {
      assert.fail(`${label} 第 ${i} 个码元不同：mine=${mine.charCodeAt(i)} ref=${theirs.charCodeAt(i)}`);
    }
  }
}

test('对拍：compressToBase64 与参考实现完全相等', () => {
  for (const [label, input] of ALL_CASES) {
    assertSameString(compressToBase64(input), ref.compressToBase64(input), describe(label, input));
  }
});

test('对拍：compressToUTF16 与参考实现完全相等', () => {
  for (const [label, input] of ALL_CASES) {
    assertSameString(compressToUTF16(input), ref.compressToUTF16(input), describe(label, input));
  }
});

test('对拍：compressToUint8Array 与参考实现完全相等', () => {
  for (const [label, input] of ALL_CASES) {
    const mine = compressToUint8Array(input);
    const theirs = ref.compressToUint8Array(input);
    assert.equal(mine.length, theirs.length, `${describe(label, input)}（字节数不同）`);
    for (let i = 0; i < theirs.length; i++) {
      if (mine[i] !== theirs[i]) {
        assert.fail(`${describe(label, input)} 第 ${i} 字节不同：mine=${mine[i]} ref=${theirs[i]}`);
      }
    }
  }
});

test('对拍：底层 compress 与参考实现完全相等（16 位，即参考实现的默认行为）', () => {
  // 参考实现 1.4.5 的 compress 固定 16 位/字符，没有 bitsPerChar 参数，
  // 因此只有 16 位这一档能直接对拍；其他位宽走下面的自洽往返测试。
  for (const [label, input] of ALL_CASES) {
    assertSameString(compress(input, 16), ref.compress(input), describe(label, input));
    assertSameString(compress(input), ref.compress(input), `默认参数 ${describe(label, input)}`);
  }
});

test('底层 compress(input, bits) 在多种位宽下自洽（参考实现不支持，故不做对拍）', () => {
  // 参考实现的 compress 会忽略第二个参数，所以这里只验证自身往返，以及
  // 6 位 / 15 位码流与 compressToBase64 / compressToUTF16 的一致性。
  // 注意：compress(input, 6) 产出的是「字符码 = 6 位值」（\x10 对应 base64 的 'Q'），
  // 要经过字母表映射后才是 base64 字符串。
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const toBase64Letters = (raw) => Array.from(raw, (ch) => B64.charAt(ch.charCodeAt(0))).join('');
  // compressToUTF16 把每个 15 位值偏移 +32 后存成字符，所以要比对需再加回 +32
  const toUTF16Chars = (raw) => Array.from(raw, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32)).join('');

  for (const [label, input] of ALL_CASES.slice(0, 60)) {
    for (const bits of [4, 6, 8, 12, 15, 16]) {
      const packed = compress(input, bits);
      assert.equal(decompress(packed, bits), input, `bits=${bits} ${describe(label, input)}`);
    }
    // 6 位码流映射成 base64 字母后，应与 compressToBase64 去掉 padding 一致
    assert.equal(toBase64Letters(compress(input, 6)), compressToBase64(input).replace(/=+$/, ''), describe(label, input));
    // 15 位码流偏移 +32 后应等于 compressToUTF16 去掉尾部补位空格
    assert.equal(toUTF16Chars(compress(input, 15)), compressToUTF16(input).slice(0, -1), describe(label, input));
  }
});

// ---------------------------------------------------------------------------
// 3. 双向交叉解压
// ---------------------------------------------------------------------------

test('交叉：我的压缩 → 参考解压 = 原文', () => {
  for (const [label, input] of ALL_CASES) {
    assert.equal(ref.decompressFromBase64(compressToBase64(input)), input, describe(label, input));
    assert.equal(ref.decompressFromUTF16(compressToUTF16(input)), input, describe(label, input));
    assert.equal(ref.decompressFromUint8Array(compressToUint8Array(input)), input, describe(label, input));
    assert.equal(ref.decompress(compress(input)), input, describe(label, input));
  }
});

test('交叉：参考压缩 → 我的解压 = 原文', () => {
  for (const [label, input] of ALL_CASES) {
    assert.equal(decompressFromBase64(ref.compressToBase64(input)), input, describe(label, input));
    assert.equal(decompressFromUTF16(ref.compressToUTF16(input)), input, describe(label, input));
    assert.equal(decompressFromUint8Array(ref.compressToUint8Array(input)), input, describe(label, input));
    assert.equal(decompress(ref.compress(input)), input, describe(label, input));
  }
});

// ---------------------------------------------------------------------------
// 4. 真实形状：RPG Maker 存档 JSON
// ---------------------------------------------------------------------------

function makeSaveData() {
  const skills = [];
  for (let i = 1; i <= 40; i++) {
    skills.push({ id: i, name: `技能-${i}`, mpCost: i * 3, note: `<target:${i % 4}>\n<damage:${i * 11}>` });
  }

  const items = {};
  for (let i = 1; i <= 60; i++) {
    items[i] = { id: i, name: `道具${i}号`, count: (i * 7) % 13, obtained: i % 3 === 0 };
  }

  const actors = [];
  for (let i = 1; i <= 8; i++) {
    actors.push({
      _actorId: i,
      _name: `角色${i}🐉`,
      _classId: (i % 5) + 1,
      _level: 10 + i,
      _hp: 120 + i * 7,
      _mp: 30 + i * 3,
      _exp: { 1: i * 1000, 2: 0, 3: null },
      _equips: [1, i + 10, 0, i + 20, i + 30],
      _skills: skills.slice(0, 5 + i).map((s) => s.id),
      _states: i % 4 === 0 ? [4, 5, 6] : [],
      _note: `备注\u0000二\u001f制控制符 ${'x'.repeat(50)}`,
    });
  }

  const map = {};
  for (let y = 0; y < 25; y++) {
    const row = [];
    for (let x = 0; x < 25; x++) row.push((x * y) % 17);
    map[`${y}`] = row;
  }

  // 一段几万字符的长文本，逼近真实存档里的大 note / 长事件指令
  const longText = Array.from(
    { length: 20000 },
    (_, i) => `存档长文本内容-这是第${i}段：\u0000\u0001\t换行\n与 emoji 🎒💾\r\n`,
  ).join('');

  return {
    _system: { version: 4, switches: [true, false, null, true], variables: { 1: 0, 2: 999999 } },
    _switches: [true, false, false, true],
    _variables: { 1: 42, 2: -1, 3: null, 4: 3.14159 },
    _selfSwitches: { A: true, B: false, C: true, D: false },
    _actors: actors,
    _items: items,
    _weapons: [1, 2, 3],
    _armors: [1, 2, 3],
    _party: { _gold: 123456, _steps: 98765, _members: [1, 2, 3, 4], _items: items },
    _map: { _mapId: 7, _interpreter: { _depth: 0, _branch: {} }, _events: map },
    _longText: longText,
    _nested: { a: { b: { c: { d: { e: [null, 0, '', false, [], {}, '中文'] } } } } },
    _protoTrap: { __proto__: 'x', constructor: 'y' },
  };
}

test('真实形状：RPG Maker 存档 JSON 完整链路', () => {
  const save = makeSaveData();
  const json = JSON.stringify(save);
  assert.ok(json.length > 100000, `期望十万字符量级，实际 ${json.length}`);

  const packed = compressToBase64(json);
  assert.equal(typeof packed, 'string');
  assert.ok(packed.length < json.length, '压缩后应当明显更短');

  // 与参考实现压缩结果完全一致
  assertSameString(packed, ref.compressToBase64(json), '存档压缩输出');

  // 我的解压
  const back = decompressFromBase64(packed);
  assert.equal(typeof back, 'string');
  assert.notEqual(back, null);
  assert.equal(back, json);
  assert.deepStrictEqual(JSON.parse(back), JSON.parse(json));

  // 参考解我的压缩；我解参考的压缩
  assert.equal(ref.decompressFromBase64(packed), json);
  assert.equal(decompressFromBase64(ref.compressToBase64(json)), json);

  // 存档形状：合法 base64 字母表且长度是 4 的倍数
  assert.equal(packed.length % 4, 0);
  assert.match(packed, /^[A-Za-z0-9+/]+={0,3}$/);
});

test('真实形状：同一存档的 UTF16 / Uint8Array 链路也一致', () => {
  const json = JSON.stringify(makeSaveData());

  assertSameString(compressToUTF16(json), ref.compressToUTF16(json), 'utf16 压缩');
  assert.equal(decompressFromUTF16(compressToUTF16(json)), json);
  assert.equal(decompressFromUTF16(ref.compressToUTF16(json)), json);
  assert.equal(ref.decompressFromUTF16(compressToUTF16(json)), json);

  const bytes = compressToUint8Array(json);
  const refBytes = ref.compressToUint8Array(json);
  assert.equal(bytes.length, refBytes.length);
  assert.deepStrictEqual(Array.from(bytes), Array.from(refBytes));
  assert.equal(decompressFromUint8Array(bytes), json);
  assert.equal(ref.decompressFromUint8Array(bytes), json);
  assert.equal(decompressFromUint8Array(refBytes), json);
});

// ---------------------------------------------------------------------------
// 5. 边界与非法输入
// ---------------------------------------------------------------------------

test('边界：空串的行为与参考实现一致', () => {
  // 注意：空串并不是全空输出。compress 仍会写端标记并收尾，所以
  // compress('') 会产出一个字符；compressToBase64('') 得到 "Q==="。
  // 这些值都是从参考实现实测出来的，不是推断。
  assertSameString(compressToBase64(''), ref.compressToBase64(''), 'compressToBase64("")');
  assert.equal(compressToBase64(''), 'Q===');
  assertSameString(compressToUTF16(''), ref.compressToUTF16(''), 'compressToUTF16("")');
  assert.equal(compressToUTF16(''), '\u2020 ');
  assertSameString(compress(''), ref.compress(''), 'compress("")');
  assert.equal(compressToUint8Array('').length, ref.compressToUint8Array('').length);
  assert.equal(
    attempt(decompressFromBase64, compressToBase64('')),
    attempt(ref.decompressFromBase64, ref.compressToBase64('')),
  );
  assert.equal(decompressFromBase64(compressToBase64('')), '');
  assert.equal(decompressFromUTF16(compressToUTF16('')), '');
  assert.equal(decompressFromUint8Array(compressToUint8Array('')), '');
  assert.equal(decompress(compress('')), '');

  // 空压缩流解压 → null（参考实现的实测行为，不是 ""）
  assert.equal(ref.decompressFromBase64(''), null);
  assert.equal(decompressFromBase64(''), null);
  assert.equal(ref.decompressFromUTF16(''), null);
  assert.equal(decompressFromUTF16(''), null);
  assert.equal(ref.decompress(''), null);
  assert.equal(decompress(''), null);
});

test('边界：null / undefined 的行为与参考实现一致', () => {
  for (const bad of [null, undefined]) {
    assert.equal(compressToBase64(bad), ref.compressToBase64(bad), `compressToBase64(${bad})`);
    assert.equal(compressToUTF16(bad), ref.compressToUTF16(bad), `compressToUTF16(${bad})`);
    assert.equal(compress(bad), ref.compress(bad), `compress(${bad})`);
    assert.equal(decompressFromBase64(bad), ref.decompressFromBase64(bad), `decompressFromBase64(${bad})`);
    assert.equal(decompressFromUTF16(bad), ref.decompressFromUTF16(bad), `decompressFromUTF16(${bad})`);
    assert.equal(decompress(bad), ref.decompress(bad), `decompress(${bad})`);
    assert.equal(
      decompressFromUint8Array(bad),
      ref.decompressFromUint8Array(bad),
      `decompressFromUint8Array(${bad})`,
    );
    // 解压端对 null/undefined 返回 ""，压缩端也返回 ""
    assert.equal(decompressFromBase64(bad), '');
    assert.equal(decompress(bad), '');
    assert.equal(compress(bad), '');
  }
});

test('边界：含 + / = 的输入往返与对拍（这些字符属于 base64 字母表）', () => {
  const cases = [
    '++++++++',
    '////////',
    '====',
    '+/+=+/+=',
    'a+b/c=d',
    'A'.repeat(100) + '+/==',
    '中文+/=中文',
    '\u0000+/=\u001f',
  ];
  for (const input of cases) {
    const label = describe('base64 特殊字符', input);
    assertSameString(compressToBase64(input), ref.compressToBase64(input), label);
    assert.equal(decompressFromBase64(compressToBase64(input)), input, label);
    assert.equal(decompressFromBase64(ref.compressToBase64(input)), input, label);
    assert.equal(ref.decompressFromBase64(compressToBase64(input)), input, label);
  }
});

test('非法输入：decompressFromBase64 不抛异常，返回值与参考实现一致', () => {
  // 参考实现的真实行为（逐条实测）：非空但非法的输入返回 null、"" 或极短的垃圾串，
  // 绝不抛异常。这里分两类断言：
  //   - 空串 → null（明确契约）
  //   - 其余非法输入 → 与参考实现逐字符一致，且不得解出「看起来像正常文本」的长内容
  assert.equal(ref.decompressFromBase64(''), null);
  assert.equal(decompressFromBase64(''), null);

  const invalids = [
    '!',
    '!!!!',
    'not base64 at all',
    '@@@@',
    '\u0000\u0001\u0002',
    'A',
    'AB',
    'ABCD',
    'AAAA',
    '////',
    '====',
    'A===',
    'AAAA====',
    '中文中文',
    'ZZZZZZZZZZZZ',
    'a b c d',
    'eJw',
    'eJx',
    'eJz',
    '~',
    '\u00ff',
    'B',
    'AA',
    'AAA',
    'AAAAA',
  ];
  for (const input of invalids) {
    let mine;
    assert.doesNotThrow(() => {
      mine = decompressFromBase64(input);
    }, `mine threw on ${JSON.stringify(input)}`);
    const theirs = ref.decompressFromBase64(input);
    assert.equal(mine, theirs, `非法输入不一致: ${JSON.stringify(input)}`);
    // 非法输入的产物要么是 null / ""，要么是参考实现同样会吐出的 1 字符垃圾；
    // 绝不会解出有意义的文本。'AB' / 'ABCD' / 'ZZZZ' 这类短串在参考实现里
    // 会解出单个 U+0000（实测），这里如实接受而不是把断言放宽到无意义。
    assert.ok(
      mine === null || mine === '' || (mine.length === 1 && mine === '\u0000'),
      `非法输入解出了内容: ${JSON.stringify(input)} -> ${JSON.stringify(mine)}`,
    );
  }
});

test('非法输入：截断 / 篡改的合法压缩流，双方行为一致', () => {
  const sources = [
    'hello world hello world hello world',
    '存档数据存档数据存档数据',
    '🎮'.repeat(40),
    'The quick brown fox jumps over the lazy dog',
  ];
  for (const src of sources) {
    const good = ref.compressToBase64(src);
    const variants = [
      good.slice(0, Math.max(1, good.length - 4)), // 截断
      good.slice(0, 1),
      good.slice(0, 2),
      good.slice(0, 4),
      good.replace(/^./, good[0] === 'A' ? 'B' : 'A'), // 首字符篡改
      good + 'AAAA', // 尾部追加垃圾
      good.slice(0, -1),
      good.slice(0, -2),
    ];
    for (const v of variants) {
      let mine;
      assert.doesNotThrow(() => {
        mine = decompressFromBase64(v);
      }, `mine threw on ${JSON.stringify(v)}`);
      assert.equal(mine, ref.decompressFromBase64(v), `不一致: ${JSON.stringify(v)}`);
    }
  }
});

test('非法输入：UTF16 / 底层解压不抛异常，行为与参考一致', () => {
  const badStrings = ['!', 'x', 'xxxx', '\u0000\u0000\u0000\u0000', 'hello', 'A', 'AB', ' ', 'not base64 at all'];
  for (const s of badStrings) {
    assert.doesNotThrow(() => {
      assert.equal(
        attempt(decompressFromUTF16, s),
        attempt(ref.decompressFromUTF16, s),
        `UTF16 ${JSON.stringify(s)}`,
      );
    });
  }
  for (const s of ['!', 'x', 'xxxx', '\u0000\u0000', '\u0000\u0000\u0000\u0000', 'hello']) {
    assert.doesNotThrow(() => {
      assert.equal(attempt(decompress, s), attempt(ref.decompress, s), `raw ${JSON.stringify(s)}`);
    });
  }
});

test('非法输入：Uint8Array 的边界行为与参考一致（含奇数字节长度抛 RangeError）', () => {
  // 偶数字节的垃圾数据
  for (const bytes of [
    new Uint8Array([0, 0, 0, 0]),
    new Uint8Array([255, 255, 255, 255]),
    new Uint8Array([]),
  ]) {
    assert.equal(
      attempt(decompressFromUint8Array, bytes),
      attempt(ref.decompressFromUint8Array, bytes),
      `bytes ${JSON.stringify(Array.from(bytes))}`,
    );
  }

  // 奇数字节：参考实现抛 RangeError（实测），本实现同样抛
  for (const bytes of [
    new Uint8Array([1]),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([5]),
  ]) {
    assert.equal(attempt(ref.decompressFromUint8Array, bytes), 'THROW:RangeError');
    assert.equal(attempt(decompressFromUint8Array, bytes), 'THROW:RangeError');
  }

  // null / undefined 落到 decompress，返回 ""
  assert.equal(decompressFromUint8Array(null), ref.decompressFromUint8Array(null));
  assert.equal(decompressFromUint8Array(undefined), ref.decompressFromUint8Array(undefined));
  assert.equal(decompressFromUint8Array(null), '');
  assert.equal(decompressFromUint8Array(undefined), '');
});

test('参数校验：非法 bitsPerChar 立即抛 RangeError', () => {
  for (const bad of [0, -1, 1.5, NaN, 'six']) {
    assert.throws(() => compress('x', bad), RangeError, `compress bits=${String(bad)}`);
    assert.throws(() => decompress('x', bad), RangeError, `decompress bits=${String(bad)}`);
  }
});

test('压缩率：真实存档能被有效压缩（冒烟，不依赖参考实现）', () => {
  const json = JSON.stringify(makeSaveData());
  const packed = compressToBase64(json);
  assert.ok(packed.length < json.length / 2, `压缩率异常：${json.length} -> ${packed.length}`);
  assert.equal(decompressFromBase64(packed), json);
});
