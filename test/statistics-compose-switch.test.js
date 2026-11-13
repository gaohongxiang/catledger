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

test('月份条给出全年 12 个 chip，当前月在其中且非未来；点击切月', async () => {
  const h = runtime()
  const page = h.page('statistics')
  page.onLoad()
  const current = page.data.month
  await page.loadStatistics()
  assert.equal(page.data.monthOptions.length, 12, '全年 12 个月')
  const cur = page.data.monthOptions.find(o => o.value === current)
  assert.ok(cur && cur.future === false, '当前月不是未来月')
  // 未来月（若存在）必须标 future
  const real = page.data.realCurrentMonth
  for (const o of page.data.monthOptions) assert.equal(o.future, o.value > real)
  h.respond = respond(h)
  const past = page.data.monthOptions[0]
  await page.pickMonth({ currentTarget: { dataset: { value: past.value } } })
  assert.equal(page.data.month, past.value)
})

test('未来月不可点击（pickMonth 拒绝）', async () => {
  const h = runtime(); h.respond = respond(h)
  const page = h.page('statistics'); page.onLoad(); await page.loadStatistics()
  const future = page.data.monthOptions.find(o => o.future)
  if (!future) return // 当年 12 月就是当前月时无未来月
  const before = page.data.month
  await page.pickMonth({ currentTarget: { dataset: { value: future.value } } })
  assert.equal(page.data.month, before, '未来月不应切换')
})

test('年份切换：上一年可切，落点同年月号；下一年不超过真实当前年', async () => {
  const h = runtime(); h.respond = respond(h)
  const page = h.page('statistics'); page.onLoad(); await page.loadStatistics()
  const viewYear = Number(page.data.viewYear)
  await page.previousYear()
  assert.equal(Number(page.data.viewYear), viewYear - 1, '上一年生效')
  assert.equal(Number(String(page.data.month).slice(0, 4)), viewYear - 1)
  // 下一年回到当前年，然后再点不应超过
  await page.nextYear()
  assert.equal(Number(page.data.viewYear), viewYear)
  assert.equal(page.data.canNextYear, false, '当前年不能再往下一年')
  const m = page.data.month
  await page.nextYear()
  assert.equal(page.data.month, m, '超过真实当前年时不切换')
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

test('日历点某天：selectedDay 带净额/收入/支出（取自 charts.calendar 而非 daily）', async () => {
  const h = runtime()
  h.respond = (action, data) => action === 'statistics.get'
    ? { ok: true, data: { month: data.month, trendEndMonth: data.trendEndMonth,
        summary: { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' },
        daily: [{ date: '2026-08-05', incomeMinor: '3000002', expenseMinor: '11609' }],
        cashFlowTrend: [], metrics: {}, liabilities: null,
        expenseCategories: [], incomeCategories: [], categoryComparisons: { expense: {} } } }
    : undefined
  const page = h.page('statistics'); page.onLoad(); await page.loadStatistics()
  page.selectCompositionKind({ currentTarget: { dataset: { kind: 'calendar' } } })
  page.selectDay({ currentTarget: { dataset: { date: '2026-08-05', index: 0 } } })
  assert.ok(page.data.selectedDay, '应选中某天')
  assert.equal(page.data.selectedDay.incomeText, '¥30,000.02')
  assert.equal(page.data.selectedDay.expenseText, '¥116.09')
  assert.notEqual(page.data.selectedDay.netText, undefined, '净额不能是 undefined')
  assert.equal(page.data.selectedDay.netText, '¥29,883.93')
})
