const { importError } = require('../errors')
const { validateUuid, validateVersion } = require('../validation')
const { digestParts } = require('../digest')
const { executeUserRead, executeIdempotentMutation } = require('../import-transaction')
const { selectUpdate, selectPlanningRows, selectPaymentMappings, selectActiveAccounts, persistPlan, insertAction } = require('../finance-update-repository')
const { buildOrganizePlan } = require('../organizer-planner')
const { selectDomainEvents, saveEvents } = require('./event-store')
const { resolvedReasons } = require('./policy')
const { updateMappingMemberVersions, createFollowUpIssues } = require('./issue-store')
const { recalculateUpdateCounts } = require('./reconciliation')
const { commandResult } = require('../command-result')
const { chunks } = require('../sql-batch')
const { randomUUID } = require('node:crypto')
const { assertBudget } = require('../performance-contract')

async function priorDistinctPairs(connection, uid, updateId, event, forUpdate) {
  const keys = new Set(event.fieldSources.bankChannelDistinctPairs || [])
  if (!keys.size) return []
  const hydrated = await require('./bank-channel-hydration').hydrate(connection, uid, updateId, null, null, { forUpdate })
  const clean = hydrated.map(item => ({ ...item, fieldSources: { ...item.fieldSources, bankChannelDistinctPairs: undefined } }))
  return require('../bank-channel-matching').bankChannelEdges(clean).filter(pair => keys.has(pair.pairKey) &&
    [pair.bank.eventId, pair.platform.eventId].includes(event.eventId)).sort((a,b)=>a.pairKey.localeCompare(b.pairKey))
}

