const { randomUUID } = require('node:crypto')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { parseVersion } = require('./transaction-domain')
const { storedScheduleInput,remainingSchedule } = require('./loan-installment')
const { advanceLoans } = require('./loan-payment-repository')
function anchorOf(loan) {
  return { baselineDate: loan.baselineDate, startDate: loan.startDate, createdDate: String(loan.createdAt).slice(0, 10) }
}
function publicPreview(periods, summary) {
  return { periods: periods.map(row => ({ periodNumber: row.periodNumber, dueDate: row.dueDate,
      principalMinor: String(row.principalMinor), interestMinor: String(row.interestMinor), feeMinor: String(row.feeMinor) })),
    summary: { totalPaymentMinor: String(summary.totalPaymentMinor), totalInterestMinor: String(summary.totalInterestMinor),
      totalFeeMinor: String(summary.totalFeeMinor), ...(summary.derivedRatePpm == null ? {} : { derivedRatePpm: String(summary.derivedRatePpm) }),
      ...(summary.remainingPrincipalMinor == null ? {} : { remainingPrincipalMinor:summary.remainingPrincipalMinor,historicalPaidTerms:summary.historicalPaidTerms,totalTerms:summary.totalTerms,upfrontFeeMinor:summary.upfrontFeeMinor }) } }
}
async function insertSchedulePeriods(connection, uid, loanId, periods) {
  for (let at = 0; at < periods.length; at += 100) {
    const part = periods.slice(at, at + 100).map(row => ({ ...row, periodId: randomUUID() }))
    await connection.execute(`INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled)
      VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,0)').join(',')}`,
    part.flatMap(row => [uid,row.periodId,loanId,row.periodNumber,row.dueDate,row.principalMinor,row.interestMinor,row.feeMinor]))
    await connection.execute(`INSERT INTO catledger_loan_period_revisions (uid,period_id,version,snapshot_json) VALUES ${part.map(() => '(?,?,1,?)').join(',')}`,
    part.flatMap(row => [uid,row.periodId,JSON.stringify({ periodNumber:row.periodNumber,dueDate:row.dueDate,
      principalMinor:String(row.principalMinor),interestMinor:String(row.interestMinor),feeMinor:String(row.feeMinor),cancelled:false })]))
  }
}
function createLoanScheduleService({ getPool, selectLoan }) {
  const read = (context, operation) => executeLedgerRead({ getPool, ...context, consistentSnapshot: true, operation })
  const write = (context, action, operation) => executeIdempotentMutation({ getPool, ...context, currentReads: true, action, operation })
  async function previewPlan(context) {
    return read(context, async (connection, uid) => {
      const data = context.data || {}
      let input = data, options = {}
      if (data.loanId != null) {
        const loan = await selectLoan(connection, uid, data.loanId)
        input = storedScheduleInput(loan)
        options = anchorOf(loan)
      }
      const { periods, summary } = remainingSchedule(input, options)
      return publicPreview(periods, summary)
    })
  }
  async function generatePlan(context) {
    return write(context, 'loans.generatePlan', async (connection, uid, data) => {
      if (data.confirmed !== true) throw ledgerError('VALIDATION_ERROR')
      const loan = await selectLoan(connection, uid, data.loanId, true)
      loan.version = Number(loan.version)
      if (loan.version !== parseVersion(data.version)) throw ledgerError('CONFLICT')
      const input = storedScheduleInput(loan)
      const [[existing]] = await connection.execute('SELECT period_id FROM catledger_loan_periods WHERE uid=? AND loan_id=? LIMIT 1', [uid, loan.loanId])
      if (existing) throw ledgerError('LOAN_PLAN_EXISTS')
      const { periods } = remainingSchedule(input, anchorOf(loan))
      if (!periods.length) throw ledgerError('VALIDATION_ERROR')
      await insertSchedulePeriods(connection,uid,loan.loanId,periods)
      await advanceLoans(connection, uid, new Map([[loan.loanId, loan]]))
      return { loanId: loan.loanId, loanVersion: loan.version + 1, generatedPeriods: periods.length }
    })
  }
  return { previewPlan, generatePlan }
}
module.exports = { createLoanScheduleService,insertSchedulePeriods }
