// 只读核对提示：已存在的问题决定可处理入口，当前事件的缺口补充剩余事项。
// 不创建问题、不预测后续步骤；不改变入账门禁、成员范围或人工决定。
const VERSION = 'review-attention-v1'
const step = (key, label, priority) => ({ key, label, priority })
const principal = event => Boolean(event.installment && event.installment.creditStatement && event.installment.component === 'principal')
const knownNature = event => ['income', 'expense', 'fee', 'refund', 'internal_transfer', 'borrow', 'repayment', 'balance_adjustment'].includes(event.economicNature)

function accounts(event) {
  let label = '资金账户待确认'
  const nature = event.economicNature
  if (principal(event)) label = '所属信用卡待确认'
  else if (event.repaymentOwnershipRequired) label = '资金账户待确认'
  else if (['income', 'refund'].includes(nature)) label = nature === 'refund' ? '退款到账账户待确认' : '收款账户待确认'
  else if (['expense', 'fee'].includes(nature)) label = nature === 'fee' ? '记费账户待确认' : '付款账户待确认'
  else if (['internal_transfer', 'borrow', 'repayment'].includes(nature)) {
    const allocated = event.paymentResolution || (event.repaymentAllocations || []).length
    const reverse = !allocated && event.sourceDirection === 'income'
    const from = reverse ? event.counterpartyLedgerAccountId : event.ledgerAccountId
    const to = reverse ? event.ledgerAccountId : event.counterpartyLedgerAccountId
    const names = nature === 'repayment' ? ['付款账户', '还入账户']
      : nature === 'borrow' ? ['借款负债账户', '到账账户'] : ['转出账户', '转入账户']
    if (!from && to) label = names[0] + '待确认'
    else if (from && !to) label = names[1] + '待确认'
    else if (from && from === to) label = '两端账户需不同'
  }
  return step('accounts', label, 50)
}

function reasonStep(reason, event) {
  if (reason === 'refund_source_conflict') return step('source_conflict', '退款与原订单状态冲突', 0)
  if (['row_status_unknown', 'transaction_status_unknown'].includes(reason)) return step('status', '账单状态待核对', 1)
  if (reason === 'source_profile_unknown') return step('source', '账单来源待核对', 2)
  if (reason === 'row_amount_invalid') return step('amount', '金额待核对', 3)
  if (['identity_conflict', 'identity_review_required'].includes(reason)) return step('identity', '来源身份冲突待核对', 4)
  if (reason === 'account_mapping_conflict') return step('account_conflict', '账户归属冲突待核对', 5)
  if (['core_fields_conflict', 'row_semantic_conflict', 'postability_direction_conflict'].includes(reason)) return step('fields', '交易信息冲突待核对', 6)
  if (reason === 'source_group_conflict') return step('same_event', '同笔来源冲突待核对', 7)
  if (['same_event_candidate', 'bank_channel_same_event_candidate'].includes(reason)) return step('same_event', '判断是否同一笔', 20)
  if (reason === 'historical_duplicate_candidate') return step('same_event', '判断是否已经入账', 20)
  if (['economic_nature_required', 'row_transaction_type_unknown'].includes(reason)) return step('nature', knownNature(event) ? '账单类型待核对' : '性质待确认', 30)
  if (reason === 'core_fields_missing') return step('basic', '金额／时间待补齐', 8)
  if (['repayment_ownership_required', 'repayment_ownership_invalid', 'repayment_other_treatment_required'].includes(reason)) {
    return step('ownership', event.repaymentOwnership && event.repaymentOwnership.owner === 'other' ? '代他人还款待核对' : '还款账户归属待确认', 40)
  }
  if (['ledger_account_required', 'payment_reference_mapping_required', 'source_account_endpoint_unknown', 'account_endpoint_unknown'].includes(reason)) return accounts(event)
  if (['transfer_account_required', 'repayment_account_required', 'borrow_account_required'].includes(reason) && !principal(event)) return accounts(event)
  if (reason === 'payment_components_ambiguous') return step('payment', '组合支付待核对', 60)
  if (reason.startsWith('repayment_allocation_') && event.economicNature === 'repayment' && !principal(event)) return step('allocation', '还款分配待补齐', 61)
  if (reason === 'loan_repayment_required' && !principal(event)) return step('loan', '还款本息费待核对', 62)
  if (['refund_relation_required', 'refund_relation_ambiguous', 'refund_amount_exceeded', 'refund_relation_invalid'].includes(reason) && event.economicNature === 'refund') {
    return step('refund', reason === 'refund_amount_exceeded' ? '退款金额超额待核对' : '退款关系待确认', 70)
  }
  if (['installment_origin_required', 'installment_composition_required'].includes(reason)) return step('installment', '分期来源／组成待确认', 80)
  if (reason === 'balance_adjustment_mapping_required') return step('adjustment', '余额调整待核对', 50)
  return null
}

