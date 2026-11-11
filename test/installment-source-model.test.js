const test = require('node:test')
const assert = require('node:assert/strict')
const { aggregate, presentGroup } = require('../miniprogram/services/installment-source-model')

test('同一笔分期按期次分别展示（各期都列出，不遗漏）；同期本金+利息归一行', () => {
  const groups = aggregate([
    { itemId: 'a8', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'principal', amountMinor: '50000' },
    { itemId: 'b8', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'interest', amountMinor: '3000' },
    { itemId: 'a9', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 9, component: 'principal', amountMinor: '50000' }
  ]).map(presentGroup)
  // 第 8、9 期各自一条，全部展示。
  assert.equal(groups.length, 2)
  const g8 = groups.find(g => g.latestPeriod === 8), g9 = groups.find(g => g.latestPeriod === 9)
  assert.match(g8.periodText, /第 8 \/ 12 期/)
  assert.match(g8.amountText, /本金.*利息/)  // 同期本金+利息归一行
  assert.equal(g8.sourceItemId, 'a8')
  assert.equal(g9.sourceItemId, 'a9')
})

test('不同总期数/名称的分期分开成多条', () => {
  const groups = aggregate([
    { itemId: 'x', accountId: 'c', planLabel: '总账分', totalTerms: 36, periodNumber: 28, component: 'principal', amountMinor: '200000' },
    { itemId: 'y', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 9, component: 'principal', amountMinor: '50000' }
  ])
  assert.equal(groups.length, 2)
})

test('有唯一编号时按期次分别展示（不同期次各一条；同编号同期的不同组件归一行）', () => {
  const groups = aggregate([
    { itemId: 'p1', accountId: 'c', referenceKey: 'r1', planLabel: 'A', totalTerms: 12, periodNumber: 3, component: 'principal', amountMinor: '1' },
    { itemId: 'p2', accountId: 'c', referenceKey: 'r1', planLabel: 'A2', totalTerms: 12, periodNumber: 4, component: 'principal', amountMinor: '1' }
  ])
  // 同编号但不同期次 → 两条（不遗漏）。
  assert.equal(groups.length, 2)
  // 同编号同期次、不同组件的两行 → 合成一条。
  const samePeriod = aggregate([
    { itemId: 'q1', accountId: 'c', referenceKey: 'r2', planLabel: 'B', totalTerms: 12, periodNumber: 5, component: 'principal', amountMinor: '1' },
    { itemId: 'q2', accountId: 'c', referenceKey: 'r2', planLabel: 'B', totalTerms: 12, periodNumber: 5, component: 'interest', amountMinor: '2' }
  ])
  assert.equal(samePeriod.length, 1)
})

test('同名同总期数但编号不同不合并成一条（各算各的）', () => {
  const groups = aggregate([
    { itemId: 'a', accountId: 'c', referenceKey: 'ra', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'principal', amountMinor: '50000' },
    { itemId: 'b', accountId: 'c', referenceKey: 'rb', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'principal', amountMinor: '50000' }
  ])
  assert.equal(groups.length, 2)
})

test('无编号同名同期数同组件多行时标记 ambiguous，不静默当成一笔', () => {
  const groups = aggregate([
    { itemId: 'a', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'principal', amountMinor: '50000' },
    { itemId: 'b', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'principal', amountMinor: '60000' }
  ]).map(presentGroup)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].ambiguous, true)
  assert.equal(groups[0].seen, undefined)
})

test('同一笔的本金+利息同期不标记 ambiguous', () => {
  const groups = aggregate([
    { itemId: 'a', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'principal', amountMinor: '50000' },
    { itemId: 'b', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'interest', amountMinor: '3000' }
  ]).map(presentGroup)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].ambiguous, false)
})
