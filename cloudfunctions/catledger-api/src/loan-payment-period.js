const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { FIELDS, PERIOD_SQL, publicPeriod, advancePeriods } = require('./loan-period-repository')
const { fullPlan } = require('./installment-view')

// 从某一期登记付款时，付款、费用清偿和期次关联共用原事务与原回执。
async function prepare(connection, uid, input, loans, previous) {
  const result = []
  for (const share of input.allocations.filter(a => a.period)) {
    if (previous || input.kind !== 'repayment') throw ledgerError('VALIDATION_ERROR')
    const requested = share.period, loan = loans.get(share.loanId)
    const [[saved]] = await connection.execute(PERIOD_SQL + ' WHERE p.uid=? AND p.loan_id=? AND p.period_number=? GROUP BY p.uid,p.period_id', [uid, loan.loanId, requested.periodNumber])
    const period = saved ? publicPeriod(saved) : fullPlan(loan).find(p => p.periodNumber === requested.periodNumber)
    if (!period || period.cancelled) throw ledgerError('VALIDATION_ERROR')
    if (Number(saved ? period.version : 0) !== requested.version) throw ledgerError('CONFLICT')
    for (const field of FIELDS) {
      const paid = saved ? period['paid' + field[0].toUpperCase() + field.slice(1) + 'Minor'] : '0'
      if (BigInt(share[field + 'Minor']) + BigInt(paid) > BigInt(period[field + 'Minor'])) throw ledgerError('LOAN_PLAN_OVERALLOCATED')
    }
    for (const fee of share.chargeAllocations) {
      if(!fee.chargeId)throw ledgerError('LOAN_CHARGE_COVERAGE')
      const [[charge]] = await connection.execute(`SELECT c.period_number AS periodNumber,
        EXISTS(SELECT 1 FROM catledger_loan_charges covered WHERE covered.uid=c.uid AND covered.contract_id=c.contract_id AND covered.covered_by_charge_id=c.charge_id AND covered.period_number=?) AS coversPeriod
        FROM catledger_loan_charges c WHERE c.uid=? AND c.charge_id=?`, [requested.periodNumber, uid, fee.chargeId])
      if (!charge || Number(charge.periodNumber) !== requested.periodNumber && Number(charge.coversPeriod) !== 1) throw ledgerError('LOAN_CHARGE_COVERAGE')
    }
    result.push({ share, period, create: !saved })
  }
  return result
}

async function persist(connection, uid, paymentId, items) {
  for (const { share, period, create } of items) {
    const id = create ? randomUUID() : period.periodId, version = create ? 1 : period.version
    if (create) {
      await connection.execute(`INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled)
        VALUES (?,?,?,?,?,?,?,?,0)`, [uid, id, share.loanId, period.periodNumber, period.dueDate, period.principalMinor, period.interestMinor, period.feeMinor])
      const snapshot = { periodNumber: period.periodNumber, dueDate: period.dueDate, cancelled: false, ...Object.fromEntries(FIELDS.map(f => [f + 'Minor', String(period[f + 'Minor'])])) }
      await connection.execute('INSERT INTO catledger_loan_period_revisions (uid,period_id,version,snapshot_json) VALUES (?,?,?,?)', [uid, id, version, JSON.stringify(snapshot)])
    }
    await connection.execute(`INSERT INTO catledger_loan_period_allocations
      (uid,allocation_id,payment_id,loan_id,period_id,principal_minor,interest_minor,fee_minor,confirmed_period_version,confirmed_payment_version)
      VALUES (?,?,?,?,?,?,?,?,?,1)`, [uid, randomUUID(), paymentId, share.loanId, id, share.principalMinor, share.interestMinor, share.feeMinor, version])
    await advancePeriods(connection, uid, [id])
  }
}
module.exports = { prepare, persist }
