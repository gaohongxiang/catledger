const { DRAFT_STATUSES, HARD_CLEANUP_HOURS } = require('./import-draft-retention')
const { RETENTION_DAYS } = require('./import-file-retention')
const { withCleanupConnection, createCleanupBudget } = require('./cleanup-runtime')

const immediate = Object.entries(RETENTION_DAYS).filter(([, days]) => days === 0).map(([state]) => state)
const POLICIES = {
  drafts: {
    table: 'catledger_finance_updates', key: 'update_id',
    where: `t.status IN (${DRAFT_STATUSES.map(() => '?').join(',')})
      AND t.updated_at <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR)
      AND EXISTS (SELECT 1 FROM catledger_users u WHERE u.uid = t.uid AND u.status = 'active')`,
    values: [...DRAFT_STATUSES, HARD_CLEANUP_HOURS]
  },
  files: {
    table: 'catledger_import_files', key: 'import_id',
    where: `t.content_deleted_at IS NULL AND t.cloud_file_id IS NOT NULL AND (
      t.state IN (${immediate.map(() => '?').join(',')})
      OR (t.state = 'review_ready' AND t.updated_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY))
      OR (t.state = 'failed' AND t.updated_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY))
      OR (t.state = 'awaiting_upload' AND t.updated_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)))`,
    values: [...immediate, RETENTION_DAYS.review_ready, RETENTION_DAYS.failed, RETENTION_DAYS.awaiting_upload]
  }
}
const RETRY_READY = '(t.cleanup_retry_after IS NULL OR t.cleanup_retry_after <= CURRENT_TIMESTAMP(3))'

async function readCleanupBacklog(getPool, kind, { budget = createCleanupBudget() } = {}) {
  const policy = POLICIES[kind]
  if (!policy) throw new Error('Unknown cleanup kind')
  return withCleanupConnection(getPool(), budget, async connection => {
    const [[row]] = await connection.execute(
      `SELECT COUNT(*) AS pending, COALESCE(SUM(${RETRY_READY}), 0) AS ready,
              COALESCE(MAX(TIMESTAMPDIFF(MICROSECOND, t.updated_at, CURRENT_TIMESTAMP(3)) DIV 1000), 0) AS oldestPendingAgeMs
         FROM ${policy.table} t WHERE ${policy.where}`, policy.values)
    const pending = Number(row.pending), ready = Number(row.ready)
    return { available: true, pending, ready, deferred: pending - ready, oldestPendingAgeMs: Number(row.oldestPendingAgeMs) }
  }, 1_000)
}

module.exports = { POLICIES, RETRY_READY, readCleanupBacklog }
