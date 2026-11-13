const { listAccountsForUser } = require('./account-service')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
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
            c.system_key AS systemKey, c.parent_id AS parentId, p.name AS parentName, p.system_key AS parentSystemKey,
            MAX(c.parent_id IS NOT NULL OR EXISTS(SELECT 1 FROM catledger_categories child WHERE child.uid = c.uid AND child.parent_id = c.category_id)) AS hasChildren,
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
       LEFT JOIN catledger_categories p ON p.uid = c.uid AND p.category_id = c.parent_id
      WHERE t.uid = ?
        AND t.occurred_local_date >= ? AND t.occurred_local_date < ?
        AND t.deleted_at IS NULL
        AND t.type IN ('expense', 'income', 'refund')
      GROUP BY CASE WHEN t.type = 'refund' THEN 'expense' ELSE t.type END,
               COALESCE(t.category_id, original.category_id), c.name, c.system_key, c.parent_id, p.name, p.system_key
     HAVING amountMinor <> 0
      ORDER BY type, amountMinor DESC, categoryId`,
    [uid, range.startDate, range.endDate]
  )
  const totals = {
    expense: BigInt(summary.expenseMinor),
    income: BigInt(summary.incomeMinor)
  }
  return {
    expenseCategories: rollupCategories(rows.filter(row => row.type === 'expense'), totals.expense),
    incomeCategories: rollupCategories(rows.filter(row => row.type === 'income'), totals.income)
  }
}

function rollupCategories(rows, total) {
  const groups = new Map()
  for (const row of rows) {
    const id = row.parentId || row.categoryId || null
    const amount = BigInt(minorUnitsToString(row.amountMinor))
    const group = groups.get(id) || { categoryId: id, name: row.parentId ? row.parentName : row.categoryName,
      systemKey: row.parentId ? row.parentSystemKey : row.systemKey, amountMinor: '0', children: [], hasChildren: false }
    group.amountMinor = (BigInt(group.amountMinor) + amount).toString()
    group.hasChildren = group.hasChildren || Number(row.hasChildren) === 1 || Boolean(row.parentId)
    group.children.push({ categoryId: row.categoryId, systemKey: row.systemKey || null,
      name: row.parentId ? row.categoryName : '未细分', direct: !row.parentId, amountMinor: amount.toString() })
    groups.set(id, group)
  }
  const compare = (a, b) => BigInt(a.amountMinor) === BigInt(b.amountMinor) ? String(a.categoryId).localeCompare(String(b.categoryId)) : BigInt(a.amountMinor) > BigInt(b.amountMinor) ? -1 : 1
  return [...groups.values()].sort(compare).map(group => ({
    categoryId: group.categoryId, name: group.name, systemKey: group.systemKey || null, amountMinor: group.amountMinor,
    shareBasisPoints: basisPoints(BigInt(group.amountMinor) > 0n ? BigInt(group.amountMinor) : 0n, total),
    children: group.hasChildren ? group.children.sort(compare) : []
  }))
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

function monthSequence(month, count = 12) {
  parseMonth(month)
  const [year, monthNumber] = month.split('-').map(Number)
  const values = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const cursor = new Date(Date.UTC(year, monthNumber - 1 - offset, 1))
    values.push(`${String(cursor.getUTCFullYear()).padStart(4, '0')}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return values
}

// 两个 'YYYY-MM' 之间的月数（含首含尾）。
function monthsBetween(fromMonth, toMonth) {
  const [fy, fm] = fromMonth.split('-').map(Number)
  const [ty, tm] = toMonth.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm) + 1
}

