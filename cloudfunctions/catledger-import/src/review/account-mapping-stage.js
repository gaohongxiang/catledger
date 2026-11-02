const { randomUUID } = require('node:crypto')
const { chunks, insertMany } = require('../sql-batch')
const { importError } = require('../errors')
const { unique } = require('../organizer-values')
const { paymentReferenceKey } = require('../payment-account')
const { ledgerAccountReferenceForRow } = require('../source-funds')
const { mappingRow, saveMappings } = require('./account-binding-store')
const { setMappingDecision } = require('../account-mapping-policy')

async function stageAccountMappings(
  connection, uid, updateId, eventIds, accountId, actionId,
  mappingAction = 'account', mappingIndex = null
) {
  if (eventIds.length === 0) return []
  if (!['account', 'external', 'ignore'].includes(mappingAction)) throw importError('VALIDATION_ERROR')
  if ((mappingAction === 'account') !== Boolean(accountId)) throw importError('VALIDATION_ERROR')
  const rows = []
  for (const part of chunks([...new Set(eventIds)].sort().map(id => [id]))) {
    const [found] = await connection.execute(
      `SELECT DISTINCT ee.event_id AS eventId, r.row_id AS rowId, r.batch_id AS batchId,
            s.import_id AS importId, profile.profile_key AS sourceProfileKey,
            r.currency, r.semantic_json AS semantic,
            JSON_UNQUOTE(JSON_EXTRACT(batch.analysis_json,'$.bankMapping.statementKind')) AS bankStatementKind,
            s.source_type_snapshot AS sourceType,
            r.payment_method_key AS paymentMethodKey,
            r.payment_method_raw AS paymentMethod
       FROM catledger_event_evidence ee
       JOIN catledger_import_rows r ON r.uid = ee.uid AND r.row_id = ee.row_id
       JOIN catledger_finance_update_sources s
         ON s.uid = ee.uid AND s.update_id = ee.update_id AND s.batch_id = r.batch_id
       JOIN catledger_import_batches batch ON batch.uid=r.uid AND batch.batch_id=r.batch_id
       LEFT JOIN catledger_import_source_profiles profile
         ON profile.uid=s.uid AND profile.source_profile_id=s.source_profile_id
      WHERE ee.uid = ? AND ee.update_id = ?
        AND ee.event_id IN (${part.map(() => '?').join(', ')})
        AND ee.evidence_role <> 'discarded' AND r.payment_method_key IS NOT NULL`,
      [uid, updateId, ...part.flat()]
    )
    rows.push(...found.map(row => ({ ...row, semantic: typeof row.semantic === 'string' ? JSON.parse(row.semantic) : row.semantic })))
  }
  if (mappingAction === 'ignore' && rows.length === 0) throw importError('VALIDATION_ERROR')
  const references = rows.map(row => ({ eventId: row.eventId, reference: ledgerAccountReferenceForRow(row) })).filter(row => row.reference)
  const records = new Map()
  for (const { eventId, reference } of references) {
    records.set(eventId + ':' + paymentReferenceKey(reference), mappingRow(uid, updateId, eventId, reference, accountId, actionId, mappingAction))
    setMappingDecision(mappingIndex, reference, mappingAction, accountId, eventId)
  }
  await saveMappings(connection, [...records.values()])
  const paymentReferenceKeys = unique(references.map(row => paymentReferenceKey(row.reference)))
  return paymentReferenceKeys
}

module.exports = { stageAccountMappings }
