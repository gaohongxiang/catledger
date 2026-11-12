const test = require('node:test')
const assert = require('node:assert/strict')
const { buildCategoryComparisons } = require('../cloudfunctions/catledger-api/src/reporting-service')
const { categoryDeltaText } = require('../miniprogram/pages/statistics/model')

test('分类环比：本月对上月按 categoryId 对齐，差值/百万分率精确', () => {
  const current = [{ categoryId: 'c1', amountMinor: '15000' }, { categoryId: 'c2', amountMinor: '5000' }]
  const previous = [{ categoryId: 'c1', amountMinor: '10000' }, { categoryId: 'c2', amountMinor: '5000' }]
  const r = buildCategoryComparisons(current, previous)
  assert.equal(r.c1.deltaMinor, '5000')
  assert.equal(r.c1.ratePpm, 500000, '+50%')
  assert.equal(r.c2.deltaMinor, '0')
  assert.equal(r.c2.ratePpm, 0)
})

test('分类环比：上月没有的类 previousMinor=0、ratePpm=null；未分类按 null 归并', () => {
  const r = buildCategoryComparisons([{ categoryId: 'new', amountMinor: '8000' }, { categoryId: null, amountMinor: '2000' }], [])
  assert.equal(r.new.previousMinor, '0')
  assert.equal(r.new.ratePpm, null)
  assert.equal(r[''].categoryId, null)
  assert.equal(r[''].deltaMinor, '2000')
})

test('categoryDeltaText：涨/降/新增/持平/无数据 的文案与色调', () => {
  assert.deepEqual(categoryDeltaText({ previousMinor: '10000', deltaMinor: '5000', ratePpm: 500000 }), { tone: 'up', text: '↑50%' })
  assert.deepEqual(categoryDeltaText({ previousMinor: '10000', deltaMinor: '-2000', ratePpm: -200000 }), { tone: 'down', text: '↓20%' })
  assert.deepEqual(categoryDeltaText({ previousMinor: '0', deltaMinor: '8000', ratePpm: null }), { tone: 'up', text: '新增' })
  assert.equal(categoryDeltaText({ previousMinor: '5000', deltaMinor: '0', ratePpm: 0 }), null, '持平不显示')
  assert.equal(categoryDeltaText({ previousMinor: '0', deltaMinor: '-1000', ratePpm: null }), null, '上月无、本期也无净增（退款抵减）不显示')
  assert.equal(categoryDeltaText(null), null)
})

test('准备分类行时把 delta 挂到支出类，退款抵减类不做环比', () => {
  // 直接走页面数据通道验证：用 runtime 驱动真实 Page 加载
  const { runtime } = require('./helpers/read-runtime')
  const h = runtime()
  const categories = {
    expenseCategories: [
      { categoryId: 'c1', name: '餐饮', amountMinor: '15000', shareBasisPoints: 7500, children: [] },
      { categoryId: 'c2', name: '购物', amountMinor: '5000', shareBasisPoints: 2500, children: [] }
    ],
    incomeCategories: [],
    categoryComparisons: { expense: { c1: { categoryId: 'c1', previousMinor: '10000', deltaMinor: '5000', ratePpm: 500000 }, c2: { categoryId: 'c2', previousMinor: '0', deltaMinor: '5000', ratePpm: null } } }
  }
  h.respond = (action, data) => action === 'statistics.get'
    ? { ok: true, data: { month: data.month, trendEndMonth: data.trendEndMonth, summary: { incomeMinor: '0', expenseMinor: '20000' }, daily: [], cashFlowTrend: [], metrics: {}, liabilities: null, ...categories } }
    : undefined
  const page = h.page('statistics')
  return page.loadStatistics().then(() => {
    const food = page.data.expenseCategories.find(r => r.categoryId === 'c1')
    const shopping = page.data.expenseCategories.find(r => r.categoryId === 'c2')
    assert.equal(food.delta.tone, 'up')
    assert.equal(food.delta.text, '↑50%')
    assert.equal(shopping.delta.tone, 'up')
    assert.equal(shopping.delta.text, '新增')
  })
})
