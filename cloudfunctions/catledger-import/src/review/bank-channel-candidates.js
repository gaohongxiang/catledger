const { randomUUID } = require('node:crypto')
const { VERSION, REASON, bankChannelGroups, bankChannelPair, pairKey } = require('../bank-channel-matching')
const { digestParts } = require('../digest')
const { importError } = require('../errors')
const { selectPlanningRows, persistPlan } = require('../finance-update-repository')
const { selectDomainEvents, saveEvent } = require('./event-store')
const { updateMappingMemberVersions, createFollowUpIssues } = require('./issue-store')
const { buildReviewIssues } = require('../organizer-planner')
const { PLAN_VERSION } = require('../domain-versions')

const { hydrate, hasBankPlatformEvidence } = require('./bank-channel-hydration')
const { confirmedPrimary, mergeRelations } = require('./bank-channel-merge')
const decisions = require('./bank-channel-decisions')
const { applyPairs } = require('./bank-channel-apply')

async function synchronize(connection, uid, updateId, actionId, rows = null, { reuseDecisions = true } = {}) {
  const [[source]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_finance_update_sources
    WHERE uid = ? AND update_id = ? AND source_type_snapshot = 'bank'`, [uid, updateId])
  if (!Number(source.count)) return
  let events = await hydrate(connection, uid, updateId, null, rows)
  const storedDistinct = new Map(events.map(event => [event.eventId, JSON.stringify(event.fieldSources.bankChannelDistinctPairs || [])]))
  if (reuseDecisions) {
    const remembered = await decisions.remembered(connection, uid, events)
    remembered.filter(pair => pair.decision === 'distinct').forEach(decisions.markDistinct)
    const same = remembered.filter(pair => pair.decision === 'same')
    const uses = new Map()
    for (const pair of same) for (const event of [pair.bank, pair.platform]) uses.set(event.eventId, (uses.get(event.eventId) || 0) + 1)
    // 可靠身份的原决定仍需双向无占用；发生冲突留给当前候选，不猜测。
    const [occupied] = same.length ? await connection.execute(`SELECT DISTINCT event_id AS id FROM catledger_economic_event_transactions
      WHERE uid = ? AND update_id = ?`, [uid, updateId]) : [[]]
    const [accounts] = same.length ? await connection.execute(`SELECT account_id AS id, currency FROM catledger_accounts WHERE uid = ? AND archived_at IS NULL
      UNION ALL SELECT draft_account_id, currency FROM catledger_finance_update_account_drafts WHERE uid = ? AND update_id = ?`, [uid, uid, updateId]) : [[]]
    const unavailable = new Set(occupied.map(row => row.id)), active = new Map(accounts.map(row => [row.id, row.currency]))
    const reusable = same.filter(pair => uses.get(pair.bank.eventId) === 1 && uses.get(pair.platform.eventId) === 1 &&
      !unavailable.has(pair.bank.eventId) && !unavailable.has(pair.platform.eventId) && active.get(pair.bank.ledgerAccountId) === pair.bank.currency &&
      !require('../evidence-matching').hasSourceIdentityConflict(pair.bank.relationEvidence.rows.concat(pair.platform.relationEvidence.rows)))
    if (reusable.length) {
      // 初始化事务沿用原整理的原子边界；内部块限制 SQL 参数和临时集合，不逐笔公开提交。
      for (let offset = 0; offset < reusable.length; offset += 100) {
        await applyPairs(connection, uid, updateId, reusable.slice(offset, offset + 100), actionId, { persistDecisions: false })
      }
      events = await hydrate(connection, uid, updateId, null, rows)
      ;(await decisions.remembered(connection, uid, events)).filter(pair => pair.decision === 'distinct').forEach(decisions.markDistinct)
    }
  }
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
  const distinctChanged = events.some(event => storedDistinct.get(event.eventId) !== JSON.stringify(event.fieldSources.bankChannelDistinctPairs || []))
  // 删除一条边后连通组成员可能完全不变；稳定来源的拒绝边仍必须落库。
  if (!legacyIssues.size && !distinctChanged && JSON.stringify(prior) === JSON.stringify(next)) return
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

async function distinctEvents(connection, uid, updateId, events, { required = true } = {}) {
  const hydrated = await hydrate(connection, uid, updateId, events)
  if (!required && !hasBankPlatformEvidence(hydrated)) return null
  return hydrated.map(event => ({ ...event, fieldSources: { ...event.fieldSources, bankChannelCandidate: undefined,
    bankChannelDistinctPairs: [...new Set([...(event.fieldSources.bankChannelDistinctPairs || []),
      ...hydrated.filter(other => other !== event && bankChannelPair(event, other)).map(other => pairKey(event, other))])] } }))
}

module.exports = { synchronize, confirmedPrimary, distinctEvents, mergeRelations }
