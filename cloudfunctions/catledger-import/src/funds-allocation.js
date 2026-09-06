const { paymentResolutionForEvent } = require('./payment-resolution')
const { isAggregateRepayment, repaymentAllocationsForEvent } = require('./repayment-allocation')

// 分配决定只有一个解释入口。来源候选不参与账户授权；账户元数据由调用方按 uid 锁定。
function eventAllocation(event) {
  const fields = event.fieldSources || {}
  const payment = Boolean(fields.paymentResolution)
  const repayment = isAggregateRepayment(event)
  const repaymentDecision = fields.repaymentAllocations != null || fields.repaymentAllocationVersion != null
  if ((payment && (repayment || repaymentDecision)) || (repaymentDecision && !repayment)) {
    return { valid: false, kind: 'conflict', reason: 'funds_allocation_conflict', allocations: [] }
  }
  if (payment) return { ...paymentResolutionForEvent(event), kind: 'payment' }
  if (repayment) return { ...repaymentAllocationsForEvent(event), kind: 'repayment' }
  return { valid: true, kind: 'none', allocations: [] }
}

function allocationAccountsValid(event, plan, accounts) {
  if (!plan.valid) return false
  if (plan.kind === 'none') return true
  const from = plan.kind === 'payment' ? plan.allocations.map((item) => item.accountId) : [event.ledgerAccountId]
  const to = plan.kind === 'repayment' ? plan.allocations.map((item) => item.accountId)
    : event.economicNature === 'repayment' ? [event.counterpartyLedgerAccountId] : []
  return [...from, ...to].every((id) => {
    const account = accounts.get(id)
    return account && account.currency === event.currency && account.archivedAt == null
  }) && to.every((id) => !from.includes(id) && ['credit', 'other_liability'].includes(accounts.get(id).type))
}

function allocationTransactionDrafts(event, plan) {
  if (!plan.valid || plan.kind === 'none') throw new Error('Invalid allocation plan')
  return plan.allocations.map((item) => ({
    type: event.economicNature === 'expense' ? 'expense' : 'transfer',
    sourceAccountId: plan.kind === 'payment' ? item.accountId : event.ledgerAccountId,
    destinationAccountId: plan.kind === 'repayment' ? item.accountId
      : event.economicNature === 'repayment' ? event.counterpartyLedgerAccountId : null,
    categoryId: event.economicNature === 'expense' ? event.categoryId : null,
    originalTransactionId: null,
    amountMinor: item.amountMinor,
    role: plan.kind === 'payment' ? 'payment_allocation' : 'repayment_allocation'
  }))
}

module.exports = { eventAllocation, allocationAccountsValid, allocationTransactionDrafts }
