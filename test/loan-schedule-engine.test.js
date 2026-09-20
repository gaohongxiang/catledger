const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSchedule, periodicRate } = require('../cloudfunctions/catledger-api/src/loan-schedule/schedule-engine')
const { monthlyIrr } = require('../cloudfunctions/catledger-api/src/loan-schedule/cashflow')
const { addMonths, scheduleAnchor } = require('../cloudfunctions/catledger-api/src/loan-schedule/schedule-dates')
const { MAX_TERMS } = require('../cloudfunctions/catledger-api/src/loan-schedule/schedule-params')

function rateInput(method, overrides = {}) {
  return { principalMinor: '1000000', scheduleMethod: method, scheduleTerms: 12, measurementKind: 'rate',
    quoteType: 'annual', ratePpm: '100000', firstPaymentDate: '2026-09-10', ...overrides }
}
function repaymentInput(method, value, overrides = {}) {
  return { principalMinor: '1000000', scheduleMethod: method, scheduleTerms: 12, measurementKind: 'repayment',
    repaymentMinor: String(value), firstPaymentDate: '2026-09-10', ...overrides }
}
function assertSchedule(result, terms, principal, label) {
  assert.equal(result.periods.length, terms, `${label}: term count`)
  assert.equal(result.periods.reduce((sum, row) => sum + row.principalMinor, 0), principal, `${label}: principal conservation`)
  for (const [index, row] of result.periods.entries()) {
    assert.equal(row.periodNumber, index + 1, `${label}: row ${index + 1} number`)
    assert.equal(row.paymentMinor, row.principalMinor + row.interestMinor + row.feeMinor, `${label}: row ${index + 1} payment`)
    assert.ok(row.principalMinor >= 0 && row.interestMinor >= 0 && row.feeMinor >= 0, `${label}: row ${index + 1} non-negative`)
    assert.ok(row.principalMinor + row.interestMinor + row.feeMinor > 0, `${label}: row ${index + 1} positive`)
  }
  assert.equal(result.periods[result.periods.length - 1].endingBalanceMinor, 0, `${label}: final balance`)
  assert.equal(result.summary.totalPaymentMinor, principal + result.summary.totalInterestMinor + result.summary.totalFeeMinor, `${label}: total reconciliation`)
}

for (const method of ['flat', 'equal_payment', 'equal_principal', 'interest_only']) {
  test(`rate basis builds complete ${method} schedule`, () => {
    const result = buildSchedule(rateInput(method))
    assertSchedule(result, 12, 1000000, `rate ${method}`)
    assert.equal(result.periods[0].dueDate, '2026-09-10')
    assert.equal(result.summary.derivedRatePpm, undefined)
  })
}

test('flat annual quote uses fixed principal cost with final residue', () => {
  const result = buildSchedule(rateInput('flat'))
  assert.equal(result.summary.totalInterestMinor, 100000)
  assert.equal(result.summary.totalFeeMinor, 0)
  assert.equal(result.periods[0].principalMinor, 83333)
  assert.equal(result.periods[0].interestMinor, 8333)
  assert.equal(result.periods[11].principalMinor, 83337)
  assert.equal(result.periods[11].interestMinor, 8337)
})

test('equal payment nominal annual quote amortizes', () => {
  const result = buildSchedule(rateInput('equal_payment'))
  assert.equal(result.periods[0].paymentMinor, result.periods[1].paymentMinor)
  assert.ok(result.periods[0].interestMinor > result.periods[11].interestMinor)
  assert.ok(result.periods[0].principalMinor < result.periods[11].principalMinor)
})

test('equal principal nominal annual quote declines', () => {
  const result = buildSchedule(rateInput('equal_principal'))
  assert.ok(result.periods[0].paymentMinor > result.periods[11].paymentMinor)
  assert.equal(result.periods[0].principalMinor, result.periods[1].principalMinor)
})

test('interest-only nominal annual quote returns principal at maturity', () => {
  const result = buildSchedule(rateInput('interest_only'))
  assert.equal(result.periods[0].principalMinor, 0)
  assert.equal(result.periods[11].principalMinor, 1000000)
  assert.equal(result.periods[0].interestMinor, 8333)
})

test('daily quote uses 360-day year and monthly quote stays per term', () => {
  const daily = buildSchedule(rateInput('flat', { quoteType: 'daily', ratePpm: '100' }))
  assert.equal(daily.summary.totalInterestMinor, 36000)
  const monthly = buildSchedule(rateInput('flat', { quoteType: 'monthly', ratePpm: '10000' }))
  assert.equal(monthly.summary.totalInterestMinor, 120000)
})

const repaymentCases = [['flat', 90000], ['equal_payment', 87916], ['equal_principal', 91667], ['interest_only', 8333]]
for (const [method, value] of repaymentCases) {
  test(`repayment basis infers and splits ${method}`, () => {
    const result = buildSchedule(repaymentInput(method, value))
    assertSchedule(result, 12, 1000000, `repayment ${method}`)
    assert.ok(Number(result.summary.derivedRatePpm) >= 0)
  })
}

test('flat repayment basis derives fixed total cost and rate', () => {
  const result = buildSchedule(repaymentInput('flat', 90000))
  assert.equal(result.summary.totalInterestMinor, 80000)
  assert.equal(result.summary.derivedRatePpm, 80000)
  assert.equal(result.periods[0].paymentMinor, 90000)
})

test('equal payment honors entered payment and corrects only the final row', () => {
  const result = buildSchedule(repaymentInput('equal_payment', 446059, { principalMinor: '5000000' }))
  for (const row of result.periods.slice(0, -1)) assert.equal(row.paymentMinor, 446059)
  assert.ok(Math.abs(result.periods[11].paymentMinor - 446059) <= 3)
  assert.ok(Math.abs(result.summary.totalInterestMinor - 352709) <= 20)
  assert.ok(Math.abs(Number(result.summary.derivedRatePpm) - 127800) <= 300)
})

