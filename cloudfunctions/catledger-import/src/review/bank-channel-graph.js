const { bankChannelEdges } = require('../bank-channel-matching')
const { hasSourceIdentityConflict } = require('../evidence-matching')

// 输入已排除无效账户和历史占用；摘要与分页共用完整图，不能先按问题或页码缩小范围。
function pairingGraph(events, members) {
  const issues = new Map()
  for (const member of members) {
    if (!issues.has(member.eventId)) issues.set(member.eventId, new Set())
    issues.get(member.eventId).add(member.issueId)
  }
  const all = bankChannelEdges(events)
    .filter(pair => !hasSourceIdentityConflict(pair.bank.relationEvidence.rows.concat(pair.platform.relationEvidence.rows)))
    .sort((a, b) => a.pairKey.localeCompare(b.pairKey))
  const degrees = new Map()
  for (const pair of all) for (const event of [pair.bank, pair.platform]) degrees.set(event.eventId, (degrees.get(event.eventId) || 0) + 1)
  const pairs = all.map(pair => ({ ...pair,
    issueIds: [...(issues.get(pair.bank.eventId) || [])].filter(id => issues.get(pair.platform.eventId)?.has(id)),
    unique: degrees.get(pair.bank.eventId) === 1 && degrees.get(pair.platform.eventId) === 1 }))
    .filter(pair => pair.issueIds.length)
  return { all, pairs, suggestedCount: pairs.filter(pair => pair.unique).length }
}

module.exports = { pairingGraph }
