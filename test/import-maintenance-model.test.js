const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../miniprogram/pages/import-maintenance/model')
test('维护表单以十进制字符串提交金额，聚合分配覆盖完整用户选择', () => {
  const fields = model.fieldsForDraft({ amountYuan: '100.00', accountIndex: 0, aggregate: true,
    allocations: [{ accountId: 'credit-a', amountYuan: '60.00' }, { accountId: 'credit-b', amountYuan: '40' },
      { accountId: 'unused', amountYuan: '' }] }, [{ accountId: 'bank' }], [])
  assert.deepEqual(fields, { amountMinor: '10000', ledgerAccountId: 'bank', repaymentAllocations: [
    { accountId: 'credit-a', amountMinor: '6000' }, { accountId: 'credit-b', amountMinor: '4000' }] })
  assert.throws(() => model.fieldsForDraft({ amountYuan: '1', accountIndex: -1 }, [], []), /账户/u)
  assert.throws(() => model.fieldsForDraft({ amountYuan: '1.001', accountIndex: 0 }, [{ accountId: 'a' }], []), /金额/u)
})
test('预览说明明确区分本批影响与账户净变化，并展示服务端冲突', () => {
  const result = model.impactView({ conflicts: ['TRANSACTION_SET_CHANGED'], accountImpacts: [
    { accountId: 'a', oldMinor: '-100', newMinor: '-200', deltaMinor: '-100' }
  ] }, [{ accountId: 'a', name: '测试现金' }])
  assert.equal(result.changes[0].deltaText, '-¥1.00')
  assert.match(result.conflictsText, /已发生变化/u)
})
