const assert = require('node:assert/strict')
const test = require('node:test')

const { decodeCursor, encodeCursor } = require('../src/cursor')

test('transaction cursors round-trip only for the same trusted user secret', () => {
  const cursor = encodeCursor('trusted-subject-one', {
    filterDigest: 'digest',
    occurredLocalAt: '2026-08-29 12:00:00.000',
    transactionId: 'transaction-1'
  })
  assert.deepEqual(decodeCursor('trusted-subject-one', cursor), {
    filterDigest: 'digest',
    occurredLocalAt: '2026-08-29 12:00:00.000',
    transactionId: 'transaction-1'
  })
  assert.throws(() => decodeCursor('trusted-subject-two', cursor), {
    publicCode: 'VALIDATION_ERROR'
  })
  assert.throws(() => decodeCursor('trusted-subject-one', `${cursor}x`), {
    publicCode: 'VALIDATION_ERROR'
  })
})
