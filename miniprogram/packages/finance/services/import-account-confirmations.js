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

// 从完整本机事实提取展示线索。每个来源事项和引用身份仍保持独立，
// 不把展示分组写回 issues、成员、绑定或人工决定。
function build(model, issues, { separateIssueIds = [], accountSelections = [] } = {}) {
  const sources = new Map(model.facts.sources.map(source => [source.batchId, source]))
  const separate = new Set(separateIssueIds)
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
    const savedAccountId = confirmed ? [...ids][0] : null
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
    entries.push({ issueId: issue.issueId, status: issue.status,
      decision: separate.has(issue.issueId) ? 'separate' : conflict || selectionBlocked ? 'conflict' : excluded ? 'excluded' : external ? 'external' : confirmed ? 'account' : 'pending',
      accountId: savedAccountId, selectedAccountId, selectionExplicit: Boolean(selection?.explicit), selectionDirty: Boolean(selection?.dirty),
      currency: issue.accountContext?.currency || contexts[0].event.currency || 'CNY',
      allowedAccountTypes: types.forMembers(contexts), canExternal: grouping.canUseExternal(model.events, original), members })
  }
  return confirmations.buildGroups(entries).map(group => group.groupReason === 'selected_account'
    ? { ...group, label: safeDisplayName(model.accounts.get(group.selectedAccountId)?.name || group.label) } : group)
}

module.exports = { build, normalizeSelections }
