const { executeLedgerRead } = require('./ledger-read')
const { digestIdempotencyKey } = require('./request-digest')
const { ledgerError } = require('./ledger-errors')
const ACTIONS = new Set(['accounts.archive', 'accounts.restore', 'accounts.remove', 'loans.delete', 'loans.recordUpfrontFee','loans.changeCharge','loans.endCharges', 'loans.syncCharges', 'loans.configureCharges', 'loans.pauseCharges', 'loans.setInstallmentProgress', 'loans.confirmInstallments', 'loans.linkInstallmentSource', 'loans.reconcileInstallmentSources', 'loans.archiveInstallment', 'loans.removeInstallmentItem', 'loans.create', 'loans.update', 'loans.record', 'loans.reverse', 'loans.correct', 'loans.savePeriod', 'loans.allocatePeriods', 'loans.generatePlan', 'loans.rebuildPlan', 'transactions.create', 'transactions.update', 'transactions.delete', 'transactions.deleteMany', 'transactions.linkRefund', 'transactions.setCategory'])
function createCommandResult({ getPool }) {
  return context => {
    const { requestId, commandAction } = context.data
    if (!ACTIONS.has(commandAction)) throw ledgerError('VALIDATION_ERROR')
    const receiptId = digestIdempotencyKey(requestId)
    return executeLedgerRead({ getPool, ...context, operation: async (connection, uid) => {
      const [[row]] = await connection.execute(`SELECT action, result_json AS result FROM catledger_mutation_receipts
        WHERE uid = ? AND idempotency_key_digest = ?`, [uid, receiptId])
      // 关键区分：查无此回执=该请求从未成功落库（幂等回执只在成功后写入），返回 found:false 让前端安全丢弃僵尸包，
      // 而不是抛 OPERATION_UNCONFIRMED 把"从未发生"误判成"结果未知"、永久卡住后续写入。
      if (!row || row.result == null) return { action: commandAction, receiptId, found: false, result: null }
      // 同一 requestId 却对应别的动作=身份/键冲突，仍按未确认处理，交给上层核对。
      if (row.action !== commandAction) throw ledgerError('OPERATION_UNCONFIRMED')
      return { action: row.action, receiptId, found: true, result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result }
    } })
  }
}
module.exports = { createCommandResult }
