const assert = require('node:assert/strict')
const test = require('node:test')

const { parseLocalDate, parseLocalDateTime, parseMonth } = require('../src/local-time')

test('local transaction time converts with JavaScript timezone offset semantics', () => {
  assert.deepEqual(parseLocalDateTime('2026-08-29T12:34:56.7', -480), {
    localDate: '2026-08-29',
    localAt: '2026-08-29 12:34:56.700',
    occurredAtUtc: '2026-08-29 04:34:56.700',
    timezoneOffsetMinutes: -480
  })
})

test('local time rejects impossible dates and invalid offsets', () => {
  assert.throws(
    () => parseLocalDateTime('2026-02-30T12:00', -480),
    { publicCode: 'VALIDATION_ERROR' }
  )
  assert.throws(
    () => parseLocalDateTime('2026-08-29T12:00', 841),
    { publicCode: 'VALIDATION_ERROR' }
  )
})

test('month ranges use local calendar boundaries including year rollover', () => {
  assert.deepEqual(parseMonth('2026-08'), {
    startDate: '2026-08-01',
    endDate: '2026-09-01'
  })
  assert.deepEqual(parseMonth('2026-12'), {
    startDate: '2026-12-01',
    endDate: '2027-01-01'
  })
  assert.throws(() => parseMonth('2026-13'), { publicCode: 'VALIDATION_ERROR' })
})

test('specific-date ranges use the local calendar and reject impossible dates', () => {
  assert.deepEqual(parseLocalDate('2026-08-29'), {
    startDate: '2026-08-29',
    endDate: '2026-08-30'
  })
  assert.deepEqual(parseLocalDate('2026-12-31'), {
    startDate: '2026-12-31',
    endDate: '2027-01-01'
  })
  assert.throws(() => parseLocalDate('2026-02-30'), { publicCode: 'VALIDATION_ERROR' })
})
