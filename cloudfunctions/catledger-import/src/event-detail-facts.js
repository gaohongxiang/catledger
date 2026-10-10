// 单笔详情的只读补充。调用者已核实 uid/update/event 和视图版本，并持有一致性快照。
// 不修改事件、关系、账户或贷款；原始账单仍通过既有 evidence 分段接口读取。
async function eventDetailFacts(connection, uid, updateId, event) {
  const fields = event.fieldSources || {}, payment = fields.paymentResolution || {}
  const ids = [...new Set([event.ledgerAccountId, event.counterpartyLedgerAccountId]
    .concat((payment.allocations || []).map(item => item.accountId),
      (fields.repaymentAllocations || []).map(item => item.accountId),
      (fields.editorOverrides?.incompleteComposition?.parts || []).map(item => item.accountId)).filter(Boolean))]
  const accounts = []
  if (ids.length) {
    const marks = ids.map(() => '?').join(',')
    const [rows] = await connection.execute(`SELECT account_id AS accountId,name,type,currency,archived_at AS archivedAt
      FROM catledger_accounts WHERE uid=? AND account_id IN (${marks})
      UNION ALL SELECT draft_account_id AS accountId,name,type,currency,NULL AS archivedAt
      FROM catledger_finance_update_account_drafts WHERE uid=? AND update_id=? AND materialized_at IS NULL
        AND draft_account_id IN (${marks})`, [uid, ...ids, uid, updateId, ...ids])
    accounts.push(...rows)
  }
  let refund = null
  if (event.economicNature === 'refund') {
    const [batch] = await connection.execute(`SELECT r.target_event_id AS eventId,e.event_local_at AS localAt,
      e.amount_minor AS amountMinor,c.name AS categoryName,p.name AS parentCategoryName
      FROM catledger_economic_event_relations r JOIN catledger_economic_events e
        ON e.uid=r.uid AND e.update_id=r.update_id AND e.event_id=r.target_event_id
      LEFT JOIN catledger_categories c ON c.uid=e.uid AND c.category_id=e.category_id
      LEFT JOIN catledger_categories p ON p.uid=c.uid AND p.category_id=c.parent_id
      WHERE r.uid=? AND r.update_id=? AND r.source_event_id=? AND r.relation_type='refund_of'
        AND r.status='confirmed' ORDER BY r.relation_id LIMIT 2`, [uid, updateId, event.eventId])
    const [history] = await connection.execute(`SELECT t.transaction_id AS transactionId,t.occurred_local_at AS localAt,
      t.amount_minor AS amountMinor,LEFT(t.note,160) AS note,c.name AS categoryName,p.name AS parentCategoryName
      FROM catledger_economic_event_transactions l JOIN catledger_transactions t
        ON t.uid=l.uid AND t.transaction_id=l.transaction_id AND t.deleted_at IS NULL
      LEFT JOIN catledger_categories c ON c.uid=t.uid AND c.category_id=t.category_id
      LEFT JOIN catledger_categories p ON p.uid=c.uid AND p.category_id=c.parent_id
      WHERE l.uid=? AND l.update_id=? AND l.event_id=? AND l.role='refund_original'
        AND l.superseded_at IS NULL ORDER BY l.link_id LIMIT 2`, [uid, updateId, event.eventId])
    const originals = batch.concat(history).map(row => ({ ...row, amountMinor: String(row.amountMinor),
      categoryName: [row.parentCategoryName, row.categoryName].filter(Boolean).join(' / ') }))
    const pending = fields.refundRelation && fields.refundRelation.version === 'refund-relation-state-v1' && fields.refundRelation.status === 'pending' && fields.refundRelation.confirmedBy === 'user'
    refund = { status: originals.length > 1 ? 'ambiguous' : originals.length === 1 ? 'confirmed' : pending ? 'pending' : 'unlinked', originals }
  }
  const repayment = fields.loanRepayment
  let loan = null
  if (repayment && repayment.mode === 'associate' && repayment.loanId) {
    const [[row]] = await connection.execute('SELECT loan_id AS loanId,name FROM catledger_loans WHERE uid=? AND loan_id=?', [uid, repayment.loanId])
    loan = row || null
  }
  const categories = []
  const repaymentFacts = { ...(repayment || {}), ...(fields.editorOverrides?.incompleteRepayment || {}) }
  const categoryIds = [...new Set([event.categoryId, repaymentFacts.interestCategoryId, repaymentFacts.feeCategoryId].filter(Boolean))]
  if (categoryIds.length) {
    const [rows] = await connection.execute(`SELECT category_id AS categoryId,name,kind,archived_at AS archivedAt FROM catledger_categories
      WHERE uid=? AND category_id IN (${categoryIds.map(() => '?').join(',')})`, [uid, ...categoryIds])
    categories.push(...rows)
  }
  return { version: 1, accounts, categories, refund, loan }
}
module.exports = { eventDetailFacts }
