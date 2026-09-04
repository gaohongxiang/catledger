const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildManualTransaction,
  createTransactionService,
  monthSequence,
  normalizeListFilters,
  transactionToPublic
} = require('../src/transaction-service')

test('transaction service stays a thin compatible facade', () => {
  const service = createTransactionService({ getPool: function unusedPool() {} })
  assert.deepEqual(Object.keys(service).sort(), [
    'create',
    'dashboard',
    'linkRefund',
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

test('交易投影明确区分已关联和待关联退款', () => {
  const base = {
    transactionId: 'refund-1', type: 'refund', sourceAccountId: null,
    destinationAccountId: 'account-1', destinationAccountName: '支付宝账户余额',
    categoryId: null, amountMinor: '466', occurredLocalAt: '2026-07-04 15:02:00.000',
    timezoneOffsetMinutes: -480, note: '退款', version: 1
  }
  assert.equal(transactionToPublic({ ...base, originalTransactionId: null }).refundLinkStatus, 'pending')
  assert.equal(transactionToPublic({
    ...base, originalTransactionId: 'expense-1', originalAmountMinor: '466',
    originalOccurredLocalAt: '2026-07-04 11:37:00.000', originalNote: '原消费'
  }).refundLinkStatus, 'linked')
  assert.equal(transactionToPublic({ ...base, type: 'income', originalTransactionId: null }).refundLinkStatus, null)
})

test('所有收支统计只让已关联退款冲减支出', () => {
  const querySource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/transaction-query-service.js'), 'utf8')
  const reportingSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/reporting-service.js'), 'utf8')
  assert.match(querySource, /type = 'refund' AND original_transaction_id IS NOT NULL/)
  assert.ok((reportingSource.match(/(?:t\.)?type = 'refund' AND (?:t\.)?original_transaction_id IS NOT NULL/g) || []).length >= 3)
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
