const assert = require('node:assert/strict')
const test = require('node:test')

const { buildPaymentMethodKey } = require('../src/identity')
const { scopeReference, confirmedBinding } = require('../src/account-binding')
const { accountIdFromIndex, resolutionFromIndex } = require('../src/account-mapping-policy')
const {
  createMappingIndex,
  ledgerAccountReferenceForRow,
  projectSourceFunds,
  reconcileProjectedAccounts,
  resolveSourceFunds
} = require('../src/source-funds')

function confirmedMapping(reference, accountId, overrides = {}) {
  return { sourceType: reference.sourceType, paymentMethodKey: reference.bindingKey || reference.paymentMethodKey,
    paymentMethodHint: reference.label, mappingAction: accountId ? 'account' : 'ignore', accountId,
    accountType: reference.expectedAccountType || 'wallet', accountCurrency: 'CNY', mappingScope: 'batch',
    binding: confirmedBinding(reference), ...overrides }
}

test('余额宝转出到账户余额直接投影为两个明确账户', () => {
  const projection = projectSourceFunds({
    importId: 'synthetic-savings-file', sourceType: 'alipay', rawTransactionType: '余额宝-转出到余额', item: '余额宝转出', paymentMethod: '账户余额'
  })
  assert.equal(projection.kind, 'platform_savings_out')
  assert.equal(projection.from.label, '支付宝余额宝')
  assert.equal(projection.to.label, '支付宝账户余额')
  const index = createMappingIndex([
    confirmedMapping(projection.from, 'yuebao'), confirmedMapping(projection.to, 'balance')
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

test('微信收入转账按明确到账状态推导微信零钱账本端', () => {
  const reference = ledgerAccountReferenceForRow({
    sourceType: 'wechat', rawTransactionType: '转账', transactionType: 'transfer',
    direction: 'income', paymentMethod: '/', rawStatus: '已存入零钱'
  })
  assert.equal(reference.label, '微信零钱')
  assert.equal(reference.role, 'ledger_account')
  assert.equal(reference.inferenceRule, 'wechat_income_deposited_to_change')
  assert.equal(reference.paymentMethodKey, buildPaymentMethodKey('wechat', '零钱'))

  for (const candidate of [
    { direction: 'expense', rawStatus: '已存入零钱' },
    { direction: 'income', rawStatus: '支付成功' },
    { direction: 'income', rawStatus: '已存入零钱', rawTransactionType: '商户消费', transactionType: 'payment' }
  ]) {
    assert.equal(ledgerAccountReferenceForRow({
      sourceType: 'wechat', rawTransactionType: '转账', transactionType: 'transfer',
      direction: 'income', paymentMethod: '/', rawStatus: '已存入零钱', ...candidate
    }), null)
  }
})

test('本批新增映射会补齐缺失端，但不覆盖用户手工选择', () => {
  const projection = projectSourceFunds({
    importId: 'synthetic-withdrawal-file', sourceType: 'alipay', rawTransactionType: '提现-实时提现', item: '提现', paymentMethod: '浙江农商联合银行储蓄卡(5564)'
  })
  const event = {
    ledgerAccountId: 'manual-balance',
    counterpartyLedgerAccountId: null,
    fieldSources: { fundsProjection: projection }
  }
  const index = createMappingIndex([
    confirmedMapping(projection.from, 'mapped-balance'), confirmedMapping(projection.to, 'mapped-bank')
  ])
  const result = reconcileProjectedAccounts(event, index, { preserveFrom: true })
  assert.equal(result.changed, true)
  assert.equal(result.event.ledgerAccountId, 'manual-balance')
  assert.equal(result.event.counterpartyLedgerAccountId, 'mapped-bank')
})

test('账户确认后的资金重算拒绝把支付宝余额绑定到现金账户', () => {
  const projection = projectSourceFunds({
    importId: 'synthetic-wrong-account-file', sourceType: 'alipay', rawTransactionType: '账户存取', item: '提现-实时提现',
    paymentMethod: '余额', counterparty: '浙江农商联合银行'
  })
  const event = {
    ledgerAccountId: null,
    counterpartyLedgerAccountId: null,
    fieldSources: { fundsProjection: projection }
  }
  const index = createMappingIndex([confirmedMapping(projection.from, 'wrong-cash-account', { accountType: 'cash' })])

  const result = reconcileProjectedAccounts(event, index)
  assert.equal(result.changed, false)
  assert.equal(result.event.ledgerAccountId, null)
  assert.equal(result.event.counterpartyLedgerAccountId, null)
})

test('增量重算与首次规划使用相同优先级且不依赖候选顺序', () => {
  const reference = scopeReference({ sourceType: 'wechat', paymentMethodKey: 'same-reference', label: '微信零钱' },
    { sourceProfileKey: 'a'.repeat(64), currency: 'CNY' })
  const candidates = [
    confirmedMapping(reference, 'history-account', { mappingScope: 'history' }),
    confirmedMapping(reference, 'batch-account')
  ]
  assert.equal(accountIdFromIndex(createMappingIndex(candidates), reference), 'batch-account')
  assert.equal(accountIdFromIndex(createMappingIndex([...candidates].reverse()), reference), 'batch-account')
})

test('增量重算遇到同级不同账户时保持未知而不是最后一条覆盖', () => {
  const reference = scopeReference({ sourceType: 'wechat', paymentMethodKey: 'same-reference', label: '合成银行信用卡(1234)' },
    { importId: 'synthetic-conflict-file', currency: 'CNY' })
  const index = createMappingIndex([
    confirmedMapping(reference, 'first-account'), confirmedMapping(reference, 'second-account')
  ])
  assert.equal(accountIdFromIndex(index, reference), null)
  assert.equal(resolutionFromIndex(index, reference).kind, 'conflict')
})


test('聚合目标只在完整候选全部收敛时自动归属，未知和历史唯一标记不能放行', () => {
  const reference = key => scopeReference({ sourceType: 'alipay', paymentMethodKey: key, label: '合成引用' + key },
    { importId: 'synthetic-aggregate-file', currency: 'CNY' })
  const projection = { from: reference('bank'), to: { referenceKind: 'aggregate', candidates: [], resolvedAccountId: 'stale-account' } }
  const index = createMappingIndex([
    confirmedMapping(reference('bank'), 'bank-account'),
    confirmedMapping(reference('first'), 'account-a'),
    confirmedMapping(reference('same'), 'account-a'),
    confirmedMapping(reference('other'), 'account-b'),
    confirmedMapping(reference('ignored'), null)
  ])
  for (const keys of [[], ['unknown'], ['first','unknown'], ['unknown','first'], ['first','ignored'], ['first','other']]) {
    const value = { ...projection, to: { ...projection.to, candidates: keys.map(reference) } }
    const resolved = resolveSourceFunds(value, index)
    assert.equal(resolved.toAccountId, null, keys.join(','))
    assert.equal(Object.hasOwn(resolved.projection.to, 'resolvedAccountId'), false)
    assert.equal(resolved.fromAccountId, 'bank-account')
    assert.equal(value.to.resolvedAccountId, 'stale-account', '只读推导不改输入')
  }
  for (const keys of [['first'], ['first','same'], ['same','first']]) {
    const resolved = resolveSourceFunds({ ...projection, to: { ...projection.to, candidates: keys.map(reference) } }, index)
    assert.equal(resolved.toAccountId, 'account-a')
    assert.equal(resolved.projection.to.resolvedAccountId, 'account-a')
  }
})

test('旧批次规范别名低于直接决定，冲突别名不能按顺序替用户选择', () => {
  const reference = scopeReference({ sourceType: 'alipay', paymentMethodKey: 'canonical', label: '支付宝账户余额' },
    { importId: 'synthetic-alias-file', currency: 'CNY' })
  const mapping = (accountId, mappingScope) => confirmedMapping(reference, accountId, { mappingScope })
  for (const order of [[mapping('old-a','batch_alias'),mapping('old-b','batch_alias')], [mapping('old-b','batch_alias'),mapping('old-a','batch_alias')]]) {
    assert.equal(resolutionFromIndex(createMappingIndex(order), reference).kind, 'unknown')
    assert.equal(accountIdFromIndex(createMappingIndex([...order,mapping('chosen','batch')]), reference), 'chosen')
    assert.equal(accountIdFromIndex(createMappingIndex([mapping('chosen','batch'),...order]), reference), 'chosen')
  }
})
