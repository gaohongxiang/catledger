const { randomUUID } = require('node:crypto')
const { digestParts } = require('./digest')
const { PLAN_VERSION, REVIEW_ISSUE_VERSION } = require('./domain-versions')
const { groupKey, mappedAccount } = require('./payment-account-groups')
const { mappingReferenceForMember } = require('./review/account-mapping-policy')
const { chunks } = require('./sql-batch')

function memberReference(event, member) {
  return event.fieldSources?.bankChannelAccountContexts?.[member.issueId] ||
    mappingReferenceForMember(event, member.memberRole)
}
function memberAccount(event, member, reference) {
  if (reference?.memberRole) return mappedAccount(event, reference)
  return ['mapping_to', 'payment_target'].includes(member.memberRole) ? event.counterpartyLedgerAccountId : event.ledgerAccountId
}
function referenceGroup(event, member, reference) {
  return (reference && groupKey(reference) || event.eventId + ':' + member.memberRole) + ':' + event.currency
}

// 只迁移账户事项的分组；事件、证据、人工字段和旧决定均保持原身份。
// 以成员集合而非第一条记录裁决合并，多条旧决定有冲突时保留为待核对。
function planAccountIssueUpgrade({ updateId, previousEvents, events, issues, members, idFactory = randomUUID }) {
  const before = new Map(previousEvents.map(event => [event.eventId, event]))
  const after = new Map(events.map(event => [event.eventId, event]))
  const issueById = new Map(issues.filter(issue => issue.issueType === 'account_mapping' && ['open', 'resolved'].includes(issue.status))
    .map(issue => [issue.issueId, issue]))
  const descriptors = [], affected = new Set()
  for (const member of members) {
    const issue = issueById.get(member.issueId), event = after.get(member.objectId), previous = before.get(member.objectId)
    if (!issue || member.objectType !== 'event' || !event || !previous || ['posted', 'corrected'].includes(event.status)) continue
    const reference = memberReference(event, member), oldReference = memberReference(previous, member)
    const key = referenceGroup(event, member, reference)
    descriptors.push({ member, issue, event, reference, key })
    if (reference?.paymentMethodKey && oldReference?.paymentMethodKey && key !== referenceGroup(previous, member, oldReference)) affected.add(issue.issueId)
  }
  // 一个旧事项可包含多个角色；扩展到相交的完整事项，避免一半成员留在旧组。
  const groups = new Map()
  for (const descriptor of descriptors) {
    if (!groups.has(descriptor.key)) groups.set(descriptor.key, [])
    groups.get(descriptor.key).push(descriptor)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const group of groups.values()) if (group.some(item => affected.has(item.issue.issueId))) {
      for (const item of group) if (!affected.has(item.issue.issueId)) { affected.add(item.issue.issueId); changed = true }
    }
  }
  const nextIssues = [], nextMembers = [], accountIssueMappings = []
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (!group.some(item => affected.has(item.issue.issueId))) continue
    const targets = group.map(({ event, member, reference }) => {
      const accountId = memberAccount(event, member, reference)
      if (accountId) return 'account:' + accountId
      return event.status === 'excluded' && event.reasonCodes.some(reason => ['source_account_ignored_default', 'account_mapping_excluded'].includes(reason)) ? 'ignore' : null
    })
    const distinct = new Set(targets.filter(Boolean)), complete = targets.every(Boolean)
    const resolved = complete && distinct.size === 1 && group.every(item => item.issue.status === 'resolved')
    const ignored = resolved && distinct.has('ignore')
    const reason = resolved ? ignored ? 'payment_reference_ignored_by_history' : 'account_mapping_confirmed'
      : distinct.size > 1 ? 'account_mapping_conflict' : 'payment_reference_mapping_required'
    const issueId = idFactory(), uniqueMembers = new Map()
    for (const item of group) uniqueMembers.set(item.event.eventId + ':' + item.member.memberRole, item)
    nextIssues.push({ issueId, updateId, issueKey: digestParts('account-plan-upgrade-v1', PLAN_VERSION, updateId, key),
      issueKeyVersion: REVIEW_ISSUE_VERSION, issueType: 'account_mapping', status: resolved ? 'resolved' : 'open',
      version: 1, blocking: !resolved, primaryReasonCode: reason, memberCount: uniqueMembers.size, candidateCount: 0,
      ruleVersion: REVIEW_ISSUE_VERSION, reasonCodes: ignored ? ['source_account_ignored_default'] : [reason] })
    let sortOrder = 0
    for (const { event, member } of [...uniqueMembers.values()].sort((a, b) =>
      a.event.eventId.localeCompare(b.event.eventId) || a.member.memberRole.localeCompare(b.member.memberRole))) {
      nextMembers.push({ memberId: idFactory(), updateId, issueId, objectType: 'event', objectId: event.eventId,
        objectVersion: event.version, memberRole: member.memberRole, sortOrder: sortOrder++ })
    }
    for (const fromIssueId of [...new Set(group.map(item => item.issue.issueId))].sort()) accountIssueMappings.push({ fromIssueId, toIssueId: issueId })
  }
  return { issues: nextIssues, members: nextMembers, supersededIssueIds: [...affected].sort(), accountIssueMappings }
}

async function prepareAccountIssueUpgrade(connection, uid, updateId, previousEvents) {
  const { selectDomainEvents } = require('./review/event-store')
  const [issues] = await connection.execute(`SELECT issue_id AS issueId, issue_type AS issueType, status
    FROM catledger_review_issues WHERE uid=? AND update_id=? AND issue_type='account_mapping' AND status IN ('open','resolved')`, [uid, updateId])
  if (!issues.length) return { issues: [], members: [], supersededIssueIds: [], accountIssueMappings: [] }
  const [members] = await connection.execute(`SELECT m.issue_id AS issueId,m.object_type AS objectType,m.object_id AS objectId,m.member_role AS memberRole
    FROM catledger_review_issue_members m JOIN catledger_review_issues i ON i.uid=m.uid AND i.issue_id=m.issue_id
    WHERE m.uid=? AND m.update_id=? AND i.issue_type='account_mapping' AND i.status IN ('open','resolved')`, [uid, updateId])
  const events = await selectDomainEvents(connection, uid, updateId, previousEvents.map(event => event.eventId))
  return planAccountIssueUpgrade({ updateId, previousEvents, events, issues, members })
}

async function persistAccountIssueUpgrade(connection, uid, updateId, plan, actionId) {
  if (!plan.issues.length) return
  const { persistPlan } = require('./finance-update-repository')
  for (const part of chunks(plan.supersededIssueIds.map(id => [id]))) await connection.execute(`UPDATE catledger_review_issues
    SET status='superseded',blocking=0,version=version+1,resolved_action_id=?
    WHERE uid=? AND update_id=? AND issue_id IN (${part.map(() => '?').join(',')}) AND status IN ('open','resolved')`, [actionId, uid, updateId, ...part.flat()])
  await persistPlan(connection, uid, updateId, { planVersion: PLAN_VERSION, events: [], evidence: [], relations: [], issues: plan.issues, members: plan.members })
}
module.exports = { planAccountIssueUpgrade, prepareAccountIssueUpgrade, persistAccountIssueUpgrade }
