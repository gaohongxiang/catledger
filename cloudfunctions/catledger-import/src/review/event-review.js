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
  if (data.editorVersion != null) return saveEditor(connection, uid, data, requestDigest, update, event)
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

// 与旧 setReview 共用外层用户锁、幂等回执和批次版本，不新增写协议或嵌套事务。
async function saveEditor(connection, uid, data, requestDigest, update, event) {
  let next = require('./editor-policy').prepare(event, data)
  await require('./editor-refund').validateExpectations(connection, uid, event, data.expectedRelations)
  if (event.fieldSources.installment && (data.sourceCorrection || ['ledgerAccountId','amountMinor','occurredLocalAt'].some(key => Object.hasOwn(data.fields || {}, key)))) {
    const [[claimed]] = await connection.execute('SELECT COUNT(*) AS count FROM catledger_installment_items WHERE uid=? AND source_event_id=? AND active=1', [uid, event.eventId])
    if (Number(claimed.count)) throw importError('LOAN_SOURCE_MISMATCH')
  }
  const actionId = await insertAction(connection, uid, { updateId: event.updateId, expectedVersion: Number(update.version),
    appliedVersion: Number(update.version) + 1, actionType: 'set_event_review', requestDigest,
    decision: data, reasons: ['review_manually_changed'] })
  if (data.decisions && data.decisions.repaymentChannel) {
    const [verified] = await require('./bank-channel-hydration').hydrate(connection, uid, event.updateId, [next])
    if (!require('../repayment-channel').evidenceValid(verified, verified.relationEvidence.rows)) throw importError('VALIDATION_ERROR')
    next = await require('./repayment-channel-merge').confirmDetails(connection, uid, event.updateId, verified, actionId)
  }
  if (next.fieldSources.loanRepayment) next.fieldSources.loanRepayment = await require('./repayment').prepareRepayment(connection, uid, event.updateId, next, next.fieldSources.loanRepayment, { editor: true })
  await require('./editor-refund').apply(connection, uid, event, next, data)
  const openBlockingIssues = await require('./issue-store').refreshEditedEventIssues(connection, uid, event.updateId, next, actionId)
  const saved = await saveEvents(connection, uid, event.updateId, [{ current: event, next }], actionId, { openBlockingIssues })
  await updateMappingMemberVersions(connection, uid, event.updateId, saved)
  await updateMappingMemberVersions(connection, uid, event.updateId, saved, true)
  await createFollowUpIssues(connection, uid, event.updateId, saved)
  // 归属保存后的增量补建可能只建出单笔事项（清除指定、来回改归属时尤其如此），散件必须
  // 立刻收回“一期次一条、本金在前”——否则本金失去事项成员身份掉进已核对，本息分居两个页签。
  // 组内归属都已指定时 collapse 自身会跳过，不影响正常指定的收尾路径。
  await require('./issue-store').collapseInstallmentIssues(connection, uid, event.updateId, actionId)
  await recalculateUpdateCounts(connection, uid, event.updateId, Number(update.version) + 1, actionId, Number(update.version), 0)
  return { ...await commandResult(connection, uid, event.updateId), event: saved[0] }
}
// The local protocol submits one final editor value per stable event. Pure
// preparation and SQL saving are batched; relational checks reuse the editor's
// existing validators on this same connection. Whole-batch derivation runs once
// in local-review-submit, after all decisions have been applied.
async function saveEditors(connection, uid, updateId, items, actionId) {
  if (!items.length) return []
  const stored = await selectDomainEvents(connection, uid, updateId, items.map(item => item.eventId), { forUpdate: true })
  const events = new Map((await effectiveProjectedEvents(connection, uid, updateId, stored)).map(event => [event.eventId, event]))
  const changes = []
  for (const item of items) {
    const batch = require('../local-review-batch').get(connection)
    if (batch) batch.affected = [item.eventId]
    const current = events.get(item.eventId)
    if (!current) throw importError('CONFLICT')
    const data = item.editor
    let next = require('./editor-policy').prepare(current, data)
    // Historical targets retain the user's explicit versions. Local event and
    // relation versions are server-internal and have already changed in this
    // transaction; their exact source scopes are checked by the v3 kernel.
    if (data.expectedRelations?.some(row=>['loan','transaction'].includes(row.kind))) {
      const now = await require('./editor-refund').expectations(connection, uid, current)
      for (const target of data.expectedRelations.filter(row => ['loan','transaction'].includes(row.kind))) {
        const found = now.find(row => row.kind === target.kind && row.id === target.id)
        if (found && found.version !== target.version) throw importError('CONFLICT')
      }
    }
    if (current.fieldSources.installment && (data.sourceCorrection || ['ledgerAccountId','amountMinor','occurredLocalAt'].some(key => Object.hasOwn(data.fields || {}, key)))) {
      const [[claimed]] = await connection.execute('SELECT COUNT(*) AS count FROM catledger_installment_items WHERE uid=? AND source_event_id=? AND active=1', [uid, current.eventId])
      if (Number(claimed.count)) throw importError('LOAN_SOURCE_MISMATCH')
    }
    if (data.decisions && data.decisions.repaymentChannel) {
      const [verified] = await require('./bank-channel-hydration').hydrate(connection, uid, updateId, [next])
      if (!require('../repayment-channel').evidenceValid(verified, verified.relationEvidence.rows)) throw importError('VALIDATION_ERROR')
      next = await require('./repayment-channel-merge').confirmDetails(connection, uid, updateId, verified, actionId)
    }
    if (next.fieldSources.loanRepayment) next.fieldSources.loanRepayment = await require('./repayment').prepareRepayment(connection, uid, updateId, next, next.fieldSources.loanRepayment, { editor: true })
    changes.push({ current, next, data })
  }
  // Save all final field values before validating relationships, so the outcome
  // cannot depend on click order (e.g. changing an expense and its refund).
  const blocking = await require('./issue-store').refreshEditedEventsIssues(connection, uid, updateId, changes.map(row=>row.next), actionId)
  let saved = await saveEvents(connection, uid, updateId, changes, actionId, { openBlockingIssues: blocking })
  const relationChanges = changes.filter(({current,next,data})=>current.economicNature==='refund'||next.economicNature==='refund'||data.decisions?.refund||
    ['economicNature','amountMinor','utcAt'].some(key=>current[key]!==next[key]))
  for (const { current, next, data } of relationChanges) {
    const batch = require('../local-review-batch').get(connection)
    if (batch) batch.affected = [next.eventId]
    const refund = data.decisions && data.decisions.refund
    let input = data
    if (refund && refund.kind === 'event' && refund.mode === 'link') {
      const [target] = await selectDomainEvents(connection, uid, updateId, [refund.id])
      if (!target) throw importError('CONFLICT')
      input = { ...data, decisions: { ...data.decisions, refund: { ...refund, version: target.version } } }
    }
    await require('./editor-refund').apply(connection, uid, current, next, input)
  }
  // Relation changes may remove the last blocker; evaluate once against their
  // final state and preserve every primary field prepared above.
  const savedById = new Map(saved.map(row => [row.eventId, { ...row }]))
  if (relationChanges.length) {
    const revised = await saveEvents(connection, uid, updateId, relationChanges.map(({ next }) => ({ current: savedById.get(next.eventId), next })), actionId, { openBlockingIssues: blocking })
    for (const event of revised) savedById.set(event.eventId,event)
    saved = [...savedById.values()]
  }
  await updateMappingMemberVersions(connection, uid, updateId, saved)
  await updateMappingMemberVersions(connection, uid, updateId, saved, true)
  await createFollowUpIssues(connection, uid, updateId, saved)
  return saved
}
module.exports = { setReview, saveEditors }
