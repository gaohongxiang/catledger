const { randomUUID } = require('node:crypto')

const { CATEGORY_ALIAS_VERSION } = require('./category-mapping')
const { digestParts } = require('./digest')
const { importError } = require('./errors')
const { buildPaymentMethodKey } = require('./identity')
const { paymentAccountDetails } = require('./payment-account')
const {
  publicImport,
  selectImportFile,
  selectLatestBatch
} = require('./import-repository')

function validateDecisions(value) {
  if (!Array.isArray(value) || value.length > 5000) throw importError('VALIDATION_ERROR')
  const decisions = new Map()
  for (const item of value) {
    const paymentRuleAction = item && item.paymentRuleAction != null ? item.paymentRuleAction : null
    if (!item || typeof item !== 'object' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.eventId || '') ||
        !['post', 'skip'].includes(item.disposition) || decisions.has(item.eventId) ||
        (paymentRuleAction !== null && !['ignore', 'forget'].includes(paymentRuleAction)) ||
        (paymentRuleAction !== null && item.disposition !== 'skip')) {
      throw importError('VALIDATION_ERROR')
    }
    decisions.set(item.eventId, {
      eventId: item.eventId,
      disposition: item.disposition,
      accountId: item.accountId || null,
      categoryId: item.categoryId || null,
      paymentRuleAction
    })
  }
  return decisions
}

async function selectPostingRows(connection, uid, batchId) {
  const [rows] = await connection.execute(
    `SELECT e.event_id AS eventId, e.state AS eventState,
            r.row_id AS rowId, r.identity_id AS identityId,
            r.parse_state AS parseState, r.identity_state AS identityState,
            r.processing_state AS processingState,
            r.normalized_local_date AS localDate, r.normalized_local_at AS localAt,
            r.normalized_utc_at AS utcAt,
            r.timezone_offset_minutes AS timezoneOffsetMinutes,
            r.normalized_amount_minor AS amountMinor,
            r.normalized_direction AS direction,
            r.normalized_transaction_type AS transactionType,
            r.economic_effect AS economicEffect,
            r.payment_method_key AS paymentMethodKey,
            r.payment_method_raw AS paymentMethod,
            r.category_evidence_json AS categoryEvidence,
            r.counterparty_raw AS counterparty, r.item_raw AS item,
            r.note_raw AS sourceNote,
            d.decision_version AS decisionVersion,
            d.disposition AS systemDisposition,
            d.account_id AS systemAccountId, d.category_id AS systemCategoryId
       FROM catledger_economic_events e
       JOIN catledger_event_evidence ee
         ON ee.uid = e.uid AND ee.event_id = e.event_id AND ee.evidence_role = 'primary'
       JOIN catledger_import_rows r
         ON r.uid = ee.uid AND r.row_id = ee.row_id
       JOIN catledger_import_decisions d
         ON d.uid = e.uid AND d.event_id = e.event_id
        AND d.decision_version = (
          SELECT MAX(d2.decision_version)
            FROM catledger_import_decisions d2
           WHERE d2.uid = e.uid AND d2.event_id = e.event_id
        )
      WHERE e.uid = ? AND e.batch_id = ?
      ORDER BY r.source_row_number, e.event_id`,
    [uid, batchId]
  )
  return rows
}

async function lockSourceIdentities(connection, uid, identityIds) {
  const ids = [...new Set(identityIds.filter(Boolean))].sort()
  if (ids.length === 0) return
  const [rows] = await connection.execute(
    `SELECT identity_id
       FROM catledger_source_identities
      WHERE uid = ? AND identity_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY identity_id FOR UPDATE`,
    [uid, ...ids]
  )
  if (rows.length !== ids.length) throw importError('IDENTITY_CONFLICT')
}

async function existingTransactionsByIdentity(connection, uid, identityIds) {
  const result = new Map()
  const ids = [...new Set(identityIds.filter(Boolean))]
  if (ids.length === 0) return result
  const [rows] = await connection.execute(
    `SELECT r.identity_id AS identityId, l.transaction_id AS transactionId
      FROM catledger_import_rows r
      JOIN catledger_import_transaction_links l
         ON l.uid = r.uid AND l.row_id = r.row_id
      WHERE r.uid = ? AND r.identity_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY l.created_at, l.link_id FOR UPDATE`,
    [uid, ...ids]
  )
  rows.forEach((row) => {
    if (!result.has(row.identityId)) result.set(row.identityId, row.transactionId)
  })
  return result
}

