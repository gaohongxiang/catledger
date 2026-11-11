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
  const result = buildSchedule(rateInput('flat', { principalRounding: 'cent' }))
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
  const result = buildSchedule(repaymentInput('flat', 90000, { principalRounding: 'cent' }))
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
  assert.throws(() => buildSchedule(rateInput('flat', { scheduleTerms: 601 })), { publicCode: 'SCHEDULE_TERMS_INVALID' })
  assert.throws(() => buildSchedule(rateInput('flat', { scheduleTerms: 0 })), { publicCode: 'SCHEDULE_TERMS_INVALID' })
})

test('parameter pairing and semantic violations are rejected', () => {
  const invalid = [
    rateInput('unknown_method'),
    rateInput('flat', { scheduleTerms: 1.5 }),
    rateInput('flat', { measurementKind: 'unknown' }),
    rateInput('flat', { quoteType: null }),
    rateInput('flat', { ratePpm: null }),
    rateInput('flat', { quoteType: 'quarterly' }),
    rateInput('equal_payment', { quoteType: 'installment' }),
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
  for (const input of invalid) assert.throws(() => buildSchedule(input), (e) => /^SCHEDULE_/.test(e && e.publicCode), JSON.stringify(input))
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

// 方案A：本金整元平摊（到元）——默认到分不受影响，到元让逐期本金跟银行账单一致。
test('整元平摊：26000/18 得 1444×17 + 1452，本金合计守恒，利息不受影响', () => {
  const cent = buildSchedule({ principalMinor: '2600000', scheduleMethod: 'flat', scheduleTerms: 18,
    measurementKind: 'rate', quoteType: 'installment', ratePpm: '9000', principalRounding: 'cent' })
  // 显式到分：1444.44 分位，末期吃尾差
  assert.equal(cent.periods[0].principalMinor, 144444)
  assert.equal(cent.periods.at(-1).principalMinor, 144452)
  assertSchedule(cent, 18, 2600000, 'cent flat')

  const yuan = buildSchedule({ principalMinor: '2600000', scheduleMethod: 'flat', scheduleTerms: 18,
    measurementKind: 'rate', quoteType: 'installment', ratePpm: '9000' })
  // 默认到元：前 17 期整 1444，末期 1452
  for (let i = 0; i < 17; i += 1) assert.equal(yuan.periods[i].principalMinor, 144400, `yuan period ${i + 1}`)
  assert.equal(yuan.periods.at(-1).principalMinor, 145200)
  assertSchedule(yuan, 18, 2600000, 'yuan flat')
  // 利息按原始本金固定：每期 234（26000×0.9%），与取整口径无关
  assert.ok(yuan.periods.every(row => row.interestMinor === 23400))
  assert.equal(yuan.summary.totalInterestMinor, 421200)
})

test('整元平摊等额本金：本金仍整元，利息按剩余本金递减不变', () => {
  const cent = buildSchedule(rateInput('equal_principal', { principalMinor: '2600000', scheduleTerms: 18, ratePpm: '9000', quoteType: 'monthly', principalRounding: 'cent' }))
  const yuan = buildSchedule(rateInput('equal_principal', { principalMinor: '2600000', scheduleTerms: 18, ratePpm: '9000', quoteType: 'monthly', principalRounding: 'yuan' }))
  assert.equal(yuan.periods[0].principalMinor, 144400)
  assert.equal(yuan.periods.at(-1).principalMinor, 145200)
  assertSchedule(yuan, 18, 2600000, 'yuan equal_principal')
  // 首期利息与到分一致（首期剩余=全额本金，按 0.9%/月）
  assert.equal(yuan.periods[0].interestMinor, cent.periods[0].interestMinor)
})

test('整元平摊在已还期次之后仍守恒：historicalPaidTerms 只切片，不改金额', () => {
  const { remainingSchedule } = require('../cloudfunctions/catledger-api/src/loan-installment')
  const out = remainingSchedule({ principalMinor: '2600000', scheduleMethod: 'flat', scheduleTerms: 18,
    measurementKind: 'rate', quoteType: 'installment', ratePpm: '9000', principalRounding: 'yuan',
    installmentSetup: { schema: 1, originalPrincipalMinor: '2600000', historicalPaidTerms: 6, recordType: '', customRecordType: '', discountKind: null, discountValue: null } })
  // 已还前 6 期，剩第 7~18 期共 12 期；前 11 期整 1444，末期仍是 1452（切片不改末期金额）
  assert.equal(out.periods.length, 12)
  for (let i = 0; i < 11; i += 1) assert.equal(out.periods[i].principalMinor, 144400)
  assert.equal(out.periods.at(-1).principalMinor, 145200)
  assert.equal(out.periods.reduce((sum, row) => sum + row.principalMinor, 0), 2600000 - 6 * 144400)
})

// 块1：参数校验出结构化错误码 + fields，供前端点名高亮（不再笼统"请检查填写内容"）。
test('结构化校验错误码带字段：冲突/缺项/过低各有明确 code', () => {
  const { parseScheduleParams } = require('../cloudfunctions/catledger-api/src/loan-schedule/schedule-params')
  const base = { principalMinor: '1962890', scheduleMethod: 'flat', scheduleTerms: 6, measurementKind: 'rate',
    quoteType: 'monthly', ratePpm: '7576', principalRounding: 'yuan' }
  // rate 口径残留还款额 → 以利率为准，自动忽略还款额（不再报冲突）
  {
    const p = parseScheduleParams({ ...base, repaymentMinor: '342018' })
    assert.equal(p.measurement.ratePpm, 7576)
    assert.equal(p.measurement.repaymentMinor, null)
  }
  // repayment 口径残留利率/口径 → 以还款额为准，忽略利率与口径
  {
    const p = parseScheduleParams({ principalMinor: '1962890', scheduleMethod: 'flat', scheduleTerms: 6,
      measurementKind: 'repayment', repaymentMinor: '342018', ratePpm: '7576', principalRounding: 'yuan' })
    assert.equal(p.measurement.repaymentMinor, 342018)
    assert.equal(p.measurement.ratePpm, null)
    assert.equal(p.measurement.quoteType, null)
  }
  // 利率口径缺 quoteType
  assert.throws(() => parseScheduleParams({ ...base, quoteType: null }),
    e => e.publicCode === 'SCHEDULE_QUOTE_REQUIRED' && e.fields.includes('quoteType'))
  // 每期应还低于每期本金
  assert.throws(() => parseScheduleParams({ principalMinor: '1000000', scheduleMethod: 'flat', scheduleTerms: 12,
    measurementKind: 'repayment', repaymentMinor: '100', principalRounding: 'yuan' }),
    e => e.publicCode === 'SCHEDULE_PAYMENT_TOO_LOW' && e.fields.includes('repaymentMinor'))
  // 每期费率只配等本等息
  assert.throws(() => parseScheduleParams({ ...base, scheduleMethod: 'equal_payment', quoteType: 'installment' }),
    e => e.publicCode === 'SCHEDULE_INSTALLMENT_NEEDS_FLAT')
  // 一次性费用≥本金
  assert.throws(() => parseScheduleParams({ ...base, feeUpfrontMinor: '1962890' }),
    e => e.publicCode === 'SCHEDULE_UPFRONT_FEE_TOO_HIGH' && e.fields.includes('feeUpfrontMinor'))
  // 默认到元：不传 principalRounding 时按 yuan
  const p = parseScheduleParams({ principalMinor: '1962890', scheduleMethod: 'flat', scheduleTerms: 6,
    measurementKind: 'rate', quoteType: 'monthly', ratePpm: '7576' })
  assert.equal(p.principalRounding, 'yuan')
  // 显式 cent 仍可
  assert.equal(parseScheduleParams({ ...base, principalRounding: 'cent' }).principalRounding, 'cent')
})

test('handler 把结构化错误码翻成人话并透传 fields', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/catledger-api/src/handler.js'), 'utf8')
  assert.match(src, /SCHEDULE_FIELD_CONFLICT: '.*不一致/)
  assert.match(src, /SCHEDULE_PAYMENT_TOO_LOW: '每期应还不能低于每期本金'/)
  assert.match(src, /failure\(code, error\.fields\)/)
})

// 日利率按「实际天数」计息：以真实借据为基准（3000元 / 6期 / 日利率0.045% / 起息2018-11-30 / 首还2018-12-18）。
// 每期利息 = 期初剩余本金 × 0.045% × 实际天数；首期 11/30→12/18 = 18 天。
test('日利率 + 等额本金：按实际天数计息，逐期利息与借据一致', () => {
  const result = buildSchedule({
    principalMinor: '300000', scheduleMethod: 'equal_principal', scheduleTerms: 6,
    measurementKind: 'rate', quoteType: 'daily', ratePpm: '450',
    principalRounding: 'yuan', firstPaymentDate: '2018-12-18', interestStartDate: '2018-11-30',
    feePerTermMinor: '0', feeUpfrontMinor: '0'
  })
  const interest = result.periods.map(row => row.interestMinor)
  const payment = result.periods.map(row => row.paymentMinor)
  // 借据每期「含利息」：24.30 / 34.88 / 27.90 / 18.90 / 13.95 / 6.75（分）
  assert.deepEqual(interest, [2430, 3488, 2790, 1890, 1395, 675])
  // 每期本金固定 500，月供 = 500 + 利息
  assert.deepEqual(result.periods.map(row => row.principalMinor), [50000, 50000, 50000, 50000, 50000, 50000])
  assert.deepEqual(payment, [52430, 53488, 52790, 51890, 51395, 50675])
  // 利息合计 126.68
  assert.equal(interest.reduce((a, b) => a + b, 0), 12668)
})

test('日利率未填起息日时，默认首期还款日前一个月起算（首期天数按月序列口径）', () => {
  const withDate = buildSchedule({
    principalMinor: '300000', scheduleMethod: 'equal_principal', scheduleTerms: 6,
    measurementKind: 'rate', quoteType: 'daily', ratePpm: '450',
    principalRounding: 'yuan', firstPaymentDate: '2018-12-18', interestStartDate: '2018-11-30'
  })
  const noDate = buildSchedule({
    principalMinor: '300000', scheduleMethod: 'equal_principal', scheduleTerms: 6,
    measurementKind: 'rate', quoteType: 'daily', ratePpm: '450',
    principalRounding: 'yuan', firstPaymentDate: '2018-12-18'
  })
  // 不填起息日时首期从「首还日往前一个月」(2018-11-18) 起，天数不同 → 首期利息不同，但仍能出完整计划。
  assert.equal(noDate.periods.length, 6)
  assert.notEqual(noDate.periods[0].interestMinor, withDate.periods[0].interestMinor)
})

test('年利率 / 月利率口径不受实际天数改动影响（仍按月简化）', () => {
  const annual = buildSchedule(rateInput('equal_principal'))
  // 年利率口径：月利率 = 10% / 12，首期利息 = round(1000000 × 0.10/12) = 8333
  assert.equal(annual.periods[0].interestMinor, 8333)
})

// 回归：到分本金必须「向下取整」，尾差进末期，才能与网贷流水逐分一致。
// 7000元 / 9期 / 日利率0.045% / 起息2018-06-25（前7天免息后）/ 首还2018-07-18。
test('日利率+到分：本金向下取整，逐期应还与利息与真实流水 9/9 一致', () => {
  const result = buildSchedule({
    principalMinor: '700000', scheduleMethod: 'equal_principal', scheduleTerms: 9,
    measurementKind: 'rate', quoteType: 'daily', ratePpm: '450',
    principalRounding: 'cent', firstPaymentDate: '2018-07-18', interestStartDate: '2018-06-25',
    feePerTermMinor: '0', feeUpfrontMinor: '0'
  })
  // 真实流水：应还 / 利息（分）
  const pay = [85022, 86457, 85372, 84077, 83202, 81977, 81032, 79947, 78764]
  const interest = [7245, 8680, 7595, 6300, 5425, 4200, 3255, 2170, 980]
  // 每期本金：前 8 期 77777（777.77），末期吃尾差 77784（777.84）
  const principal = [77777, 77777, 77777, 77777, 77777, 77777, 77777, 77777, 77784]
  assert.deepEqual(result.periods.map(r => r.paymentMinor), pay)
  assert.deepEqual(result.periods.map(r => r.interestMinor), interest)
  assert.deepEqual(result.periods.map(r => r.principalMinor), principal)
})

test('到分本金用向下取整而非四舍五入（7000/9=777.777… → 777.77，不是 777.78）', () => {
  const result = buildSchedule({
    principalMinor: '700000', scheduleMethod: 'equal_principal', scheduleTerms: 9,
    measurementKind: 'rate', quoteType: 'annual', ratePpm: '120000', principalRounding: 'cent',
    firstPaymentDate: '2018-07-18'
  })
  assert.equal(result.periods[0].principalMinor, 77777) // 777.77，向下取整
  assert.equal(result.periods.at(-1).principalMinor, 77784) // 尾差进末期
})

test('后端参数校验：起息日不得晚于或等于首期还款日（否则拒绝，不静默算 0）', () => {
  const { parseScheduleParams } = require('../cloudfunctions/catledger-api/src/loan-schedule/schedule-params')
  const base = { principalMinor: '500000', scheduleMethod: 'equal_principal', scheduleTerms: 6, measurementKind: 'rate',
    quoteType: 'daily', ratePpm: '450', firstPaymentDate: '2018-11-18' }
  assert.doesNotThrow(() => parseScheduleParams({ ...base, interestStartDate: '2018-10-21' }))
  assert.throws(() => parseScheduleParams({ ...base, interestStartDate: '2026-10-18' }), { publicCode: 'SCHEDULE_DATE_INVALID' })
  assert.throws(() => parseScheduleParams({ ...base, interestStartDate: '2018-11-18' }), { publicCode: 'SCHEDULE_DATE_INVALID' })
})

// 首期按起息日天数折算：适用于按月简化的等本等息 / 等额本息（首期不满整月的常见情形）。
// 未填起息日不受影响（保留旧口径），确保历史贷款计算结果不变。
test('等本等息 + 月利率：填起息日后首期利息按天数折算，其余期不变', () => {
  // 15.6万 / 12期 / 月费率0.384% → 每期利息 599.04 元；首还 2024-06-18，起息 2024-05-21（28天）。
  const base = { principalMinor: '15600000', scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate',
    quoteType: 'monthly', ratePpm: '3840', firstPaymentDate: '2024-06-18', principalRounding: 'cent' }
  const noStart = buildSchedule(base)
  const withStart = buildSchedule({ ...base, interestStartDate: '2024-05-21' })
  // 未填起息日：每期利息相同
  assert.equal(noStart.periods[0].interestMinor, noStart.periods[1].interestMinor)
  // 填起息日：首期利息 = round(59904 × 28/30) = 55910（少 39.94 元）
  assert.equal(withStart.periods[0].interestMinor, Math.round(noStart.periods[0].interestMinor * 28 / 30))
  assert.ok(withStart.periods[0].interestMinor < noStart.periods[0].interestMinor)
  // 第 2 期起利息不变
  assert.equal(withStart.periods[1].interestMinor, noStart.periods[1].interestMinor)
  // 本金排期不变，末期余额仍归零
  assert.equal(withStart.periods[0].principalMinor, noStart.periods[0].principalMinor)
  assert.equal(withStart.periods[11].endingBalanceMinor, 0)
})

test('等额本息 + 月利率：填起息日后仅首期应还变小（本金排期不变），后面保持恒定', () => {
  const base = { principalMinor: '1000000', scheduleMethod: 'equal_payment', scheduleTerms: 12, measurementKind: 'rate',
    quoteType: 'monthly', ratePpm: '10000', firstPaymentDate: '2026-09-10', principalRounding: 'cent' }
  const noStart = buildSchedule(base)
  const withStart = buildSchedule({ ...base, interestStartDate: '2026-08-20' })
  // 首期应还变小，但本金部分不变
  assert.ok(withStart.periods[0].paymentMinor < noStart.periods[0].paymentMinor)
  assert.equal(withStart.periods[0].principalMinor, noStart.periods[0].principalMinor)
  // 第 2 期应还保持与未折算一致
  assert.equal(withStart.periods[1].paymentMinor, noStart.periods[1].paymentMinor)
  assert.equal(withStart.periods[11].endingBalanceMinor, 0)
})

test('首期起息日恰好整月（30天）不折算，与不带起息日结果一致', () => {
  const base = { principalMinor: '15600000', scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate',
    quoteType: 'monthly', ratePpm: '3840', firstPaymentDate: '2024-06-18', principalRounding: 'cent' }
  const noStart = buildSchedule(base)
  // 起息 = 首还日前 30 天 → 折算因子=1，结果应与不带起息日完全相同
  const start30 = '2024-05-19' // 2024-05-19 → 2024-06-18 = 30 天
  const withStart = buildSchedule({ ...base, interestStartDate: start30 })
  assert.equal(withStart.periods[0].interestMinor, noStart.periods[0].interestMinor)
})

test('每期费率口径不带起息日折算：首期利息仍按整期费率', () => {
  const base = { principalMinor: '1200000', scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate',
    quoteType: 'installment', ratePpm: '15000', firstPaymentDate: '2024-06-18', principalRounding: 'cent' }
  const noStart = buildSchedule(base)
  const withStart = buildSchedule({ ...base, interestStartDate: '2024-05-21' })
  assert.equal(withStart.periods[0].interestMinor, noStart.periods[0].interestMinor)
})
