const money = require('../../utils/money')
function present(loan) {
  return Object.assign({}, loan, { principalText: loan.remainingPrincipalMinor == null ? '待补充' : money.formatMinor(loan.remainingPrincipalMinor),
    statusText: { unknown: '待补充本金', active: '还款中', settled: '已结清' }[loan.status],
    kindText: loan.kind === 'installment' ? '消费分期' : '普通借款' })
}
function form(loan) {
  return { name: loan.name, institution: loan.institution || '', kindIndex: loan.kind === 'installment' ? 1 : 0,
    principalYuan: loan.baselinePrincipalMinor == null ? '' : money.minorToYuan(loan.baselinePrincipalMinor),
    baselineDate: loan.baselineDate || '', startDate: loan.startDate || '', endDate: loan.endDate || '', repaymentMethod: loan.repaymentMethod || '' }
}
module.exports = { present, form }
