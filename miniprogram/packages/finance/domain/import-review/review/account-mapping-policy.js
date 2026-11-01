const accountGroups = require('../payment-account-groups')
const { applyFields, FIELD_MASK } = require('./policy')
const { reconcileProjectedAccounts } = require('../source-funds')
const { importError } = require('../errors')
function mappingReferenceForMember(event, memberRole) {
  const grouped = accountGroups.referenceForRole(event, memberRole)
  if (grouped) return grouped
  const projection = event && event.fieldSources && event.fieldSources.fundsProjection
  if (memberRole === 'mapping_from') return projection && projection.from || null
  if (memberRole === 'mapping_to') return projection && projection.to || null
  if (memberRole === 'subject') {
    return event && event.fieldSources && event.fieldSources.ledgerAccountReference || null
  }
  return null
}

function channelResolution(event) {
  return event && event.fieldSources && event.fieldSources.repaymentChannelResolution || null
}

function assertChannelTarget(event) {
  const resolution = channelResolution(event)
  if (resolution && event.counterpartyLedgerAccountId !== resolution.targetAccountId) throw importError('VALIDATION_ERROR')
}

function reopenChangedComposition(event, role, accountId) {
  const fields = event.fieldSources || {}, payment = fields.paymentResolution
  const kind = payment ? 'payment' : fields.repaymentAllocations?.length ? 'repayment' : null
  if (!kind) return event
  const original = payment ? payment.allocations : fields.repaymentAllocations
  let changed = false
  const parts = original.map((part, index) => {
    const matches = part.referenceRole === role || kind === 'payment' && (
      /^payment_component_\d+$/.test(role) && part.componentIndex === Number(role.slice('payment_component_'.length)) ||
      role === 'subject' && !part.referenceRole && part.accountId === event.ledgerAccountId)
    if (!matches || part.kind !== 'external' && part.accountId === accountId) return { ...part }
    changed = true
    const next = { ...part, accountId }; delete next.kind
    return next
  })
  const targetChanged = kind === 'payment' && ['mapping_to', 'payment_target'].includes(role) &&
    event.counterpartyLedgerAccountId !== accountId
  if (!changed && !targetChanged) return event
  const nextFields = { ...fields, editorOverrides: { ...fields.editorOverrides, version: 1, composition: kind,
    incompleteComposition: { kind, parts, evidenceNote: payment?.evidenceNote || fields.editorOverrides?.evidenceNote || '' } } }
  delete nextFields.paymentResolution; delete nextFields.repaymentAllocations; delete nextFields.repaymentAllocationVersion
  return { ...event, status: 'needs_action', fieldSources: nextFields,
    reasonCodes: [...new Set((event.reasonCodes || []).concat('editor_composition_incomplete'))] }
}

function applyMappedAccount(event, memberRole, accountId, mappingIndex, mappingAction = 'account', referenceOverride = null) {
  const decision = require('../account-reference-decision')
  if (mappingAction === 'external') {
    return decision.apply(event, memberRole, 'external', null, { reference: referenceOverride })
  }
  event = require('../account-ownership-recheck').clear(event, memberRole,
    referenceOverride || require('../account-ownership-recheck').referenceFor(event, memberRole))
  event = reopenChangedComposition(event, memberRole, accountId)
  if (event.fieldSources?.accountOwnership && decision.supported(event, memberRole)) {
    return decision.apply(event, memberRole, 'ledger', accountId, { reference: referenceOverride })
  }
  const resolution = channelResolution(event)
  if (resolution && ['mapping_to', 'payment_target'].includes(memberRole) && accountId !== resolution.targetAccountId) {
    throw importError('VALIDATION_ERROR')
  }
  const reference = accountGroups.referenceForRole(event, memberRole)
  if (reference) {
    if (memberRole === 'payment_target') return applyFields(event, { counterpartyLedgerAccountId: accountId })
    const accounts = (event.fieldSources.paymentAccounts || []).filter((item) => item.componentIndex !== reference.componentIndex)
    accounts.push({ componentIndex: reference.componentIndex, accountId })
    return { ...event, manualFieldMask: event.manualFieldMask | FIELD_MASK.paymentAccounts,
      fieldSources: { ...event.fieldSources, paymentAccounts: accounts.sort((a, b) => a.componentIndex - b.componentIndex) } }
  }
  if (memberRole === 'subject') return applyFields(event, { ledgerAccountId: accountId })
  return reconcileProjectedAccounts(event, mappingIndex, {
      preserveFrom: Boolean(event.manualFieldMask & FIELD_MASK.ledgerAccountId),
      preserveTo: Boolean(event.manualFieldMask & FIELD_MASK.counterpartyLedgerAccountId)
    }).event
}

function accountMappingEventMembers(members) {
  return members.filter((member) => member.objectType === 'event' &&
    (['subject', 'mapping_from', 'mapping_to', 'payment_target'].includes(member.memberRole) || /^payment_component_\d+$/.test(member.memberRole)))
}

module.exports = { mappingReferenceForMember, channelResolution, assertChannelTarget, applyMappedAccount, accountMappingEventMembers }
