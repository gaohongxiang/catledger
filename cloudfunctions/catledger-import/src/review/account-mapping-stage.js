const { randomUUID } = require('node:crypto')
const { chunks, insertMany } = require('../sql-batch')
const { importError } = require('../errors')
const { unique } = require('../organizer-values')
const { paymentReferenceKey } = require('../payment-account')

async function stageAccountMappings(
  connection, uid, updateId, eventIds, accountId, actionId,
  mappingAction = 'account', mappingIndex = null
) {
  if (eventIds.length === 0) return []
  if (!['account', 'ignore'].includes(mappingAction)) throw importError('VALIDATION_ERROR')
  if ((mappingAction === 'account') !== Boolean(accountId)) throw importError('VALIDATION_ERROR')
  const rows = []
  for (const part of chunks([...new Set(eventIds)].sort().map(id => [id]))) {
    const [found] = await connection.execute(
      `SELECT DISTINCT ee.event_id AS eventId,
            s.source_type_snapshot AS sourceType,
            r.payment_method_key AS paymentMethodKey,
            r.payment_method_raw AS paymentMethod
       FROM catledger_event_evidence ee
       JOIN catledger_import_rows r ON r.uid = ee.uid AND r.row_id = ee.row_id
       JOIN catledger_finance_update_sources s
         ON s.uid = ee.uid AND s.update_id = ee.update_id AND s.batch_id = r.batch_id
      WHERE ee.uid = ? AND ee.update_id = ?
        AND ee.event_id IN (${part.map(() => '?').join(', ')})
        AND ee.evidence_role <> 'discarded' AND r.payment_method_key IS NOT NULL`,
      [uid, updateId, ...part.flat()]
    )
    rows.push(...found)
  }
  if (mappingAction === 'ignore' && rows.length === 0) throw importError('VALIDATION_ERROR')
  await insertMany(connection, `INSERT INTO catledger_finance_update_account_mapping_drafts
    (uid, draft_mapping_id, update_id, event_id, source_type, payment_method_key, payment_method_hint, mapping_action, account_id, action_id) VALUES`,
    rows.map(row => [uid, randomUUID(), updateId, row.eventId, row.sourceType, row.paymentMethodKey,
        String(row.paymentMethod || '').slice(0, 128), mappingAction, accountId, actionId]),
    ` ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint), mapping_action = VALUES(mapping_action),
    account_id = VALUES(account_id), action_id = VALUES(action_id)`)
  const paymentReferenceKeys = unique(rows.map(paymentReferenceKey))
  if (mappingIndex) {
    for (const key of paymentReferenceKeys) mappingIndex.set(key, mappingAction === 'account' ? accountId : null)
  }
  return paymentReferenceKeys
}

module.exports = { stageAccountMappings }
