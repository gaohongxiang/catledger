const { addMinor } = require('../../utils/minor-arithmetic')
const money = require('../../utils/money')
function allocation(loan) {
  return { loanId: loan.loanId, loanName: loan.name, version: loan.version, kind: loan.kind,
    principalYuan: '', interestYuan: '', feeYuan: '', interestIndex: 0, feeIndex: 0, interestCategoryIndex: -1, feeCategoryIndex: -1 }
}
function payload(data) {
  const asset = data.accounts[data.accountIndex]
  if (!asset) throw new Error('请选择资金账户')
  if (!data.confirmed) throw new Error('请核对并确认本息费构成')
  const drawdown = data.kindIndex === 1
  const result = { mode: 'new', kind: drawdown ? 'drawdown' : 'repayment', assetAccountId: asset.accountId,
    totalMinor: money.yuanToMinor(data.totalYuan), occurredLocalAt: data.date + 'T' + data.time + ':00', timezoneOffsetMinutes: new Date().getTimezoneOffset(), confirmed: true,
    allocations: data.allocations.map(a => {
      if (drawdown && a.kind === 'installment') throw new Error('消费分期不登记重复借款到账')
      const value = { loanId: a.loanId, version: a.version, principalMinor: money.yuanToMinor(a.principalYuan, { allowZero: true }),
        interestMinor: drawdown ? '0' : money.yuanToMinor(a.interestYuan, { allowZero: true }), feeMinor: drawdown ? '0' : money.yuanToMinor(a.feeYuan, { allowZero: true }) }
      for (const field of ['interest','fee']) {
        value[field + 'Treatment'] = a[field + 'Index'] === 1 ? 'accrued' : 'expense'
        const category = data.categories[a[field + 'CategoryIndex']]
        if (value[field + 'Minor'] !== '0' && value[field + 'Treatment'] === 'expense' && !category) throw new Error('请选择利息或费用的支出分类')
        value[field + 'CategoryId'] = value[field + 'Minor'] !== '0' && value[field + 'Treatment'] === 'expense' ? category.id : null
      }
      return value
    }) }
  const total = result.allocations.reduce((sum, a) => addMinor(sum, addMinor(a.principalMinor, addMinor(a.interestMinor, a.feeMinor))), '0')
  if (total !== result.totalMinor) throw new Error('本金、利息、费用之和必须等于实际总额')
  return result
}
function review(data) {
  try {
    const value = payload(Object.assign({}, data, { confirmed: true }))
    const expense = value.allocations.reduce((sum, a) => addMinor(sum, addMinor(a.interestTreatment === 'expense' ? a.interestMinor : '0', a.feeTreatment === 'expense' ? a.feeMinor : '0')), '0')
    return '实际总额 ' + money.formatMinor(value.totalMinor) + '，本次新增支出 ' + money.formatMinor(expense) + '，分配至 ' + value.allocations.length + ' 笔贷款。'
  } catch (error) { return error.message }
}
function paymentView(result) {
  return { payment: Object.assign({}, result.payment, { totalText: money.formatMinor(result.payment.totalMinor),
    kindText: result.payment.kind === 'drawdown' ? '放款' : '还款', statusText: result.payment.status === 'active' ? '已登记' : '已撤销' }),
  allocations: result.allocations.map(a => Object.assign({}, a, { principalText: money.formatMinor(a.principalMinor),
    interestText: money.formatMinor(a.interestMinor), feeText: money.formatMinor(a.feeMinor) })),
  transactions: result.transactions.map(t => Object.assign({}, t, { amountText: money.formatMinor(t.amountMinor),
    flowText: t.type === 'expense' ? '支出' : '转账' })) }
}
module.exports = { allocation, payload, paymentView, review }
