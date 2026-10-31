const { randomUUID } = require('node:crypto')
const { digestParts } = require('./digest')
const { PLAN_VERSION, REVIEW_ISSUE_VERSION } = require('./domain-versions')
const { memberReference, memberAccount, referenceGroup } = require('./account-issue-grouping')
const { chunks } = require('./sql-batch')
const { FIELD_MASK } = require('./manual-field-mask')

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
    // 旧规则造成的排除已在语义升级里恢复成待确认；这条事项必须跟着重建，
    // 否则事件回到待核对却仍挂着“已解决·忽略”的账户项。
    if (previous.status === 'excluded' && event.status !== 'excluded') {
      affected.add(issue.issueId)
    }
    // v40 的组合还款目标可能只有已解决事项，实际事件没有目标账户。
    // 这种不一致重开确认；不能把缺失账户当作排除，也不猜写人工账户字段。
    if (issue.status === 'resolved' && member.memberRole === 'payment_target' && event.economicNature === 'repayment' &&
        !(event.manualFieldMask & (FIELD_MASK.economicNature | FIELD_MASK.counterpartyLedgerAccountId)) &&
        ['ready', 'needs_action'].includes(event.status) &&
        !memberAccount(event, member, reference)) affected.add(issue.issueId)
    if (reference?.paymentMethodKey && oldReference?.paymentMethodKey && key !== referenceGroup(previous, member, oldReference)) affected.add(issue.issueId)
  }
  // 一个旧事项可包含多个角色；扩展到相交的完整事项，避免一半成员留在旧组。
  const groups = new Map()
  for (const descriptor of descriptors) {
    if (!groups.has(descriptor.key)) groups.set(descriptor.key, [])
    groups.get(descriptor.key).push(descriptor)
  }
  // 旧计划把普通付款和组合成分分开建项；即使账户引用没变，也须归成一个完整范围。
  for (const group of groups.values()) {
    const issueIds = new Set(group.map(item => item.issue.issueId))
    if (issueIds.size > 1) issueIds.forEach(issueId => affected.add(issueId))
  }
  let changed = true
  while (changed) {
    changed = false
    for (const group of groups.values()) if (group.some(item => affected.has(item.issue.issueId))) {
      for (const item of group) if (!affected.has(item.issue.issueId)) { affected.add(item.issue.issueId); changed = true }
    }
  }
  const nextIssues = [], nextMembers = [], accountIssueMappings = [], contextUpdates = new Map()
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (!group.some(item => affected.has(item.issue.issueId))) continue
    const targets = group.map(({ event, member, reference }) => {
      if (event.status === 'excluded' && event.reasonCodes.some(reason => ['source_account_ignored_default', 'account_mapping_excluded'].includes(reason))) return 'ignore'
      const accountId = memberAccount(event, member, reference)
      if (accountId) return 'account:' + accountId
      return null
    })
    const distinct = new Set(targets.filter(Boolean)), complete = targets.every(Boolean)
    const resolved = complete && distinct.size === 1 && group.every(item => item.issue.status === 'resolved')
    const ignored = resolved && distinct.has('ignore')
    const reason = resolved ? ignored ? 'payment_reference_ignored_by_history' : 'account_mapping_confirmed'
      : distinct.size > 1 ? 'account_mapping_conflict' : 'payment_reference_mapping_required'
    const issueId = idFactory(), uniqueMembers = new Map()
    for (const item of group) uniqueMembers.set(item.event.eventId + ':' + item.member.memberRole, item)
    // 银行与平台确认同笔后，银行引用按旧事项保存；新事项必须继续指向该引用，
    // 不能退回主事件的平台别名。保留旧键供历史与拆分恢复使用。
    for (const { event, member } of group) {
      const contexts = event.fieldSources?.bankChannelAccountContexts, reference = contexts?.[member.issueId]
      if (!reference) continue
      if (!contextUpdates.has(event.eventId)) contextUpdates.set(event.eventId,
        { eventId: event.eventId, version: event.version, contexts: { ...contexts } })
      contextUpdates.get(event.eventId).contexts[issueId] = reference
    }
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
    // 迁移关系只承接本批已保存的人工选择，不会把旧快照里的自动排除变成决定。
    // local_v3 的明确选择尚未同步到服务端；即使服务端释放了历史忽略，也要让
    // 本机按完整成员和来源范围保留这次选择，没有本机决定的组则保持待确认。
    for (const fromIssueId of [...new Set(group.map(item => item.issue.issueId))].sort()) accountIssueMappings.push({ fromIssueId, toIssueId: issueId })
  }
  for (const member of nextMembers) if (contextUpdates.has(member.objectId)) member.objectVersion++
  return { issues: nextIssues, members: nextMembers, supersededIssueIds: [...affected].sort(), accountIssueMappings,
    contextUpdates: [...contextUpdates.values()] }
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
  for (const update of plan.contextUpdates || []) {
    const [result] = await connection.execute(`UPDATE catledger_economic_events
      SET field_sources_json=JSON_SET(field_sources_json,'$.bankChannelAccountContexts',CAST(? AS JSON),'$.lastSemanticActionId',?),version=version+1
      WHERE uid=? AND update_id=? AND event_id=? AND version=?`,
    [JSON.stringify(update.contexts), actionId, uid, updateId, update.eventId, update.version])
    if (result.affectedRows !== 1) throw require('./errors').importError('CONFLICT')
    await connection.execute(`UPDATE catledger_review_issue_members m JOIN catledger_review_issues i
      ON i.uid=m.uid AND i.issue_id=m.issue_id SET m.object_version=?
      WHERE m.uid=? AND m.update_id=? AND m.object_type='event' AND m.object_id=?
        AND (i.status='open' OR (i.issue_type='account_mapping' AND i.status='resolved'))`,
    [update.version + 1, uid, updateId, update.eventId])
  }
  for (const part of chunks(plan.supersededIssueIds.map(id => [id]))) await connection.execute(`UPDATE catledger_review_issues
    SET status='superseded',blocking=0,version=version+1,resolved_action_id=?
    WHERE uid=? AND update_id=? AND issue_id IN (${part.map(() => '?').join(',')}) AND status IN ('open','resolved')`, [actionId, uid, updateId, ...part.flat()])
  await persistPlan(connection, uid, updateId, { planVersion: PLAN_VERSION, events: [], evidence: [], relations: [], issues: plan.issues, members: plan.members })
}
module.exports = { planAccountIssueUpgrade, prepareAccountIssueUpgrade, persistAccountIssueUpgrade }
