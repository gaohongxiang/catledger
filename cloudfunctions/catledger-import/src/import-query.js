const { importError } = require('./errors')
const { paymentAccountDetails } = require('./payment-account')
const {
  publicBatch,
  publicImport,
  selectImportFile,
  selectLatestBatch
} = require('./import-repository')

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

function parsePageSize(value) {
  if (value == null) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw importError('VALIDATION_ERROR')
  return value
}

function encodeCursor(importId, rowNumber) {
  return Buffer.from(JSON.stringify({ v: 1, importId, rowNumber }), 'utf8').toString('base64url')
}

function decodeCursor(cursor, importId) {
  if (cursor == null) return 0
  if (typeof cursor !== 'string' || cursor.length > 256) throw importError('VALIDATION_ERROR')
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (parsed.v !== 1 || parsed.importId !== importId || !Number.isInteger(parsed.rowNumber) || parsed.rowNumber < 1) {
      throw new Error('invalid cursor')
    }
    return parsed.rowNumber
  } catch (error) {
    throw importError('VALIDATION_ERROR', error)
  }
}

function parseJson(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (error) {
      return fallback
    }
  }
  return value
}

function publicRow(row, sourceType) {
  const paymentAccount = paymentAccountDetails(sourceType, row.paymentMethod)
  return {
    rowId: row.rowId,
    eventId: row.eventId,
    rowNumber: Number(row.rowNumber),
    sourceLocator: row.sourceLocator,
    time: row.localAt,
    amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
    direction: row.direction,
    transactionType: row.transactionType,
    economicEffect: row.economicEffect,
    counterparty: row.counterparty || '',
    item: row.item || '',
    paymentMethod: paymentAccount.displayName,
    paymentMethodRecognized: paymentAccount.recognized,
    parseState: row.parseState,
    identityState: row.identityState,
    processingState: row.processingState,
    issues: parseJson(row.issues, []),
    decision: row.eventId ? {
      disposition: row.disposition,
      reasonCode: row.reasonCode,
      accountId: row.decisionAccountId || row.mappedAccountId || null,
      categoryId: row.categoryId || row.suggestedCategoryId || null,
      paymentRuleAction: row.mappedRuleAction || null
    } : null
  }
}

async function applyCategorySuggestions(connection, uid, sourceType, rows, categories) {
  const evidenceByRow = new Map()
  const aliasKeys = new Set()
  rows.forEach((row) => {
    const evidence = parseJson(row.categoryEvidence, {})
    evidenceByRow.set(row.rowId, evidence)
    ;(Array.isArray(evidence.aliasKeys) ? evidence.aliasKeys : []).forEach((key) => aliasKeys.add(key))
  })
  const aliases = new Map()
  if (aliasKeys.size > 0) {
    const keys = [...aliasKeys]
    const [mappings] = await connection.execute(
      `SELECT alias_key AS aliasKey, category_id AS categoryId
         FROM catledger_import_category_mappings
        WHERE uid = ? AND source_type = ?
          AND alias_key IN (${keys.map(() => '?').join(', ')})`,
      [uid, sourceType, ...keys]
    )
    mappings.forEach((mapping) => aliases.set(mapping.aliasKey, mapping.categoryId))
  }
  const categoriesById = new Map(categories.map((category) => [category.id, category]))
  const categoriesBySystemKey = new Map(categories.map((category) => [category.systemKey, category]))
  return rows.map((row) => {
    if (!row.eventId || row.categoryId) return row
    const evidence = evidenceByRow.get(row.rowId) || {}
    let categoryId = null
    for (const key of Array.isArray(evidence.aliasKeys) ? evidence.aliasKeys : []) {
      const candidateId = aliases.get(key)
      const category = categoriesById.get(candidateId)
      if (category && category.kind === row.direction) {
        categoryId = candidateId
        break
      }
    }
    if (!categoryId && evidence.deterministicSystemKey) {
      const category = categoriesBySystemKey.get(evidence.deterministicSystemKey)
      if (category && category.kind === row.direction) categoryId = category.id
    }
    if (!categoryId) return row
    return { ...row, suggestedCategoryId: categoryId }
  })
}