// 该用户最早一笔有效收支/退款所在的月份（'YYYY-MM'），无数据返回 null。
async function earliestTransactionMonth(connection, uid) {
  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(MIN(occurred_local_date), '%Y-%m') AS earliestMonth
       FROM catledger_transactions
      WHERE uid = ? AND deleted_at IS NULL AND type IN ('income', 'expense', 'refund')`,
    [uid]
  )
  return rows[0] && rows[0].earliestMonth ? String(rows[0].earliestMonth) : null
}

// 自适应窗口：从「最早有数据月 → 结束月」的月数，夹在 [min, max]（默认 6~12）。
// 数据不足 min 时补空到 min，避免柱子挤在角落；超过 max 时只取最近 max 个月。
// 最早月晚于结束月（或没数据）时取 min 个月。
function adaptiveWindowCount(earliestMonth, endMonth, min = 6, max = 12) {
  if (!earliestMonth) return min
  const span = monthsBetween(earliestMonth, endMonth)
  if (!Number.isFinite(span) || span <= 0) return min
  return Math.max(min, Math.min(max, span))
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

// 环比（上月）/ 同比（去年同月）对比：从趋势序列按月份取值，点缺失即视为无数据（不当作 0）。
// 只返回选中月份能取到的对比项；源月不在趋势窗口或为「空月」时返回 null，页面不显示该项，避免显示假 0%。
function shiftMonthKey(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number)
  const cursor = new Date(Date.UTC(year, monthNumber - 1 + delta, 1))
  return `${String(cursor.getUTCFullYear()).padStart(4, '0')}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`
}

function comparisonOf(current, previous) {
  if (!previous) return null
  const currentExpense = BigInt(current.expenseMinor)
  const previousExpense = BigInt(previous.expenseMinor)
  const currentIncome = BigInt(current.incomeMinor)
  const previousIncome = BigInt(previous.incomeMinor)
  // 差值为分（当前 − 对比基期），前端按符号决定涨/降文案；基期为 0 时百分比无法有意义，ratePpm 记 null。
  const expenseDelta = currentExpense - previousExpense
  const incomeDelta = currentIncome - previousIncome
  return {
    month: previous.month,
    expense: {
      deltaMinor: expenseDelta.toString(),
      ratePpm: previousExpense > 0n ? Number((expenseDelta * 1000000n) / previousExpense) : null
    },
    income: {
      deltaMinor: incomeDelta.toString(),
      ratePpm: previousIncome > 0n ? Number((incomeDelta * 1000000n) / previousIncome) : null
    }
  }
}

function buildComparisons(cashFlowTrend, month) {
  const byMonth = new Map((cashFlowTrend || []).map(row => [row.month, row]))
  const current = byMonth.get(month)
  if (!current) return { previousMonth: null, lastYearMonth: null }
  return {
    previousMonth: comparisonOf(current, byMonth.get(shiftMonthKey(month, -1))),
    lastYearMonth: comparisonOf(current, byMonth.get(shiftMonthKey(month, -12)))
  }
}

// 分类环比：以本月「大类」聚合为骨架，对齐上月同一 categoryId（含未分类 null）的支出，
// 产出每类 previousMinor / deltaMinor / ratePpm；上月无此分类 previousMinor=0、ratePpm=null。
// 只对支出侧做（收入分类排行不需要环比噪音），与 buildComparisons 的百万分率口径一致。
function buildCategoryComparisons(currentCategories, previousCategories) {
  const previous = new Map()
  for (const row of previousCategories || []) previous.set(row.categoryId == null ? '' : String(row.categoryId), BigInt(row.amountMinor))
  const result = {}
  for (const row of currentCategories || []) {
    const key = row.categoryId == null ? '' : String(row.categoryId)
    const currentMinor = BigInt(row.amountMinor)
    const previousMinor = previous.get(key) || 0n
    const delta = currentMinor - previousMinor
    result[key] = {
      categoryId: row.categoryId == null ? null : row.categoryId,
      previousMinor: previousMinor.toString(),
      deltaMinor: delta.toString(),
      ratePpm: previousMinor > 0n ? Number((delta * 1000000n) / previousMinor) : null
    }
  }
  return result
}

async function queryMonthlyCashFlowTrend(connection, uid, month, count = 12) {
  // count='auto' 时按最早有数据月自适应（6~12 格），否则用固定月数。
  const resolvedCount = count === 'auto'
    ? adaptiveWindowCount(await earliestTransactionMonth(connection, uid), month)
    : count
  const months = monthSequence(month, resolvedCount)
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

// 净资产口径见 net-worth.js（唯一真源）：只算未归档账户，资产取 bookBalance、负债取 debtMinor。
// dashboard 直接把三份合计一起返回，前端两页不再各自累加。
const { accountTotals, netWorthTotals } = require('./net-worth')
function netWorthOf(accounts) {
  return BigInt(netWorthTotals(accounts).netWorthMinor)
}

function createReportingService({ getPool }) {
  async function dashboard(context) {
    const summaryScope = context.data && context.data.summaryScope != null ? context.data.summaryScope : 'month'
    if (!['month', 'all'].includes(summaryScope)) throw ledgerError('VALIDATION_ERROR')
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
        const cashFlowTrend = await queryMonthlyCashFlowTrend(connection, uid, month, 'auto')
        const summary = summaryScope === 'all'
          ? await queryMonthlySummary(connection, uid, null)
          : summaryFromTrend(cashFlowTrend, month)
        const totals = accountTotals(accounts)
        return {
          month,
          summaryScope,
          totals,
          // 兼容旧消费者：平铺三项仍返回，但一律由 totals 派生，不再单独计算。
          netWorthMinor: totals.netWorthMinor,
          assetsMinor: totals.assetsMinor,
          liabilitiesMinor: totals.liabilitiesMinor,
          liabilitiesInterestMinor: totals.liabilitiesInterestMinor,
          summary,
          cashFlowTrend,
          accounts,
          liabilitySettingsVersion: 1,
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
        const trendEndMonth = context.data && context.data.trendEndMonth !== undefined ? context.data.trendEndMonth : month
        parseMonth(trendEndMonth)
        const range = parseMonth(month)
        const summary = await queryMonthlySummary(connection, uid, range)
        const categories = await queryCategoryStatistics(connection, uid, range, summary)
        // 上月分类聚合（仅供支出分类环比；单独一次查询，口径与本月同）。
        const previousMonth = shiftMonthKey(month, -1)
        const previousRange = parseMonth(previousMonth)
        const previousSummary = await queryMonthlySummary(connection, uid, previousRange)
        const previousCategories = await queryCategoryStatistics(connection, uid, previousRange, previousSummary)
        const daily = await queryDailyStatistics(connection, uid, range)
        // 图表只展示近 6 个月；同比需要「去年同月」，故单独用 13 个月窗口算对比，不为图表多带数据。
        const cashFlowTrend = await queryMonthlyCashFlowTrend(connection, uid, trendEndMonth, 'auto')
        const comparisonTrend = await queryMonthlyCashFlowTrend(connection, uid, trendEndMonth, 13)
        const quality = await queryStatisticsMetrics(connection, uid, range)
        // 负债占比与分期利息是「当前时点」数据，与所选月份无关；口径见 liability-summary.js。
        const accounts = await listAccountsForUser(connection, uid)
        const { paidInterestByAccount } = require('./installment-service')
        const paidInterest = await paidInterestByAccount(connection, uid)
        // 合计走 accountTotals（与首页/账户页同一真源），负债率由同一函数派生；还款压力复用贷款域纯查询。
        const totals = accountTotals(accounts)
        // 本月待还跟随所选月(month)；未来12个月锚定真实当月(trendEndMonth)，不受选择器影响。
        const { repaymentPressureQuery } = require('./home-alerts')
        const repaymentPressure = await repaymentPressureQuery(connection, uid, month, 12, trendEndMonth)
        const liabilityBase = require('./liability-summary').liabilitySummary(accounts, paidInterest).liabilities
        const liabilities = Object.assign({}, liabilityBase, {
          // 合计与负债率：来自 accountTotals 唯一真源，不在此重算。
          debtTotalMinor: totals.liabilitiesMinor,
          interestTotalMinor: totals.liabilitiesInterestMinor,
          liabilitiesRatioBasisPoints: totals.liabilitiesRatioBasisPoints,
          repaymentPressure
        })
        return {
          month,
          trendEndMonth,
          summary,
          liabilities,
          comparisons: buildComparisons(comparisonTrend, month),
          categoryComparisons: { expense: buildCategoryComparisons(categories.expenseCategories, previousCategories.expenseCategories) },
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

module.exports = { createReportingService, monthSequence, summaryFromTrend, netWorthOf, buildComparisons, buildCategoryComparisons, adaptiveWindowCount }

module.exports.rollupCategories = rollupCategories
