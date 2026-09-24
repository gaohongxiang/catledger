const repaymentOwnership = require('../repayment-ownership')
const { inspectPaymentAccounts, inspectPaymentResolution } = require('../payment-resolution')
const { importError } = require('../errors')
const { ECONOMIC_NATURE, FLOW_DIRECTION, REVIEW_DECISIONS, unique } = require('../organizer-model')
const { validateUuid } = require('../validation')
const { REPAYMENT_ALLOCATION_VERSION, inspectRepaymentAllocations, isAggregateRepayment } = require('../repayment-allocation')

const FIELD_MASK = Object.freeze({
  ledgerAccountId: 1 << 0,
  counterpartyLedgerAccountId: 1 << 1,
  flowDirection: 1 << 2,
  economicNature: 1 << 3,
  occurredLocalAt: 1 << 4,
  amountMinor: 1 << 5,
  currency: 1 << 6,
  categoryId: 1 << 7,
  repaymentAllocations: 1 << 8,
  paymentResolution: 1 << 9,
  paymentAccounts: 1 << 10,
  repaymentOwnership: 1 << 11
})

const ISSUE_RESOLVED_REASONS = Object.freeze({
  account_mapping: new Set([
    'ledger_account_required', 'core_fields_missing',
    'payment_reference_mapping_required'
  ]),
  category_assignment: new Set(['category_required']),
  shared_fields: new Set(['core_fields_missing', 'economic_nature_required', 'postability_direction_conflict']),
  same_event: new Set(['same_event_candidate', 'relation_ambiguous', 'source_group_conflict']),
  refund_relation: new Set(['refund_relation_required', 'refund_relation_ambiguous', 'refund_relation_invalid', 'refund_amount_exceeded', 'relation_ambiguous']),
  transfer_accounts: new Set([
    'repayment_ownership_required', 'repayment_other_treatment_required', 'repayment_ownership_invalid', 'economic_nature_required',
    'transfer_account_required', 'repayment_account_required', 'borrow_account_required', 'relation_ambiguous',
    'repayment_allocation_required', 'repayment_allocation_invalid',
    'repayment_allocation_amount_mismatch', 'repayment_allocation_account_duplicate',
    'repayment_allocation_target_not_allowed'
  ]),
  identity_conflict: new Set(['identity_conflict', 'identity_review_required']),
  field_conflict: new Set(['core_fields_conflict']),
  installment_origin: new Set(['installment_origin_required', 'installment_composition_required', 'economic_nature_required', 'core_fields_missing'])
})

function validateDecision(value) {
  if (!REVIEW_DECISIONS.has(value)) throw importError('VALIDATION_ERROR')
  return value
}

function resolvedReasons(issueType, reasons) {
  const removable = ISSUE_RESOLVED_REASONS[issueType] || new Set()
  return unique(reasons.filter((reason) => reason !== 'blocking_issue_open' && !removable.has(reason)))
}

function validateOptionalUuid(value) {
  return value == null || value === '' ? null : validateUuid(value)
}

