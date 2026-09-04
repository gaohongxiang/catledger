const { randomUUID } = require('node:crypto')

const { importError } = require('./errors')
const { materializeAccountDrafts } = require('./account-draft')
const {
  getUpdateView,
  insertAction,
  parseJson,
  selectUpdate
} = require('./finance-update-repository')
const { executeIdempotentMutation } = require('./import-transaction')
const {
  ECONOMIC_NATURE,
  EVENT_STATUS,
  evaluatePostability,
  hasPendingRefundRelation
} = require('./organizer-model')
const { isAggregateRepayment, repaymentAllocationsForEvent } = require('./repayment-allocation')
const { validateUuid, validateVersion } = require('./validation')
const { CATEGORY_ALIAS_VERSION } = require('./category-mapping')

function categoryMappingCandidates(rows) {
  const categoriesByAlias = new Map()
  ;(rows || []).forEach((row) => {
    const evidence = typeof row.categoryEvidence === 'string'
      ? parseJson(row.categoryEvidence, {})
      : row.categoryEvidence || {}
    ;(evidence.aliasKeys || []).forEach((aliasKey) => {
      const key = `${row.sourceType}:${aliasKey}`
      const current = categoriesByAlias.get(key) || {
        sourceType: row.sourceType,
        aliasKey,
        categoryIds: new Set()
      }
      if (row.categoryId) current.categoryIds.add(row.categoryId)
      categoriesByAlias.set(key, current)
    })
  })
  return [...categoriesByAlias.values()]
    .filter((item) => item.categoryIds.size === 1)
    .map((item) => ({
      sourceType: item.sourceType,
      aliasKey: item.aliasKey,
      categoryId: [...item.categoryIds][0]
    }))
    .sort((left, right) => `${left.sourceType}:${left.aliasKey}`.localeCompare(`${right.sourceType}:${right.aliasKey}`))
}

function postingEvent(row) {
  return {
    eventId: row.eventId,
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
    fieldSources: parseJson(row.fieldSources, {}),
    reasonCodes: parseJson(row.reasonCodes, []),
    sourceDirection: row.sourceDirection,
    counterparty: row.counterparty || '',
    item: row.item || '',
    sourceNote: row.sourceNote || ''
  }
}

