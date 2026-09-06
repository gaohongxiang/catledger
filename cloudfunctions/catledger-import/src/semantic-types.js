const RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'resolved',
  UNKNOWN: 'unknown',
  CONFLICT: 'conflict',
  INVALID: 'invalid'
})

const MONEY_EFFECT = Object.freeze({
  FINANCIAL: 'financial',
  NON_FINANCIAL: 'non_financial',
  FAILED: 'failed',
  CLOSED: 'closed',
  PENDING: 'pending',
  UNKNOWN: 'unknown'
})

const SOURCE_ACTION = Object.freeze({
  PURCHASE: 'purchase',
  RECEIPT: 'receipt',
  TRANSFER_SENT: 'transfer_sent',
  TRANSFER_RECEIVED: 'transfer_received',
  REFUND_CREDIT: 'refund_credit',
  TOP_UP: 'top_up',
  WITHDRAWAL: 'withdrawal',
  REPAYMENT: 'repayment',
  BORROW: 'borrow',
  FEE: 'fee',
  YIELD: 'yield'
})

module.exports = { RESOLUTION_STATUS, MONEY_EFFECT, SOURCE_ACTION }
