const { commandResult } = require('../command-result')
const { importError } = require('../errors')
const { insertAction, selectUpdate } = require('../finance-update-repository')
const { selectDomainEvents } = require('./event-store')
const { FIELD_MASK } = require('./policy')

async function setCategory(connection, uid, data, requestDigest, { updateId, eventId, updateVersion, eventVersion, categoryId }) {
  const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
  if (update.status !== 'review' || Number(update.version) !== updateVersion) throw importError('CONFLICT')
  const [event] = await selectDomainEvents(connection, uid, updateId, [eventId], { forUpdate: true })
  if (!event || event.version !== eventVersion || !['ready', 'needs_action'].includes(event.status)) throw importError('CONFLICT')
  if (!event.categoryId || !['income', 'expense', 'fee'].includes(event.economicNature)) throw importError('VALIDATION_ERROR')
  const [[category]] = await connection.execute(`SELECT kind FROM catledger_categories
    WHERE uid = ? AND category_id = ? AND archived_at IS NULL FOR UPDATE`, [uid, categoryId])
  if (!category || category.kind !== (event.economicNature === 'income' ? 'income' : 'expense')) throw importError('VALIDATION_ERROR')
  const actionId = await insertAction(connection, uid, { updateId, expectedVersion: updateVersion, appliedVersion: updateVersion + 1,
    actionType: 'set_event_category', requestDigest, decision: { eventId, categoryId }, reasons: ['category_manually_changed'] })
  // 只改这一笔的分类；不重新推断资金字段、状态或其他待核对决定。
  const [saved] = await connection.execute(`UPDATE catledger_economic_events SET category_id = ?,
    manual_field_mask = manual_field_mask | ?, field_sources_json = ?, version = version + 1
    WHERE uid = ? AND update_id = ? AND event_id = ? AND version = ?`,
  [categoryId, FIELD_MASK.categoryId, JSON.stringify({ ...event.fieldSources, lastUserActionId: actionId }), uid, updateId, eventId, eventVersion])
  if (saved.affectedRows !== 1) throw importError('CONFLICT')
  await connection.execute(`UPDATE catledger_review_issue_members m JOIN catledger_review_issues i ON i.uid = m.uid AND i.issue_id = m.issue_id
    SET m.object_version = ? WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'event' AND m.object_id = ?
      AND (i.status = 'open' OR (i.issue_type = 'account_mapping' AND i.status = 'resolved'))`, [eventVersion + 1, uid, updateId, eventId])
  await connection.execute(`UPDATE catledger_review_issues i SET version = version + 1
    WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND EXISTS (
      SELECT 1 FROM catledger_review_issue_members m WHERE m.uid = i.uid AND m.issue_id = i.issue_id
        AND m.object_type = 'event' AND m.object_id = ?)`, [uid, updateId, eventId])
  const [advanced] = await connection.execute(`UPDATE catledger_finance_updates SET version = version + 1, current_action_id = ?
    WHERE uid = ? AND update_id = ? AND version = ? AND status = 'review'`, [actionId, uid, updateId, updateVersion])
  if (advanced.affectedRows !== 1) throw importError('CONFLICT')
  return commandResult(connection, uid, updateId)
}

module.exports = { setCategory }
