// 资金组成的人工决定与来源证据分开。复用入账分配格式，未完成草稿绝不冒充已确认分配。
const { importError } = require('../errors')
const { validateUuid } = require('../validation')
const { FIELD_MASK } = require('../manual-field-mask')
const { overrides } = require('../editor-fields')
const { inspectPaymentResolution, EDITOR_PAYMENT_VERSION } = require('../payment-resolution')
const { inspectRepaymentAllocations, REPAYMENT_ALLOCATION_VERSION, isAggregateRepayment } = require('../repayment-allocation')
const fail = () => { throw importError('VALIDATION_ERROR') }
function sourceKind(event) {
  const source = event.fieldSources || {}, editor = overrides(event)
  if (editor.composition) return editor.composition
  if (isAggregateRepayment(event)) return 'repayment'
  if (source.paymentResolution || (source.semanticBlockers || []).includes('payment_components_ambiguous')) return 'payment'
  return 'single'
}
function apply(event, value, acknowledgements = []) {
  if (!value || Array.isArray(value) || !['single','payment','repayment'].includes(value.kind) ||
    Object.keys(value).some(key => !['kind','parts','evidenceNote','incomplete'].includes(key))) fail()
  if (value.kind === 'payment' && !['expense','repayment', ...(value.incomplete ? ['unknown'] : [])].includes(event.economicNature) ||
    value.kind === 'repayment' && event.economicNature !== 'repayment') fail()
  const before = event.fieldSources || {}, prior = sourceKind(event)
  const explanation = value.evidenceNote == null ? '' : value.evidenceNote
  if (typeof explanation !== 'string' || explanation.length > 300 ||
    value.incomplete != null && typeof value.incomplete !== 'boolean') fail()
  if ((before.paymentResolution || before.repaymentAllocations?.length) &&
    (prior !== value.kind || value.incomplete) && !acknowledgements.includes('composition')) fail()
  // 解除已存在的来源组成需要人工说明，而不是直接把第一行当全部金额。
  if (value.kind === 'single' && prior !== 'single' && !explanation.trim()) fail()
  const fields = { ...before, editorOverrides: { ...overrides(event), version: 1, composition: value.kind, evidenceNote: explanation.trim() } }
  delete fields.paymentResolution; delete fields.repaymentAllocations; delete fields.repaymentAllocationVersion
  delete fields.editorOverrides.incompleteComposition
  const mask = FIELD_MASK.paymentResolution | FIELD_MASK.repaymentAllocations | FIELD_MASK.ledgerAccountId | FIELD_MASK.counterpartyLedgerAccountId
  let next = { ...event, fieldSources: fields, manualFieldMask: (event.manualFieldMask || 0) | mask }
  if (value.kind === 'single') {
    if (value.parts != null && (!Array.isArray(value.parts) || value.parts.length)) fail()
    return next
  }
  if (!Array.isArray(value.parts) || value.parts.length > 20) fail()
  const ids = new Set(); let sum = 0n
  const parts = value.parts.map((part, index) => {
    if (!part || Array.isArray(part) || Object.keys(part).some(key => !['accountId','amountMinor'].includes(key))) fail()
    const accountId = part.accountId == null || part.accountId === '' ? null : validateUuid(part.accountId)
    const amountMinor = part.amountMinor == null || part.amountMinor === '' ? null : part.amountMinor
    if (accountId && ids.has(accountId)) fail()
    if (accountId) ids.add(accountId)
    if (amountMinor != null && (typeof amountMinor !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(amountMinor) || BigInt(amountMinor) > 9223372036854775807n)) fail()
    if (amountMinor != null) sum += BigInt(amountMinor)
    if (value.kind === 'repayment' && amountMinor === '0') fail()
    return { accountId, amountMinor, ...(value.kind === 'payment' ? { componentIndex: index } : {}) }
  })
  if (event.amountMinor != null && sum > BigInt(event.amountMinor)) fail()
  const minimum = value.kind === 'payment' ? 2 : 1
  const complete = parts.length >= minimum && parts.every(part => part.accountId && part.amountMinor != null) &&
    event.amountMinor != null && sum === BigInt(event.amountMinor) && (value.kind !== 'payment' || explanation.trim())
  if (value.incomplete === true) {
    fields.editorOverrides.incompleteComposition = { kind: value.kind, parts, evidenceNote: explanation.trim() }
    if (value.kind === 'repayment') next.counterpartyLedgerAccountId = null
    return next
  }
  if (!complete) fail()
  if (value.kind === 'payment') {
    const value = { version: EDITOR_PAYMENT_VERSION, nature: next.economicNature, confirmedFromDetails: true,
      targetAccountId: next.economicNature === 'repayment' ? next.counterpartyLedgerAccountId : null,
      evidenceNote: explanation.trim(), allocations: parts }
    const result = inspectPaymentResolution(next, value)
    if (!result.valid) fail()
    fields.paymentResolution = result.resolution
    next.ledgerAccountId = result.allocations[0].accountId
  } else {
    const result = inspectRepaymentAllocations(parts, next.amountMinor)
    if (!result.valid) fail()
    fields.repaymentAllocationVersion = REPAYMENT_ALLOCATION_VERSION
    fields.repaymentAllocations = result.allocations
    next.counterpartyLedgerAccountId = null
  }
  return next
}
module.exports = { sourceKind, apply }
