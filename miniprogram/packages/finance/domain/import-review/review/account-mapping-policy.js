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

function applyMappedAccount(event, memberRole, accountId, mappingIndex, mappingAction = 'account') {
  const decision = require('../account-reference-decision')
  if (mappingAction === 'external' || event.fieldSources?.accountOwnership) {
    return decision.apply(event, memberRole, mappingAction === 'external' ? 'external' : 'ledger', accountId)
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
