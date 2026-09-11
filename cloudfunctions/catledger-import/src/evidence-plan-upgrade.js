const { digestParts } = require('./digest')
const { buildOrganizePlan } = require('./organizer-planner')
const { hasGroupConflict, identityGroups } = require('./evidence-matching')

// 只拆危险活动组。原人工字段归于原主证据；不复制到独立的新事件。
function prepareEvidenceSplit({ current, rows, links, paymentMappings, accounts, idFactory }) {
  if (!['ready', 'needs_action'].includes(current.status) || identityGroups(rows).length < 2 || !hasGroupConflict(rows)) return null
  const plan = buildOrganizePlan({ updateId: current.updateId, rows, paymentMappings, accounts, idFactory })
  if (plan.events.length < 2) return null
  const primaryLink = links.find(link => link.role === 'primary') || links[0]
  const primary = plan.events.find(event => event.fieldSources.rowIds.includes(primaryLink.rowId))
  const conflictKey = digestParts('upgraded-evidence-group-v1', current.eventId)
  const next = { ...primary, ...current, status: 'needs_action',
    fieldSources: { ...current.fieldSources, rowIds: primary.fieldSources.rowIds, evidenceGroupConflictKey: conflictKey },
    reasonCodes: [...new Set([...current.reasonCodes, 'source_group_conflict'])] }
  const additions = plan.events.filter(event => event !== primary)
  additions.forEach(event => {
    if (event.status !== 'excluded') {
      event.status = 'needs_action'
      event.reasonCodes = [...new Set([...event.reasonCodes, 'source_group_conflict'])]
      event.fieldSources.evidenceGroupConflictKey = conflictKey
    }
  })
  const evidenceByRow = new Map(plan.evidence.map(evidence => [evidence.rowId, evidence]))
  const assignments = links.map(link => {
    const evidence = evidenceByRow.get(link.rowId)
    return { ...link, eventId: evidence.eventId === primary.eventId ? current.eventId : evidence.eventId,
      role: evidence.eventId === primary.eventId
        ? link.rowId === primaryLink.rowId ? 'primary' : evidence.evidenceRole === 'duplicate' ? 'duplicate' : 'supporting'
        : evidence.evidenceRole }
  })
  additions.forEach(event => {
    const primary = assignments.find(link => link.eventId === event.eventId && link.role === 'primary')
    event.fieldSources.primaryEvidenceId = primary.evidenceId
  })
  return { next, additions, assignments }
}

module.exports = { prepareEvidenceSplit }
