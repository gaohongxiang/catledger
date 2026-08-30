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
            t.category_id AS categoryId,
            COALESCE(c.name, '未分类') AS categoryName,
            SUM(CASE WHEN t.type = 'refund'
              THEN -CAST(t.amount_minor AS DECIMAL(20, 0))
              ELSE CAST(t.amount_minor AS DECIMAL(20, 0)) END) AS amountMinor
       FROM catledger_transactions t
       LEFT JOIN catledger_categories c ON c.uid = t.uid AND c.category_id = t.category_id
      WHERE t.uid = ?
        AND t.occurred_local_date >= ? AND t.occurred_local_date < ?
        AND t.deleted_at IS NULL
        AND t.type IN ('expense', 'income', 'refund')
      GROUP BY CASE WHEN t.type = 'refund' THEN 'expense' ELSE t.type END, t.category_id, c.name
     HAVING amountMinor <> 0
      ORDER BY type, amountMinor DESC, t.category_id`,
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
              WHEN type = 'refund' THEN -CAST(amount_minor AS DECIMAL(20, 0))
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
  let maxExpense = 0n
  while (cursor < end) {
    const date = cursor.toISOString().slice(0, 10)
    const row = byDate.get(date)
    const expense = BigInt(minorUnitsToString(row ? row.expenseMinor : '0'))
    const income = BigInt(minorUnitsToString(row ? row.incomeMinor : '0'))
    if (expense > maxExpense) maxExpense = expense
    values.push({ date, expenseMinor: expense.toString(), incomeMinor: income.toString() })
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return values.map((row) => ({
    ...row,
    expenseHeightPermille: maxExpense > 0n && BigInt(row.expenseMinor) > 0n
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
            SUM(CASE
              WHEN type = 'expense' THEN CAST(amount_minor AS DECIMAL(20, 0))
              WHEN type = 'refund' THEN -CAST(amount_minor AS DECIMAL(20, 0))
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
        const range = parseMonth(month)
        const summary = await queryMonthlySummary(connection, uid, range)
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
        return {
          month,
          summary,
          daily,
          expenseCategories: categories.expenseCategories,
          incomeCategories: categories.incomeCategories
        }
      }
    })
  }

  return { dashboard, statistics }
}

module.exports = { createReportingService, monthSequence }
