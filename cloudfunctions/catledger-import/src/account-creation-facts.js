const identity = require('./local-review-identity')
const draftPolicy = require('./account-draft-policy')
const accountTypes = require('./account-type-policy')
const { memberReference } = require('./account-reference-context')
const clone = value => JSON.parse(JSON.stringify(value))
const unique = values => [...new Set(values)].sort()
const same = (left, right) => JSON.stringify(unique(left)) === JSON.stringify(unique(right))
const failure = () => { throw Object.assign(new Error('账户创建来源已变化，请重新核对'), { code: 'LOCAL_RECHECK_REQUIRED', publicCode: 'LOCAL_RECHECK_REQUIRED' }) }
const malformed = () => { throw Object.assign(new Error('账户创建事实格式无效'), { code: 'VALIDATION_ERROR', publicCode: 'VALIDATION_ERROR' }) }
const memberKey = member => [member.issueId, member.objectId, member.memberRole].join(':')
const draftOf = choice => choice?.fields?.mappingAccountDraft || choice?.fields?.ledgerAccountDraft
const accountId = (fact, snapshotId) => identity.accountId(snapshotId, fact.draft.name, fact.draft.type, fact.draft.creationKey)
function memberValue(member) {
  return { issueId: member.issueId, objectType: 'event', objectId: member.objectId, memberRole: member.memberRole }
}
function fromChoice(choice, facts, selectedMembers, selectedEvents) {
  const draft = draftOf(choice)
  if (!draft) return null
  const value = draftPolicy.validate(draft)
  const members = (selectedMembers || facts.members || []).filter(member => member.objectType === 'event' &&
    member.memberRole !== 'candidate' && (selectedMembers || member.issueId === choice.issueId))
  if (!members.length) return null
  const key = identity.accountCreationKey(members, selectedEvents || facts.events || [])
  if (value.creationKey && value.creationKey !== key) failure()
  return { key, origin: { snapshotId: facts.snapshotId, issueId: choice.issueId }, draft: { name: value.name, type: value.type, currency: value.currency,
    ...(value.creationKey ? { creationKey: value.creationKey } : {}) },
  members: members.map(memberValue), sourceIds: unique(choice.sourceIds || []) }
}
function shape(fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact) ||
      Object.keys(fact).some(key => !['key', 'origin', 'draft', 'members', 'sourceIds'].includes(key)) ||
      !/^[a-f0-9]{64}$/.test(fact.key) || !Array.isArray(fact.members) || !fact.members.length ||
      fact.members.length > 50000 || !Array.isArray(fact.sourceIds) || !fact.sourceIds.length ||
      fact.sourceIds.length > 25000 || fact.sourceIds.some(id => typeof id !== 'string') ||
      new Set(fact.sourceIds).size !== fact.sourceIds.length) malformed()
  if (!fact.origin || typeof fact.origin !== 'object' || Array.isArray(fact.origin) ||
      Object.keys(fact.origin).some(key => !['snapshotId', 'issueId'].includes(key)) ||
      typeof fact.origin.snapshotId !== 'string' || typeof fact.origin.issueId !== 'string') malformed()
  const draft = draftPolicy.validate(fact.draft)
  if (Object.keys(fact.draft).some(key => !['name', 'type', 'currency', 'creationKey'].includes(key)) ||
      draft.creationKey && draft.creationKey !== fact.key) malformed()
  const seen = new Set()
  for (const member of fact.members) {
    if (!member || typeof member !== 'object' || Array.isArray(member) ||
        Object.keys(member).some(key => !['issueId', 'objectType', 'objectId', 'memberRole'].includes(key)) ||
        member.objectType !== 'event' || typeof member.issueId !== 'string' || typeof member.objectId !== 'string' ||
        typeof member.memberRole !== 'string' || member.memberRole === 'candidate' || seen.has(memberKey(member))) malformed()
    seen.add(memberKey(member))
  }
  return fact
}
// 创建证明只引用已有成员。账户名和客户端账户 ID 都不能建立该证明。
function validate(fact, facts) {
  shape(fact)
  if (fact.origin.snapshotId === facts.snapshotId) validateOrigin(fact, facts)
  const byId = facts.events instanceof Map ? facts.events : new Map((facts.events || []).map(event => [event.eventId, event]))
  const trusted = new Map((facts.members || []).filter(member => member.objectType === 'event' && member.memberRole !== 'candidate')
    .map(member => [memberKey(member), member]))
  const selected = fact.members.map(member => trusted.get(memberKey(member)))
  if (selected.some(member => !member || !byId.has(member.objectId))) failure()
  const eventIds = new Set(selected.map(member => member.objectId))
  const sourceIds = (facts.evidence || []).filter(row => eventIds.has(row.eventId) && row.evidenceRole !== 'discarded').map(row => row.rowId)
  if (!same(fact.sourceIds, sourceIds) || identity.accountCreationKey(selected, byId) !== fact.key) failure()
  const draft = draftPolicy.validate(fact.draft)
  for (const member of selected) {
    const event = byId.get(member.objectId)
    const reference = memberReference(event, member) || { currency: event.currency }
    if (draft.currency !== (reference.binding?.currency || reference.currency || 'CNY') ||
        !accountTypes.rules(reference, { event, memberRole: member.memberRole }).allowedAccountTypes.includes(draft.type)) failure()
  }
  return clone(fact)
}
function validateOrigin(fact, facts) {
  shape(fact)
  if (fact.origin.snapshotId !== facts.snapshotId) failure()
  const issue = (facts.issues || []).find(item => item.issueId === fact.origin.issueId && item.issueType === 'account_mapping' &&
    ['open', 'resolved'].includes(item.status))
  if (!issue) failure()
  const members = (facts.members || []).filter(member => member.issueId === issue.issueId && member.objectType === 'event' && member.memberRole !== 'candidate')
  const port = member => member.objectId + ':' + member.memberRole
  const ids = new Set(members.map(member => member.objectId))
  const sources = (facts.evidence || []).filter(row => ids.has(row.eventId) && row.evidenceRole !== 'discarded').map(row => row.rowId)
  if (!members.length || !same(members.map(port), fact.members.map(port)) || !same(sources, fact.sourceIds) ||
      identity.accountCreationKey(members, facts.events || []) !== fact.key) failure()
  return fact
}
// 旧日志中的创建也独立保留；后来的 external/reuse 不会抹掉原创建事实。
function collect(records, facts) {
  const result = new Map()
  for (const record of records || []) for (const change of record.changes || []) {
    if (change.kind === 'accountCreation') {
      if (change.value === null) result.delete(change.key)
      else result.set(change.key, clone(change.value))
    } else if (change.kind === 'accounts' && draftOf(change.value)) {
      try {
        const fact = fromChoice(change.value, facts)
        if (fact) result.set(fact.key, fact)
      } catch (_) { /* 原决定仍由重放核验；不把无效旧输入升级成创建事实。 */ }
    }
  }
  return result
}
function rebase(fact, facts) {
  const members = (facts.members || []).filter(member => member.objectType === 'event' && member.memberRole !== 'candidate')
  const selected = fact.members.map(prior => {
    const matches = members.filter(member => member.objectId === prior.objectId && member.memberRole === prior.memberRole)
    return matches.find(member => member.issueId === prior.issueId) || (matches.length === 1 ? matches[0] : null)
  })
  if (selected.some(member => !member)) return { ...clone(fact), needsRecheck: true }
  const value = { ...clone(fact), members: selected.map(memberValue) }
  delete value.needsRecheck
  try { return validate(value, facts) } catch (_) { return { ...value, needsRecheck: true } }
}
function referencedIds(decisions, snapshotId) {
  const result = new Set(), queue = [decisions]
  while (queue.length) {
    const value = queue.pop()
    if (!value || typeof value !== 'object') continue
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /^(accountId|.*AccountId)$/.test(key)) result.add(item)
      else if (item && typeof item === 'object') queue.push(item)
    }
  }
  for (const choice of decisions.accounts || []) {
    const draft = draftOf(choice)
    if (draft) result.add(identity.accountId(snapshotId, draft.name, draft.type, draft.creationKey))
  }
  return result
}
module.exports = { fromChoice, collect, validate, validateOrigin, shape, rebase, accountId, draftOf, memberKey, referencedIds }
