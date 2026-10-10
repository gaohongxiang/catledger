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
  const decision = await prepareRepayment(connection, uid, updateId, event, data.repayment)
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

// 可在现有用户事务内复用，既有专用入口和统一单笔保存采用同一校验。
async function prepareRepayment(connection, uid, updateId, event, value, { editor = false } = {}) {
  const { booking, inputForEvent } = require('../explicit-repayment')
  let decision = null
  if (value != null) {
    if (value.mode === 'review') decision = { mode:'review' }
    else {
      decision = booking.normalize(value,event.amountMinor)
      inputForEvent({ ...event,fieldSources:{ ...event.fieldSources,loanRepayment:decision } })
      // 整理决定不创建账户；已映射的草稿账户在整批入账时再次完整鉴权。
      const catalog = await loadReferenceCatalog(connection,uid,updateId,[event])
      const asset = catalog.accounts.get(decision.assetAccountId) || catalog.drafts.get(decision.assetAccountId)
      const debt = catalog.accounts.get(decision.liabilityAccountId) || catalog.drafts.get(decision.liabilityAccountId)
      if (!asset || !debt || !['cash','bank','wallet','other_asset'].includes(asset.type) || debt.type !== 'other_liability') throw importError('VALIDATION_ERROR')
    }
  }
  const partial = editor && event.fieldSources.editorOverrides?.incompleteRepayment
  if (partial) {
    for (const key of ['interestCategoryId','feeCategoryId']) if (partial[key]) {
      const [[row]] = await connection.execute('SELECT kind FROM catledger_categories WHERE uid=? AND category_id=? AND archived_at IS NULL', [uid, partial[key]])
      if (!row || row.kind !== 'expense') throw importError('VALIDATION_ERROR')
    }
    if (partial.loanId) {
      const [[row]] = await connection.execute('SELECT version FROM catledger_loans WHERE uid=? AND loan_id=? AND deleted_at IS NULL', [uid, partial.loanId])
      if (!row || Number(row.version) !== partial.loanVersion) throw importError('CONFLICT')
    }
    if (partial.chargeAllocations?.length) {
      for (const selection of partial.chargeAllocations) {
        if (!selection.chargeId || !partial.loanId) throw importError('LOAN_CHARGE_COVERAGE')
        const [[row]] = await connection.execute(`SELECT c.charge_id FROM catledger_loan_charges c JOIN catledger_loan_charge_contracts p
          ON p.uid=c.uid AND p.contract_id=c.contract_id WHERE c.uid=? AND c.charge_id=? AND p.loan_id=?`, [uid, selection.chargeId, partial.loanId])
        if (!row) throw importError('LOAN_CHARGE_COVERAGE')
      }
    }
  }
  if (editor && decision && decision.confirmed) {
    // 读取核验不得触发 claimExisting 创建正式费用。导入编辑只引用已有收费项。
    if (decision.chargeAllocations.some(row => row.transactionId)) throw importError('LOAN_CHARGE_COVERAGE')
    for (const key of ['interest','fee']) if (decision[key + 'Treatment'] === 'expense' && decision[key + 'Minor'] !== '0') {
      const [[category]] = await connection.execute(`SELECT kind FROM catledger_categories WHERE uid=? AND category_id=? AND archived_at IS NULL`,
        [uid, decision[key + 'CategoryId']])
      if (!category || category.kind !== 'expense') throw importError('VALIDATION_ERROR')
    }
    if (decision.mode === 'associate') {
      const [[loan]] = await connection.execute(`SELECT loan_id AS loanId, account_id AS accountId,version,baseline_date AS baselineDate,
        baseline_principal_minor AS baselinePrincipalMinor FROM catledger_loans WHERE uid=? AND loan_id=? AND deleted_at IS NULL FOR UPDATE`, [uid, decision.loanId])
      if (!loan || Number(loan.version) !== decision.loanVersion) throw importError('CONFLICT')
      if (loan.accountId !== decision.liabilityAccountId || !loan.baselineDate || loan.baselinePrincipalMinor == null ||
        event.localAt.slice(0,10) < String(loan.baselineDate).slice(0,10)) throw importError('VALIDATION_ERROR')
      await require('../loan-charge-payments').validate(connection, uid, loan, decision, { paymentDate: event.localAt.slice(0,10) })
    } else if (decision.chargeAllocations.length || ['interest','fee'].some(key => decision[key+'Treatment'] === 'accrued' && decision[key+'Minor'] !== '0')) {
      throw importError('LOAN_CHARGE_COVERAGE')
    }
  }
  return decision
}
module.exports = { setRepayment, prepareRepayment }
