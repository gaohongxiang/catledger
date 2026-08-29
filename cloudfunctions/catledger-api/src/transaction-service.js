const { randomUUID } = require('node:crypto')

const { decodeCursor, encodeCursor } = require('./cursor')
const { ledgerError } = require('./ledger-errors')
const { executeIdempotentMutation, resolveUid } = require('./ledger-transaction')
const { parseLocalDate, parseLocalDateTime, parseMonth } = require('./local-time')
const { minorUnitsToString, parseMinorUnits } = require('./money')
const { digestRequest } = require('./request-digest')

const MANUAL_TYPES = new Set(['expense', 'income', 'transfer'])

function parseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return value
}

function normalizeOptionalNote(value) {
  if (value == null || value === '') {
    return null
  }
  if (typeof value !== 'string') {
    throw ledgerError('VALIDATION_ERROR')
  }
  const note = value.normalize('NFKC').trim()
  if (Array.from(note).length > 200) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return note || null
}

function validateId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return value
}

function transactionToPublic(row) {
  return {
    transactionId: row.transactionId,
    type: row.type,
    sourceAccount: row.sourceAccountId == null
      ? null
      : { accountId: row.sourceAccountId, name: row.sourceAccountName || null },
    destinationAccount: row.destinationAccountId == null
      ? null
      : { accountId: row.destinationAccountId, name: row.destinationAccountName || null },
    category: row.categoryId == null
      ? null
      : { categoryId: row.categoryId, name: row.categoryName || null, kind: row.categoryKind || null },
    amountMinor: minorUnitsToString(row.amountMinor),
    occurredLocalAt: String(row.occurredLocalAt).replace(' ', 'T'),
    timezoneOffsetMinutes: Number(row.timezoneOffsetMinutes),
    note: row.note == null ? null : row.note,
    version: Number(row.version)
  }
}

async function lockAccounts(connection, uid, accountIds) {
  const ids = [...new Set(accountIds.filter(Boolean).map(validateId))].sort()
  if (ids.length === 0) {
    return new Map()
  }
  const placeholders = ids.map(() => '?').join(', ')
  const [rows] = await connection.execute(
    `SELECT account_id AS accountId, name, currency, archived_at AS archivedAt
       FROM catledger_accounts
      WHERE uid = ? AND account_id IN (${placeholders})
      ORDER BY account_id
      FOR UPDATE`,
    [uid, ...ids]
  )
  if (rows.length !== ids.length) {
    throw ledgerError('NOT_FOUND')
  }
  const accounts = new Map(rows.map((row) => [row.accountId, row]))
  for (const account of accounts.values()) {
    if (account.archivedAt != null) {
      throw ledgerError('ACCOUNT_INACTIVE')
    }
    if (account.currency !== 'CNY') {
      throw ledgerError('UNSUPPORTED_CURRENCY')
    }
  }
  return accounts
}

async function validateCategory(connection, uid, categoryId, expectedKind) {
  validateId(categoryId)
  const [rows] = await connection.execute(
    `SELECT kind
       FROM catledger_categories
      WHERE uid = ? AND category_id = ? AND archived_at IS NULL
      LIMIT 1`,
    [uid, categoryId]
  )
  if (!rows[0]) {
    throw ledgerError('NOT_FOUND')
  }
  if (rows[0].kind !== expectedKind) {
    throw ledgerError('VALIDATION_ERROR')
  }
}

function buildManualTransaction(data) {
  if (!MANUAL_TYPES.has(data.type)) {
    throw ledgerError('VALIDATION_ERROR')
  }
  const amount = parseMinorUnits(data.amountMinor)
  const time = parseLocalDateTime(data.occurredLocalAt, data.timezoneOffsetMinutes)
  const note = normalizeOptionalNote(data.note)
  let sourceAccountId = null
  let destinationAccountId = null
  let categoryId = null

  if (data.type === 'expense') {
    sourceAccountId = validateId(data.sourceAccountId)
    categoryId = validateId(data.categoryId)
  } else if (data.type === 'income') {
    destinationAccountId = validateId(data.destinationAccountId)
    categoryId = validateId(data.categoryId)
  } else {
    sourceAccountId = validateId(data.sourceAccountId)
    destinationAccountId = validateId(data.destinationAccountId)
    if (sourceAccountId === destinationAccountId || data.categoryId != null) {
      throw ledgerError('VALIDATION_ERROR')
    }
  }

  return {
    type: data.type,
    sourceAccountId,
    destinationAccountId,
    categoryId,
    amountMinor: amount.toString(),
    note,
    ...time
  }
}

