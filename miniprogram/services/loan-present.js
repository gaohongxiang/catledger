// 由 pages/loans/model.js 提升而来：借款/分期列表的展示态纯函数。
// 原依赖 loan-detail/schedule-form 的 METHOD_LABELS，这里内联该静态映射，
// 使本模块可独立置于主包 services，被主包与 finance 分包共同引用。
const money = require('../utils/money')
const METHOD_LABELS = { flat: '等本等息', equal_payment: '等额本息', equal_principal: '等额本金', interest_only: '先息后本' }
function scheduleText(loan) {
  return loan.scheduleMethod && loan.scheduleTerms ? (METHOD_LABELS[loan.scheduleMethod] || loan.scheduleMethod) + ' · ' + loan.scheduleTerms + ' 期' : ''
}
function present(loan) {
  const summary = loan.installmentSummary
  return Object.assign({}, loan, { progressText: summary ? '已完成 ' + summary.paidPeriods + ' / ' + summary.totalTerms + ' 期' : '', principalText: loan.remainingPrincipalMinor == null ? '待补充' : money.formatMinor(loan.remainingPrincipalMinor),
    statusText: summary ? (summary.paidPeriods === summary.totalTerms ? '已完成' : '还款中') : { unknown: '待补充本金', active: '还款中', settled: '已结清' }[loan.status],
    kindText: loan.installmentSetup ? ({ credit_card: '信用卡分期', bank_loan: '银行借款', online_loan: '网络借款', other: loan.installmentSetup.customRecordType || '其他分期' }[loan.installmentSetup.recordType] || '分期贷款') : loan.kind === 'installment' ? '分期贷款' : '借款资料',
    originalPrincipalText: loan.installmentSetup ? money.formatMinor(loan.installmentSetup.originalPrincipalMinor) : '',
    scheduleText: scheduleText(loan) })
}
function form(loan) {
  return { name: loan.name, institution: loan.institution || '', kindIndex: loan.kind === 'installment' ? 1 : 0,
    principalYuan: loan.baselinePrincipalMinor == null ? '' : money.minorToYuan(loan.baselinePrincipalMinor),
    baselineDate: loan.baselineDate || '', startDate: loan.startDate || '', endDate: loan.endDate || '', repaymentMethod: loan.repaymentMethod || '' }
}
module.exports = { present, form, scheduleText }
