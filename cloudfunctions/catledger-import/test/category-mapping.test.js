const assert = require('node:assert/strict')
const test = require('node:test')

const { buildCategoryEvidence, canonicalName } = require('../src/category-mapping')

function row(transactionType, counterparty, item) {
  return { raw: { transactionType, counterparty, item } }
}

test('支付宝明确分类保守映射到当前账本系统分类', function () {
  assert.equal(buildCategoryEvidence('alipay', row('餐饮美食', '', '')).deterministicSystemKey, 'food')
  assert.equal(buildCategoryEvidence('alipay', row('交通出行', '', '')).deterministicSystemKey, 'transport')
  assert.equal(buildCategoryEvidence('alipay', row('医疗健康', '', '')).deterministicSystemKey, 'medical')
  assert.equal(buildCategoryEvidence('alipay', row('商业服务', '', '')).deterministicSystemKey, null)
})

test('分类别名稳定摘要且排除宽泛交易类型', function () {
  const first = buildCategoryEvidence('wechat', row('商户消费', ' 合成商户 ', '食品'))
  const second = buildCategoryEvidence('wechat', row('商户消费', '合成商户', '食品'))
  assert.deepEqual(first.aliasKeys, second.aliasKeys)
  assert.equal(first.aliasKeys.length, 2)
  assert.match(first.aliasKeys[0], /^[0-9a-f]{64}$/)
  assert.equal(canonicalName(' 餐饮 - 美食 '), '餐饮美食')
})

test('微信只对旧规则已经验证的证据做建议', function () {
  assert.equal(buildCategoryEvidence('wechat', row('商户消费', '美团平台商户', '')).deterministicSystemKey, 'food')
  assert.equal(buildCategoryEvidence('wechat', row('商户消费', '普通合成商户', '')).deterministicSystemKey, null)
})
