const { ledgerError } = require('./ledger-errors')
const { parseMinorUnits } = require('./money')
const { buildSchedule } = require('./loan-schedule/schedule-engine')
const parseSetup = value => value == null ? null : typeof value === 'string' ? JSON.parse(value) : value
function normalizeSetup(raw, terms) {
  if (raw == null) return null
  const keys = ['schema','originalPrincipalMinor','historicalPaidTerms','recordType','customRecordType','discountKind','discountValue']
  if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key)) || raw.schema !== 1) throw ledgerError('VALIDATION_ERROR')
  const originalPrincipalMinor = parseMinorUnits(raw.originalPrincipalMinor).toString()
  const historicalPaidTerms = raw.historicalPaidTerms
  if (!Number.isInteger(terms) || !Number.isInteger(historicalPaidTerms) || historicalPaidTerms < 0 || historicalPaidTerms > terms) throw ledgerError('VALIDATION_ERROR')
  const recordType = raw.recordType || '', customRecordType = raw.customRecordType == null ? '' : raw.customRecordType
  if (!['','credit_card','bank_loan','online_loan','other'].includes(recordType) || typeof customRecordType !== 'string' || Array.from(customRecordType).length > 12) throw ledgerError('VALIDATION_ERROR')
  const discountKind = raw.discountKind || null
  const discountValue = raw.discountValue == null ? null : parseMinorUnits(raw.discountValue).toString()
  if ((discountKind === null) !== (discountValue === null) || (discountKind && !['interest_rate','per_period','total'].includes(discountKind)) ||
    (discountKind === 'interest_rate' && BigInt(discountValue) > 1000000n)) throw ledgerError('VALIDATION_ERROR')
  return { schema:1,originalPrincipalMinor,historicalPaidTerms,recordType,customRecordType:recordType === 'other' ? customRecordType.trim() : '',discountKind,discountValue }
}
function storedScheduleInput(loan) {
  const setup = parseSetup(loan.installmentSetup)
  if (loan.scheduleMethod == null) throw ledgerError('VALIDATION_ERROR')
  const principal = setup ? setup.originalPrincipalMinor : loan.baselinePrincipalMinor
  if (principal == null || BigInt(principal) <= 0n) throw ledgerError('LOAN_PRINCIPAL_UNCONFIRMED')
  return { principalMinor:String(principal),scheduleMethod:loan.scheduleMethod,scheduleTerms:Number(loan.scheduleTerms),
    measurementKind:loan.measurementKind,quoteType:loan.quoteType,ratePpm:loan.ratePpm == null ? null : String(loan.ratePpm),
    repaymentMinor:loan.repaymentMinor == null ? null : String(loan.repaymentMinor),feePerTermMinor:loan.feePerTermMinor == null ? null : String(loan.feePerTermMinor),
    feeUpfrontMinor:loan.feeUpfrontMinor == null ? null : String(loan.feeUpfrontMinor),firstPaymentDate:loan.firstPaymentDate,
    ...(setup ? { installmentSetup:setup } : {}) }
}
function remainingSchedule(input, options) {
  const setup = normalizeSetup(input.installmentSetup, input.scheduleTerms)
  const result = buildSchedule({ ...input,...(setup ? { principalMinor:setup.originalPrincipalMinor,discountKind:setup.discountKind,discountValue:setup.discountValue } : {}) }, options)
  if (!setup) return { ...result,periods:result.periods.filter(row=>row.paymentMinor>0) }
  // 零利息先息后本/全额优惠的空付息月份保留原期号，但不制造 0 元应还任务。
  const periods = result.periods.slice(setup.historicalPaidTerms).filter(row=>row.paymentMinor>0)
  const sum = key => periods.reduce((total,row) => total + BigInt(row[key]),0n).toString()
  return { periods,summary:{ totalPaymentMinor:sum('paymentMinor'),totalInterestMinor:sum('interestMinor'),totalFeeMinor:sum('feeMinor'),
    remainingPrincipalMinor:sum('principalMinor'),historicalPaidTerms:setup.historicalPaidTerms,totalTerms:input.scheduleTerms,
    upfrontFeeMinor:input.feeUpfrontMinor || '0',...(result.summary.derivedRatePpm == null ? {} : { derivedRatePpm:result.summary.derivedRatePpm }) } }
}
module.exports = { normalizeSetup,parseSetup,storedScheduleInput,remainingSchedule }
