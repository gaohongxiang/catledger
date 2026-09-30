const { randomUUID } = require('node:crypto')
const { VERSION, REASON, bankChannelGroups, bankChannelPair, pairKey } = require('../bank-channel-matching')
const { digestParts } = require('../digest')
const { importError } = require('../errors')
const { selectPlanningRows, persistPlan } = require('../finance-update-repository')
const { selectDomainEvents, saveEvent } = require('./event-store')
const { updateMappingMemberVersions, createFollowUpIssues } = require('./issue-store')
const { buildReviewIssues } = require('../organizer-planner')
const { PLAN_VERSION } = require('../domain-versions')

async function hydrate(connection, uid, updateId, events = null, rows = null) {
  rows = rows || await selectPlanningRows(connection, uid, updateId)
  const [links] = await connection.execute(`SELECT event_id AS eventId, row_id AS rowId, evidence_id AS evidenceId,
    evidence_role AS role FROM catledger_event_evidence WHERE uid = ? AND update_id = ? AND evidence_role <> 'discarded'
    ORDER BY (evidence_role = 'primary') DESC, evidence_id`, [uid, updateId])
  events = events || await selectDomainEvents(connection, uid, updateId, [...new Set(links.map(link => link.eventId))], { forUpdate: true })
  const byId = new Map(rows.map(row => [row.rowId, row]))
  const rowsByEvent = new Map()
  for (const link of links) {
    if (!rowsByEvent.has(link.eventId)) rowsByEvent.set(link.eventId, [])
    if (byId.has(link.rowId)) rowsByEvent.get(link.eventId).push(byId.get(link.rowId))
  }
  return events.map(event => ({ ...event, sourceType: (rowsByEvent.get(event.eventId) || [])[0]?.sourceType,
    relationEvidence: { rows: rowsByEvent.get(event.eventId) || [] } }))
}

function hasBankPlatformEvidence(events) {
  const types = new Set(events.flatMap(event => event.relationEvidence.rows.map(row => row.sourceType)))
  return types.has('bank') && (types.has('wechat') || types.has('alipay'))
}

