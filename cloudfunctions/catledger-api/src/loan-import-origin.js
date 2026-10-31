const { validateId } = require('./transaction-domain')
const { ledgerError } = require('./ledger-errors')

// 创建回执是草稿清理的依据；客户端传来的 loanId 或 action:create 不能证明创建来源。
async function importOrigin(connection, uid, data) {
  if (data.importOrigin == null) return null
  const origin = data.importOrigin
  if (!origin || typeof origin !== 'object' || Array.isArray(origin) || data.kind !== 'installment' ||
      data.generatePlan !== true || data.sourceItemId != null || data.chargeContractId != null ||
      data.originKind != null || data.repayments != null || data.coverage != null || data.oneOffCharges != null) {
    throw ledgerError('VALIDATION_ERROR')
  }
  const updateId = validateId(origin.updateId), eventId = validateId(origin.eventId)
  const [[source]] = await connection.execute(`SELECT u.status AS updateStatus,e.status,
      JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.disbursement.role')) AS role
    FROM catledger_economic_events e JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id
    WHERE e.uid=? AND e.update_id=? AND e.event_id=?`, [uid, updateId, eventId])
  if (!source || source.updateStatus !== 'review' || !['ready', 'needs_action'].includes(source.status) ||
      !['disbursement', 'registration'].includes(source.role)) throw ledgerError('CONFLICT')
  return { updateId, eventId }
}

module.exports = { importOrigin }
