const { ledgerError } = require('./ledger-errors')
const { assertNoLoanTransactions } = require('./loan-transaction-guard')
const { MANUAL_TYPES, parseVersion } = require('./transaction-domain')

function* chunks(ids) {
  for (let offset = 0; offset < ids.length; offset += 100) yield ids.slice(offset, offset + 100)
}

function ensureDeletable(row, version) {
  if (row.origin === 'loan_plan' && row.deletedAt == null) throw ledgerError('LOAN_TRANSACTION_LOCKED')
  if (row.deletedAt != null || !['manual', 'import'].includes(row.origin) || !MANUAL_TYPES.has(row.type)) {
    throw ledgerError('NOT_FOUND')
  }
  if (Number(row.version) !== parseVersion(version)) throw ledgerError('CONFLICT')
}

// 仅普通永久删除使用此保护；系统更正/撤销继续沿用原活动关系规则。
// 调用者已持有用户锁和完整交易选择的行锁。
async function assertNoHistoricalLoanReferences(connection, uid, ids) {
  await assertNoLoanTransactions(connection, uid, ids)
  for (const part of chunks(ids)) {
    const placeholders = part.map(() => '?').join(',')
    const [[row]] = await connection.execute(`SELECT transaction_id FROM catledger_loan_payment_transactions
      WHERE uid=? AND transaction_id IN (${placeholders})
      UNION ALL SELECT transaction_id FROM catledger_loan_replaced_transactions
      WHERE uid=? AND transaction_id IN (${placeholders})
      UNION ALL SELECT transaction_id FROM catledger_installment_items
      WHERE uid=? AND transaction_id IN (${placeholders}) LIMIT 1`,
    [uid, ...part, uid, ...part, uid, ...part])
    if (row) throw ledgerError('LOAN_TRANSACTION_LOCKED')
  }
}

async function assertDeleteRange(connection, uid, ids) {
  await assertNoHistoricalLoanReferences(connection, uid, ids)
  const selected = new Set(ids)
  for (const part of chunks(ids)) {
    // 一份来源的付款分配共用身份，部分删除会使剩余成员把重导永久判重。
    // 只校验用户的完整选择，不自动扩选，也不把来源金额相似当作分项身份。
    const [allocations] = await connection.execute(`SELECT DISTINCT other.transaction_id AS transactionId
      FROM catledger_economic_event_transactions chosen JOIN catledger_economic_event_transactions other
        ON other.uid=chosen.uid AND other.event_id=chosen.event_id AND other.superseded_at IS NULL
      JOIN catledger_transactions t ON t.uid=other.uid AND t.transaction_id=other.transaction_id AND t.deleted_at IS NULL
      WHERE chosen.uid=? AND chosen.transaction_id IN (${part.map(() => '?').join(',')})
        AND chosen.superseded_at IS NULL AND chosen.role<>'refund_original'
        AND EXISTS (SELECT 1 FROM catledger_economic_event_transactions allocation
          WHERE allocation.uid=chosen.uid AND allocation.event_id=chosen.event_id AND allocation.superseded_at IS NULL
            AND allocation.role IN ('payment_allocation','repayment_allocation'))
        AND other.role<>'refund_original'`, [uid, ...part])
    if (allocations.some(row => !selected.has(row.transactionId))) throw ledgerError('TRANSACTION_GROUP_LOCKED')
    const [refunds] = await connection.execute(`SELECT transaction_id AS transactionId, deleted_at AS deletedAt
      FROM catledger_transactions WHERE uid=? AND original_transaction_id IN (${part.map(() => '?').join(',')})
      ORDER BY transaction_id FOR UPDATE`, [uid, ...part])
    if (refunds.some(row => row.deletedAt == null && !selected.has(row.transactionId))) {
      throw ledgerError('REFUNDED_TRANSACTION_LOCKED')
    }
    // 旧软删除退款仍是历史记录，只解除普通退款的失效外键；贷款历史不可改写。
    await assertNoHistoricalLoanReferences(connection, uid, refunds.filter(row => row.deletedAt != null).map(row => row.transactionId))
  }
}

async function permanentlyDelete(connection, uid, rows) {
  const ids = rows.map(row => row.transactionId).sort()
  const changedEvents = new Map()
  for (const part of chunks(ids)) {
    const [events] = await connection.execute(`SELECT e.event_id AS eventId, e.update_id AS updateId, l.creation_method AS creationMethod
      FROM catledger_economic_event_transactions l JOIN catledger_economic_events e
        ON e.uid=l.uid AND e.event_id=l.event_id
      JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id AND u.status='posted'
      WHERE l.uid=? AND l.transaction_id IN (${part.map(() => '?').join(',')})
        AND l.role<>'refund_original' AND l.superseded_at IS NULL`, [uid, ...part])
    for (const event of events) {
      const prior = changedEvents.get(event.eventId)
      changedEvents.set(event.eventId, { ...event, created: Boolean(prior && prior.created) || event.creationMethod === 'created' })
    }
  }
  // 只留集合变更事实，不留可恢复交易副本。旧更正/撤销不能把残余链接误当完整集合。
  for (const created of [true, false]) {
    const reason = created ? 'transaction_permanently_deleted' : 'reused_transaction_permanently_deleted'
    for (const part of chunks([...changedEvents.values()].filter(event => event.created === created).map(event => event.eventId).sort())) {
      await connection.execute(`UPDATE catledger_economic_events
        SET reason_codes_json=JSON_ARRAY_APPEND(reason_codes_json,'$', ?), version=version+1
        WHERE uid=? AND event_id IN (${part.map(() => '?').join(',')})
          AND NOT JSON_CONTAINS(reason_codes_json, JSON_QUOTE(?))`, [reason, uid, ...part, reason])
    }
  }
  for (const part of chunks([...new Set([...changedEvents.values()].map(event => event.updateId))].sort())) {
    await connection.execute(`UPDATE catledger_finance_updates SET version=version+1
      WHERE uid=? AND update_id IN (${part.map(() => '?').join(',')})`, [uid, ...part])
  }
  for (const part of chunks(ids)) {
    const placeholders = part.map(() => '?').join(',')
    // 链接只属于被删交易，包括旧 superseded 链接；来源、事件、文件和入账回执保留。
    await connection.execute(`DELETE FROM catledger_economic_event_transactions
      WHERE uid=? AND transaction_id IN (${placeholders})`, [uid, ...part])
    await connection.execute(`DELETE FROM catledger_review_issue_members
      WHERE uid=? AND object_type='transaction' AND object_id IN (${placeholders})`, [uid, ...part])
    await connection.execute(`UPDATE catledger_transactions SET original_transaction_id=NULL, version=version+1
      WHERE uid=? AND original_transaction_id IN (${placeholders}) AND deleted_at IS NOT NULL`, [uid, ...part])
  }
  // MySQL 自引用 RESTRICT 是即时检查；先删完整选择中的退款，再删原消费，不能依赖 ID/块顺序。
  for (const refund of [true, false]) {
    for (const part of chunks(rows.filter(row => (row.type === 'refund') === refund).map(row => row.transactionId).sort())) {
      const [result] = await connection.execute(`DELETE FROM catledger_transactions
        WHERE uid=? AND transaction_id IN (${part.map(() => '?').join(',')}) AND deleted_at IS NULL`, [uid, ...part])
      if (result.affectedRows !== part.length) throw ledgerError('CONFLICT')
    }
  }
}

module.exports = { chunks, ensureDeletable, assertDeleteRange, permanentlyDelete }
