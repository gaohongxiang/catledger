const assert = require('node:assert/strict')
const test = require('node:test')

const { monthSequence, normalizeListFilters } = require('../src/transaction-service')

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
