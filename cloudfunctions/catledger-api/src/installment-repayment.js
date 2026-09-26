// 用户保存勾选的已还期次就是本次记账意图；不要求另一份自动记费授权。
// 只在持有用户写锁的事务里调用，历史费用与余额保全、进度和回执一起提交。
const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { parseLocalDateTime } = require('./local-time')
const { fullPlan, progressOf } = require('./installment-view')
const { ITEM_SELECT, publicItem } = require('./installment-items')
const store = require('./loan-charge-store')

function selections(input, terms) {
  if (!Array.isArray(input) || !input.length || input.length > 600) throw ledgerError('VALIDATION_ERROR')
  const seen = new Set()
  for (const row of input) {
    if (!row || !Number.isInteger(row.periodNumber) || row.periodNumber < 1 || row.periodNumber > terms ||
        typeof row.paid !== 'boolean' || seen.has(row.periodNumber)) throw ledgerError('VALIDATION_ERROR')
    seen.add(row.periodNumber)
  }
  return input
}

async function context(c, uid, loan) {
  const [[account]] = await c.execute('SELECT type,archived_at AS archivedAt FROM catledger_accounts WHERE uid=? AND account_id=?', [uid, loan.accountId])
  if (!account || account.archivedAt != null) throw ledgerError('ACCOUNT_INACTIVE')
  if (!['credit', 'other_liability'].includes(account.type)) throw ledgerError('VALIDATION_ERROR')
  let contract = await store.contract(c, uid, loan.loanId)
  if (!contract) {
    const [bindings] = await c.execute('SELECT reference_key AS referenceKey FROM catledger_installment_bindings WHERE uid=? AND loan_id=? ORDER BY reference_key', [uid, loan.loanId])
    const referenceKey = bindings[0] && bindings[0].referenceKey || null
    const [previous] = await c.execute(store.CONTRACT_SQL + ' WHERE uid=? AND account_id=? AND (? IS NULL OR reference_key=?)', [uid, loan.accountId, referenceKey, referenceKey])
    // 无明确编号时不猜旧合同；有同一编号且原记录已归档时沿用原费用身份。
    for (const old of previous) {
      const [[owner]] = await c.execute('SELECT archived_at AS archivedAt FROM catledger_loans WHERE uid=? AND loan_id=?', [uid, old.loanId])
      if (referenceKey && old.referenceKey === referenceKey && owner && owner.archivedAt != null) {
        await c.execute('UPDATE catledger_loan_charge_contracts SET loan_id=?,version=version+1 WHERE uid=? AND contract_id=?', [loan.loanId, uid, old.contractId])
        await store.audit(c, uid, old.contractId, null, 'claim_contract', { previousLoanId: old.loanId, loanId: loan.loanId })
        contract = await store.contract(c, uid, loan.loanId)
        break
      }
      if (referenceKey || owner && owner.archivedAt != null) throw ledgerError('LOAN_COVERAGE_REQUIRED')
    }
    if (!contract) {
      const authorization = { schema: 1, mode: 'paused', simpleRepayment: true, coverageOnly: true }
      contract = { contractId: randomUUID(), authorization, referenceKey }
      await c.execute(`INSERT INTO catledger_loan_charge_contracts(uid,contract_id,loan_id,account_id,reference_key,origin_kind,authorization_json)
        VALUES(?,?,?,?,?,?,?)`, [uid, contract.contractId, loan.loanId, loan.accountId, referenceKey, loan.originKind || 'historical', JSON.stringify(authorization)])
    }
  }
  const [saved] = await c.execute('SELECT period_number AS periodNumber,interest_minor AS interestMinor,fee_minor AS feeMinor,cancelled FROM catledger_loan_periods WHERE uid=? AND loan_id=?', [uid, loan.loanId])
  const [raw] = await c.execute(ITEM_SELECT + ' WHERE i.uid=? AND i.loan_id=? AND i.active=1 AND i.canonical=1 LIMIT 1801', [uid, loan.loanId])
  if (raw.length > 1800) throw ledgerError('LOAN_SOURCE_TOO_LARGE')
  const [categories] = await c.execute("SELECT category_id AS categoryId,system_key AS systemKey FROM catledger_categories WHERE uid=? AND kind='expense' AND archived_at IS NULL", [uid])
  return { contract, charges: await store.charges(c, uid, contract.contractId), sources: raw.map(publicItem).filter(i => i.active),
    categories, rows: fullPlan(loan).map(row => ({ ...row, ...saved.find(p => Number(p.periodNumber) === row.periodNumber) })) }
}

