const { decodeCursor, encodeCursor } = require('./cursor')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { parseLocalDate, parseMonth } = require('./local-time')
const { minorUnitsToString } = require('./money')
const { digestRequest } = require('./request-digest')
const { transactionToPublic, validateId } = require('./transaction-domain')

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function normalizeListFilters(data) {
  const month = data.month
  const monthRange = parseMonth(month)
  const date = data.date == null || data.date === '' ? null : data.date
  if (date != null && (typeof date !== 'string' || date.slice(0, 7) !== month)) {
    throw ledgerError('VALIDATION_ERROR')
  }
  const range = date == null ? monthRange : parseLocalDate(date)
  const accountId = data.accountId == null ? null : validateId(data.accountId)
  const categoryId = data.categoryId == null ? null : validateId(data.categoryId)
  let search = null
  if (data.search != null && data.search !== '') {
    if (typeof data.search !== 'string') throw ledgerError('VALIDATION_ERROR')
    search = data.search.normalize('NFKC').trim()
    if (Array.from(search).length > 40) throw ledgerError('VALIDATION_ERROR')
    search = search || null
  }
  const pageSize = data.pageSize == null ? 50 : data.pageSize
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return { month, date, range, accountId, categoryId, search, pageSize }
}

async function queryMonthlySummary(connection, uid, range) {
  const [[row]] = await connection.execute(
    `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END), 0) AS incomeMinor,
            COALESCE(SUM(CASE
              WHEN type = 'expense' THEN CAST(amount_minor AS DECIMAL(20, 0))
              WHEN type = 'refund' AND original_transaction_id IS NOT NULL
                THEN -CAST(amount_minor AS DECIMAL(20, 0))
              ELSE 0 END), 0) AS expenseMinor
       FROM catledger_transactions
      WHERE uid = ?
        AND occurred_local_date >= ? AND occurred_local_date < ?
        AND deleted_at IS NULL`,
    [uid, range.startDate, range.endDate]
  )
  const income = BigInt(minorUnitsToString(row.incomeMinor))
  const expense = BigInt(minorUnitsToString(row.expenseMinor))
  return {
    incomeMinor: income.toString(),
    expenseMinor: expense.toString(),
    netIncomeMinor: (income - expense).toString()
  }
}

async function queryTransactionPage(connection, uid, filters, cursor) {
  const conditions = [
    't.uid = ?',
    't.occurred_local_date >= ?',
    't.occurred_local_date < ?',
    't.deleted_at IS NULL'
  ]
  const values = [uid, filters.range.startDate, filters.range.endDate]
  if (filters.accountId) {
    conditions.push('(t.source_account_id = ? OR t.destination_account_id = ?)')
    values.push(filters.accountId, filters.accountId)
  }
  if (filters.categoryId) {
    conditions.push('t.category_id = ?')
    values.push(filters.categoryId)
  }
  if (filters.search) {
    conditions.push("t.note LIKE ? ESCAPE '\\\\'")
    values.push(`%${escapeLike(filters.search)}%`)
  }
  if (cursor) {
    conditions.push('(t.occurred_local_at < ? OR (t.occurred_local_at = ? AND t.transaction_id < ?))')
    values.push(cursor.occurredLocalAt, cursor.occurredLocalAt, cursor.transactionId)
  }
  values.push(filters.pageSize + 1)

  const [rows] = await connection.execute(
    `SELECT t.transaction_id AS transactionId,
            t.type,
            t.source_account_id AS sourceAccountId,
            sa.name AS sourceAccountName,
            t.destination_account_id AS destinationAccountId,
            da.name AS destinationAccountName,
            t.category_id AS categoryId,
            c.name AS categoryName,
            c.kind AS categoryKind,
            t.original_transaction_id AS originalTransactionId,
            original.amount_minor AS originalAmountMinor,
            original.occurred_local_at AS originalOccurredLocalAt,
            original.note AS originalNote,
            t.amount_minor AS amountMinor,
            t.occurred_local_at AS occurredLocalAt,
            t.timezone_offset_minutes AS timezoneOffsetMinutes,
            t.note,
            t.origin,
            t.version
       FROM catledger_transactions t
       LEFT JOIN catledger_accounts sa ON sa.uid = t.uid AND sa.account_id = t.source_account_id
       LEFT JOIN catledger_accounts da ON da.uid = t.uid AND da.account_id = t.destination_account_id
       LEFT JOIN catledger_categories c ON c.uid = t.uid AND c.category_id = t.category_id
       LEFT JOIN catledger_transactions original
         ON original.uid = t.uid AND original.transaction_id = t.original_transaction_id
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY t.occurred_local_at DESC, t.transaction_id DESC
      LIMIT ?`,
    values
  )
  return rows
}

