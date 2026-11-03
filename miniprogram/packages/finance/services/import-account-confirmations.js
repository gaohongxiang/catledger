const grouping = require('../domain/import-review/account-issue-grouping')
const types = require('../domain/import-review/account-type-policy')
const confirmations = require('../domain/import-review/account-confirmation-groups')
const { safeDisplayName } = require('../domain/import-review/payment-account')
const { suggestExistingAccount } = require('./import-account-suggestions')

// Untouched drafts carry the same defaults as the complete-batch suggestion
// helper. Leaving them out keeps the view stable as more pages initialize.
function normalizeSelections(values) {
  const unique = new Map()
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || value.explicit !== true && value.dirty !== true) continue
    const issueId = typeof value.issueId === 'string' ? value.issueId.trim() : ''
    const mode = typeof value.mode === 'string' ? value.mode.trim() : ''
    const accountId = mode === 'account' && typeof value.accountId === 'string' ? value.accountId.trim() : ''
    if (!issueId) continue
    const key = JSON.stringify([issueId, mode, accountId]), previous = unique.get(key)
    unique.set(key, { issueId, mode, accountId,
      explicit: value.explicit === true || previous?.explicit === true,
      dirty: value.dirty === true || previous?.dirty === true })
  }
  return [...unique.values()].sort((left, right) => left.issueId.localeCompare(right.issueId) ||
    left.mode.localeCompare(right.mode) || left.accountId.localeCompare(right.accountId) ||
    Number(left.explicit) - Number(right.explicit) || Number(left.dirty) - Number(right.dirty))
}

// A display preference keeps the original issues intact. Normalize it before
// caching so reopening a draft or initializing another page cannot reshuffle it.
function normalizeDisplayGroups(values) {
  const unique = new Map()
  for (const value of Array.isArray(values) ? values : []) {
    const groupId = typeof value?.groupId === 'string' ? value.groupId.trim() : ''
    const issueIds = [...new Set((Array.isArray(value?.issueIds) ? value.issueIds : [])
      .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))].sort()
    if (!groupId || issueIds.length < 2 || issueIds.includes(groupId) || !['separated', 'joined'].includes(value.mode)) continue
    const group = { groupId, issueIds, mode: value.mode }
    unique.set(JSON.stringify(group), group)
  }
  const groups = [...unique.values()], owners = new Map(), ids = new Map()
  for (const group of groups) {
    ids.set(group.groupId, (ids.get(group.groupId) || 0) + 1)
    for (const id of group.issueIds) owners.set(id, (owners.get(id) || 0) + 1)
  }
  // Ambiguous overlapping preferences never pick one group arbitrarily.
  return groups.filter(group => ids.get(group.groupId) === 1 && group.issueIds.every(id => owners.get(id) === 1))
    .sort((left, right) => left.groupId.localeCompare(right.groupId))
}

function displayDescriptor(preference, entries, accounts) {
  if (entries.some(entry => !entry)) return null
  // A whole-card choice cannot discard a disagreement already saved inside one
  // original issue. Those members must be reconciled on their original card.
  if (preference.mode === 'joined' && entries.some(entry => entry.memberConflict)) return null
  const currencies = new Set(entries.map(entry => entry.currency))
  const allowed = types.TYPES.filter(type => entries.every(entry => entry.allowedAccountTypes.includes(type)))
  const events = new Map(), sources = new Map()
  for (const entry of entries) for (const member of entry.members) {
    if (!events.has(member.eventId)) events.set(member.eventId, { issues: new Set(), sides: new Set(), unknown: false })
    const event = events.get(member.eventId)
    event.issues.add(entry.issueId)
    if (['source', 'destination'].includes(member.actualSide)) event.sides.add(member.actualSide)
    else event.unknown = true
    const sourceId = member.sourceId || '', sourceType = member.sourceType || member.reference?.sourceType || ''
    const fileName = member.fileName || '', sourceKey = sourceId ||
      JSON.stringify([sourceType, fileName, member.reference?.binding?.scopeKey || entry.issueId])
    if (!sources.has(sourceKey)) sources.set(sourceKey, { sourceId, sourceType, fileName, events: new Set() })
    sources.get(sourceKey).events.add(member.eventId)
  }
  // Joining is a common account decision; arranging separate cards has no such
  // effect and can remain adjacent even after their account types diverge.
  if (preference.mode === 'joined' && (currencies.size !== 1 || !allowed.length ||
      [...events.values()].some(event => event.sides.size > 1 || event.issues.size > 1 && event.unknown))) return null
  const saved = new Set(entries.map(entry => entry.accountId)), selected = new Set(entries.map(entry => entry.selectedAccountId))
  const accountId = saved.size === 1 && !saved.has(null) ? [...saved][0] : null
  const selectedAccountId = selected.size === 1 && !selected.has(null) ? [...selected][0] : null
  const conflict = preference.mode === 'joined' && !selectedAccountId && (saved.size > 1 ||
    entries.some(entry => entry.selectionDirty) || entries.some(entry => !entry.accountId))
  const needsConfirmation = conflict || entries.some(entry => entry.needsConfirmation)
  const issueIds = preference.issueIds.slice(), first = entries[0]
  return { groupId: preference.groupId, issueIds, anchorIssueId: issueIds[0], displayMode: preference.mode,
    groupReason: 'manual_join', label: safeDisplayName(accounts.get(selectedAccountId || accountId)?.name ||
      first.label || first.members[0]?.reference?.label || '账户'),
    allowedAccountTypes: allowed, currency: first.currency, memberCount: events.size, sourceCount: sources.size,
    sources: [...sources.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId) ||
      left.sourceType.localeCompare(right.sourceType) || left.fileName.localeCompare(right.fileName))
      .map(({ events, ...source }) => ({ ...source, count: events.size })),
    candidate: needsConfirmation, needsConfirmation, accountId, selectedAccountId,
    allExcluded: entries.every(entry => entry.excluded && !entry.needsConfirmation),
    canExternal: entries.every(entry => entry.canExternal),
    ...(conflict ? { conflictReason: 'different_account_choices' } : {}) }
}

