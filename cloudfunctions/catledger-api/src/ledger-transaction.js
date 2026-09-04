const { ledgerError } = require('./ledger-errors')
const { digestIdempotencyKey, digestRequest } = require('./request-digest')
const {
  isRetryableDatabaseError,
  safeRollback,
  waitBeforeDatabaseRetry
} = require('./database-errors')

const MAX_ATTEMPTS = 4

async function resolveUid(connection, provider, subjectHash) {
  const [rows] = await connection.execute(
    `SELECT i.uid
       FROM catledger_user_identities i
       JOIN catledger_users u ON u.uid = i.uid
      WHERE i.provider = ? AND i.subject_hash = ? AND u.status = 'active'
      LIMIT 1`,
    [provider, subjectHash]
  )

  if (!rows[0]) {
    throw ledgerError('INITIALIZATION_REQUIRED')
  }

  return rows[0].uid
}

function parseStoredResult(value) {
  if (typeof value === 'string') {
    return JSON.parse(value)
  }
  return value
}

async function replayMutation({ getPool, provider, subjectHash, keyDigest, action, requestDigest }) {
  const connection = await getPool().getConnection()
  try {
    const uid = await resolveUid(connection, provider, subjectHash)
    const [rows] = await connection.execute(
      `SELECT action, request_digest AS requestDigest, result_json AS result
         FROM catledger_mutation_receipts
        WHERE uid = ? AND idempotency_key_digest = ?
        LIMIT 1`,
      [uid, keyDigest]
    )
    const receipt = rows[0]

    if (!receipt || receipt.action !== action || receipt.requestDigest !== requestDigest || receipt.result == null) {
      throw ledgerError('IDEMPOTENCY_CONFLICT')
    }

    return parseStoredResult(receipt.result)
  } finally {
    connection.release()
  }
}

async function executeIdempotentMutation({
  getPool,
  provider,
  subjectHash,
  action,
  data,
  operation
}) {
  const keyDigest = digestIdempotencyKey(data && data.requestId)
  const requestData = { ...data }
  delete requestData.requestId
  const requestDigest = digestRequest(action, requestData)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let connection
    let transactionStarted = false

    try {
      connection = await getPool().getConnection()
      await connection.beginTransaction()
      transactionStarted = true
      const uid = await resolveUid(connection, provider, subjectHash)

      try {
        await connection.execute(
          `INSERT INTO catledger_mutation_receipts
             (uid, idempotency_key_digest, action, request_digest)
           VALUES (?, ?, ?, ?)`,
          [uid, keyDigest, action, requestDigest]
        )
      } catch (error) {
        if (error && error.code === 'ER_DUP_ENTRY') {
          await connection.rollback()
          transactionStarted = false
          return replayMutation({
            getPool,
            provider,
            subjectHash,
            keyDigest,
            action,
            requestDigest
          })
        }
        throw error
      }

      const result = await operation(connection, uid, requestData)
      await connection.execute(
        `UPDATE catledger_mutation_receipts
            SET result_json = ?
          WHERE uid = ? AND idempotency_key_digest = ?`,
        [JSON.stringify(result), uid, keyDigest]
      )
      await connection.commit()
      transactionStarted = false
      return result
    } catch (error) {
      if (transactionStarted) await safeRollback(connection)

      if (isRetryableDatabaseError(error) && attempt + 1 < MAX_ATTEMPTS) {
        await waitBeforeDatabaseRetry(attempt)
        continue
      }

      throw error
    } finally {
      if (connection) connection.release()
    }
  }

  throw new Error('Ledger mutation attempts exhausted')
}

module.exports = {
  executeIdempotentMutation,
  resolveUid
}