async function synchronize(connection, uid, updateId, actionId, rows = null) {
  const [[source]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_finance_update_sources
    WHERE uid = ? AND update_id = ? AND source_type_snapshot = 'bank'`, [uid, updateId])
  if (!Number(source.count)) return
  const events = await hydrate(connection, uid, updateId, null, rows)
  // 旧版已确认“不同笔”的决定也继续有效，不能因规则升级再次提问。
  const [distinct] = await connection.execute(`SELECT i.issue_id AS issueId, m.object_id AS eventId
    FROM catledger_review_issues i JOIN catledger_finance_actions a
      ON a.uid = i.uid AND a.update_id = i.update_id AND a.action_id = i.resolved_action_id
    JOIN catledger_review_issue_members m ON m.uid = i.uid AND m.issue_id = i.issue_id
    WHERE i.uid = ? AND i.update_id = ? AND i.issue_type = 'same_event' AND i.status = 'resolved'
      AND JSON_UNQUOTE(JSON_EXTRACT(a.decision_json, '$.decision')) = 'confirm_distinct'
      AND m.object_type = 'event' AND m.member_role = 'subject'`, [uid, updateId])
  for (const issueId of new Set(distinct.map(item => item.issueId))) {
    const ids = new Set(distinct.filter(item => item.issueId === issueId).map(item => item.eventId))
    const members = events.filter(event => ids.has(event.eventId))
    for (const event of members) event.fieldSources = { ...event.fieldSources,
      bankChannelDistinctPairs: [...new Set([...(event.fieldSources.bankChannelDistinctPairs || []),
        ...members.filter(other => other !== event).map(other => pairKey(event, other))])] }
  }
  const [open] = await connection.execute(`SELECT i.issue_id AS issueId, i.issue_type AS issueType,
    i.primary_reason_code AS reason, m.object_id AS eventId FROM catledger_review_issues i
    JOIN catledger_review_issue_members m ON m.uid = i.uid AND m.issue_id = i.issue_id
    WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND m.object_type = 'event' AND m.member_role <> 'candidate'`, [uid, updateId])
  const sameIssues = new Map()
  for (const item of open.filter(item => item.issueType === 'same_event')) {
    if (!sameIssues.has(item.issueId)) sameIssues.set(item.issueId, [])
    sameIssues.get(item.issueId).push(item)
  }
  // 旧文本规则产生的银行/平台候选也必须重验；不能靠旧 reason 标签继续沿用宽松规则。
  const legacyIssues = new Set()
  for (const [issueId, members] of sameIssues) {
    if (members[0].reason === REASON) continue
    const ids = new Set(members.map(item => item.eventId))
    if (hasBankPlatformEvidence(events.filter(event => ids.has(event.eventId)))) legacyIssues.add(issueId)
  }
  const managed = open.filter(item => item.issueType === 'same_event' && (item.reason === REASON || legacyIssues.has(item.issueId)))
  const managedEventIds = new Set(managed.map(item => item.eventId))
  const unavailable = new Set(open.filter(item => item.issueType === 'same_event' && item.reason !== REASON &&
    !legacyIssues.has(item.issueId)).map(item => item.eventId))
  const clean = events.filter(event => !unavailable.has(event.eventId)).map(event => ({ ...event,
    fieldSources: { ...event.fieldSources, bankChannelCandidate: undefined },
    reasonCodes: event.fieldSources.bankChannelCandidate || managedEventIds.has(event.eventId)
      ? event.reasonCodes.filter(reason => ![REASON, 'same_event_candidate', 'relation_ambiguous'].includes(reason)) : [...event.reasonCodes]
  }))
  const groups = bankChannelGroups(clean)
  const desired = new Map(groups.flatMap(group => group.events.map(event => [event.eventId, event])))
  const priorIssues = new Map()
  for (const item of managed) {
    if (!priorIssues.has(item.issueId)) priorIssues.set(item.issueId, [])
    priorIssues.get(item.issueId).push(item.eventId)
  }
  const signature = ids => [...ids].sort().join('|')
  const prior = [...priorIssues.values()].map(signature).sort()
  const next = groups.map(group => signature(group.events.map(event => event.eventId))).sort()
  if (!legacyIssues.size && JSON.stringify(prior) === JSON.stringify(next)) return
  const affectedIds = new Set([...managedEventIds, ...desired.keys(), ...events.filter(event => event.fieldSources.bankChannelCandidate).map(event => event.eventId)])
  const touchedIssues = [...new Set(open.filter(item => affectedIds.has(item.eventId) && item.issueType !== 'account_mapping').map(item => item.issueId))]
  for (const issueId of touchedIssues) {
    const members = open.filter(item => item.issueId === issueId)
    const remaining = members.filter(item => !affectedIds.has(item.eventId))
    if (!remaining.length) {
      await connection.execute(`UPDATE catledger_review_issues SET status = 'superseded', blocking = 0,
        version = version + 1, resolved_action_id = ? WHERE uid = ? AND update_id = ? AND issue_id = ? AND status = 'open'`, [actionId, uid, updateId, issueId])
    } else {
      for (const member of members.filter(item => affectedIds.has(item.eventId))) await connection.execute(
        `DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND issue_id = ? AND object_type = 'event' AND object_id = ?`,
        [uid, updateId, issueId, member.eventId])
      await connection.execute(`UPDATE catledger_review_issues SET version = version + 1,
        member_count = (SELECT COUNT(*) FROM catledger_review_issue_members WHERE uid = ? AND issue_id = ?)
        WHERE uid = ? AND update_id = ? AND issue_id = ?`, [uid, issueId, uid, updateId, issueId])
    }
  }
  const saved = []
  for (const event of events.filter(event => affectedIds.has(event.eventId))) {
    const candidate = desired.get(event.eventId) || clean.find(item => item.eventId === event.eventId)
    if (!candidate) continue
    saved.push(await saveEvent(connection, uid, event, candidate, actionId, { preserveReferences: true, actionSource: 'semantic' }))
  }
  await updateMappingMemberVersions(connection, uid, updateId, saved)
  const review = buildReviewIssues(updateId, groups.flatMap(group => group.events), [], groups, randomUUID)
  for (const issue of review.issues) issue.issueKey = digestParts(VERSION, actionId, issue.issueKey)
  await persistPlan(connection, uid, updateId, { planVersion: PLAN_VERSION, events: [], evidence: [], relations: [], ...review })
  await createFollowUpIssues(connection, uid, updateId, saved.filter(event => !desired.has(event.eventId)))
}

async function confirmedPrimary(connection, uid, updateId, events, requestedId, actionId, { required = true } = {}) {
  const hydrated = await hydrate(connection, uid, updateId, events)
  if (!required && !hasBankPlatformEvidence(hydrated)) return null
  const platforms = hydrated.filter(event => ['wechat', 'alipay'].includes(event.sourceType))
  const banks = hydrated.filter(event => event.sourceType === 'bank')
  // 多个平台或多笔银行候选不能一次合成一笔；交给独立记录裁决。
  if (platforms.length !== 1 || banks.length !== 1 || hydrated.length !== 2 || !bankChannelPair(banks[0], platforms[0])) throw importError('VALIDATION_ERROR')
  const primary = platforms[0]
  if (primary.eventId !== requestedId) throw importError('VALIDATION_ERROR')
  const bankCategoryChosen = Boolean(banks[0].manualFieldMask & 128)
  if (bankCategoryChosen && (primary.manualFieldMask & 128) && banks[0].categoryId !== primary.categoryId) throw importError('VALIDATION_ERROR')
  if (banks[0].economicNature !== 'unknown' && banks[0].economicNature !== primary.economicNature) throw importError('VALIDATION_ERROR')
  const primaryRows = primary.relationEvidence.rows
  const bankRows = banks[0].relationEvidence.rows
  const accountContexts = { ...primary.fieldSources.bankChannelAccountContexts }
  const [accountMembers] = await connection.execute(`SELECT m.member_id AS memberId, m.issue_id AS issueId, m.member_role AS role, m.sort_order AS sortOrder
    FROM catledger_review_issue_members m JOIN catledger_review_issues i ON i.uid = m.uid AND i.issue_id = m.issue_id
    WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'event' AND m.object_id = ? AND i.issue_type = 'account_mapping'`,
  [uid, updateId, banks[0].eventId])
  for (const member of accountMembers) {
    const [[existing]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issue_members
      WHERE uid = ? AND update_id = ? AND issue_id = ? AND object_type = 'event' AND object_id = ? AND member_role = ?`,
    [uid, updateId, member.issueId, primary.eventId, member.role])
    if (Number(existing.count)) {
      await connection.execute('DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND member_id = ?', [uid, updateId, member.memberId])
      await connection.execute(`UPDATE catledger_review_issues SET member_count = member_count - 1, version = version + 1
        WHERE uid = ? AND update_id = ? AND issue_id = ?`, [uid, updateId, member.issueId])
    } else {
      await connection.execute('DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND member_id = ?', [uid, updateId, member.memberId])
      await connection.execute(`INSERT INTO catledger_review_issue_members
        (uid, member_id, update_id, issue_id, object_type, object_id, object_version, member_role, sort_order)
        VALUES (?, ?, ?, ?, 'event', ?, ?, ?, ?)`,
      [uid, member.memberId, updateId, member.issueId, primary.eventId, primary.version + 1, member.role, Number(member.sortOrder)])
      const reference = banks[0].fieldSources.ledgerAccountReference
      if (reference) accountContexts[member.issueId] = { ...reference, fundsSide: 'ordinary' }
    }
  }
  return { ...primary, categoryId: bankCategoryChosen ? banks[0].categoryId : primary.categoryId || banks[0].categoryId,
    manualFieldMask: primary.manualFieldMask | (banks[0].manualFieldMask & 128),
    fieldSources: { ...primary.fieldSources, bankChannelCandidate: undefined,
    bankChannelAccountContexts: accountContexts,
    rowIds: primaryRows.concat(bankRows).map(row => row.rowId),
    bankChannelResolution: { version: VERSION, actionId, ledgerAccountId: primary.ledgerAccountId,
      primaryRowId: primaryRows[0].rowId, explainedBankRowIds: bankRows.map(row => row.rowId) } } }
}

