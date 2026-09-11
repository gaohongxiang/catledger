const { hasSourceIdentityConflict } = require('./evidence-matching')
const { importError } = require('./errors')

async function assertIdentityIntegrity(connection, uid, updateId, eventIds, { merge = false } = {}) {
  if (!eventIds.length) return
  const [rows] = await connection.execute(
    `SELECT e.event_id AS eventId, r.identity_id AS identityId,
            i.source_type AS sourceType, i.source_profile_id AS sourceProfileId, i.identity_kind AS identityKind
       FROM catledger_event_evidence e
       JOIN catledger_import_rows r ON r.uid = e.uid AND r.row_id = e.row_id
       JOIN catledger_source_identities i ON i.uid = r.uid AND i.identity_id = r.identity_id
      WHERE e.uid = ? AND e.update_id = ? AND e.evidence_role <> 'discarded'
        AND e.event_id IN (${eventIds.map(() => '?').join(', ')})`,
    [uid, updateId, ...eventIds]
  )
  const groups = new Map()
  for (const row of rows) {
    const key = merge ? 'merged' : row.eventId
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  if ([...groups.values()].some(hasSourceIdentityConflict)) throw importError('IDENTITY_CONFLICT')
}

module.exports = { assertIdentityIntegrity }