async function lockAccounts(connection, uid, ids) {
  const accountIds = [...new Set(ids.filter(Boolean))].sort()
  if (accountIds.length === 0) return new Map()
  const [rows] = await connection.execute(
    `SELECT account_id AS id, currency, archived_at AS archivedAt
       FROM catledger_accounts
      WHERE uid = ? AND account_id IN (${accountIds.map(() => '?').join(', ')})
      ORDER BY account_id FOR UPDATE`,
    [uid, ...accountIds]
  )
  if (rows.length !== accountIds.length) throw importError('NOT_FOUND')
  rows.forEach((row) => {
    if (row.archivedAt != null || row.currency !== 'CNY') throw importError('VALIDATION_ERROR')
  })
  return new Map(rows.map((row) => [row.id, row]))
}

async function lockCategories(connection, uid, ids) {
  const categoryIds = [...new Set(ids.filter(Boolean))].sort()
  if (categoryIds.length === 0) return new Map()
  const [rows] = await connection.execute(
    `SELECT category_id AS id, kind, archived_at AS archivedAt
       FROM catledger_categories
      WHERE uid = ? AND category_id IN (${categoryIds.map(() => '?').join(', ')})
      ORDER BY category_id FOR UPDATE`,
    [uid, ...categoryIds]
  )
  if (rows.length !== categoryIds.length) throw importError('NOT_FOUND')
  rows.forEach((row) => {
    if (row.archivedAt != null) throw importError('VALIDATION_ERROR')
  })
  return new Map(rows.map((row) => [row.id, row]))
}

function canPost(row) {
  return row.parseState === 'valid' && row.identityState !== 'identity_conflict' &&
    row.economicEffect === 'normal' && ['income', 'expense'].includes(row.direction) &&
    ['payment', 'fee'].includes(row.transactionType) && row.amountMinor != null && row.localAt
}

function buildNote(row) {
  const values = [row.item, row.counterparty, row.sourceNote]
    .map((value) => String(value || '').normalize('NFKC').trim())
    .filter(Boolean)
  if (values.length === 0) return null
  return [...new Set(values)].join(' · ').slice(0, 200)
}

async function insertMapping(connection, uid, sourceType, row, decision) {
  const paymentMethodKey = buildPaymentMethodKey(sourceType, row.paymentMethod)
  const paymentAccount = paymentAccountDetails(sourceType, row.paymentMethod)
  if (!paymentMethodKey || !decision.accountId) return
  await connection.execute(
    `INSERT INTO catledger_import_account_mappings
       (uid, mapping_id, source_type, payment_method_key, payment_method_hint,
        mapping_action, account_id, disabled_at)
     VALUES (?, ?, ?, ?, ?, 'account', ?, NULL)
     ON DUPLICATE KEY UPDATE
       payment_method_hint = VALUES(payment_method_hint),
       mapping_action = 'account', account_id = VALUES(account_id),
       disabled_at = NULL, version = version + 1`,
    [uid, randomUUID(), sourceType, paymentMethodKey, paymentAccount.displayName, decision.accountId]
  )
}

async function applyPaymentRule(connection, uid, sourceType, row, action) {
  const paymentMethodKey = buildPaymentMethodKey(sourceType, row.paymentMethod)
  const paymentAccount = paymentAccountDetails(sourceType, row.paymentMethod)
  if (!paymentMethodKey || !paymentAccount.recognized) throw importError('VALIDATION_ERROR')
  if (action === 'forget') {
    await connection.execute(
      `UPDATE catledger_import_account_mappings
          SET disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP(3)), version = version + 1
        WHERE uid = ? AND source_type = ? AND payment_method_key = ?`,
      [uid, sourceType, paymentMethodKey]
    )
    return
  }
  const [existingRules] = await connection.execute(
    `SELECT mapping_action AS mappingAction, account_id AS accountId,
            payment_method_hint AS paymentMethodHint, disabled_at AS disabledAt
       FROM catledger_import_account_mappings
      WHERE uid = ? AND source_type = ? AND payment_method_key = ?
      LIMIT 1 FOR UPDATE`,
    [uid, sourceType, paymentMethodKey]
  )
  const existingRule = existingRules[0]
  if (existingRule && existingRule.mappingAction === 'ignore' && existingRule.accountId == null &&
      existingRule.disabledAt == null && existingRule.paymentMethodHint === paymentAccount.displayName) {
    return
  }
  await connection.execute(
    `INSERT INTO catledger_import_account_mappings
       (uid, mapping_id, source_type, payment_method_key, payment_method_hint,
        mapping_action, account_id, disabled_at)
     VALUES (?, ?, ?, ?, ?, 'ignore', NULL, NULL)
     ON DUPLICATE KEY UPDATE
       payment_method_hint = VALUES(payment_method_hint),
       mapping_action = 'ignore', account_id = NULL,
       disabled_at = NULL, version = version + 1`,
    [uid, randomUUID(), sourceType, paymentMethodKey, paymentAccount.displayName]
  )
}

