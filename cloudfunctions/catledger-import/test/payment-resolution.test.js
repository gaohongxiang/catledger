const test = require('node:test')
const assert = require('node:assert/strict')
const { inspectPaymentResolution, paymentResolutionForEvent } = require('../src/payment-resolution')
const { applyFields } = require('../src/review-issue-service')
const { evaluatePostability } = require('../src/organizer-model')
const { transactionDrafts } = require('../src/finance-update-posting')
const { correctionImpactResult } = require('../src/maintenance-state')
const { reachableAccountIds } = require('../src/account-draft')
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222', c = '33333333-3333-4333-8333-333333333333'
function fixture() {
  return { eventId: 'event', status: 'needs_action', amountMinor: '1000', currency: 'CNY', localAt: '2026-09-01 12:00:00', utcAt: '2026-09-01 04:00:00',
    economicNature: 'unknown', flowDirection: 'outflow', ledgerAccountId: null, categoryId: c,
    reasonCodes: ['payment_components_ambiguous', 'row_transaction_type_unknown'],
    fieldSources: { paymentSourceDirection: 'expense', semanticBlockers: ['payment_components_ambiguous', 'row_transaction_type_unknown'], paymentComponents: [
      { componentKind: 'financial', label: '测试银行卡' }, { componentKind: 'financial', label: '测试余额' }
    ] } }
}
function resolution(nature = 'expense') { return { version: 'payment-resolution-v1', nature, confirmedFromDetails: true, evidenceNote: '已核对合成支付详情',
  targetAccountId: nature === 'repayment' ? c : null, allocations: [{ componentIndex: 0, accountId: a, amountMinor: '600' }, { componentIndex: 1, accountId: b, amountMinor: '400' }] } }

test('人工分项解除指定歧义、保留原始语义、两项支出守恒且全部账户可达', () => {
  const original = fixture(), next = applyFields(original, { paymentResolution: resolution() })
  assert.equal(evaluatePostability(next).status, 'ready')
  assert.equal(original.economicNature, 'unknown')
  assert.deepEqual(next.fieldSources.semanticBlockers, original.fieldSources.semanticBlockers)
  const drafts = transactionDrafts(next)
  assert.equal(drafts.length, 2)
  assert.deepEqual(drafts.map(x => x.sourceAccountId), [a, b])
  assert.equal(drafts.reduce((sum, x) => sum + BigInt(x.amountMinor), 0n), 1000n)
  assert.ok(drafts.every(x => x.type === 'expense' && x.role === 'payment_allocation'))
  assert.deepEqual([...reachableAccountIds([next])].sort(), [a, b].sort())
})
test('还款分项生成两个转账而非支出，不允许转给自己的资金来源', () => {
  const next = applyFields(fixture(), { paymentResolution: resolution('repayment') })
  assert.equal(next.categoryId, null)
  assert.equal(evaluatePostability(next).status, 'ready')
  assert.ok(transactionDrafts(next).every(x => x.type === 'transfer' && x.destinationAccountId === c))
  const invalid = resolution('repayment'); invalid.targetAccountId = a
  assert.equal(inspectPaymentResolution(fixture(), invalid).valid, false)
})
test('拒绝漏项重复金额不守恒、零负数、浮点、重复账户及缺少核对说明', () => {
  const edits = [r => r.allocations.pop(), r => r.allocations[1].componentIndex = 0, r => r.allocations[1].amountMinor = '401',
    r => r.allocations[1].amountMinor = '0', r => r.allocations[1].amountMinor = '-1', r => r.allocations[1].amountMinor = 400,
    r => r.allocations[1].accountId = a, r => r.evidenceNote = ' ', r => r.confirmedFromDetails = false]
  for (const edit of edits) { const r = resolution(); edit(r); assert.equal(inspectPaymentResolution(fixture(), r).valid, false) }
  assert.throws(() => applyFields(fixture(), { paymentResolution: resolution(), amountMinor: '1000' }))
})
test('不能掩盖未知状态、来源冲突；不能把入款或未知成分当出款拆分', () => {
  for (const blocker of ['row_status_unknown', 'row_semantic_conflict', 'identity_conflict']) {
    const event = fixture(); event.reasonCodes.push(blocker)
    assert.equal(evaluatePostability(applyFields(event, { paymentResolution: resolution() })).status, 'needs_action')
  }
  const incoming = fixture(); incoming.fieldSources.paymentSourceDirection = 'income'
  assert.equal(inspectPaymentResolution(incoming, resolution()).valid, false)
  const unknown = fixture(); unknown.fieldSources.paymentComponents.push({ componentKind: 'unknown', label: '未知' })
  assert.equal(inspectPaymentResolution(unknown, resolution()).valid, false)
})
test('保存后改总额或资金端不能复用旧确认；多分项局部更正被阻止', () => {
  const next = applyFields(fixture(), { paymentResolution: resolution() })
  assert.equal(paymentResolutionForEvent({ ...next, amountMinor: '1001' }).valid, false)
  assert.throws(() => transactionDrafts({ ...next, ledgerAccountId: c }))
  const posted = { ...next, status: 'posted' }
  const rows = [a, b].map(id => ({ transactionId: id, creationMethod: 'created', role: 'payment_allocation', version: 1, linkedVersion: 1 }))
  assert.equal(correctionImpactResult(posted, rows).canCorrect, false)
  assert.ok(correctionImpactResult(posted, rows).conflicts.includes('WHOLE_UPDATE_UNDO_REQUIRED'))
})