async function load(connection, uid, updateId, eventId, forUpdate = false) {
  const update = await selectUpdate(connection, uid, updateId, { forUpdate })
  const [event] = await selectDomainEvents(connection, uid, updateId, [eventId], { forUpdate })
  if (!event) throw importError('NOT_FOUND')
  if (update.status === 'review' && ['ready', 'needs_action'].includes(event.status) && !event.fieldSources.mergeOrigins &&
      !event.fieldSources.bankChannelResolution && (event.fieldSources.bankChannelDistinctPairs || []).length) {
    const pairs = await priorDistinctPairs(connection, uid, updateId, event, forUpdate)
    return { update, event, pairs, kind: 'distinct', reason: pairs.length ? '' : '原配对事实已变化，请先完成当前待核对事项。' }
  }
  const [evidence] = await connection.execute(`SELECT row_id AS rowId, evidence_role AS role FROM catledger_event_evidence
    WHERE uid = ? AND update_id = ? AND event_id = ? AND evidence_role <> 'discarded' ORDER BY row_id`, [uid, updateId, eventId])
  if (update.status === 'review' && event.status === 'excluded' && event.reasonCodes.includes('linked_existing_transaction')) {
    const [[manual]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issues i
      JOIN catledger_finance_actions a ON a.uid=i.uid AND a.action_id=i.resolved_action_id
      JOIN catledger_review_issue_members m ON m.uid=i.uid AND m.issue_id=i.issue_id
      WHERE i.uid=? AND i.update_id=? AND i.status='resolved' AND i.primary_reason_code='historical_duplicate_candidate'
        AND m.object_type='event' AND m.member_role='subject' AND m.object_id=?
        AND JSON_UNQUOTE(JSON_EXTRACT(a.decision_json,'$.decision'))='link_existing_transaction'`, [uid,updateId,eventId])
    const [[sameIdentity]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_event_evidence v
      JOIN catledger_import_rows r ON r.uid=v.uid AND r.row_id=v.row_id
      JOIN catledger_import_rows other ON other.uid=r.uid AND other.identity_id=r.identity_id
      JOIN catledger_event_evidence previous ON previous.uid=other.uid AND previous.row_id=other.row_id
      JOIN catledger_economic_event_transactions l ON l.uid=previous.uid AND l.event_id=previous.event_id AND l.superseded_at IS NULL
      JOIN catledger_transactions t ON t.uid=l.uid AND t.transaction_id=l.transaction_id AND t.deleted_at IS NULL
      WHERE v.uid=? AND v.update_id=? AND v.event_id=? AND previous.event_id<>v.event_id
        AND v.evidence_role<>'discarded' AND previous.evidence_role<>'discarded'
        AND l.role IN ('primary','refund_transaction','repayment_allocation','payment_allocation','historical_primary')`, [uid,updateId,eventId])
    if (Number(manual.count) && !Number(sameIdentity.count)) return { update,event,kind:'historical',reason:'' }
  }
  const [[links]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_economic_event_transactions
    WHERE uid = ? AND update_id = ? AND event_id = ? AND superseded_at IS NULL`, [uid, updateId, eventId])
  let reason = update.status !== 'review' || !['ready', 'needs_action'].includes(event.status)
    ? '仅待入账的合并记录可以重新判断。' : Number(links.count) ? '这笔来源已对应正式账目，不能直接拆成新的待入账记录。'
      : evidence.length > 100 ? '来源较多，请先按具体来源核对。' : ''
  const rows = reason ? [] : await selectPlanningRows(connection, uid, updateId, evidence.map(item => item.rowId))
  const plan = buildOrganizePlan({ updateId, rows, paymentMappings: reason ? [] : await selectPaymentMappings(connection, uid, updateId),
    accounts: reason ? [] : await selectActiveAccounts(connection, uid) })
  if (!reason && (plan.events.length < 2 || rows.some(row => row.existingTransactionId))) reason =
    '这些是同一来源身份的重复账单，不能作为多笔交易再次入账。'
  if (!reason && plan.events.some(item => item.fieldSources.loanRepayment || item.existingTransactionIds.length)) reason = '请先核对已关联的账目。'
  const primaryRow = evidence.find(item => item.role === 'primary')
  const primary = primaryRow && plan.events.find(item => item.fieldSources.rowIds.includes(primaryRow.rowId))
  if (!reason && !primary) throw importError('CONFLICT')
  return { update, event, evidence, rows, plan, primary, reason }
}

async function supersedeRelatedIssues(connection, uid, updateId, eventIds, actionId) {
  // 只移出受影响成员。共享问题的其他成员继续保留原未决状态。
  for (const eventId of eventIds) {
    const [issues] = await connection.execute(`SELECT DISTINCT i.issue_id AS id FROM catledger_review_issues i
      JOIN catledger_review_issue_members m ON m.uid = i.uid AND m.issue_id = i.issue_id
      WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND i.issue_type <> 'account_mapping'
        AND m.object_type = 'event' AND m.member_role <> 'candidate' AND m.object_id = ?`, [uid, updateId, eventId])
    for (const issue of issues) {
      await connection.execute(`DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND issue_id = ?
        AND object_type = 'event' AND object_id = ? AND member_role <> 'candidate'`, [uid, updateId, issue.id, eventId])
      await connection.execute(`UPDATE catledger_review_issues SET version = version + 1,
        member_count = (SELECT COUNT(*) FROM catledger_review_issue_members WHERE uid = ? AND issue_id = ?),
        status = IF(EXISTS(SELECT 1 FROM catledger_review_issue_members WHERE uid = ? AND issue_id = ? AND object_type='event' AND member_role <> 'candidate'), 'open', 'superseded'),
        blocking = IF(status = 'open', blocking, 0), resolved_action_id = IF(status = 'open', resolved_action_id, ?)
        WHERE uid = ? AND update_id = ? AND issue_id = ?`, [uid, issue.id, uid, issue.id, actionId, uid, updateId, issue.id])
    }
  }
}

async function restoreRefundCandidates(connection, uid, updateId, plan, freshIds, primaryId) {
  const events = await require('./bank-channel-hydration').hydrate(connection, uid, updateId)
  const candidates = require('../relation-resolver').buildRelations(updateId, events, randomUUID)
    .filter(row => row.relationType === 'refund_of' && (freshIds.has(row.sourceEventId) || freshIds.has(row.targetEventId)))
  const affected = new Set(), insert = []
  for (const row of candidates) {
    const [[existing]] = await connection.execute(`SELECT relation_id AS id, source_event_id AS sourceId, target_event_id AS targetId
      FROM catledger_economic_event_relations WHERE uid=? AND update_id=? AND relation_key=?`, [uid,updateId,row.relationKey])
    if (existing && [existing.sourceId,existing.targetId].includes(primaryId)) {
      await connection.execute(`UPDATE catledger_economic_event_relations SET source_event_id=?,target_event_id=?,status='proposed',manual=0,version=version+1
        WHERE uid=? AND update_id=? AND relation_id=?`, [row.sourceEventId,row.targetEventId,uid,updateId,existing.id])
      affected.add(row.sourceEventId)
    } else if (!existing && freshIds.has(row.sourceEventId)) {
      insert.push({ ...row,status:'proposed',manual:false }); affected.add(row.sourceEventId)
    }
  }
  await persistPlan(connection,uid,updateId,{ ...plan,events:[],evidence:[],relations:insert,issues:[],members:[] })
  return [...affected]
}

async function split(connection, uid, data, requestDigest, values) {
  const { updateId, eventId, updateVersion, eventVersion } = values
  const state = await load(connection, uid, updateId, eventId, true)
  if (Number(state.update.version) !== updateVersion || state.event.version !== eventVersion) throw importError('CONFLICT')
  if (state.reason || state.kind) throw importError('VALIDATION_ERROR')
  const { event, plan, primary } = state, oldPrimaryId = primary.eventId
  const actionId = await insertAction(connection, uid, { updateId, expectedVersion: updateVersion, appliedVersion: updateVersion + 1,
    actionType: 'revise_duplicate', requestDigest, decision: { eventId, decision: 'distinct' }, reasons: ['duplicate_decision_revised'] })
  const origins = event.fieldSources.mergeOrigins || []
  for (const planned of plan.events) {
    const rowIds = planned.fieldSources.rowIds
    const original = origins.find(item => item.rowIds.length === rowIds.length && item.rowIds.every(id => rowIds.includes(id)))
    if (planned === primary) Object.assign(planned, event, { eventId, version: eventVersion })
    else if (original) Object.assign(planned, original.event)
    planned.updateId = updateId
    planned.sameEventCandidateKey = undefined
    planned.fieldSources = { ...planned.fieldSources, rowIds, mergeOrigins: undefined, bankChannelResolution: undefined,
      bankChannelCandidate: undefined, bankChannelAccountContexts: undefined, lastUserActionId: actionId }
    planned.reasonCodes = resolvedReasons('same_event', planned.reasonCodes)
    planned.status = 'needs_action'
  }
  const fresh = plan.events.filter(item => item !== primary)
  // 新记录只建领域事件，原文通过原 evidence_id 移动，不复制账单或身份。
  await persistPlan(connection, uid, updateId, { ...plan, events: fresh, evidence: [], relations: [], issues: [], members: [] })
  for (const planned of plan.events) {
    const group = plan.evidence.filter(item => item.eventId === (planned === primary ? oldPrimaryId : planned.eventId))
    for (const item of group) await connection.execute(`UPDATE catledger_event_evidence SET event_id = ?, evidence_role = ?
      WHERE uid = ? AND update_id = ? AND event_id = ? AND row_id = ? AND evidence_role <> 'discarded'`,
    [planned.eventId, item.evidenceRole, uid, updateId, eventId, item.rowId])
  }
  // 合并时可能把银行来源的退款关系移至保留记录。拆开后重新核验这些关系，不能沿用猜测。
  const [relations] = await connection.execute(`SELECT DISTINCT source_event_id AS id FROM catledger_economic_event_relations
    WHERE uid = ? AND update_id = ? AND relation_type = 'refund_of' AND status IN ('proposed','confirmed')
      AND (source_event_id = ? OR target_event_id = ?)`, [uid, updateId, eventId, eventId])
  await connection.execute(`UPDATE catledger_economic_event_relations SET status='proposed', manual=0, version=version+1
    WHERE uid = ? AND update_id = ? AND relation_type='refund_of' AND status='confirmed'
      AND (source_event_id = ? OR target_event_id = ?)`, [uid, updateId, eventId, eventId])
  const freshIds = new Set(fresh.map(item => item.eventId))
  const restoredRefunds = await restoreRefundCandidates(connection,uid,updateId,plan,freshIds,eventId)
  const affectedIds = [...new Set([eventId, ...relations.map(item => item.id), ...restoredRefunds])]
  const other = await selectDomainEvents(connection, uid, updateId, affectedIds.filter(id => id !== eventId && !freshIds.has(id)), { forUpdate: true })
  for (const item of [...plan.events, ...other]) if (item.economicNature === 'refund') {
    item.fieldSources = { ...item.fieldSources, refundRelation: undefined }
    item.reasonCodes = resolvedReasons('refund_relation', item.reasonCodes)
  }
  await supersedeRelatedIssues(connection, uid, updateId, affectedIds, actionId)
  const hydrated = await require('./bank-channel-hydration').hydrate(connection, uid, updateId, plan.events)
  const pairs = require('../bank-channel-matching').bankChannelEdges(hydrated).map(pair => ({ ...pair, decision: 'distinct' }))
  for (const pair of pairs) require('./bank-channel-decisions').markDistinct(pair)
  // 撤销这一来源对的旧同笔记忆，再记录当前事实；金额/性质变化不会继承旧合并。
  const identities = [...new Set(state.rows.map(row => row.identityId).filter(Boolean))]
  for (const part of chunks(identities.map(id => [id]))) await connection.execute(`UPDATE catledger_bank_channel_decisions
    SET decision = 'distinct', action_id = ?, updated_at = CURRENT_TIMESTAMP(3)
    WHERE uid = ? AND decision = 'same' AND bank_identity_id IN (${part.map(() => '?').join(',')})
      AND platform_identity_id IN (${part.map(() => '?').join(',')})`, [actionId, uid, ...part.flat(), ...part.flat()])
  await require('./bank-channel-decisions').remember(connection, uid, pairs, actionId)
  for (const item of hydrated) {
    const planned = plan.events.find(candidate => candidate.eventId === item.eventId)
    planned.fieldSources.bankChannelDistinctPairs = item.fieldSources.bankChannelDistinctPairs
  }
  // 银行专用账户成员曾移到主记录；移除这些上下文后，新来源各自补回账户核对。
  for (const issueId of Object.keys(event.fieldSources.bankChannelAccountContexts || {})) {
    await connection.execute(`DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND issue_id = ?
      AND object_type='event' AND object_id = ?`, [uid, updateId, issueId, eventId])
    await connection.execute(`UPDATE catledger_review_issues SET member_count=(SELECT COUNT(*) FROM catledger_review_issue_members WHERE uid=? AND issue_id=?),
      status=IF(member_count=0,'superseded',status),blocking=IF(member_count=0,0,blocking),version=version+1
      WHERE uid=? AND update_id=? AND issue_id=?`, [uid, issueId, uid, updateId, issueId])
  }
  for (const item of fresh.filter(item=>item.ledgerAccountId && !item.fieldSources.fundsProjection)) {
    await require('./account-mapping-stage').stageAccountMappings(connection,uid,updateId,[item.eventId],item.ledgerAccountId,actionId)
  }
  const saved = await saveEvents(connection, uid, updateId, [...plan.events, ...other].map(item => ({
    current: item === primary ? event : item, next: { ...item, resolvingIssueType: 'same_event' } })), actionId)
  const newIds = new Set(fresh.map(item => item.eventId)), newMembers = plan.members.filter(item => newIds.has(item.objectId))
  const newIssueIds = new Set(newMembers.map(item => item.issueId))
  const accountIssues = plan.issues.filter(item => newIssueIds.has(item.issueId) && item.issueType === 'account_mapping')
  for (const issue of accountIssues) {
    issue.issueKey = digestParts('split-account', actionId, issue.issueKey)
    issue.memberCount = newMembers.filter(item => item.issueId === issue.issueId).length
  }
  await persistPlan(connection, uid, updateId, { ...plan, events: [], evidence: [], relations: [], issues: accountIssues,
    members: newMembers.filter(item => accountIssues.some(issue => issue.issueId === item.issueId))
      .map(item => ({ ...item, objectVersion: saved.find(row => row.eventId === item.objectId).version })) })
  await updateMappingMemberVersions(connection, uid, updateId, saved)
  await updateMappingMemberVersions(connection, uid, updateId, saved, true)
  await connection.execute(`UPDATE catledger_review_issue_members m JOIN catledger_economic_event_relations r ON r.uid=m.uid AND r.relation_id=m.object_id
    SET m.object_version=r.version WHERE m.uid=? AND m.update_id=? AND m.object_type='relation'`, [uid, updateId])
  await createFollowUpIssues(connection, uid, updateId, saved)
  await require('./bank-channel-candidates').synchronize(connection, uid, updateId, actionId, null, { reuseDecisions: false })
  await recalculateUpdateCounts(connection, uid, updateId, updateVersion + 1, actionId, updateVersion, -fresh.length)
  return commandResult(connection, uid, updateId)
}

async function mergeAgain(connection, uid, data, requestDigest, values) {
  const { updateId, eventId, updateVersion, eventVersion } = values
  const state = await load(connection, uid, updateId, eventId, true)
  if (Number(state.update.version) !== updateVersion || state.event.version !== eventVersion) throw importError('CONFLICT')
  if (state.kind !== 'distinct' || state.reason) throw importError('VALIDATION_ERROR')
  const pair = state.pairs.find(item => item.pairKey === data.pairKey)
  if (!pair) throw importError('CONFLICT')
  const other = pair.bank.eventId === eventId ? pair.platform : pair.bank
  if (other.eventId !== data.otherEventId || other.version !== data.otherEventVersion) throw importError('CONFLICT')
  const [stored] = await selectDomainEvents(connection, uid, updateId, [other.eventId], { forUpdate: true })
  if (!stored || stored.version !== other.version) throw importError('CONFLICT')
  const actionId = await insertAction(connection, uid, { updateId, expectedVersion: updateVersion, appliedVersion: updateVersion + 1,
    actionType: 'revise_duplicate', requestDigest, decision: { eventId, otherEventId: other.eventId, pairKey: pair.pairKey, decision: 'same' },
    reasons: ['duplicate_decision_revised'] })
  // 只解除被重新确认的这一对；其他“不同笔”的选择仍保留。
  for (const item of [pair.bank, pair.platform]) {
    const source = item.eventId === eventId ? state.event : stored
    item.fieldSources.bankChannelDistinctPairs = (source.fieldSources.bankChannelDistinctPairs || []).filter(key => key !== pair.pairKey)
  }
  await require('./bank-channel-apply').applyPairs(connection, uid, updateId, [{ ...pair, decision:'same' }], actionId)
  await require('./bank-channel-candidates').synchronize(connection, uid, updateId, actionId, null, { reuseDecisions:false })
  await recalculateUpdateCounts(connection, uid, updateId, updateVersion + 1, actionId, updateVersion)
  return commandResult(connection, uid, updateId)
}

async function reopenHistory(connection, uid, data, requestDigest, values) {
  const { updateId,eventId,updateVersion,eventVersion } = values
  const state = await load(connection,uid,updateId,eventId,true)
  if (Number(state.update.version)!==updateVersion || state.event.version!==eventVersion) throw importError('CONFLICT')
  if (state.kind!=='historical') throw importError('VALIDATION_ERROR')
  const actionId = await insertAction(connection,uid,{ updateId,expectedVersion:updateVersion,appliedVersion:updateVersion+1,
    actionType:'revise_duplicate',requestDigest,decision:{ eventId,decision:'reopen' },reasons:['historical_duplicate_reopened'] })
  await connection.execute(`UPDATE catledger_economic_event_transactions SET superseded_at=CURRENT_TIMESTAMP(3)
    WHERE uid=? AND update_id=? AND event_id=? AND role='historical_primary' AND superseded_at IS NULL`, [uid,updateId,eventId])
  await connection.execute(`UPDATE catledger_review_issues i SET status='superseded',blocking=0,version=version+1,resolved_action_id=?
    WHERE i.uid=? AND i.update_id=? AND i.primary_reason_code='historical_duplicate_candidate'
      AND EXISTS(SELECT 1 FROM catledger_review_issue_members m WHERE m.uid=i.uid AND m.issue_id=i.issue_id
        AND m.object_type='event' AND m.member_role='subject' AND m.object_id=?)`, [actionId,uid,updateId,eventId])
  const next={ ...state.event,status:'needs_action',reasonCodes:state.event.reasonCodes.filter(code=>!['linked_existing_transaction','already_posted'].includes(code)) }
  const saved=await require('./event-store').saveEvent(connection,uid,state.event,next,actionId,{ preserveReferences:true })
  await updateMappingMemberVersions(connection,uid,updateId,[saved])
  await createFollowUpIssues(connection,uid,updateId,[saved])
  await recalculateUpdateCounts(connection,uid,updateId,updateVersion+1,actionId,updateVersion)
  return commandResult(connection,uid,updateId)
}

function previewRecord(item) {
  const row = item.relationEvidence.rows[0]
  return { sourceType: row.sourceType, localAt: item.localAt, amountMinor: item.amountMinor, currency: item.currency,
    title: String(row.counterparty || row.item || '原始记录').slice(0,160), evidenceCount: item.relationEvidence.rows.length }
}

function createDuplicateRevision({ getPool }) {
  return {
    async preview(context) {
      const updateId = validateUuid(context.data.updateId), eventId = validateUuid(context.data.eventId)
      const pairIndex = context.data.pairIndex == null ? 0 : context.data.pairIndex
      if(!Number.isInteger(pairIndex) || pairIndex<0 || pairIndex>10000) throw importError('VALIDATION_ERROR')
      return executeUserRead({ getPool, ...context, consistentSnapshot: true, operation: async (connection, uid) => {
        const view = await require('../finance-update-read').readVersion(connection, uid, updateId)
        if (context.data.viewVersion && context.data.viewVersion !== view.viewVersion) throw importError('STALE_VIEW')
        const state = await load(connection, uid, updateId, eventId)
        if (state.kind === 'distinct' && state.pairs.length && pairIndex >= state.pairs.length) throw importError('VALIDATION_ERROR')
        if(state.kind==='historical') return { protocolVersion:2,viewVersion:view.viewVersion,update:view.update,
          eventVersion:state.event.version,kind:'historical',reason:'将返回待核对，重新选择历史账目或确认是独立记录。已入账账目保持原样。',
          canReopen:true,canSplit:false,count:1,records:[] }
        if (state.kind === 'distinct') return assertBudget({ protocolVersion:2, viewVersion:view.viewVersion, update:view.update,
          eventVersion:state.event.version, kind:'distinct', reason:state.reason, canSplit:false, canMerge:!state.reason,
          pairIndex, pairs:state.pairs.slice(pairIndex,pairIndex+1).map(pair => { const other = pair.bank.eventId === eventId ? pair.platform : pair.bank
            return { pairKey:pair.pairKey, otherEventId:other.eventId, otherEventVersion:other.version,
              records:[previewRecord(pair.bank),previewRecord(pair.platform)] } }), records:[], count:state.pairs.length }, 'page')
        return assertBudget({ protocolVersion: 2, viewVersion: view.viewVersion, update: view.update, eventVersion: state.event.version,
          kind:'same', canSplit: !state.reason, reason: state.reason, count: state.plan.events.length,
          records: state.plan.events.map(previewRecord) }, 'page')
      } })
    },
    async revise(context) {
      const input = context.data, values = { updateId: validateUuid(input.updateId), eventId: validateUuid(input.eventId),
        updateVersion: validateVersion(input.updateVersion), eventVersion: validateVersion(input.eventVersion) }
      if (!['distinct','same','reopen'].includes(input.decision)) throw importError('VALIDATION_ERROR')
      if (input.decision === 'same') {
        validateUuid(input.otherEventId); validateVersion(input.otherEventVersion)
        if (typeof input.pairKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.pairKey)) throw importError('VALIDATION_ERROR')
      }
      return executeIdempotentMutation({ getPool, ...context, action: 'financeUpdates.reviseDuplicate',
        operation: (connection, uid, data, requestDigest) => (data.decision === 'same' ? mergeAgain : data.decision === 'reopen' ? reopenHistory : split)(connection, uid, data, requestDigest, values) })
    }
  }
}
module.exports = { createDuplicateRevision }
