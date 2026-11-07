const test = require('node:test')
const assert = require('node:assert/strict')
const { aggregate, presentGroup } = require('../miniprogram/services/installment-source-model')

test('同一笔分期的多期、本金利息行聚合成一条，取最近期次', () => {
  const groups = aggregate([
    { itemId: 'a8', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'principal', amountMinor: '50000' },
    { itemId: 'b8', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'interest', amountMinor: '3000' },
    { itemId: 'a9', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 9, component: 'principal', amountMinor: '50000' }
  ]).map(presentGroup)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].latestPeriod, 9)
  assert.match(groups[0].periodText, /第 9 \/ 12 期/)
  assert.match(groups[0].amountText, /本金/)
  assert.equal(groups[0].sourceItemId, 'a9')
})

test('不同总期数/名称的分期分开成多条', () => {
  const groups = aggregate([
    { itemId: 'x', accountId: 'c', planLabel: '总账分', totalTerms: 36, periodNumber: 28, component: 'principal', amountMinor: '200000' },
    { itemId: 'y', accountId: 'c', planLabel: '电销现分', totalTerms: 12, periodNumber: 9, component: 'principal', amountMinor: '50000' }
  ])
  assert.equal(groups.length, 2)
})

test('有唯一编号时按编号聚合（即使名称不同也归为一笔）', () => {
  const groups = aggregate([
    { itemId: 'p1', accountId: 'c', referenceKey: 'r1', planLabel: 'A', totalTerms: 12, periodNumber: 3, component: 'principal', amountMinor: '1' },
    { itemId: 'p2', accountId: 'c', referenceKey: 'r1', planLabel: 'A2', totalTerms: 12, periodNumber: 4, component: 'principal', amountMinor: '1' }
  ])
  assert.equal(groups.length, 1)
})
