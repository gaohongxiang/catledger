const money = require('../../utils/money')

const TYPE_LABELS = Object.freeze({
  cash: '现金',
  bank: '银行卡',
  wallet: '平台钱包',
  credit: '信用卡/消费信贷',
  other_asset: '其他资产',
  other_liability: '其他负债'
})

const TYPE_ICONS = Object.freeze({
  cash: 'account-cash.svg',
  bank: 'account-bank.svg',
  wallet: 'account-wallet.svg',
  credit: 'account-credit.svg',
  other_asset: 'account-other.svg',
  other_liability: 'account-other.svg'
})

const { addMinor } = require('../../utils/minor-arithmetic')

function sumMinor(rows, selector) {
  return (rows || []).reduce(function (total, row) { return addMinor(total, selector(row)) }, '0')
}

function isNegative(value) {
  return String(value == null ? '0' : value).charAt(0) === '-'
}

// 负债账户按「欠款」展示：总欠款（账单本期应还 + 未来未到期次分期剩余本息）。
// 欠款 > 0 显示「待还」，= 0 显示「已还清」。没导入账单/没本期应还 = 没欠款，属正常，不提示"待确认"。
function decorateAccount(account) {
  const needsCorrection = account.nature === 'asset' && isNegative(account.bookBalanceMinor)
  if (account.nature === 'liability') {
    const debtMinor = account.debtMinor == null ? '0' : String(account.debtMinor)
    const hasDebt = debtMinor !== '0' && !isNegative(debtMinor)
    return Object.assign({}, account, {
      typeLabel: TYPE_LABELS[account.type] || '账户',
      iconPath: TYPE_ICONS[account.type] || TYPE_ICONS.other_asset,
      balanceText: money.formatMinor(debtMinor),
      statementDayText: account.statementDay == null ? '未设置' : '每月 ' + account.statementDay + ' 日',
      repaymentDayText: account.repaymentDay == null ? '未设置' : '每月 ' + account.repaymentDay + ' 日',
      creditLimitText: account.creditLimitMinor == null ? '未设置' : money.formatMinor(account.creditLimitMinor),
      statementDueText: account.statementDueMinor == null ? '未设置' : money.formatMinor(account.statementDueMinor),
      statementMinimumText: account.statementMinimumMinor == null ? '未设置' : money.formatMinor(account.statementMinimumMinor),
      statementDueDateText: account.statementDueDate == null ? '未设置' : account.statementDueDate,
      statementCycleText: account.statementCycle == null ? '未设置' : account.statementCycle,
      needsCorrection: false,
      stateText: hasDebt ? '待还' : '已还清',
      stateTone: hasDebt ? 'state-liability' : 'state-positive',
      amountTone: hasDebt ? 'amount-liability' : '',
      balanceLabel: '欠款',
      debtMinor: debtMinor,
      debtUnknown: false,
      needsInstallmentPlan: Boolean(account.needsInstallmentPlan) && hasDebt
    })
  }
  return Object.assign({}, account, {
    typeLabel: TYPE_LABELS[account.type] || '账户',
    iconPath: TYPE_ICONS[account.type] || TYPE_ICONS.other_asset,
    balanceText: money.formatMinor(account.displayBalanceMinor),
    statementDayText: account.statementDay == null ? '未设置' : '每月 ' + account.statementDay + ' 日',
    repaymentDayText: account.repaymentDay == null ? '未设置' : '每月 ' + account.repaymentDay + ' 日',
    creditLimitText: account.creditLimitMinor == null ? '未设置' : money.formatMinor(account.creditLimitMinor),
    needsCorrection: needsCorrection,
    stateText: needsCorrection ? '待校正' : '可用余额',
    stateTone: needsCorrection ? 'state-warning' : '',
    amountTone: needsCorrection ? 'amount-warning' : '',
    balanceLabel: '当前余额',
    debtMinor: null,
    needsInstallmentPlan: false
  })
}

function buildAccountsView(accounts) {
  const prepared = (accounts || []).map(decorateAccount)
  const active = prepared.filter(function (account) { return !account.archived })
  const assets = active.filter(function (account) { return account.nature === 'asset' })
  const liabilities = active.filter(function (account) { return account.nature === 'liability' })
  const assetTotal = sumMinor(active, function (account) {
    return account.nature === 'asset' && !isNegative(account.bookBalanceMinor) ? account.bookBalanceMinor : '0'
  })
  const liabilityTotal = sumMinor(liabilities, function (account) { return account.debtMinor || '0' })
  // 净资产 = 资产 − 负债欠款；欠款非负，直接相减。
  const netWorth = addMinor(assetTotal, '-' + (liabilityTotal === '0' ? '0' : liabilityTotal))
  return {
    assets: assets,
    liabilities: liabilities,
    archivedAccounts: prepared.filter(function (account) { return account.archived }),
    assetCorrectionCount: assets.filter(function (account) { return account.needsCorrection }).length,
    installmentPlanPromptCount: liabilities.filter(function (account) { return account.needsInstallmentPlan }).length,
    totals: {
      netWorthText: money.formatMinor(netWorth),
      netWorthTone: isNegative(netWorth) ? 'amount-liability' : '',
      assetsText: money.formatMinor(assetTotal),
      liabilitiesText: money.formatMinor(liabilityTotal)
    }
  }
}

module.exports = { addMinor, buildAccountsView, decorateAccount }
