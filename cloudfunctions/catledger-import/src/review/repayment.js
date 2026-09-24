const { commandResult } = require('../command-result')
const { importError } = require('../errors')
const { insertAction, selectUpdate } = require('../finance-update-repository')
const { selectDomainEvents, loadReferenceCatalog, saveEvents } = require('./event-store')
const { updateMappingMemberVersions, createFollowUpIssues } = require('./issue-store')
const { effectiveProjectedEvents, recalculateUpdateCounts } = require('./reconciliation')


async function setRepayment(connection, uid, data, requestDigest, { updateId, eventId, updateVersion, eventVersion }) {
        const update = await selectUpdate(connection,uid,updateId,{ forUpdate:true })
        if (update.status !== 'review' || Number(update.version) !== updateVersion) throw importError('CONFLICT')
        const stored = await selectDomainEvents(connection,uid,updateId,[eventId],{ forUpdate:true })
        const [event] = await effectiveProjectedEvents(connection,uid,updateId,stored)
        if (!event || event.version !== eventVersion || !['ready','needs_action'].includes(event.status)) throw importError('CONFLICT')
        if (!['repayment','internal_transfer'].includes(event.economicNature)) throw importError('VALIDATION_ERROR')
        const { booking,inputForEvent } = require('../explicit-repayment')
        let decision = null
        if (data.repayment != null) {
          if (data.repayment.mode === 'review') decision = { mode:'review' }
          else {
            decision = booking.normalize(data.repayment,event.amountMinor)
            inputForEvent({ ...event,fieldSources:{ ...event.fieldSources,loanRepayment:decision } })
            // 整理决定不创建账户；已映射的草稿账户在整批入账时再次完整鉴权。
            const catalog = await loadReferenceCatalog(connection,uid,updateId,[event])
            const asset = catalog.accounts.get(decision.assetAccountId) || catalog.drafts.get(decision.assetAccountId)
            const debt = catalog.accounts.get(decision.liabilityAccountId) || catalog.drafts.get(decision.liabilityAccountId)
            if (!asset || !debt || !['cash','bank','wallet','other_asset'].includes(asset.type) || debt.type !== 'other_liability') throw importError('VALIDATION_ERROR')
          }
        }
        const actionId = await insertAction(connection,uid,{ updateId,expectedVersion:updateVersion,appliedVersion:updateVersion+1,
          actionType:'set_loan_repayment',requestDigest,decision:{ eventId,repayment:decision },reasons:['loan_repayment_decided'] })
        await connection.execute(`UPDATE catledger_review_issues i JOIN catledger_review_issue_members m ON m.uid=i.uid AND m.issue_id=i.issue_id
          SET i.status='superseded',i.blocking=0,i.version=i.version+1,i.resolved_action_id=?
          WHERE i.uid=? AND i.update_id=? AND m.object_id=? AND m.object_type='event' AND i.status='open'
          AND i.primary_reason_code='loan_repayment_required'`,[actionId,uid,updateId,eventId])
        const next = { ...event,fieldSources:{ ...event.fieldSources,loanRepayment:decision },
          reasonCodes:event.reasonCodes.filter(r=>r!=='loan_repayment_required' && r!=='blocking_issue_open') }
        const affected = await saveEvents(connection,uid,updateId,[{ current:event,next }],actionId)
        await updateMappingMemberVersions(connection,uid,updateId,affected)
        await createFollowUpIssues(connection,uid,updateId,affected)
        await recalculateUpdateCounts(connection,uid,updateId,updateVersion+1,actionId,updateVersion,0)
        return commandResult(connection,uid,updateId,data)
      }

module.exports = { setRepayment }
