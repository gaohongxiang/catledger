const { importError } = require('./errors')
// 调用者已取得同一用户锁；分块保护整组正式交易，不能只改其中一项。
async function assertNoLoanTransactions(connection, uid, transactionIds) {
  const ids = [...new Set(transactionIds.filter(Boolean))]
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100)
    await require('./loan-charge-store').assertNoCharges(connection, uid, chunk)
    const [[row]] = await connection.execute(`SELECT payment_id FROM catledger_loan_payment_transactions
      WHERE uid=? AND active_transaction_id IN (${chunk.map(() => '?').join(',')}) LIMIT 1`, [uid, ...chunk])
    if (row) throw importError('LOAN_TRANSACTION_LOCKED')
  }
}
module.exports = { assertNoLoanTransactions }
