const test = require('node:test')
const assert = require('node:assert/strict')

const { buildAccountsView } = require('../miniprogram/pages/accounts/model')

test('账户展示区分资产异常、待还负债和负债溢缴余额', function () {
  const view = buildAccountsView([
    { accountId: 'cash', name: '微信零钱', type: 'wallet', nature: 'asset', balanceDirection: 'asset', bookBalanceMinor: '-100', displayBalanceMinor: '-100', archived: false },
    { accountId: 'credit', name: '江苏银行信用购', type: 'credit', nature: 'liability', balanceDirection: 'asset', bookBalanceMinor: '500', displayBalanceMinor: '500', archived: false },
    { accountId: 'card', name: '光大银行信用卡', type: 'credit', nature: 'liability', balanceDirection: 'liability', bookBalanceMinor: '-700', displayBalanceMinor: '700', archived: false }
  ])

  assert.equal(view.assetCorrectionCount, 1)
  assert.equal(view.assets[0].stateText, '待校正')
  assert.equal(view.assets[0].amountTone, 'amount-warning')
  assert.equal(view.liabilities[0].stateText, '溢缴余额')
  assert.equal(view.liabilities[0].amountTone, 'amount-positive')
  assert.equal(view.liabilities[0].balanceLabel, '溢缴余额')
  assert.equal(view.liabilities[1].stateText, '待还')
  assert.equal(view.liabilities[1].amountTone, 'amount-liability')
  assert.equal(view.totals.assetsText, '¥5.00')
  assert.equal(view.totals.liabilitiesText, '¥7.00')
  assert.equal(view.totals.netWorthText, '-¥3.00')
})
