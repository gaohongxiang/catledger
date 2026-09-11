const assert = require('node:assert/strict')
const test = require('node:test')

const { createReportingService, summaryFromTrend } = require('../src/reporting-service')

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
  assert.equal(harness.calls.filter((sql) => typeof sql === 'string' && sql.includes('AS incomeMinor') && !sql.includes('GROUP BY')).length, 0)
  assert.ok(harness.calls.includes('START TRANSACTION READ ONLY'))
  assert.equal(harness.calls.at(-2), 'COMMIT')
  assert.equal(harness.calls.at(-1), 'RELEASE')
})

test('dashboard derives current summary from the six-month trend query', () => {
  assert.deepEqual(summaryFromTrend([
    { month: '2026-07', incomeMinor: '1', expenseMinor: '2' },
    { month: '2026-08', incomeMinor: '500', expenseMinor: '125' }
  ], '2026-08'), {
    incomeMinor: '500',
    expenseMinor: '125',
    netIncomeMinor: '375'
  })
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
  assert.equal(result.daily.every((row) => Object.prototype.hasOwnProperty.call(row, 'incomeHeightPermille')), true)
  assert.equal(result.cashFlowTrend.length, 6)
  assert.deepEqual(result.metrics, {
    transactionCount: 0,
    activeDayCount: 0,
    averageDailyExpenseMinor: '0',
    largestExpenseMinor: '0'
  })
  assert.deepEqual(result.uncategorized, { transactionCount: 0, amountMinor: '0' })
  assert.deepEqual(result.expenseCategories, [])
  assert.deepEqual(result.incomeCategories, [])
  assert.ok(harness.calls.includes('START TRANSACTION READ ONLY'))
  assert.equal(harness.calls.at(-2), 'COMMIT')
  assert.equal(harness.calls.at(-1), 'RELEASE')
})

test('退款分类统计通过原交易分类冲减而不是落入未分类', async () => {
  const harness = createReportingHarness()
  await harness.service.statistics({
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    data: { month: '2026-08' }
  })
  const categorySql = harness.calls.find((sql) => typeof sql === 'string' && sql.includes("THEN 'expense'"))
  assert.match(categorySql, /LEFT JOIN catledger_transactions original/)
  assert.match(categorySql, /COALESCE\(t\.category_id, original\.category_id\)/)
})

test('统计允许独立趋势终点，默认兼容原月份且拒绝无效终点', async () => {
  const h = createReportingHarness()
  const context = { provider: 'wechat-mini', subjectHash: 'synthetic', data: { month: '2025-01', trendEndMonth: '2026-09' } }
  const result = await h.service.statistics(context)
  assert.equal(result.month, '2025-01')
  assert.equal(result.trendEndMonth, '2026-09')
  assert.equal(result.daily[0].date, '2025-01-01')
  assert.deepEqual(result.cashFlowTrend.map(row => row.month), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'])
  assert.equal(h.calls.filter(sql => sql === 'START TRANSACTION READ ONLY').length, 1)
  assert.doesNotMatch(h.calls.join('\n'), /FROM catledger_accounts/)
  assert.equal((await h.service.statistics({ ...context, data: { month: '2025-01' } })).trendEndMonth, '2025-01')
  for (const trendEndMonth of ['2026-13', 'invalid', null]) {
    await assert.rejects(h.service.statistics({ ...context, data: { month: '2025-01', trendEndMonth } }), { publicCode: 'VALIDATION_ERROR' })
  }
})
