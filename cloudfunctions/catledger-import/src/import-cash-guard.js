const { importError } = require('./errors')

async function queryCashBalances(connection, uid, accounts) {
  const balances = new Map()
  for (const account of accounts.values()) {
    if (account.type !== 'cash') continue
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
      [uid, account.accountId, uid, account.accountId]
    )
    balances.set(account.accountId, BigInt(String(row.bookBalance)))
  }
  return balances
}

async function assertCashBalancesNotWorsened(connection, uid, accounts, beforeBalances) {
  const afterBalances = await queryCashBalances(connection, uid, accounts)
  for (const [accountId, after] of afterBalances) {
    const before = beforeBalances.get(accountId) || 0n
    if (after < 0n && after < before) throw importError('INSUFFICIENT_CASH_BALANCE')
  }
}

module.exports = { queryCashBalances, assertCashBalancesNotWorsened }
