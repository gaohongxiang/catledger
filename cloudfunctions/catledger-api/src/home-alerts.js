const { executeLedgerRead } = require('./ledger-read')
const { parseMonth } = require('./local-time')

// 本月待还：当月到期、未取消、贷款未归档删除的期次里，还没还完的那些。
// 已还部分按有效还款分摊（a.active=1 且付款 p.status='active'）扣掉，只报未还金额；
// 已结清的期次 outstanding 为 0，不进笔数也不进金额。
const DUE_THIS_MONTH_SQL = `
  SELECT COUNT(*) AS periodCount, COALESCE(SUM(x.outstanding), 0) AS dueMinor
    FROM (
      SELECT t.principal_minor + t.interest_minor + t.fee_minor
             - COALESCE((SELECT SUM(a.principal_minor + a.interest_minor + a.fee_minor)
                           FROM catledger_loan_period_allocations a
                           JOIN catledger_loan_payments p
                             ON p.uid = a.uid AND p.payment_id = a.payment_id AND p.status = 'active'
                          WHERE a.uid = t.uid AND a.period_id = t.period_id AND a.active = 1), 0) AS outstanding
        FROM catledger_loan_periods t
        JOIN catledger_loans l ON l.uid = t.uid AND l.loan_id = t.loan_id
       WHERE t.uid = ? AND t.cancelled = 0 AND l.archived_at IS NULL AND l.deleted_at IS NULL
         AND t.due_date >= ? AND t.due_date < ?
    ) x
   WHERE x.outstanding > 0`

// 本月待还明细：每期一条，含贷款名、账户名、期号、到期日与扣除已还后的未还金额。
const DUE_DETAIL_SQL = `
  SELECT t.loan_id AS loanId, l.name AS loanName, a.name AS accountName, t.period_number AS periodNumber, t.due_date AS dueDate,
         (t.principal_minor + t.interest_minor + t.fee_minor
           - COALESCE((SELECT SUM(pa.principal_minor + pa.interest_minor + pa.fee_minor)
                         FROM catledger_loan_period_allocations pa
                         JOIN catledger_loan_payments p2 ON p2.uid = pa.uid AND p2.payment_id = pa.payment_id AND p2.status = 'active'
                        WHERE pa.uid = t.uid AND pa.period_id = t.period_id AND pa.active = 1), 0)) AS outstanding
    FROM catledger_loan_periods t
    JOIN catledger_loans l ON l.uid = t.uid AND l.loan_id = t.loan_id
    LEFT JOIN catledger_accounts a ON a.uid = l.uid AND a.account_id = l.account_id
   WHERE t.uid = ? AND t.cancelled = 0 AND l.archived_at IS NULL AND l.deleted_at IS NULL
     AND t.due_date >= ? AND t.due_date < ?
   HAVING outstanding > 0
   ORDER BY t.due_date, t.period_id`

// 未来 months 个月（含本月）到期、未取消、未归档贷款的未还本息费合计。
// 与本月待还同口径（同一扣减有效还款的子查询），只是到期日范围放宽——供统计页「还款压力」用。
const UPCOMING_TOTAL_SQL = `
  SELECT COUNT(*) AS periodCount, COALESCE(SUM(x.outstanding), 0) AS dueMinor
    FROM (
      SELECT t.principal_minor + t.interest_minor + t.fee_minor
             - COALESCE((SELECT SUM(a.principal_minor + a.interest_minor + a.fee_minor)
                           FROM catledger_loan_period_allocations a
                           JOIN catledger_loan_payments p
                             ON p.uid = a.uid AND p.payment_id = a.payment_id AND p.status = 'active'
                          WHERE a.uid = t.uid AND a.period_id = t.period_id AND a.active = 1), 0) AS outstanding
        FROM catledger_loan_periods t
        JOIN catledger_loans l ON l.uid = t.uid AND l.loan_id = t.loan_id
       WHERE t.uid = ? AND t.cancelled = 0 AND l.archived_at IS NULL AND l.deleted_at IS NULL
         AND t.due_date >= ? AND t.due_date < ?
    ) x
   WHERE x.outstanding > 0`

