// 同一快照/用户锁内分块读取完整依赖；不为每一期重复往返数据库。
async function grouped(c, uid, ids, sql, key, repeats = 1) {
  const result = new Map()
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200), marks = batch.map(() => '?').join(',')
    const [rows] = await c.execute(sql.replaceAll('$ids', marks), Array.from({ length: repeats }, () => [uid, ...batch]).flat())
    for (const row of rows) {
      if (!result.has(row[key])) result.set(row[key], [])
      result.get(row[key]).push(row)
    }
  }
  return id => result.get(id) || []
}
async function load(c, uid, payments, transactions) {
  const paymentIds = payments.map(p => p.paymentId), ids = transactions.map(t => t.transactionId)
  const allocations = await grouped(c, uid, paymentIds, `SELECT payment_id AS paymentId,loan_id AS loanId,
    principal_minor AS principalMinor,interest_minor AS interestMinor,fee_minor AS feeMinor
    FROM catledger_loan_payment_allocations WHERE uid=? AND payment_id IN ($ids) ORDER BY payment_id,loan_id`, 'paymentId')
  const links = await grouped(c, uid, paymentIds, `SELECT payment_id AS paymentId,transaction_id AS transactionId,transaction_version AS version
    FROM catledger_loan_payment_transactions WHERE uid=? AND payment_id IN ($ids) AND active=1 ORDER BY payment_id,transaction_id`, 'paymentId')
  const coverage = await grouped(c, uid, paymentIds, `SELECT a.payment_id AS paymentId,a.charge_id AS chargeId,a.amount_minor AS amountMinor,
    a.historical_replaced_minor AS historicalReplacedMinor,k.loan_id AS loanId
    FROM catledger_loan_charge_allocations a JOIN catledger_loan_charges f ON f.uid=a.uid AND f.charge_id=a.charge_id
    JOIN catledger_loan_charge_contracts k ON k.uid=f.uid AND k.contract_id=f.contract_id
    WHERE a.uid=? AND a.payment_id IN ($ids) ORDER BY a.payment_id,a.charge_id`, 'paymentId')
  const periods = await grouped(c, uid, paymentIds, `SELECT payment_id AS paymentId,period_id AS periodId,loan_id AS loanId,
    principal_minor AS principalMinor,historical_principal_minor AS historicalPrincipalMinor,interest_minor AS interestMinor,fee_minor AS feeMinor
    FROM catledger_loan_period_allocations WHERE uid=? AND payment_id IN ($ids) AND active=1 ORDER BY payment_id,period_id`, 'paymentId')
  const paymentSources = await grouped(c, uid, paymentIds, `SELECT payment_id AS paymentId,event_id AS eventId,applied_event_version AS version
    FROM catledger_loan_payment_sources WHERE uid=? AND payment_id IN ($ids) AND active=1 ORDER BY payment_id`, 'paymentId')
  const sources = await grouped(c, uid, ids, `SELECT r.transaction_id AS transactionId,r.link_id AS linkId,r.transaction_version AS version,
    r.role,e.event_id AS eventId,e.version AS eventVersion,e.status,u.status AS updateStatus,u.version AS updateVersion
    FROM catledger_economic_event_transactions r JOIN catledger_economic_events e ON e.uid=r.uid AND e.event_id=r.event_id
    JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id
    WHERE r.uid=? AND r.transaction_id IN ($ids) AND r.superseded_at IS NULL AND r.role<>'refund_original' ORDER BY r.link_id`, 'transactionId')
  const uses = await grouped(c, uid, ids, `SELECT r.transaction_id AS transactionId,'payment' AS kind,p.payment_id AS id,a.loan_id AS loanId
    FROM catledger_loan_payment_transactions r JOIN catledger_loan_payments p ON p.uid=r.uid AND p.payment_id=r.payment_id AND p.status='active'
    LEFT JOIN catledger_loan_payment_allocations a ON a.uid=p.uid AND a.payment_id=p.payment_id
    WHERE r.uid=? AND r.transaction_id IN ($ids) AND r.active=1
    UNION ALL SELECT transaction_id,'item',item_id,loan_id FROM catledger_installment_items
    WHERE uid=? AND transaction_id IN ($ids) AND active=1 AND loan_id IS NOT NULL
    UNION ALL SELECT f.transaction_id,'charge',f.charge_id,k.loan_id FROM catledger_loan_charges f
    JOIN catledger_loan_charge_contracts k ON k.uid=f.uid AND k.contract_id=f.contract_id WHERE f.uid=? AND f.transaction_id IN ($ids)
    UNION ALL SELECT f.balance_adjustment_id,'charge',f.charge_id,k.loan_id FROM catledger_loan_charges f
    JOIN catledger_loan_charge_contracts k ON k.uid=f.uid AND k.contract_id=f.contract_id WHERE f.uid=? AND f.balance_adjustment_id IN ($ids)
    ORDER BY transactionId,kind,id,loanId`, 'transactionId', 4)
  const refunds = await grouped(c, uid, ids, `SELECT original_transaction_id AS originalId,transaction_id AS id,version
    FROM catledger_transactions WHERE uid=? AND original_transaction_id IN ($ids) AND deleted_at IS NULL ORDER BY transaction_id`, 'originalId')
  for (const p of payments) Object.assign(p, { allocations: allocations(p.paymentId), links: links(p.paymentId), coverage: coverage(p.paymentId),
    periods: periods(p.paymentId), sources: paymentSources(p.paymentId) })
  return { sources, uses, refunds }
}
module.exports = { load }
