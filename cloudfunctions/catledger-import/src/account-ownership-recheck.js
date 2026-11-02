// 归属事实可以先保存；尚未重核的组成、退款、借贷和同笔关系不得因此入账。
// 原账户和金额保留供核对，外部引用没有可用于余额计算的账户 ID。
const { paymentReferenceKey } = require('./payment-account')
const { FIELD_MASK } = require('./manual-field-mask')
const { importError } = require('./errors')

const VERSION = 'account-ownership-recheck-v1'
const REASON = 'account_ownership_recheck_required'
const roleValid = role => ['subject', 'mapping_from', 'mapping_to', 'payment_target'].includes(role) ||
  /^payment_component_\d+$/.test(role || '')
const keyFor = (role, referenceKey) => role + ':' + (referenceKey || '')

function referenceFor(event = {}, role) {
  const fields = event.fieldSources || {}
  return (fields.paymentAccountReferences || []).find(reference => reference.memberRole === role) ||
    (role === 'mapping_from' ? fields.fundsProjection?.from
      : ['mapping_to', 'payment_target'].includes(role) ? fields.fundsProjection?.to
        : role === 'subject' ? fields.ledgerAccountReference : null) || null
}
function inspect(event) {
  const value = event.fieldSources?.accountOwnershipRecheck
  if (value == null) return { valid: true, entries: [] }
  if (!value || value.version !== VERSION || value.confirmedBy !== 'user' || !Array.isArray(value.entries) ||
      !value.entries.length || value.entries.length > 24) return { valid: false, entries: [] }
  const keys = new Set()
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { valid: false, entries: [] }
    const key = keyFor(entry.role, entry.referenceKey)
    if (!roleValid(entry.role) || entry.kind !== 'external' ||
        typeof entry.referenceKey !== 'string' || keys.has(key) || entry.side != null && !['source', 'destination'].includes(entry.side) ||
        Object.keys(entry).some(name => !['role', 'referenceKey', 'kind', 'side'].includes(name))) return { valid: false, entries: [] }
    keys.add(key)
  }
  return { valid: true, entries: value.entries }
}
function entries(event) { return inspect(event).entries }
function decision(event, role, reference = referenceFor(event, role)) {
  const key = paymentReferenceKey(reference)
  return entries(event).some(entry => entry.role === role && (!entry.referenceKey || entry.referenceKey === key))
    ? { kind: 'external', accountId: null } : null
}
function requiresReview(event) {
  const fields = event.fieldSources || {}, editor = fields.editorOverrides || {}
  return Boolean(event.economicNature === 'refund' || event.economicNature === 'borrow' ||
    fields.paymentResolution || editor.composition !== 'single' && (fields.paymentAccounts?.length ||
      fields.paymentAccountReferences?.some(ref => /^payment_component_/.test(ref.memberRole))) ||
    fields.repaymentAllocations?.length || editor.incompleteComposition || fields.repaymentChannelResolution ||
    fields.bankChannelResolution || fields.mergeOrigins?.length || fields.loanRepayment || editor.incompleteRepayment ||
    fields.installment || fields.disbursement || fields.installmentPlan)
}
function record(event, role, reference = referenceFor(event, role), side = null) {
  if (!roleValid(role) || !['ready', 'needs_action', 'excluded'].includes(event.status) || !inspect(event).valid) {
    throw importError('VALIDATION_ERROR')
  }
  const referenceKey = paymentReferenceKey(reference), key = keyFor(role, referenceKey)
  const nextEntries = entries(event).filter(entry => keyFor(entry.role, entry.referenceKey) !== key)
    .concat({ role, referenceKey, kind: 'external', ...(side ? { side } : {}) })
  return { ...event, status: 'needs_action',
    manualFieldMask: (event.manualFieldMask || 0) | FIELD_MASK.ledgerAccountId |
      FIELD_MASK.counterpartyLedgerAccountId | (/^payment_component_/.test(role) ? FIELD_MASK.paymentAccounts : 0),
    fieldSources: { ...event.fieldSources, accountOwnershipRecheck: { version: VERSION, confirmedBy: 'user', entries: nextEntries } },
    reasonCodes: [...new Set([...(event.reasonCodes || []).filter(reason => ![
      'manual_exclusion', 'account_mapping_excluded', 'source_account_ignored_default', 'external_no_ledger_effect'
    ].includes(reason)), REASON])] }
}
function clear(event, role, reference = referenceFor(event, role)) {
  const key = paymentReferenceKey(reference)
  const retained = entries(event).filter(entry => entry.role !== role || entry.referenceKey && entry.referenceKey !== key)
  const fields = { ...event.fieldSources }
  if (retained.length) fields.accountOwnershipRecheck = { version: VERSION, confirmedBy: 'user', entries: retained }
  else delete fields.accountOwnershipRecheck
  return { ...event, fieldSources: fields, reasonCodes: (event.reasonCodes || []).filter(reason => reason !== REASON) }
}
function fulfilled(event, entry, { payment, repayment, ownership, sideFor } = {}) {
  const fields = event.fieldSources || {}
  // 配对/计划事实仍在时，不能借新组成或普通字段编辑绕过原关系。
  if (fields.repaymentChannelResolution || fields.bankChannelResolution || fields.mergeOrigins?.length ||
      fields.installment || fields.disbursement || fields.installmentPlan || fields.loanRepayment ||
      fields.editorOverrides?.incompleteRepayment || fields.editorOverrides?.incompleteComposition) return false
  if (payment?.valid && (payment.resolution.allocations || []).some(part => part.kind === 'external' &&
      (part.referenceRole === entry.role || /^payment_component_\d+$/.test(entry.role) &&
        part.componentIndex === Number(entry.role.slice('payment_component_'.length))))) return true
  if (payment?.valid && payment.resolution.nature === 'expense' && (entry.side || sideFor?.(event, entry.role)) === 'destination') return true
  if (repayment?.valid && repayment.allocations.some(part => part.kind === 'external' && part.referenceRole === entry.role)) return true
  const side = entry.side || sideFor?.(event, entry.role)
  const ordinaryConfirmed = Boolean(event.manualFieldMask & FIELD_MASK.economicNature) && ['income', 'expense', 'fee'].includes(event.economicNature)
  return Boolean(side && (ownership?.explicit || ordinaryConfirmed) && !ownership.invalid && ownership[side].kind === 'external' &&
    !requiresReview(event))
}
function pending(event, inspected) {
  const value = inspect(event)
  return value.valid ? value.entries.filter(entry => !fulfilled(event, entry, inspected)) : [{ role: 'unknown', kind: 'external', referenceKey: '' }]
}
function publicState(event, inspected) {
  const unresolved = pending(event, inspected)
  if (!unresolved.length) return null
  const fields = event.fieldSources || {}
  const action = fields.repaymentChannelResolution || fields.bankChannelResolution || fields.mergeOrigins?.length ? 'pairing'
    : fields.installment || fields.disbursement || fields.installmentPlan || event.economicNature === 'borrow' ||
      fields.loanRepayment ? 'business'
      : event.economicNature === 'refund' ? 'refund' : 'composition'
  return { version: 1, action, entries: unresolved.map(entry => ({ ...entry })) }
}

module.exports = { VERSION, REASON, inspect, entries, decision, referenceFor, roleValid, requiresReview, record, clear, pending, publicState }
