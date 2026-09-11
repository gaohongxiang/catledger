const assert = require('node:assert/strict')
const test = require('node:test')
const { applyFields } = require('../src/review-issue-service')
const { evaluatePostability, classifyReviewIssue } = require('../src/organizer-model')
const { repaymentTargetReference } = require('../src/account-reference')
const { reconcileProjectedAccounts, createMappingIndex } = require('../src/source-funds')

const wallet = '51000000-0000-4000-8000-000000000001'
const card = '51000000-0000-4000-8000-000000000002'
function repayment() {
  return { eventId: 'synthetic-event', status: 'needs_action', economicNature: 'repayment', flowDirection: 'neutral',
    ledgerAccountId: wallet, counterpartyLedgerAccountId: null, amountMinor: '12000', currency: 'CNY',
    localAt: '2026-08-01 12:00:00.000', utcAt: '2026-08-01 04:00:00.000', manualFieldMask: 0, categoryId: null,
    reasonCodes: ['repayment_account_required'], fieldSources: { fundsProjection: { kind: 'repayment',
      from: { sourceType: 'alipay', paymentMethodKey: 'wallet', label: '支付宝账户余额' },
      to: repaymentTargetReference('alipay', '合成银行信用卡') } } }
}

test('银行还款线索不能证明目标属于本人', () => {
  const event = repayment()
  const evaluated = evaluatePostability(event, {})
  assert.ok(evaluated.reasonCodes.includes('repayment_ownership_required'))
  assert.equal(classifyReviewIssue({ ...event, reasonCodes: evaluated.reasonCodes }).issueType, 'transfer_accounts')
})

test('本人确认必须同时选择目标，决定仅写入当前事件', () => {
  const event = repayment()
  assert.throws(() => applyFields(event, { repaymentOwnership: { owner: 'self' } }))
  const next = applyFields(event, { repaymentOwnership: { owner: 'self' }, counterpartyLedgerAccountId: card })
  assert.equal(next.fieldSources.repaymentOwnership.owner, 'self')
  assert.equal(next.fieldSources.repaymentOwnership.confirmedBy, 'user')
  assert.equal(next.counterpartyLedgerAccountId, card)
  assert.equal(next.economicNature, 'repayment')
  assert.equal(evaluatePostability(next, {}).status, 'ready')
  assert.equal(event.fieldSources.repaymentOwnership, undefined)
})

test('替他人还款明确无需收回才记支出，清空目标并待分类', () => {
  const next = applyFields(repayment(), { repaymentOwnership: { owner: 'other', treatment: 'expense' } })
  assert.equal(next.counterpartyLedgerAccountId, null)
  assert.equal(next.economicNature, 'expense')
  assert.equal(next.flowDirection, 'outflow')
  assert.equal(next.ledgerAccountId, wallet)
  assert.equal(next.amountMinor, '12000')
  const evaluated = evaluatePostability(next, {})
  assert.ok(evaluated.reasonCodes.includes('category_required'))
  assert.equal(classifyReviewIssue({ ...next, ...evaluated }).issueType, 'category_assignment')
})

test('代垫或未定只保存归属，仍阻止整批入账', () => {
  const next = applyFields(repayment(), { repaymentOwnership: { owner: 'other', treatment: 'pending' } })
  const evaluated = evaluatePostability(next, {})
  assert.equal(next.economicNature, 'unknown')
  assert.equal(next.counterpartyLedgerAccountId, null)
  assert.equal(evaluated.status, 'needs_action')
  assert.ok(evaluated.reasonCodes.includes('repayment_other_treatment_required'))
  assert.equal(classifyReviewIssue({ ...next, ...evaluated }).issueType, 'transfer_accounts')
})

test('他人决定拒绝附带目标账户、伪造证明及不适用的事件', () => {
  for (const fields of [
    { repaymentOwnership: { owner: 'other', treatment: 'expense' }, counterpartyLedgerAccountId: card },
    { repaymentOwnership: { owner: 'other' } },
    { repaymentOwnership: { owner: 'self', confirmedBy: 'bank_statement' }, counterpartyLedgerAccountId: card },
    { repaymentOwnership: { owner: 'unknown' } }
  ]) assert.throws(() => applyFields(repayment(), fields))
  assert.throws(() => applyFields({ ...repayment(), fieldSources: {} }, { repaymentOwnership: { owner: 'other', treatment: 'expense' } }))
})

test('后续账户重算不能给他人还款重新绑定自己的信用卡', () => {
  const next = applyFields(repayment(), { repaymentOwnership: { owner: 'other', treatment: 'expense' } })
  next.fieldSources.fundsProjection.to.paymentMethodKey = 'bank-card'
  const index = createMappingIndex([{ sourceType: 'alipay', paymentMethodKey: 'bank-card', accountId: card, mappingAction: 'account' }])
  const result = reconcileProjectedAccounts(next, index)
  assert.equal(result.event.counterpartyLedgerAccountId, null)
  assert.equal(result.event.ledgerAccountId, wallet)
})
