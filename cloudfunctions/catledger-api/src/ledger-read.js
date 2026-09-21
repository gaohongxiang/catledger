const { resolveUid } = require('./ledger-transaction')
const { ledgerError } = require('./ledger-errors')
const { metadata } = require('./read-contract')
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
  read,
  operation
}) {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    let connection
    let transactionStarted = false
    try {
      connection = await getPool().getConnection()
      if (consistentSnapshot || read) {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await connection.query('START TRANSACTION READ ONLY')
        transactionStarted = true
      }

      let uid, view
      if (read) {
        const [[identity]] = await connection.execute(`SELECT i.uid, CAST(u.data_revision AS CHAR) AS dataRevision
          FROM catledger_user_identities i JOIN catledger_users u ON u.uid=i.uid
          WHERE i.provider=? AND i.subject_hash=? AND u.status='active' LIMIT 1`, [provider, subjectHash])
        if (!identity) throw ledgerError('INITIALIZATION_REQUIRED')
        uid = identity.uid
        view = metadata(uid, identity.dataRevision, read.knownRevision === identity.dataRevision)
      } else uid = await resolveUid(connection, provider, subjectHash)
      const payload = view && view.unchanged ? null : await operation(connection, uid, view && view.dataRevision)
      const result = view ? { ...payload, ...view } : payload

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
