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
  const to = plan.kind === 'repayment' ? plan.allocations.filter(item => item.kind !== 'external').map((item) => item.accountId)
    : event.economicNature === 'repayment' ? [event.counterpartyLedgerAccountId] : []
  return [...from, ...to].every((id) => {
    const account = accounts.get(id)
    return account && account.currency === event.currency && account.archivedAt == null
  }) && to.every((id) => !from.includes(id) && ['credit', 'other_liability'].includes(accounts.get(id).type))
}

function allocationTransactionDrafts(event, plan) {
  if (!plan.valid || plan.kind === 'none') throw new Error('Invalid allocation plan')
  const rows = plan.allocations.map((item) => ({
    type: event.economicNature === 'expense' || item.kind === 'external' ? 'expense' : 'transfer',
    sourceAccountId: plan.kind === 'payment' ? item.accountId : event.ledgerAccountId,
    destinationAccountId: plan.kind === 'repayment' ? item.accountId
      : event.economicNature === 'repayment' ? event.counterpartyLedgerAccountId : null,
    categoryId: event.economicNature === 'expense' ? event.categoryId : null,
    originalTransactionId: null,
    amountMinor: item.amountMinor,
    role: plan.kind === 'payment' ? 'payment_allocation' : 'repayment_allocation'
  }))
  // 外部共同付款不影响我的支出；外部替我还款则增加我的负债账户余额，按收入记录。
  if (plan.kind === 'payment' && event.economicNature === 'repayment') {
    for (const item of plan.externalAllocations || []) rows.push({ type: 'income', sourceAccountId: null,
      destinationAccountId: event.counterpartyLedgerAccountId, categoryId: null, originalTransactionId: null,
      amountMinor: item.amountMinor, role: 'payment_allocation' })
  }
  return rows
}

function effectAmounts(event) {
  const plan = eventAllocation(event)
  if (!plan.valid || plan.kind === 'none') return null
  const result = { expense: 0n, income: 0n, transfer: 0n }
  for (const row of allocationTransactionDrafts(event, plan)) result[row.type] += BigInt(row.amountMinor)
  return result
}

module.exports = { eventAllocation, allocationAccountsValid, allocationTransactionDrafts, effectAmounts }
