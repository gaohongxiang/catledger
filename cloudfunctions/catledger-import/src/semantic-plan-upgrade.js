const { commandResult } = require('./command-result')
const repaymentOwnership = require('./repayment-ownership')
const { randomUUID } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { prepareEvidenceSplit } = require('./evidence-plan-upgrade')
const { hasGroupConflict, identityGroups } = require('./evidence-matching')
const { accountReferences, buildReviewIssues } = require('./organizer-planner')
const { sameEventCandidateGroups, refundRelation } = require('./relation-resolver')
const { findRefundSourceConflicts, withRefundSourceEvidence, applyRefundSourceConflict } = require('./refund-source-conflict')
const { getRowSemantic } = require('./row-semantic-resolver')
const { applyInstallmentDisbursements } = require('./installment-disbursement')
const { SEMANTIC_HARD_BLOCKERS, semanticBlockers } = require('./semantic-policy')
const { economicNatureForRow, INSTALLMENT_PRINCIPAL_NATURES } = require('./organizer-model')
const { unique } = require('./organizer-values')
const { ledgerAccountReferenceForRow, projectSourceFunds, withAggregateCandidates } = require('./source-funds')
const { paymentEvidenceFields } = require('./payment-resolution')
const { referencesForRows } = require('./payment-account-groups')
const { paymentReferenceKey } = require('./payment-account')
const { recalculateUpdateCounts } = require('./review/reconciliation')
const { createFollowUpIssue } = require('./review/issue-store')
const { selectDomainEvents, saveEvent } = require('./review/event-store')
const { FIELD_MASK } = require('./review/policy')
const { insertAction, persistPlan, selectPaymentMappings, selectActiveAccounts, selectDraftPaymentMappings, restoreDraftPaymentMappings } = require('./finance-update-repository')
const { PLAN_VERSION } = require('./domain-versions')
const { CATEGORY_RULE_VERSION } = require('./category-rules')
const { prepareAccountIssueUpgrade, persistAccountIssueUpgrade } = require('./account-plan-upgrade')
const { releaseLegacyIgnore } = require('./legacy-ignore-release')

const SOURCE_REASONS = new Set([...SEMANTIC_HARD_BLOCKERS, 'economic_nature_required',
  'source_account_endpoint_unknown', 'transaction_status_unknown'])

