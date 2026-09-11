const repaymentOwnership = require('./repayment-ownership')
const { eventAllocation } = require('./funds-allocation')
const { inspectPaymentAccounts, effectiveSemanticReasons, paymentResolutionForEvent } = require('./payment-resolution')
const { SEMANTIC_HARD_BLOCKERS } = require('./semantic-policy')
const { getRowSemantic } = require('./row-semantic-resolver')
const { economicNatureForSemantic } = require('./economic-nature')
const { isAggregateRepayment, repaymentAllocationsForEvent } = require('./repayment-allocation')

const UPDATE_STATUS = Object.freeze({
  DRAFT: 'draft',
  ORGANIZING: 'organizing',
  REVIEW: 'review',
  POSTING: 'posting',
  POSTED: 'posted',
  FAILED: 'failed',
  UNDONE: 'undone',
  ABANDONED: 'abandoned'
})

const EVENT_STATUS = Object.freeze({
  READY: 'ready',
  NEEDS_ACTION: 'needs_action',
  EXCLUDED: 'excluded',
  POSTED: 'posted',
  CORRECTED: 'corrected'
})

const ECONOMIC_NATURE = Object.freeze({
  INCOME: 'income',
  EXPENSE: 'expense',
  INTERNAL_TRANSFER: 'internal_transfer',
  BORROW: 'borrow',
  REPAYMENT: 'repayment',
  REFUND: 'refund',
  FEE: 'fee',
  BALANCE_ADJUSTMENT: 'balance_adjustment',
  UNKNOWN: 'unknown'
})

const FLOW_DIRECTION = Object.freeze({
  INFLOW: 'inflow',
  OUTFLOW: 'outflow',
  NEUTRAL: 'neutral'
})

const EVIDENCE_ROLE = Object.freeze({
  PRIMARY: 'primary',
  SUPPORTING: 'supporting',
  DUPLICATE: 'duplicate',
  DISCARDED: 'discarded'
})

const RELATION_TYPE = Object.freeze({
  REFUND_OF: 'refund_of',
  TRANSFER_BETWEEN: 'transfer_between',
  REPAYMENT_OF: 'repayment_of',
  DEBT_DISBURSEMENT_OF: 'debt_disbursement_of'
})

const RELATION_STATUS = Object.freeze({
  PROPOSED: 'proposed',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  UNDONE: 'undone'
})

const REVIEW_ISSUE_TYPE = Object.freeze({
  ACCOUNT_MAPPING: 'account_mapping',
  CATEGORY_ASSIGNMENT: 'category_assignment',
  SHARED_FIELDS: 'shared_fields',
  SAME_EVENT: 'same_event',
  REFUND_RELATION: 'refund_relation',
  TRANSFER_ACCOUNTS: 'transfer_accounts',
  IDENTITY_CONFLICT: 'identity_conflict',
  FIELD_CONFLICT: 'field_conflict',
  INSTALLMENT_ORIGIN: 'installment_origin'
})

const REVIEW_DECISIONS = new Set([
  'apply_fields',
  'confirm_distinct',
  'confirm_same',
  'exclude_events',
  'confirm_installment_principal',
  'discard_evidence',
  'link_refund',
  'mark_refund_pending',
  'link_existing_transaction'
])

const REFUND_RELATION_STATE_VERSION = 'refund-relation-state-v1'

function hasPendingRefundRelation(event) {
  const relation = event && event.fieldSources && event.fieldSources.refundRelation
  return Boolean(relation && relation.version === REFUND_RELATION_STATE_VERSION &&
    relation.status === 'pending' && relation.confirmedBy === 'user')
}

const HARD_BLOCKING_REASONS = new Set([
  ...SEMANTIC_HARD_BLOCKERS,
  'account_mapping_conflict',
  'blocking_issue_open',
  'core_fields_conflict',
  'identity_conflict',
  'identity_review_required',
  'source_group_conflict',
  'relation_ambiguous',
  'refund_amount_exceeded',
  'refund_relation_ambiguous',
  'refund_relation_invalid',
  'transaction_status_unknown'
])

