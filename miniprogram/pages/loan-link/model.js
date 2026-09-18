const money = require('../../utils/money')
const { addMinor } = require('../../utils/minor-arithmetic')
function candidateView(t) {
  return Object.assign({}, t, { amountText: money.formatMinor(t.amountMinor),
    accountText: (t.sourceAccount && t.sourceAccount.name || '付款账户') + ' → ' + (t.destinationAccount && t.destinationAccount.name || '负债账户'),
    businessText: t.targetType === 'credit' ? '信用卡还款候选' : '负债还款候选' })
}
function contextView(value) {
  if (!value || !['none','candidate','linked','replaced'].includes(value.state) || !value.transaction || !Array.isArray(value.allocations)) {
    throw new Error('贷款关联信息不完整，请重新读取')
  }
  const linked = value.state === 'linked' || value.state === 'replaced'
  if (value.state === 'candidate' && (!value.targetAccount || !value.targetAccount.accountId)) throw new Error('还款目标账户不完整，请重新读取')
  if (linked && (!value.payment || !value.allocations.length)) throw new Error('贷款关联信息不完整，请重新读取')
  const hasInstallment = value.allocations.some(a => a.kind === 'installment')
  return Object.assign({}, value, { linked, amountText: money.formatMinor(value.transaction.amountMinor),
    accountText: candidateView(value.transaction).accountText,
    businessText: linked ? (value.payment.kind === 'drawdown' ? '贷款放款' : hasInstallment ? '已关联分期还款' : '已关联贷款还款') :
      value.state === 'none' ? '未关联贷款的普通账目' : value.targetAccount && value.targetAccount.type === 'credit' ? '信用卡还款 · 尚未确认是否分期' : '负债还款 · 尚未关联贷款',
    totalText: linked ? money.formatMinor(value.payment.totalMinor) : '',
    evidence: value.evidence || { items: [], hasMore: false },
    allocations: value.allocations.map(a => {
      const periods = a.periods || []
      return Object.assign({}, a, { principalText: money.formatMinor(a.principalMinor), interestText: money.formatMinor(a.interestMinor), feeText: money.formatMinor(a.feeMinor),
        kindText: a.kind === 'installment' ? '消费分期' : '普通借款',
        periodText: a.periodCount ? periods.map(p => '第' + p.periodNumber + '期（' + p.dueDate + '）').join('、') + (a.periodCount > periods.length ? '，共' + a.periodCount + '期，更多见对账' : '') : '尚未分配到期次',
        unallocatedText: a.unallocated ? '待对账：本金 ' + money.formatMinor(a.unallocated.principalMinor) + ' · 利息 ' + money.formatMinor(a.unallocated.interestMinor) + ' · 费用 ' + money.formatMinor(a.unallocated.feeMinor) : '',
        hasUnallocated: a.unallocated ? addMinor(a.unallocated.principalMinor, addMinor(a.unallocated.interestMinor,a.unallocated.feeMinor)) !== '0' : true })
    }) })
}
function choiceView(loan, date) {
  const issue = loan.accountArchived ? '负债账户已停用，请先核对' : loan.baselinePrincipalMinor == null ? '本金基准待补充' :
    loan.baselineDate > date ? '本金基准晚于这笔还款，请先核对' : ''
  return Object.assign({}, loan, { kindText: loan.kind === 'installment' ? '消费分期' : '普通借款',
    principalText: loan.remainingPrincipalMinor == null ? '待补充' : money.formatMinor(loan.remainingPrincipalMinor),
    issue, canLink: !issue })
}
module.exports = { candidateView, contextView, choiceView }