async function book(c, uid, loan, state, row, historical, paymentDate) {
  if (row.cancelled) throw ledgerError('VALIDATION_ERROR')
  if (historical && row.periodNumber === 1 && BigInt(loan.feeUpfrontMinor || '0') > 0n) {
    await book(c, uid, loan, state, { periodNumber:null, interestMinor:'0', feeMinor:loan.feeUpfrontMinor, dueDate:row.dueDate }, true)
  }
  for (const component of ['interest', 'fee']) {
    const key = row.periodNumber == null ? 'upfront:fee' : 'period:' + row.periodNumber + ':' + component
    const source = state.sources.find(i => i.periodNumber === row.periodNumber && i.component === component)
    let item = state.charges.find(i => i.chargeKey === key)
    if (item && ['recorded', 'baseline', 'covered'].includes(item.state)) continue
    // 删除、减免、暂停的费用不能被勾选已还偷偷复活。
    if (item && item.state !== 'planned') throw ledgerError('LOAN_CHARGE_PAUSED')
    const amount = source ? source.amountMinor : String(row[component + 'Minor'])
    if (amount === '0') continue
    if (item && item.amountMinor !== amount) throw ledgerError('LOAN_CHARGE_DIFFERENCE')
    const categoryId = item && item.categoryId || (state.categories.find(i => i.systemKey === (component === 'interest' ? 'finance__interest' : 'finance__service')) || {}).categoryId || null
    if (!item) {
      item = { chargeId: randomUUID(), chargeKey: key, amountMinor: amount, categoryId, chargeDate: source ? source.occurredDate : paymentDate && paymentDate < row.dueDate ? paymentDate : row.dueDate }
      await c.execute(`INSERT INTO catledger_loan_charges(uid,charge_id,contract_id,charge_key,component,period_number,charge_date,amount_minor,category_id)
        VALUES(?,?,?,?,?,?,?,?,?)`, [uid, item.chargeId, state.contract.contractId, key, component, row.periodNumber, item.chargeDate, amount, categoryId])
      state.charges.push(item)
    }
    let transactionId = source && source.transactionId, adjustmentId = null
    if (!transactionId) {
      if (categoryId && !state.categories.some(category => category.categoryId === categoryId)) throw ledgerError('NOT_FOUND')
      transactionId = randomUUID()
      const time = parseLocalDateTime(item.chargeDate + 'T12:00:00', -480)
      await c.execute(`INSERT INTO catledger_transactions(uid,transaction_id,type,source_account_id,amount_minor,category_id,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin)
        VALUES(?,?,'expense',?,?,?,?,?,?,?,?,'loan_plan')`, [uid, transactionId, loan.accountId, amount, categoryId, time.localDate, time.localAt, time.timezoneOffsetMinutes, time.occurredAtUtc,
        loan.name + (row.periodNumber == null ? ' 一次性' : ' 第' + row.periodNumber + '期') + (component === 'interest' ? '利息' : '手续费')])
      if (historical) {
        adjustmentId = randomUUID()
        await c.execute(`INSERT INTO catledger_transactions(uid,transaction_id,type,destination_account_id,amount_minor,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin)
          VALUES(?,?,'balance_adjustment',?,?,?,?,?,?,?,'system')`, [uid, adjustmentId, loan.accountId, amount, time.localDate, time.localAt, time.timezoneOffsetMinutes, time.occurredAtUtc, '补记历史费用，保留已确认余额'])
      }
    }
    await c.execute("UPDATE catledger_loan_charges SET state='recorded',basis=?,transaction_id=?,balance_adjustment_id=?,version=version+1 WHERE uid=? AND charge_id=?",
      [source ? 'actual' : 'manual', transactionId, adjustmentId, uid, item.chargeId])
    if (source) await c.execute('INSERT INTO catledger_loan_charge_sources(uid,charge_id,item_id) VALUES(?,?,?)', [uid, item.chargeId, source.itemId])
    Object.assign(item, { state: 'recorded', transactionId, balanceAdjustmentId: adjustmentId })
    await store.audit(c, uid, state.contract.contractId, item.chargeId, historical ? 'confirm_historical_paid' : 'record_period_fee', { periodNumber: row.periodNumber, transactionId, balanceAdjustmentId: adjustmentId })
  }
}

