const { randomUUID } = require('node:crypto')
const { confirmedBinding } = require('../account-binding')
const { paymentReferenceKey, safeDisplayName } = require('../payment-account')
const { setMappingDecision } = require('../account-mapping-policy')
const { insertMany } = require('../sql-batch')
const { importError } = require('../errors')

const INSERT = `INSERT INTO catledger_finance_update_account_mapping_drafts
  (uid,draft_mapping_id,update_id,event_id,source_type,payment_method_key,payment_method_hint,
   mapping_action,account_id,action_id,binding_json) VALUES`
const UPDATE = ` ON DUPLICATE KEY UPDATE payment_method_hint=VALUES(payment_method_hint),
  mapping_action=VALUES(mapping_action),account_id=VALUES(account_id),action_id=VALUES(action_id),
  binding_json=VALUES(binding_json)`

function mappingRow(uid, updateId, eventId, reference, accountId, actionId, mappingAction = 'account') {
  if (!reference?.sourceType || !reference.paymentMethodKey || !['account','external','ignore'].includes(mappingAction) ||
      (mappingAction === 'account') !== Boolean(accountId)) throw importError('VALIDATION_ERROR')
  const proof = confirmedBinding(reference)
  return [uid, randomUUID(), updateId, eventId, reference.sourceType, reference.bindingKey || reference.paymentMethodKey,
    safeDisplayName(reference.label || reference.value || '').slice(0, 128), mappingAction, accountId || null,
    actionId, proof ? JSON.stringify(proof) : null]
}

async function saveMappings(connection, rows) { await insertMany(connection, INSERT, rows, UPDATE) }

async function stageReference(connection, uid, updateId, eventId, reference, accountId, actionId,
  mappingAction = 'account', mappingIndex = null, pendingRows = null) {
  if (reference?.memberRole && !reference.paymentMethodKey) return ''
  const row = mappingRow(uid, updateId, eventId, reference, accountId, actionId, mappingAction)
  if (pendingRows) pendingRows.push(row)
  else await saveMappings(connection, [row])
  setMappingDecision(mappingIndex, reference, mappingAction, accountId, eventId)
  return paymentReferenceKey(reference)
}

module.exports = { mappingRow, saveMappings, stageReference }
