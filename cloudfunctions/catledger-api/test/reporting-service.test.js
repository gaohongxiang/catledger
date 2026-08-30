const assert = require('node:assert/strict')
const test = require('node:test')

const { createReportingService } = require('../src/reporting-service')

function createReportingHarness() {
  const calls = []
  const connection = {
    async query(sql) {
      calls.push(sql)
      return [[], []]
    },
    async execute(sql) {
      calls.push(sql)
      if (sql.includes('FROM catledger_user_identities')) {
        return [[{ uid: 'user-1' }], []]
      }
      if (sql.includes('AS incomeMinor') && !sql.includes('GROUP BY')) {
        return [[{ incomeMinor: '0', expenseMinor: '0' }], []]
      }
      return [[], []]
    },
    async commit() {
      calls.push('COMMIT')
    },
    async rollback() {
      calls.push('ROLLBACK')
    },
    release() {
      calls.push('RELEASE')
    }
  }
  const service = createReportingService({
    getPool: () => ({ getConnection: async () => connection })
  })
  return { calls, service }
}

test('dashboard is assembled inside one read-only snapshot', async () => {
  const harness = createReportingHarness()
  const result = await harness.service.dashboard({
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    data: { month: '2026-08' }
  })

  assert.equal(result.month, '2026-08')
  assert.equal(result.netWorthMinor, '0')
  assert.deepEqual(result.accounts, [])
  assert.deepEqual(result.recentTransactions, [])
  assert.ok(harness.calls.includes('START TRANSACTION READ ONLY'))
  assert.equal(harness.calls.at(-2), 'COMMIT')
  assert.equal(harness.calls.at(-1), 'RELEASE')
})
test('statistics is assembled inside one read-only snapshot', async () => {
  const harness = createReportingHarness()
  const result = await harness.service.statistics({
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    data: { month: '2026-08' }
  })

  assert.equal(result.month, '2026-08')
  assert.equal(result.daily.length, 31)
  assert.deepEqual(result.expenseCategories, [])
  assert.deepEqual(result.incomeCategories, [])
  assert.ok(harness.calls.includes('START TRANSACTION READ ONLY'))
  assert.equal(harness.calls.at(-2), 'COMMIT')
  assert.equal(harness.calls.at(-1), 'RELEASE')
})