async function selectPostingEvents(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT e.event_id AS eventId, e.update_id AS updateId, e.status, e.version,
            e.flow_direction AS flowDirection, e.economic_nature AS economicNature,
            e.ledger_account_id AS ledgerAccountId,
            e.counterparty_ledger_account_id AS counterpartyLedgerAccountId,
            e.event_local_date AS localDate, e.event_local_at AS localAt,
            e.event_utc_at AS utcAt, e.timezone_offset_minutes AS timezoneOffsetMinutes,
            e.amount_minor AS amountMinor, e.currency, e.category_id AS categoryId,
            e.field_sources_json AS fieldSources, e.reason_codes_json AS reasonCodes,
            r.normalized_direction AS sourceDirection,
            r.counterparty_raw AS counterparty, r.item_raw AS item, r.note_raw AS sourceNote
       FROM catledger_economic_events e
       LEFT JOIN catledger_event_evidence ee
         ON ee.uid = e.uid AND ee.update_id = e.update_id AND ee.event_id = e.event_id
        AND ee.evidence_role = 'primary'
       LEFT JOIN catledger_import_rows r ON r.uid = ee.uid AND r.row_id = ee.row_id
      WHERE e.uid = ? AND e.update_id = ?
      ORDER BY e.economic_nature = 'refund', e.event_local_at, e.event_id
      FOR UPDATE`,
    [uid, updateId]
  )
  return rows.map(postingEvent)
}

async function eventContext(connection, uid, updateId, eventId) {
  const [relations] = await connection.execute(
    `SELECT relation_type AS relationType, status,
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

async function lockAccountsAndCategories(connection, uid, events) {
  const accountIds = [...new Set(events.flatMap((event) => {
    const allocation = isAggregateRepayment(event) ? repaymentAllocationsForEvent(event) : null
    if (allocation && !allocation.valid) throw importError('UNRESOLVED_IMPORT')
    return [
      event.ledgerAccountId,
      event.counterpartyLedgerAccountId,
      ...(allocation ? allocation.allocations.map((item) => item.accountId) : [])
    ]
  }).filter(Boolean))].sort()
  const accounts = new Map()
  if (accountIds.length > 0) {
    const [rows] = await connection.execute(
      `SELECT account_id AS accountId, type, currency, archived_at AS archivedAt
         FROM catledger_accounts
        WHERE uid = ? AND account_id IN (${accountIds.map(() => '?').join(', ')})
        ORDER BY account_id FOR UPDATE`,
      [uid, ...accountIds]
    )
    if (rows.length !== accountIds.length || rows.some((row) => row.archivedAt != null)) throw importError('UNRESOLVED_IMPORT')
    rows.forEach((row) => accounts.set(row.accountId, row))
  }
  const categoryIds = [...new Set(events.map((event) => event.categoryId).filter(Boolean))].sort()
  const categories = new Map()
  if (categoryIds.length > 0) {
    const [rows] = await connection.execute(
      `SELECT category_id AS categoryId, kind, archived_at AS archivedAt
         FROM catledger_categories
        WHERE uid = ? AND category_id IN (${categoryIds.map(() => '?').join(', ')})
        ORDER BY category_id FOR UPDATE`,
      [uid, ...categoryIds]
    )
    if (rows.length !== categoryIds.length || rows.some((row) => row.archivedAt != null)) throw importError('UNRESOLVED_IMPORT')
    rows.forEach((row) => categories.set(row.categoryId, row))
  }
  for (const event of events) {
    if (!accounts.has(event.ledgerAccountId) || accounts.get(event.ledgerAccountId).currency !== event.currency) {
      throw importError('UNRESOLVED_IMPORT')
    }
    if (event.counterpartyLedgerAccountId && (!accounts.has(event.counterpartyLedgerAccountId) ||
        accounts.get(event.counterpartyLedgerAccountId).currency !== event.currency)) throw importError('UNRESOLVED_IMPORT')
    if (isAggregateRepayment(event)) {
      const allocation = repaymentAllocationsForEvent(event)
      if (!allocation.valid || allocation.allocations.some((item) => {
        const account = accounts.get(item.accountId)
        return !account || account.currency !== event.currency || !['credit', 'other_liability'].includes(account.type) ||
          item.accountId === event.ledgerAccountId
      })) throw importError('UNRESOLVED_IMPORT')
    }
    if (event.categoryId) {
      const expected = event.economicNature === ECONOMIC_NATURE.INCOME ? 'income' : 'expense'
      if (!categories.has(event.categoryId) || categories.get(event.categoryId).kind !== expected) {
        throw importError('UNRESOLVED_IMPORT')
      }
    }
  }
  return accounts
}

async function queryCashBalances(connection, uid, accounts) {
  const balances = new Map()
  for (const account of accounts.values()) {
    if (account.type !== 'cash') continue
    const [[row]] = await connection.execute(
      `SELECT COALESCE(SUM(entries.delta_minor), 0) AS bookBalance
         FROM (
           SELECT CAST(amount_minor AS DECIMAL(20, 0)) AS delta_minor
             FROM catledger_transactions
            WHERE uid = ? AND destination_account_id = ? AND deleted_at IS NULL
           UNION ALL
           SELECT -CAST(amount_minor AS DECIMAL(20, 0)) AS delta_minor
             FROM catledger_transactions
            WHERE uid = ? AND source_account_id = ? AND deleted_at IS NULL
         ) entries`,
      [uid, account.accountId, uid, account.accountId]
    )
    balances.set(account.accountId, BigInt(String(row.bookBalance)))
  }
  return balances
}

async function assertCashBalancesNotWorsened(connection, uid, accounts, beforeBalances) {
  const afterBalances = await queryCashBalances(connection, uid, accounts)
  for (const [accountId, after] of afterBalances) {
    const before = beforeBalances.get(accountId) || 0n
    if (after < 0n && after < before) throw importError('INSUFFICIENT_CASH_BALANCE')
  }
}

async function lockEvidenceIdentities(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT DISTINCT r.identity_id AS identityId
       FROM catledger_event_evidence ee
       JOIN catledger_import_rows r ON r.uid = ee.uid AND r.row_id = ee.row_id
      WHERE ee.uid = ? AND ee.update_id = ? AND ee.evidence_role <> 'discarded'
        AND r.identity_id IS NOT NULL ORDER BY r.identity_id`,
    [uid, updateId]
  )
  const ids = rows.map((row) => row.identityId)
  if (ids.length > 0) {
    const [locked] = await connection.execute(
      `SELECT identity_id FROM catledger_source_identities
        WHERE uid = ? AND identity_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY identity_id FOR UPDATE`,
      [uid, ...ids]
    )
    if (locked.length !== ids.length) throw importError('IDENTITY_CONFLICT')
  }
}

async function promoteAccountMappings(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT draft.source_type AS sourceType,
            draft.payment_method_key AS paymentMethodKey,
            MAX(draft.payment_method_hint) AS paymentMethodHint,
            MIN(draft.mapping_action) AS mappingAction,
            COUNT(DISTINCT draft.mapping_action) AS actionCount,
            MIN(draft.account_id) AS accountId,
            COUNT(DISTINCT draft.account_id) AS accountCount,
            MIN(event_row.status) AS minimumEventStatus,
            MAX(event_row.status) AS maximumEventStatus
       FROM catledger_finance_update_account_mapping_drafts draft
       JOIN catledger_economic_events event_row
         ON event_row.uid = draft.uid AND event_row.update_id = draft.update_id
        AND event_row.event_id = draft.event_id
      WHERE draft.uid = ? AND draft.update_id = ?
      GROUP BY draft.source_type, draft.payment_method_key
      ORDER BY draft.source_type, draft.payment_method_key`,
    [uid, updateId]
  )
  for (const row of rows) {
    if (Number(row.actionCount) !== 1) throw importError('UNRESOLVED_IMPORT')
    if (row.mappingAction === 'account') {
      if (Number(row.accountCount) !== 1 || row.minimumEventStatus !== 'posted' || row.maximumEventStatus !== 'posted') {
        throw importError('UNRESOLVED_IMPORT')
      }
      await connection.execute(
        `INSERT INTO catledger_import_account_mappings
           (uid, mapping_id, source_type, payment_method_key, payment_method_hint,
            mapping_action, account_id, disabled_at)
         VALUES (?, ?, ?, ?, ?, 'account', ?, NULL)
         ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint),
           mapping_action = 'account', account_id = VALUES(account_id), disabled_at = NULL,
           version = version + 1`,
        [uid, randomUUID(), row.sourceType, row.paymentMethodKey, row.paymentMethodHint, row.accountId]
      )
    } else if (row.mappingAction === 'ignore') {
      if (Number(row.accountCount) !== 0 || row.minimumEventStatus !== 'excluded' || row.maximumEventStatus !== 'excluded') {
        throw importError('UNRESOLVED_IMPORT')
      }
      await connection.execute(
        `INSERT INTO catledger_import_account_mappings
           (uid, mapping_id, source_type, payment_method_key, payment_method_hint,
            mapping_action, account_id, disabled_at)
         VALUES (?, ?, ?, ?, ?, 'ignore', NULL, NULL)
         ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint),
           mapping_action = 'ignore', account_id = NULL, disabled_at = NULL,
           version = version + 1`,
        [uid, randomUUID(), row.sourceType, row.paymentMethodKey, row.paymentMethodHint]
      )
    } else {
      throw importError('UNRESOLVED_IMPORT')
    }
  }
}