// 还款压力查询
async function repaymentPressureQuery(connection, uid, month, months = 12, fromMonth) {
  // month：本月待还的口径月（跟随所选月）；fromMonth：未来窗口起点月（默认=month）。
  // 统计页传 fromMonth=真实当月，让「未来12个月」锚定当前时点，不受月份选择器影响。
  const range = parseMonth(month)
  const windowStart = fromMonth || month
  const [y, m] = windowStart.split('-').map(Number)
  const endCursor = new Date(Date.UTC(y, m - 1 + months - 1, 1))
  const endMonth = `${String(endCursor.getUTCFullYear()).padStart(4, '0')}-${String(endCursor.getUTCMonth() + 1).padStart(2, '0')}`
  const endRange = parseMonth(endMonth)
  const windowStartRange = parseMonth(windowStart)
  const [[monthRow]] = await connection.execute(DUE_THIS_MONTH_SQL, [uid, range.startDate, range.endDate])
  // 未来窗口下界用 windowStart 的月初（不是所选月的），否则选了推后的月会漏掉真实当月及之前。
  const [[upcomingRow]] = await connection.execute(UPCOMING_TOTAL_SQL, [uid, windowStartRange.startDate, endRange.endDate])
  return {
    month, months, windowStartMonth: windowStart,
    monthDueMinor: String((monthRow && monthRow.dueMinor) == null ? '0' : monthRow.dueMinor),
    monthPeriodCount: Number(monthRow && monthRow.periodCount) || 0,
    upcomingMinor: String((upcomingRow && upcomingRow.dueMinor) == null ? '0' : upcomingRow.dueMinor),
    upcomingPeriodCount: Number(upcomingRow && upcomingRow.periodCount) || 0
  }
}

function createHomeAlertsService({ getPool }) {
  const read = (context, operation) => executeLedgerRead({ getPool, ...context, consistentSnapshot: true, operation })
  return {
    // 只读聚合，供首页提醒行使用；月份由客户端按设备本地时区给出，与 dashboard 同一口径。
    // 同时返回 items 明细（每期一条：贷款名、期号、到期日、未还金额、loanId），供「本月待还」明细页使用。
    dueThisMonth(context) {
      const month = (context.data || {}).month
      const range = parseMonth(month)
      return read(context, async (connection, uid) => {
        const [[row]] = await connection.execute(DUE_THIS_MONTH_SQL, [uid, range.startDate, range.endDate])
        const [detailRows] = await connection.execute(DUE_DETAIL_SQL, [uid, range.startDate, range.endDate])
        return {
          month,
          periodCount: Number(row && row.periodCount) || 0,
          dueMinor: String((row && row.dueMinor) == null ? '0' : row.dueMinor),
          items: detailRows.map(r => ({ loanId: r.loanId, loanName: r.loanName, accountName: r.accountName,
            periodNumber: Number(r.periodNumber), dueDate: r.dueDate, outstandingMinor: String(r.outstanding == null ? '0' : r.outstanding) }))
        }
      })
    },

    // 还款压力（统计页用）：本月待还 + 未来 months 个月（默认 12）未还本息费合计。
    // 与本月待还/贷款页同口径，避免第三套算法；返回 { monthDueMinor, monthPeriodCount, upcomingMinor, upcomingPeriodCount, months }。
    repaymentPressure(context) {
      const month = (context.data || {}).month
      const months = (context.data || {}).months || 12
      return read(context, (connection, uid) => repaymentPressureQuery(connection, uid, month, months))
    }
  }
}

module.exports = { createHomeAlertsService, repaymentPressureQuery, DUE_THIS_MONTH_SQL }
