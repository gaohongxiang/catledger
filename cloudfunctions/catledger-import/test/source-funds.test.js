const assert = require('node:assert/strict')
const test = require('node:test')

const { buildPaymentMethodKey } = require('../src/identity')
const { createMappingIndex, projectSourceFunds, reconcileProjectedAccounts, resolveSourceFunds } = require('../src/source-funds')

test('余额宝转出到账户余额直接投影为两个明确账户', () => {
  const projection = projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '余额宝-转出到余额', item: '余额宝转出', paymentMethod: '账户余额'
  })
  assert.equal(projection.kind, 'platform_savings_out')
  assert.equal(projection.from.label, '支付宝余额宝')
  assert.equal(projection.to.label, '支付宝账户余额')
  const index = createMappingIndex([
    { sourceType: 'alipay', paymentMethodKey: buildPaymentMethodKey('alipay', '余额宝'), mappingAction: 'account', accountId: 'yuebao' },
    { sourceType: 'alipay', paymentMethodKey: buildPaymentMethodKey('alipay', '账户余额'), mappingAction: 'account', accountId: 'balance' }
  ])
  assert.deepEqual(resolveSourceFunds(projection, index), { projection, fromAccountId: 'yuebao', toAccountId: 'balance' })
})

test('支付宝官方账户余额提现可从严格动作类型识别转出端', () => {
  const projection = projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '提现-实时提现', item: '提现', paymentMethod: '浙江农商联合银行'
  })
  assert.equal(projection.kind, 'withdrawal')
  assert.equal(projection.from.label, '支付宝账户余额')
  assert.equal(projection.to.label, '浙江农商联合银行')
})

test('支付宝提现在支付方式仍为余额时从交易对方识别到账银行', () => {
  const projection = projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '账户存取', item: '提现-实时提现',
    paymentMethod: '余额', counterparty: '浙江农商联合银行'
  })
  assert.equal(projection.kind, 'withdrawal')
  assert.equal(projection.from.label, '支付宝账户余额')
  assert.equal(projection.to.label, '浙江农商联合银行')
})

test('支付宝提现优先使用原始支付方式，不把余额宝写成账户余额', () => {
  const projection = projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '账户存取', item: '提现-快速到账',
    paymentMethod: '余额宝', counterparty: '浙江农商联合银行(5564)'
  })
  assert.equal(projection.kind, 'withdrawal')
  assert.equal(projection.from.label, '支付宝余额宝')
  assert.equal(projection.to.label, '浙江农商联合银行(5564)')
})

test('普通文案包含提现或充值时不得伪造本人资金流转', () => {
  assert.equal(projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '购物', item: '商家提现优惠券',
    paymentMethod: '余额', counterparty: '合成商店'
  }), null)
  assert.equal(projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '购物', item: '话费充值活动',
    paymentMethod: '余额', counterparty: '合成商店'
  }), null)
})

test('普通商品文案中的余额宝、转入、还款和微信零钱提现均不产生双端投影', () => {
  for (const item of ['余额宝提现活动', '余额宝-提现活动', '转入会员活动', '还款-优惠券']) {
    assert.equal(projectSourceFunds({
      sourceType: 'alipay', rawTransactionType: '购物', item,
      paymentMethod: '余额', counterparty: '合成商店'
    }), null, item)
  }
  assert.equal(projectSourceFunds({
    sourceType: 'wechat', rawTransactionType: '商户消费', item: '微信零钱提现优惠',
    paymentMethod: '零钱', counterparty: '合成商店'
  }), null)
})

test('支付宝官方充值从明确银行卡转入账户余额', () => {
  const projection = projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '账户存取', item: '充值-快捷充值',
    paymentMethod: '浙江农商联合银行储蓄卡(5564)', counterparty: '支付宝'
  })
  assert.equal(projection.kind, 'top_up')
  assert.equal(projection.from.label, '浙江农商联合银行储蓄卡(5564)')
  assert.equal(projection.to.label, '支付宝账户余额')
})

test('微信零钱提现在支付方式仍为零钱时从交易对方识别到账银行', () => {
  const projection = projectSourceFunds({
    sourceType: 'wechat', rawTransactionType: '零钱提现', item: '/',
    paymentMethod: '零钱', counterparty: '浙江农商联合银行(5564)'
  })
  assert.equal(projection.kind, 'withdrawal')
  assert.equal(projection.from.label, '微信零钱')
  assert.equal(projection.to.label, '浙江农商联合银行(5564)')
})

test('微信信用卡还款确定零钱转出端，但无卡尾号时不冒充确定转入账户', () => {
  const projection = projectSourceFunds({
    sourceType: 'wechat', rawTransactionType: '信用卡还款', item: '/',
    paymentMethod: '零钱', counterparty: '兴业银行信用卡还款'
  })
  assert.equal(projection.kind, 'repayment')
  assert.equal(projection.from.label, '微信零钱')
  assert.ok(projection.from.paymentMethodKey)
  assert.equal(projection.to.label, '兴业银行信用卡')
  assert.equal(projection.to.paymentMethodKey, null)
  assert.equal(projection.to.unresolvedReason, 'card_locator_missing')
})

