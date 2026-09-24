const { chunks, updateEvents, loadEventContexts } = require('../sql-batch')
const repaymentOwnership = require('../repayment-ownership')
const { eventAllocation, allocationAccountsValid } = require('../funds-allocation')
const { inspectPaymentAccounts, paymentEvidenceFields, paymentResolutionForEvent } = require('../payment-resolution')
const { importError } = require('../errors')
const { parseJson } = require('../finance-update-repository')
const { ECONOMIC_NATURE, evaluatePostability, unique } = require('../organizer-model')
const { isAggregateRepayment, repaymentAllocationsForEvent } = require('../repayment-allocation')
const { resolvedReasons } = require('./policy')

function domainEvent(row) {
  return {
    eventId: row.eventId,
    sourceDirection: row.sourceDirection,
    updateId: row.updateId,
    status: row.status,
    version: Number(row.version),
    flowDirection: row.flowDirection,
    economicNature: row.economicNature,
    ledgerAccountId: row.ledgerAccountId || null,
    counterpartyLedgerAccountId: row.counterpartyLedgerAccountId || null,
    localDate: row.localDate,
    localAt: row.localAt,
    utcAt: row.utcAt,
    timezoneOffsetMinutes: row.timezoneOffsetMinutes == null ? null : Number(row.timezoneOffsetMinutes),
    amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
    currency: row.currency,
    categoryId: row.categoryId || null,
    manualFieldMask: Number(row.manualFieldMask),
    fieldSources: parseJson(row.fieldSources, {}),
    reasonCodes: parseJson(row.reasonCodes, [])
  }
}

