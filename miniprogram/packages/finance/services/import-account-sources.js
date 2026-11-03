const { memberReference } = require('../domain/import-review/account-reference-context')
const { paymentReferenceKey } = require('../domain/import-review/payment-account')

function referenceKey(reference) {
  if (!reference?.sourceType) return ''
  const binding = reference.bindingKey || (reference.accountIdentityKey || '').replace(/^account-reference-v3:/u, '')
  if (reference.bindingKey || reference.accountIdentityKey?.startsWith('account-reference-v3:')) {
    return reference.sourceType + ':binding:' + binding
  }
  return paymentReferenceKey(reference)
}

function references(event) {
  const fields = event?.fieldSources || {}
  return [fields.ledgerAccountReference, fields.fundsProjection?.from, fields.fundsProjection?.to,
    ...(fields.paymentAccountReferences || []), ...Object.values(fields.bankChannelAccountContexts || {})].filter(Boolean)
}

// A merged event can contain both payment and receiving evidence. Account cards
// retain the source of their original member, not every document proving the event.
function create(model) {
  const sources = new Map(model.facts.sources.map(source => [source.batchId, source]))
  const originalEvents = new Map(model.facts.events.map(event => [event.eventId, event]))
  const originalMembers = new Map(model.facts.members.filter(member => member.memberId)
    .map(member => [member.memberId, member]))
  const originalRows = new Map(), currentRows = new Map()
  for (const link of model.facts.evidence) if (link.evidenceRole !== 'discarded') {
    if (!originalRows.has(link.eventId)) originalRows.set(link.eventId, [])
    originalRows.get(link.eventId).push(link.rowId)
  }
  function rowIds(event) { return event.fieldSources?.rowIds || originalRows.get(event.eventId) || [] }
  function belongs(reference, key) { return key && referenceKey(reference) === key }
  function originRows(event, member, reference) {
    const fields = event.fieldSources || {}, origins = fields.mergeOrigins || []
    const repayment = fields.repaymentChannelResolution, ordinary = fields.bankChannelResolution
    if (!origins.length && !repayment && !ordinary) {
      const ids = rowIds(event)
      // Without merge provenance a mixed-platform scope cannot be attributed
      // to one account merely because its event survived the merge.
      return reference?.sourceType && ids.some(id => {
        const row = model.rows.get(id), source = row && sources.get(row.batchId)
        return (source?.sourceType || row?.sourceType) && (source?.sourceType || row.sourceType) !== reference.sourceType
      }) ? [] : ids
    }
    const key = referenceKey(reference)
    const matched = origins.filter(origin => references(origin.event).some(value => belongs(value, key)))
    if (matched.length) {
      const ids = matched.flatMap(origin => origin.rowIds || rowIds(origin.event))
      // Legacy payment keys have no file scope. An ambiguous old reference must
      // not claim every same-platform file as its own source.
      const scoped = reference?.bindingKey || reference?.accountIdentityKey?.startsWith('account-reference-v3:')
      const batches = new Set(ids.map(id => model.rows.get(id)?.batchId).filter(Boolean))
      if (scoped || batches.size === 1) return ids
    }
    if (repayment?.bankAccountIssueIds?.includes(member.issueId)) return repayment.bankRowIds || []
    if (ordinary && fields.bankChannelAccountContexts?.[member.issueId]) return ordinary.explainedBankRowIds || []
    if (repayment && belongs(fields.fundsProjection?.from, key)) return repayment.platformRowIds || []
    if (ordinary && !fields.bankChannelAccountContexts?.[member.issueId] && belongs(fields.ledgerAccountReference, key)) {
      const bankRows = new Set(ordinary.explainedBankRowIds || [])
      return rowIds(event).filter(id => !bankRows.has(id))
    }
    return []
  }
  return function sourcesFor(member, event, reference) {
    const saved = originalMembers.get(member.memberId)
    const original = saved?.issueId === member.issueId && saved.objectType === 'event' ? saved : null
    const initial = original && originalEvents.get(original.objectId)
    const initialReference = initial && memberReference(initial, original) || reference
    if (!currentRows.has(event.eventId)) currentRows.set(event.eventId,
      new Set(model.evidenceFor(event.eventId).filter(link => link.evidenceRole !== 'discarded').map(link => link.rowId)))
    const valid = currentRows.get(event.eventId), found = new Map()
    const ids = originRows(initial || event, original || member, initialReference)
    for (const id of ids) {
      if (!valid.has(id)) continue
      const row = model.rows.get(id), source = row && sources.get(row.batchId)
      if (row) found.set(source?.sourceId || row.batchId, { sourceId: source?.sourceId || row.batchId,
        sourceType: source?.sourceType || row.sourceType, fileName: source?.fileName || '' })
    }
    if (found.size) return [...found.values()]
    // The platform can still be known when an older snapshot lacks provenance.
    // Keep the transaction in the group without inventing a document match.
    return initialReference?.sourceType ? [{ sourceId: '', sourceType: initialReference.sourceType, fileName: '' }] : []
  }
}

module.exports = { create }
