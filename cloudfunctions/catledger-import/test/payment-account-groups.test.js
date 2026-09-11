const test = require('node:test')
const assert = require('node:assert/strict')
const { referencesForRows } = require('../src/payment-account-groups')
const base = { sourceType: 'alipay', sourceFormat: 'alipay_app_csv', rawStatus: '交易成功', amountMinor: '1000', direction: 'expense', rawTransactionType: '信用借还', counterparty: '1688先采后付', item: '先采后付账单付款', paymentMethod: '测试银行储蓄卡(1234)&账户余额' }
test('账户引用独立于组合金额，目标只按明确平台产品及信用借还识别', () => {
  assert.deepEqual(referencesForRows([base]).map(x => x.label), ['测试银行储蓄卡(1234)', '支付宝账户余额', '1688先采后付'])
  assert.equal(referencesForRows([{ ...base, rawTransactionType: '购物' }]).length, 2)
  assert.equal(referencesForRows([{ ...base, counterparty: '某商家' }]).length, 2)
  assert.equal(referencesForRows([base, { ...base, paymentMethod: '账户余额' }]).length, 0)
  assert.equal(referencesForRows([{ ...base, paymentMethod: '账户余额' }])[0].memberRole, 'payment_target')
  assert.deepEqual(referencesForRows([{ ...base, paymentMethod: '优惠券&账户余额&测试银行储蓄卡(1234)' }]).slice(0, 2).map(x => x.componentIndex), [1, 2])
})

test('归组新鲜判定与实际刷新候选一致，忽略已处理和舍弃证据', () => {
  const { needsExpansion, VERSION } = require('../src/payment-account-groups')
  const event = { eventId: 'event', status: 'needs_action', fieldSources: {} }
  const rows = [{ ...base, rowId: 'row' }], evidence = [{ eventId: 'event', rowId: 'row', evidenceRole: 'primary' }]
  assert.equal(needsExpansion([event], rows, evidence), true)
  assert.equal(needsExpansion([{ ...event, fieldSources: { paymentAccountGroupsVersion: VERSION } }], rows, evidence), false)
  assert.equal(needsExpansion([{ ...event, fieldSources: { paymentResolution: {} } }], rows, evidence), false)
  assert.equal(needsExpansion([{ ...event, status: 'excluded' }], rows, evidence), false)
  assert.equal(needsExpansion([event], rows, [{ ...evidence[0], evidenceRole: 'discarded' }]), false)
  assert.equal(needsExpansion([event], [{ ...rows[0], rawTransactionType: '购物', paymentMethod: '账户余额' }], evidence), false)
})
