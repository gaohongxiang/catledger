const assert = require('node:assert/strict')
const test = require('node:test')

const {
  MONEY_EFFECT,
  RESOLUTION_STATUS,
  SOURCE_ACTION,
  mergeRuleOutputs,
  resolveRowSemantic
} = require('../src/row-semantic-resolver')

function row(overrides = {}) {
  return {
    sourceType: 'wechat',
    sourceFormat: 'wechat_csv',
    rawTransactionType: '转账',
    transactionType: '转账',
    direction: 'income',
    rawDirection: '收入',
    rawStatus: '已存入零钱',
    status: '已存入零钱',
    paymentMethod: '/',
    amountMinor: '300000',
    item: '',
    counterparty: '',
    ...overrides
  }
}

test('微信转账收入只有完整组合才推导到账微信零钱', () => {
  const semantic = resolveRowSemantic(row())
  assert.equal(semantic.resolutionStatus, RESOLUTION_STATUS.RESOLVED)
  assert.equal(semantic.moneyEffect, MONEY_EFFECT.FINANCIAL)
  assert.equal(semantic.sourceAction, SOURCE_ACTION.TRANSFER_RECEIVED)
  assert.equal(semantic.fromAccountRef, null)
  assert.equal(semantic.toAccountRef.value, '零钱')
  assert.ok(semantic.ruleIds.includes('wechat.transfer.received-to-balance.v1'))

  for (const candidate of [
    { direction: 'expense', rawDirection: '支出' },
    { rawStatus: '支付成功', status: '支付成功' },
    { rawTransactionType: '商户消费', transactionType: '商户消费' },
    { amountMinor: '0' }
  ]) {
    const nearMiss = resolveRowSemantic(row(candidate))
    assert.equal(Boolean(nearMiss.toAccountRef && nearMiss.toAccountRef.inferenceRule === 'wechat_income_deposited_to_change'), false)
  }

  const accountUnknown = resolveRowSemantic(row({ rawStatus: '支付成功', status: '支付成功' }))
  assert.equal(accountUnknown.resolutionStatus, RESOLUTION_STATUS.UNKNOWN)
  assert.ok(accountUnknown.issues.some((issue) => issue.code === 'account_endpoint_unknown'))
})

test('未知交易类型和未知状态都不能由方向或成功字样兜底', () => {
  for (const type of ['全新业务类型', '全新支付服务']) {
    const unknownType = resolveRowSemantic(row({
      rawTransactionType: type, transactionType: type,
      rawStatus: '支付成功', status: '支付成功', paymentMethod: '零钱'
    }))
    assert.equal(unknownType.resolutionStatus, RESOLUTION_STATUS.UNKNOWN)
    assert.equal(unknownType.sourceAction, null)
  }

  const unknownStatus = resolveRowSemantic(row({
    rawTransactionType: '商户消费', transactionType: '商户消费',
    rawStatus: '处理成功但未登记', status: '处理成功但未登记', paymentMethod: '零钱'
  }))
  assert.equal(unknownStatus.resolutionStatus, RESOLUTION_STATUS.UNKNOWN)
  assert.equal(unknownStatus.moneyEffect, MONEY_EFFECT.UNKNOWN)
})

test('微信明确商户退款类型识别为独立退款到账', () => {
  const semantic = resolveRowSemantic(row({
    rawTransactionType: '商户退款', transactionType: '商户退款',
    direction: 'income', rawDirection: '收入',
    rawStatus: '退款成功', status: '退款成功', paymentMethod: '微信零钱', amountMinor: '466'
  }))
  assert.equal(semantic.resolutionStatus, RESOLUTION_STATUS.RESOLVED)
  assert.equal(semantic.sourceAction, SOURCE_ACTION.REFUND_CREDIT)
  assert.equal(semantic.legacy.economicEffect, 'refund')
})

