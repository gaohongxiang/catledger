const repaymentOwnership = require('./repayment-ownership')
const { randomUUID } = require('node:crypto')
const { prepareEvidenceSplit } = require('./evidence-plan-upgrade')
const { hasGroupConflict, identityGroups } = require('./evidence-matching')
const { buildReviewIssues } = require('./organizer-planner')
const { sameEventCandidateGroups } = require('./relation-resolver')
const { getRowSemantic } = require('./row-semantic-resolver')
const { SEMANTIC_HARD_BLOCKERS, semanticBlockers } = require('./semantic-policy')
const { economicNatureForRow, unique } = require('./organizer-model')
const { ledgerAccountReferenceForRow, projectSourceFunds } = require('./source-funds')
const { paymentEvidenceFields } = require('./payment-resolution')
const { referencesForRows } = require('./payment-account-groups')
const { FIELD_MASK, selectDomainEvents, saveEvent, createFollowUpIssue, recalculateUpdateCounts } = require('./review-issue-service')
const { insertAction, getUpdateView, persistPlan, selectPaymentMappings, selectActiveAccounts } = require('./finance-update-repository')
const { PLAN_VERSION } = require('./domain-versions')

const SOURCE_REASONS = new Set([...SEMANTIC_HARD_BLOCKERS, 'economic_nature_required',
  'source_account_endpoint_unknown', 'transaction_status_unknown'])

// 在原事件的有效证据组内重算来源语义；绝不重新分组或复制人工决定。
function refreshEventSemantic(current, evidenceRows) {
  if (!['ready', 'needs_action'].includes(current.status) || !evidenceRows.length) return current
  const rows = evidenceRows.map(row => ({ ...row, semantic: getRowSemantic(row) }))
  const natures = unique(rows.map(economicNatureForRow))
  const semantics = rows.map(row => row.semantic)
  const blockers = unique(semantics.flatMap(semanticBlockers))
  const sameNature = natures.length === 1 && natures[0] !== 'unknown'
  const financial = semantics.every(semantic => semantic.moneyEffect === 'financial')
  const sources = current.fieldSources || {}
  const signature = semantic => JSON.stringify([semantic.sourceAction, semantic.moneyEffect, semantic.settlement,
    semantic.issues && semantic.issues.map(issue => issue.code).sort(), semantic.fromAccountRef, semantic.toAccountRef])
  const sameSource = evidenceRows.every((row, index) => row.semantic && signature(row.semantic) === signature(semantics[index]))
  if (sameSource && JSON.stringify(blockers.slice().sort()) === JSON.stringify((sources.semanticBlockers || []).slice().sort()) &&
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
    if (!(current.manualFieldMask & (FIELD_MASK.paymentResolution | FIELD_MASK.repaymentAllocations))) {
      const projections = rows.map(projectSourceFunds)
      const projection = projections[0]
      if (projections.some(value => JSON.stringify(value) !== JSON.stringify(projection))) {
        next.reasonCodes.push('core_fields_conflict')
      } else if (JSON.stringify(projection) !== JSON.stringify(sources.fundsProjection || null)) {
        next.fieldSources.fundsProjection = projection
      }
    }
    next.fieldSources.ledgerAccountReference = ledgerAccountReferenceForRow(rows[0])
    Object.assign(next.fieldSources, paymentEvidenceFields(rows))
    const references = referencesForRows(rows)
    if (references.length) next.fieldSources.paymentAccountReferences = references
    next.reasonCodes = unique([...next.reasonCodes, ...blockers])
  }
  if (semantics.some(semantic => semantic.moneyEffect === 'unknown')) next.reasonCodes.push('transaction_status_unknown')
  // 没有来源语义变化的事件保持原版本和原核对项。
  const sourceView = event => JSON.stringify([event.economicNature, event.flowDirection,
    event.fieldSources, event.reasonCodes.filter(reason => SOURCE_REASONS.has(reason) || reason === 'core_fields_conflict').sort()])
  return sourceView(next) === sourceView(current) ? current : next
}

