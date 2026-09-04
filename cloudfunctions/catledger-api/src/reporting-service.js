const { listAccountsForUser } = require('./account-service')
const { executeLedgerRead } = require('./ledger-read')
const { parseMonth } = require('./local-time')
const { minorUnitsToString } = require('./money')
const { transactionToPublic } = require('./transaction-domain')
const { queryMonthlySummary, queryTransactionPage } = require('./transaction-query-service')

function basisPoints(amount, total) {
  if (total <= 0n) return 0
  return Number((amount * 10000n) / total)
}

async function queryCategoryStatistics(connection, uid, range, summary) {
  const [rows] = await connection.execute(
    `SELECT CASE WHEN t.type = 'refund' THEN 'expense' ELSE t.type END AS type,
            COALESCE(t.category_id, original.category_id) AS categoryId,
            COALESCE(c.name, '未分类') AS categoryName,
            SUM(CASE WHEN t.type = 'refund' AND t.original_transaction_id IS NOT NULL
              THEN -CAST(t.amount_minor AS DECIMAL(20, 0))
              WHEN t.type = 'refund' THEN 0
              ELSE CAST(t.amount_minor AS DECIMAL(20, 0)) END) AS amountMinor
       FROM catledger_transactions t
       LEFT JOIN catledger_transactions original
         ON original.uid = t.uid AND original.transaction_id = t.original_transaction_id
        AND original.deleted_at IS NULL
       LEFT JOIN catledger_categories c ON c.uid = t.uid
        AND c.category_id = COALESCE(t.category_id, original.category_id)
      WHERE t.uid = ?
        AND t.occurred_local_date >= ? AND t.occurred_local_date < ?
        AND t.deleted_at IS NULL
        AND t.type IN ('expense', 'income', 'refund')
      GROUP BY CASE WHEN t.type = 'refund' THEN 'expense' ELSE t.type END,
               COALESCE(t.category_id, original.category_id), c.name
     HAVING amountMinor <> 0
      ORDER BY type, amountMinor DESC, categoryId`,
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
      shareBasisPoints: basisPoints(amount > 0n ? amount : 0n, totals[row.type] || 0n)
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
            SUM(CASE
              WHEN type = 'expense' THEN CAST(amount_minor AS DECIMAL(20, 0))
              WHEN type = 'refund' AND original_transaction_id IS NOT NULL
                THEN -CAST(amount_minor AS DECIMAL(20, 0))
              ELSE 0 END) AS expenseMinor,
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
  let maximum = 0n
  while (cursor < end) {
    const date = cursor.toISOString().slice(0, 10)
    const row = byDate.get(date)
    const expense = BigInt(minorUnitsToString(row ? row.expenseMinor : '0'))
    const income = BigInt(minorUnitsToString(row ? row.incomeMinor : '0'))
    if (expense > maximum) maximum = expense
    if (income > maximum) maximum = income
    values.push({ date, expenseMinor: expense.toString(), incomeMinor: income.toString() })
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return values.map((row) => ({
    ...row,
    expenseHeightPermille: maximum > 0n && BigInt(row.expenseMinor) > 0n
      ? Number((BigInt(row.expenseMinor) * 1000n) / maximum)
      : 0,
    incomeHeightPermille: maximum > 0n && BigInt(row.incomeMinor) > 0n
      ? Number((BigInt(row.incomeMinor) * 1000n) / maximum)
      : 0
  }))
}

async function queryStatisticsMetrics(connection, uid, range) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS transactionCount,
            COUNT(DISTINCT occurred_local_date) AS activeDayCount,
            COALESCE(MAX(CASE WHEN type = 'expense' THEN amount_minor ELSE 0 END), 0) AS largestExpenseMinor,
            SUM(CASE WHEN type IN ('income', 'expense') AND category_id IS NULL THEN 1 ELSE 0 END) AS uncategorizedCount,
            COALESCE(SUM(CASE WHEN type IN ('income', 'expense') AND category_id IS NULL
              THEN amount_minor ELSE 0 END), 0) AS uncategorizedAmountMinor
       FROM catledger_transactions
      WHERE uid = ? AND occurred_local_date >= ? AND occurred_local_date < ?
        AND deleted_at IS NULL`,
    [uid, range.startDate, range.endDate]
  )
  const row = rows[0] || {}
  const activeDayCount = Number(row.activeDayCount || 0)
  const expense = BigInt(String(row.largestExpenseMinor == null ? 0 : row.largestExpenseMinor))
  return {
    metrics: {
      transactionCount: Number(row.transactionCount || 0),
      activeDayCount,
      largestExpenseMinor: expense.toString()
    },
    uncategorized: {
      transactionCount: Number(row.uncategorizedCount || 0),
      amountMinor: String(row.uncategorizedAmountMinor == null ? 0 : row.uncategorizedAmountMinor)
    }
  }
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

function summaryFromTrend(cashFlowTrend, month) {
  const current = cashFlowTrend.find((row) => row.month === month) || {
    incomeMinor: '0',
    expenseMinor: '0'
  }
  const income = BigInt(current.incomeMinor)
  const expense = BigInt(current.expenseMinor)
  return {
    incomeMinor: income.toString(),
    expenseMinor: expense.toString(),
    netIncomeMinor: (income - expense).toString()
  }
}

async function queryMonthlyCashFlowTrend(connection, uid, month) {
  const months = monthSequence(month)
  const endRange = parseMonth(month)
  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(occurred_local_date, '%Y-%m') AS localMonth,
            SUM(CASE WHEN type = 'income' THEN amount_minor ELSE 0 END) AS incomeMinor,
            SUM(CASE
              WHEN type = 'expense' THEN CAST(amount_minor AS DECIMAL(20, 0))
              WHEN type = 'refund' AND original_transaction_id IS NOT NULL
                THEN -CAST(amount_minor AS DECIMAL(20, 0))
              ELSE 0 END) AS expenseMinor
       FROM catledger_transactions
      WHERE uid = ?
        AND occurred_local_date >= ? AND occurred_local_date < ?
        AND deleted_at IS NULL
        AND type IN ('income', 'expense', 'refund')
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
    expenseHeightPermille: maximum > 0n && BigInt(row.expenseMinor) > 0n
      ? Number((BigInt(row.expenseMinor) * 1000n) / maximum)
      : 0
  }))
}

function createReportingService({ getPool }) {
  async function dashboard(context) {
    return executeLedgerRead({
      getPool,
      ...context,
      consistentSnapshot: true,
      operation: async (connection, uid) => {
        const month = context.data && context.data.month
        const accounts = await listAccountsForUser(connection, uid)
        const recentRows = await queryTransactionPage(connection, uid, {
          month,
          range: { startDate: '1000-01-01', endDate: '9999-12-31' },
          accountId: null,
          categoryId: null,
          search: null,
          pageSize: 5
        }, null)
        const cashFlowTrend = await queryMonthlyCashFlowTrend(connection, uid, month)
        const summary = summaryFromTrend(cashFlowTrend, month)
        const netWorth = accounts.reduce(
          (total, account) => total + BigInt(account.bookBalanceMinor),
          0n
        )
        return {
          month,
          netWorthMinor: netWorth.toString(),
          summary,
          cashFlowTrend,
          accounts,
          recentTransactions: recentRows.slice(0, 5).map(transactionToPublic)
        }
      }
    })
  }

  async function statistics(context) {
    return executeLedgerRead({
      getPool,
      ...context,
      consistentSnapshot: true,
      operation: async (connection, uid) => {
        const month = context.data && context.data.month
        const range = parseMonth(month)
        const summary = await queryMonthlySummary(connection, uid, range)
        const categories = await queryCategoryStatistics(connection, uid, range, summary)
        const daily = await queryDailyStatistics(connection, uid, range)
        const cashFlowTrend = await queryMonthlyCashFlowTrend(connection, uid, month)
        const quality = await queryStatisticsMetrics(connection, uid, range)
        return {
          month,
          summary,
          daily,
          cashFlowTrend,
          metrics: {
            ...quality.metrics,
            averageDailyExpenseMinor: quality.metrics.activeDayCount > 0
              ? (BigInt(summary.expenseMinor) / BigInt(quality.metrics.activeDayCount)).toString()
              : '0'
          },
          uncategorized: quality.uncategorized,
          expenseCategories: categories.expenseCategories,
          incomeCategories: categories.incomeCategories
        }
      }
    })
  }

  return { dashboard, statistics }
}

module.exports = { createReportingService, monthSequence, summaryFromTrend }
