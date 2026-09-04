const assert = require('node:assert/strict')
const test = require('node:test')

const { groupUnclassifiedRows } = require('../src/category-service')

test('已入账未分类记录按来源分类证据分组且不跨收支性质', function () {
  const rows = [
    { transactionId: 'a', version: 1, type: 'expense', amountMinor: '100', sourceType: 'alipay', categoryEvidence: { aliasKeys: ['same'] }, item: '午餐' },
    { transactionId: 'b', version: 2, type: 'expense', amountMinor: '200', sourceType: 'alipay', categoryEvidence: { aliasKeys: ['same'] }, item: '晚餐' },
    { transactionId: 'c', version: 1, type: 'income', amountMinor: '300', sourceType: 'alipay', categoryEvidence: { aliasKeys: ['same'] }, item: '退款外收入' }
  ]
  const groups = groupUnclassifiedRows(rows)

  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => [group.kind, group.count, group.amountMinor]), [
    ['expense', 2, '300'],
    ['income', 1, '300']
  ])
  assert.deepEqual(groups[0].members, [
    { transactionId: 'a', version: 1 },
    { transactionId: 'b', version: 2 }
  ])
})
