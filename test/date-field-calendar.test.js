const test = require('node:test')
const assert = require('node:assert/strict')
const cal = require('../miniprogram/components/date-field/calendar')

test('月历网格固定 42 格，前后月补白正确', () => {
  const g = cal.monthGrid(2018, 1) // 2018-01-01 周一
  assert.equal(g.length, 42)
  assert.equal(g[0].date, '2017-12-31') // 上周日补白
  assert.equal(g[0].inMonth, false)
  assert.equal(g[1].date, '2018-01-01')
  assert.equal(g[1].inMonth, true)
  assert.equal(g.filter(c => c.inMonth).length, 31)
})

test('2 月按闰年正确处理天数', () => {
  assert.equal(cal.monthGrid(2018, 2).filter(c => c.inMonth).length, 28)
  assert.equal(cal.monthGrid(2020, 2).filter(c => c.inMonth).length, 29)
})

test('parse 兼容日期与月份两种粒度', () => {
  assert.deepEqual(cal.parse('2018-01-27'), { year: 2018, month: 1, day: 27 })
  assert.deepEqual(cal.parse('2018-01'), { year: 2018, month: 1, day: null })
  assert.equal(cal.parse(''), null)
  assert.equal(cal.parse('abc'), null)
})

test('shiftMonth 跨年正确', () => {
  assert.deepEqual(cal.shiftMonth(2018, 1, -1), { year: 2017, month: 12 })
  assert.deepEqual(cal.shiftMonth(2018, 12, 1), { year: 2019, month: 1 })
  assert.deepEqual(cal.shiftMonth(2018, 6, 0), { year: 2018, month: 6 })
})

test('ymd / ym 补零', () => {
  assert.equal(cal.ymd(2018, 1, 7), '2018-01-07')
  assert.equal(cal.ym(2018, 1), '2018-01')
})
