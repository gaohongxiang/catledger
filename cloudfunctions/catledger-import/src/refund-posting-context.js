const { assertNoLoanTransactions } = require('./loan-transaction-guard')
const { chunks } = require('./sql-batch')
const { importError } = require('./errors')
const { hasPendingRefundRelation } = require('./organizer-model')

// 调用方已经持有用户写锁，并在本事务中落下本批原消费。读取一次历史累计，再逐项消耗。
async function loadRefundPostingContext(connection, uid, updateId, eventIds) {
  const direct = new Map(), related = new Map()
  for (const part of chunks(eventIds.map(id => [id]))) {
    const placeholders = part.map(() => '?').join(','), values = [uid, updateId, ...part.flat()]
    const [links] = await connection.execute(`SELECT event_id AS eventId, transaction_id AS transactionId
      FROM catledger_economic_event_transactions WHERE uid=? AND update_id=? AND event_id IN (${placeholders}) AND role='refund_original'`, values)
    links.forEach(row => { if (!direct.has(row.eventId)) direct.set(row.eventId, row.transactionId) })
    const [relations] = await connection.execute(`SELECT r.source_event_id AS eventId, t.transaction_id AS transactionId
      FROM catledger_economic_event_relations r JOIN catledger_economic_event_transactions t
        ON t.uid=r.uid AND t.update_id=r.update_id AND t.event_id=r.target_event_id
      WHERE r.uid=? AND r.update_id=? AND r.source_event_id IN (${placeholders}) AND r.relation_type='refund_of'
        AND r.status='confirmed' AND t.role IN ('primary','historical_primary')`, values)
    relations.forEach(row => { if (!related.has(row.eventId)) related.set(row.eventId, row.transactionId) })
  }
  const originals = new Map(), amounts = new Map()
  const ids = [...new Set([...direct.values(), ...related.values()])].sort()
  await assertNoLoanTransactions(connection, uid, ids)
  for (const part of chunks(ids.map(id => [id]))) {
    const placeholders = part.map(() => '?').join(','), values = [uid, ...part.flat()]
    const [rows] = await connection.execute(`SELECT transaction_id AS transactionId,amount_minor AS amountMinor,
      occurred_at_utc AS utcAt,category_id AS categoryId FROM catledger_transactions
      WHERE uid=? AND transaction_id IN (${placeholders}) AND type='expense' AND deleted_at IS NULL ORDER BY transaction_id FOR UPDATE`, values)
    rows.forEach(row => originals.set(row.transactionId, row))
    const [totals] = await connection.execute(`SELECT original_transaction_id AS transactionId,SUM(amount_minor) AS amount
      FROM catledger_transactions WHERE uid=? AND original_transaction_id IN (${placeholders}) AND type='refund'
        AND deleted_at IS NULL GROUP BY original_transaction_id`, values)
    totals.forEach(row => amounts.set(row.transactionId, BigInt(String(row.amount))))
  }
  return { take(event) {
    const transactionId = direct.get(event.eventId) || related.get(event.eventId)
    if (!transactionId) {
      if (!hasPendingRefundRelation(event)) throw importError('UNRESOLVED_IMPORT')
      return null
    }
    const original = originals.get(transactionId)
    if (!original || String(original.utcAt) > String(event.utcAt)) throw importError('UNRESOLVED_IMPORT')
    const amount = (amounts.get(transactionId) || 0n) + BigInt(event.amountMinor)
    if (amount > BigInt(String(original.amountMinor))) throw importError('UNRESOLVED_IMPORT')
    amounts.set(transactionId, amount)
    return original
  } }
}
module.exports = { loadRefundPostingContext }