test('账户归属独立保存后转入整理，不能解除金额阻断或生成正式交易', () => {
  const next = applyFields(fixture(), { paymentAccounts: [{ componentIndex: 0, accountId: a }, { componentIndex: 1, accountId: b }] })
  const evaluated = evaluatePostability(next)
  assert.equal(evaluated.status, 'needs_action')
  assert.ok(evaluated.reasonCodes.includes('payment_components_ambiguous'))
  const { classifyReviewIssue } = require('../src/organizer-model')
  assert.equal(classifyReviewIssue({ ...next, reasonCodes: evaluated.reasonCodes }).issueType, 'shared_fields')
  assert.equal(next.ledgerAccountId, null)
  assert.equal(next.fieldSources.paymentResolution, undefined)
  assert.deepEqual([...reachableAccountIds([next])].sort(), [a, b])
  assert.throws(() => applyFields(fixture(), { paymentAccounts: [{ componentIndex: 0, accountId: a }, { componentIndex: 1, accountId: a }] }))
})


test('v2 全部支付保留零分项证据，只生成正数交易并以实际付款项为主账户', () => {
  for (const nature of ['expense', 'repayment']) for (const activeIndex of [0, 1]) {
    const value = resolution(nature); value.version = 'payment-resolution-v2'
    value.allocations.forEach((item, index) => { item.amountMinor = index === activeIndex ? '1000' : '0' })
    const next = applyFields(fixture(), { paymentResolution: value })
    const plan = paymentResolutionForEvent(next)
    assert.equal(plan.valid, true)
    assert.equal(plan.allocations.length, 1)
    assert.equal(plan.resolution.allocations.length, 2)
    assert.equal(next.ledgerAccountId, [a, b][activeIndex])
    assert.equal(evaluatePostability(next).status, 'ready')
    const drafts = transactionDrafts(next)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].amountMinor, '1000')
    assert.equal(drafts[0].sourceAccountId, [a, b][activeIndex])
    assert.equal(correctionImpactResult({ ...next, status: 'posted' }, [{ role: 'payment_allocation', creationMethod: 'created', version: 1, linkedVersion: 1 }]).canCorrect, false)
    assert.equal(drafts[0].type, nature === 'expense' ? 'expense' : 'transfer')
    assert.deepEqual([...reachableAccountIds([next])].sort(), (nature === 'expense' ? [a, b] : [a, b, c]).sort())
  }
})
test('v2 零分项仍要求完整账户与索引，非法金额和总额继续拒绝', () => {
  for (const mutate of [r => r.allocations.pop(), r => r.allocations[0].accountId = '', r => r.allocations[0].accountId = b,
    r => r.allocations[0].amountMinor = '', r => r.allocations[0].amountMinor = '-1', r => r.allocations[0].amountMinor = '00',
    r => r.allocations[1].amountMinor = '0', r => r.version = 'payment-resolution-v3']) {
    const value = resolution(); value.version = 'payment-resolution-v2'; value.allocations[0].amountMinor = '0'; value.allocations[1].amountMinor = '1000'
    mutate(value); assert.equal(inspectPaymentResolution(fixture(), value).valid, false)
  }
})
