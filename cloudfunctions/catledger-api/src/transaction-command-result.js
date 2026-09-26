const { executeLedgerRead } = require('./ledger-read')
const { digestIdempotencyKey } = require('./request-digest')
const { ledgerError } = require('./ledger-errors')
const ACTIONS = new Set(['loans.syncCharges', 'loans.configureCharges', 'loans.pauseCharges', 'loans.setInstallmentProgress', 'loans.linkInstallmentSource', 'loans.archiveInstallment', 'loans.removeInstallmentItem', 'loans.create', 'loans.update', 'loans.record', 'loans.reverse', 'loans.correct', 'loans.savePeriod', 'loans.allocatePeriods', 'loans.generatePlan', 'transactions.create', 'transactions.update', 'transactions.delete', 'transactions.deleteMany', 'transactions.linkRefund', 'transactions.setCategory'])
function createCommandResult({ getPool }) {
  return context => {
    const { requestId, commandAction } = context.data
    if (!ACTIONS.has(commandAction)) throw ledgerError('VALIDATION_ERROR')
    const receiptId = digestIdempotencyKey(requestId)
    return executeLedgerRead({ getPool, ...context, operation: async (connection, uid) => {
      const [[row]] = await connection.execute(`SELECT action, result_json AS result FROM catledger_mutation_receipts
        WHERE uid = ? AND idempotency_key_digest = ?`, [uid, receiptId])
      if (!row || row.action !== commandAction || row.result == null) throw ledgerError('OPERATION_UNCONFIRMED')
      return { action: row.action, receiptId, result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result }
    } })
  }
}
module.exports = { createCommandResult }
