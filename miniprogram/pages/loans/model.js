const money = require('../../utils/money')
const { METHOD_LABELS } = require('../loan-detail/schedule-form')
function scheduleText(loan) {
  return loan.scheduleMethod && loan.scheduleTerms ? (METHOD_LABELS[loan.scheduleMethod] || loan.scheduleMethod) + ' · ' + loan.scheduleTerms + ' 期' : ''
}
function present(loan) {
  const summary=loan.installmentSummary
  return Object.assign({}, loan, { progressText:summary ? '已完成 '+summary.paidPeriods+' / '+summary.totalTerms+' 期' : '', principalText: summary ? money.formatMinor(summary.remainingPrincipalMinor) : loan.remainingPrincipalMinor == null ? '待补充' : money.formatMinor(loan.remainingPrincipalMinor),
    statusText: summary ? (summary.paidPeriods===summary.totalTerms?'已完成':'还款中') : { unknown: '待补充本金', active: '还款中', settled: '已结清' }[loan.status],
    kindText: loan.installmentSetup ? ({credit_card:'信用卡分期',bank_loan:'银行借款',online_loan:'网络借款',other:loan.installmentSetup.customRecordType || '其他分期'}[loan.installmentSetup.recordType] || '分期贷款') : loan.kind === 'installment' ? '分期贷款' : '借款资料',
    originalPrincipalText:loan.installmentSetup ? money.formatMinor(loan.installmentSetup.originalPrincipalMinor) : '',
    scheduleText: scheduleText(loan) })
}
function form(loan) {
  return { name: loan.name, institution: loan.institution || '', kindIndex: loan.kind === 'installment' ? 1 : 0,
    principalYuan: loan.baselinePrincipalMinor == null ? '' : money.minorToYuan(loan.baselinePrincipalMinor),
    baselineDate: loan.baselineDate || '', startDate: loan.startDate || '', endDate: loan.endDate || '', repaymentMethod: loan.repaymentMethod || '' }
}
module.exports = { present, form, scheduleText }
