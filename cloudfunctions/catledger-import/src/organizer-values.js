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

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

module.exports = { ECONOMIC_NATURE, FLOW_DIRECTION, REVIEW_DECISIONS, unique }
