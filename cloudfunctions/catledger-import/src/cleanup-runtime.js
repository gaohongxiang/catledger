// Keep this deployment budget aligned with cloudbaserc.json (covered by tests).
const FUNCTION_TIMEOUT_MS = 60_000
const SAFETY_MARGIN_MS = 15_000
const ITEM_TIMEOUT_MS = 3_000
const MIN_OPERATION_MS = 100

function timeoutError() {
  const error = new Error('Maintenance operation exceeded its time budget')
  error.code = 'CLEANUP_TIMEOUT'
  return error
}

function createCleanupBudget({ now = Date.now, timeoutMs = FUNCTION_TIMEOUT_MS - SAFETY_MARGIN_MS } = {}) {
  const startedAt = now(), deadline = startedAt + Math.max(0, timeoutMs)
  return { now, remaining: () => Math.max(0, deadline - now()),
    canStart: () => deadline - now() >= MIN_OPERATION_MS,
    elapsed: () => Math.max(0, now() - startedAt) }
}

// Timeout destroys the SQL connection and fences all subsequent calls. A late
// pool acquisition is returned immediately; a timed-out transaction is never pooled.
async function withCleanupConnection(pool, budget, operation, maxMs = ITEM_TIMEOUT_MS) {
  if (!budget.canStart()) throw timeoutError()
  const allowedMs = Math.min(maxMs, budget.remaining())
  let connection, expired = false, timer
  const pending = (async () => {
    const acquired = await pool.getConnection()
    if (expired) { acquired.release(); throw timeoutError() }
    connection = acquired
    const guarded = {}
    for (const method of ['execute', 'query', 'beginTransaction', 'commit', 'rollback']) {
      guarded[method] = (...args) => {
        if (expired || !budget.canStart()) return Promise.reject(timeoutError())
        return connection[method](...args)
      }
    }
    try { return await operation(guarded) }
    catch (error) {
      if (!expired) { try { await guarded.rollback() } catch (_) { connection.destroy(); expired = true } }
      throw error
    }
  })()
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true
        if (connection) connection.destroy()
        reject(timeoutError())
      }, allowedMs)
    })])
  } finally {
    clearTimeout(timer)
    if (connection && !expired) connection.release()
  }
}

// These two identifiers are internal constants, never event input.
const TARGETS = Object.freeze({ drafts: ['catledger_finance_updates', 'update_id'], files: ['catledger_import_files', 'import_id'] })
async function deferCleanupFailure(pool, budget, kind, row) {
  const [table, key] = TARGETS[kind]
  await withCleanupConnection(pool, budget, connection => connection.execute(
    `UPDATE ${table}
        SET cleanup_retry_after = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL LEAST(604800, 3600 * POW(2, LEAST(cleanup_failure_count, 8))) SECOND),
            cleanup_failure_count = LEAST(cleanup_failure_count + 1, 65535), updated_at = updated_at
      WHERE uid = ? AND ${key} = ? AND updated_at = ?`,
    [row.uid, row.id, row.updatedAt]
  ), 1_000)
}

function cursorClause(progress, idColumn, alias = '') {
  const prefix = alias ? alias + '.' : ''
  return progress.cursor ? ` AND (${prefix}updated_at, ${prefix}uid, ${prefix}${idColumn}) > (?, ?, ?)` : ''
}
function cursorValues(progress) {
  return progress.cursor ? [progress.cursor.updatedAt, progress.cursor.uid, progress.cursor.id] : []
}

module.exports = { FUNCTION_TIMEOUT_MS, SAFETY_MARGIN_MS, ITEM_TIMEOUT_MS, createCleanupBudget,
  withCleanupConnection, deferCleanupFailure, cursorClause, cursorValues }
