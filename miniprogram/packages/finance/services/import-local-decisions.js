const identity = require('../domain/import-review/local-review-identity')
const clone = value => JSON.parse(JSON.stringify(value))
const kinds = new Set(['accounts','events','pairings','reviews','duplicates','draft','pairingDraft'])
const unique = values => [...new Set(values)].sort()
const same = (left, right) => JSON.stringify(unique(left)) === JSON.stringify(unique(right))
const nameKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
function indexFacts(facts) {
  const members = new Map(), sources = new Map(), sourceEvents = new Map(), eventIssues = new Map()
  for (const row of facts?.members || []) if (row.objectType === 'event' && row.memberRole !== 'candidate') {
    if (!members.has(row.issueId)) members.set(row.issueId, [])
    members.get(row.issueId).push(row)
    if (!eventIssues.has(row.objectId)) eventIssues.set(row.objectId, new Set())
    eventIssues.get(row.objectId).add(row.issueId)
  }
  for (const row of facts?.evidence || []) if (row.evidenceRole !== 'discarded') {
    if (!sources.has(row.eventId)) sources.set(row.eventId, [])
    sources.get(row.eventId).push(row.rowId)
    if (!sourceEvents.has(row.rowId)) sourceEvents.set(row.rowId, [])
    sourceEvents.get(row.rowId).push(row.eventId)
  }
  return { members, sources, sourceEvents, eventIssues }
}
function members(index, issueId) { return index.members.get(issueId) || [] }
function sourceIds(index, eventIds) { return unique(eventIds.flatMap(id => index.sources.get(id) || [])) }
function choiceScope(index, issue) {
  const eventIds = unique(members(index, issue.issueId).map(row => row.objectId))
  return { key: issue.issueId, issueId: issue.issueId, issueType: issue.issueType, reasonCode: issue.primaryReasonCode,
    eventIds, sourceIds: sourceIds(index, eventIds) }
}
function memberKey(member) { return member.objectId + ':' + member.memberRole }
function accountDraft(choice) { return choice.fields?.mappingAccountDraft || choice.fields?.ledgerAccountDraft }
function target(choice, facts) {
  const draft = accountDraft(choice)
  if (!draft) return choice.fields?.mappingAccountId || choice.fields?.ledgerAccountId || null
  return identity.accountId(facts.snapshotId, draft.name, draft.type, draft.creationKey)
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
}
function accountFingerprint(choice) {
  const fields = clone(choice.fields || {})
  if (Object.prototype.hasOwnProperty.call(fields, 'mappingAccountId')) { fields.ledgerAccountId = fields.mappingAccountId; delete fields.mappingAccountId }
  if (Object.prototype.hasOwnProperty.call(fields, 'mappingAccountDraft')) { fields.ledgerAccountDraft = fields.mappingAccountDraft; delete fields.mappingAccountDraft }
  if (fields.ledgerAccountDraft?.name) fields.ledgerAccountDraft.name = nameKey(fields.ledgerAccountDraft.name)
  return JSON.stringify(canonical({ decision: choice.decision, fields, paymentRuleAction: choice.paymentRuleAction || null }))
}
function replaceAccountIds(value, aliases, key = '') {
  if (Array.isArray(value)) return value.map(item => replaceAccountIds(item, aliases, key))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replaceAccountIds(item, aliases, name)]))
  return typeof value === 'string' && /^(accountId|.*AccountId)$/.test(key) && aliases.has(value) ? aliases.get(value) : value
}
// 新快照发布前把最终决定一次性写入其日志；旧日志仅作为输入，不改写。
// 账户范围只按服务端迁移关系和完整成员集合继承，不能由标签或行序猜测。
function rebase(records, oldFacts, newFacts) {
  const oldIndex = indexFacts(oldFacts), newIndex = indexFacts(newFacts)
  const final = new Map()
  for (const record of records || []) for (const change of record.changes || []) {
    if (!kinds.has(change.kind) && !(change.kind === 'ui' && change.key === 'step')) continue
    const key = change.kind + ':' + change.key
    if (change.value === null) final.delete(key)
    else final.set(key, clone(change))
  }
  const aliases = new Map()
  if (oldFacts) for (const { kind, value } of final.values()) if (kind === 'accounts' && accountDraft(value)) {
    aliases.set(target(value, oldFacts), target(value, newFacts))
  }
  const changes = [...final.values()].map(change => ({ ...change, value: replaceAccountIds(change.value, aliases) }))
  const routes = new Map()
  for (const action of newFacts.actions || []) if (action.actionType === 'semantic_upgrade') {
    for (const pair of action.decision?.accountIssueMappings || []) {
      if (!routes.has(pair.fromIssueId)) routes.set(pair.fromIssueId, new Set())
      routes.get(pair.fromIssueId).add(pair.toIssueId)
    }
  }
  function destinations(id, seen = new Set()) {
    if (!routes.has(id) || seen.has(id)) return [id]
    const nextSeen = new Set([...seen, id])
    return unique([...routes.get(id)].flatMap(next => destinations(next, nextSeen)))
  }
  const issues = new Map((newFacts.issues || []).filter(issue => issue.issueType === 'account_mapping' && ['open','resolved'].includes(issue.status)).map(issue => [issue.issueId, issue]))
  const grouped = new Map(), draftGroups = new Map(), orphaned = [], result = []
  for (const change of changes) {
    if (change.kind === 'draft') {
      const targets = destinations(change.key).filter(id => issues.has(id))
      if (targets.length) {
        for (const id of targets) {
          if (!draftGroups.has(id)) draftGroups.set(id, [])
          draftGroups.get(id).push(change)
        }
        continue
      }
    }
    if (change.kind !== 'accounts') {
      if (change.kind === 'pairingDraft') change.value.needsRecheck = true
      result.push(change); continue
    }
    let targets = destinations(change.value.issueId).filter(id => issues.has(id))
    let value = change.value
    if (!targets.length) {
      // 没有服务端迁移承诺时仅把旧编辑挂到当前核对入口，不能自动应用。
      targets = unique((value.eventIds || []).flatMap(id => [...newIndex.eventIssues.get(id) || []])).filter(id => issues.has(id))
      value = { ...value, needsRecheck: true }
      if (!targets.length) { orphaned.push(value); continue }
    }
    for (const id of targets) {
      if (!grouped.has(id)) grouped.set(id, [])
      grouped.get(id).push(value)
    }
  }
  for (const [issueId, choices] of grouped) {
    const issue = issues.get(issueId), scope = choiceScope(newIndex, issue)
    const fingerprints = new Set(choices.map(accountFingerprint))
    const covered = new Set(choices.flatMap(choice => members(oldIndex, choice.issueId).map(memberKey)))
    const complete = oldFacts ? members(newIndex, issueId).every(member => covered.has(memberKey(member)))
      : choices.length === 1 && choices[0].issueId === issueId && same(choices[0].eventIds || [], scope.eventIds) && same(choices[0].sourceIds || [], scope.sourceIds)
    const evidenceUnchanged = choices.every(choice => {
      const ids = (choice.eventIds || []).filter(id => scope.eventIds.includes(id))
      return !oldFacts || same(sourceIds(oldIndex, ids), sourceIds(newIndex, ids))
    })
    const creationUnchanged = choices.every(choice => !accountDraft(choice)?.creationKey ||
      accountDraft(choice).creationKey === identity.accountCreationKey(members(newIndex, issueId), newFacts.events))
    const needsRecheck = fingerprints.size !== 1 || !complete || !evidenceUnchanged || !creationUnchanged || choices.some(choice => choice.needsRecheck)
    const value = { ...choices[0], ...scope }
    if (needsRecheck) { value.needsRecheck = true; value.previousChoices = choices.map(clone) }
    else { delete value.needsRecheck; delete value.previousChoices }
    result.push({ kind: 'accounts', key: issueId, value })
  }
  for (const choice of orphaned) {
    const affected = unique((choice.sourceIds || []).flatMap(id => newIndex.sourceEvents.get(id) || []))
    if (!affected.length) {
      result.push({ kind: 'draft', key: choice.key, value: { mode: 'pending', dirty: true, localConfirmed: false, previousChoices: [choice] } })
      continue
    }
    for (const eventId of affected) {
      let change = result.find(row => row.kind === 'events' && row.key === eventId)
      if (!change) { change = { kind: 'events', key: eventId, value: { key: eventId, eventId, sourceIds: sourceIds(newIndex, [eventId]), editor: { editorVersion: 1 } } }; result.push(change) }
      change.value.needsRecheck = true
      change.value.previousChoices = [...change.value.previousChoices || [], clone(choice)]
    }
  }
  for (const [issueId, drafts] of draftGroups) {
    const fingerprints = new Set(drafts.map(({ value }) => JSON.stringify([value.mode, value.accountId || '', nameKey(value.name), value.typeIndex])))
    const covered = new Set(drafts.flatMap(draft => members(oldIndex, draft.key).map(memberKey)))
    const complete = oldFacts ? members(newIndex, issueId).every(member => covered.has(memberKey(member))) : drafts.length === 1 && drafts[0].key === issueId
    const value = { ...drafts[0].value }
    if (fingerprints.size !== 1 || !complete) {
      Object.assign(value, { mode: 'pending', accountId: '', dirty: true, localConfirmed: false,
        previousDrafts: drafts.map(draft => ({ issueId: draft.key, value: clone(draft.value) })) })
    }
    result.push({ kind: 'draft', key: issueId, value })
  }
  return result
}
module.exports = { rebase }
