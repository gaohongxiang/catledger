const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildManualTransaction,
  createTransactionService,
  monthSequence,
  normalizeListFilters
} = require('../src/transaction-service')

test('transaction service stays a thin compatible facade', () => {
  const service = createTransactionService({ getPool: function unusedPool() {} })
  assert.deepEqual(Object.keys(service).sort(), [
    'create',
    'dashboard',
    'list',
    'refundable',
    'remove',
    'statistics',
    'update'
  ])
  assert.equal(Object.values(service).every((handler) => typeof handler === 'function'), true)
})

test('refund requires an original expense and credits one account', () => {
  const transaction = buildManualTransaction({
    type: 'refund',
    destinationAccountId: 'account-1',
    originalTransactionId: 'expense-1',
    amountMinor: '120',
    occurredLocalAt: '2026-08-30T10:00:00',
    timezoneOffsetMinutes: -480
  })
  assert.equal(transaction.type, 'refund')
  assert.equal(transaction.destinationAccountId, 'account-1')
  assert.equal(transaction.originalTransactionId, 'expense-1')
  assert.equal(transaction.categoryId, null)
})

test('dashboard month trend covers the trailing six months across a year boundary', () => {
  assert.deepEqual(monthSequence('2026-02'), [
    '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'
  ])
})

test('transaction filters use a selected local date inside the requested month', () => {
  const filters = normalizeListFilters({ month: '2026-08', date: '2026-08-29' })
  assert.equal(filters.month, '2026-08')
  assert.equal(filters.date, '2026-08-29')
  assert.deepEqual(filters.range, {
    startDate: '2026-08-29',
    endDate: '2026-08-30'
  })
})

test('transaction filters reject a date outside the requested month', () => {
  assert.throws(
    () => normalizeListFilters({ month: '2026-08', date: '2026-07-31' }),
    { publicCode: 'VALIDATION_ERROR' }
  )
  assert.throws(
    () => normalizeListFilters({ month: '2026-02', date: '2026-02-30' }),
    { publicCode: 'VALIDATION_ERROR' }
  )
})
