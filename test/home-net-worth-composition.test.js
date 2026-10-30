const test = require('node:test')
const assert = require('node:assert/strict')
const { composition, shortAccountName } = require('../miniprogram/pages/index/net-worth-composition')

const asset = (name, minor, extra) => Object.assign({ accountId: name, nature: 'asset', name, bookBalanceMinor: minor }, extra)
const liability = (name, minor) => ({ accountId: name, nature: 'liability', name, bookBalanceMinor: minor })

test('资产按金额降序，百分比用最大余数法凑满 100', () => {
  const shares = composition([asset('微信零钱', '551551'), asset('农商行', '1737920'), asset('支付宝', '3200')]).assets
  assert.deepEqual(shares.items.map(item => item.name), ['农商行', '微信零钱', '支付宝'])
  assert.deepEqual(shares.items.map(item => item.percentText), ['76%', '24%', '<1%'])
  const sum = shares.items.reduce((total, item) => total + (item.percentText === '<1%' ? 0 : Number(item.percentText.replace('%', ''))), 0)
  assert.equal(sum, 100, '显示出来的百分比合计 100，不出现 97% 这种')
  assert.equal(shares.bar.reduce((total, seg) => total + seg.permille, 0), 1000)
})

test('负债取绝对值，不与资产混在一条里', () => {
  const shares = composition([asset('农商行', '1737920'), liability('花呗', '-180000'), liability('信用卡', '-120000')])
  assert.equal(shares.assets.items.length, 1)
  assert.deepEqual(shares.liabilities.items.map(item => item.name), ['花呗', '信用卡'])
  assert.deepEqual(shares.liabilities.items.map(item => item.percentText), ['60%', '40%'])
})

test('0 元账户不进构成，也不占「其他」的名额', () => {
  const shares = composition([asset('农商行', '1737920'), asset('支付宝', '0'), asset('现金', '0')]).assets
  assert.deepEqual(shares.items.map(item => item.name), ['农商行'])
  assert.equal(shares.bar.length, 1)
})

test('账户多于 5 个时条封顶 6 段，第 6 段是其余合计', () => {
  const accounts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, index) => asset(name, String(700 - index * 100)))
  const shares = composition(accounts).assets
  assert.equal(shares.items.length, 7, '图例仍然逐个列出')
  assert.equal(shares.bar.length, 6, '条最多 6 段')
  assert.equal(shares.bar[5].tone, 'mix-tone-other')
  assert.equal(shares.bar[5].accountId, 'other')
  assert.deepEqual(shares.items.map(item => item.tone), ['mix-tone-1', 'mix-tone-2', 'mix-tone-3', 'mix-tone-4', 'mix-tone-5', 'mix-tone-other', 'mix-tone-other'])
  assert.equal(shares.bar.reduce((total, seg) => total + seg.permille, 0), 1000)
})

test('一侧没有账户时返回空构成，交给页面写「暂无」', () => {
  const shares = composition([asset('农商行', '1737920')])
  assert.equal(shares.liabilities.empty, true)
  assert.deepEqual(shares.liabilities.items, [])
  assert.deepEqual(shares.liabilities.bar, [])
  assert.equal(shares.liabilities.totalMinor, '0')
  assert.deepEqual(composition([]).assets.items, [])
})

test('图例用短名：去掉尾号括号，超过 6 个字截断', () => {
  assert.equal(shortAccountName('浙江农商联合银行储蓄卡(5564)'), '浙江农商联合…')
  assert.equal(shortAccountName('微信零钱'), '微信零钱')
  assert.equal(shortAccountName('  支付宝账户余额（8891） '), '支付宝账户余…')
  assert.equal(shortAccountName(''), '账户')
  assert.equal(shortAccountName(null), '账户')
})