async function selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate = false } = {}) {
  if (eventIds.length === 0) return []
  const rows = []
  for (const part of chunks([...new Set(eventIds)].sort().map(id => [id]))) {
  const [found] = await connection.execute(
    `SELECT event_id AS eventId, update_id AS updateId, status, version,
            flow_direction AS flowDirection, economic_nature AS economicNature,
            ledger_account_id AS ledgerAccountId,
            counterparty_ledger_account_id AS counterpartyLedgerAccountId,
            event_local_date AS localDate, event_local_at AS localAt, event_utc_at AS utcAt,
            timezone_offset_minutes AS timezoneOffsetMinutes, amount_minor AS amountMinor,
            currency, category_id AS categoryId, manual_field_mask AS manualFieldMask,
            field_sources_json AS fieldSources, reason_codes_json AS reasonCodes,
            (SELECT r.normalized_direction FROM catledger_event_evidence v JOIN catledger_import_rows r ON r.uid=v.uid AND r.row_id=v.row_id
              WHERE v.uid=catledger_economic_events.uid AND v.event_id=catledger_economic_events.event_id AND v.evidence_role='primary' LIMIT 1) AS sourceDirection
       FROM catledger_economic_events
      WHERE uid = ? AND update_id = ? AND event_id IN (${part.map(() => '?').join(', ')})
      ORDER BY event_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, updateId, ...part.flat()]
  )
  rows.push(...found)
  }
  const events = rows.map(domainEvent)
  const legacy = events.filter((event) => (event.fieldSources.semanticBlockers || []).includes('payment_components_ambiguous') &&
    !Object.prototype.hasOwnProperty.call(event.fieldSources, 'paymentComponents'))
  if (legacy.length) {
    const evidence = []
    for (const part of chunks(legacy.map(event => [event.eventId]))) {
    const [found] = await connection.execute(`SELECT e.event_id AS eventId, r.normalized_direction AS direction, r.semantic_json AS semantic
      FROM catledger_event_evidence e JOIN catledger_import_rows r ON r.uid = e.uid AND r.row_id = e.row_id
      WHERE e.uid = ? AND e.update_id = ? AND e.event_id IN (${part.map(() => '?').join(', ')}) AND e.evidence_role <> 'discarded'
      ORDER BY e.event_id, r.row_id`, [uid, updateId, ...part.flat()])
    evidence.push(...found)
    }
    for (const event of legacy) event.fieldSources = { ...event.fieldSources, ...paymentEvidenceFields(evidence.filter((row) => row.eventId === event.eventId)
      .map((row) => ({ direction: row.direction, semantic: parseJson(row.semantic, {}) }))) }
  }
  return events
}

async function eventContext(connection, uid, updateId, eventId) {
  const [relations] = await connection.execute(
    `SELECT relation_id AS relationId, relation_type AS relationType, status,
            source_event_id AS sourceEventId, target_event_id AS targetEventId,
            amount_minor AS amountMinor, currency
       FROM catledger_economic_event_relations
      WHERE uid = ? AND update_id = ? AND (source_event_id = ? OR target_event_id = ?)`,
    [uid, updateId, eventId, eventId]
  )
  const [transactionLinks] = await connection.execute(
    `SELECT event_id AS eventId, transaction_id AS transactionId, role
       FROM catledger_economic_event_transactions
      WHERE uid = ? AND update_id = ? AND event_id = ?`,
    [uid, updateId, eventId]
  )
  return { relations, transactionLinks }
}

async function validateEventReferences(connection, uid, event, catalog = null) {
  const fieldSources = event && event.fieldSources || {}
  const plan = eventAllocation(event)
  if (plan.kind === 'conflict') throw importError('VALIDATION_ERROR')
  const hasAllocationDraft = Object.prototype.hasOwnProperty.call(fieldSources, 'repaymentAllocationVersion') ||
    Object.prototype.hasOwnProperty.call(fieldSources, 'repaymentAllocations')
  const allocation = isAggregateRepayment(event) && hasAllocationDraft ? repaymentAllocationsForEvent(event) : null
  if (allocation && !allocation.valid) throw importError('VALIDATION_ERROR')
  if (allocation && allocation.allocations.some((item) => item.accountId === event.ledgerAccountId)) {
    throw importError('VALIDATION_ERROR')
  }
  const payment = event.fieldSources && event.fieldSources.paymentResolution ? paymentResolutionForEvent(event) : null
  if (payment && !payment.valid) throw importError('VALIDATION_ERROR')
  const paymentAccounts = fieldSources.paymentAccounts ? inspectPaymentAccounts(event, fieldSources.paymentAccounts, { partial: true }) : null
  if (paymentAccounts && !paymentAccounts.valid) throw importError('VALIDATION_ERROR')
  const accountIds = unique([
    ...(paymentAccounts ? paymentAccounts.accounts.map((item) => item.accountId) : []),
    ...(payment ? payment.resolution.allocations.map((item) => item.accountId) : []),
    event.ledgerAccountId,
    event.counterpartyLedgerAccountId,
    ...(allocation ? allocation.allocations.map((item) => item.accountId) : [])
  ])
  if (accountIds.length > 0) {
    const [accounts] = catalog ? [accountIds.map(id => catalog.accounts.get(id)).filter(Boolean)] : await connection.execute(
      `SELECT account_id AS accountId, type, currency, archived_at AS archivedAt
         FROM catledger_accounts
        WHERE uid = ? AND account_id IN (${accountIds.map(() => '?').join(', ')}) FOR UPDATE`,
      [uid, ...accountIds]
    )
    if (accounts.some((account) => account.archivedAt != null || account.currency !== event.currency)) {
      throw importError('VALIDATION_ERROR')
    }
    const existingIds = new Set(accounts.map((account) => account.accountId))
    const draftIds = accountIds.filter((accountId) => !existingIds.has(accountId))
    if (draftIds.length > 0) {
      const [drafts] = catalog ? [draftIds.map(id => catalog.drafts.get(id)).filter(Boolean)] : await connection.execute(
        `SELECT draft_account_id AS accountId, type, currency
           FROM catledger_finance_update_account_drafts
          WHERE uid = ? AND update_id = ?
            AND draft_account_id IN (${draftIds.map(() => '?').join(', ')}) FOR UPDATE`,
        [uid, event.updateId, ...draftIds]
      )
      if (drafts.length !== draftIds.length || drafts.some((draft) => draft.currency !== event.currency)) {
        throw importError('VALIDATION_ERROR')
      }
      drafts.forEach((draft) => accounts.push(draft))
    }
    if (plan.valid && !allocationAccountsValid(event, plan, new Map(accounts.map((account) => [account.accountId, account])))) throw importError('VALIDATION_ERROR')
    if (event.counterpartyLedgerAccountId && ((fieldSources.paymentAccountReferences || []).some((ref) => ref.memberRole === 'payment_target') || repaymentOwnership.decisionFor(event)?.owner === 'self')) {
      const target = accounts.find((account) => account.accountId === event.counterpartyLedgerAccountId)
      if (!target || !['credit', 'other_liability'].includes(target.type)) throw importError('VALIDATION_ERROR')
    }
  }
  if (event.categoryId) {
    const [categories] = catalog ? [[catalog.categories.get(event.categoryId)].filter(Boolean)] : await connection.execute(
      `SELECT kind FROM catledger_categories
        WHERE uid = ? AND category_id = ? AND archived_at IS NULL LIMIT 1`,
      [uid, event.categoryId]
    )
    const expectedKind = event.economicNature === ECONOMIC_NATURE.INCOME ? 'income' : 'expense'
    if (!categories[0] || !['income', 'expense', 'fee'].includes(event.economicNature) || categories[0].kind !== expectedKind) {
      throw importError('VALIDATION_ERROR')
    }
  }
}

function finalizeSavedEvent(current, next, actionId, context, actionSource = 'user') {
  const evaluated = evaluatePostability(next, context)
  next.status = evaluated.status
  next.reasonCodes = unique([...resolvedReasons(next.resolvingIssueType, next.reasonCodes), ...evaluated.reasonCodes])
  next.version = current.version + 1
  next.fieldSources = { ...(next.fieldSources || {}),
    [actionSource === 'semantic' ? 'lastSemanticActionId' : 'lastUserActionId']: actionId }
  return next
}

async function loadReferenceCatalog(connection, uid, updateId, events) {
  const accountIds = unique(events.flatMap(event => {
    const fields = event.fieldSources || {}
    return [event.ledgerAccountId, event.counterpartyLedgerAccountId,
      ...(fields.repaymentAllocations || []).map(item => item.accountId),
      ...(fields.paymentAccounts || []).map(item => item.accountId),
      ...(fields.paymentResolution && fields.paymentResolution.allocations || []).map(item => item.accountId)]
  })).sort()
  const categoryIds = unique(events.map(event => event.categoryId)).sort()
  const catalog = { accounts: new Map(), drafts: new Map(), categories: new Map() }
  for (const ids of chunks(accountIds.map(id => [id]))) {
    const values = ids.flat()
    const [accounts] = await connection.execute(`SELECT account_id AS accountId, type, currency, archived_at AS archivedAt
      FROM catledger_accounts WHERE uid = ? AND account_id IN (${values.map(() => '?').join(',')}) ORDER BY account_id FOR UPDATE`, [uid, ...values])
    accounts.forEach(row => catalog.accounts.set(row.accountId, row))
    const missing = values.filter(id => !catalog.accounts.has(id))
    if (missing.length) {
      const [drafts] = await connection.execute(`SELECT draft_account_id AS accountId, type, currency FROM catledger_finance_update_account_drafts
        WHERE uid = ? AND update_id = ? AND draft_account_id IN (${missing.map(() => '?').join(',')}) ORDER BY draft_account_id FOR UPDATE`, [uid, updateId, ...missing])
      drafts.forEach(row => catalog.drafts.set(row.accountId, row))
    }
  }
  for (const ids of chunks(categoryIds.map(id => [id]))) {
    const values = ids.flat()
    const [categories] = await connection.execute(`SELECT category_id AS categoryId, kind FROM catledger_categories
      WHERE uid = ? AND category_id IN (${values.map(() => '?').join(',')}) AND archived_at IS NULL ORDER BY category_id FOR UPDATE`, [uid, ...values])
    categories.forEach(row => catalog.categories.set(row.categoryId, row))
  }
  return catalog
}

async function saveEvents(connection, uid, updateId, pairs, actionId) {
  if (!pairs.length) return []
  const catalog = await loadReferenceCatalog(connection, uid, updateId, pairs.map(pair => pair.next))
  const contexts = await loadEventContexts(connection, uid, updateId)
  for (const { current, next } of pairs) {
    await validateEventReferences(connection, uid, next, catalog)
    finalizeSavedEvent(current, next, actionId, contexts.get(next.eventId))
  }
  function* rows() {
    for (const { current, next } of pairs) yield [current.eventId, current.version, next.status, next.status, next.flowDirection, next.economicNature,
      next.ledgerAccountId, next.counterpartyLedgerAccountId, next.localDate, next.localAt, next.utcAt,
      next.timezoneOffsetMinutes, next.amountMinor, next.currency, next.categoryId, next.manualFieldMask,
      JSON.stringify(next.fieldSources), JSON.stringify(next.reasonCodes), next.version]
  }
  await updateEvents(connection, uid, updateId, ['state', 'status', 'flow_direction', 'economic_nature', 'ledger_account_id',
    'counterparty_ledger_account_id', 'event_local_date', 'event_local_at', 'event_utc_at', 'timezone_offset_minutes',
    'amount_minor', 'currency', 'category_id', 'manual_field_mask', 'field_sources_json', 'reason_codes_json', 'version'], rows())
  return pairs.map(pair => pair.next)
}

async function saveEvent(connection, uid, current, next, actionId, { preserveReferences = false, actionSource = 'user' } = {}) {
  if (preserveReferences) {
    const sameReferences = ['ledgerAccountId', 'counterpartyLedgerAccountId', 'currency', 'categoryId'].every(key => current[key] === next[key]) &&
      ['paymentAccounts', 'paymentResolution', 'repaymentAllocations'].every(key =>
        JSON.stringify(current.fieldSources && current.fieldSources[key]) === JSON.stringify(next.fieldSources && next.fieldSources[key]))
    if (!sameReferences) throw importError('CONFLICT')
  } else await validateEventReferences(connection, uid, next)
  const context = await eventContext(connection, uid, next.updateId, next.eventId)
  finalizeSavedEvent(current, next, actionId, context, actionSource)
  const [result] = await connection.execute(
    `UPDATE catledger_economic_events
        SET state = ?, status = ?, flow_direction = ?, economic_nature = ?,
            ledger_account_id = ?, counterparty_ledger_account_id = ?,
            event_local_date = ?, event_local_at = ?, event_utc_at = ?,
            timezone_offset_minutes = ?, amount_minor = ?, currency = ?, category_id = ?,
            manual_field_mask = ?, field_sources_json = ?, reason_codes_json = ?, version = ?
      WHERE uid = ? AND event_id = ? AND update_id = ? AND version = ?`,
    [
      next.status, next.status, next.flowDirection, next.economicNature,
      next.ledgerAccountId, next.counterpartyLedgerAccountId, next.localDate, next.localAt,
      next.utcAt, next.timezoneOffsetMinutes, next.amountMinor, next.currency, next.categoryId,
      next.manualFieldMask, JSON.stringify(next.fieldSources), JSON.stringify(next.reasonCodes),
      next.version, uid, next.eventId, next.updateId, current.version
    ]
  )
  if (result.affectedRows !== 1) throw importError('CONFLICT')
  return next
}

module.exports = { selectDomainEvents, loadReferenceCatalog, saveEvents, saveEvent }