// 从完整本机事实提取展示线索。每个来源事项和引用身份仍保持独立，
// 不把展示分组写回 issues、成员、绑定或人工决定。
function buildIndex(model, issues, { separateIssueIds = [], accountSelections = [], displayGroups = [] } = {}) {
  const sources = new Map(model.facts.sources.map(source => [source.batchId, source]))
  const preferences = normalizeDisplayGroups(displayGroups)
  const covered = new Set(preferences.flatMap(group => group.issueIds)), legacy = new Map()
  const legacyIds = new Set(separateIssueIds)
  // Older drafts remember only per-issue separation. Reconstruct their former
  // label/currency layout across the whole batch, without creating a binding.
  for (const issue of issues) if (legacyIds.has(issue.issueId) && !covered.has(issue.issueId)) {
    const context = issue.accountContext || {}
    if (!String(context.label || '').trim()) continue
    const groupId = 'legacy:' + (context.label || '') + '|' + (context.currency || issue.subject?.currency || 'CNY')
    if (!legacy.has(groupId)) legacy.set(groupId, [])
    legacy.get(groupId).push(issue.issueId)
  }
  for (const [groupId, issueIds] of legacy) if (issueIds.length > 1 && !preferences.some(group => group.groupId === groupId)) {
    preferences.push({ groupId, issueIds: issueIds.sort(), mode: 'separated' })
  }
  const separate = new Set([...separateIssueIds, ...preferences.flatMap(group => group.issueIds)])
  const selections = new Map()
  for (const selection of normalizeSelections(accountSelections)) {
    if (!selections.has(selection.issueId)) selections.set(selection.issueId, [])
    selections.get(selection.issueId).push(selection)
  }
  const catalog = [...model.accounts.values()].filter(account => !model.drafts.has(account.accountId))
  const entries = []
  for (const issue of issues) {
    const original = (model.members.get(issue.issueId) || []).filter(member => member.memberRole !== 'candidate')
    if (!original.length || original.some(member => member.objectType !== 'event' || !model.events.has(member.objectId))) continue
    const contexts = original.map(member => {
      const event = model.events.get(member.objectId), reference = grouping.memberReference(event, member)
      return { member, event, reference, memberRole: member.memberRole,
        decision: grouping.memberDecision(event, member, reference) }
    })
    const ids = new Set(contexts.map(context => context.decision.accountId).filter(Boolean))
    // 一个原事项内已有分歧时，保留原卡供核对；其完整号码仍参与全批冲突检测。
    const excluded = (issue.reasonCodes || []).some(code => ['account_mapping_excluded', 'source_account_ignored_default'].includes(code)) ||
      contexts.some(context => context.event.status === 'excluded')
    const external = contexts.some(context => context.decision.kind === 'external')
    const confirmed = issue.status === 'resolved' && contexts.every(context => context.decision.kind === 'ledger' && context.decision.accountId)
    const conflict = ids.size > 1 || ids.size > 0 && !confirmed
    const choices = selections.get(issue.issueId) || [], selection = choices[0]
    const savedAccountId = confirmed && ids.size === 1 ? [...ids][0] : null
    const chosen = selection?.mode === 'account' ? model.accounts.get(selection.accountId) : null
    const compatible = account => account && contexts.every(context => types.compatible({
      ...(context.reference || {}), currency: context.reference?.currency || context.event.currency || 'CNY'
    }, account, { event: context.event, memberRole: context.memberRole }))
    // A different unsaved mode, invalid account or contradictory UI choices
    // must not fall back to the saved account and reappear in another card.
    const selectionBlocked = choices.length > 1 || Boolean(selection &&
      (selection.mode !== 'account' || !compatible(chosen)))
    const suggested = !selection && !confirmed ? suggestExistingAccount(issue.accountContext, catalog) : null
    const selectedAccountId = selectionBlocked ? null : chosen?.accountId || savedAccountId ||
      (compatible(suggested) ? suggested.accountId : null)
    const members = contexts.flatMap(({ member, event, reference }) => {
      const found = new Map()
      for (const link of model.evidenceFor(event.eventId)) {
        if (link.evidenceRole === 'discarded') continue
        const row = model.rows.get(link.rowId), source = row && sources.get(row.batchId)
        if (row) found.set(source?.sourceId || row.batchId, { sourceId: source?.sourceId || row.batchId,
          sourceType: source?.sourceType || row.sourceType, fileName: source?.fileName || '' })
      }
      const base = { eventId: event.eventId, actualSide: types.actualSide(event, member.memberRole), reference }
      return found.size ? [...found.values()].map(source => ({ ...base, ...source })) : [base]
    })
    const canExternal = grouping.canUseExternal(model.events, original)
    const needsConfirmation = issue.status !== 'resolved' || Boolean(selection?.dirty) || choices.length > 1 ||
      Boolean(selection && (selection.mode !== 'account' || !compatible(chosen) || chosen.accountId !== savedAccountId)) ||
      !(excluded || external && canExternal || confirmed && ids.size === 1 && compatible(model.accounts.get(savedAccountId)))
    const originalDecision = conflict || selectionBlocked ? 'conflict' : excluded ? 'excluded' : external ? 'external' : confirmed ? 'account' : 'pending'
    entries.push({ issueId: issue.issueId, status: issue.status, label: issue.accountContext?.label || '', needsConfirmation, excluded,
      memberConflict: conflict,
      originalDecision, decision: separate.has(issue.issueId) ? 'separate' : originalDecision,
      accountId: savedAccountId, selectedAccountId, selectionExplicit: Boolean(selection?.explicit), selectionDirty: Boolean(selection?.dirty),
      currency: issue.accountContext?.currency || contexts[0].event.currency || 'CNY',
      allowedAccountTypes: types.forMembers(contexts), canExternal, members })
  }
  const byIssue = new Map(entries.map(entry => [entry.issueId, entry]))
  const explicit = preferences.map(preference =>
    displayDescriptor(preference, preference.issueIds.map(id => byIssue.get(id)), model.accounts)).filter(Boolean)
  const eligible = explicit.filter(group => group.displayMode === 'joined' && group.selectedAccountId),
    eligibleIds = new Set(eligible.flatMap(group => group.issueIds)), independentlySeparate = new Set(separateIssueIds)
  // A restored group can later absorb another explicitly selected source, just
  // like an ordinary card. It must be absorbed as a whole, never one half at a
  // time; conflicting joined groups and all separated groups stay independent.
  const expansions = eligible.length ? confirmations.buildGroups(entries.map(entry => eligibleIds.has(entry.issueId) &&
    !independentlySeparate.has(entry.issueId) ? { ...entry, decision: entry.originalDecision } : entry)).filter(group => {
    const ids = new Set(group.issueIds)
    return eligible.some(previous => group.issueIds.length > previous.issueIds.length && previous.issueIds.every(id => ids.has(id))) &&
      explicit.every(previous => previous.issueIds.every(id => ids.has(id)) || previous.issueIds.every(id => !ids.has(id)))
  }) : []
  const expanded = new Set(expansions.flatMap(group => group.issueIds))
  const groups = [...expansions, ...confirmations.buildGroups(entries.map(entry => expanded.has(entry.issueId)
    ? { ...entry, decision: 'separate' } : entry))].map(group => ({ ...group,
    needsConfirmation: group.issueIds.some(id => byIssue.get(id)?.needsConfirmation),
    ...(group.groupReason === 'selected_account'
      ? { label: safeDisplayName(model.accounts.get(group.selectedAccountId)?.name || group.label) } : {}) }))
  for (const group of explicit) if (!group.issueIds.every(id => expanded.has(id))) groups.push(group)
  return { groups, entries: byIssue }
}

const build = (model, issues, options) => buildIndex(model, issues, options).groups

module.exports = { build, buildIndex, normalizeSelections, normalizeDisplayGroups }