const ACCOUNT_FIRST_NATURES = new Set([
  ECONOMIC_NATURE.INCOME,
  ECONOMIC_NATURE.EXPENSE,
  ECONOMIC_NATURE.FEE,
  ECONOMIC_NATURE.REFUND
])

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function flowDirectionForRow(row) {
  if (row.direction === 'income') return FLOW_DIRECTION.INFLOW
  if (row.direction === 'expense') return FLOW_DIRECTION.OUTFLOW
  return FLOW_DIRECTION.NEUTRAL
}

function economicNatureForRow(row) {
  return economicNatureForSemantic(getRowSemantic(row))
}

function needsCategory(event) {
  return [ECONOMIC_NATURE.INCOME, ECONOMIC_NATURE.EXPENSE, ECONOMIC_NATURE.FEE].includes(event.economicNature) && !event.categoryId
}

function requiredReasons(event, { relations = [], transactionLinks = [], openBlockingIssues = 0 } = {}) {
  if ([EVENT_STATUS.EXCLUDED, EVENT_STATUS.POSTED, EVENT_STATUS.CORRECTED].includes(event.status)) return []
  const reasons = unique(effectiveSemanticReasons(event, [...(event.reasonCodes || []),
    ...(event.fieldSources && event.fieldSources.semanticBlockers || [])
  ].filter((reason) => HARD_BLOCKING_REASONS.has(reason))))
  if (event.fieldSources && event.fieldSources.paymentResolution && !paymentResolutionForEvent(event).valid) reasons.push('payment_components_ambiguous')
  if (eventAllocation(event).kind === 'conflict') reasons.push('funds_allocation_conflict')
  if (openBlockingIssues > 0) reasons.push('blocking_issue_open')
  if (event.amountMinor == null || !event.localAt || !event.utcAt || !event.currency) {
    reasons.push('core_fields_missing')
  }
  if (!event.ledgerAccountId) reasons.push('ledger_account_required')
  reasons.push(...repaymentOwnership.reasonsFor(event))
  if (needsCategory(event)) {
    reasons.push('category_required')
  }

  switch (event.economicNature) {
    case ECONOMIC_NATURE.INCOME:
      if (event.flowDirection !== FLOW_DIRECTION.INFLOW) reasons.push('postability_direction_conflict')
      break
    case ECONOMIC_NATURE.EXPENSE:
    case ECONOMIC_NATURE.FEE:
      if (event.flowDirection !== FLOW_DIRECTION.OUTFLOW) reasons.push('postability_direction_conflict')
      break
    case ECONOMIC_NATURE.REFUND: {
      if (event.flowDirection !== FLOW_DIRECTION.INFLOW) reasons.push('postability_direction_conflict')
      const confirmed = relations.filter((relation) => relation.relationType === RELATION_TYPE.REFUND_OF &&
        relation.sourceEventId === event.eventId && relation.status === RELATION_STATUS.CONFIRMED)
      const linkedOriginal = transactionLinks.filter((link) => link.eventId === event.eventId && link.role === 'refund_original')
      const proposed = relations.some((relation) => relation.sourceEventId === event.eventId && relation.status === RELATION_STATUS.PROPOSED)
      if (confirmed.some((relation) => String(relation.amountMinor) !== String(event.amountMinor) || relation.currency !== event.currency ||
          relation.targetEventId === event.eventId)) reasons.push('refund_relation_invalid')
      if (confirmed.length + linkedOriginal.length === 0 && !hasPendingRefundRelation(event)) {
        reasons.push('refund_relation_required')
      }
      if (confirmed.length + linkedOriginal.length > 1 || proposed) reasons.push('relation_ambiguous')
      break
    }
    case ECONOMIC_NATURE.INTERNAL_TRANSFER:
      if (event.flowDirection !== FLOW_DIRECTION.NEUTRAL) reasons.push('postability_direction_conflict')
      if (!event.counterpartyLedgerAccountId || event.counterpartyLedgerAccountId === event.ledgerAccountId) {
        reasons.push('transfer_account_required')
      }
      break
    case ECONOMIC_NATURE.REPAYMENT:
    case ECONOMIC_NATURE.BORROW:
      if (event.flowDirection !== FLOW_DIRECTION.NEUTRAL) reasons.push('postability_direction_conflict')
      if (event.economicNature === ECONOMIC_NATURE.REPAYMENT && isAggregateRepayment(event)) {
        const allocation = repaymentAllocationsForEvent(event)
        if (!allocation.valid) reasons.push(allocation.reason)
        if (allocation.valid && allocation.allocations.some((item) => item.accountId === event.ledgerAccountId)) {
          reasons.push('repayment_allocation_invalid')
        }
      } else if (!event.counterpartyLedgerAccountId || event.counterpartyLedgerAccountId === event.ledgerAccountId) {
        reasons.push(event.economicNature === ECONOMIC_NATURE.REPAYMENT
          ? 'repayment_account_required'
          : 'borrow_account_required')
      }
      break
    case ECONOMIC_NATURE.BALANCE_ADJUSTMENT:
      reasons.push('balance_adjustment_mapping_required')
      break
    case ECONOMIC_NATURE.UNKNOWN:
    default:
      reasons.push('economic_nature_required')
      break
  }
  return unique(reasons)
}