async function promoteCategoryMappings(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT source.source_type_snapshot AS sourceType,
            event.category_id AS categoryId,
            import_row.category_evidence_json AS categoryEvidence
       FROM catledger_economic_events event
       JOIN catledger_event_evidence evidence
         ON evidence.uid = event.uid AND evidence.update_id = event.update_id
        AND evidence.event_id = event.event_id AND evidence.evidence_role <> 'discarded'
       JOIN catledger_import_rows import_row
         ON import_row.uid = evidence.uid AND import_row.row_id = evidence.row_id
       JOIN catledger_finance_update_sources source
         ON source.uid = import_row.uid AND source.update_id = event.update_id
        AND source.batch_id = import_row.batch_id
      WHERE event.uid = ? AND event.update_id = ? AND event.status = 'posted'
        AND event.economic_nature IN ('income', 'expense', 'fee')
        AND event.category_id IS NOT NULL
      ORDER BY source.source_type_snapshot, import_row.row_id`,
    [uid, updateId]
  )
  for (const mapping of categoryMappingCandidates(rows)) {
    await connection.execute(
      `INSERT INTO catledger_import_category_mappings
         (uid, mapping_id, source_type, alias_key, alias_key_version, category_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), version = version + 1`,
      [uid, randomUUID(), mapping.sourceType, mapping.aliasKey, CATEGORY_ALIAS_VERSION, mapping.categoryId]
    )
  }
}

async function existingTransactionForEvent(connection, uid, updateId, eventId) {
  const [rows] = await connection.execute(
    `(SELECT linked.transaction_id AS transactionId, t.version, linked.created_at AS createdAt
        FROM catledger_event_evidence ee
        JOIN catledger_import_rows source_row
          ON source_row.uid = ee.uid AND source_row.row_id = ee.row_id
        JOIN catledger_import_rows prior_row
          ON prior_row.uid = source_row.uid AND prior_row.identity_id = source_row.identity_id
        JOIN catledger_import_transaction_links linked
          ON linked.uid = prior_row.uid AND linked.row_id = prior_row.row_id
        JOIN catledger_transactions t
          ON t.uid = linked.uid AND t.transaction_id = linked.transaction_id AND t.deleted_at IS NULL
       WHERE ee.uid = ? AND ee.update_id = ? AND ee.event_id = ?
         AND ee.evidence_role <> 'discarded' AND source_row.identity_id IS NOT NULL)
     UNION ALL
     (SELECT linked.transaction_id AS transactionId, t.version, linked.created_at AS createdAt
        FROM catledger_event_evidence ee
        JOIN catledger_import_rows source_row
          ON source_row.uid = ee.uid AND source_row.row_id = ee.row_id
        JOIN catledger_import_rows prior_row
          ON prior_row.uid = source_row.uid AND prior_row.identity_id = source_row.identity_id
        JOIN catledger_event_evidence prior_evidence
          ON prior_evidence.uid = prior_row.uid AND prior_evidence.row_id = prior_row.row_id
         AND prior_evidence.evidence_role <> 'discarded'
        JOIN catledger_economic_event_transactions linked
          ON linked.uid = prior_evidence.uid AND linked.event_id = prior_evidence.event_id
         AND linked.role IN ('primary', 'refund_transaction', 'repayment_allocation', 'historical_primary')
        JOIN catledger_transactions t
          ON t.uid = linked.uid AND t.transaction_id = linked.transaction_id AND t.deleted_at IS NULL
       WHERE ee.uid = ? AND ee.update_id = ? AND ee.event_id = ?
         AND ee.evidence_role <> 'discarded' AND source_row.identity_id IS NOT NULL)
     ORDER BY createdAt LIMIT 1 FOR UPDATE`,
    [uid, updateId, eventId, uid, updateId, eventId]
  )
  return rows[0] || null
}

function noteForEvent(event) {
  const values = [event.item, event.counterparty, event.sourceNote]
    .map((value) => String(value || '').normalize('NFKC').trim())
    .filter(Boolean)
  return [...new Set(values)].join(' · ').slice(0, 200) || null
}

async function originalTransactionIdForRefund(connection, uid, updateId, eventId) {
  const [direct] = await connection.execute(
    `SELECT transaction_id AS transactionId
       FROM catledger_economic_event_transactions
      WHERE uid = ? AND update_id = ? AND event_id = ? AND role = 'refund_original'
      LIMIT 1`,
    [uid, updateId, eventId]
  )
  if (direct[0]) return direct[0].transactionId
  const [related] = await connection.execute(
    `SELECT tx.transaction_id AS transactionId
       FROM catledger_economic_event_relations relation_row
       JOIN catledger_economic_event_transactions tx
         ON tx.uid = relation_row.uid AND tx.update_id = relation_row.update_id
        AND tx.event_id = relation_row.target_event_id
      WHERE relation_row.uid = ? AND relation_row.update_id = ?
        AND relation_row.source_event_id = ? AND relation_row.relation_type = 'refund_of'
        AND relation_row.status = 'confirmed'
        AND tx.role IN ('primary', 'historical_primary')
      LIMIT 1`,
    [uid, updateId, eventId]
  )
  return related[0] ? related[0].transactionId : null
}

async function validateRefundAmount(connection, uid, originalTransactionId, amountMinor) {
  const [originals] = await connection.execute(
    `SELECT amount_minor AS amountMinor FROM catledger_transactions
      WHERE uid = ? AND transaction_id = ? AND type = 'expense' AND deleted_at IS NULL
      LIMIT 1 FOR UPDATE`,
    [uid, originalTransactionId]
  )
  if (!originals[0]) throw importError('UNRESOLVED_IMPORT')
  const [[refunds]] = await connection.execute(
    `SELECT COALESCE(SUM(amount_minor), 0) AS refundedMinor
       FROM catledger_transactions
      WHERE uid = ? AND original_transaction_id = ? AND type = 'refund' AND deleted_at IS NULL`,
    [uid, originalTransactionId]
  )
  if (BigInt(String(refunds.refundedMinor)) + BigInt(amountMinor) > BigInt(String(originals[0].amountMinor))) {
    throw importError('UNRESOLVED_IMPORT')
  }
}

function transactionDraft(event, originalTransactionId) {
  const ordinaryType = event.economicNature === ECONOMIC_NATURE.INCOME ? 'income' : 'expense'
  if ([ECONOMIC_NATURE.INCOME, ECONOMIC_NATURE.EXPENSE, ECONOMIC_NATURE.FEE].includes(event.economicNature)) {
    return {
      type: ordinaryType,
      sourceAccountId: ordinaryType === 'expense' ? event.ledgerAccountId : null,
      destinationAccountId: ordinaryType === 'income' ? event.ledgerAccountId : null,
      categoryId: event.categoryId,
      originalTransactionId: null
    }
  }
  if (event.economicNature === ECONOMIC_NATURE.REFUND) {
    return {
      type: 'refund', sourceAccountId: null, destinationAccountId: event.ledgerAccountId,
      categoryId: null, originalTransactionId
    }
  }
  if ([ECONOMIC_NATURE.INTERNAL_TRANSFER, ECONOMIC_NATURE.REPAYMENT, ECONOMIC_NATURE.BORROW].includes(event.economicNature)) {
    const sourceIsLedger = event.sourceDirection !== 'income'
    return {
      type: 'transfer',
      sourceAccountId: sourceIsLedger ? event.ledgerAccountId : event.counterpartyLedgerAccountId,
      destinationAccountId: sourceIsLedger ? event.counterpartyLedgerAccountId : event.ledgerAccountId,
      categoryId: null,
      originalTransactionId: null
    }
  }
  throw importError('UNRESOLVED_IMPORT')
}

function transactionDrafts(event, originalTransactionId) {
  if (isAggregateRepayment(event)) {
    const allocation = repaymentAllocationsForEvent(event)
    if (!allocation.valid) throw importError('UNRESOLVED_IMPORT')
    return allocation.allocations.map((item) => ({
      type: 'transfer',
      sourceAccountId: event.ledgerAccountId,
      destinationAccountId: item.accountId,
      categoryId: null,
      originalTransactionId: null,
      amountMinor: item.amountMinor,
      role: 'repayment_allocation'
    }))
  }
  return [{
    ...transactionDraft(event, originalTransactionId),
    amountMinor: event.amountMinor,
    role: event.economicNature === ECONOMIC_NATURE.REFUND ? 'refund_transaction' : 'primary'
  }]
}

async function createTransactions(connection, uid, updateId, event) {
  let originalTransactionId = null
  if (event.economicNature === ECONOMIC_NATURE.REFUND) {
    originalTransactionId = await originalTransactionIdForRefund(connection, uid, updateId, event.eventId)
    if (!originalTransactionId && !hasPendingRefundRelation(event)) throw importError('UNRESOLVED_IMPORT')
    if (originalTransactionId) await validateRefundAmount(connection, uid, originalTransactionId, event.amountMinor)
  }
  const created = []
  for (const draft of transactionDrafts(event, originalTransactionId)) {
    const transactionId = randomUUID()
    await connection.execute(
      `INSERT INTO catledger_transactions
         (uid, transaction_id, type, source_account_id, destination_account_id,
          category_id, original_transaction_id, amount_minor, occurred_local_date,
          occurred_local_at, timezone_offset_minutes, occurred_at_utc, note, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import')`,
      [
        uid, transactionId, draft.type, draft.sourceAccountId, draft.destinationAccountId,
        draft.categoryId, draft.originalTransactionId, draft.amountMinor, event.localDate,
        event.localAt, event.timezoneOffsetMinutes, event.utcAt, noteForEvent(event)
      ]
    )
    created.push({ transactionId, role: draft.role })
  }
  return created
}

