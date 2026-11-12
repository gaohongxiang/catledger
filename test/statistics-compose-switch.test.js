const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

function respond(h, month) {
  return (action, data) => action === 'statistics.get'
    ? { ok: true, data: {
        month: data.month, trendEndMonth: data.trendEndMonth,
        summary: { incomeMinor: '7200478', expenseMinor: '4744950', netIncomeMinor: '2455528' },
        daily: [], cashFlowTrend: [], metrics: { transactionCount: 135, activeDayCount: 30, averageDailyExpenseMinor: '158165', largestExpenseMinor: '4300000' },
        liabilities: null,
        expenseCategories: [{ categoryId: 'c1', name: '宠物', amountMinor: '4300000', shareBasisPoints: 9060 }, { categoryId: 'c2', name: '餐饮', amountMinor: '181970', shareBasisPoints: 380 }],
        incomeCategories: [{ categoryId: 'i1', name: '工资', amountMinor: '7200478', shareBasisPoints: 10000 }],
        categoryComparisons: { expense: { c1: { categoryId: 'c1', previousMinor: '0', deltaMinor: '4300000', ratePpm: null }, c2: { categoryId: 'c2', previousMinor: '150000', deltaMinor: '31970', ratePpm: 213133 } } }
      } }
    : undefined
}

test('月份条给出 7 个 chip，当前月在其中；点击 chip 切到该月并带上次月选项', async () => {
  const h = runtime()
  const page = h.page('statistics')
  page.onLoad()
  const current = page.data.month
  await page.loadStatistics()
  assert.equal(page.data.monthOptions.length, 7)
  assert.ok(page.data.monthOptions.some(o => o.value === current))
  const target = page.data.monthOptions[0].value
  h.respond = respond(h)
  await page.pickMonth({ currentTarget: { dataset: { value: target } } })
  assert.equal(page.data.month, target)
  assert.equal(page.data.monthOptions.length, 7)
})

test('Hero 结余大字、netTone，收入/支出分列带比率', async () => {
  const h = runtime()
  h.respond = respond(h)
  const page = h.page('statistics')
  await page.loadStatistics()
  assert.equal(page.data.netText, '¥24,555.28')
  assert.equal(page.data.netTone, '')
  assert.equal(page.data.incomeText, '¥72,004.78')
})

test('分段切换：默认支出，切到收入后 compositionKind=income 且图例取自收入环', async () => {
  const h = runtime()
  h.respond = respond(h)
  const page = h.page('statistics')
  await page.loadStatistics()
  assert.equal(page.data.compositionKind, 'expense')
  assert.ok(page.data.rings.expense.legend.length >= 1)
  assert.equal(page.data.rings.expense.legend[0].name, '宠物')
  // 支出图例带环比：宠物为「新增」
  assert.equal(page.data.rings.expense.legend.find(l => l.name === '宠物').delta.text, '新增')
  page.selectCompositionKind({ currentTarget: { dataset: { kind: 'income' } } })
  assert.equal(page.data.compositionKind, 'income')
  assert.equal(page.data.rings.income.legend[0].name, '工资')
})

test('收入图例不带环比 delta', async () => {
  const h = runtime()
  h.respond = respond(h)
  const page = h.page('statistics')
  await page.loadStatistics()
  assert.ok(page.data.rings.income.legend.every(l => l.delta === null || l.delta === undefined))
})

test('分段第三项「日历」：compositionKind=calendar，categoryKind 置空，selectedDay 重置', async () => {
  const h = runtime(); h.respond = respond(h)
  const page = h.page('statistics'); page.onLoad(); await page.loadStatistics()
  page.setData({ selectedDay: { date: '2026-08-01' } })
  page.selectCompositionKind({ currentTarget: { dataset: { kind: 'calendar' } } })
  assert.equal(page.data.compositionKind, 'calendar')
  assert.equal(page.data.categoryKind, '')
  assert.equal(page.data.selectedDay, null)
})
