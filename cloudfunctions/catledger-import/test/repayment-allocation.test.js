const assert = require('node:assert/strict')
const test = require('node:test')

const {
  inspectRepaymentAllocations,
  repaymentAllocationsForEvent
} = require('../src/repayment-allocation')
const { transactionDrafts } = require('../src/finance-update-posting')
const { applyFields, FIELD_MASK } = require('../src/review-issue-service')

const A = '51000000-0000-4000-8000-000000000201'
const B = '51000000-0000-4000-8000-000000000202'
const C = '51000000-0000-4000-8000-000000000203'

test('聚合还款分配必须为正数、账户唯一且金额守恒', () => {
  const valid = inspectRepaymentAllocations([
    { accountId: A, amountMinor: '6000' },
    { accountId: B, amountMinor: '4000' }
  ], '10000')
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.allocations, [
    { accountId: A, amountMinor: '6000' },
    { accountId: B, amountMinor: '4000' }
  ])

  assert.equal(inspectRepaymentAllocations([], '10000').reason, 'repayment_allocation_required')
  assert.equal(inspectRepaymentAllocations([{ accountId: A, amountMinor: '9999' }], '10000').reason, 'repayment_allocation_amount_mismatch')
  assert.equal(inspectRepaymentAllocations([
    { accountId: A, amountMinor: '5000' }, { accountId: A, amountMinor: '5000' }
  ], '10000').reason, 'repayment_allocation_account_duplicate')
})

test('事件只从受版本控制的 fieldSources 读取还款分配', () => {
  const result = repaymentAllocationsForEvent({
    economicNature: 'repayment',
    amountMinor: '10000',
    fieldSources: {
      fundsProjection: { to: { referenceKind: 'aggregate', candidates: [{ accountId: A }] } },
      repaymentAllocationVersion: 'repayment-allocation-v1',
      repaymentAllocations: [{ accountId: A, amountMinor: '10000' }]
    }
  })
  assert.equal(result.valid, true)
  assert.deepEqual(result.allocations, [{ accountId: A, amountMinor: '10000' }])
})

test('聚合还款拒绝分配到事件候选集之外的负债账户', () => {
  const result = repaymentAllocationsForEvent({
    economicNature: 'repayment',
    amountMinor: '10000',
    fieldSources: {
      fundsProjection: {
        to: {
          referenceKind: 'aggregate',
          candidates: [{ accountId: A }, { accountId: B }]
        }
      },
      repaymentAllocationVersion: 'repayment-allocation-v1',
      repaymentAllocations: [{ accountId: C, amountMinor: '10000' }]
    }
  })
  assert.equal(result.valid, false)
  assert.equal(result.reason, 'repayment_allocation_target_not_allowed')
})

test('一个聚合还款事件投影为多笔守恒的正式转账', () => {
  const drafts = transactionDrafts({
    economicNature: 'repayment', sourceDirection: 'neutral',
    ledgerAccountId: '51000000-0000-4000-8000-000000000299', amountMinor: '10000',
    fieldSources: {
      fundsProjection: { to: { referenceKind: 'aggregate', candidates: [{ accountId: A }, { accountId: B }] } },
      repaymentAllocationVersion: 'repayment-allocation-v1',
      repaymentAllocations: [
        { accountId: A, amountMinor: '6000' },
        { accountId: B, amountMinor: '4000' }
      ]
    }
  }, null)
  assert.deepEqual(drafts, [
    {
      type: 'transfer', sourceAccountId: '51000000-0000-4000-8000-000000000299',
      destinationAccountId: A, categoryId: null, originalTransactionId: null,
      amountMinor: '6000', role: 'repayment_allocation'
    },
    {
      type: 'transfer', sourceAccountId: '51000000-0000-4000-8000-000000000299',
      destinationAccountId: B, categoryId: null, originalTransactionId: null,
      amountMinor: '4000', role: 'repayment_allocation'
    }
  ])
})

test('ReviewIssue 只把合法分配写入事件来源快照并留下手工字段位', () => {
  const event = {
    economicNature: 'repayment', amountMinor: '10000', manualFieldMask: 0,
    counterpartyLedgerAccountId: '51000000-0000-4000-8000-000000000298',
    fieldSources: { fundsProjection: { to: { referenceKind: 'aggregate' } } }
  }
  const result = applyFields(event, {
    repaymentAllocations: [
      { accountId: A, amountMinor: '6000' },
      { accountId: B, amountMinor: '4000' }
    ]
  })
  assert.equal(result.counterpartyLedgerAccountId, null)
  assert.equal(result.fieldSources.repaymentAllocationVersion, 'repayment-allocation-v1')
  assert.equal(Boolean(result.manualFieldMask & FIELD_MASK.repaymentAllocations), true)
  assert.throws(() => applyFields(event, {
    repaymentAllocations: [{ accountId: A, amountMinor: '9999' }]
  }), { publicCode: 'VALIDATION_ERROR' })
})