function issueStep(issue, event) {
  // 共享问题的 reasonCodes 是成员并集，不能把其他成员的缺口贴在当前交易上。
  const reason = issue.primaryReasonCode || ''
  if (issue.issueType === 'account_mapping' && reason === 'payment_components_ambiguous') return step('payment_accounts', '组合付款账户待确认', 15)
  const explicit = reasonStep(reason, event)
  if (explicit) {
    // 判重需要已明确的账单账户；现有账户问题应先于需要这些账户的同笔候选。
    if (issue.issueType === 'account_mapping' && !event.ledgerAccountId) explicit.priority = Math.min(explicit.priority, 15)
    return explicit
  }
  const defaults = {
    same_event: step('same_event', '判断是否同一笔', 20),
    identity_conflict: step('identity', '来源身份冲突待核对', 4),
    field_conflict: step('fields', '交易信息冲突待核对', 6),
    refund_relation: step('refund', '退款关系待确认', 70),
    installment_origin: step('installment', '分期来源／组成待确认', 80)
  }
  if (issue.issueType === 'account_mapping' || issue.issueType === 'transfer_accounts') {
    const item = accounts(event)
    if (issue.issueType === 'account_mapping' && !event.ledgerAccountId) item.priority = 15
    return item
  }
  if (issue.issueType === 'shared_fields') {
    const fields = new Set(['status', 'source', 'amount', 'fields', 'nature', 'basic', 'adjustment', 'loan'])
    const reasons = (event.reasonCodes || []).map(code => reasonStep(code, event)).filter(item => item && fields.has(item.key))
      .sort((a, b) => a.priority - b.priority)
    return reasons[0] || step('review', '交易信息待核对', 90)
  }
  return defaults[issue.issueType] || step('review', '交易信息待核对', 90)
}

function reviewAttention(event, issues = []) {
  // 调用者按 created_at、issue_id 提供稳定次序；同优先级沿用它。
  const seen = new Set()
  const available = issues.filter(issue => issue && issue.status === 'open' && issue.blocking &&
    issue.issueType !== 'category_assignment' && !seen.has(issue.issueId) && seen.add(issue.issueId))
    .map((issue, index) => ({ issue, index, item: issueStep(issue, event) }))
    .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index)
  const first = available[0], pendingIssue = first ? first.issue : null
  const byKey = new Map()
  for (const item of available.map(row => row.item).concat((event.reasonCodes || []).map(code => reasonStep(code, event)).filter(Boolean))) {
    if (!byKey.has(item.key)) byKey.set(item.key, item)
  }
  if (!knownNature(event) && !principal(event) && !byKey.has('nature')) byKey.set('nature', step('nature', '性质待确认', 30))
  if (!byKey.size) byKey.set('review', step('review', '交易信息待核对', 90))
  const steps = [...byKey.values()].sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))
  // 首项始终对应真正能打开的问题。其余是当前已知缺口，不承诺必经未来步骤。
  if (first) {
    const index = steps.findIndex(item => item.key === first.item.key)
    steps.splice(index, 1); steps.unshift(first.item)
  }
  return { pendingIssue, reviewAttention: { version: VERSION, issueId: pendingIssue && pendingIssue.issueId || null,
    steps: steps.map(({ key, label }) => ({ key, label })) } }
}
module.exports = { VERSION, reviewAttention }
