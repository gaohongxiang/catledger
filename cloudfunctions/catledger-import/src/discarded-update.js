// 仅由持有批次写锁、已将状态改为 abandoned 的事务调用。
// 删除派生整理数据，来源行、正式账本、批次摘要与动作审计继续保留。
const DRAFT_TABLES = Object.freeze([
  'catledger_import_review_objects',
  'catledger_finance_update_account_mapping_drafts',
  'catledger_finance_update_account_drafts',
  'catledger_review_issue_members',
  'catledger_review_issues',
  'catledger_economic_event_relations',
  'catledger_economic_event_transactions',
  'catledger_event_evidence',
  'catledger_economic_events'
])

// 只注销本批创建且仍未使用/修改的计划；初始期次和审计保留，不授予导入函数删除计划的权限。
async function discardPlans(connection, uid, loanIds, updateId) {
  for (const loanId of loanIds) {
    const [[loan]] = await connection.execute(
      `SELECT l.loan_id AS loanId FROM catledger_loans l
        WHERE l.uid = ? AND l.loan_id = ? AND l.version = 1 AND l.deleted_at IS NULL AND l.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM catledger_economic_events e JOIN catledger_finance_updates u
            ON u.uid=e.uid AND u.update_id=e.update_id WHERE e.uid=l.uid AND e.update_id<>? AND u.status<>'abandoned'
            AND JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.installmentPlan.loanId'))=l.loan_id)
          AND NOT EXISTS (SELECT 1 FROM catledger_installment_items i WHERE i.uid = l.uid AND i.loan_id = l.loan_id)
          AND NOT EXISTS (SELECT 1 FROM catledger_installment_bindings b WHERE b.uid = l.uid AND b.loan_id = l.loan_id)
          AND NOT EXISTS (SELECT 1 FROM catledger_loan_payment_allocations a WHERE a.uid = l.uid AND a.loan_id = l.loan_id)
          AND NOT EXISTS (SELECT 1 FROM catledger_loan_period_allocations a WHERE a.uid = l.uid AND a.loan_id = l.loan_id)
          AND NOT EXISTS (SELECT 1 FROM catledger_loan_charge_contracts c WHERE c.uid = l.uid AND c.loan_id = l.loan_id)
          AND NOT EXISTS (SELECT 1 FROM catledger_loan_period_revisions r JOIN catledger_loan_periods p
            ON p.uid = r.uid AND p.period_id = r.period_id WHERE p.uid = l.uid AND p.loan_id = l.loan_id AND r.version>1)
          AND NOT EXISTS (SELECT 1 FROM catledger_loan_periods p WHERE p.uid=l.uid AND p.loan_id=l.loan_id AND p.version>1)
        FOR UPDATE`, [uid, loanId, updateId])
    if (!loan) continue
    await connection.execute('UPDATE catledger_loan_periods SET cancelled=1,version=version+1 WHERE uid = ? AND loan_id = ?', [uid, loanId])
    await connection.execute(`UPDATE catledger_loans SET deleted_at=CURRENT_TIMESTAMP(3),archived_at=CURRENT_TIMESTAMP(3),
      version=version+1 WHERE uid = ? AND loan_id = ?`, [uid, loanId])
  }
}

// 本机保存事件前就可能中断，因此直接读经过服务端校验的创建回执；不信任客户端 planIds。
// 旧版本没有来源回执的计划保留，不能据一次草稿决定推断它是临时计划。
async function discardCreatedPlans(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.loanId')) AS loanId FROM catledger_mutation_receipts
      WHERE uid=? AND action='loans.create'
        AND JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.importOrigin.updateId'))=?`,
    [uid, updateId]
  )
  await discardPlans(connection, uid, new Set(rows.map(row => row.loanId).filter(Boolean)), updateId)
}

async function discardUpdateGraph(connection, uid, updateId, { planIds = [] } = {}) {
  const [[update]] = await connection.execute(
    'SELECT status FROM catledger_finance_updates WHERE uid = ? AND update_id = ? FOR UPDATE',
    [uid, updateId]
  )
  if (!update || update.status !== 'abandoned') throw new Error('Draft cleanup requires an abandoned update')
  await discardCreatedPlans(connection, uid, updateId, planIds)
  for (const table of DRAFT_TABLES) {
    await connection.execute(`DELETE FROM ${table} WHERE uid = ? AND update_id = ?`, [uid, updateId])
  }
}

module.exports = { discardUpdateGraph, discardCreatedPlans, discardPlans, DRAFT_TABLES }
