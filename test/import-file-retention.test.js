const test = require('node:test')
const assert = require('node:assert/strict')
const { RETENTION_DAYS, isExpired } = require('../cloudfunctions/catledger-import/src/import-file-retention')

test('原件保留期按状态分级，边界当天即到期', () => {
  const now = Date.parse('2026-10-19T00:00:00Z')
  for (const [state, days] of Object.entries(RETENTION_DAYS)) {
    const boundary = now - days * 24 * 60 * 60 * 1000
    assert.equal(isExpired(state, boundary, now), true, state + ' boundary')
    assert.equal(isExpired(state, boundary + 1, now), false, state + ' inside')
    assert.equal(isExpired(state, boundary - 1, now), true, state + ' outside')
  }
  assert.equal(isExpired('unknown', now, now), false)
  assert.equal(isExpired('failed', 'not-a-date', now), false)
})
