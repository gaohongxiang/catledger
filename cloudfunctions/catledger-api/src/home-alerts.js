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

function createHomeAlertsService({ getPool }) {
  const read = (context, operation) => executeLedgerRead({ getPool, ...context, consistentSnapshot: true, operation })
  return {
    // 只读聚合，供首页提醒行使用；月份由客户端按设备本地时区给出，与 dashboard 同一口径。
    dueThisMonth(context) {
      const month = (context.data || {}).month
      const range = parseMonth(month)
      return read(context, async (connection, uid) => {
        const [[row]] = await connection.execute(DUE_THIS_MONTH_SQL, [uid, range.startDate, range.endDate])
        return {
          month,
          periodCount: Number(row && row.periodCount) || 0,
          dueMinor: String((row && row.dueMinor) == null ? '0' : row.dueMinor)
        }
      })
    }
  }
}

module.exports = { createHomeAlertsService, DUE_THIS_MONTH_SQL }
