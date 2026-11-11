const { ledgerError } = require('../ledger-errors')
const { monthlyIrr } = require('./cashflow')
const { addMonths, scheduleAnchor, differenceInDays, isDate } = require('./schedule-dates')
const { parseScheduleParams } = require('./schedule-params')

function quotedPeriodicRate(quoteType, ratePpm) {
  const quoted = ratePpm / 1000000
  if (quoteType === 'daily') return quoted * 30
  if (quoteType === 'monthly' || quoteType === 'installment') return quoted
  return quoted / 12
}

function inferredRepaymentRate(params) {
  const principal = params.principalMinor
  const terms = params.terms
  const payment = params.measurement.repaymentMinor
  const principalPerTermAmount = principalPerTerm(principal, terms, params.principalRounding)
  if (!(principal > 0) || !(terms > 0)) return 0
  if (params.method === 'equal_payment') {
    const cashflows = [principal]
    for (let index = 0; index < terms; index += 1) cashflows.push(-payment)
    return monthlyIrr(cashflows)
  }
  if (params.method === 'equal_principal') return Math.max(0, (payment - principalPerTermAmount) / principal)
  if (params.method === 'interest_only') return Math.max(0, payment / principal)
  return Math.max(0, (payment * terms - principal) / (principal * terms))
}

function periodicRate(params) {
  return params.measurement.kind === 'rate'
    ? quotedPeriodicRate(params.measurement.quoteType, params.measurement.ratePpm)
    : inferredRepaymentRate(params)
}

function annuityPayment(principal, terms, rate) {
  if (!(rate > 0)) return principal / terms
  const factor = Math.pow(1 + rate, terms)
  return principal * rate * factor / (factor - 1)
}

// 每期本金（前 N−1 期）：无论到元还是到分都「向下取整」，余下的由最后一期吃 balance（尾差进末期）。
// 到分用 Math.floor：7000/9=777.777… → 777.77/期、末期补尾差 777.84，与网贷流水逐分一致；
// 若用四舍五入会得到 777.78，逐期多 1 分、导致利息与流水对不上（历史 bug）。
function principalPerTerm(principal, terms, rounding) {
  if (rounding === 'yuan') {
    const per = Math.floor(principal / terms / 100) * 100
    // 期数多到整元平摊会被压到 0（本金 < 期数×100）时退回按分，避免出现 0 元本金期。
    return per > 0 ? per : Math.floor(principal / terms)
  }
  return Math.floor(principal / terms)
}