function applyFields(event, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw importError('VALIDATION_ERROR')
  if (Object.prototype.hasOwnProperty.call(fields, 'paymentAccounts')) {
    const result = inspectPaymentAccounts(event, fields.paymentAccounts)
    if (Object.keys(fields).length !== 1 || !result.valid || event.fieldSources.paymentResolution) throw importError('VALIDATION_ERROR')
    return { ...event, fieldSources: { ...event.fieldSources, paymentAccounts: result.accounts },
      manualFieldMask: (event.manualFieldMask || 0) | FIELD_MASK.paymentAccounts }
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'paymentResolution')) {
    if (Object.keys(fields).length !== 1) throw importError('VALIDATION_ERROR')
    const result = inspectPaymentResolution(event, fields.paymentResolution)
    if (!result.valid) throw importError('VALIDATION_ERROR')
    const value = result.resolution
    return { ...event, ledgerAccountId: result.allocations[0].accountId, counterpartyLedgerAccountId: value.targetAccountId,
      economicNature: value.nature, flowDirection: value.nature === 'expense' ? 'outflow' : 'neutral',
      categoryId: value.nature === 'expense' ? event.categoryId : null,
      manualFieldMask: (event.manualFieldMask || 0) | FIELD_MASK.paymentResolution | FIELD_MASK.ledgerAccountId |
        FIELD_MASK.counterpartyLedgerAccountId | FIELD_MASK.economicNature | FIELD_MASK.flowDirection,
      fieldSources: { ...event.fieldSources, paymentResolution: value } }
  }
  const ownership = fields.repaymentOwnership
  if (Object.prototype.hasOwnProperty.call(fields, 'repaymentOwnership')) {
    const allowed = ownership && ownership.owner === 'self'
      ? ['repaymentOwnership', 'ledgerAccountId', 'counterpartyLedgerAccountId'] : ['repaymentOwnership']
    if (!repaymentOwnership.bankRepayment(event) || Object.keys(fields).some(key => !allowed.includes(key))) throw importError('VALIDATION_ERROR')
  }
  let mask = 0
  let next = { ...event }
  for (const key of Object.keys(fields)) {
    if (key === 'timezoneOffsetMinutes') continue
    if (!Object.prototype.hasOwnProperty.call(FIELD_MASK, key)) throw importError('VALIDATION_ERROR')
    mask |= FIELD_MASK[key]
    if (key === 'ledgerAccountId' || key === 'counterpartyLedgerAccountId' || key === 'categoryId') {
      next[key] = validateOptionalUuid(fields[key])
    } else if (key === 'flowDirection') {
      if (!Object.values(FLOW_DIRECTION).includes(fields[key])) throw importError('VALIDATION_ERROR')
      next[key] = fields[key]
    } else if (key === 'economicNature') {
      if (!Object.values(ECONOMIC_NATURE).includes(fields[key])) throw importError('VALIDATION_ERROR')
      next[key] = fields[key]
    } else if (key === 'amountMinor') {
      if (typeof fields[key] !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(fields[key])) throw importError('VALIDATION_ERROR')
      next[key] = fields[key]
    } else if (key === 'currency') {
      if (fields[key] !== 'CNY') throw importError('VALIDATION_ERROR')
      next[key] = fields[key]
    } else if (key === 'occurredLocalAt') {
      if (typeof fields[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(fields[key])) {
        throw importError('VALIDATION_ERROR')
      }
      if (!Number.isInteger(fields.timezoneOffsetMinutes) || fields.timezoneOffsetMinutes < -840 || fields.timezoneOffsetMinutes > 840) {
        throw importError('VALIDATION_ERROR')
      }
      const normalized = fields[key].replace('T', ' ').replace(/\.\d{3}$/, '') + '.000'
      const localEpoch = Date.parse(normalized.replace(' ', 'T') + 'Z')
      if (!Number.isFinite(localEpoch)) throw importError('VALIDATION_ERROR')
      next.localAt = normalized
      next.localDate = normalized.slice(0, 10)
      next.timezoneOffsetMinutes = fields.timezoneOffsetMinutes
      next.utcAt = new Date(localEpoch + fields.timezoneOffsetMinutes * 60_000).toISOString().replace('T', ' ').replace('Z', '')
    } else if (key === 'repaymentAllocations') {
      if (!isAggregateRepayment(next)) throw importError('VALIDATION_ERROR')
      const allocation = inspectRepaymentAllocations(fields[key], next.amountMinor)
      if (!allocation.valid) throw importError('VALIDATION_ERROR')
      next.counterpartyLedgerAccountId = null
      next.fieldSources = {
        ...(next.fieldSources || {}),
        repaymentAllocationVersion: REPAYMENT_ALLOCATION_VERSION,
        repaymentAllocations: allocation.allocations
      }
    }
  }
  if (mask === 0) throw importError('VALIDATION_ERROR')
  if (Object.prototype.hasOwnProperty.call(fields, 'repaymentOwnership')) {
    next = repaymentOwnership.applyDecision(next, ownership)
    mask |= FIELD_MASK.counterpartyLedgerAccountId | FIELD_MASK.economicNature | FIELD_MASK.flowDirection | FIELD_MASK.categoryId
  }
  const priorOwnership = repaymentOwnership.decisionFor(event)
  if (priorOwnership && priorOwnership.owner === 'other' && !ownership &&
      (next.counterpartyLedgerAccountId || !['expense', 'unknown'].includes(next.economicNature))) throw importError('VALIDATION_ERROR')
  next.manualFieldMask |= mask
  return next
}

function assertDecisionMatchesIssue(issue, decision) {
  if (issue.primaryReasonCode === 'historical_duplicate_candidate' &&
      !['confirm_distinct', 'link_existing_transaction', 'exclude_events'].includes(decision)) throw importError('VALIDATION_ERROR')
  if (decision === 'confirm_same' && issue.issueType !== 'same_event') throw importError('VALIDATION_ERROR')
  if (decision === 'confirm_distinct' && !['same_event', 'identity_conflict'].includes(issue.issueType)) throw importError('VALIDATION_ERROR')
  if (decision === 'link_refund' && issue.issueType !== 'refund_relation') throw importError('VALIDATION_ERROR')
  if (decision === 'mark_refund_pending' && issue.issueType !== 'refund_relation') throw importError('VALIDATION_ERROR')
  if (decision === 'confirm_installment_principal') throw importError('INSTALLMENT_CONFIRMATION_UNAVAILABLE')
}

module.exports = { FIELD_MASK, validateDecision, resolvedReasons, applyFields, assertDecisionMatchesIssue }
