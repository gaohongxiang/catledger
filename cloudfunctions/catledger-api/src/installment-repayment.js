// 用户保存勾选的已还期次就是本次记账意图；不要求另一份自动记费授权。
// 只在持有用户写锁的事务里调用，历史费用与余额保全、进度和回执一起提交。
const { ledgerError } = require('./ledger-errors')
const { parseLocalDateTime } = require('./local-time')
const { fullPlan, progressOf } = require('./installment-view')
const { ITEM_SELECT, publicItem } = require('./installment-items')
const store = require('./loan-charge-store')
const { book, bookNewHistory, settlementAudit } = require('./installment-charge-booking')

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
  const {contract}=await store.ensureContract(c,uid,loan,{
    contractId:loan.chargeContractId,originKind:loan.originKind||'historical',
    authorization:{schema:1,mode:'paused',simpleRepayment:true,coverageOnly:true}
  })
  const [saved] = await c.execute('SELECT period_number AS periodNumber,interest_minor AS interestMinor,fee_minor AS feeMinor,cancelled FROM catledger_loan_periods WHERE uid=? AND loan_id=?', [uid, loan.loanId])
  const [raw] = await c.execute(ITEM_SELECT + ' WHERE i.uid=? AND i.loan_id=? AND i.active=1 AND i.canonical=1 LIMIT 1801', [uid, loan.loanId])
  if (raw.length > 1800) throw ledgerError('LOAN_SOURCE_TOO_LARGE')
  const [categories] = await c.execute("SELECT category_id AS categoryId,system_key AS systemKey FROM catledger_categories WHERE uid=? AND kind='expense' AND archived_at IS NULL", [uid])
  const savedByNumber=new Map(saved.map(p=>[Number(p.periodNumber),p]))
  return { contract, charges: await store.charges(c, uid, contract.contractId), sources: raw.map(publicItem).filter(i => i.active),
    categories, rows: fullPlan(loan).map(row => ({ ...row, ...savedByNumber.get(row.periodNumber) })) }
}