test('支付宝零金额生命周期在账户阶段前终止', () => {
  for (const status of ['芝麻免押下单成功', '解冻成功']) {
    const semantic = resolveRowSemantic(row({
      sourceType: 'alipay',
      sourceFormat: 'alipay_app_csv',
      rawTransactionType: '信用借还',
      transactionType: '信用借还',
      direction: 'neutral',
      rawDirection: '不计收支',
      rawStatus: status,
      status,
      paymentMethod: '/',
      amountMinor: '0'
    }))
    assert.equal(semantic.resolutionStatus, RESOLUTION_STATUS.RESOLVED)
    assert.equal(semantic.moneyEffect, MONEY_EFFECT.NON_FINANCIAL)
    assert.equal(semantic.sourceAction, null)
    assert.equal(semantic.fromAccountRef, null)
    assert.equal(semantic.toAccountRef, null)
  }

  const nearMiss = resolveRowSemantic(row({
    sourceType: 'alipay', sourceFormat: 'alipay_app_csv',
    rawTransactionType: '信用借还', transactionType: '信用借还',
    direction: 'neutral', rawDirection: '不计收支',
    rawStatus: '解冻成功', status: '解冻成功', amountMinor: '1'
  }))
  assert.notEqual(nearMiss.moneyEffect, MONEY_EFFECT.NON_FINANCIAL)
})

test('组合支付不会默认选择第一个资金账户', () => {
  const oneAccount = resolveRowSemantic(row({
    sourceType: 'alipay', sourceFormat: 'alipay_app_csv',
    rawTransactionType: '餐饮美食', transactionType: '餐饮美食',
    direction: 'expense', rawDirection: '支出',
    rawStatus: '交易成功', status: '交易成功', amountMinor: '1000',
    paymentMethod: '招商银行储蓄卡(1234)&红包'
  }))
  assert.equal(oneAccount.fromAccountRef.value, '招商银行储蓄卡(1234)')
  assert.equal(oneAccount.paymentComponents.length, 2)

  const ambiguous = resolveRowSemantic(row({
    sourceType: 'alipay', sourceFormat: 'alipay_app_csv',
    rawTransactionType: '餐饮美食', transactionType: '餐饮美食',
    direction: 'expense', rawDirection: '支出',
    rawStatus: '交易成功', status: '交易成功', amountMinor: '1000',
    paymentMethod: '余额宝&招商银行储蓄卡(1234)'
  }))
  assert.equal(ambiguous.resolutionStatus, RESOLUTION_STATUS.UNKNOWN)
  assert.equal(ambiguous.fromAccountRef, null)
  assert.ok(ambiguous.issues.some((issue) => issue.code === 'payment_components_ambiguous'))
})

test('充值提现和还款的双端账户由整行语义入口一次给出', () => {
  const withdrawal = resolveRowSemantic(row({
    rawTransactionType: '零钱提现', transactionType: '零钱提现',
    direction: 'neutral', rawDirection: '/',
    rawStatus: '提现已到账', status: '提现已到账',
    paymentMethod: '浙江农商银行储蓄卡(5564)',
    counterparty: '浙江农商银行储蓄卡(5564)', amountMinor: '2552530'
  }))
  assert.equal(withdrawal.sourceAction, SOURCE_ACTION.WITHDRAWAL)
  assert.equal(withdrawal.fundsProjection.kind, 'withdrawal')
  assert.equal(withdrawal.fundsProjection.from.label, '微信零钱')
  assert.match(withdrawal.fundsProjection.to.label, /5564/u)

  const repayment = resolveRowSemantic(row({
    rawTransactionType: '信用卡还款', transactionType: '信用卡还款',
    direction: 'neutral', rawDirection: '/', rawStatus: '还款成功', status: '还款成功',
    paymentMethod: '零钱', counterparty: '交通银行信用卡还款(1234)', amountMinor: '124653'
  }))
  assert.equal(repayment.sourceAction, SOURCE_ACTION.REPAYMENT)
  assert.equal(repayment.fundsProjection.kind, 'repayment')
  assert.equal(repayment.fundsProjection.from.label, '微信零钱')
  assert.match(repayment.fundsProjection.to.label, /1234/u)
})

test('规则合并同值保留来源，异值明确冲突且不依赖顺序', () => {
  const same = mergeRuleOutputs([
    { ruleId: 'a', value: '零钱' },
    { ruleId: 'b', value: '零钱' }
  ])
  assert.deepEqual(same, { status: 'resolved', value: '零钱', ruleIds: ['a', 'b'] })

  const conflict = mergeRuleOutputs([
    { ruleId: 'a', value: '零钱' },
    { ruleId: 'b', value: '银行卡' }
  ])
  const reversed = mergeRuleOutputs([
    { ruleId: 'b', value: '银行卡' },
    { ruleId: 'a', value: '零钱' }
  ])
  assert.equal(conflict.status, 'conflict')
  assert.deepEqual(conflict, reversed)
})