function buildSchedule(input, options = {}) {
  const params = parseScheduleParams(input)
  const principal = params.principalMinor
  const terms = params.terms
  const method = params.method
  // 沿用 loan-cost-calculator：利息折扣重新按折后利率计算；现金减免只扣利息/费用。
  const rate = Math.max(0, periodicRate(params)) * (params.discountKind === 'interest_rate' ? params.discountValue / 1000000 : 1)
  const honorMeasurement = params.measurement.kind === 'repayment' && params.discountKind !== 'interest_rate'
  const anchor = scheduleAnchor({
    firstPaymentDate: params.firstPaymentDate,
    baselineDate: options.baselineDate,
    startDate: options.startDate,
    createdDate: options.createdDate,
    referenceDate: options.referenceDate
  })
  // 日利率口径：按「实际天数」计息。每期利息 = 期初剩余本金 × 日利率 × 本期天数；
  // 天数由相邻还款日相减得出，首期 = 起息日(interestStartDate) → 首期还款日。
  // 仅利率口径 + 日利率 + 按本金逐期还的方式（等额本金 / 等本等息 / 先息后本）启用；
  // 等额本息需要年金公式，仍按月简化；年/月利率口径完全不动。
  const dailyRatePpm = params.measurement.kind === 'rate' && params.measurement.quoteType === 'daily'
    ? params.measurement.ratePpm : null
  // 仅「等额本金 / 先息后本」这类按余额逐期还本的方式按实际天数计息；
  // 等额本息需年金公式、等本等息是约定固定费率，二者仍按月简化（×30），不改历史口径。
  const actualDaysMode = dailyRatePpm != null && params.discountKind !== 'interest_rate' && (method === 'equal_principal' || method === 'interest_only')
  const dailyRate = actualDaysMode ? (dailyRatePpm / 1000000) : 0
  const periodDays = []
  if (actualDaysMode) {
    const startPoint = params.interestStartDate && isDate(params.interestStartDate) ? params.interestStartDate : addMonths(anchor, -1)
    let previousDue = startPoint
    for (let index = 1; index <= terms; index += 1) {
      const due = addMonths(anchor, index - 1)
      periodDays.push(Math.max(0, differenceInDays(previousDue, due)))
      previousDue = due
    }
  }
  let balance = principal
  let equalPayment = Math.round(annuityPayment(principal, terms, rate))
  const perTermPrincipal = principalPerTerm(principal, terms, params.principalRounding)
  let fixedInterestTotal = Math.round(principal * rate * terms)
  let fixedInterestPaid = 0
  const enteredPayment = honorMeasurement ? params.measurement.repaymentMinor : 0
  if (honorMeasurement) {
    if (method === 'equal_payment') equalPayment = enteredPayment
    if (method === 'flat' || method === 'interest_only') {
      fixedInterestTotal = method === 'flat'
        ? Math.max(0, enteredPayment * terms - principal)
        : enteredPayment * terms
    }
  }
  const periods = []
  for (let index = 1; index <= terms; index += 1) {
    let principalPart = 0
    let interestPart = 0
    const serviceFee = params.feePerTermMinor
    if (method === 'equal_payment') {
      interestPart = Math.round(balance * rate)
      principalPart = index === terms ? balance : Math.round(equalPayment - interestPart)
      if (principalPart < 0) principalPart = 0
    } else if (method === 'equal_principal') {
      principalPart = index === terms ? balance : perTermPrincipal
      interestPart = Math.round(balance * rate)
      if (honorMeasurement && index === 1) interestPart = Math.max(0, enteredPayment - principalPart)
    } else if (method === 'interest_only') {
      principalPart = index === terms ? balance : 0
      interestPart = index === terms ? fixedInterestTotal - fixedInterestPaid : Math.round(principal * rate)
    } else {
      principalPart = index === terms ? balance : perTermPrincipal
      interestPart = index === terms ? fixedInterestTotal - fixedInterestPaid : Math.round(principal * rate)
    }
    principalPart = Math.max(0, Math.min(balance, principalPart))
    if (actualDaysMode) {
      // 期初剩余本金 × 日利率 × 本期实际天数（先息后本末期本金已结清，利息也只在期末一次计，这里按余额照算）。
      interestPart = Math.round(balance * dailyRate * periodDays[index - 1])
    }
    interestPart = Math.max(0, interestPart)
    const endingBalance = index === terms ? 0 : Math.max(0, balance - principalPart)
    periods.push({ periodNumber: index, dueDate: addMonths(anchor, index - 1),
      principalMinor: principalPart, interestMinor: interestPart, feeMinor: serviceFee,
      paymentMinor: principalPart + interestPart + serviceFee, endingBalanceMinor: endingBalance })
    if (method === 'flat' || method === 'interest_only') fixedInterestPaid += interestPart
    balance = endingBalance
  }
  const unsafe = value => !Number.isSafeInteger(value) || value < 0
  if (periods.some(row => Object.values(row).some(value => typeof value === 'number' && unsafe(value)))) throw ledgerError('VALIDATION_ERROR')
  if (params.discountKind === 'per_period' || params.discountKind === 'total') {
    const costs = periods.map(row => BigInt(row.interestMinor) + BigInt(row.feeMinor))
    const totalCost = costs.reduce((sum,cost) => sum + cost,0n)
    const requested = BigInt(params.discountValue), discountTotal = requested < totalCost ? requested : totalCost
    let remaining = discountTotal, remainingCost = totalCost
    periods.forEach((row,index) => {
      const cost = costs[index]
      let cut = params.discountKind === 'per_period' ? (requested < cost ? requested : cost) :
        remainingCost === 0n ? 0n : (remaining * cost + remainingCost / 2n) / remainingCost
      if (cut > cost) cut = cost
      if (params.discountKind === 'total') { remaining -= cut; remainingCost -= cost }
      const feeCut = cut < BigInt(row.feeMinor) ? cut : BigInt(row.feeMinor)
      row.feeMinor -= Number(feeCut); row.interestMinor -= Number(cut - feeCut); row.paymentMinor -= Number(cut)
    })
  }
  const paymentTotal = periods.reduce((sum, row) => sum + row.paymentMinor, 0)
  const summary = {
    totalPaymentMinor: paymentTotal + params.feeUpfrontMinor,
    totalInterestMinor: periods.reduce((sum, row) => sum + row.interestMinor, 0),
    totalFeeMinor: periods.reduce((sum, row) => sum + row.feeMinor, 0) + params.feeUpfrontMinor
  }
  if (params.measurement.kind === 'repayment') summary.derivedRatePpm = Math.round(rate * 12 * 1000000)
  if (Object.values(summary).some(unsafe)) throw ledgerError('VALIDATION_ERROR')
  return { periods, summary }
}

module.exports = { buildSchedule, periodicRate, quotedPeriodicRate, inferredRepaymentRate }
