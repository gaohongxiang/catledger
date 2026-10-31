// 两个来源事件仍独立保存；只有安全合卡的对行同步计划归属。
const { hiddenOffset, indexByRow } = require('../installment-business')

async function partnerEventId(connection, uid, updateId, event) {
  const hint = event && event.fieldSources && event.fieldSources.disbursement
  if (!hint || hint.role !== 'disbursement' || !hint.partnerRowId) return null
  const [[row]] = await connection.execute(
    `SELECT event_id AS eventId FROM catledger_event_evidence
      WHERE uid = ? AND update_id = ? AND row_id = ? AND event_id <> ? AND evidence_role<>'discarded' LIMIT 1`,
    [uid, updateId, hint.partnerRowId, event.eventId]
  )
  return row && row.eventId || null
}

// 与放款行保持同一份决定；没有变化时不写，避免每保存一次就抬一次对行版本。
async function mirrorPlan(connection, uid, updateId, event, plan) {
  const eventId = await partnerEventId(connection, uid, updateId, event)
  if (!eventId) return null
  const [[row]] = await connection.execute(
    `SELECT e.event_id AS eventId,e.update_id AS updateId,e.version,e.status,e.economic_nature AS economicNature,
      e.manual_field_mask AS manualFieldMask,e.reason_codes_json AS reasonCodes,e.field_sources_json AS fieldSources,
      EXISTS (SELECT 1 FROM catledger_economic_event_transactions t WHERE t.uid=e.uid AND t.event_id=e.event_id AND t.superseded_at IS NULL) AS hasTransaction
      FROM catledger_economic_events e WHERE e.uid = ? AND e.update_id = ? AND e.event_id = ? FOR UPDATE`, [uid, updateId, eventId])
  if (!row) return null
  const sources = typeof row.fieldSources === 'string' ? JSON.parse(row.fieldSources) : row.fieldSources || {}
  const offset = { ...row, fieldSources: sources, hasTransaction: Boolean(Number(row.hasTransaction)),
    reasonCodes: typeof row.reasonCodes === 'string' ? JSON.parse(row.reasonCodes) : row.reasonCodes || [] }
  if (!hiddenOffset(offset, indexByRow([event, offset]))) return null
  const next = plan || null
  if (JSON.stringify(sources.installmentPlan || null) === JSON.stringify(next)) return eventId
  if (next) sources.installmentPlan = next
  else delete sources.installmentPlan
  await connection.execute(
    `UPDATE catledger_economic_events SET field_sources_json = ?, version = version + 1
      WHERE uid = ? AND update_id = ? AND event_id = ? AND version = ?`,
    [JSON.stringify(sources), uid, updateId, eventId, row.version])
  return eventId
}

module.exports = { mirrorPlan }
