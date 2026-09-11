const { encodeReceipt, readReceipt } = require('./import-receipt')
const { digestIdempotencyKey, digestRequest } = require('./digest')
const { importError } = require('./errors')
const {
  isRetryableDatabaseError,
  safeRollback,
  waitBeforeDatabaseRetry
} = require('./database-errors')

const MAX_ATTEMPTS = 4
const MAX_READ_ATTEMPTS = 2

async function resolveUid(connection, provider, subjectHash) {
  const [rows] = await connection.execute(
    `SELECT i.uid
       FROM catledger_user_identities i
       JOIN catledger_users u ON u.uid = i.uid
      WHERE i.provider = ? AND i.subject_hash = ? AND u.status = 'active'
      LIMIT 1`,
    [provider, subjectHash]
  )
  if (!rows[0]) throw importError('INITIALIZATION_REQUIRED')
  return rows[0].uid
}

async function replayMutation({ getPool, provider, subjectHash, keyDigest, action, requestDigest, readIssue }) {
  const connection = await getPool().getConnection()
  try {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
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
      throw importError('IDEMPOTENCY_CONFLICT')
    }
    const result = await readReceipt(connection, uid, receipt.result, readIssue)
    await connection.commit()
    return result
  } catch (error) {
    await safeRollback(connection)
    throw error
  } finally {
    connection.release()
  }
}

async function executeIdempotentMutation({ getPool, provider, subjectHash, action, data, operation, currentReads = false, readIssue }) {
  const keyDigest = digestIdempotencyKey(data && data.requestId)
  const requestData = { ...data }
  delete requestData.requestId
  const requestDigest = digestRequest(action, requestData)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let connection
    let transactionStarted = false
    try {
      connection = await getPool().getConnection()
      if (currentReads) await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await connection.beginTransaction()
      transactionStarted = true
      const uid = await resolveUid(connection, provider, subjectHash)
      // 与 API 正式账本 mutation 使用相同门禁；解析和只读请求不占此锁。
      if (currentReads) await connection.execute(
        'SELECT uid FROM catledger_users WHERE uid = ? AND status = \'active\' FOR UPDATE', [uid]
      )
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
          return replayMutation({ getPool, provider, subjectHash, keyDigest, action, requestDigest, readIssue })
        }
        throw error
      }

      const result = await operation(connection, uid, requestData, requestDigest, keyDigest)
      await connection.execute(
        `UPDATE catledger_mutation_receipts
            SET result_json = ?
          WHERE uid = ? AND idempotency_key_digest = ?`,
        [JSON.stringify(encodeReceipt(result)), uid, keyDigest]
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
  throw new Error('Import mutation attempts exhausted')
}

async function executeUserRead({ getPool, provider, subjectHash, operation, consistentSnapshot = false }) {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    let connection
    try {
      connection = await getPool().getConnection()
      if (consistentSnapshot) await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      const uid = await resolveUid(connection, provider, subjectHash)
      const result = await operation(connection, uid)
      if (consistentSnapshot) await connection.commit()
      return result
    } catch (error) {
      if (consistentSnapshot && connection) await safeRollback(connection)
      if (isRetryableDatabaseError(error) && attempt + 1 < MAX_READ_ATTEMPTS) {
        await waitBeforeDatabaseRetry(attempt)
        continue
      }
      throw error
    } finally {
      if (connection) connection.release()
    }
  }
  throw new Error('Import read attempts exhausted')
}

module.exports = {
  executeIdempotentMutation,
  executeUserRead,
  resolveUid
}