// 在原事件的有效证据组内重算来源语义；绝不重新分组或复制人工决定。
function refreshEventSemantic(current, evidenceRows, planReferences = []) {
  if (!['ready', 'needs_action'].includes(current.status) || !evidenceRows.length) return current
  const repaymentRelation = require('./repayment-channel').evidenceValid(current, evidenceRows)
  evidenceRows = require('./bank-channel-matching').semanticRowsAfterConfirmation(current, evidenceRows)
  const rows = evidenceRows.map(row => ({ ...row, semantic: getRowSemantic(row) }))
  const natures = unique(rows.map(economicNatureForRow))
  const semantics = rows.map(row => row.semantic)
  const blockers = unique(semantics.flatMap(semanticBlockers))
  const registration = semantics.map(semantic => semantic.relationHints && semantic.relationHints.disbursement)
  if (registration.every(hint => hint && hint.role === 'registration')) {
    // 原文识别为登记时，已有人工资金决定保持原样；自动 unknown 记录原位补上登记职责。
    const financialMask = FIELD_MASK.economicNature | FIELD_MASK.flowDirection | FIELD_MASK.counterpartyLedgerAccountId |
      FIELD_MASK.categoryId | FIELD_MASK.paymentResolution | FIELD_MASK.repaymentAllocations
    if (current.manualFieldMask & financialMask) return current
    const fieldSources = { ...(current.fieldSources || {}), semanticBlockers: blockers, disbursement: registration[0],
      ledgerAccountReference: ledgerAccountReferenceForRow(rows[0]), fundsProjection: null }
    delete fieldSources.installment
    const next = { ...current, economicNature: 'unknown', flowDirection: 'neutral', fieldSources,
      reasonCodes: unique([...(current.reasonCodes || []).filter(reason => !SOURCE_REASONS.has(reason)), ...blockers]) }
    return JSON.stringify([next.economicNature,next.flowDirection,next.fieldSources,next.reasonCodes]) ===
      JSON.stringify([current.economicNature,current.flowDirection,current.fieldSources,current.reasonCodes]) ? current : next
  }
  // 放款对行是同一笔分期在卡内的记账行：两行合成一笔借款之后，它本身不产生资金流，
  // 也不再需要确认账户。原地升级要按同一事实把它收进已排除，不能退回“性质待确认”，
  // 否则每次规则升级都会把它重新变成一条待办。人工改过字段的事件不动。
  const offsetHints = semantics.map(semantic => semantic.relationHints && semantic.relationHints.disbursement)
    .filter(hint => hint && hint.role === 'offset')
  if (offsetHints.length === semantics.length && !current.manualFieldMask) {
    const hint = offsetHints[0]
    const reasonCodes = unique([...blockers, 'economic_nature_required', 'installment_offset_pair'])
    const fieldSources = { ...(current.fieldSources || {}), semanticBlockers: blockers, disbursement: hint }
    delete fieldSources.installment
    if (JSON.stringify(current.reasonCodes) === JSON.stringify(reasonCodes) &&
        JSON.stringify(current.fieldSources || {}) === JSON.stringify(fieldSources)) return current
    // 账户引用保持原样：已排除的事件不入账，不为了清掉一个不再使用的账户而改动引用，
    // 否则原地升级会因为引用变化被判成冲突。
    return { ...current, status: 'excluded', economicNature: 'unknown', reasonCodes, fieldSources }
  }
  const sameNature = natures.length === 1 && natures[0] !== 'unknown'
  const financial = semantics.every(semantic => semantic.moneyEffect === 'financial')
  const sources = current.fieldSources || {}
  const disbursementOf = semantic => semantic.relationHints && semantic.relationHints.disbursement || null
  const signature = semantic => [semantic.sourceAction, semantic.moneyEffect, semantic.settlement,
    semantic.issues && semantic.issues.map(issue => issue.code).sort(), semantic.ledgerAccountRef, semantic.fromAccountRef, semantic.toAccountRef,
    semantic.relationHints && semantic.relationHints.installment || null, disbursementOf(semantic)]
  const installment = semantics[0].relationHints && semantics[0].relationHints.installment || null
  const installmentChanged = JSON.stringify(installment) !== JSON.stringify(sources.installment || null)
  const disbursement = disbursementOf(semantics[0])
  const sameDisbursement = semantics.every(semantic => JSON.stringify(disbursementOf(semantic)) === JSON.stringify(disbursement))
  const sameSource = evidenceRows.every((row, index) => row.semantic && isDeepStrictEqual(
    signature(require('./account-binding').scopeSemantic(row.semantic, row)), signature(semantics[index])))
  if (sameSource && !installmentChanged && JSON.stringify(blockers.slice().sort()) === JSON.stringify((sources.semanticBlockers || []).slice().sort()) &&
      ((current.manualFieldMask & FIELD_MASK.economicNature) || (natures.length === 1 && natures[0] === current.economicNature))) return current
  const next = { ...current, fieldSources: { ...sources, semanticBlockers: blockers },
    reasonCodes: (current.reasonCodes || []).filter(reason => !SOURCE_REASONS.has(reason)) }
  if (!financial || !sameNature) {
    // 生命周期或证据间资金性质发生变化时保留原事件，交人工确认，不能自动排除。
    next.reasonCodes = unique([...next.reasonCodes, ...blockers, 'core_fields_conflict'])
  } else {
    if (!(current.manualFieldMask & FIELD_MASK.economicNature)) next.economicNature = natures[0]
    if (!(current.manualFieldMask & FIELD_MASK.flowDirection)) {
      next.flowDirection = ['repayment', 'borrow', 'internal_transfer'].includes(next.economicNature) ? 'neutral'
        : ['income', 'refund'].includes(next.economicNature) ? 'inflow' : 'outflow'
    }
    if (!repaymentRelation && !(current.manualFieldMask & (FIELD_MASK.paymentResolution | FIELD_MASK.repaymentAllocations | FIELD_MASK.counterpartyLedgerAccountId))) {
      const projections = rows.map(row => withAggregateCandidates(projectSourceFunds(row), planReferences))
      const projection = projections[0]
      if (projections.some(value => JSON.stringify(value) !== JSON.stringify(projection))) {
        next.reasonCodes.push('core_fields_conflict')
      } else if (JSON.stringify(projection) !== JSON.stringify(sources.fundsProjection || null)) {
        next.fieldSources.fundsProjection = projection
      }
    }
    next.fieldSources.ledgerAccountReference = ledgerAccountReferenceForRow(rows[0])
    const sameInstallment = semantics.every(semantic => JSON.stringify(semantic.relationHints && semantic.relationHints.installment || null) === JSON.stringify(installment))
    if (sameInstallment) {
      if (installment) next.fieldSources.installment = installment
      else delete next.fieldSources.installment
    } else next.reasonCodes.push('core_fields_conflict')
    // 放款行改成这一对放款的事实：期数、计划名和卡内那一行，供详情和排除说明引用。
    if (sameDisbursement) {
      if (disbursement) next.fieldSources.disbursement = disbursement
      else delete next.fieldSources.disbursement
    } else next.reasonCodes.push('core_fields_conflict')
    if (installment && installment.component === 'principal' && next.economicNature === 'repayment' && !next.counterpartyLedgerAccountId) {
      next.reasonCodes = next.reasonCodes.filter(reason => !['transfer_account_required', 'repayment_account_required', 'borrow_account_required'].includes(reason))
    }
    // 本金行允许改判为支出、费用、收入或待确认；方向由 organizer-model 按性质复核。
    if (installment && installment.component === 'principal' &&
        (!INSTALLMENT_PRINCIPAL_NATURES.has(next.economicNature) || next.counterpartyLedgerAccountId)) next.reasonCodes.push('core_fields_conflict')
    Object.assign(next.fieldSources, paymentEvidenceFields(rows))
    const references = referencesForRows(rows)
    if (!repaymentRelation && references.length) next.fieldSources.paymentAccountReferences = references
    next.reasonCodes = unique([...next.reasonCodes, ...blockers])
  }
  if (semantics.some(semantic => semantic.moneyEffect === 'unknown')) next.reasonCodes.push('transaction_status_unknown')
  // 没有来源语义变化的事件保持原版本和原核对项。
  const sourceView = event => [event.economicNature, event.flowDirection,
    event.fieldSources, event.reasonCodes.filter(reason => SOURCE_REASONS.has(reason) || reason === 'core_fields_conflict').sort()]
  return isDeepStrictEqual(sourceView(next), sourceView(current)) ? current : next
}