async function listRefundableRows(connection, uid, limit) {
  const [rows] = await connection.execute(
    `SELECT t.transaction_id AS transactionId, t.type,
            t.source_account_id AS sourceAccountId, sa.name AS sourceAccountName,
            t.destination_account_id AS destinationAccountId, da.name AS destinationAccountName,
            t.category_id AS categoryId, c.name AS categoryName, c.kind AS categoryKind,
            t.amount_minor AS amountMinor, t.occurred_local_at AS occurredLocalAt,
            t.timezone_offset_minutes AS timezoneOffsetMinutes, t.note, t.version,
            COALESCE(refunds.refunded_minor, 0) AS refundedMinor
       FROM catledger_transactions t
       LEFT JOIN catledger_accounts sa ON sa.uid = t.uid AND sa.account_id = t.source_account_id
       LEFT JOIN catledger_accounts da ON da.uid = t.uid AND da.account_id = t.destination_account_id
       LEFT JOIN catledger_categories c ON c.uid = t.uid AND c.category_id = t.category_id
       LEFT JOIN (
         SELECT uid, original_transaction_id, SUM(amount_minor) AS refunded_minor
           FROM catledger_transactions
          WHERE uid = ? AND type = 'refund' AND deleted_at IS NULL
          GROUP BY uid, original_transaction_id
       ) refunds ON refunds.uid = t.uid AND refunds.original_transaction_id = t.transaction_id
      WHERE t.uid = ? AND t.type = 'expense' AND t.deleted_at IS NULL
        AND CAST(t.amount_minor AS DECIMAL(20, 0)) > COALESCE(refunds.refunded_minor, 0)
      ORDER BY t.occurred_local_at DESC, t.transaction_id DESC
      LIMIT ?`,
    [uid, uid, limit]
  )
  return rows.map((row) => ({
    ...transactionToPublic(row),
    refundedMinor: minorUnitsToString(row.refundedMinor),
    refundableMinor: (BigInt(minorUnitsToString(row.amountMinor)) - BigInt(minorUnitsToString(row.refundedMinor))).toString()
  }))
}

function createTransactionQueryService({ getPool }) {
  async function list(context) {
    return executeLedgerRead({
      getPool,
      ...context,
      consistentSnapshot: true,
      operation: async (connection, uid) => {
        const filters = normalizeListFilters(context.data || {})
        const filterDigest = digestRequest('transactions.list', {
          month: filters.month,
          date: filters.date,
          accountId: filters.accountId,
          categoryId: filters.categoryId,
          search: filters.search
        })
        let cursor = null
        if (context.data && context.data.cursor) {
          cursor = decodeCursor(context.subjectHash, context.data.cursor)
          if (cursor.filterDigest !== filterDigest || typeof cursor.occurredLocalAt !== 'string' ||
              typeof cursor.transactionId !== 'string') {
            throw ledgerError('VALIDATION_ERROR')
          }
        }

        const summary = await queryMonthlySummary(connection, uid, filters.range)
        const rows = await queryTransactionPage(connection, uid, filters, cursor)
        const hasMore = rows.length > filters.pageSize
        const pageRows = hasMore ? rows.slice(0, filters.pageSize) : rows
        const last = pageRows[pageRows.length - 1]
        const nextCursor = hasMore && last
          ? encodeCursor(context.subjectHash, {
              filterDigest,
              occurredLocalAt: String(last.occurredLocalAt),
              transactionId: last.transactionId
            })
          : null
        return {
          month: filters.month,
          date: filters.date,
          summary,
          transactions: pageRows.map(transactionToPublic),
          nextCursor
        }
      }
    })
  }

  async function refundable(context) {
    return executeLedgerRead({
      getPool,
      ...context,
      operation: async (connection, uid) => {
        const limit = context.data && context.data.limit == null ? 50 : context.data.limit
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw ledgerError('VALIDATION_ERROR')
        return { transactions: await listRefundableRows(connection, uid, limit) }
      }
    })
  }

  return { list, refundable }
}

module.exports = {
  createTransactionQueryService,
  normalizeListFilters,
  queryMonthlySummary,
  queryTransactionPage
}
