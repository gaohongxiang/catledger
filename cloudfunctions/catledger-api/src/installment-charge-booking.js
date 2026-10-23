// 逐期记费共用同一规划；批量只合并 SQL，不创建事务或改变用户锁、回执边界。
const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { parseLocalDateTime } = require('./local-time')
const store = require('./loan-charge-store')

const BATCH_ROWS = 100
const TRANSACTION_INSERT = `INSERT INTO catledger_transactions
  (uid,transaction_id,type,source_account_id,destination_account_id,amount_minor,category_id,
   occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin,creation_provenance_json) VALUES `
const CHARGE_INSERT = `INSERT INTO catledger_loan_charges
  (uid,charge_id,contract_id,charge_key,component,period_number,charge_date,amount_minor,category_id) VALUES `
const HISTORICAL_CHARGE_INSERT = `INSERT INTO catledger_loan_charges
  (uid,charge_id,contract_id,charge_key,component,period_number,charge_date,amount_minor,category_id,
   version,historical_settled_minor,state,basis,transaction_id,balance_adjustment_id) VALUES `
const AUDIT_INSERT = `INSERT INTO catledger_loan_charge_audit
  (uid,audit_id,contract_id,charge_id,action,snapshot_json) VALUES `

async function insertRows(c, prefix, rows) {
  for (let offset = 0; offset < rows.length; offset += BATCH_ROWS) {
    const batch = rows.slice(offset, offset + BATCH_ROWS)
    await c.execute(prefix + batch.map(row => '(' + row.map(() => '?').join(',') + ')').join(','), batch.flat())
  }
}

function settlementAudit(periodNumber, amountMinor, chargeVersion) {
  return { action: 'confirm_settlement', snapshot: { periodNumber, amountMinor, chargeVersion } }
}

function planBookings(uid, loan, state, rows, historical, paymentDate) {
  const result = [], provenance = JSON.stringify({ kind: 'loan', loanIds: [loan.loanId] })
  for (const row of rows) {
    if (row.cancelled || !Number.isInteger(row.periodNumber) || row.periodNumber < 1) throw ledgerError('VALIDATION_ERROR')
    // 一次性费用必须由实际发生/认领入口确认，不能从首期推定。
    for (const component of ['interest', 'fee']) {
      const key = 'period:' + row.periodNumber + ':' + component
      const source = state.sources.find(i => i.periodNumber === row.periodNumber && i.component === component)
      const previous = state.charges.find(i => i.chargeKey === key)
      if (previous && ['recorded', 'baseline', 'covered'].includes(previous.state)) continue
      if (previous && previous.state !== 'planned') throw ledgerError('LOAN_CHARGE_PAUSED')
      const amount = source ? source.amountMinor : String(row[component + 'Minor'])
      if (amount === '0') continue
      if (previous && previous.amountMinor !== amount) throw ledgerError('LOAN_CHARGE_DIFFERENCE')
      const categoryId = previous && previous.categoryId || (state.categories.find(i => i.systemKey ===
        (component === 'interest' ? 'finance__interest' : 'finance__service')) || {}).categoryId || null
      const item = previous || { chargeId: randomUUID(), chargeKey: key, periodNumber: row.periodNumber, component,
        amountMinor: amount, categoryId, chargeDate: source ? source.occurredDate : paymentDate && paymentDate < row.dueDate ? paymentDate : row.dueDate }
      const transactionId = source && source.transactionId || randomUUID()
      const adjustmentId = historical && !(source && source.transactionId) ? randomUUID() : null
      const transactions = []
      if (!(source && source.transactionId)) {
        if (categoryId && !state.categories.some(category => category.categoryId === categoryId)) throw ledgerError('NOT_FOUND')
        const time = parseLocalDateTime(item.chargeDate + 'T12:00:00', -480)
        transactions.push([uid, transactionId, 'expense', loan.accountId, null, amount, categoryId,
          time.localDate, time.localAt, time.timezoneOffsetMinutes, time.occurredAtUtc,
          loan.name + ' 第' + row.periodNumber + '期' + (component === 'interest' ? '利息' : '手续费'), 'loan_plan', provenance])
        if (adjustmentId) transactions.push([uid, adjustmentId, 'balance_adjustment', null, loan.accountId, amount, null,
          time.localDate, time.localAt, time.timezoneOffsetMinutes, time.occurredAtUtc,
          '补记历史费用，保留已确认余额', 'system', provenance])
      }
      result.push({ item, source, isNew: !previous, amount, transactions, transactionId, adjustmentId,
        basis: source ? 'actual' : 'manual',
        chargeValues: [uid, item.chargeId, state.contract.contractId, key, component, row.periodNumber, item.chargeDate, amount, categoryId],
        recordAudit: { action: historical ? 'confirm_historical_paid' : 'record_period_fee',
          snapshot: { periodNumber: row.periodNumber, transactionId, balanceAdjustmentId: adjustmentId } },
        settlementAudit: settlementAudit(row.periodNumber, amount, 2)
      })
    }
  }
  return result
}

async function book(c, uid, loan, state, row, historical, paymentDate) {
  for (const entry of planBookings(uid, loan, state, [row], historical, paymentDate)) {
    const { item, source, transactionId, adjustmentId } = entry
    if (entry.isNew) await insertRows(c, CHARGE_INSERT, [entry.chargeValues])
    for (const values of entry.transactions) await insertRows(c, TRANSACTION_INSERT, [values])
    await c.execute("UPDATE catledger_loan_charges SET state='recorded',basis=?,transaction_id=?,balance_adjustment_id=?,version=version+1 WHERE uid=? AND charge_id=?",
      [entry.basis, transactionId, adjustmentId, uid, item.chargeId])
    if (source) await c.execute('INSERT INTO catledger_loan_charge_sources(uid,charge_id,item_id) VALUES(?,?,?)', [uid, item.chargeId, source.itemId])
    Object.assign(item, { state: 'recorded', transactionId, balanceAdjustmentId: adjustmentId })
    if (entry.isNew) state.charges.push(item)
    await store.audit(c, uid, state.contract.contractId, item.chargeId, entry.recordAudit.action, entry.recordAudit.snapshot)
  }
}

async function bookNewHistory(c, uid, loan, state, rows) {
  // 已有收费项、实际来源、认领和覆盖仍逐项执行原有依赖检查。
  const entries = planBookings(uid, loan, state, rows, true).filter(entry => entry.isNew && !entry.source)
  if (!entries.length) return new Set()
  await insertRows(c, TRANSACTION_INSERT, entries.flatMap(entry => entry.transactions))
  // 新费用的原顺序版本为 planned(1) -> recorded(2) -> historical settled(3)。
  await insertRows(c, HISTORICAL_CHARGE_INSERT, entries.map(entry => [...entry.chargeValues,
    3, entry.amount, 'recorded', entry.basis, entry.transactionId, entry.adjustmentId]))
  await insertRows(c, AUDIT_INSERT, entries.flatMap(entry => [entry.recordAudit, entry.settlementAudit].map(audit =>
    [uid, randomUUID(), state.contract.contractId, entry.item.chargeId, audit.action, JSON.stringify(audit.snapshot)])))
  for (const entry of entries) state.charges.push({ ...entry.item, state: 'recorded', transactionId: entry.transactionId,
    balanceAdjustmentId: entry.adjustmentId, historicalSettledMinor: entry.amount })
  return new Set(entries.map(entry => entry.item.chargeId))
}

module.exports = { book, bookNewHistory, settlementAudit }
