// tests/xml.test.mjs —— core/xml.mjs 的测试
//
// 测试数据取自实测到的真实 XML 形状：
//   · Noita 存档：<Entity _version="1" name="" tags="wand"><_Transform position.x="165.603" .../></Entity>
//   · Ultimate Chicken Horse：<UCHSave version="1.11.01" creationDate="..." lastSaveDate="..."><settings><sound...
// 映射规则（属性 → @名，同名重复 → 数组）是下游 core/diff.mjs 做路径匹配的依据，
// 所以这些行为必须被钉死。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseXml, decodeEntities } from '../core/xml.mjs'

test('单元素 + 属性 + 文本', () => {
  assert.deepEqual(parseXml('<a x="1" y="2">hi</a>'), { a: { '@x': '1', '@y': '2', '#text': 'hi' } })
})

test('嵌套结构', () => {
  const x = parseXml('<root><child><leaf v="1"/></child></root>')
  assert.deepEqual(x, { root: { child: { leaf: { '@v': '1' } } } })
})

test('★ 同名重复子元素自动转数组（diff 才能看出列表变长）', () => {
  const x = parseXml('<r><i v="1"/><i v="2"/><i v="3"/></r>')
  assert.deepEqual(x.r.i, [{ '@v': '1' }, { '@v': '2' }, { '@v': '3' }])
})

test('单个子元素不是数组（形状保持一致，避免消费方到处判类型）', () => {
  assert.deepEqual(parseXml('<r><i v="1"/></r>').r.i, { '@v': '1' })
})

test('★ 属性与同名子元素互不覆盖（用 @ 前缀的理由）', () => {
  const x = parseXml('<a b="attr"><b>child</b></a>')
  assert.deepEqual(x, { a: { '@b': 'attr', b: '#text' && { '#text': 'child' } } })
})

test('自闭合元素', () => {
  assert.deepEqual(parseXml('<root><empty/></root>'), { root: { empty: {} } })
})

test('XML 声明与注释被忽略', () => {
  const x = parseXml('<?xml version="1.0" encoding="utf-8"?>\n<!-- note -->\n<r><a>1</a></r>')
  assert.deepEqual(x, { r: { a: { '#text': '1' } } })
})

test('DOCTYPE 被忽略', () => {
  assert.deepEqual(parseXml('<!DOCTYPE html><r><a/></r>'), { r: { a: {} } })
})

test('CDATA 保留原文且不解实体', () => {
  const x = parseXml('<r><a><![CDATA[x < y & z]]></a></r>')
  assert.equal(x.r.a['#text'], 'x < y & z')
})

test('元素之间的空白不产生 #text', () => {
  const x = parseXml('<r>\n  <a>1</a>\n  <b>2</b>\n</r>')
  assert.deepEqual(x.r, { a: { '#text': '1' }, b: { '#text': '2' } })
})

test('实体解码：命名 / 十进制 / 十六进制', () => {
  assert.equal(decodeEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f')
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB')
  assert.equal(decodeEntities('&unknown;'), '&unknown;', '未知实体保留原文，不吞掉')
  assert.equal(decodeEntities('no entities'), 'no entities')
  assert.equal(parseXml('<r t="a&amp;b"/>').r['@t'], 'a&b')
})

test('★ 属性值里含 > 不会截断标签', () => {
  const x = parseXml('<r a="x > y" b="2"/>')
  assert.deepEqual(x.r, { '@a': 'x > y', '@b': '2' })
})

test('单引号与无引号属性', () => {
  assert.deepEqual(parseXml("<r a='1' b=2/>").r, { '@a': '1', '@b': '2' })
})

test('非法/截断的 XML 不抛异常', () => {
  for (const bad of ['<r><a>', '<r', '<', '<a></b>', '']) {
    assert.doesNotThrow(() => parseXml(bad))
  }
})

test('完全不是 XML 时返回 null', () => {
  assert.equal(parseXml('just text'), null)
  assert.equal(parseXml('{"json":1}'), null)
  assert.equal(parseXml(''), null)
  assert.equal(parseXml(null), null)
})

test('BOM 被忽略', () => {
  assert.deepEqual(parseXml('\uFEFF<r><a>1</a></r>'), { r: { a: { '#text': '1' } } })
})

test('★ 实测形状：Noita 存档片段', () => {
  const src = '<Entity \r\n  _version="1" \r\n  name="" \r\n  serialize="1" \r\n  tags="teleportable_NOT,hittable,wand" >\r\r\n' +
    '  <_Transform \r\n    position.x="165.603" \r\n    position.y="250.307" \r\n    rotation="-0.168747" \r\n  />\r\n</Entity>'
  const x = parseXml(src)
  assert.equal(x.Entity['@tags'], 'teleportable_NOT,hittable,wand')
  assert.equal(x.Entity['@_version'], '1')
  assert.equal(x.Entity._Transform['@position.x'], '165.603')
  assert.equal(x.Entity._Transform['@rotation'], '-0.168747')
})

test('★ 实测形状：Ultimate Chicken Horse（base64 解出来的 XML）', () => {
  const src = '<UCHSave version="1.11.01" creationDate="07/04/2023 13:16:17" lastSaveDate="07/28/2024 09:15:05">' +
    '<settings><sound volume="0.8"/><video fullscreen="true"/></settings></UCHSave>'
  const x = parseXml(src)
  assert.equal(x.UCHSave['@version'], '1.11.01')
  assert.equal(x.UCHSave['@lastSaveDate'], '07/28/2024 09:15:05')
  assert.equal(x.UCHSave.settings.sound['@volume'], '0.8')
  assert.equal(x.UCHSave.settings.video['@fullscreen'], 'true')
})

test('结果可复现', () => {
  const src = '<r><a x="1"/><a x="2"/><b>t</b></r>'
  assert.equal(JSON.stringify(parseXml(src)), JSON.stringify(parseXml(src)))
})
