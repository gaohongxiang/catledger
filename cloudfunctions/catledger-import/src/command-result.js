const { assertBudget } = require('./performance-contract')
const { importError } = require('./errors')

async function assertLegacyScope(connection, uid, update) {
  // 旧客户端只在明确的小规模内兼容。先在写事务内检查规模，展示在commit后读取。
  if (update.counts.finalEvents > 40 || update.counts.validEvidence > 40) throw importError('PAGINATION_REQUIRED')
  const [sizes] = await connection.execute(`SELECT COALESCE(SUM(2048 + OCTET_LENGTH(r.raw_fields_json) + COALESCE(OCTET_LENGTH(r.semantic_json), 0)), 0) AS bytes
    FROM catledger_finance_update_sources s JOIN catledger_import_rows r ON r.uid = s.uid AND r.batch_id = s.batch_id
    WHERE s.uid = ? AND s.update_id = ?
    UNION ALL SELECT COALESCE(SUM(2048 + OCTET_LENGTH(field_sources_json) + OCTET_LENGTH(reason_codes_json)), 0)
      FROM catledger_economic_events WHERE uid = ? AND update_id = ?
    UNION ALL SELECT COUNT(*) * 1024 FROM catledger_review_issues WHERE uid = ? AND update_id = ?
    UNION ALL SELECT COUNT(*) * 256 FROM catledger_review_issue_members WHERE uid = ? AND update_id = ?
    UNION ALL SELECT COALESCE(SUM(512 + OCTET_LENGTH(name)), 0) FROM catledger_accounts WHERE uid = ? AND archived_at IS NULL
    UNION ALL SELECT COALESCE(SUM(256 + OCTET_LENGTH(name)), 0) FROM catledger_categories WHERE uid = ? AND archived_at IS NULL`,
  [uid, update.updateId, uid, update.updateId, uid, update.updateId, uid, update.updateId, uid, uid])
  if (sizes.reduce((sum, row) => sum + Number(row.bytes), 0) > 128 * 1024) throw importError('PAGINATION_REQUIRED')
}

async function commandResult(connection, uid, updateId, data = {}, issueId = null) {
  const repository = require('./finance-update-repository')
  const update = repository.publicUpdate(await repository.selectUpdate(connection, uid, updateId))
  const [[posting]] = await connection.execute(`SELECT created_transaction_count AS createdTransactionCount,
    reused_transaction_count AS reusedTransactionCount FROM catledger_finance_update_postings
    WHERE uid = ? AND update_id = ? AND state = 'completed' ORDER BY completed_at DESC LIMIT 1`, [uid, updateId])
  if (data.resultMode !== 'receipt') await assertLegacyScope(connection, uid, update)
  return { update, ...(data.resultMode === 'receipt' ? {} : { __legacyView: { updateId, issueId } }),
    posting: posting ? { createdTransactionCount: Number(posting.createdTransactionCount),
    reusedTransactionCount: Number(posting.reusedTransactionCount) } : null }
}
function operationReceipt(result, action, receiptId) {
  const update = result.update || result
  if (!update || typeof update.updateId !== 'string' || !Number.isInteger(update.version)) throw importError('VALIDATION_ERROR')
  return assertBudget({ protocolVersion: 2, kind: 'operation-receipt', receiptId, action,
    updateId: update.updateId, appliedVersion: update.version, status: update.status,
    counts: update.counts, update, posting: result.posting || null,
    invalidates: ['summary', 'events', 'issues', 'members', 'options', 'evidence'] }, 'receipt')
}
module.exports = { commandResult, operationReceipt }
