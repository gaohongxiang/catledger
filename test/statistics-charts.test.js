const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { buildStatisticsView } = require('../miniprogram/pages/statistics/model')
const { createReadCache } = require('../miniprogram/services/read-cache')
const { READ_POLICIES } = require('../miniprogram/services/read-policy')
const source = view => decodeURIComponent(view.src.split(',').slice(1).join(','))
const day = (date, incomeMinor, expenseMinor) => ({ date, incomeMinor, expenseMinor })

test('月内累计按分精确累加，退款负净支出向上抵减且坐标有限', () => {
  const view = buildStatisticsView({ month: '2026-09', daily: [day('2026-09-01', '9007199254740993', '1'), day('2026-09-02', '0', '-9')] }, {})
  assert.equal(view.cumulativeDays[0].cumulativeMinor, '9007199254740992')
  assert.equal(view.cumulativeDays[1].cumulativeMinor, '9007199254741001')
  assert.equal(view.cumulativeEndText, '¥90,071,992,547,410.01')
  assert.equal(view.calendar[0].blank, true)
  assert.equal(view.calendar[2].level, 'refund')
  assert.doesNotMatch(source(view.cumulativeChart), /NaN|Infinity/)
  assert.equal(view.dailyChart, undefined)
})

test('分类构成合并长尾、排除负净额并明确标记退款口径', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ name: '合成分类' + i, amountMinor: String((8 - i) * 100) }))
  rows.push({ name: '退款抵减', amountMinor: '-500' })
  const view = buildStatisticsView({ expenseCategories: rows }, {})
  assert.equal(view.expenseRing.legend.length, 6)
  assert.equal(view.expenseRing.legend[5].name, '其他分类')
  assert.equal(view.expenseRing.legend[5].amountText, '¥6.00')
  assert.equal(view.expenseRing.totalText, '¥36.00')
  assert.equal(view.expenseRing.hasNegative, true)
  assert.ok(Math.abs(view.expenseRing.legend.reduce((sum, row) => sum + Number(row.shareText.slice(0, -1)), 0) - 100) < .3)
})

test('空月保持零图表并提示历史月份，未分类也有环图，零收入不产生无效数', () => {
  const view = buildStatisticsView({ month: '2026-09', daily: [day('2026-09-01', '0', '0')], cashFlowTrend: [{ month: '2026-08', incomeMinor: '0', expenseMinor: '100' }, { month: '2026-09', incomeMinor: '0', expenseMinor: '0' }] }, {})
  assert.equal(view.emptyCashflow, true)
  assert.equal(view.recentMonth, '2026-08')
  assert.equal(view.incomeRing.legend.length, 0)
  for (const graph of [view.monthlyChart, view.cumulativeChart, view.expenseRing, view.incomeRing]) assert.doesNotMatch(source(graph), /NaN|Infinity/)
  const refund = buildStatisticsView({ daily: [day('2026-09-01', '0', '-100')], expenseCategories: [{ name: '未分类', amountMinor: '20' }] }, {})
  assert.equal(refund.emptyCashflow, false)
  assert.equal(refund.expenseRing.legend[0].name, '未分类')
  assert.equal(refund.cumulativeEndText, '¥1.00')
})

test('缓存连续使用超过原TTL仍复用；回前台失效一次，保留登录会话并重新读取', async () => {
  let now = 0, calls = 0
  const cache = createReadCache({ now: () => now })
  const load = async () => ++calls
  await cache.read('statistics', READ_POLICIES['statistics.get'], load)
  now = 24 * 60 * 60 * 1000
  assert.equal(await cache.read('statistics', READ_POLICIES['statistics.get'], load), 1)
  let app
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8'), {
    App: definition => { app = definition },
    require: name => name === './services/read-cache' ? cache : {},
    wx: {}, console
  })
  const session = cache.getSession()
  app.onShow()
  assert.ok(cache.token('statistics'))
  app.onHide()
  app.onShow()
  assert.equal(cache.token('statistics'), null)
  assert.equal(cache.getSession(), session)
  assert.equal(await cache.read('statistics', READ_POLICIES['statistics.get'], load), 2)
  app.onShow()
  assert.ok(cache.token('statistics'))
  await cache.mutate(['transactions'], async () => {})
  assert.equal(cache.token('statistics'), null)
})
