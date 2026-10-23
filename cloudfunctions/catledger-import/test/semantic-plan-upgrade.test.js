const test = require('node:test')
const assert = require('node:assert/strict')
const { refreshEventSemantic } = require('../src/semantic-plan-upgrade')
const { resolveRowSemantic } = require('../src/row-semantic-resolver')
const { FIELD_MASK } = require('../src/review/policy')
const row = { sourceType: 'alipay', sourceFormat: 'alipay_app_csv', rawTransactionType: '信用借还',
  item: '免押服务使用费', direction: 'expense', rawStatus: '交易成功', amountMinor: '600', paymentMethod: '账户余额' }
const event = { eventId: 'synthetic-event', updateId: 'synthetic-update', version: 7, status: 'needs_action',
  economicNature: 'unknown', flowDirection: 'outflow', amountMinor: '600', currency: 'CNY', localAt: '2026-09-06 10:00:00',
  ledgerAccountId: 'chosen-account', counterpartyLedgerAccountId: null, categoryId: 'chosen-category',
  manualFieldMask: FIELD_MASK.ledgerAccountId | FIELD_MASK.categoryId,
  fieldSources: { semanticBlockers: ['row_transaction_type_unknown'], rowIds: ['source-row'], primaryEvidenceId: 'evidence-id',
    lastUserActionId: 'user-action', refundRelation: { confirmedBy: 'user', status: 'rejected' } },
  reasonCodes: ['row_transaction_type_unknown', 'economic_nature_required'] }

test('语义升级原位修正免押服务费并完整保留人工字段和证据', () => {
  const next = refreshEventSemantic(event, [row])
  assert.equal(next.economicNature, 'expense')
  assert.deepEqual(next.fieldSources.semanticBlockers, [])
  for (const key of ['eventId', 'version', 'updateId', 'amountMinor', 'currency', 'localAt', 'ledgerAccountId', 'categoryId', 'manualFieldMask']) assert.deepEqual(next[key], event[key])
  for (const key of ['rowIds', 'primaryEvidenceId', 'lastUserActionId', 'refundRelation']) assert.deepEqual(next.fieldSources[key], event.fieldSources[key])
  assert.ok(!next.reasonCodes.includes('economic_nature_required'))
  assert.deepEqual(event.fieldSources.semanticBlockers, ['row_transaction_type_unknown'])
})

test('排除、已入账、修正事件和人工性质都保持原决定', () => {
  for (const status of ['excluded', 'posted', 'corrected']) {
    const current = { ...event, status }
    assert.equal(refreshEventSemantic(current, [row]), current)
  }
  const manual = { ...event, economicNature: 'income', flowDirection: 'inflow', manualFieldMask: event.manualFieldMask | FIELD_MASK.economicNature | FIELD_MASK.flowDirection }
  const next = refreshEventSemantic(manual, [row])
  assert.equal(next.economicNature, 'income')
  assert.equal(next.flowDirection, 'inflow')
  assert.equal(next.categoryId, manual.categoryId)
})

test('证据生命周期或性质冲突不能静默排除或重新分组，来源结果相同不改版本', () => {
  const conflict = refreshEventSemantic(event, [row, { ...row, direction: 'income' }])
  assert.equal(conflict.economicNature, 'unknown')
  assert.ok(conflict.reasonCodes.includes('core_fields_conflict'))
  const lifecycle = refreshEventSemantic(event, [{ ...row, amountMinor: '0', direction: 'neutral', rawStatus: '解冻成功' }])
  assert.equal(lifecycle.status, 'needs_action')
  assert.ok(lifecycle.reasonCodes.includes('core_fields_conflict'))
  const fresh = { ...row, semantic: resolveRowSemantic(row) }
  const ready = refreshEventSemantic(event, [fresh])
  assert.equal(refreshEventSemantic(ready, [fresh]), ready)
})


