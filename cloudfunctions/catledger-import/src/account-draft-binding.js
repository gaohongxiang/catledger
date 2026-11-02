const { paymentReferenceKey } = require('./payment-account')
const { confirmedBinding, bindingMatches } = require('./account-binding')

function lookup(mappings) {
  const common = [], byEvent = new Map(), byRow = new Map()
  for (const mapping of mappings || []) {
    if (!mapping.eventId) { common.push(mapping); continue }
    if (!byEvent.has(mapping.eventId)) byEvent.set(mapping.eventId, [])
    byEvent.get(mapping.eventId).push(mapping)
    for (const rowId of mapping.rowIds || []) {
      if (!byRow.has(rowId)) byRow.set(rowId, [])
      byRow.get(rowId).push(mapping)
    }
  }
  return { common, byEvent, byRow }
}

// 本批决定只能回到原成员的子集。合并后缺少完整依据时交人工处理，
// 不能把一个旧组的选择按名称或尾号广播到整个新组。
function forMembers(index, rowIds, references, eventId = null) {
  const candidates = new Set(eventId ? index.byEvent.get(eventId) || [] : [])
  for (const id of rowIds) for (const mapping of index.byRow.get(id) || []) candidates.add(mapping)
  const result = []
  for (const mapping of candidates) {
    if (mapping.eventId !== eventId && (!rowIds.length || !rowIds.every(id => (mapping.rowIds || []).includes(id)))) continue
    for (const reference of references) {
      if (mapping.sourceType !== reference.sourceType) continue
      const exact = paymentReferenceKey(mapping) === paymentReferenceKey(reference)
      const legacy = !mapping.binding && mapping.paymentMethodKey === reference.paymentMethodKey
      if (!(exact && (!reference.binding || bindingMatches(mapping, reference)) || legacy)) continue
      result.push({ ...mapping, eventId: null, mappingScope: 'batch',
        paymentMethodKey: reference.bindingKey || reference.paymentMethodKey,
        paymentMethodHint: reference.label || mapping.paymentMethodHint,
        binding: confirmedBinding(reference) || mapping.binding })
    }
  }
  return result
}
module.exports = { lookup, forMembers }
