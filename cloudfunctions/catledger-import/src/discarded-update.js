// 仅由持有批次写锁、已将状态改为 abandoned 的事务调用。
// 删除派生整理数据，来源行、正式账本、批次摘要与动作审计继续保留。
const DRAFT_TABLES = Object.freeze([
  'catledger_finance_update_account_mapping_drafts',
  'catledger_finance_update_account_drafts',
  'catledger_review_issue_members',
  'catledger_review_issues',
  'catledger_economic_event_relations',
  'catledger_economic_event_transactions',
  'catledger_event_evidence',
  'catledger_economic_events'
])

async function discardUpdateGraph(connection, uid, updateId) {
  const [[update]] = await connection.execute(
    'SELECT status FROM catledger_finance_updates WHERE uid = ? AND update_id = ? FOR UPDATE',
    [uid, updateId]
  )
  if (!update || update.status !== 'abandoned') throw new Error('Draft cleanup requires an abandoned update')
  for (const table of DRAFT_TABLES) {
    await connection.execute(`DELETE FROM ${table} WHERE uid = ? AND update_id = ?`, [uid, updateId])
  }
}

module.exports = { discardUpdateGraph, DRAFT_TABLES }
