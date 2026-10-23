const { POLICIES, RETRY_READY } = require('./cleanup-policy')
const { createCleanupBudget, withCleanupConnection, deferCleanupFailure, cursorClause, cursorValues } = require('./cleanup-runtime')

function createImportFileCleanup({ getPool, storage }) {
  async function cleanupExpiredFilesGlobal(limit = 20, { budget = createCleanupBudget(), progress = {} } = {}) {
    const bounded = Math.max(1, Math.min(50, Number.isInteger(limit) ? limit : 20))
    const pool = getPool(), policy = POLICIES.files
    const result = { checked: 0, deleted: 0, skipped: 0, failed: 0, backoffFailed: 0 }
    if (!budget.canStart()) return result
    const rows = await withCleanupConnection(pool, budget, async connection => {
      const [rows] = await connection.execute(
        `SELECT t.uid, t.import_id AS id, t.cloud_file_id AS fileID, t.updated_at AS updatedAt
           FROM catledger_import_files t
          WHERE ${policy.where} AND ${RETRY_READY}${cursorClause(progress, 'import_id', 't')}
          ORDER BY t.updated_at, t.uid, t.import_id LIMIT ?`,
        [...policy.values, ...cursorValues(progress), bounded])
      return rows
    })
    progress.done = rows.length < bounded
    for (const row of rows) {
      if (!budget.canStart()) { progress.done = false; break }
      result.checked += 1
      progress.cursor = row
      try {
        const deleted = await withCleanupConnection(pool, budget, async connection => {
          await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
          await connection.beginTransaction()
          // Same write gate as parse/renew/post. A candidate can become current
          // while waiting; recheck it only after acquiring this user's lock.
          const [users] = await connection.execute('SELECT uid FROM catledger_users WHERE uid = ? FOR UPDATE', [row.uid])
          if (!users[0]) { await connection.rollback(); return false }
          const [current] = await connection.execute(
            `SELECT t.cloud_file_id AS fileID FROM catledger_import_files t
              WHERE t.uid = ? AND t.import_id = ? AND ${policy.where} AND ${RETRY_READY} FOR UPDATE`,
            [row.uid, row.id, ...policy.values])
          if (!current[0] || current[0].fileID !== row.fileID) { await connection.rollback(); return false }
          // Ordinary review/post uses parsed rows. Storage deletion cannot be
          // cancelled: timeout destroys the SQL connection and fences late writes;
          // the next run rechecks/redeletes this same fileID before marking success.
          if (!await storage.remove(row.fileID)) throw new Error('Original file cleanup failed')
          await connection.execute(
            `UPDATE catledger_import_files SET content_deleted_at = CURRENT_TIMESTAMP(3),
                    cleanup_retry_after = NULL, cleanup_failure_count = 0
              WHERE uid = ? AND import_id = ?`, [row.uid, row.id])
          await connection.execute('UPDATE catledger_users SET data_revision = data_revision + 1 WHERE uid = ?', [row.uid])
          await connection.commit()
          return true
        })
        if (deleted) result.deleted += 1
        else result.skipped += 1
      } catch (_) {
        result.failed += 1
        try { await deferCleanupFailure(pool, budget, 'files', row) }
        catch (_) { result.backoffFailed += 1 }
      }
    }
    return result
  }
  return { cleanupExpiredFilesGlobal }
}

module.exports = { createImportFileCleanup }
