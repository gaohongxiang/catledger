const { resolveUid } = require('./ledger-transaction')
const {
  isRetryableDatabaseError,
  safeRollback,
  waitBeforeDatabaseRetry
} = require('./database-errors')

const MAX_READ_ATTEMPTS = 2

async function executeLedgerRead({
  getPool,
  provider,
  subjectHash,
  consistentSnapshot = false,
  operation
}) {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    let connection
    let transactionStarted = false
    try {
      connection = await getPool().getConnection()
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
      if (transactionStarted) await safeRollback(connection)
      if (isRetryableDatabaseError(error) && attempt + 1 < MAX_READ_ATTEMPTS) {
        await waitBeforeDatabaseRetry(attempt)
        continue
      }
      throw error
    } finally {
      if (connection) connection.release()
    }
  }

  throw new Error('Ledger read attempts exhausted')
}

module.exports = { executeLedgerRead }