async function linkEventTransaction(connection, uid, updateId, event, transactionId, creationMethod, transactionVersion = 1, role = null) {
  const linkRole = role || (event.economicNature === ECONOMIC_NATURE.REFUND ? 'refund_transaction' : 'primary')
  await connection.execute(
    `INSERT INTO catledger_economic_event_transactions
       (uid, link_id, update_id, event_id, transaction_id, role,
        creation_method, rule_version, transaction_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'event-transaction-link-v2', ?)`,
    [uid, randomUUID(), updateId, event.eventId, transactionId, linkRole, creationMethod, transactionVersion]
  )
}

function createFinanceUpdatePosting({ getPool }) {
  async function post(context) {
    const updateId = validateUuid(context.data.updateId)
    const version = validateVersion(context.data.version)
    if (context.data.mode != null && context.data.mode !== 'all_ready') throw importError('VALIDATION_ERROR')
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'financeUpdates.post',
      operation: async (connection, uid, data, requestDigest) => {
        const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        if (update.status === 'posted') return getUpdateView(connection, uid, updateId)
        if (update.status !== 'review' || Number(update.version) !== version) throw importError('CONFLICT')
        const [[openIssues]] = await connection.execute(
          `SELECT COUNT(*) AS count FROM catledger_review_issues
            WHERE uid = ? AND update_id = ? AND status = 'open' AND blocking = 1`,
          [uid, updateId]
        )
        if (Number(openIssues.count) !== 0) throw importError('UNRESOLVED_IMPORT')
        const events = await selectPostingEvents(connection, uid, updateId)
        if (events.some((event) => event.status === EVENT_STATUS.NEEDS_ACTION) ||
            events.length !== Number(update.finalEventCount)) throw importError('UNRESOLVED_IMPORT')
        const ready = events.filter((event) => event.status === EVENT_STATUS.READY)
        for (const event of ready) {
          const evaluated = evaluatePostability(event, await eventContext(connection, uid, updateId, event.eventId))
          if (evaluated.status !== EVENT_STATUS.READY) throw importError('UNRESOLVED_IMPORT')
        }
        // Draft accounts are assigned stable future IDs during review, but the
        // formal Account rows are created only after the user starts posting.
        // This transaction also owns every later transaction/link/state write,
        // so any failure removes the accounts again with the full rollback.
        await materializeAccountDrafts(connection, uid, updateId)
        const lockedAccounts = await lockAccountsAndCategories(connection, uid, ready)
        const cashBalancesBeforePost = await queryCashBalances(connection, uid, lockedAccounts)
        await lockEvidenceIdentities(connection, uid, updateId)

        const postingId = randomUUID()
        await connection.execute(
          `INSERT INTO catledger_finance_update_postings
             (uid, posting_id, update_id, request_digest, state, selected_event_count)
           VALUES (?, ?, ?, ?, 'running', ?)`,
          [uid, postingId, updateId, requestDigest, ready.length]
        )
        const appliedVersion = version + 1
        const actionId = await insertAction(connection, uid, {
          updateId,
          expectedVersion: version,
          appliedVersion,
          actionType: 'post_all_ready',
          requestDigest,
          reasons: ['finance_update_posted']
        })
        const [postingState] = await connection.execute(
          `UPDATE catledger_finance_updates
              SET status = 'posting', current_action_id = ?
            WHERE uid = ? AND update_id = ? AND version = ? AND status = 'review'`,
          [actionId, uid, updateId, version]
        )
        if (postingState.affectedRows !== 1) throw importError('CONFLICT')

        let created = 0
        let reused = 0
        for (const event of ready) {
          event.postingId = postingId
          const existing = await existingTransactionForEvent(connection, uid, updateId, event.eventId)
          if (isAggregateRepayment(event)) {
            if (existing) throw importError('IDENTITY_CONFLICT')
            const transactions = await createTransactions(connection, uid, updateId, event)
            created += transactions.length
            for (const transaction of transactions) {
              await linkEventTransaction(
                connection, uid, updateId, event, transaction.transactionId, 'created', 1, transaction.role
              )
            }
          } else {
            let transactionId
            let creationMethod
            let transactionVersion = 1
            if (existing) {
              transactionId = existing.transactionId
              transactionVersion = Number(existing.version)
              creationMethod = 'reused'
              reused += 1
            } else {
              const transactions = await createTransactions(connection, uid, updateId, event)
              transactionId = transactions[0].transactionId
              creationMethod = 'created'
              created += 1
            }
            await linkEventTransaction(connection, uid, updateId, event, transactionId, creationMethod, transactionVersion)
          }
          const [eventUpdate] = await connection.execute(
            `UPDATE catledger_economic_events
                SET state = 'posted', status = 'posted', version = version + 1
              WHERE uid = ? AND update_id = ? AND event_id = ? AND version = ? AND status = 'ready'`,
            [uid, updateId, event.eventId, event.version]
          )
          if (eventUpdate.affectedRows !== 1) throw importError('CONFLICT')
        }

        // Imported transactions, newly materialized accounts and every state
        // transition still belong to this transaction. A cash deficit aborts
        // the whole FinanceUpdate and rolls every formal write back together.
        await assertCashBalancesNotWorsened(connection, uid, lockedAccounts, cashBalancesBeforePost)

        // Review only records mapping intent in the FinanceUpdate draft. The
        // reusable ledger rule crosses the write barrier only inside this same
        // all-or-nothing posting transaction.
        await promoteAccountMappings(connection, uid, updateId)
        await promoteCategoryMappings(connection, uid, updateId)

        await connection.execute(
          `UPDATE catledger_finance_update_postings
              SET state = 'completed', created_transaction_count = ?,
                  reused_transaction_count = ?, completed_at = CURRENT_TIMESTAMP(3)
            WHERE uid = ? AND posting_id = ?`,
          [created, reused, uid, postingId]
        )
        await connection.execute(
          `UPDATE catledger_import_batches b
           JOIN catledger_finance_update_sources s
             ON s.uid = b.uid AND s.batch_id = b.batch_id
              SET b.state = 'committed', b.pending_row_count = 0,
                  b.posted_row_count = b.valid_row_count,
                  b.updated_at = CURRENT_TIMESTAMP(3)
            WHERE s.uid = ? AND s.update_id = ?`,
          [uid, updateId]
        )
        await connection.execute(
          `UPDATE catledger_import_files f
           JOIN catledger_finance_update_sources s
             ON s.uid = f.uid AND s.import_id = f.import_id
              SET f.state = 'committed', f.version = f.version + 1, f.error_code = NULL
            WHERE s.uid = ? AND s.update_id = ? AND f.state = 'review_ready'`,
          [uid, updateId]
        )
        const [completed] = await connection.execute(
          `UPDATE catledger_finance_updates
              SET status = 'posted', version = ?, posted_event_count = posted_event_count + ?,
                  ready_event_count = 0, current_action_id = ?
            WHERE uid = ? AND update_id = ? AND version = ? AND status = 'posting'
              AND needs_action_event_count = 0`,
          [appliedVersion, ready.length, actionId, uid, updateId, version]
        )
        if (completed.affectedRows !== 1) throw importError('CONFLICT')
        return getUpdateView(connection, uid, updateId)
      }
    })
  }

  return { post }
}

module.exports = {
  categoryMappingCandidates,
  createFinanceUpdatePosting,
  noteForEvent,
  postingEvent,
  transactionDraft,
  transactionDrafts
}
