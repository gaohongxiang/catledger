const money = require('../../utils/money')
const { presentTotals } = require('../../utils/net-worth-present')

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

function isNegative(value) {
  return String(value == null ? '0' : value).charAt(0) === '-'
}

// 账单归属月份：优先用后端算好的 account.statementMonth（YYYY-MM，已含到期日/周期/来源日期兜底）；
// 旧数据没有该字段时退回本地按到期日/周期推，再没有返回空串（不显示月份）。
function statementMonthText(account) {
  const fmt = value => {
    const m = String(value == null ? '' : value).match(/^(\d{4})-?(\d{2})/)
    return m ? Number(m[1]) + '年' + Number(m[2]) + '月' : ''
  }
  const fromServer = fmt(account && account.statementMonth)
  if (fromServer) return fromServer
  const fromDate = value => {
    const m = String(value == null ? '' : value).match(/^(\d{4})-?(\d{2})-?(\d{2})$/)
    return m ? Number(m[1]) + '年' + Number(m[2]) + '月' : ''
  }
  const due = fromDate(account && account.statementDueDate)
  if (due) return due
  const cycle = String(account && account.statementCycle || '')
  const end = cycle.split('-')[1]
  return end ? fromDate(end) : ''
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
      statementMonthText: statementMonthText(account),
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

function buildAccountsView(accounts, totals) {
  const prepared = (accounts || []).map(decorateAccount)
  const active = prepared.filter(function (account) { return !account.archived })
  // 按金额从大到小：资产比余额（displayBalanceMinor），负债比欠款（debtMinor）。
  // 金额是整数分字符串，用 BigInt 比较避免溢出；相等时保持后端原顺序（稳定排序）。
  const byAmountDesc = function (field) {
    return function (a, b) {
      const av = BigInt(a[field] == null ? '0' : a[field])
      const bv = BigInt(b[field] == null ? '0' : b[field])
      if (av === bv) return 0
      return av > bv ? -1 : 1
    }
  }
  const assets = active.filter(function (account) { return account.nature === 'asset' }).sort(byAmountDesc('displayBalanceMinor'))
  const liabilities = active.filter(function (account) { return account.nature === 'liability' }).sort(byAmountDesc('debtMinor'))
  // 合计一律走共享展示层 presentTotals（后端 accountTotals 的唯一真源），前端不再自己累加，
  // 也与首页净值卡同一套格式与「其中利息」口径。
  const sum = presentTotals(totals)
  return {
    assets: assets,
    liabilities: liabilities,
    archivedAccounts: prepared.filter(function (account) { return account.archived }),
    assetCorrectionCount: assets.filter(function (account) { return account.needsCorrection }).length,
    installmentPlanPromptCount: liabilities.filter(function (account) { return account.needsInstallmentPlan }).length,
    totals: {
      netWorthText: sum.netWorthText,
      netWorthTone: sum.netWorthTone,
      assetsText: sum.assetsText,
      liabilitiesText: sum.liabilitiesText,
      liabilitiesInterestText: sum.totalInterestText
    }
  }
}

module.exports = { buildAccountsView, decorateAccount }
