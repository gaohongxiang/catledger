const test = require('node:test')
const assert = require('node:assert/strict')
const { eventAllocation, allocationAccountsValid } = require('../src/funds-allocation')
const { transactionDrafts } = require('../src/finance-update-posting')
const { applyFields } = require('../src/review-issue-service')
const { evaluatePostability } = require('../src/organizer-model')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function aggregate() {
  return { status: 'needs_action', economicNature: 'repayment', flowDirection: 'neutral', amountMinor: '1000',
    localAt: '2026-01-01 12:00:00', utcAt: '2026-01-01 04:00:00', currency: 'CNY', ledgerAccountId: A,
    fieldSources: { fundsProjection: { to: { referenceKind: 'aggregate', candidates: [] } },
      repaymentAllocationVersion: 'repayment-allocation-v2',
      repaymentAllocations: [{ accountId: B, amountMinor: '600' }, { accountId: C, amountMinor: '400' }] } }
}

test('统一分配校验在无候选时接受真实账户；目标资格独立于推荐', () => {
  const event = aggregate(), plan = eventAllocation(event)
  assert.equal(plan.valid, true)
  assert.equal(evaluatePostability(event).status, 'ready')
  const accounts = new Map([A, B, C].map(id => [id, { currency: 'CNY', type: id === A ? 'bank' : 'credit' }]))
  assert.equal(allocationAccountsValid(event, plan, accounts), true)
  for (const change of [{ type: 'wallet' }, { currency: 'USD' }, { archivedAt: '2026-01-01' }]) {
    const copy = new Map(accounts); copy.set(B, { ...copy.get(B), ...change })
    assert.equal(allocationAccountsValid(event, plan, copy), false)
  }
  accounts.delete(C)
  assert.equal(allocationAccountsValid(event, plan, accounts), false)
  const self = aggregate(); self.fieldSources.repaymentAllocations[0].accountId = A
  assert.equal(allocationAccountsValid(self, eventAllocation(self), accounts), false)
})

test('两套单独有效的分配决定不得由分支顺序选择其中一套', () => {
  const payment = applyFields({ ...aggregate(), economicNature: 'unknown', fieldSources: {
    paymentSourceDirection: 'expense', semanticBlockers: ['payment_components_ambiguous'],
    paymentComponents: [{ componentKind: 'financial' }, { componentKind: 'financial' }]
  } }, { paymentResolution: { version: 'payment-resolution-v1', nature: 'repayment', confirmedFromDetails: true,
    evidenceNote: '合成详情', targetAccountId: C,
    allocations: [{ componentIndex: 0, accountId: A, amountMinor: '600' }, { componentIndex: 1, accountId: B, amountMinor: '400' }] } })
  assert.equal(eventAllocation(payment).valid, true)
  assert.equal(transactionDrafts(payment).length, 2)
  payment.fieldSources = { ...payment.fieldSources, ...aggregate().fieldSources }
  assert.equal(eventAllocation(payment).reason, 'funds_allocation_conflict')
  assert.equal(evaluatePostability(payment).status, 'needs_action')
  assert.throws(() => transactionDrafts(payment), { publicCode: 'UNRESOLVED_IMPORT' })
})

test('还款决定不能通过改性质退化为普通交易或额外支出', () => {
  const event = aggregate(); event.economicNature = 'expense'; event.categoryId = B; event.flowDirection = 'outflow'
  assert.equal(eventAllocation(event).reason, 'funds_allocation_conflict')
  assert.throws(() => transactionDrafts(event), { publicCode: 'UNRESOLVED_IMPORT' })
})
