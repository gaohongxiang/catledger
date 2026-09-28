const { ledgerError } = require('./ledger-errors')
const { validateId, parseVersion } = require('./transaction-domain')
const { loanOrigin } = require('./transaction-provenance')
const store = require('./loan-charge-store')

// 仅承接用户逐笔确认的旧归档费用；不把普通删除确认当作创建归属确认。
function parse(value, loan) {
  if (value === undefined) return new Map()
  if (!Array.isArray(value) || !value.length || value.length > 200 || loan.archivedAt == null) throw ledgerError('VALIDATION_ERROR')
  const entries = value.map(row => {
    if (!row || row.createdByThisPlan !== true) throw ledgerError('VALIDATION_ERROR')
    return [validateId(row.transactionId), parseVersion(row.version)]
  })
  const result = new Map(entries)
  if (result.size !== entries.length) throw ledgerError('VALIDATION_ERROR')
  return result
}

async function verify(c, uid, loan, contract, charges, transaction, version, storedProvenance) {
  if (transaction.version !== version) throw ledgerError('CONFLICT')
  const fee = charges.find(f => f.transactionId === transaction.transactionId)
  if (storedProvenance != null || transaction.provenance.kind !== 'unknown' || transaction.type !== 'expense' || !fee || !contract) throw ledgerError('LOAN_DELETE_BLOCKED')
  const [[evidence]] = await c.execute(`SELECT
    EXISTS(SELECT 1 FROM catledger_loan_charge_audit WHERE uid=? AND contract_id=? AND charge_id=?
      AND action='record_period_fee' AND JSON_UNQUOTE(JSON_EXTRACT(snapshot_json,'$.transactionId'))=?) AS periodAudit,
    EXISTS(SELECT 1 FROM catledger_loan_charge_audit WHERE uid=? AND contract_id=? AND action='claim_contract') AS changedOwner,
    EXISTS(SELECT 1 FROM catledger_loan_charge_sources WHERE uid=? AND charge_id=?) AS chargeSource,
    EXISTS(SELECT 1 FROM catledger_economic_event_transactions WHERE uid=? AND transaction_id=?) AS eventSource,
    EXISTS(SELECT 1 FROM catledger_loan_payment_transactions WHERE uid=? AND transaction_id=?) AS paymentSource,
    EXISTS(SELECT 1 FROM catledger_mutation_receipts WHERE uid=? AND action='transactions.create'
      AND JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.transactionId'))=?) AS independentCreation`, [
    uid, contract.contractId, fee.chargeId, transaction.transactionId, uid, contract.contractId,
    uid, fee.chargeId, uid, transaction.transactionId, uid, transaction.transactionId, uid, transaction.transactionId
  ])
  if (!Number(evidence.periodAudit) || ['changedOwner', 'chargeSource', 'eventSource', 'paymentSource', 'independentCreation'].some(k => Number(evidence[k]))) throw ledgerError('LOAN_DELETE_BLOCKED')
  return { transactionId: transaction.transactionId, version, chargeId: fee.chargeId, provenance: loanOrigin([loan.loanId]), evidence: 'user_confirmed_legacy_creation' }
}

async function record(c, uid, loan, contract, reviews) {
  for (const review of reviews) {
    const [result] = await c.execute(`UPDATE catledger_transactions SET creation_provenance_json=?
      WHERE uid=? AND transaction_id=? AND version=? AND creation_provenance_json IS NULL AND deleted_at IS NULL`,
    [JSON.stringify({ ...review.provenance, evidence: review.evidence }), uid, review.transactionId, review.version])
    if (result.affectedRows !== 1) throw ledgerError('CONFLICT')
    await store.audit(c, uid, contract.contractId, review.chargeId, 'confirm_creation', {
      loanId: loan.loanId, transactionId: review.transactionId, transactionVersion: review.version,
      previousProvenance: null, provenance: review.provenance, evidence: review.evidence, command: 'loans.delete'
    })
  }
}

module.exports = { parse, verify, record }
