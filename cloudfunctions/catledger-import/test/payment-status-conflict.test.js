const test = require('node:test')
const assert = require('node:assert/strict')
const { plan } = require('../../../test/helpers/payment-status')
const { evaluatePostability, REFUND_RELATION_STATE_VERSION } = require('../src/organizer-model')
const { resolveRowSemantic } = require('../src/row-semantic-resolver')

test('合成反例：同来源订单的关闭原消费与到账退款必须核对，不能暂记待关联绕过', async () => {
  for (const options of [{}, { refundAmount: '5.00' }, { refundAccount: '余额宝' }, { status: '支付失败' }]) {
    const result = await plan(options)
    const original = result.events.find(event => event.economicNature === 'expense')
    const refund = result.events.find(event => event.economicNature === 'refund')
    assert.equal(original.status, 'excluded')
    assert.ok(refund.reasonCodes.includes('refund_source_conflict'))
    assert.equal(result.issues.find(issue => issue.issueType === 'refund_relation').primaryReasonCode, 'refund_source_conflict')
    assert.equal(evaluatePostability({ ...refund, reasonCodes: [], fieldSources: { ...refund.fieldSources,
      refundRelation: { version: REFUND_RELATION_STATE_VERSION, status: 'pending', confirmedBy: 'user' }
    } }).status, 'needs_action')
  }
})

test('未支付关闭仍不入账；无可靠同订单依据的普通退款仍允许待关联', async () => {
  assert.equal((await plan({ refund: false })).events[0].status, 'excluded')
  for (const change of [{ sameOrder: false }]) {
    const result = await plan(change)
    const refund = result.events.find(event => event.economicNature === 'refund')
    assert.ok(!refund.reasonCodes.includes('refund_source_conflict'))
    assert.equal(evaluatePostability({ ...refund, reasonCodes: [], fieldSources: { ...refund.fieldSources,
      refundRelation: { version: REFUND_RELATION_STATE_VERSION, status: 'pending', confirmedBy: 'user' }
    } }).status, 'ready')
  }
})

test('相同商户编号、脱敏编号或不同来源主体不足以建立关闭退款冲突', async () => {
  for (const changes of [
    () => ({ sourceOrderId: '', sourceMerchantOrderId: 'SYNTH-MERCHANT-ORDER' }),
    () => ({ sourceOrderId: 'SYNTH-XXXX-ORDER' }),
    index => ({ sourceProfileId: 'synthetic-source-' + index })
  ]) {
    const result = await plan({}, changes)
    assert.ok(!result.events.find(event => event.economicNature === 'refund').reasonCodes.includes('refund_source_conflict'))
  }
})

test('成功原消费与退款保留跨月日期、原金额和各自账户；已入账原消费只复用', async () => {
  for (const options of [{ status: '交易成功' }, { status: '交易成功', refundAmount: '5.00' }, { status: '交易成功', refundAccount: '余额宝' }]) {
    const result = await plan(options)
    assert.equal(result.events.find(event => event.economicNature === 'expense').localDate, '2026-01-31')
    assert.equal(result.events.find(event => event.economicNature === 'refund').localDate, '2026-02-02')
    assert.equal(result.relations[0].status, 'confirmed')
    if (options.refundAccount) assert.notEqual(result.events[0].ledgerAccountId, result.events[1].ledgerAccountId)
  }
  const result = await plan({ status: '交易成功' }, index => index === 0 ? { existingTransactionId: 'synthetic-history' } : {})
  const original = result.events.find(event => event.economicNature === 'expense')
  assert.equal(original.status, 'excluded')
  assert.deepEqual(original.existingTransactionIds, ['synthetic-history'])
  assert.equal(result.relations[0].status, 'confirmed')
  assert.ok(!result.events.find(event => event.economicNature === 'refund').reasonCodes.includes('refund_source_conflict'))
})

test('待真实模板验证的微信状态不因为名称类似成功就获得到账语义', () => {
  for (const [rawTransactionType, direction, rawStatus] of [
    ['零钱充值', 'neutral', '充值完成'], ['商户消费', 'expense', '已全额退款'],
    ['转账', 'expense', '对方已收钱'], ['退款', 'income', '已全额退款']
  ]) {
    const result = resolveRowSemantic({ sourceType: 'wechat', sourceFormat: 'wechat_csv', rawTransactionType,
      direction, rawStatus, paymentMethod: '零钱', amountMinor: '2000' })
    assert.equal(result.moneyEffect, 'unknown')
    assert.ok(result.issues.some(issue => issue.code === 'row_status_unknown'))
  }
})
