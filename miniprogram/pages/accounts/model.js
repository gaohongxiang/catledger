const money = require('../../utils/money')

const TYPE_LABELS = Object.freeze({
  cash: '现金',
  bank: '银行卡',
  wallet: '平台钱包',
  credit: '信用卡/消费信贷',
  other_asset: '其他资产',
  other_liability: '其他负债'
})

function normalizeSigned(value) {
  const text = String(value == null ? '0' : value)
  const negative = text.charAt(0) === '-'
  const digits = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, '') || '0'
  return { negative: negative && digits !== '0', digits: digits }
}

function compareAbs(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  return left === right ? 0 : (left > right ? 1 : -1)
}

function addAbs(left, right) {
  let carry = 0
  let output = ''
  let leftIndex = left.length - 1
  let rightIndex = right.length - 1
  while (leftIndex >= 0 || rightIndex >= 0 || carry) {
    const sum = Number(left[leftIndex] || 0) + Number(right[rightIndex] || 0) + carry
    output = String(sum % 10) + output
    carry = Math.floor(sum / 10)
    leftIndex -= 1
    rightIndex -= 1
  }
  return output
}

function subtractAbs(larger, smaller) {
  let borrow = 0
  let output = ''
  let largerIndex = larger.length - 1
  let smallerIndex = smaller.length - 1
  while (largerIndex >= 0) {
    let digit = Number(larger[largerIndex]) - borrow - Number(smaller[smallerIndex] || 0)
    if (digit < 0) { digit += 10; borrow = 1 } else borrow = 0
    output = String(digit) + output
    largerIndex -= 1
    smallerIndex -= 1
  }
  return output.replace(/^0+(?=\d)/, '') || '0'
}

function addMinor(leftValue, rightValue) {
  const left = normalizeSigned(leftValue)
  const right = normalizeSigned(rightValue)
  if (left.negative === right.negative) {
    const digits = addAbs(left.digits, right.digits)
    return left.negative && digits !== '0' ? '-' + digits : digits
  }
  const comparison = compareAbs(left.digits, right.digits)
  if (comparison === 0) return '0'
  const larger = comparison > 0 ? left : right
  const smaller = comparison > 0 ? right : left
  const digits = subtractAbs(larger.digits, smaller.digits)
  return larger.negative ? '-' + digits : digits
}

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
