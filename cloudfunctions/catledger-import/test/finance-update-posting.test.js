const assert = require('node:assert/strict')
const test = require('node:test')

const { categoryMappingCandidates, transactionDraft } = require('../src/finance-update-posting')

test('同一商户不同商品独立记忆，同一具体证据分类冲突明确失效', function () {
  const { categoryMemory } = require('../src/category-memory')
  const first = { sourceType: 'wechat', rawTransactionType: '商户消费', counterparty: '合成商户', item: '合成商品甲' }
  const second = { ...first, item: '合成商品乙' }
  const candidates = categoryMappingCandidates([
    { ...first, categoryId: 'food' }, { ...second, categoryId: 'food' }, { ...second, categoryId: 'shopping' }
  ])
  assert.equal(candidates.length, 2)
  assert.equal(candidates.find(item => item.aliasKey === categoryMemory('wechat', first).pairKey).categoryId, 'food')
  assert.equal(candidates.find(item => item.aliasKey === categoryMemory('wechat', second).pairKey).categoryId, null)
})

test('待关联退款沿用标准 refund 交易并保留空原消费', function () {
  assert.deepEqual(transactionDraft({
    economicNature: 'refund',
    ledgerAccountId: 'account-1'
  }, null), {
    type: 'refund',
    sourceAccountId: null,
    destinationAccountId: 'account-1',
    categoryId: null,
    originalTransactionId: null
  })
})
