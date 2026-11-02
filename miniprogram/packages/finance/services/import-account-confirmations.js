const grouping = require('../domain/import-review/account-issue-grouping')
const types = require('../domain/import-review/account-type-policy')
const confirmations = require('../domain/import-review/account-confirmation-groups')

// 从完整本机事实提取展示线索。每个来源事项和引用身份仍保持独立，
// 不把展示分组写回 issues、成员、绑定或人工决定。
function build(model, issues, { separateIssueIds = [] } = {}) {
  const sources = new Map(model.facts.sources.map(source => [source.batchId, source]))
  const separate = new Set(separateIssueIds)
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
      decision: separate.has(issue.issueId) ? 'separate' : conflict ? 'conflict' : excluded ? 'excluded' : external ? 'external' : confirmed ? 'account' : 'pending',
      accountId: confirmed ? [...ids][0] : null, currency: issue.accountContext?.currency || contexts[0].event.currency || 'CNY',
      allowedAccountTypes: types.forMembers(contexts), canExternal: grouping.canUseExternal(model.events, original), members })
  }
  return confirmations.buildGroups(entries)
}

module.exports = { build }
