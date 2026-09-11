const money = require('../../utils/money')

const TYPE_LABELS = Object.freeze({
  cash: '现金',
  bank: '银行卡',
  wallet: '平台钱包',
  credit: '信用卡/消费信贷',
  other_asset: '其他资产',
  other_liability: '其他负债'
})

const { addMinor } = require('../../utils/minor-arithmetic')

function sumMinor(rows, selector) {
  return (rows || []).reduce(function (total, row) { return addMinor(total, selector(row)) }, '0')
}

function decorateAccount(account) {
  const needsCorrection = account.nature === 'asset' && String(account.bookBalanceMinor).charAt(0) === '-'
  const liabilityDue = account.nature === 'liability' && account.balanceDirection === 'liability'
  const liabilityCredit = account.nature === 'liability' && !liabilityDue
  return Object.assign({}, account, {
    typeLabel: TYPE_LABELS[account.type] || '账户',
    balanceText: money.formatMinor(account.displayBalanceMinor),
    needsCorrection: needsCorrection,
    stateText: needsCorrection ? '待校正' : (liabilityDue ? '待还' : (liabilityCredit ? '溢缴余额' : '可用余额')),
    stateTone: needsCorrection ? 'state-warning' : (liabilityDue ? 'state-liability' : (liabilityCredit ? 'state-positive' : '')),
    amountTone: needsCorrection ? 'amount-warning' : (liabilityDue ? 'amount-liability' : (liabilityCredit ? 'amount-positive' : '')),
    balanceLabel: account.nature === 'asset' ? '当前余额' : (liabilityDue ? '当前待还' : '溢缴余额')
  })
}

function buildAccountsView(accounts) {
  const prepared = (accounts || []).map(decorateAccount)
  const active = prepared.filter(function (account) { return !account.archived })
  const assets = active.filter(function (account) { return account.nature === 'asset' })
  const liabilities = active.filter(function (account) { return account.nature === 'liability' })
  const netWorth = sumMinor(active, function (account) { return account.bookBalanceMinor })
  const assetTotal = sumMinor(active, function (account) {
    return String(account.bookBalanceMinor).charAt(0) === '-' ? '0' : account.bookBalanceMinor
  })
  const liabilityTotal = sumMinor(liabilities, function (account) {
    return account.balanceDirection === 'liability' ? String(account.displayBalanceMinor) : '0'
  })
  return {
    assets: assets,
    liabilities: liabilities,
    archivedAccounts: prepared.filter(function (account) { return account.archived }),
    assetCorrectionCount: assets.filter(function (account) { return account.needsCorrection }).length,
    totals: {
      netWorthText: money.formatMinor(netWorth),
      netWorthTone: String(netWorth).charAt(0) === '-' ? 'amount-liability' : '',
      assetsText: money.formatMinor(assetTotal),
      liabilitiesText: money.formatMinor(liabilityTotal)
    }
  }
}

module.exports = { addMinor, buildAccountsView, decorateAccount }