async function validateTransactionRelations(connection, uid, transaction, extraAccountIds = []) {
  await lockAccounts(connection, uid, [
    transaction.sourceAccountId,
    transaction.destinationAccountId,
    ...extraAccountIds
  ])

  if (transaction.categoryId) {
    await validateCategory(connection, uid, transaction.categoryId, transaction.type)
  }
}

async function selectTransaction(connection, uid, transactionId, { forUpdate = false } = {}) {
  validateId(transactionId)
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
            t.amount_minor AS amountMinor,
            t.occurred_local_at AS occurredLocalAt,
            t.timezone_offset_minutes AS timezoneOffsetMinutes,
            t.note,
            t.origin,
            t.version,
            t.deleted_at AS deletedAt
       FROM catledger_transactions t
       LEFT JOIN catledger_accounts sa
         ON sa.uid = t.uid AND sa.account_id = t.source_account_id
       LEFT JOIN catledger_accounts da
         ON da.uid = t.uid AND da.account_id = t.destination_account_id
       LEFT JOIN catledger_categories c
         ON c.uid = t.uid AND c.category_id = t.category_id
      WHERE t.uid = ? AND t.transaction_id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, transactionId]
  )
  if (!rows[0]) {
    throw ledgerError('NOT_FOUND')
  }
  return rows[0]
}

function ensureEditable(row, version) {
  if (row.deletedAt != null || row.origin !== 'manual' || !MANUAL_TYPES.has(row.type)) {
    throw ledgerError('NOT_FOUND')
  }
  if (Number(row.version) !== parseVersion(version)) {
    throw ledgerError('CONFLICT')
  }
}

async function insertManualTransaction(connection, uid, transactionId, transaction) {
  await connection.execute(
    `INSERT INTO catledger_transactions
       (uid, transaction_id, type, source_account_id, destination_account_id,
        category_id, amount_minor, occurred_local_date, occurred_local_at,
        timezone_offset_minutes, occurred_at_utc, note, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    [
      uid,
      transactionId,
      transaction.type,
      transaction.sourceAccountId,
      transaction.destinationAccountId,
      transaction.categoryId,
      transaction.amountMinor,
      transaction.localDate,
      transaction.localAt,
      transaction.timezoneOffsetMinutes,
      transaction.occurredAtUtc,
      transaction.note
    ]
  )
}

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
    if (typeof data.search !== 'string') {
      throw ledgerError('VALIDATION_ERROR')
    }
    search = data.search.normalize('NFKC').trim()
    if (Array.from(search).length > 40) {
      throw ledgerError('VALIDATION_ERROR')
    }
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
            COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS expenseMinor
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
            t.amount_minor AS amountMinor,
            t.occurred_local_at AS occurredLocalAt,
            t.timezone_offset_minutes AS timezoneOffsetMinutes,
            t.note,
            t.version
       FROM catledger_transactions t
       LEFT JOIN catledger_accounts sa ON sa.uid = t.uid AND sa.account_id = t.source_account_id
       LEFT JOIN catledger_accounts da ON da.uid = t.uid AND da.account_id = t.destination_account_id
       LEFT JOIN catledger_categories c ON c.uid = t.uid AND c.category_id = t.category_id
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY t.occurred_local_at DESC, t.transaction_id DESC
      LIMIT ?`,
    values
  )
  return rows
}

function basisPoints(amount, total) {
  if (total <= 0n) {
    return 0
  }
  return Number((amount * 10000n) / total)
}

async function queryCategoryStatistics(connection, uid, range, summary) {
  const [rows] = await connection.execute(
    `SELECT t.type,
            t.category_id AS categoryId,
            COALESCE(c.name, '未分类') AS categoryName,
            SUM(t.amount_minor) AS amountMinor
       FROM catledger_transactions t
       LEFT JOIN catledger_categories c ON c.uid = t.uid AND c.category_id = t.category_id
      WHERE t.uid = ?
        AND t.occurred_local_date >= ? AND t.occurred_local_date < ?
        AND t.deleted_at IS NULL
        AND t.type IN ('expense', 'income')
      GROUP BY t.type, t.category_id, c.name
      ORDER BY t.type, amountMinor DESC, t.category_id`,
    [uid, range.startDate, range.endDate]
  )
  const totals = {
    expense: BigInt(summary.expenseMinor),
    income: BigInt(summary.incomeMinor)
  }
  function prepareCategory(row) {
    const amount = BigInt(minorUnitsToString(row.amountMinor))
    return {
      categoryId: row.categoryId,
      name: row.categoryName,
      amountMinor: amount.toString(),
      shareBasisPoints: basisPoints(amount, totals[row.type] || 0n)
    }
  }
  return {
    expenseCategories: rows.filter((row) => row.type === 'expense').map(prepareCategory),
    incomeCategories: rows.filter((row) => row.type === 'income').map(prepareCategory)
  }
}

