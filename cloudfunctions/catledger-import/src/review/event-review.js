const { importError } = require('../errors')
const { commandResult } = require('../command-result')
const { insertAction, selectUpdate } = require('../finance-update-repository')
const { applyFields, FIELD_MASK } = require('./policy')
const { selectDomainEvents, saveEvents } = require('./event-store')
const { updateMappingMemberVersions, createFollowUpIssues } = require('./issue-store')
const { effectiveProjectedEvents, recalculateUpdateCounts } = require('./reconciliation')

const allowed = new Set(['economicNature', 'ledgerAccountId', 'counterpartyLedgerAccountId'])
const categoryKind = nature => nature === 'income' ? 'income' : ['expense', 'fee'].includes(nature) ? 'expense' : ''

async function setReview(connection, uid, data, requestDigest, { updateId, eventId, updateVersion, eventVersion }) {
  const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
  if (update.status !== 'review' || Number(update.version) !== updateVersion) throw importError('CONFLICT')
  const stored = await selectDomainEvents(connection, uid, updateId, [eventId], { forUpdate: true })
  const [event] = await effectiveProjectedEvents(connection, uid, updateId, stored)
  if (!event || event.version !== eventVersion || !['ready', 'needs_action'].includes(event.status)) throw importError('CONFLICT')
  const fields = data.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length ||
    Object.keys(fields).some(key => !allowed.has(key))) throw importError('VALIDATION_ERROR')
  const [[blocked]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issues i
    JOIN catledger_review_issue_members m ON m.uid=i.uid AND m.issue_id=i.issue_id
    WHERE i.uid=? AND i.update_id=? AND i.status='open' AND i.blocking=1
      AND m.object_type='event' AND m.member_role='subject' AND m.object_id=?`, [uid, updateId, eventId])
  if (Number(blocked.count)) throw importError('CONFLICT')
  // 多账户分配和贷款付款仍由其专用编辑器维护，通用修改不能丢掉分配事实。
  const source = event.fieldSources
  if (source.paymentResolution || (source.repaymentAllocations || []).length ||
    source.loanRepayment && !['ordinary', 'review'].includes(source.loanRepayment.mode)) throw importError('VALIDATION_ERROR')
  const patch = { ...fields }
  const nature = fields.economicNature || event.economicNature
  if (nature !== event.economicNature) {
    patch.flowDirection = ['income', 'refund'].includes(nature) ? 'inflow' : ['expense', 'fee'].includes(nature) ? 'outflow'
      : ['internal_transfer', 'repayment', 'borrow'].includes(nature) ? 'neutral' : event.flowDirection
    if (!['internal_transfer', 'repayment', 'borrow'].includes(nature)) patch.counterpartyLedgerAccountId = null
    if (categoryKind(nature) !== categoryKind(event.economicNature)) patch.categoryId = null
    const [[dependents]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_economic_event_relations
      WHERE uid=? AND update_id=? AND target_event_id=? AND relation_type='refund_of' AND status='confirmed'`, [uid, updateId, eventId])
    if (Number(dependents.count) && nature !== 'expense') throw importError('VALIDATION_ERROR')
  }
  const next = applyFields(event, patch)
  if (next.ledgerAccountId && next.ledgerAccountId === next.counterpartyLedgerAccountId) throw importError('VALIDATION_ERROR')
  const actionId = await insertAction(connection, uid, { updateId, expectedVersion: updateVersion, appliedVersion: updateVersion + 1,
    actionType: 'set_event_review', requestDigest, decision: { eventId, fields }, reasons: ['review_manually_changed'] })
  if (nature !== event.economicNature) {
    // 类型变化后重新判断分类与退款关系，不能沿用不再适用的旧选择。
    if (patch.categoryId === null) next.manualFieldMask &= ~FIELD_MASK.categoryId
    if (event.economicNature === 'refund') {
      await connection.execute(`UPDATE catledger_economic_event_relations SET status='rejected',manual=1,version=version+1
        WHERE uid=? AND update_id=? AND source_event_id=? AND relation_type='refund_of' AND status IN ('proposed','confirmed')`, [uid, updateId, eventId])
      await connection.execute(`UPDATE catledger_economic_event_transactions SET superseded_at=CURRENT_TIMESTAMP(3)
        WHERE uid=? AND update_id=? AND event_id=? AND role='refund_original' AND superseded_at IS NULL`, [uid, updateId, eventId])
      next.fieldSources = { ...next.fieldSources, refundRelation: undefined }
    }
    if (!['repayment', 'internal_transfer'].includes(nature)) next.fieldSources = { ...next.fieldSources, loanRepayment: undefined }
    const [issues] = await connection.execute(`SELECT i.issue_id AS id FROM catledger_review_issues i
      JOIN catledger_review_issue_members m ON m.uid=i.uid AND m.issue_id=i.issue_id
      WHERE i.uid=? AND i.update_id=? AND i.status='open' AND i.issue_type='category_assignment'
        AND m.object_type='event' AND m.member_role='subject' AND m.object_id=?`, [uid, updateId, eventId])
    for (const issue of issues) {
      await connection.execute(`DELETE FROM catledger_review_issue_members WHERE uid=? AND issue_id=? AND object_type='event' AND object_id=?`, [uid, issue.id, eventId])
      await connection.execute(`UPDATE catledger_review_issues SET version=version+1,
        member_count=(SELECT COUNT(*) FROM catledger_review_issue_members WHERE uid=? AND issue_id=?),
        status=IF(member_count=0,'superseded',status),resolved_action_id=IF(member_count=0,?,resolved_action_id)
        WHERE uid=? AND issue_id=?`, [uid, issue.id, actionId, uid, issue.id])
    }
  }
  next.reasonCodes = next.reasonCodes.filter(reason => reason !== 'category_required')
  const saved = await saveEvents(connection, uid, updateId, [{ current: event, next }], actionId)
  await updateMappingMemberVersions(connection, uid, updateId, saved)
  await updateMappingMemberVersions(connection, uid, updateId, saved, true)
  await createFollowUpIssues(connection, uid, updateId, saved)
  await recalculateUpdateCounts(connection, uid, updateId, updateVersion + 1, actionId, updateVersion, 0)
  return commandResult(connection, uid, updateId)
}

module.exports = { setReview }