test('equal principal derives declining rows from first payment', () => {
  const result = buildSchedule(repaymentInput('equal_principal', 91667))
  assert.equal(result.periods[0].paymentMinor, 91667)
  assert.ok(result.periods[1].paymentMinor < result.periods[0].paymentMinor)
  assert.ok(result.periods[11].paymentMinor < result.periods[1].paymentMinor)
})

test('per-term and upfront fees enter payments and summary but never principal', () => {
  const plain = buildSchedule(rateInput('equal_payment'))
  const fees = buildSchedule(rateInput('equal_payment', { feePerTermMinor: '1000', feeUpfrontMinor: '10000' }))
  assert.equal(fees.periods.reduce((sum, row) => sum + row.principalMinor, 0), 1000000)
  assert.equal(fees.periods[0].feeMinor, 1000)
  assert.equal(fees.summary.totalFeeMinor, 22000)
  assert.equal(fees.summary.totalPaymentMinor - plain.summary.totalPaymentMinor, 22000)
  assert.equal(fees.periods.every(row => row.feeMinor === 1000), true)
})

test('monthlyIrr solves and rejects degenerate cashflows', () => {
  const rate = monthlyIrr([1000000, ...Array.from({ length: 12 }, () => -87916)])
  assert.ok(Math.abs(rate - 0.008333) < 0.0002)
  assert.equal(monthlyIrr([1000000, -1000000]), 0)
  assert.equal(monthlyIrr([1000000, -500000]), 0)
  assert.equal(monthlyIrr([]), 0)
})

test('addMonths clamps month ends and anchor falls back to baseline then creation', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29')
  assert.equal(addMonths('2026-12-15', 2), '2027-02-15')
  assert.equal(scheduleAnchor({ firstPaymentDate: '2026-09-10', baselineDate: '2026-05-05' }), '2026-09-10')
  assert.equal(scheduleAnchor({ baselineDate: '2026-05-05', startDate: '2026-04-01' }), '2026-06-05')
  assert.equal(scheduleAnchor({ startDate: '2026-04-01', createdDate: '2026-03-02' }), '2026-05-01')
  assert.equal(scheduleAnchor({ createdDate: '2026-03-31' }), '2026-04-30')
})

test('missing first payment date anchors one month after the loan dates', () => {
  const result = buildSchedule(rateInput('flat', { firstPaymentDate: null }), { baselineDate: '2026-05-05' })
  assert.equal(result.periods[0].dueDate, '2026-06-05')
  assert.equal(result.periods[11].dueDate, '2027-05-05')
})

test('600-term boundary builds and 601 is rejected', () => {
  assert.equal(MAX_TERMS, 600)
  const result = buildSchedule(rateInput('equal_payment', { scheduleTerms: 600 }))
  assertSchedule(result, 600, 1000000, 'rate 600 terms')
  assert.throws(() => buildSchedule(rateInput('flat', { scheduleTerms: 601 })), { publicCode: 'VALIDATION_ERROR' })
  assert.throws(() => buildSchedule(rateInput('flat', { scheduleTerms: 0 })), { publicCode: 'VALIDATION_ERROR' })
})

test('parameter pairing and semantic violations are rejected', () => {
  const invalid = [
    rateInput('unknown_method'),
    rateInput('flat', { scheduleTerms: 1.5 }),
    rateInput('flat', { measurementKind: 'unknown' }),
    rateInput('flat', { quoteType: null }),
    rateInput('flat', { ratePpm: null }),
    rateInput('flat', { repaymentMinor: '90000' }),
    rateInput('flat', { quoteType: 'quarterly' }),
    rateInput('equal_payment', { quoteType: 'installment' }),
    repaymentInput('flat', 90000, { quoteType: 'annual' }),
    repaymentInput('flat', 90000, { ratePpm: '100000' }),
    rateInput('flat', { principalMinor: '0' }),
    rateInput('flat', { principalMinor: null }),
    rateInput('flat', { principalMinor: 1000000 }),
    rateInput('flat', { feePerTermMinor: '-1' }),
    rateInput('flat', { feeUpfrontMinor: '1000000' }),
    rateInput('flat', { firstPaymentDate: '2026-02-30' }),
    repaymentInput('equal_payment', 80000),
    repaymentInput('flat', 80000),
    repaymentInput('equal_principal', 80000)
  ]
  for (const input of invalid) assert.throws(() => buildSchedule(input), { publicCode: 'VALIDATION_ERROR' }, JSON.stringify(input))
  const interestFree=buildSchedule(repaymentInput('interest_only',0))
  assert.equal(interestFree.periods.slice(0,-1).every(row=>row.paymentMinor===0),true)
  assert.equal(interestFree.periods.at(-1).paymentMinor,1000000)
  assert.equal(interestFree.summary.totalInterestMinor,0)
})

test('periodicRate converts ppm quotes and infers repayment rates', () => {
  const { parseScheduleParams } = require('../cloudfunctions/catledger-api/src/loan-schedule/schedule-params')
  assert.ok(Math.abs(periodicRate(parseScheduleParams(rateInput('flat'))) - 0.1 / 12) < 1e-12)
  assert.ok(Math.abs(periodicRate(parseScheduleParams(rateInput('flat', { quoteType: 'daily', ratePpm: '100' }))) - 0.003) < 1e-12)
  assert.ok(Math.abs(periodicRate(parseScheduleParams(repaymentInput('interest_only', 8333))) - 0.008333) < 1e-6)
})
