// 首页「待核对 N 笔」：导入工作台「待核对」页签里的交易条数，跨本次未完成的所有导入批次统计。
// 口径直接复用工作台的判定（activeSql + pendingReviewSql），不另写一套，页签里看到几条这里就是几。
const { executeUserRead } = require('./import-transaction')
const { activeSql, pendingReviewSql } = require('./finance-update-read')

// 「还没结果的更新」。已入账(posted)、已撤销(undone)、已放弃(abandoned) 都不再等用户核对；
// 这里与 assertBatchesAvailable 对「活着的更新」的定义保持一致。
const IN_FLIGHT_UPDATE_SQL = "u.status IN ('draft', 'failed', 'review', 'posting')"

function createFinanceUpdatePending({ getPool }) {
  return context => executeUserRead({
    getPool,
    ...context,
    consistentSnapshot: true,
    operation: async (connection, uid) => {
      const [[row]] = await connection.execute(
        `SELECT COUNT(*) AS count
           FROM catledger_economic_events e
           JOIN catledger_finance_updates u ON u.uid = e.uid AND u.update_id = e.update_id
          WHERE e.uid = ? AND ${IN_FLIGHT_UPDATE_SQL} AND ${activeSql} AND ${pendingReviewSql}`,
        [uid]
      )
      return { count: Number(row && row.count) || 0 }
    }
  })
}

module.exports = { createFinanceUpdatePending, IN_FLIGHT_UPDATE_SQL }