test('微信信用卡还款有卡尾号时可生成稳定转入账户引用', () => {
  const projection = projectSourceFunds({
    sourceType: 'wechat', rawTransactionType: '信用卡还款', item: '/',
    paymentMethod: '零钱', counterparty: '兴业银行信用卡(6106)还款'
  })
  assert.equal(projection.from.label, '微信零钱')
  assert.equal(projection.to.label, '兴业银行信用卡(6106)')
  assert.ok(projection.to.paymentMethodKey)
})

test('支付宝花呗信用购合并账单还款保留真实转出卡并把目标建模为聚合分配', () => {
  const projection = projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '信用借还',
    item: '自动还款-花呗|信用购2026年07月账单', counterparty: '花呗|信用购',
    paymentMethod: '浙江农商联合银行储蓄卡(5564)', direction: 'neutral',
    status: '还款成功'
  })

  assert.equal(projection.kind, 'repayment')
  assert.equal(projection.from.label, '浙江农商联合银行储蓄卡(5564)')
  assert.ok(projection.from.paymentMethodKey)
  assert.equal(projection.to.referenceKind, 'aggregate')
  assert.equal(projection.to.aggregateFamily, 'alipay_huabei_credit')
  assert.equal(projection.to.label, '支付宝花呗｜信用购')
  assert.equal(projection.to.paymentMethodKey, null)
  assert.equal(projection.to.accountIdentityKey, '')
  assert.equal(projection.to.unresolvedReason, 'aggregate_allocation_required')
})

test('普通支付宝消费和普通微信转账不伪造成两个自有账户', () => {
  assert.equal(projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '即时到账交易', item: '午餐', paymentMethod: '账户余额'
  }), null)
  assert.equal(projectSourceFunds({
    sourceType: 'wechat', rawTransactionType: '转账', item: '转给朋友', paymentMethod: '零钱'
  }), null)
})

test('本批新增映射会补齐缺失端，但不覆盖用户手工选择', () => {
  const projection = projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '提现-实时提现', item: '提现', paymentMethod: '浙江农商联合银行储蓄卡(5564)'
  })
  const event = {
    ledgerAccountId: 'manual-balance',
    counterpartyLedgerAccountId: null,
    fieldSources: { fundsProjection: projection }
  }
  const index = createMappingIndex([
    { sourceType: 'alipay', paymentMethodKey: projection.from.paymentMethodKey, mappingAction: 'account', accountId: 'mapped-balance' },
    { sourceType: 'alipay', paymentMethodKey: projection.to.paymentMethodKey, mappingAction: 'account', accountId: 'mapped-bank' }
  ])
  const result = reconcileProjectedAccounts(event, index, { preserveFrom: true })
  assert.equal(result.changed, true)
  assert.equal(result.event.ledgerAccountId, 'manual-balance')
  assert.equal(result.event.counterpartyLedgerAccountId, 'mapped-bank')
})

test('账户确认后的资金重算不得把支付宝余额历史映射重新套回现金账户', () => {
  const projection = projectSourceFunds({
    sourceType: 'alipay', rawTransactionType: '账户存取', item: '提现-实时提现',
    paymentMethod: '余额', counterparty: '浙江农商联合银行'
  })
  const event = {
    ledgerAccountId: null,
    counterpartyLedgerAccountId: null,
    fieldSources: { fundsProjection: projection }
  }
  const index = createMappingIndex([{
    sourceType: 'alipay',
    paymentMethodKey: projection.from.paymentMethodKey,
    paymentMethodHint: '余额',
    mappingAction: 'account',
    accountId: 'wrong-cash-account',
    accountType: 'cash',
    mappingScope: 'history'
  }])

  const result = reconcileProjectedAccounts(event, index)
  assert.equal(result.changed, false)
  assert.equal(result.event.ledgerAccountId, null)
  assert.equal(result.event.counterpartyLedgerAccountId, null)
})

test('增量重算与首次规划使用相同优先级且不依赖候选顺序', () => {
  const candidates = [
    {
      sourceType: 'wechat', paymentMethodKey: 'same-reference', paymentMethodHint: '光大银行信用卡(2690)',
      mappingAction: 'account', accountId: 'history-account', accountType: 'credit', mappingScope: 'history'
    },
    {
      sourceType: 'wechat', paymentMethodKey: 'same-reference', paymentMethodHint: '光大银行信用卡(2690)',
      mappingAction: 'account', accountId: 'batch-account', accountType: 'credit', mappingScope: 'batch'
    }
  ]
  assert.equal(createMappingIndex(candidates).get('wechat:same-reference'), 'batch-account')
  assert.equal(createMappingIndex([...candidates].reverse()).get('wechat:same-reference'), 'batch-account')
})

test('增量重算遇到同级不同账户时保持未知而不是最后一条覆盖', () => {
  const index = createMappingIndex([
    {
      sourceType: 'wechat', paymentMethodKey: 'same-reference',
      mappingAction: 'account', accountId: 'first-account', mappingScope: 'batch'
    },
    {
      sourceType: 'wechat', paymentMethodKey: 'same-reference',
      mappingAction: 'account', accountId: 'second-account', mappingScope: 'batch'
    }
  ])
  assert.equal(index.get('wechat:same-reference'), null)
})
