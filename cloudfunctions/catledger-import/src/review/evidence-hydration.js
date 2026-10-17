function hydrateEvidence(events, rows, links) {
  const byId = new Map(rows.map(row => [row.rowId, row]))
  const rowsByEvent = new Map()
  for (const link of links) {
    if (!rowsByEvent.has(link.eventId)) rowsByEvent.set(link.eventId, [])
    if (byId.has(link.rowId)) rowsByEvent.get(link.eventId).push({ ...byId.get(link.rowId), identityKind: link.identityKind })
  }
  return events.map(event => ({ ...event, sourceType: (rowsByEvent.get(event.eventId) || [])[0]?.sourceType,
    relationEvidence: { rows: rowsByEvent.get(event.eventId) || [] } }))
}

function hasBankPlatformEvidence(events) {
  const types = new Set(events.flatMap(event => event.relationEvidence.rows.map(row => row.sourceType)))
  return types.has('bank') && (types.has('wechat') || types.has('alipay'))
}

module.exports = { hydrateEvidence, hasBankPlatformEvidence }
