const { assertBudget } = require('./performance-contract')
const { operationReceipt } = require('./command-result')
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
const RECEIPT_ACTIONS = new Set(['financeUpdates.prepareSnapshot', 'financeUpdates.prepare', 'financeUpdates.organize', 'financeUpdates.abandon',
  'financeUpdates.setCategory', 'financeUpdates.setReview', 'financeUpdates.reviseDuplicate', 'financeUpdates.setRepayment', 'financeUpdates.post', 'financeUpdates.undo', 'economicEvents.correct', 'reviewIssues.resolve',
  'reviewIssues.resolveAccountMappings', 'reviewIssues.refreshAccountGroups', 'reviewIssues.reviseAccountMapping', 'reviewIssues.resolvePairings'])

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

async function replayMutation({ getPool, provider, subjectHash, keyDigest, action, requestDigest }) {
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
    const result = assertBudget(readReceipt(receipt.result), 'receipt')
    await connection.commit()
    return result
  } catch (error) {
    await safeRollback(connection)
    throw error
  } finally {
    connection.release()
  }
}

async function executeIdempotentMutation({ getPool, provider, subjectHash, action, data, operation }) {
  if (data && Object.hasOwn(data, 'resultMode')) throw importError('VALIDATION_ERROR')
  assertBudget(data, 'request')
  const keyDigest = digestIdempotencyKey(data && data.requestId)
  const requestData = { ...data }
  delete requestData.requestId
  const requestDigest = digestRequest(action, requestData)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let connection
    let transactionStarted = false
    // 此闭包仅管理当前mutation作用域的let变量；replayMutation的const连接独立释放。
    function releaseMutationConnection() {
      if (connection) { connection.release(); connection = undefined }
    }
    try {
      connection = await getPool().getConnection()
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await connection.beginTransaction()
      transactionStarted = true
      const uid = await resolveUid(connection, provider, subjectHash)
      // 解析 CPU 留在事务外；所有持久化与 API 共用用户门禁及导出修订。
      const [activeUsers] = await connection.execute(
        'SELECT uid FROM catledger_users WHERE uid = ? AND status = \'active\' FOR UPDATE', [uid]
      )
      if (!activeUsers[0]) throw importError('INITIALIZATION_REQUIRED')
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
          releaseMutationConnection()
          return replayMutation({ getPool, provider, subjectHash, keyDigest, action, requestDigest })
        }
        throw error
      }

      // Receipt replay is resolved above before this mode gate, so old in-flight
      // requests remain recoverable after a batch switches to local review.
      if (data.updateId && (action.startsWith('reviewIssues.') ||
        ['financeUpdates.setReview','financeUpdates.setCategory','financeUpdates.setRepayment','financeUpdates.reviseDuplicate','financeUpdates.organize','financeUpdates.post'].includes(action)) &&
        !(action === 'financeUpdates.post' && data.protocolVersion === 3)) {
        const [[batch]] = await connection.execute('SELECT review_mode AS mode FROM catledger_finance_updates WHERE uid=? AND update_id=?', [uid, data.updateId])
        if (batch && batch.mode === 'local_v3') throw importError('LOCAL_REVIEW_REQUIRED')
      }
      const rawResult = await operation(connection, uid, requestData, requestDigest, keyDigest)
      // Full private exports include draft facts and immutable transport objects.
      // Every committed mutation keeps the existing export revision contract,
      // including staging and a definitive recheck receipt; none writes money.
      await connection.execute('UPDATE catledger_users SET data_revision=data_revision+1 WHERE uid=?', [uid])
      const result = RECEIPT_ACTIONS.has(action) ? operationReceipt(rawResult, action, keyDigest) : assertBudget(rawResult, 'receipt')
      await connection.execute(
        `UPDATE catledger_mutation_receipts
            SET result_json = ?
          WHERE uid = ? AND idempotency_key_digest = ?`,
        [JSON.stringify(encodeReceipt(result)), uid, keyDigest]
      )
      await connection.commit()
      transactionStarted = false
      releaseMutationConnection()
      return result
    } catch (error) {
      if (transactionStarted) await safeRollback(connection)
      releaseMutationConnection()
      if (isRetryableDatabaseError(error) && attempt + 1 < MAX_ATTEMPTS) {
        await waitBeforeDatabaseRetry(attempt)
        continue
      }
      throw error
    } finally {
      releaseMutationConnection()
    }
  }
  throw new Error('Import mutation attempts exhausted')
}

async function executeUserRead({ getPool, provider, subjectHash, operation, consistentSnapshot = false }) {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    let connection
    try {
      connection = await getPool().getConnection()
      if (consistentSnapshot) {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      }
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

async function readCommandResult(context) {
  const { requestId, commandAction } = context.data
  const fileCommand = commandAction === 'imports.renameFile'
  if (!fileCommand && !RECEIPT_ACTIONS.has(commandAction)) throw importError('VALIDATION_ERROR')
  const keyDigest = digestIdempotencyKey(requestId)
  return executeUserRead({ ...context, consistentSnapshot: true, operation: async (connection, uid) => {
    const [[row]] = await connection.execute(`SELECT action, result_json AS result FROM catledger_mutation_receipts
      WHERE uid = ? AND idempotency_key_digest = ?`, [uid, keyDigest])
    if (!row || row.action !== commandAction || row.result == null) throw importError('OPERATION_UNCONFIRMED')
    const value = readReceipt(row.result)
    if (value.protocolVersion !== 2 || value.kind !== (fileCommand ? 'file-receipt' : 'operation-receipt') || value.action !== commandAction || value.receiptId !== keyDigest) {
      throw importError('RECEIPT_RECONCILIATION_REQUIRED')
    }
    return assertBudget(value, 'receipt')
  } })
}

// Preflight for commands which prepare immutable data before taking the write
// lock. A lost response must replay before examining a now-advanced version.
async function findReplay(context, action) {
  const data = { ...context.data }, key = digestIdempotencyKey(data.requestId)
  delete data.requestId
  const digest = digestRequest(action, data)
  return executeUserRead({ ...context, operation: async (connection, uid) => {
    const [[row]] = await connection.execute(`SELECT action,request_digest AS digest,result_json AS result
      FROM catledger_mutation_receipts WHERE uid=? AND idempotency_key_digest=?`, [uid, key])
    if (!row) return null
    if (row.action !== action || row.digest !== digest) throw importError('IDEMPOTENCY_CONFLICT')
    return row.result == null ? null : assertBudget(readReceipt(row.result), 'receipt')
  } })
}

module.exports = { executeIdempotentMutation, executeUserRead, resolveUid, readCommandResult, findReplay }