function evaluatePostability(event, context) {
  if ([EVENT_STATUS.EXCLUDED, EVENT_STATUS.POSTED, EVENT_STATUS.CORRECTED].includes(event.status)) {
    return { status: event.status, reasonCodes: unique(event.reasonCodes || []) }
  }
  const reasonCodes = requiredReasons(event, context)
  return {
    status: reasonCodes.every((reason) => reason === 'category_required') ? EVENT_STATUS.READY : EVENT_STATUS.NEEDS_ACTION,
    reasonCodes
  }
}

function classifyReviewIssue(event) {
  const reasons = new Set(event.reasonCodes || [])
  if (reasons.has('source_group_conflict')) {
    return { issueType: REVIEW_ISSUE_TYPE.SAME_EVENT, primaryReason: 'source_group_conflict' }
  }
  if (paymentResolutionForEvent(event).valid) {
    reasons.delete('payment_components_ambiguous')
    reasons.delete('row_transaction_type_unknown')
    reasons.delete('ledger_account_required')
  }
  const fundsProjection = event.fieldSources && event.fieldSources.fundsProjection
  if (reasons.has('identity_conflict') || reasons.has('identity_review_required')) {
    return { issueType: REVIEW_ISSUE_TYPE.IDENTITY_CONFLICT, primaryReason: reasons.has('identity_conflict') ? 'identity_conflict' : 'identity_review_required' }
  }
  if (reasons.has('account_mapping_conflict')) {
    return { issueType: REVIEW_ISSUE_TYPE.ACCOUNT_MAPPING, primaryReason: 'account_mapping_conflict' }
  }
  if (reasons.has('core_fields_conflict')) {
    return { issueType: REVIEW_ISSUE_TYPE.FIELD_CONFLICT, primaryReason: 'core_fields_conflict' }
  }
  if (reasons.has('payment_components_ambiguous') && !paymentResolutionForEvent(event).valid) {
    return { issueType: inspectPaymentAccounts(event, event.fieldSources && event.fieldSources.paymentAccounts).valid
      ? REVIEW_ISSUE_TYPE.SHARED_FIELDS : REVIEW_ISSUE_TYPE.ACCOUNT_MAPPING, primaryReason: 'payment_components_ambiguous' }
  }
  if (reasons.has('ledger_account_required') && ACCOUNT_FIRST_NATURES.has(event.economicNature)) {
    return { issueType: REVIEW_ISSUE_TYPE.ACCOUNT_MAPPING, primaryReason: 'ledger_account_required' }
  }
  if (reasons.has('repayment_other_treatment_required') || reasons.has('repayment_ownership_invalid') ||
      (reasons.has('repayment_ownership_required') && event.ledgerAccountId)) {
    return { issueType: REVIEW_ISSUE_TYPE.TRANSFER_ACCOUNTS, primaryReason: reasons.has('repayment_other_treatment_required')
      ? 'repayment_other_treatment_required' : 'repayment_ownership_required' }
  }
  if ((event.status === EVENT_STATUS.READY || reasons.size === 1) && reasons.has('category_required')) {
    return { issueType: REVIEW_ISSUE_TYPE.CATEGORY_ASSIGNMENT, primaryReason: 'category_required' }
  }
  if (reasons.has('refund_relation_required') || reasons.has('refund_relation_ambiguous') ||
      reasons.has('refund_amount_exceeded') || reasons.has('refund_relation_invalid')) {
    return { issueType: REVIEW_ISSUE_TYPE.REFUND_RELATION, primaryReason: reasons.has('refund_relation_required') ? 'refund_relation_required' : 'refund_relation_ambiguous' }
  }
  if (reasons.has('installment_origin_required') || reasons.has('installment_composition_required')) {
    return { issueType: REVIEW_ISSUE_TYPE.INSTALLMENT_ORIGIN, primaryReason: 'installment_origin_required' }
  }
  // 资金动作已经明确了一个可复用的付款工具、但该工具尚未归属账本账户时，
  // 先在账户步骤确认它。确认后再生成只询问另一端的资金流转问题。
  // 这样“微信零钱还信用卡”不会在整理页把已知的零钱端和未知信用卡端
  // 混成双端选择，也不会为没有稳定键的银行泛称提前创建账户。
  if (fundsProjection && (
    (!event.ledgerAccountId && fundsProjection.from && fundsProjection.from.paymentMethodKey) ||
    (!event.counterpartyLedgerAccountId && fundsProjection.to && fundsProjection.to.paymentMethodKey)
  )) {
    return { issueType: REVIEW_ISSUE_TYPE.ACCOUNT_MAPPING, primaryReason: 'ledger_account_required' }
  }
  if ([ECONOMIC_NATURE.INTERNAL_TRANSFER, ECONOMIC_NATURE.REPAYMENT, ECONOMIC_NATURE.BORROW].includes(event.economicNature) ||
      reasons.has('transfer_account_required') || reasons.has('repayment_account_required') || reasons.has('borrow_account_required') ||
      [...reasons].some((reason) => reason.startsWith('repayment_allocation_'))) {
    return {
      issueType: REVIEW_ISSUE_TYPE.TRANSFER_ACCOUNTS,
      primaryReason: [...reasons].find((reason) => reason.startsWith('repayment_allocation_')) ||
        [...reasons].find((reason) => reason.endsWith('_account_required'))
    }
  }
  if (event.sameEventCandidateKey || reasons.has('same_event_candidate') || reasons.has('relation_ambiguous')) {
    return { issueType: REVIEW_ISSUE_TYPE.SAME_EVENT, primaryReason: 'relation_ambiguous' }
  }
  if (reasons.has('ledger_account_required')) {
    return { issueType: REVIEW_ISSUE_TYPE.ACCOUNT_MAPPING, primaryReason: 'ledger_account_required' }
  }
  return {
    issueType: REVIEW_ISSUE_TYPE.SHARED_FIELDS,
    primaryReason: (event.reasonCodes || []).find((reason) => reason !== 'category_required') || 'core_fields_missing'
  }
}

module.exports = {
  ECONOMIC_NATURE,
  EVENT_STATUS,
  EVIDENCE_ROLE,
  FLOW_DIRECTION,
  HARD_BLOCKING_REASONS,
  REFUND_RELATION_STATE_VERSION,
  RELATION_STATUS,
  RELATION_TYPE,
  REVIEW_DECISIONS,
  REVIEW_ISSUE_TYPE,
  UPDATE_STATUS,
  classifyReviewIssue,
  economicNatureForRow,
  evaluatePostability,
  flowDirectionForRow,
  hasPendingRefundRelation,
  needsCategory,
  unique
}
