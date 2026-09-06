const PAYMENT_RESOLUTION_VERSION = 'payment-resolution-v2'
const LEGACY_PAYMENT_RESOLUTION_VERSION = 'payment-resolution-v1'
const NONNEGATIVE_MINOR = /^(?:0|[1-9]\d{0,18})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MINOR = /^[1-9]\d{0,18}$/
const RESOLVABLE = new Set(['payment_components_ambiguous', 'row_transaction_type_unknown'])

function paymentEvidenceFields(rows) {
  if (!rows.length) return { paymentComponents: [], paymentSourceDirection: '' }
  const first = rows[0]
  const components = first.semantic && first.semantic.paymentComponents || []
  const same = rows.every((row) => row.direction === first.direction && JSON.stringify(row.semantic && row.semantic.paymentComponents || []) === JSON.stringify(components))
  return { paymentSourceDirection: same ? first.direction : '', paymentComponents: same ? components.map((part) => ({
    componentKind: part.componentKind, label: part.displayName || part.value, amountMinor: part.amountMinor
  })) : [] }
}

function inspectPaymentAccounts(event, value, { partial = false } = {}) {
  const fields = event.fieldSources || {}
  const parts = (fields.paymentComponents || []).map((part, componentIndex) => ({ ...part, componentIndex }))
    .filter((part) => part.componentKind === 'financial')
  if (!fields.semanticBlockers || !fields.semanticBlockers.includes('payment_components_ambiguous') ||
      parts.length < 2 || parts.length > 20 || !Array.isArray(value) || (partial ? value.length > parts.length : value.length !== parts.length)) return { valid: false }
  const indexes = new Set(), ids = new Set()
  for (const item of value) {
    if (!item || !Number.isInteger(item.componentIndex) || !parts.some((part) => part.componentIndex === item.componentIndex) ||
        indexes.has(item.componentIndex) || !UUID.test(item.accountId || '') || ids.has(item.accountId) ||
        Object.keys(item).some((key) => !['componentIndex', 'accountId'].includes(key))) return { valid: false }
    indexes.add(item.componentIndex); ids.add(item.accountId)
  }
  return { valid: true, accounts: value.map((item) => ({ componentIndex: item.componentIndex, accountId: item.accountId })).sort((a, b) => a.componentIndex - b.componentIndex) }
}

function inspectPaymentResolution(event, value) {
  const invalid = (reason = 'payment_resolution_required') => ({ valid: false, reason, allocations: [] })
  const fields = event.fieldSources || {}
  const components = fields.paymentComponents || []
  const financial = components.map((item, index) => ({ ...item, componentIndex: index }))
    .filter((item) => item.componentKind === 'financial')
  if (fields.paymentSourceDirection !== 'expense') return invalid('payment_resolution_not_supported')
  if (financial.length < 2 || financial.length > 20 || components.some((item) =>
    !['financial', 'certified_discount'].includes(item.componentKind)) ||
    !fields.semanticBlockers || !fields.semanticBlockers.includes('payment_components_ambiguous')) return invalid('payment_resolution_not_supported')
  if (!value || ![PAYMENT_RESOLUTION_VERSION, LEGACY_PAYMENT_RESOLUTION_VERSION].includes(value.version) || value.confirmedFromDetails !== true ||
    !['expense', 'repayment'].includes(value.nature) || typeof value.evidenceNote !== 'string' ||
    !value.evidenceNote.trim() || value.evidenceNote.length > 300 || !MINOR.test(String(event.amountMinor || '')) ||
    !Array.isArray(value.allocations) || value.allocations.length !== financial.length) return invalid()
  if (value.nature === 'repayment' ? !UUID.test(value.targetAccountId || '') : Boolean(value.targetAccountId)) return invalid('payment_resolution_target_invalid')
  const seen = new Set(), ids = new Set()
  let total = 0n
  const allocations = []
  for (const item of value.allocations) {
    if (!item || !Number.isInteger(item.componentIndex) || !financial.some((part) => part.componentIndex === item.componentIndex) ||
      seen.has(item.componentIndex) || !UUID.test(item.accountId || '') || ids.has(item.accountId) ||
      item.accountId === value.targetAccountId || typeof item.amountMinor !== 'string' || !(value.version === PAYMENT_RESOLUTION_VERSION ? NONNEGATIVE_MINOR : MINOR).test(item.amountMinor)) return invalid('payment_resolution_component_invalid')
    seen.add(item.componentIndex); ids.add(item.accountId)
    total += BigInt(item.amountMinor)
    allocations.push({ componentIndex: item.componentIndex, accountId: item.accountId, amountMinor: item.amountMinor })
  }
  if (total !== BigInt(event.amountMinor)) return invalid('payment_resolution_amount_mismatch')
  allocations.sort((a, b) => a.componentIndex - b.componentIndex)
  return { valid: true, reason: '', allocations: allocations.filter((item) => item.amountMinor !== '0'), resolution: {
    version: value.version, nature: value.nature, allocations,
    targetAccountId: value.targetAccountId || null, evidenceNote: value.evidenceNote.trim(), confirmedFromDetails: true
  } }
}

function paymentResolutionForEvent(event) {
  const result = inspectPaymentResolution(event, event.fieldSources && event.fieldSources.paymentResolution)
  if (!result.valid) return result
  const value = result.resolution
  if (event.economicNature !== value.nature || event.ledgerAccountId !== result.allocations[0].accountId ||
    (event.counterpartyLedgerAccountId || null) !== value.targetAccountId ||
    event.flowDirection !== (value.nature === 'expense' ? 'outflow' : 'neutral')) return { valid: false, reason: 'payment_resolution_changed', allocations: [] }
  return result
}

function effectiveSemanticReasons(event, reasons) {
  return paymentResolutionForEvent(event).valid ? reasons.filter((reason) => !RESOLVABLE.has(reason)) : reasons
}

module.exports = { inspectPaymentAccounts, paymentEvidenceFields, PAYMENT_RESOLUTION_VERSION, inspectPaymentResolution, paymentResolutionForEvent, effectiveSemanticReasons }
