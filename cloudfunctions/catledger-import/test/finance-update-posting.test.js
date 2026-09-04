const assert = require('node:assert/strict')
const test = require('node:test')

const { categoryMappingCandidates, transactionDraft } = require('../src/finance-update-posting')

test('只提升本批内分类一致的来源别名映射', function () {
  assert.deepEqual(categoryMappingCandidates([
    { sourceType: 'wechat', categoryId: 'food', categoryEvidence: { aliasKeys: ['meal', 'merchant'] } },
    { sourceType: 'wechat', categoryId: 'food', categoryEvidence: { aliasKeys: ['meal'] } },
    { sourceType: 'wechat', categoryId: 'shopping', categoryEvidence: { aliasKeys: ['merchant'] } }
  ]), [
    { sourceType: 'wechat', aliasKey: 'meal', categoryId: 'food' }
  ])
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
