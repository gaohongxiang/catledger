const { ledgerError } = require('./ledger-errors')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { assertNoLoanTransactions } = require('./loan-transaction-guard')
const { assertCashBalanceChanges } = require('./cash-balance-guard')
const { MANUAL_TYPES, validateId, parseVersion } = require('./transaction-domain')
const { lockAccounts } = require('./transaction-command-service')

function selection(items) {
  if (!Array.isArray(items) || !items.length) throw ledgerError('VALIDATION_ERROR')
  const versions = new Map()
  for (const item of items) {
    if (!item || typeof item !== 'object') throw ledgerError('VALIDATION_ERROR')
    const id = validateId(item.transactionId)
    if (versions.has(id)) throw ledgerError('VALIDATION_ERROR')
    versions.set(id, parseVersion(item.version))
  }
  return versions
}

function* chunks(ids) {
  for (let offset = 0; offset < ids.length; offset += 100) yield ids.slice(offset, offset + 100)
}

function createBatchDelete({ getPool }) {
  return context => executeIdempotentMutation({ getPool, ...context, action: 'transactions.deleteMany',
    operation: async (connection, uid, data) => {
      const versions = selection(data.items), ids = [...versions.keys()].sort()
      const rows = []
      for (const part of chunks(ids)) {
        const [selected] = await connection.execute(`SELECT transaction_id AS transactionId, type, origin, version,
          source_account_id AS sourceAccountId, destination_account_id AS destinationAccountId, amount_minor AS amountMinor
          FROM catledger_transactions WHERE uid = ? AND transaction_id IN (${part.map(() => '?').join(', ')}) AND deleted_at IS NULL
          ORDER BY transaction_id FOR UPDATE`, [uid, ...part])
        rows.push(...selected)
      }
      if (rows.length !== ids.length) throw ledgerError('NOT_FOUND')
      if (rows.some(row => Number(row.version) !== versions.get(row.transactionId))) throw ledgerError('CONFLICT')
      await assertNoLoanTransactions(connection, uid, ids)
      if (rows.some(row => !['manual', 'import'].includes(row.origin) || !MANUAL_TYPES.has(row.type))) throw ledgerError('NOT_FOUND')
      // 按整组判断：退款与原消费可以一起删除，组外退款不能失去原消费。
      for (const part of chunks(ids)) {
        const [refunds] = await connection.execute(`SELECT transaction_id AS transactionId FROM catledger_transactions
          WHERE uid = ? AND original_transaction_id IN (${part.map(() => '?').join(', ')}) AND type = 'refund' AND deleted_at IS NULL
          FOR UPDATE`, [uid, ...part])
        if (refunds.some(row => !versions.has(row.transactionId))) throw ledgerError('REFUNDED_TRANSACTION_LOCKED')
      }
      const accounts = await lockAccounts(connection, uid, rows.flatMap(row => [row.sourceAccountId, row.destinationAccountId]), { allowArchived: true })
      await assertCashBalanceChanges(connection, uid, accounts, rows.map(transaction => ({ transaction, multiplier: -1n })))
      // 所有分块共用 executeIdempotentMutation 的用户锁、连接和事务，只在全部完成后提交。
      for (const part of chunks(ids)) {
        const [result] = await connection.execute(`UPDATE catledger_transactions
          SET deleted_at = CURRENT_TIMESTAMP(3), version = version + 1
          WHERE uid = ? AND transaction_id IN (${part.map(() => '?').join(', ')}) AND deleted_at IS NULL`, [uid, ...part])
        if (result.affectedRows !== part.length) throw ledgerError('CONFLICT')
      }
      return { deleted: true, deletedCount: ids.length, transactionIds: ids }
    }
  })
}

module.exports = { createBatchDelete }