async function confirm(c, uid, loan, view, input, alignPrincipal = false, coverage = {}) {
  const selected = selections(input, Number(loan.scheduleTerms)), state = await context(c, uid, loan)
  const previous = progressOf(loan)
  const progress = { ...previous, schema: 2, simpleRepayment: true, historyFacts: { ...previous.historyFacts }, reviewedPeriods: { ...previous.reviewedPeriods }, exceptions: { ...previous.exceptions } }
  const setup = require('./loan-installment').parseSetup(loan.installmentSetup)
  const rows=new Map(view.rows.map(row=>[row.periodNumber,row])),original=new Map(view.original.map(row=>[row.periodNumber,row]))
  const paidRows=selected.filter(entry=>entry.paid).map(entry=>rows.get(entry.periodNumber))
  if(paidRows.some(row=>!row||row.cancelled||row.status==='partial'))throw ledgerError('LOAN_TRANSACTION_LOCKED')
  await require('./installment-coverage').apply(c,uid,loan,state,paidRows.filter(row=>!row.paymentConfirmed),coverage)
  const newlyBooked = await bookNewHistory(c, uid, loan, state, paidRows.filter(row => !row.paymentConfirmed))
  let principal = BigInt(loan.baselinePrincipalMinor)
  for (const entry of selected) {
    const row = rows.get(entry.periodNumber)
    if (!row || row.cancelled || row.status === 'partial' || !entry.paid && row.paymentConfirmed) throw ledgerError('LOAN_TRANSACTION_LOCKED')
    const fact = progress.historyFacts[entry.periodNumber]
    const legacyReviewed = previous.simpleRepayment && previous.reviewedPeriods && previous.reviewedPeriods[entry.periodNumber] && row.completedByProgress && !fact
    if (legacyReviewed) throw ledgerError('LOAN_HISTORY_REVIEW_REQUIRED')
    const historicalSetup = !previous.reviewedPeriods?.[entry.periodNumber] && entry.periodNumber <= Number(setup && setup.historicalPaidTerms || 0)
    const originalPrincipal = historicalSetup ? original.get(entry.periodNumber).principalMinor : row.principalMinor
    if (!row.paymentConfirmed) {
      if (entry.paid && !fact) {
        if (alignPrincipal && !historicalSetup) principal -= BigInt(row.principalMinor)
        progress.historyFacts[entry.periodNumber] = { principalMinor: String(originalPrincipal), periodVersion: Number(row.version||0), loanVersion: Number(loan.version||1) }
      } else if (!entry.paid && (fact || historicalSetup)) {
        principal += BigInt(fact ? fact.principalMinor : originalPrincipal)
        delete progress.historyFacts[entry.periodNumber]
      }
    }
    if (entry.paid && !row.paymentConfirmed) await book(c, uid, loan, state, row, true)
    // 旧版首期历史补记的一次费仍可成对撤回，但首期已还不能推定一次费已发生或已结清。
    const costs = state.charges.filter(i => i.periodNumber === entry.periodNumber ||
      !entry.paid && entry.periodNumber === 1 && i.chargeKey === 'upfront:fee' && i.historicalSettledMinor !== '0')
    for (const item of costs) {
      if (newlyBooked.has(item.chargeId)) continue
      const current = await store.charge(c,uid,item.chargeId)
      if (entry.paid && !row.paymentConfirmed && ['recorded','baseline','covered'].includes(current.state)) {
        const financial = current.coveredByChargeId ? await store.charge(c,uid,current.coveredByChargeId) : current
        if(BigInt(financial.directlyPaidMinor||'0')>0n)continue
        if (financial.settledMinor !== '0') throw ledgerError('LOAN_TRANSACTION_LOCKED')
        const amount = current.netAmountMinor
        if (current.historicalSettledMinor !== amount) {
          await c.execute('UPDATE catledger_loan_charges SET historical_settled_minor=?,version=version+1 WHERE uid=? AND charge_id=?',[amount,uid,item.chargeId])
          const audit = settlementAudit(entry.periodNumber, amount, current.version)
          await store.audit(c,uid,state.contract.contractId,item.chargeId,audit.action,audit.snapshot)
        }
      } else if (!entry.paid && current.historicalSettledMinor !== '0') {
        const financial = current.coveredByChargeId ? await store.charge(c,uid,current.coveredByChargeId) : current
        if (financial.settledMinor !== '0') throw ledgerError('LOAN_TRANSACTION_LOCKED')
        if (current.balanceAdjustmentId && current.state === 'recorded') {
          await store.assertUnencumbered(c, uid, current)
          await c.execute('UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3),version=version+1 WHERE uid=? AND transaction_id IN (?,?)', [uid, current.transactionId, current.balanceAdjustmentId])
          await c.execute("UPDATE catledger_loan_charges SET state='planned',transaction_id=NULL,balance_adjustment_id=NULL WHERE uid=? AND charge_id=?", [uid,item.chargeId])
        }
        await c.execute('UPDATE catledger_loan_charges SET historical_settled_minor=0,version=version+1 WHERE uid=? AND charge_id=?',[uid,item.chargeId])
        await store.audit(c, uid, state.contract.contractId, item.chargeId, 'unmark_historical_paid', { periodNumber: entry.periodNumber, before:current })
      }
    }
    progress.exceptions[entry.periodNumber] = entry.paid ? 'completed' : 'unpaid'
    progress.reviewedPeriods[entry.periodNumber] = true
  }
  if (principal < 0n) throw ledgerError('LOAN_BASELINE_LOCKED')
  await require('./loan-payment-repository').assertPrincipalTimeline(c,uid,new Map([[loan.loanId,{...loan,baselinePrincipalMinor:principal.toString()}]]))
  // 普通逐期流程只在用户保存时记费；旧自动设置在显式接入此流程时停止。
  await c.execute('UPDATE catledger_loan_charge_contracts SET authorization_json=?,version=version+1 WHERE uid=? AND contract_id=?',
    [JSON.stringify({ ...state.contract.authorization, mode: 'paused', simpleRepayment: true, coverageOnly: true }), uid, state.contract.contractId])
  await c.execute('UPDATE catledger_loans SET progress_json=?,baseline_principal_minor=? WHERE uid=? AND loan_id=?', [JSON.stringify(progress), principal.toString(), uid, loan.loanId])
  await store.audit(c, uid, state.contract.contractId, null, 'save_repayments', { repayments:selected, previousFacts:previous.historyFacts||{}, historyFacts:progress.historyFacts, baselineBefore:String(loan.baselinePrincipalMinor), baselineAfter:principal.toString(), previousMode:state.contract.authorization.mode })
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
