const { analysisFullyObserved } = require('./statement-analysis')
const { SEMANTIC_HARD_BLOCKERS } = require('./semantic-policy')
const { effectiveSemanticReasons } = require('./payment-resolution')
const { deriveRowDisposition, RELATION_BLOCKERS } = require('./row-disposition')

function buildCoverageReport({ sources = [], events = [], issues = [], rows = [], evidence = [] } = {}) {
  const dataRows = sources.reduce((total, source) => total + Number(source.summary && source.summary.total || 0), 0)
  const eventsById = new Map(events.map((event) => [event.eventId, event]))
  const linksByRow = new Map()
  for (const link of evidence) {
    const links = linksByRow.get(link.rowId) || []
    links.push(link)
    linksByRow.set(link.rowId, links)
  }
  const dispositions = rows.map((row) => deriveRowDisposition(row, linksByRow.get(row.rowId) || [], eventsById))
  const rowIds = new Set(rows.map((row) => row.rowId))
  const linkedEvents = new Set(evidence.filter((link) => link.evidenceRole !== 'discarded').map((link) => link.eventId))
  const rowConservationPassed = rows.length === dataRows && rowIds.size === rows.length &&
    events.every((event) => ['excluded', 'corrected'].includes(event.status) || linkedEvents.has(event.eventId)) &&
    evidence.every((link) => rowIds.has(link.rowId) && (link.evidenceRole === 'discarded' || eventsById.has(link.eventId))) &&
    dispositions.every((row) => !row.conflict && row.disposition !== 'unassigned')
  const recognizedRows = dispositions.filter((row) => row.recognized).length
  const invalidRows = rows.filter((row) => row.parseState !== 'valid').length
  const conflictRows = dispositions.filter((row) => row.conflict).length
  const dispositionCounts = Object.fromEntries([
    'financial', 'non_financial', 'duplicate', 'needs_confirmation', 'user_excluded', 'invalid', 'unassigned'
  ].map((kind) => [kind, dispositions.filter((row) => row.disposition === kind).length]))
  const selected = events.filter((event) => !['excluded', 'corrected'].includes(event.status))
  const ready = selected.filter((event) => ['ready', 'posted'].includes(event.status) &&
    !effectiveSemanticReasons(event, [...(event.reasonCodes || []), ...(event.fieldSources && event.fieldSources.semanticBlockers || [])])
      .some((reason) => SEMANTIC_HARD_BLOCKERS.includes(reason)))
  const openBlockingIssues = issues.filter((issue) => issue.status === 'open' && issue.blocking).length
  const fileObservationsPassed = sources.length > 0 && sources.every((source) =>
    analysisFullyObserved(source.analysis) && source.analysis.dataRows === Number(source.summary.total))
  return {
    dataRows, recognizedRows, unrecognizedRows: Math.max(0, dataRows - recognizedRows), invalidRows,
    unresolvedSemanticRows: dispositions.filter((row) => !row.recognized && row.disposition !== 'invalid').length,
    conflictRows, dispositionCounts, rowConservationPassed, fileObservationsPassed,
    selectedEvents: selected.length, readySelectedEvents: ready.length,
    pendingSelectedEvents: selected.length - ready.length,
    excludedEvents: events.filter((event) => event.status === 'excluded').length, openBlockingIssues,
    statementFullyRecognized: dataRows > 0 && rowConservationPassed && fileObservationsPassed && recognizedRows === dataRows,
    selectedEventsReadyToPost: rowConservationPassed && selected.length > 0 && ready.length === selected.length && openBlockingIssues === 0
  }
}

module.exports = { buildCoverageReport, SEMANTIC_BLOCKERS: RELATION_BLOCKERS,
  hasSemanticBlocker: (event) => (event.reasonCodes || []).some((reason) => RELATION_BLOCKERS.has(reason)) }
