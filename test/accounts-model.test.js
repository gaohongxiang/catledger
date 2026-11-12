const test = require('node:test')
const assert = require('node:assert/strict')

const { buildAccountsView } = require('../miniprogram/pages/accounts/model')

test('资产账户区分待校正，负债账户按欠款显示待还/已还清，不再有溢缴余额', function () {
  const { netWorthTotals } = require('../cloudfunctions/catledger-api/src/net-worth')
  const accounts = [
    { accountId: 'cash', name: '微信零钱', type: 'wallet', nature: 'asset', balanceDirection: 'asset', bookBalanceMinor: '-100', displayBalanceMinor: '-100', archived: false },
    { accountId: 'paid', name: '江苏银行信用购', type: 'credit', nature: 'liability', bookBalanceMinor: '500', displayBalanceMinor: '500', debtMinor: '0', debtDirection: 'paid', hasStatementData: true, archived: false },
    { accountId: 'card', name: '光大银行信用卡', type: 'credit', nature: 'liability', bookBalanceMinor: '-700', displayBalanceMinor: '700', debtMinor: '700', debtDirection: 'debt', archived: false }
  ]
  const view = buildAccountsView(accounts, netWorthTotals(accounts))

  const liab = id => view.liabilities.find(a => a.accountId === id)
  assert.equal(view.assetCorrectionCount, 1)
  assert.equal(view.assets[0].stateText, '待校正')
  assert.equal(view.assets[0].amountTone, 'amount-warning')
  // 欠款为 0 → 已还清，不再是「溢缴余额」
  assert.equal(liab('paid').stateText, '已还清')
  assert.equal(liab('paid').balanceLabel, '欠款')
  assert.equal(liab('paid').balanceText, '¥0.00')
  // 欠款 > 0 → 待还
  assert.equal(liab('card').stateText, '待还')
  assert.equal(liab('card').amountTone, 'amount-liability')
  assert.equal(liab('card').balanceLabel, '欠款')
  assert.equal(liab('card').balanceText, '¥7.00')
  // 按金额降序：欠款多的 card(7) 排在欠款 0 的 paid 之前
  assert.deepEqual(view.liabilities.map(a => a.accountId), ['card', 'paid'])
  // 合计取后端真源：资产含负余额（-100），负债用欠款（700）
  assert.equal(view.totals.assetsText, '-¥1.00')
  assert.equal(view.totals.liabilitiesText, '¥7.00')
  // 净资产 = 资产(-100) − 负债欠款(700)
  assert.equal(view.totals.netWorthText, '-¥8.00')
  assert.equal(view.totals.netWorthTone, 'amount-liability')
})

test('负债账户有欠款且有账单却没分期计划时给出补建提示', function () {
  const view = buildAccountsView([
    { accountId: 'c1', name: '兴业 6106', type: 'credit', nature: 'liability', bookBalanceMinor: '-813739', displayBalanceMinor: '813739', debtMinor: '813739', debtDirection: 'debt', needsInstallmentPlan: true, archived: false },
    { accountId: 'c2', name: '光大', type: 'credit', nature: 'liability', bookBalanceMinor: '-100', displayBalanceMinor: '100', debtMinor: '100', debtDirection: 'debt', needsInstallmentPlan: false, archived: false },
    { accountId: 'c3', name: '已还清卡', type: 'credit', nature: 'liability', bookBalanceMinor: '0', displayBalanceMinor: '0', debtMinor: '0', debtDirection: 'paid', hasStatementData: true, needsInstallmentPlan: true, archived: false }
  ])
  assert.equal(view.liabilities[0].needsInstallmentPlan, true)
  assert.equal(view.liabilities[1].needsInstallmentPlan, false)
  // 已还清(欠款=0)不提示补建
  assert.equal(view.liabilities[2].needsInstallmentPlan, false)
  assert.equal(view.installmentPlanPromptCount, 1)
})

test('负债卡片不再出现溢缴余额或可用余额文案', function () {
  const view = buildAccountsView([
    { accountId: 'c', name: '卡', type: 'credit', nature: 'liability', bookBalanceMinor: '151217', displayBalanceMinor: '151217', debtMinor: '0', debtDirection: 'paid', hasStatementData: true, archived: false }
  ])
  const card = view.liabilities[0]
  assert.notEqual(card.stateText, '溢缴余额')
  assert.notEqual(card.balanceLabel, '溢缴余额')
  assert.notEqual(card.stateText, '可用余额')
  assert.equal(card.stateText, '已还清')
})

test('没导入账单/没有本期应还的负债账户：没欠款即已还清，不提示待确认', function () {
  const view = buildAccountsView([
    { accountId: 'x', name: '新卡', type: 'credit', nature: 'liability', bookBalanceMinor: '0', displayBalanceMinor: '0', debtMinor: '0', debtDirection: 'paid', hasStatementData: false, hasInstallmentPlan: false, archived: false }
  ])
  assert.equal(view.liabilities[0].stateText, '已还清')
  assert.equal(view.liabilities[0].debtUnknown, false)
})

test('有分期计划（无账单）时即使欠款为 0 也按已还清显示', function () {
  const view = buildAccountsView([
    { accountId: 'y', name: '有分期卡', type: 'credit', nature: 'liability', bookBalanceMinor: '0', displayBalanceMinor: '0', debtMinor: '0', debtDirection: 'paid', hasStatementData: false, hasInstallmentPlan: true, archived: false }
  ])
  assert.equal(view.liabilities[0].stateText, '已还清')
})

test('账户按金额从大到小排序：资产按余额、负债按欠款，各自降序', function () {
  const accounts = [
    { accountId: 'a_small', name: '小额', type: 'cash', nature: 'asset', bookBalanceMinor: '100', displayBalanceMinor: '100', archived: false },
    { accountId: 'a_big', name: '大额', type: 'bank', nature: 'asset', bookBalanceMinor: '900000', displayBalanceMinor: '900000', archived: false },
    { accountId: 'a_mid', name: '中额', type: 'wallet', nature: 'asset', bookBalanceMinor: '5000', displayBalanceMinor: '5000', archived: false },
    { accountId: 'l_small', name: '小欠', type: 'credit', nature: 'liability', bookBalanceMinor: '-100', displayBalanceMinor: '100', debtMinor: '100', debtDirection: 'debt', archived: false },
    { accountId: 'l_big', name: '大欠', type: 'credit', nature: 'liability', bookBalanceMinor: '-90000', displayBalanceMinor: '90000', debtMinor: '90000', debtDirection: 'debt', archived: false }
  ]
  const view = buildAccountsView(accounts, { assets: '0', liabilities: '0', netWorth: '0', totalInterest: '0' })
  // 资产：余额降序
  assert.deepEqual(view.assets.map(a => a.accountId), ['a_big', 'a_mid', 'a_small'])
  // 负债：欠款降序
  assert.deepEqual(view.liabilities.map(a => a.accountId), ['l_big', 'l_small'])
})
