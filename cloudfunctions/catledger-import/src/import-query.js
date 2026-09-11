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

  }
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
            r.processing_state AS processingState, r.issues_json AS issues
       FROM catledger_import_rows r
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

async function getImport(connection, uid, { importId, pageSize, cursor, includeOptions = true }) {
  const size = parsePageSize(pageSize)
  const after = decodeCursor(cursor, importId)
  const file = await selectImportFile(connection, uid, importId)
  const batch = await selectLatestBatch(connection, uid, importId)
  const options = await listMappingOptions(connection, uid, includeOptions)
  const page = batch
    ? await listRows(connection, uid, batch.batchId, importId, size, after)
    : { rows: [], nextCursor: null }
  const result = {
    import: publicImport(file, batch),
    batch: publicBatch(batch),
    rows: page.rows.map(function (row) { return publicRow(row, batch.sourceType) }),
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