async function listRows(connection, uid, batchId, importId, pageSize, afterRowNumber) {
  const [rows] = await connection.execute(
    `SELECT r.row_id AS rowId, r.source_row_number AS rowNumber, r.source_locator AS sourceLocator,
            r.normalized_local_at AS localAt, r.normalized_amount_minor AS amountMinor,
            r.normalized_direction AS direction,
            r.normalized_transaction_type AS transactionType,
            r.economic_effect AS economicEffect,
            r.counterparty_raw AS counterparty, r.item_raw AS item,
            r.payment_method_raw AS paymentMethod, r.category_evidence_json AS categoryEvidence,
            r.parse_state AS parseState, r.identity_state AS identityState,
            r.processing_state AS processingState, r.issues_json AS issues,
            e.event_id AS eventId, d.disposition, d.reason_code AS reasonCode,
            d.account_id AS decisionAccountId, d.category_id AS categoryId,
            m.account_id AS mappedAccountId, m.mapping_action AS mappedRuleAction
       FROM catledger_import_rows r
       LEFT JOIN catledger_event_evidence ee
         ON ee.uid = r.uid AND ee.row_id = r.row_id AND ee.evidence_role = 'primary'
       LEFT JOIN catledger_economic_events e
         ON e.uid = ee.uid AND e.event_id = ee.event_id
       LEFT JOIN catledger_import_decisions d
         ON d.uid = e.uid AND d.event_id = e.event_id
        AND d.decision_version = (
          SELECT MAX(d2.decision_version)
            FROM catledger_import_decisions d2
           WHERE d2.uid = e.uid AND d2.event_id = e.event_id
        )
       LEFT JOIN catledger_import_account_mappings m
         ON m.uid = r.uid AND m.source_type = (
           SELECT b.source_type FROM catledger_import_batches b
            WHERE b.uid = r.uid AND b.batch_id = r.batch_id
         ) AND m.payment_method_key = r.payment_method_key
        AND m.disabled_at IS NULL
      WHERE r.uid = ? AND r.batch_id = ? AND r.source_row_number > ?
      ORDER BY r.source_row_number
      LIMIT ?`,
    [uid, batchId, afterRowNumber, pageSize + 1]
  )
  const hasMore = rows.length > pageSize
  const visible = rows.slice(0, pageSize)
  return {
    rows: visible,
    nextCursor: hasMore ? encodeCursor(importId, Number(rows[pageSize - 1].rowNumber)) : null
  }
}

async function listMappingOptions(connection, uid, includeAccounts) {
  const accounts = includeAccounts
    ? (await connection.execute(
      `SELECT account_id AS id, type, nature, name, currency
         FROM catledger_accounts
        WHERE uid = ? AND archived_at IS NULL
        ORDER BY created_at, account_id`,
      [uid]
    ))[0]
    : []
  const [categories] = await connection.execute(
    `SELECT category_id AS id, kind, system_key AS systemKey, name, sort_order AS sortOrder
       FROM catledger_categories
      WHERE uid = ? AND archived_at IS NULL
      ORDER BY kind, sort_order, category_id`,
    [uid]
  )
  return { accounts, categories }
}

async function latestPosting(connection, uid, importId) {
  const [rows] = await connection.execute(
    `SELECT created_transaction_count AS createdTransactionCount,
            reused_transaction_count AS reusedTransactionCount
       FROM catledger_import_postings
      WHERE uid = ? AND import_id = ? AND state = 'completed'
      ORDER BY completed_at DESC, posting_id DESC
      LIMIT 1`,
    [uid, importId]
  )
  if (!rows[0]) return null
  return {
    createdTransactionCount: Number(rows[0].createdTransactionCount),
    reusedTransactionCount: Number(rows[0].reusedTransactionCount)
  }
}

async function getImport(connection, uid, { importId, pageSize, cursor, includeOptions = true }) {
  const size = parsePageSize(pageSize)
  const after = decodeCursor(cursor, importId)
  const file = await selectImportFile(connection, uid, importId)
  const batch = await selectLatestBatch(connection, uid, importId)
  const options = await listMappingOptions(connection, uid, includeOptions)
  const posting = file.state === 'committed' ? await latestPosting(connection, uid, importId) : null
  const page = batch
    ? await listRows(connection, uid, batch.batchId, importId, size, after)
    : { rows: [], nextCursor: null }
  const rows = batch
    ? await applyCategorySuggestions(connection, uid, batch.sourceType, page.rows, options.categories)
    : []
  const result = {
    import: publicImport(file, batch),
    batch: publicBatch(batch),
    posting,
    rows: rows.map(function (row) { return publicRow(row, batch.sourceType) }),
    nextCursor: page.nextCursor
  }
  if (includeOptions) {
    result.accounts = options.accounts
    result.categories = options.categories
  }
  return result
}

module.exports = {
  decodeCursor,
  encodeCursor,
  getImport
}
