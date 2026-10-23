const { digestParts } = require('./digest')
const { discardUpdateGraph } = require('./discarded-update')
const { insertAction, selectUpdate } = require('./finance-update-repository')
const { DRAFT_STATUSES, DEFAULT_LIMIT, MAX_LIMIT, HARD_CLEANUP_HOURS } = require('./import-draft-retention')
const { POLICIES, RETRY_READY } = require('./cleanup-policy')
const { createCleanupBudget, withCleanupConnection, deferCleanupFailure, cursorClause, cursorValues } = require('./cleanup-runtime')

function createFinanceDraftCleanup({ getPool }) {
  async function cleanupExpiredDraftsGlobal(limit = DEFAULT_LIMIT, { budget = createCleanupBudget(), progress = {} } = {}) {
    const bounded = Math.max(1, Math.min(MAX_LIMIT, Number.isInteger(limit) ? limit : DEFAULT_LIMIT))
    const pool = getPool(), policy = POLICIES.drafts
    const result = { checked: 0, cleaned: 0, skipped: 0, failed: 0, backoffFailed: 0 }
    if (!budget.canStart()) return result
    const rows = await withCleanupConnection(pool, budget, async connection => {
      const [rows] = await connection.execute(
        `SELECT t.uid, t.update_id AS id, t.updated_at AS updatedAt
           FROM catledger_finance_updates t
          WHERE ${policy.where} AND ${RETRY_READY}${cursorClause(progress, 'update_id', 't')}
          ORDER BY t.updated_at, t.uid, t.update_id LIMIT ?`,
        [...policy.values, ...cursorValues(progress), bounded])
      return rows
    })
    progress.done = rows.length < bounded
    for (const row of rows) {
      if (!budget.canStart()) { progress.done = false; break }
      result.checked += 1
      progress.cursor = row
      try {
        const cleaned = await withCleanupConnection(pool, budget, async connection => {
          await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
          await connection.beginTransaction()
          const [users] = await connection.execute(
            "SELECT uid FROM catledger_users WHERE uid = ? AND status = 'active' FOR UPDATE", [row.uid]
          )
          if (!users[0]) { await connection.rollback(); return false }
          const current = await selectUpdate(connection, row.uid, row.id, { forUpdate: true })
          if (!DRAFT_STATUSES.includes(current.status)) { await connection.rollback(); return false }
          const [[eligibility]] = await connection.execute(
            `SELECT (updated_at <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR)
                     AND (cleanup_retry_after IS NULL OR cleanup_retry_after <= CURRENT_TIMESTAMP(3))) AS eligible
               FROM catledger_finance_updates WHERE uid = ? AND update_id = ?`,
            [HARD_CLEANUP_HOURS, row.uid, row.id]
          )
          if (!eligibility || !Number(eligibility.eligible)) { await connection.rollback(); return false }
          const version = Number(current.version)
          const actionId = await insertAction(connection, row.uid, {
            updateId: row.id,
            expectedVersion: version,
            appliedVersion: version + 1,
            actionType: 'abandon_update',
            requestDigest: digestParts('expired-draft-cleanup-v1', row.id, String(version), String(current.updatedAt)),
            reasons: ['expired_draft_cleanup']
          })
          const [updated] = await connection.execute(
            `UPDATE catledger_finance_updates
                SET status = 'abandoned', version = ?, current_action_id = ?, error_code = 'DRAFT_EXPIRED',
                    cleanup_retry_after = NULL, cleanup_failure_count = 0
              WHERE uid = ? AND update_id = ? AND version = ? AND status IN (${DRAFT_STATUSES.map(() => '?').join(',')})`,
            [version + 1, actionId, row.uid, row.id, version, ...DRAFT_STATUSES]
          )
          if (updated.affectedRows !== 1) throw new Error('Import draft changed during cleanup')
          await discardUpdateGraph(connection, row.uid, row.id)
          // Temporary objects are exported as part of the private data revision.
          await connection.execute('UPDATE catledger_users SET data_revision = data_revision + 1 WHERE uid = ?', [row.uid])
          await connection.commit()
          return true
        })
        if (cleaned) result.cleaned += 1
        else result.skipped += 1
      } catch (_) {
        result.failed += 1
        try { await deferCleanupFailure(pool, budget, 'drafts', row) }
        catch (_) { result.backoffFailed += 1 }
      }
    }
    return result
  }
  return { cleanupExpiredDraftsGlobal }
}

module.exports = { createFinanceDraftCleanup }