async function queryDailyStatistics(connection, uid, range) {
  const [rows] = await connection.execute(
    `SELECT occurred_local_date AS localDate,
            SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END) AS expenseMinor,
            SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END) AS incomeMinor
       FROM catledger_transactions
      WHERE uid = ?
        AND occurred_local_date >= ? AND occurred_local_date < ?
        AND deleted_at IS NULL
      GROUP BY occurred_local_date
      ORDER BY occurred_local_date`,
    [uid, range.startDate, range.endDate]
  )
  const byDate = new Map(rows.map((row) => [String(row.localDate), row]))
  const values = []
  let cursor = new Date(`${range.startDate}T00:00:00.000Z`)
  const end = new Date(`${range.endDate}T00:00:00.000Z`)
  let maxExpense = 0n
  while (cursor < end) {
    const date = cursor.toISOString().slice(0, 10)
    const row = byDate.get(date)
    const expense = BigInt(minorUnitsToString(row ? row.expenseMinor : '0'))
    const income = BigInt(minorUnitsToString(row ? row.incomeMinor : '0'))
    if (expense > maxExpense) {
      maxExpense = expense
    }
    values.push({ date, expenseMinor: expense.toString(), incomeMinor: income.toString() })
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return values.map((row) => ({
    ...row,
    expenseHeightPermille: maxExpense > 0n
      ? Number((BigInt(row.expenseMinor) * 1000n) / maxExpense)
      : 0
  }))
}

function monthSequence(month, count = 6) {
  parseMonth(month)
  const [year, monthNumber] = month.split('-').map(Number)
  const values = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const cursor = new Date(Date.UTC(year, monthNumber - 1 - offset, 1))
    values.push(`${String(cursor.getUTCFullYear()).padStart(4, '0')}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return values
}

async function queryMonthlyCashFlowTrend(connection, uid, month) {
  const months = monthSequence(month)
  const endRange = parseMonth(month)
  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(occurred_local_date, '%Y-%m') AS localMonth,
            SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END) AS incomeMinor,
            SUM(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END) AS expenseMinor
       FROM catledger_transactions
      WHERE uid = ?
        AND occurred_local_date >= ? AND occurred_local_date < ?
        AND deleted_at IS NULL
        AND type IN ('income', 'expense')
      GROUP BY DATE_FORMAT(occurred_local_date, '%Y-%m')
      ORDER BY localMonth`,
    [uid, `${months[0]}-01`, endRange.endDate]
  )
  const byMonth = new Map(rows.map((row) => [String(row.localMonth), row]))
  let maximum = 0n
  const values = months.map((value) => {
    const row = byMonth.get(value)
    const income = BigInt(minorUnitsToString(row ? row.incomeMinor : '0'))
    const expense = BigInt(minorUnitsToString(row ? row.expenseMinor : '0'))
    if (income > maximum) maximum = income
    if (expense > maximum) maximum = expense
    return { month: value, incomeMinor: income.toString(), expenseMinor: expense.toString() }
  })
  return values.map((row) => ({
    ...row,
    incomeHeightPermille: maximum > 0n ? Number((BigInt(row.incomeMinor) * 1000n) / maximum) : 0,
    expenseHeightPermille: maximum > 0n ? Number((BigInt(row.expenseMinor) * 1000n) / maximum) : 0
  }))
}

function createTransactionService({ getPool, accountService }) {
  async function create(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'transactions.create',
      operation: async (connection, uid, data) => {
        const transaction = buildManualTransaction(data)
        await validateTransactionRelations(connection, uid, transaction)
        const transactionId = randomUUID()
        await insertManualTransaction(connection, uid, transactionId, transaction)
        return transactionToPublic({
          transactionId,
          ...transaction,
          occurredLocalAt: transaction.localAt,
          version: 1
        })
      }
    })
  }

  async function update(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'transactions.update',
      operation: async (connection, uid, data) => {
        const current = await selectTransaction(connection, uid, data.transactionId, { forUpdate: true })
        ensureEditable(current, data.version)
        const transaction = buildManualTransaction(data)
        await validateTransactionRelations(connection, uid, transaction, [
          current.sourceAccountId,
          current.destinationAccountId
        ])

        await connection.execute(
          `UPDATE catledger_transactions
              SET type = ?, source_account_id = ?, destination_account_id = ?, category_id = ?,
                  amount_minor = ?, occurred_local_date = ?, occurred_local_at = ?,
                  timezone_offset_minutes = ?, occurred_at_utc = ?, note = ?, version = version + 1
            WHERE uid = ? AND transaction_id = ? AND version = ? AND deleted_at IS NULL`,
          [
            transaction.type,
            transaction.sourceAccountId,
            transaction.destinationAccountId,
            transaction.categoryId,
            transaction.amountMinor,
            transaction.localDate,
            transaction.localAt,
            transaction.timezoneOffsetMinutes,
            transaction.occurredAtUtc,
            transaction.note,
            uid,
            current.transactionId,
            data.version
          ]
        )
        return transactionToPublic({
          transactionId: current.transactionId,
          ...transaction,
          occurredLocalAt: transaction.localAt,
          version: Number(current.version) + 1
        })
      }
    })
  }

  async function remove(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'transactions.delete',
      operation: async (connection, uid, data) => {
        const current = await selectTransaction(connection, uid, data.transactionId, { forUpdate: true })
        ensureEditable(current, data.version)
        await lockAccounts(connection, uid, [current.sourceAccountId, current.destinationAccountId])
        await connection.execute(
          `UPDATE catledger_transactions
              SET deleted_at = CURRENT_TIMESTAMP(3), version = version + 1
            WHERE uid = ? AND transaction_id = ? AND version = ? AND deleted_at IS NULL`,
          [uid, current.transactionId, data.version]
        )
        return {
          transactionId: current.transactionId,
          deleted: true,
          version: Number(current.version) + 1
        }
      }
    })
  }

  async function list(context) {
    const connection = await getPool().getConnection()
    try {
      const uid = await resolveUid(connection, context.provider, context.subjectHash)
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

      const [summary, rows] = await Promise.all([
        queryMonthlySummary(connection, uid, filters.range),
        queryTransactionPage(connection, uid, filters, cursor)
      ])
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
    } finally {
      connection.release()
    }
  }

  async function dashboard(context) {
    const connection = await getPool().getConnection()
    try {
      const uid = await resolveUid(connection, context.provider, context.subjectHash)
      const range = parseMonth(context.data && context.data.month)
      const [summary, accountResult, recentRows] = await Promise.all([
        queryMonthlySummary(connection, uid, range),
        accountService.list(context),
        queryTransactionPage(connection, uid, {
          month: context.data.month,
          range: { startDate: '1000-01-01', endDate: '9999-12-31' },
          accountId: null,
          categoryId: null,
          search: null,
          pageSize: 5
        }, null)
      ])
      const netWorth = accountResult.accounts.reduce(
        (total, account) => total + BigInt(account.bookBalanceMinor),
        0n
      )
      const cashFlowTrend = await queryMonthlyCashFlowTrend(connection, uid, context.data.month)
      return {
        month: context.data.month,
        netWorthMinor: netWorth.toString(),
        summary,
        cashFlowTrend,
        accounts: accountResult.accounts,
        recentTransactions: recentRows.slice(0, 5).map(transactionToPublic)
      }
    } finally {
      connection.release()
    }
  }

  async function statistics(context) {
    const connection = await getPool().getConnection()
    try {
      const uid = await resolveUid(connection, context.provider, context.subjectHash)
      const month = context.data && context.data.month
      const range = parseMonth(month)
      const summary = await queryMonthlySummary(connection, uid, range)
      const [categories, daily] = await Promise.all([
        queryCategoryStatistics(connection, uid, range, summary),
        queryDailyStatistics(connection, uid, range)
      ])
      return {
        month,
        summary,
        daily,
        expenseCategories: categories.expenseCategories,
        incomeCategories: categories.incomeCategories
      }
    } finally {
      connection.release()
    }
  }

  return {
    create,
    dashboard,
    list,
    remove,
    statistics,
    update
  }
}

module.exports = {
  buildManualTransaction,
  createTransactionService,
  monthSequence,
  normalizeListFilters,
  transactionToPublic
}
