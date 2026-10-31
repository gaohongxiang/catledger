const { digestParts } = require('./portable-digest')
const { groupKey, referenceForRole, mappedAccount } = require('./payment-account-groups')

function memberReference(event, member) {
  const sources = event.fieldSources || {}, projection = sources.fundsProjection
  if (sources.bankChannelAccountContexts && sources.bankChannelAccountContexts[member.issueId]) {
    return sources.bankChannelAccountContexts[member.issueId]
  }
  return referenceForRole(event, member.memberRole) ||
    (member.memberRole === 'mapping_from' ? projection && projection.from :
      member.memberRole === 'mapping_to' ? projection && projection.to :
        member.memberRole === 'subject' ? sources.ledgerAccountReference : null) || null
}

function memberAccount(event, member, reference) {
  if (reference && reference.memberRole) return mappedAccount(event, reference)
  return ['mapping_to', 'payment_target'].includes(member.memberRole) ? event.counterpartyLedgerAccountId : event.ledgerAccountId
}

function referenceGroup(event, member, reference = memberReference(event, member)) {
  const identity = reference && groupKey(reference) ||
    (member.memberRole === 'subject' && event.accountGroupingKey) || event.eventId + ':' + member.memberRole
  // 明确排除的范围不能被同账户的计入选择覆盖；币种也不能在归组时混用。
  const scope = event.status !== 'excluded' ? 'included'
    : (event.reasonCodes || []).includes('source_account_ignored_default') ? 'ignored' : 'excluded'
  return identity + ':' + (event.currency || 'CNY') + ':' + scope
}

// 普通付款、资金两端和组合付款的账户待办在这里统一按账户身份收敛。
// 只合并事项及成员，绝不合并事件或改写金额。每个成员保留其资金角色。
function coalesceAccountIssues(events, issues, members, idFactory) {
  const eventById = new Map(events.map(event => [event.eventId, event]))
  const membersByIssue = new Map(), groups = new Map(), keysByIssue = new Map()
  for (const member of members) {
    if (!membersByIssue.has(member.issueId)) membersByIssue.set(member.issueId, [])
    membersByIssue.get(member.issueId).push(member)
  }
  for (const issue of issues) {
    const items = membersByIssue.get(issue.issueId) || []
    if (issue.issueType !== 'account_mapping' || !['open', 'resolved'].includes(issue.status) || !items.length ||
        items.some(member => member.objectType !== 'event' || !eventById.has(member.objectId))) continue
    const keys = new Set()
    for (const member of items) {
      const event = eventById.get(member.objectId), reference = memberReference(event, member)
      const key = referenceGroup(event, member, reference)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push({ issue, member, event, reference })
      keys.add(key)
    }
    keysByIssue.set(issue.issueId, keys)
  }
  const nextIssues = [], nextMembers = [], emitted = new Set()
  for (const issue of issues) {
    const keys = keysByIssue.get(issue.issueId)
    if (!keys) {
      nextIssues.push(issue); nextMembers.push(...membersByIssue.get(issue.issueId) || [])
      continue
    }
    for (const key of keys) {
      if (emitted.has(key)) continue
      emitted.add(key)
      const group = groups.get(key), sourceIds = new Set(group.map(item => item.issue.issueId))
      if (sourceIds.size === 1 && keys.size === 1) {
        nextIssues.push(issue); nextMembers.push(...membersByIssue.get(issue.issueId))
        continue
      }
      const uniqueMembers = new Map(group.map(item => [item.member.objectId + ':' + item.member.memberRole, item]))
      const items = [...uniqueMembers.values()]
      const targets = items.map(item => item.event.status === 'excluded' ? 'ignore'
        : memberAccount(item.event, item.member, item.reference) || null)
      const distinct = new Set(targets.filter(Boolean))
      const resolved = targets.every(Boolean) && distinct.size === 1 && group.every(item => item.issue.status === 'resolved')
      const projected = items.some(item => item.member.memberRole !== 'subject')
      const reason = distinct.size > 1 ? 'account_mapping_conflict' : resolved
        ? distinct.has('ignore') ? issue.primaryReasonCode : projected ? 'payment_reference_mapping_confirmed' : 'account_mapping_confirmed'
        : projected ? 'payment_reference_mapping_required' : issue.primaryReasonCode
      const issueId = idFactory()
      nextIssues.push({ ...issue, issueId, issueKey: digestParts('account-issue-grouping-v1', issue.updateId, key),
        status: resolved ? 'resolved' : 'open', blocking: !resolved, primaryReasonCode: reason,
        memberCount: items.length, reasonCodes: resolved ? distinct.has('ignore')
          ? [...new Set(group.flatMap(item => item.issue.reasonCodes || []))] : ['account_mapping_confirmed'] : [reason] })
      items.forEach(({ member }, sortOrder) => nextMembers.push({ ...member, issueId, sortOrder }))
    }
  }
  return { issues: nextIssues, members: nextMembers }
}

module.exports = { memberReference, memberAccount, referenceGroup, coalesceAccountIssues }
