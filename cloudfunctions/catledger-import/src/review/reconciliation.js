const { chunks } = require('../sql-batch')
const { synchronizeDraftReachability } = require('../account-draft')
const { importError } = require('../errors')
const { parseJson, selectPaymentMappings } = require('../finance-update-repository')
const { evaluatePostability, unique } = require('../organizer-model')
const { createMappingIndex, reconcileProjectedAccounts } = require('../source-funds')
const { paymentReferenceKey } = require('../payment-account')
const { FIELD_MASK } = require('./policy')
const { selectDomainEvents, saveEvent } = require('./event-store')
const { createFollowUpIssue } = require('./issue-store')

function projectedPaymentReferenceKeys(fieldSources) {
  const projection = fieldSources && fieldSources.fundsProjection
  if (!projection) return []
  return unique([projection.from, projection.to].concat(projection.to && projection.to.candidates || [])
    .filter((reference) => reference && reference.sourceType && reference.paymentMethodKey)
    .map(paymentReferenceKey))
}

function isEventInProjectionRefreshScope(row, scope) {
  if (!scope) return true
  if (scope.eventIds.has(row.eventId)) return true
  return projectedPaymentReferenceKeys(parseJson(row.fieldSources, {}))
    .some((key) => scope.paymentReferenceKeys.has(key))
}

async function refreshProjectedEvents(connection, uid, updateId, actionId, scope = null) {
  const [rows] = await connection.execute(
    `SELECT event_id AS eventId, field_sources_json AS fieldSources
       FROM catledger_economic_events
      WHERE uid = ? AND update_id = ?
        AND status IN ('ready', 'needs_action')`,
    [uid, updateId]
  )
  const affectedEventIds = scope ? new Set(scope.eventIds || []) : null
  const changedReferenceKeys = scope ? new Set(scope.paymentReferenceKeys || []) : null
  const normalizedScope = scope
    ? { eventIds: affectedEventIds, paymentReferenceKeys: changedReferenceKeys }
    : null
  const eventIds = rows
    .filter((row) => isEventInProjectionRefreshScope(row, normalizedScope))
    .map((row) => row.eventId)
  const events = await selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate: true })
  const projected = events.filter((event) => event.fieldSources && event.fieldSources.fundsProjection)
  if (!projected.length) return []
  const mappingIndex = createMappingIndex(await selectPaymentMappings(connection, uid, updateId))
  const changed = []
  for (const event of projected) {
    const reconciled = reconcileProjectedAccounts(event, mappingIndex, {
      preserveFrom: Boolean(event.manualFieldMask & FIELD_MASK.ledgerAccountId),
      preserveTo: Boolean(event.manualFieldMask & FIELD_MASK.counterpartyLedgerAccountId)
    })
    if (!reconciled.changed) continue
    const next = { ...reconciled.event, resolvingIssueType: 'transfer_accounts' }
    await connection.execute(
      `UPDATE catledger_review_issues issue
       JOIN catledger_review_issue_members member
         ON member.uid = issue.uid AND member.issue_id = issue.issue_id
          SET issue.status = 'superseded', issue.blocking = 0,
              issue.version = issue.version + 1, issue.resolved_action_id = ?
        WHERE issue.uid = ? AND issue.update_id = ? AND issue.status = 'open'
          AND issue.issue_type <> 'account_mapping'
          AND member.object_type = 'event' AND member.object_id = ?`,
      [actionId, uid, updateId, event.eventId]
    )
    const saved = await saveEvent(connection, uid, event, next, actionId)
    changed.push(saved)
    await createFollowUpIssue(connection, uid, updateId, saved)
  }
  return changed
}

async function effectiveProjectedEvents(connection, uid, updateId, events) {
  if (!events.some((event) => event.fieldSources && event.fieldSources.fundsProjection)) return events
  const mappingIndex = createMappingIndex(await selectPaymentMappings(connection, uid, updateId))
  return effectiveProjectedEventsFromIndex(events, mappingIndex)
}

