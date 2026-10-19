const test = require('node:test')
const assert = require('node:assert/strict')
const { suggestedAccountTypeIndex } = require('../miniprogram/packages/finance/pages/import-workbench/account-review')

test('新建账户类型优先按资金端推断，主卡默认为信用卡而非银行卡', () => {
  assert.equal(suggestedAccountTypeIndex('主卡6106', 'bank', 'to', 'repayment'), 3)
  assert.equal(suggestedAccountTypeIndex('主卡6106', 'bank', 'ordinary', 'expense'), 3)
  assert.equal(suggestedAccountTypeIndex('浙江农商联合银行储蓄卡(5564)', 'bank', 'from', 'repayment'), 1)
  assert.equal(suggestedAccountTypeIndex('现金', '', 'ordinary', 'expense'), 0)
  assert.equal(suggestedAccountTypeIndex('余额宝', 'alipay', 'ordinary', 'income'), 4)
})
