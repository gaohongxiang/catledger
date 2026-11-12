const test = require('node:test')
const assert = require('node:assert/strict')
const { buildComparisons } = (() => { try { return require('../cloudfunctions/catledger-api/src/reporting-service') } catch (_) { return {} } })()
const { buildMetricsView, formatDelta } = require('../miniprogram/pages/statistics/model')

const trend = [
  { month: '2025-11', incomeMinor: '100000', expenseMinor: '200000' },
  { month: '2026-10', incomeMinor: '100000', expenseMinor: '200000' },
  { month: '2026-11', incomeMinor: '150000', expenseMinor: '150000' }
]

test('环比：支出降、收入升；差值与百分比按分精确', () => {
  const c = buildComparisons(trend, '2026-11')
  assert.equal(c.previousMonth.month, '2026-10')
  assert.equal(c.previousMonth.expense.deltaMinor, '-50000', '支出 150000−200000')
  assert.equal(c.previousMonth.expense.ratePpm, -250000, '−50%')
  assert.equal(c.previousMonth.income.deltaMinor, '50000')
  assert.equal(c.previousMonth.income.ratePpm, 500000)
})

test('同比：能取到去年同月；窗口没有则为 null，不伪造', () => {
  const c = buildComparisons(trend, '2026-11')
  assert.equal(c.lastYearMonth.month, '2025-11')
  assert.equal(c.lastYearMonth.expense.deltaMinor, '-50000')
  const noLastYear = buildComparisons([{ month: '2026-10', incomeMinor: '1', expenseMinor: '1' }, { month: '2026-11', incomeMinor: '1', expenseMinor: '1' }], '2026-11')
  assert.equal(noLastYear.lastYearMonth, null, '去年同月不在窗口内返回 null')
})

test('基期为 0：ratePpm 记 null，前端显示金额差而非假百分比', () => {
  const zeroBase = buildComparisons([{ month: '2026-10', incomeMinor: '0', expenseMinor: '0' }, { month: '2026-11', incomeMinor: '5000', expenseMinor: '8000' }], '2026-11')
  assert.equal(zeroBase.previousMonth.expense.ratePpm, null)
  assert.equal(zeroBase.previousMonth.income.ratePpm, null)
})

test('formatDelta：上/下/平三态与文案', () => {
  assert.deepEqual(formatDelta({ deltaMinor: '12300', ratePpm: 123000 }), { tone: 'up', arrow: '↑', text: '12.3%' })
  assert.deepEqual(formatDelta({ deltaMinor: '-12300', ratePpm: -123000 }), { tone: 'down', arrow: '↓', text: '12.3%' })
  assert.deepEqual(formatDelta({ deltaMinor: '0', ratePpm: 0 }), { tone: 'flat', arrow: '', text: '持平' })
  assert.equal(formatDelta({ deltaMinor: '5000', ratePpm: null }).text, '¥50.00', '基期 0 时显示绝对差')
  assert.equal(formatDelta(null), null)
})

test('buildMetricsView 组装指标与对比，缺省不显示 undefined', () => {
  const view = buildMetricsView({ transactionCount: 12, activeDayCount: 5, averageDailyExpenseMinor: '1000', largestExpenseMinor: '8000' },
    buildComparisons(trend, '2026-11'), '2026-11')
  assert.equal(view.transactionCount, 12)
  assert.equal(view.averageDailyExpenseText, '¥10.00')
  assert.equal(view.largestExpenseText, '¥80.00')
  assert.equal(view.expenseVsPrevious.tone, 'down')
  assert.equal(view.previousMonthLabel, '2026年10月')
  const empty = buildMetricsView(undefined, undefined, '2026-11')
  assert.equal(empty.transactionCount, 0)
  assert.equal(empty.expenseVsPrevious, null)
  assert.equal(empty.previousMonthLabel, '')
})