function effectiveProjectedEventsFromIndex(events, mappingIndex) {
  return events.map((event) => reconcileProjectedAccounts(event, mappingIndex, {
    preserveFrom: Boolean(event.manualFieldMask & FIELD_MASK.ledgerAccountId),
    preserveTo: Boolean(event.manualFieldMask & FIELD_MASK.counterpartyLedgerAccountId)
  }).event)
}

async function restoreStaleHistoricalLinks(connection, uid, updateId) {
  const stale = await require('../historical-duplicates').staleHistoricalLinks(connection, uid, updateId)
  if (!stale.length) return false
  const events = await selectDomainEvents(connection, uid, updateId, [...new Set(stale.map(row => row.eventId))])
  for (const event of events) {
    event.status = 'needs_action'
    event.reasonCodes = event.reasonCodes.filter(reason => !['linked_existing_transaction', 'already_posted'].includes(reason))
    const evaluated = evaluatePostability(event)
    event.status = evaluated.status
    event.reasonCodes = unique([...event.reasonCodes, ...evaluated.reasonCodes])
    event.version++
    await connection.execute(`UPDATE catledger_economic_events SET state = ?, status = ?, reason_codes_json = ?, version = ?
      WHERE uid = ? AND update_id = ? AND event_id = ?`,
    [event.status, event.status, JSON.stringify(event.reasonCodes), event.version, uid, updateId, event.eventId])
    await createFollowUpIssue(connection, uid, updateId, event)
  }
  for (const part of chunks(stale.map(row => [row.linkId]))) await connection.execute(`UPDATE catledger_economic_event_transactions
    SET superseded_at = CURRENT_TIMESTAMP(3) WHERE uid = ? AND update_id = ? AND link_id IN (${part.map(() => '?').join(',')})`, [uid, updateId, ...part.flat()])
  return true
}

async function synchronizeHistoricalReviews(connection, uid, updateId) {
  const restored = await restoreStaleHistoricalLinks(connection, uid, updateId)
  const changed = await require('../historical-duplicates').synchronizeHistoricalReviews(connection, uid, updateId)
  return restored || changed
}

async function recalculateUpdateCounts(connection, uid, updateId, nextVersion, actionId, expectedVersion, duplicateEvidenceDelta = 0) {
  await synchronizeHistoricalReviews(connection, uid, updateId)
  await synchronizeDraftReachability(connection, uid, updateId)
  const [[counts]] = await connection.execute(
    `SELECT COUNT(*) AS finalEventCount,
            SUM(status = 'ready') AS readyEventCount,
            SUM(status = 'needs_action') AS needsActionEventCount,
            SUM(status = 'excluded') AS excludedEventCount,
            SUM(status = 'posted') AS postedEventCount
       FROM catledger_economic_events WHERE uid = ? AND update_id = ?`,
    [uid, updateId]
  )
  const [result] = await connection.execute(
    `UPDATE catledger_finance_updates
        SET version = ?, current_action_id = ?, final_event_count = ?,
            ready_event_count = ?, needs_action_event_count = ?,
            excluded_event_count = ?, posted_event_count = ?,
            duplicate_evidence_count = duplicate_evidence_count + ?
      WHERE uid = ? AND update_id = ? AND version = ? AND status = 'review'`,
    [
      nextVersion, actionId, Number(counts.finalEventCount || 0), Number(counts.readyEventCount || 0),
      Number(counts.needsActionEventCount || 0), Number(counts.excludedEventCount || 0),
      Number(counts.postedEventCount || 0), duplicateEvidenceDelta, uid, updateId, expectedVersion
    ]
  )
  if (result.affectedRows !== 1) throw importError('CONFLICT')
}

module.exports = { isEventInProjectionRefreshScope, refreshProjectedEvents, effectiveProjectedEvents, effectiveProjectedEventsFromIndex, synchronizeHistoricalReviews, recalculateUpdateCounts }
