const { resolveUid } = require('./ledger-transaction')

async function executeLedgerRead({
  getPool,
  provider,
  subjectHash,
  consistentSnapshot = false,
  operation
}) {
  const connection = await getPool().getConnection()
  let transactionStarted = false

  try {
    if (consistentSnapshot) {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await connection.query('START TRANSACTION READ ONLY')
      transactionStarted = true
    }

    const uid = await resolveUid(connection, provider, subjectHash)
    const result = await operation(connection, uid)

    if (transactionStarted) {
      await connection.commit()
      transactionStarted = false
    }
    return result
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback()
    }
    throw error
  } finally {
    connection.release()
  }
}

module.exports = { executeLedgerRead }
