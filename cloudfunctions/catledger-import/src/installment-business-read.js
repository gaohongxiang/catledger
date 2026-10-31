const { visibleSql } = require('./installment-business')
async function partners(connection, uid, updateId, eventIds) {
  if (!eventIds.length) return []
  const [rows] = await connection.execute(`SELECT main_link.event_id AS mainEventId,e.event_id AS offsetEventId,
    COUNT(*) AS evidenceCount FROM catledger_economic_events e
    JOIN catledger_event_evidence main_link ON main_link.uid=e.uid AND main_link.update_id=e.update_id
      AND main_link.row_id=JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.disbursement.partnerRowId'))
      AND main_link.evidence_role<>'discarded'
    JOIN catledger_event_evidence offset_link ON offset_link.uid=e.uid AND offset_link.update_id=e.update_id
      AND offset_link.event_id=e.event_id AND offset_link.evidence_role<>'discarded'
    WHERE e.uid=? AND e.update_id=? AND main_link.event_id IN (${eventIds.map(() => '?').join(',')})
      AND NOT (${visibleSql('e')}) GROUP BY main_link.event_id,e.event_id`, [uid, updateId, ...eventIds])
  return rows
}
async function evidenceEventIds(connection, uid, updateId, eventId) {
  return [eventId, ...(await partners(connection, uid, updateId, [eventId])).map(row => row.offsetEventId)]
}
async function attachCounts(connection, uid, updateId, rows) {
  const primary = rows.filter(row => {
    const fields = typeof row.fieldSources === 'string' ? JSON.parse(row.fieldSources) : row.fieldSources
    return fields && fields.disbursement && fields.disbursement.role === 'disbursement'
  })
  if (!primary.length) return
  const grouped = await partners(connection, uid, updateId, primary.map(row => row.eventId))
  for (const row of primary) row.evidenceCount = Number(row.evidenceCount || 0) + grouped
    .filter(value => value.mainEventId === row.eventId).reduce((sum, value) => sum + Number(value.evidenceCount), 0)
}
module.exports = { partners, evidenceEventIds, attachCounts }
