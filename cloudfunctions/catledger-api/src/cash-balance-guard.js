const { ledgerError } = require('./ledger-errors')
const { minorUnitsToString } = require('./money')

function transactionDeltas(transaction, multiplier = 1n) {
  const amount = BigInt(minorUnitsToString(transaction.amountMinor)) * multiplier
  const deltas = new Map()
  if (transaction.sourceAccountId) {
    deltas.set(transaction.sourceAccountId, (deltas.get(transaction.sourceAccountId) || 0n) - amount)
  }
  if (transaction.destinationAccountId) {
    deltas.set(transaction.destinationAccountId, (deltas.get(transaction.destinationAccountId) || 0n) + amount)
  }
  return deltas
}

function mergeDeltas(target, source) {
  for (const [accountId, delta] of source) {
    target.set(accountId, (target.get(accountId) || 0n) + delta)
  }
  return target
}

async function queryBookBalance(connection, uid, accountId) {
  const [[row]] = await connection.execute(
    `SELECT COALESCE(SUM(entries.delta_minor), 0) AS bookBalance
       FROM (
         SELECT CAST(amount_minor AS DECIMAL(20, 0)) AS delta_minor
           FROM catledger_transactions
          WHERE uid = ? AND destination_account_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT -CAST(amount_minor AS DECIMAL(20, 0)) AS delta_minor
           FROM catledger_transactions
          WHERE uid = ? AND source_account_id = ? AND deleted_at IS NULL
       ) entries`,
    [uid, accountId, uid, accountId]
  )
  return BigInt(minorUnitsToString(row.bookBalance))
}

async function assertCashBalanceChanges(connection, uid, accounts, changes) {
  const deltas = new Map()
  for (const change of changes) {
    mergeDeltas(deltas, transactionDeltas(change.transaction, change.multiplier == null ? 1n : change.multiplier))
  }

  for (const [accountId, delta] of deltas) {
    const account = accounts.get(accountId)
    if (!account || account.type !== 'cash' || delta === 0n) continue
    const current = await queryBookBalance(connection, uid, accountId)
    const projected = current + delta
    // Historical invalid balances remain visible and auditable. A correction or
    // incoming transaction may improve them, but no write may create or deepen
    // a cash deficit.
    if (projected < 0n && projected < current) {
      throw ledgerError('INSUFFICIENT_CASH_BALANCE')
    }
  }
}

module.exports = {
  assertCashBalanceChanges,
  queryBookBalance,
  transactionDeltas
}