async function mergeRelations(connection, uid, updateId, primaryId, secondaryId) {
  const [relations] = await connection.execute(`SELECT relation_id AS relationId, relation_type AS type, status,
    source_event_id AS sourceId, target_event_id AS targetId, amount_minor AS amountMinor, currency
    FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ?
      AND (source_event_id IN (?, ?) OR target_event_id IN (?, ?)) FOR UPDATE`,
  [uid, updateId, primaryId, secondaryId, primaryId, secondaryId])
  const projected = relations.map(relation => ({ ...relation,
    nextSource: relation.sourceId === secondaryId ? primaryId : relation.sourceId,
    nextTarget: relation.targetId === secondaryId ? primaryId : relation.targetId }))
  const active = projected.filter(relation => !['rejected', 'undone'].includes(relation.status))
  if (active.some(relation => relation.nextSource === relation.nextTarget)) throw importError('VALIDATION_ERROR')
  const confirmedBySource = new Map()
  for (const relation of active.filter(item => item.type === 'refund_of' && item.status === 'confirmed')) {
    const target = confirmedBySource.get(relation.nextSource)
    if (target && target !== relation.nextTarget) throw importError('VALIDATION_ERROR')
    confirmedBySource.set(relation.nextSource, relation.nextTarget)
  }
  for (const relation of projected.filter(item => item.sourceId === secondaryId || item.targetId === secondaryId)) {
    const prior = active.find(item => item !== relation && item.sourceId !== secondaryId && item.targetId !== secondaryId &&
      item.type === relation.type && item.nextSource === relation.nextSource && item.nextTarget === relation.nextTarget)
    if (prior && relation.status === 'confirmed' && prior.status !== 'confirmed') {
      await connection.execute(`UPDATE catledger_economic_event_relations SET status = 'confirmed', version = version + 1
        WHERE uid = ? AND update_id = ? AND relation_id = ?`, [uid, updateId, prior.relationId])
    }
    await connection.execute(`UPDATE catledger_economic_event_relations SET source_event_id = ?, target_event_id = ?,
      status = ?, version = version + 1 WHERE uid = ? AND update_id = ? AND relation_id = ?`,
    [relation.nextSource, relation.nextTarget, prior ? 'rejected' : relation.status, uid, updateId, relation.relationId])
  }
  // 被合并消费的退款核对可能在另一问题中；关系版本必须同步，避免旧版本永远无法提交。
  await connection.execute(`UPDATE catledger_review_issue_members m JOIN catledger_economic_event_relations r
    ON r.uid = m.uid AND r.relation_id = m.object_id SET m.object_version = r.version
    WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'relation'`, [uid, updateId])
}

async function distinctEvents(connection, uid, updateId, events, { required = true } = {}) {
  const hydrated = await hydrate(connection, uid, updateId, events)
  if (!required && !hasBankPlatformEvidence(hydrated)) return null
  return hydrated.map(event => ({ ...event, fieldSources: { ...event.fieldSources, bankChannelCandidate: undefined,
    bankChannelDistinctPairs: [...new Set([...(event.fieldSources.bankChannelDistinctPairs || []),
      ...hydrated.filter(other => other !== event && bankChannelPair(event, other)).map(other => pairKey(event, other))])] } }))
}

module.exports = { synchronize, confirmedPrimary, distinctEvents, mergeRelations }
