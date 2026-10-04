const { selectPlanningRows } = require('../finance-update-repository')
const { selectDomainEvents } = require('./event-store')

async function hydrate(connection, uid, updateId, events = null, rows = null, { forUpdate = true } = {}) {
  rows = rows || await selectPlanningRows(connection, uid, updateId)
  const [links] = await connection.execute(`SELECT e.event_id AS eventId, e.row_id AS rowId, e.evidence_id AS evidenceId,
    e.evidence_role AS role, i.identity_kind AS identityKind FROM catledger_event_evidence e
    JOIN catledger_import_rows r ON r.uid = e.uid AND r.row_id = e.row_id
    LEFT JOIN catledger_source_identities i ON i.uid = r.uid AND i.identity_id = r.identity_id
    WHERE e.uid = ? AND e.update_id = ? AND e.evidence_role <> 'discarded'
    ORDER BY (e.evidence_role = 'primary') DESC, e.evidence_id`, [uid, updateId])
  events = events || await selectDomainEvents(connection, uid, updateId, [...new Set(links.map(link => link.eventId))], { forUpdate })
  return hydrateEvidence(events, rows, links)
}

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

module.exports = { hydrate, hydrateEvidence, hasBankPlatformEvidence }