test('未变化的未知来源保持原问题，不升级成新的字段冲突', () => {
  const unknown = { ...row, rawTransactionType: '未知资金动作', sourceFormat: 'alipay_web_csv' }
  unknown.semantic = resolveRowSemantic(unknown)
  assert.equal(refreshEventSemantic(event, [unknown]), event)
})


test('旧支付宝语义按policy升级统一账户身份，保留来源引用键和人工字段', () => {
  const { digestParts } = require('../src/digest')
  const { getRowSemantic } = require('../src/row-semantic-resolver')
  const { buildPaymentMethodKey } = require('../src/identity')
  const profile = require('../src/profiles/alipay-app')
  assert.equal(profile.normalizationVersion, 'alipay-normalization-v10', '已有证据可升级，不要求重传原文件')
  for (const method of ['花呗', '江苏银行信用购']) {
    const source = { ...row, rawTransactionType: '日用百货', item: '合成商品', paymentMethod: method,
      paymentMethodKey: digestParts('payment-method-v1', 'alipay', method) }
    source.semantic = resolveRowSemantic(source)
    source.semantic.policyVersion = 'alipay-semantic-policy-v4'
    source.semantic.ledgerAccountRef = { ...source.semantic.ledgerAccountRef,
      accountIdentityKey: 'account-identity-v2:alipay:' + method, paymentMethodKey: source.paymentMethodKey }
    const current = { ...event, economicNature: 'expense', reasonCodes: [], fieldSources: { ...event.fieldSources,
      semanticBlockers: [], ledgerAccountReference: source.semantic.ledgerAccountRef } }
    assert.notEqual(getRowSemantic(source), source.semantic)
    const next = refreshEventSemantic(current, [source])
    assert.equal(next.fieldSources.ledgerAccountReference.accountIdentityKey, 'account-identity-v2:alipay:alipay_huabei_credit')
    assert.equal(next.fieldSources.ledgerAccountReference.paymentMethodKey, source.paymentMethodKey)
    assert.notEqual(source.paymentMethodKey, buildPaymentMethodKey('alipay', method))
    for (const key of ['eventId','amountMinor','localAt','ledgerAccountId','categoryId','manualFieldMask']) assert.deepEqual(next[key], current[key])
  }
})

test('语义升级保留明确单目标和v1/v2分配，不以新聚合推断覆盖人工组成', () => {
  const source = { ...row, rawTransactionType: '信用借还', counterparty: '花呗|信用购', item: '自动还款-花呗|信用购账单',
    direction: 'neutral', rawStatus: '还款成功', paymentMethod: '测试银行储蓄卡(1234)' }
  source.semantic = { ...resolveRowSemantic(source), policyVersion: 'alipay-semantic-policy-v4' }
  const oldProjection = { from: { sourceType: 'alipay', paymentMethodKey: 'legacy-bank' },
    to: { sourceType: 'alipay', paymentMethodKey: 'legacy-credit', referenceKind: 'atomic' }, ruleVersion: 'source-funds-v8' }
  for (const mask of [FIELD_MASK.counterpartyLedgerAccountId, FIELD_MASK.repaymentAllocations, FIELD_MASK.paymentResolution]) {
    const current = { ...event, economicNature: 'repayment', flowDirection: 'neutral', counterpartyLedgerAccountId: 'chosen-credit',
      manualFieldMask: event.manualFieldMask | mask, fieldSources: { ...event.fieldSources, fundsProjection: oldProjection,
        repaymentAllocationVersion: 2, repaymentAllocations: [{ accountId: 'chosen-credit', amountMinor: '600' }] } }
    const next = refreshEventSemantic(current, [source])
    assert.equal(next.fieldSources.fundsProjection, oldProjection)
    assert.equal(next.counterpartyLedgerAccountId, 'chosen-credit')
    assert.deepEqual(next.fieldSources.repaymentAllocations, current.fieldSources.repaymentAllocations)
  }
})