function refreshAutomaticCategory(current, rows) {
  if (!['ready', 'needs_action'].includes(current.status) || !rows.length ||
      !['income', 'expense', 'fee'].includes(current.economicNature) ||
      (current.manualFieldMask & (FIELD_MASK.categoryId | FIELD_MASK.economicNature | FIELD_MASK.flowDirection | FIELD_MASK.paymentResolution))) return current
  const primary = rows[0]
  const kind = current.economicNature === 'income' ? 'income' : 'expense'
  if (primary.direction !== kind) return current
  const categoryId = primary.suggestedCategoryId || null
  if (categoryId === current.categoryId) return current
  return { ...current, categoryId,
    reasonCodes: current.reasonCodes.filter(reason => reason !== 'category_required'),
    fieldSources: { ...current.fieldSources, categoryRuleVersion: CATEGORY_RULE_VERSION } }
}

async function upgradeSemanticPlan(connection, uid, current, rows, requestDigest, data = {}) {
  const updateId = current.updateId
  // 与首次整理同一套来源事实推导：放款对改写的是行语义，重算来源语义前必须先应用，
  // 否则一笔已识别成借款的放款行会在规则升级后重新变回“性质待确认”。规则升级就是
  // 按新规则重算，所以所有可升级的计划都要先认出放款对；认不出来时规则本身不成立。
  rows = applyInstallmentDisbursements(rows)
  const [links] = await connection.execute(`SELECT evidence_id AS evidenceId, event_id AS eventId, row_id AS rowId, evidence_role AS role
    FROM catledger_event_evidence WHERE uid = ? AND update_id = ? AND evidence_role <> 'discarded'
    ORDER BY event_id, (evidence_role = 'primary') DESC, evidence_id`, [uid, updateId])
  const events = await selectDomainEvents(connection, uid, updateId, unique(links.map(link => link.eventId)), { forUpdate: true })
  const rowMap = new Map(rows.map(row => [row.rowId, row]))
  const linksByEvent = new Map()
  links.forEach(link => {
    if (!linksByEvent.has(link.eventId)) linksByEvent.set(link.eventId, [])
    linksByEvent.get(link.eventId).push(link)
  })
  const eventRows = event => (linksByEvent.get(event.eventId) || []).map(link => rowMap.get(link.rowId)).filter(Boolean)
  const needsSplit = events.some(event => ['ready', 'needs_action'].includes(event.status) &&
    identityGroups(eventRows(event)).length > 1 && hasGroupConflict(eventRows(event)))
  const paymentMappings = await selectPaymentMappings(connection, uid, updateId)
  const accounts = await selectActiveAccounts(connection, uid)
  const draftMappings = await selectDraftPaymentMappings(connection, uid, updateId)
  const mappingLookup = require('./account-draft-binding').lookup(paymentMappings)
  const references = accountReferences(rows)
  // 本批自己明确选过的「仅本次不计入」会留下忽略草稿，这类已决结果不能因为
  // 规则升级被重新追问；只有找不到本批决定的排除才是旧版永久规则留下的。
  const [ignoredDrafts] = await connection.execute(`SELECT event_id AS eventId, source_type AS sourceType, payment_method_key AS paymentMethodKey
    FROM catledger_finance_update_account_mapping_drafts
    WHERE uid = ? AND update_id = ? AND mapping_action = 'ignore'`, [uid, updateId])
  const ignoredEvents = new Set(ignoredDrafts.map(mapping => mapping.eventId))
  const splits = []
  const changes = events.map(event => {
    const rows = eventRows(event)
    // 只由旧版永久忽略造成的排除先恢复成待确认，再按同一套规则重算语义；
    // 账户事项随后在 account-plan-upgrade 里从“已解决·忽略”改成待确认。
    const keptByBatch = ignoredEvents.has(event.eventId)
    const released = keptByBatch ? null : releaseLegacyIgnore(event)
    if (released) {
      return { current: event, next: refreshAutomaticCategory(refreshEventSemantic(released, rows, references), rows) }
    }
    const split = prepareEvidenceSplit({ current: event, rows, links: linksByEvent.get(event.eventId) || [], paymentMappings, accounts })
    if (split) {
      splits.push(split)
      // 原事件人工字段完全保留，来源语义在该主证据组中继续原位升级。
      const primaryRows = rows.filter(row => split.next.fieldSources.rowIds.includes(row.rowId))
      split.next = refreshAutomaticCategory(refreshEventSemantic(split.next, primaryRows, references), primaryRows)
      return { current: event, next: split.next }
    }
    return { current: event, next: refreshAutomaticCategory(refreshEventSemantic(event, rows, references), rows) }
  })
    .map(pair => {
      if (!['ready', 'needs_action'].includes(pair.next.status)) return pair
      pair.next = require('./account-binding-upgrade').refreshBindings(pair.next,
        eventRows(pair.next).filter(row => !pair.next.fieldSources.rowIds || pair.next.fieldSources.rowIds.includes(row.rowId)), mappingLookup, accounts)
      const ownership = require('./account-ownership').resolve(pair.next)
      const reasons = require('./account-reference-decision').supported(pair.next) &&
        (ownership.explicit || ownership.businessNature === 'repayment') ? ownership.reasons : []
      const source = pair.next.fieldSources || {}
      if (source.loanRepayment || source.editorOverrides?.incompleteRepayment) reasons.push('loan_repayment_required')
      if (reasons.some(reason => !(pair.next.reasonCodes || []).includes(reason))) {
        return { current: pair.current, next: { ...pair.next, reasonCodes: unique([...(pair.next.reasonCodes || []), ...reasons]) } }
      }
      return pair
    })
    .filter(pair => pair.next !== pair.current)
  // 已保存的“待关联”决定不能绕过新版识别出的同订单来源矛盾；仅升级未入账事件。
  const conflicts = findRefundSourceConflicts(events.map(event => withRefundSourceEvidence(event, eventRows(event))))
  const conflictRelations = []
  for (const { refund, originals } of conflicts) {
    const currentEvent = events.find(event => event.eventId === refund.eventId)
    let pair = changes.find(pair => pair.current.eventId === refund.eventId)
    const next = applyRefundSourceConflict(pair ? pair.next : currentEvent, originals)
    if (JSON.stringify(next.fieldSources.refundSourceConflict) === JSON.stringify(currentEvent.fieldSources.refundSourceConflict) &&
        currentEvent.reasonCodes.includes('refund_source_conflict')) continue
    if (pair) pair.next = next
    else changes.push({ current: currentEvent, next })
    for (const original of originals) {
      const relation = refundRelation(updateId, next, original, randomUUID, 'proposed', 'refund_source_conflict')
      conflictRelations.push(relation)
    }
  }
  const version = Number(current.version)
  // 先为事件 JSON 预留动作身份；账户事项需看到实际保存后的事件和拆分事项。
  // 所有写入仍在原事务内，首次外键引用前把完整决定一次追加到审计表。
  const actionId = randomUUID()
  if (conflictRelations.length) await persistPlan(connection, uid, updateId, { planVersion: PLAN_VERSION,
    events: [], evidence: [], relations: conflictRelations, issues: [], members: [] })
  for (const split of splits) {
    await persistPlan(connection, uid, updateId, { planVersion: PLAN_VERSION, events: split.additions,
      evidence: [], relations: [], issues: [], members: [] })
    for (const assignment of split.assignments) await connection.execute(
      `UPDATE catledger_event_evidence SET event_id = ?, evidence_role = ?
        WHERE uid = ? AND update_id = ? AND evidence_id = ?`,
      [assignment.eventId, assignment.role, uid, updateId, assignment.evidenceId]
    )
  }
  const followUpIds = new Set(changes.map(pair => pair.current.eventId))
  if (changes.length) {
    const ids = changes.map(pair => pair.current.eventId)
    const [issues] = await connection.execute(`SELECT DISTINCT i.issue_id AS issueId FROM catledger_review_issues i
      JOIN catledger_review_issue_members m ON m.uid = i.uid AND m.issue_id = i.issue_id
      WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open'
        AND i.issue_type IN ('shared_fields', 'field_conflict', 'transfer_accounts', 'category_assignment', 'same_event', 'identity_conflict', 'refund_relation')
        AND m.object_type = 'event' AND m.object_id IN (${ids.map(() => '?').join(',')})`, [uid, updateId, ...ids])
    for (const issue of issues) {
      const [members] = await connection.execute(`SELECT object_id AS eventId FROM catledger_review_issue_members
        WHERE uid = ? AND update_id = ? AND issue_id = ? AND object_type = 'event'`, [uid, updateId, issue.issueId])
      members.forEach(member => followUpIds.add(member.eventId))
      await connection.execute(`UPDATE catledger_review_issues SET status = 'superseded', blocking = 0, version = version + 1
        WHERE uid = ? AND update_id = ? AND issue_id = ? AND status = 'open'`, [uid, updateId, issue.issueId])
    }
    for (const pair of changes) {
      // 仅刷新系统推导分类；人工分类、账户、金额、时间保持原值。
      // 若人工分类与新性质不兼容，保留分类并要求核对，不能清空用户决定。
      if (pair.next.categoryId && pair.next.categoryId === pair.current.categoryId) {
        const [[category]] = await connection.execute(`SELECT kind FROM catledger_categories
          WHERE uid = ? AND category_id = ? AND archived_at IS NULL`, [uid, pair.next.categoryId])
        const kind = pair.next.economicNature === 'income' ? 'income' : 'expense'
        if (!category || !['income', 'expense', 'fee'].includes(pair.next.economicNature) || category.kind !== kind) {
          pair.next.reasonCodes = unique([...pair.next.reasonCodes, 'core_fields_conflict'])
        }
      }
      await saveEvent(connection, uid, pair.current, pair.next, actionId, { preserveReferences: true,
        actionSource: 'semantic', allowAutomaticCategory: true, allowAutomaticAccounts: true })
      await connection.execute(`UPDATE catledger_review_issue_members m JOIN catledger_review_issues i
        ON i.uid = m.uid AND i.issue_id = m.issue_id SET m.object_version = ?
        WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'event' AND m.object_id = ? AND (i.status = 'open' OR (i.issue_type = 'account_mapping' AND i.status = 'resolved'))`,
      [pair.next.version, uid, updateId, pair.next.eventId])
    }
    for (const split of splits) {
      const conflictEvents = [changes.find(pair => pair.current.eventId === split.next.eventId).next, ...split.additions]
      const review = buildReviewIssues(updateId, conflictEvents, [], sameEventCandidateGroups(conflictEvents), randomUUID)
      await persistPlan(connection, uid, updateId, { planVersion: PLAN_VERSION, events: [], evidence: [], relations: [], ...review })
    }
  }
  const accountPlan = await prepareAccountIssueUpgrade(connection, uid, updateId, events)
  await insertAction(connection, uid, { actionId, updateId, expectedVersion: version, appliedVersion: version + 1,
    actionType: 'semantic_upgrade', requestDigest, reasons: ['source_semantics_upgraded'],
    decision: accountPlan.accountIssueMappings.length ? { accountIssueMappings: accountPlan.accountIssueMappings } : null })
  const bindingView = event => {
    const fields = event.fieldSources || {}
    return [fields.accountBindingVersion, fields.ledgerAccountReference, fields.fundsProjection,
      fields.paymentAccountReferences, fields.bankChannelAccountContexts]
  }
  const boundEvents = changes.filter(pair =>
    pair.next.fieldSources.accountBindingVersion === require('./account-binding').VERSION &&
    !isDeepStrictEqual(bindingView(pair.current), bindingView(pair.next))).map(pair => pair.next)
  for (const part of require('./sql-batch').chunks(boundEvents.map(event => [event.eventId]))) {
    await connection.execute(`DELETE FROM catledger_finance_update_account_mapping_drafts
      WHERE uid=? AND update_id=? AND event_id IN (${part.map(() => '?').join(',')})`, [uid, updateId, ...part.flat()])
  }
  await restoreDraftPaymentMappings(connection, uid, updateId, boundEvents, draftMappings, actionId)
  await persistAccountIssueUpgrade(connection, uid, updateId, accountPlan, actionId)
  const projected = await require('./review/reconciliation').refreshProjectedEvents(connection, uid, updateId, actionId)
  for (const event of projected) followUpIds.add(event.eventId)
  const followUps = await selectDomainEvents(connection, uid, updateId, [...followUpIds])
  await require('./review/issue-store').updateMappingMemberVersions(connection, uid, updateId, followUps)
  for (const event of followUps) await createFollowUpIssue(connection, uid, updateId, event)
  await require('./review/bank-channel-candidates').synchronize(connection, uid, updateId, actionId, rows)
  await recalculateUpdateCounts(connection, uid, updateId, version + 1, actionId, version,
    -splits.reduce((count, split) => count + split.additions.length, 0))
  await connection.execute(`UPDATE catledger_finance_updates SET plan_version = ?
    WHERE uid = ? AND update_id = ? AND version = ?`, [PLAN_VERSION, uid, updateId, version + 1])
  return commandResult(connection, uid, updateId, data)
}
module.exports = { refreshEventSemantic, refreshAutomaticCategory, upgradeSemanticPlan }
