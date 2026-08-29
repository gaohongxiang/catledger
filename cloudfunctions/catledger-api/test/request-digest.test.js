const assert = require('node:assert/strict')
const test = require('node:test')

const {
  canonicalize,
  digestIdempotencyKey,
  digestRequest
} = require('../src/request-digest')

test('request digests are stable across object key order', () => {
  assert.deepEqual(canonicalize({ z: 1, a: { y: 2, x: 3 } }), {
    a: { x: 3, y: 2 },
    z: 1
  })
  assert.equal(
    digestRequest('accounts.create', { b: 2, a: 1 }),
    digestRequest('accounts.create', { a: 1, b: 2 })
  )
})

test('idempotency keys require UUIDs and are stored only as digests', () => {
  const digest = digestIdempotencyKey('2f0b49ca-4081-4f88-8770-11b90e8d9876')
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.doesNotMatch(digest, /2f0b49ca/)
  assert.throws(
    () => digestIdempotencyKey('not-a-uuid'),
    { publicCode: 'VALIDATION_ERROR' }
  )
})