async function confirm(c, uid, loan, view, input, alignPrincipal = false) {
  const selected = selections(input, Number(loan.scheduleTerms)), state = await context(c, uid, loan)
  const previous = progressOf(loan)
  const progress = { ...previous, schema: 2, simpleRepayment: true, reviewedPeriods: { ...previous.reviewedPeriods }, exceptions: { ...previous.exceptions } }
  const setup = require('./loan-installment').parseSetup(loan.installmentSetup)
  let principal = BigInt(loan.baselinePrincipalMinor)
  for (const entry of selected) {
    const row = view.rows.find(r => r.periodNumber === entry.periodNumber)
    if (!row || row.cancelled || row.status === 'partial' || !entry.paid && row.paymentConfirmed) throw ledgerError('LOAN_TRANSACTION_LOCKED')
    if (alignPrincipal && !row.paymentConfirmed) {
      const accounted = previous.reviewedPeriods && previous.reviewedPeriods[entry.periodNumber]
        ? row.complete : entry.periodNumber <= Number(setup && setup.historicalPaidTerms || 0)
      if (entry.paid !== accounted) principal += (entry.paid ? -1n : 1n) * BigInt(row.principalMinor)
    }
    if (entry.paid && !row.paymentConfirmed) await book(c, uid, loan, state, row, true)
    else if (!entry.paid) for (const item of state.charges.filter(i => (i.periodNumber === entry.periodNumber || entry.periodNumber === 1 && i.chargeKey === 'upfront:fee') && i.balanceAdjustmentId && i.state === 'recorded')) {
      await store.assertUnencumbered(c, uid, item)
      await c.execute('UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3),version=version+1 WHERE uid=? AND transaction_id IN (?,?)', [uid, item.transactionId, item.balanceAdjustmentId])
      await c.execute("UPDATE catledger_loan_charges SET state='planned',transaction_id=NULL,balance_adjustment_id=NULL,version=version+1 WHERE uid=? AND charge_id=?", [uid, item.chargeId])
      await store.audit(c, uid, state.contract.contractId, item.chargeId, 'unmark_historical_paid', { periodNumber: entry.periodNumber })
    }
    progress.exceptions[entry.periodNumber] = entry.paid ? 'completed' : 'unpaid'
    progress.reviewedPeriods[entry.periodNumber] = true
  }
  if (principal < 0n) throw ledgerError('LOAN_BASELINE_LOCKED')
  // 普通逐期流程只在用户保存时记费；旧自动设置在显式接入此流程时停止。
  await c.execute('UPDATE catledger_loan_charge_contracts SET authorization_json=?,version=version+1 WHERE uid=? AND contract_id=?',
    [JSON.stringify({ ...state.contract.authorization, mode: 'paused', simpleRepayment: true, coverageOnly: true }), uid, state.contract.contractId])
  await c.execute('UPDATE catledger_loans SET progress_json=?,baseline_principal_minor=? WHERE uid=? AND loan_id=?', [JSON.stringify(progress), principal.toString(), uid, loan.loanId])
  await store.audit(c, uid, state.contract.contractId, null, 'save_repayments', { repayments:selected, previousMode:state.contract.authorization.mode })
  return progress
}

async function payment(c, uid, data, selectLoan, loadView) {
  if (data.mode !== 'new' || data.kind !== 'repayment' || data.replacePayment || data.allocations.length !== 1) throw ledgerError('VALIDATION_ERROR')
  const input = data.allocations[0], loan = await selectLoan(c, uid, input.loanId, true)
  if (Number(loan.version) !== input.version) throw ledgerError('CONFLICT')
  if (loan.archivedAt != null || !input.period) throw ledgerError('VALIDATION_ERROR')
  const view = await loadView(c, uid, loan)
  const row = view.rows.find(p => p.periodNumber === input.period.periodNumber)
  if (!row || row.complete || row.cancelled) throw ledgerError('LOAN_TRANSACTION_LOCKED')
  const state = await context(c, uid, loan)
  const paymentDate = parseLocalDateTime(data.occurredLocalAt, data.timezoneOffsetMinutes).localDate
  await book(c, uid, loan, state, row, false, paymentDate)
  const charges = await store.charges(c, uid, state.contract.contractId)
  const allocation = { ...input, chargeAllocations: [] }
  for (const component of ['interest', 'fee']) {
    allocation[component + 'Treatment'] = 'accrued'
    allocation[component + 'CategoryId'] = null
    if (input[component + 'Minor'] === '0') continue
    const item = charges.find(i => i.chargeKey === 'period:' + row.periodNumber + ':' + component)
    if (!item) throw ledgerError('LOAN_CHARGE_COVERAGE')
    allocation.chargeAllocations.push({ chargeId: item.coveredByChargeId || item.chargeId, component, amountMinor: input[component + 'Minor'] })
  }
  return { ...data, allocations: [allocation] }
}
module.exports = { selections, context, book, confirm, payment }
