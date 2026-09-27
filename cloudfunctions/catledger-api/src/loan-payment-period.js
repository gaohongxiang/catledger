const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { FIELDS, PERIOD_SQL, publicPeriod, advancePeriods } = require('./loan-period-repository')
const { fullPlan, progressOf } = require('./installment-view')

// 从某一期登记付款时，付款、费用清偿和期次关联共用原事务与原回执。
async function prepare(connection, uid, input, loans, previous) {
  const result = []
  const [prior] = previous ? await connection.execute(`SELECT loan_id AS loanId,period_id AS periodId,principal_minor AS principalMinor,
    interest_minor AS interestMinor,fee_minor AS feeMinor,historical_principal_minor AS historicalPrincipalMinor
    FROM catledger_loan_period_allocations WHERE uid=? AND payment_id=? AND active=1`,[uid,previous.payment.paymentId]) : [[]]
  // 历史凭证覆盖不能在更正时悄悄丢失期次依据。
  if (prior.some(p=>BigInt(p.historicalPrincipalMinor)>0n && !input.allocations.some(a=>a.loanId===p.loanId&&a.period))) throw ledgerError('LOAN_TRANSACTION_LOCKED')
  for (const share of input.allocations.filter(a => a.period)) {
    if (input.kind !== 'repayment') throw ledgerError('VALIDATION_ERROR')
    const requested = share.period, loan = loans.get(share.loanId)
    const [[saved]] = await connection.execute(PERIOD_SQL + ' WHERE p.uid=? AND p.loan_id=? AND p.period_number=? GROUP BY p.uid,p.period_id', [uid, loan.loanId, requested.periodNumber])
    const period = saved ? publicPeriod(saved) : fullPlan(loan).find(p => p.periodNumber === requested.periodNumber)
    if (!period || period.cancelled) throw ledgerError('VALIDATION_ERROR')
    if (Number(saved ? period.version : 0) !== requested.version) throw ledgerError('CONFLICT')
    for (const field of FIELDS) {
      const paid = saved ? BigInt(period['paid' + field[0].toUpperCase() + field.slice(1) + 'Minor']) : 0n
      const previousPaid = prior.filter(p=>p.periodId===period.periodId).reduce((sum,p)=>sum+BigInt(p[field+'Minor']),0n)
      const history = (progressOf(loan).historyFacts||{})[requested.periodNumber]
      const limit = field==='principal'&&history&&BigInt(history.principalMinor)>BigInt(period.principalMinor)?history.principalMinor:period[field+'Minor']
      if (BigInt(share[field + 'Minor']) + paid - previousPaid > BigInt(limit)) throw ledgerError('LOAN_PLAN_OVERALLOCATED')
    }
    for (const fee of share.chargeAllocations) {
      if(!fee.chargeId){
        const item=await require('./installment-items').canonicalItem(connection,uid,loan.loanId,requested.periodNumber,fee.component)
        if(!item||item.transactionId!==fee.transactionId)throw ledgerError('LOAN_CHARGE_COVERAGE')
        continue
      }
      const [[charge]] = await connection.execute(`SELECT c.period_number AS periodNumber,
        EXISTS(SELECT 1 FROM catledger_loan_charges covered WHERE covered.uid=c.uid AND covered.contract_id=c.contract_id AND covered.covered_by_charge_id=c.charge_id AND covered.period_number=?) AS coversPeriod
        FROM catledger_loan_charges c WHERE c.uid=? AND c.charge_id=?`, [requested.periodNumber, uid, fee.chargeId])
      if (!charge || Number(charge.periodNumber) !== requested.periodNumber && Number(charge.coversPeriod) !== 1) throw ledgerError('LOAN_CHARGE_COVERAGE')
    }
    const progress = progressOf(loan), fact = (progress.historyFacts||{})[requested.periodNumber]
    let historicalPrincipalMinor = '0'
    if (fact) {
      if (input.mode==='new') throw ledgerError('LOAN_TRANSACTION_LOCKED')
      const [[used]] = await connection.execute(`SELECT COALESCE(SUM(a.historical_principal_minor),0) AS amount
        FROM catledger_loan_period_allocations a JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id AND p.status='active'
        WHERE a.uid=? AND a.loan_id=? AND a.period_id=? AND a.active=1 AND (? IS NULL OR a.payment_id<>?)`,[uid,loan.loanId,period.periodId,previous?.payment.paymentId||null,previous?.payment.paymentId||null])
      const available = BigInt(fact.principalMinor)-BigInt(used.amount), proposed=BigInt(share.principalMinor)
      historicalPrincipalMinor = String(available<proposed?available:proposed)
      if (available<0n) throw ledgerError('CONFLICT')
    } else if (progress.simpleRepayment && progress.reviewedPeriods?.[requested.periodNumber] && progress.exceptions?.[requested.periodNumber]==='completed') throw ledgerError('LOAN_HISTORY_REVIEW_REQUIRED')
    result.push({ share, period, create: !saved, historicalPrincipalMinor })
  }
  return result
}

async function persist(connection, uid, paymentId, items) {
  for (const { share, period, create, historicalPrincipalMinor } of items) {
    const id = create ? randomUUID() : period.periodId, version = create ? 1 : period.version
    if (create) {
      await connection.execute(`INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled)
        VALUES (?,?,?,?,?,?,?,?,0)`, [uid, id, share.loanId, period.periodNumber, period.dueDate, period.principalMinor, period.interestMinor, period.feeMinor])
      const snapshot = { periodNumber: period.periodNumber, dueDate: period.dueDate, cancelled: false, ...Object.fromEntries(FIELDS.map(f => [f + 'Minor', String(period[f + 'Minor'])])) }
      await connection.execute('INSERT INTO catledger_loan_period_revisions (uid,period_id,version,snapshot_json) VALUES (?,?,?,?)', [uid, id, version, JSON.stringify(snapshot)])
    }
    await connection.execute(`INSERT INTO catledger_loan_period_allocations
      (uid,allocation_id,payment_id,loan_id,period_id,principal_minor,interest_minor,fee_minor,confirmed_period_version,confirmed_payment_version,historical_principal_minor)
      VALUES (?,?,?,?,?,?,?,?,?,1,?)`, [uid, randomUUID(), paymentId, share.loanId, id, share.principalMinor, share.interestMinor, share.feeMinor, version, historicalPrincipalMinor])
    await advancePeriods(connection, uid, [id])
  }
}
module.exports = { prepare, persist }
