const { digestParts } = require('./digest')
const { discardUpdateGraph } = require('./discarded-update')
const { insertAction, selectUpdate } = require('./finance-update-repository')
const { DRAFT_STATUSES, DEFAULT_LIMIT, MAX_LIMIT, HARD_CLEANUP_HOURS } = require('./import-draft-retention')

function createFinanceDraftCleanup({ getPool }) {
  async function cleanupExpiredDraftsGlobal(limit = DEFAULT_LIMIT) {
    const bounded = Math.max(1, Math.min(MAX_LIMIT, Number.isInteger(limit) ? limit : DEFAULT_LIMIT))
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT uid, update_id AS updateId, version, status
         FROM catledger_finance_updates
        WHERE status IN (${DRAFT_STATUSES.map(() => '?').join(',')})
          AND updated_at <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR)
        ORDER BY updated_at ASC, update_id ASC
        LIMIT ?`,
      [...DRAFT_STATUSES, HARD_CLEANUP_HOURS, bounded]
    )
    let cleaned = 0, skipped = 0, failed = 0
    for (const row of rows) {
      let connection
      try {
        connection = await pool.getConnection()
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await connection.beginTransaction()
        const [users] = await connection.execute(
          "SELECT uid FROM catledger_users WHERE uid = ? AND status = 'active' FOR UPDATE", [row.uid]
        )
        if (!users[0]) { await connection.rollback(); skipped += 1; continue }
        const current = await selectUpdate(connection, row.uid, row.updateId, { forUpdate: true })
        if (!DRAFT_STATUSES.includes(current.status)) { await connection.rollback(); skipped += 1; continue }
        const [[eligibility]] = await connection.execute(
          `SELECT (updated_at <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR)) AS eligible
             FROM catledger_finance_updates WHERE uid = ? AND update_id = ?`,
          [HARD_CLEANUP_HOURS, row.uid, row.updateId]
        )
        if (!eligibility || !Number(eligibility.eligible)) { await connection.rollback(); skipped += 1; continue }
        const version = Number(current.version)
        const actionId = await insertAction(connection, row.uid, {
          updateId: row.updateId,
          expectedVersion: version,
          appliedVersion: version + 1,
          actionType: 'abandon_update',
          requestDigest: digestParts('expired-draft-cleanup-v1', row.updateId, String(version), String(current.updatedAt)),
          reasons: ['expired_draft_cleanup']
        })
        const [updated] = await connection.execute(
          `UPDATE catledger_finance_updates
              SET status = 'abandoned', version = ?, current_action_id = ?, error_code = 'DRAFT_EXPIRED'
            WHERE uid = ? AND update_id = ? AND version = ? AND status IN (${DRAFT_STATUSES.map(() => '?').join(',')})`,
          [version + 1, actionId, row.uid, row.updateId, version, ...DRAFT_STATUSES]
        )
        if (updated.affectedRows !== 1) throw new Error('Import draft changed during cleanup')
        await discardUpdateGraph(connection, row.uid, row.updateId)
        // Temporary objects are exported as part of the private data revision.
        await connection.execute('UPDATE catledger_users SET data_revision = data_revision + 1 WHERE uid = ?', [row.uid])
        await connection.commit()
        cleaned += 1
      } catch (_) {
        if (connection) { try { await connection.rollback() } catch (_) {} }
        failed += 1
      } finally {
        if (connection) connection.release()
      }
    }
    return { checked: rows.length, cleaned, skipped, failed }
  }
  return { cleanupExpiredDraftsGlobal }
}

module.exports = { createFinanceDraftCleanup }