async function insertCategoryMappings(connection, uid, sourceType, row, decision) {
  if (!decision.categoryId) return
  let evidence
  try {
    evidence = typeof row.categoryEvidence === 'string'
      ? JSON.parse(row.categoryEvidence)
      : row.categoryEvidence
  } catch (error) {
    return
  }
  const aliasKeys = evidence && Array.isArray(evidence.aliasKeys) ? evidence.aliasKeys : []
  for (const aliasKey of aliasKeys) {
    if (!/^[0-9a-f]{64}$/.test(aliasKey)) continue
    await connection.execute(
      `INSERT INTO catledger_import_category_mappings
         (uid, mapping_id, source_type, alias_key, alias_key_version, category_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         category_id = VALUES(category_id), version = version + 1`,
      [uid, randomUUID(), sourceType, aliasKey, CATEGORY_ALIAS_VERSION, decision.categoryId]
    )
  }
}

async function commitImport(connection, uid, { importId, version, decisions }, requestDigest) {
  const requested = validateDecisions(decisions)
  const file = await selectImportFile(connection, uid, importId, { forUpdate: true })
  if (file.state === 'committed') {
    const [postings] = await connection.execute(
      `SELECT created_transaction_count AS createdTransactionCount,
              reused_transaction_count AS reusedTransactionCount
         FROM catledger_import_postings
        WHERE uid = ? AND import_id = ? AND state = 'completed'
        ORDER BY completed_at DESC LIMIT 1`,
      [uid, importId]
    )
    return {
      ...publicImport(file, await selectLatestBatch(connection, uid, importId)),
      createdTransactionCount: Number(postings[0] ? postings[0].createdTransactionCount : 0),
      reusedTransactionCount: Number(postings[0] ? postings[0].reusedTransactionCount : 0)
    }
  }
  if (file.state !== 'review_ready' || Number(file.version) !== version) throw importError('CONFLICT')
  const batch = await selectLatestBatch(connection, uid, importId)
  if (!batch || batch.state !== 'review_ready') throw importError('CONFLICT')
  const rows = await selectPostingRows(connection, uid, batch.batchId)
  const pendingRows = rows.filter((row) => row.eventState === 'pending')
  if (requested.size !== pendingRows.length || pendingRows.some((row) => !requested.has(row.eventId))) {
    throw importError('UNRESOLVED_IMPORT')
  }

  await lockSourceIdentities(connection, uid, rows.map((row) => row.identityId))
  const existing = await existingTransactionsByIdentity(connection, uid, rows.map((row) => row.identityId))
  const requestedPosts = pendingRows.map((row) => ({ row, decision: requested.get(row.eventId) }))
    .filter(({ row, decision }) => decision.disposition === 'post' && !existing.has(row.identityId))
  requestedPosts.forEach(({ row, decision }) => {
    if (!canPost(row) || !decision.accountId || !decision.categoryId) throw importError('UNRESOLVED_IMPORT')
  })
  const accounts = await lockAccounts(connection, uid, requestedPosts.map(({ decision }) => decision.accountId))
  const categories = await lockCategories(connection, uid, requestedPosts.map(({ decision }) => decision.categoryId))
  requestedPosts.forEach(({ row, decision }) => {
    if (!accounts.has(decision.accountId) || categories.get(decision.categoryId).kind !== row.direction) {
      throw importError('VALIDATION_ERROR')
    }
  })

  const paymentRuleUpdates = new Map()
  pendingRows.forEach((row) => {
    const decision = requested.get(row.eventId)
    if (!decision.paymentRuleAction) return
    const paymentMethodKey = buildPaymentMethodKey(batch.sourceType, row.paymentMethod)
    if (!paymentMethodKey) throw importError('VALIDATION_ERROR')
    const previous = paymentRuleUpdates.get(paymentMethodKey)
    if (previous && previous.action !== decision.paymentRuleAction) throw importError('VALIDATION_ERROR')
    paymentRuleUpdates.set(paymentMethodKey, { action: decision.paymentRuleAction, row })
  })

  const postingId = randomUUID()
  await connection.execute(
    `INSERT INTO catledger_import_postings
       (uid, posting_id, import_id, request_digest, state, selected_event_count)
     VALUES (?, ?, ?, ?, 'running', ?)`,
    [uid, postingId, importId, requestDigest, pendingRows.length]
  )

  let created = 0
  let reused = 0
  let postedRows = 0
  for (const row of rows) {
    const decision = requested.get(row.eventId)
    let disposition = row.systemDisposition
    let accountId = row.systemAccountId
    let categoryId = row.systemCategoryId
    let transactionId = existing.get(row.identityId) || null
    let creationMethod = 'reused'

    if (row.eventState === 'pending') {
      disposition = transactionId ? 'reuse' : decision.disposition
      accountId = decision.accountId
      categoryId = decision.categoryId
      await connection.execute(
        `INSERT INTO catledger_import_decisions
           (uid, decision_id, event_id, decision_version, disposition, decision_origin,
            reason_code, account_id, category_id, decision_digest)
         VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, ?)`,
        [
          uid, randomUUID(), row.eventId, Number(row.decisionVersion) + 1, disposition,
          transactionId ? 'existing_identity_reused' : disposition === 'post' ? 'user_confirmed' : 'user_skipped',
          disposition === 'post' ? accountId : null,
          disposition === 'post' ? categoryId : null,
          digestParts('decision-v1', disposition, accountId || '', categoryId || '')
        ]
      )
    }

    if (disposition === 'post') {
      transactionId = randomUUID()
      creationMethod = 'created'
      await connection.execute(
        `INSERT INTO catledger_transactions
           (uid, transaction_id, type, source_account_id, destination_account_id,
            category_id, amount_minor, occurred_local_date, occurred_local_at,
            timezone_offset_minutes, occurred_at_utc, note, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import')`,
        [
          uid, transactionId, row.direction,
          row.direction === 'expense' ? accountId : null,
          row.direction === 'income' ? accountId : null,
          categoryId, String(row.amountMinor), row.localDate, row.localAt,
          Number(row.timezoneOffsetMinutes), row.utcAt, buildNote(row)
        ]
      )
      const paymentMethodKey = buildPaymentMethodKey(batch.sourceType, row.paymentMethod)
      if (!paymentRuleUpdates.has(paymentMethodKey)) {
        await insertMapping(connection, uid, batch.sourceType, row, { accountId })
      }
      await insertCategoryMappings(connection, uid, batch.sourceType, row, { categoryId })
      existing.set(row.identityId, transactionId)
      created += 1
      postedRows += 1
    } else if (disposition === 'reuse' && transactionId) {
      reused += 1
      postedRows += 1
    }

    if (transactionId && (disposition === 'post' || disposition === 'reuse')) {
      await connection.execute(
        `INSERT INTO catledger_import_transaction_links
           (uid, link_id, posting_id, event_id, row_id, transaction_id,
            relation_role, creation_method, rule_version)
         VALUES (?, ?, ?, ?, ?, ?, 'primary', ?, 'import-link-v1')`,
        [uid, randomUUID(), postingId, row.eventId, row.rowId, transactionId, creationMethod]
      )
    }
    const nextState = disposition === 'post' ? 'posted' : disposition === 'reuse' ? 'linked' : 'ignored'
    await connection.execute(
      `UPDATE catledger_economic_events SET state = ?, version = version + 1
        WHERE uid = ? AND event_id = ?`,
      [nextState, uid, row.eventId]
    )
    await connection.execute(
      `UPDATE catledger_import_rows SET processing_state = ?
        WHERE uid = ? AND row_id = ?`,
      [nextState, uid, row.rowId]
    )
  }

  for (const update of paymentRuleUpdates.values()) {
    await applyPaymentRule(connection, uid, batch.sourceType, update.row, update.action)
  }

  await connection.execute(
    `UPDATE catledger_import_postings
        SET state = 'completed', created_transaction_count = ?, reused_transaction_count = ?,
            completed_at = CURRENT_TIMESTAMP(3)
      WHERE uid = ? AND posting_id = ?`,
    [created, reused, uid, postingId]
  )
  await connection.execute(
    `UPDATE catledger_import_batches
        SET state = 'committed', pending_row_count = 0, posted_row_count = ?,
            updated_at = CURRENT_TIMESTAMP(3)
      WHERE uid = ? AND batch_id = ?`,
    [postedRows, uid, batch.batchId]
  )
  await connection.execute(
    `UPDATE catledger_import_files
        SET state = 'committed', version = version + 1, error_code = NULL
      WHERE uid = ? AND import_id = ? AND version = ? AND state = 'review_ready'`,
    [uid, importId, version]
  )
  const current = await selectImportFile(connection, uid, importId)
  return {
    ...publicImport(current, { ...batch, state: 'committed', postedRowCount: postedRows, pendingRowCount: 0 }),
    createdTransactionCount: created,
    reusedTransactionCount: reused
  }
}

module.exports = {
  commitImport,
  validateDecisions
}
