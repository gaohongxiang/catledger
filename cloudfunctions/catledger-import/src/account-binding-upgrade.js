const binding = require('./account-binding')
const { FIELD_MASK } = require('./manual-field-mask')
const { ledgerAccountReferenceForRow, projectSourceFunds } = require('./source-funds')
const { referencesForRows } = require('./payment-account-groups')
const { createMappingIndex, accountIdFromIndex, resolveAccountMappings } = require('./account-mapping-policy')
const drafts = require('./account-draft-binding')

function refreshBindings(event, evidenceRows, mappingLookup, accounts) {
  const source = event.fieldSources || {}
  if (!['ready', 'needs_action'].includes(event.status) || !evidenceRows.length ||
      source.accountBindingVersion === binding.VERSION) return event
  const rows = require('./bank-channel-matching').semanticRowsAfterConfirmation(event, evidenceRows)
  if (!rows.length) return event
  const paired = Boolean(source.repaymentChannelResolution || source.bankChannelResolution || source.mergeOrigins?.length)
  const rowFor = ref => evidenceRows.find(row => row.sourceType === ref?.sourceType) || rows[0]
  const bind = ref => ref ? binding.scopeReference(ref, rowFor(ref)) : ref
  const projection = paired && source.fundsProjection ? { ...source.fundsProjection,
    from: bind(source.fundsProjection.from), to: bind(source.fundsProjection.to) } : projectSourceFunds(rows[0])
  const fields = { ...source, accountBindingVersion: binding.VERSION,
    ledgerAccountReference: paired ? bind(source.ledgerAccountReference) : ledgerAccountReferenceForRow(rows[0]),
    fundsProjection: projection,
    paymentAccountReferences: paired ? (source.paymentAccountReferences || []).map(bind) : referencesForRows(rows) }
  if (source.bankChannelAccountContexts) fields.bankChannelAccountContexts = Object.fromEntries(
    Object.entries(source.bankChannelAccountContexts).map(([key, ref]) => [key, bind(ref)]))
  if (source.repaymentChannelResolution?.platformTargetReference) fields.repaymentChannelResolution = {
    ...source.repaymentChannelResolution, platformTargetReference: bind(source.repaymentChannelResolution.platformTargetReference) }
  const references = [fields.ledgerAccountReference, projection?.from, projection?.to,
    ...fields.paymentAccountReferences, ...Object.values(fields.bankChannelAccountContexts || {}),
    fields.repaymentChannelResolution?.platformTargetReference].filter(Boolean)
  const own = drafts.forMembers(mappingLookup, evidenceRows.map(row => row.rowId), references, event.eventId)
  const resolved = resolveAccountMappings({ references, mappings: mappingLookup.common.concat(own), accounts })
  const index = createMappingIndex(resolved.mappings, { accounts })
  const next = { ...event, fieldSources: fields }
  // 人工端点/已确认配对仍由原事实负责。只撤掉没有确认依据的旧自动分配。
  if (!paired && !source.accountOwnership && !source.repaymentOwnership) {
    if (!(event.manualFieldMask & FIELD_MASK.ledgerAccountId)) next.ledgerAccountId =
      accountIdFromIndex(index, projection ? projection.from : fields.ledgerAccountReference)
    if (!(event.manualFieldMask & FIELD_MASK.counterpartyLedgerAccountId)) next.counterpartyLedgerAccountId =
      accountIdFromIndex(index, projection?.to || fields.paymentAccountReferences.find(ref => ref.memberRole === 'payment_target'))
    if (!(event.manualFieldMask & FIELD_MASK.paymentAccounts) && source.paymentAccounts) {
      fields.paymentAccounts = fields.paymentAccountReferences.filter(ref => ref.memberRole?.startsWith('payment_component_'))
        .map(ref => ({ componentIndex: ref.componentIndex, accountId: accountIdFromIndex(index, ref) })).filter(part => part.accountId)
    }
  }
  return next
}
module.exports = { refreshBindings }
