const { ledgerError } = require('./ledger-errors')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { assertCashBalanceChanges } = require('./cash-balance-guard')
const { validateId, parseVersion } = require('./transaction-domain')
const { lockAccounts } = require('./transaction-command-service')
const { chunks, ensureDeletable, assertDeleteRange, permanentlyDelete } = require('./transaction-permanent-delete')

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
      await assertDeleteRange(connection, uid, ids)
      for (const row of rows) ensureDeletable(row, versions.get(row.transactionId))
      const accounts = await lockAccounts(connection, uid, rows.flatMap(row => [row.sourceAccountId, row.destinationAccountId]), { allowArchived: true })
      await assertCashBalanceChanges(connection, uid, accounts, rows.map(transaction => ({ transaction, multiplier: -1n })))
      // 所有分块共用 executeIdempotentMutation 的用户锁、连接和事务，只在全部完成后提交。
      await permanentlyDelete(connection, uid, rows)
      return { deleted: true, deletedCount: ids.length, transactionIds: ids }
    }
  })
}

module.exports = { createBatchDelete }