async function upgradeSemanticPlan(connection, uid, current, rows, requestDigest) {
  const updateId = current.updateId
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
  const paymentMappings = needsSplit ? await selectPaymentMappings(connection, uid, updateId) : []
  const accounts = needsSplit ? await selectActiveAccounts(connection, uid) : []
  const splits = []
  const changes = events.map(event => {
    const rows = eventRows(event)
    const split = prepareEvidenceSplit({ current: event, rows, links: linksByEvent.get(event.eventId) || [], paymentMappings, accounts })
    if (split) {
      splits.push(split)
      // 原事件人工字段完全保留，来源语义在该主证据组中继续原位升级。
      split.next = refreshEventSemantic(split.next, rows.filter(row => split.next.fieldSources.rowIds.includes(row.rowId)))
      return { current: event, next: split.next }
    }
    return { current: event, next: refreshEventSemantic(event, rows) }
  })
    .map(pair => {
      if (!['ready', 'needs_action'].includes(pair.next.status)) return pair
      const reasons = repaymentOwnership.reasonsFor(pair.next)
      if (reasons.some(reason => !(pair.next.reasonCodes || []).includes(reason))) {
        return { current: pair.current, next: { ...pair.next, reasonCodes: unique([...(pair.next.reasonCodes || []), ...reasons]) } }
      }
      return pair
    })
    .filter(pair => pair.next !== pair.current)
  const version = Number(current.version)
  const actionId = await insertAction(connection, uid, { updateId, expectedVersion: version, appliedVersion: version + 1,
    actionType: 'semantic_upgrade', requestDigest, reasons: ['source_semantics_upgraded'] })
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
        AND i.issue_type IN ('shared_fields', 'field_conflict', 'transfer_accounts', 'category_assignment', 'same_event', 'identity_conflict')
        AND m.object_type = 'event' AND m.object_id IN (${ids.map(() => '?').join(',')})`, [uid, updateId, ...ids])
    for (const issue of issues) {
      const [members] = await connection.execute(`SELECT object_id AS eventId FROM catledger_review_issue_members
        WHERE uid = ? AND update_id = ? AND issue_id = ? AND object_type = 'event'`, [uid, updateId, issue.issueId])
      members.forEach(member => followUpIds.add(member.eventId))
      await connection.execute(`UPDATE catledger_review_issues SET status = 'superseded', blocking = 0, version = version + 1
        WHERE uid = ? AND update_id = ? AND issue_id = ? AND status = 'open'`, [uid, updateId, issue.issueId])
    }
    for (const pair of changes) {
      // 仅刷新系统推导，所有账户、分类、金额、时间都沿用已有值。
      // 若已有分类与新性质不兼容，保留分类并要求核对，不能清空用户决定。
      if (pair.next.categoryId) {
        const [[category]] = await connection.execute(`SELECT kind FROM catledger_categories
          WHERE uid = ? AND category_id = ? AND archived_at IS NULL`, [uid, pair.next.categoryId])
        const kind = pair.next.economicNature === 'income' ? 'income' : 'expense'
        if (!category || !['income', 'expense', 'fee'].includes(pair.next.economicNature) || category.kind !== kind) {
          pair.next.reasonCodes = unique([...pair.next.reasonCodes, 'core_fields_conflict'])
        }
      }
      await saveEvent(connection, uid, pair.current, pair.next, actionId, { preserveReferences: true, actionSource: 'semantic' })
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
    const followUps = await selectDomainEvents(connection, uid, updateId, [...followUpIds])
    for (const event of followUps) await createFollowUpIssue(connection, uid, updateId, event)
  }
  await recalculateUpdateCounts(connection, uid, updateId, version + 1, actionId, version,
    -splits.reduce((count, split) => count + split.additions.length, 0))
  await connection.execute(`UPDATE catledger_finance_updates SET plan_version = ?
    WHERE uid = ? AND update_id = ? AND version = ?`, [PLAN_VERSION, uid, updateId, version + 1])
  return getUpdateView(connection, uid, updateId)
}
module.exports = { refreshEventSemantic, upgradeSemanticPlan }
