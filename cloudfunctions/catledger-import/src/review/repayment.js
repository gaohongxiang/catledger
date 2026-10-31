const { commandResult } = require('../command-result')
const { importError } = require('../errors')
const { insertAction, selectUpdate } = require('../finance-update-repository')
const { selectDomainEvents, saveEvents } = require('./event-store')
const { updateMappingMemberVersions, createFollowUpIssues } = require('./issue-store')
const { effectiveProjectedEvents, recalculateUpdateCounts } = require('./reconciliation')

async function setRepayment(connection, uid, data, requestDigest, { updateId, eventId, updateVersion, eventVersion }) {
  const update = await selectUpdate(connection,uid,updateId,{ forUpdate:true })
  if (update.status !== 'review' || Number(update.version) !== updateVersion) throw importError('CONFLICT')
  const stored = await selectDomainEvents(connection,uid,updateId,[eventId],{ forUpdate:true })
  const [event] = await effectiveProjectedEvents(connection,uid,updateId,stored)
  if (!event || event.version !== eventVersion || !['ready','needs_action'].includes(event.status)) throw importError('CONFLICT')
  if (!['repayment','internal_transfer'].includes(event.economicNature)) throw importError('VALIDATION_ERROR')
  const decision = await prepareRepayment(connection, uid, updateId, event, data.repayment)
  const actionId = await insertAction(connection,uid,{ updateId,expectedVersion:updateVersion,appliedVersion:updateVersion+1,
      actionType:'set_loan_repayment',requestDigest,decision:{ eventId,repayment:decision },reasons:['loan_repayment_decided'] })
  await connection.execute(`UPDATE catledger_review_issues i JOIN catledger_review_issue_members m ON m.uid=i.uid AND m.issue_id=i.issue_id
          SET i.status='superseded',i.blocking=0,i.version=i.version+1,i.resolved_action_id=?
          WHERE i.uid=? AND i.update_id=? AND m.object_id=? AND m.object_type='event' AND i.status='open'
          AND i.primary_reason_code='loan_repayment_required'`,[actionId,uid,updateId,eventId])
  const editorOverrides = { ...event.fieldSources.editorOverrides }
  delete editorOverrides.incompleteRepayment
  const next = { ...event,fieldSources:{ ...event.fieldSources,loanRepayment:decision,editorOverrides },
    reasonCodes:event.reasonCodes.filter(r=>r!=='loan_repayment_required' && r!=='blocking_issue_open') }
  const affected = await saveEvents(connection,uid,updateId,[{ current:event,next }],actionId)
  await updateMappingMemberVersions(connection,uid,updateId,affected)
  await createFollowUpIssues(connection,uid,updateId,affected)
  await recalculateUpdateCounts(connection,uid,updateId,updateVersion+1,actionId,updateVersion,0)
  return commandResult(connection,uid,updateId,data)
}

// 旧入口仅保留解除草稿决定的兼容能力；任何新拆分/关联均拒绝。
async function prepareRepayment(connection, uid, updateId, event, value) {
  if (value !== null) throw importError('VALIDATION_ERROR')
  return null
}
module.exports = { setRepayment, prepareRepayment }
