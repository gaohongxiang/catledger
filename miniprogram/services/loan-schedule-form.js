// 分期参数（选填）表单状态与校验的纯函数；口径与计算器 loan-form-model/repayment-entry 一致，金额一律整数分字符串。
const money = require('../utils/money')
const { addMinor } = require('../utils/minor-arithmetic')

const METHOD_OPTIONS = [
  { value: 'flat', label: '等本等息' },
  { value: 'equal_payment', label: '等额本息' },
  { value: 'equal_principal', label: '等额本金' },
  { value: 'interest_only', label: '先息后本' }
]
const QUOTE_OPTIONS = [
  { value: 'annual', label: '年利率' },
  { value: 'monthly', label: '月利率' },
  { value: 'daily', label: '日利率' },
  { value: 'installment', label: '每期费率' }
]
const QUOTE_DEFAULT_INDEX = QUOTE_OPTIONS.findIndex(option => option.value === 'monthly')
const MEASUREMENT_OPTIONS = [{ value: 'rate', label: '按利率' }, { value: 'repayment', label: '按还款额' }]
// 本金取整：到元默认（跟银行账单整元平摊一致），到分为历史口径。
const ROUNDING_OPTIONS = [{ value: 'yuan', label: '到元' }, { value: 'cent', label: '到分' }]
const METHOD_LABELS = Object.fromEntries(METHOD_OPTIONS.map(option => [option.value, option.label]))
const MAX_TERMS = 600

function blank() {
  return { terms: '', methodIndex: 0, measurementIndex: 0, quoteIndex: QUOTE_DEFAULT_INDEX, roundingIndex: 0, ratePercent: '', repaymentYuan: '', feePerTermYuan: '', feeUpfrontYuan: '', firstPaymentDate: '', interestStartDate: '', firstPeriodDays: '' }
}

// —— 首期天数 ↔ 起息日 互算（纯函数，按 UTC 零点避免时区误差）——
function isYmd(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value == null ? '' : value)) }
function ymdToUtc(value) { const p = String(value).split('-'); return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) }
function daysBetween(a, b) { return Math.round((ymdToUtc(b) - ymdToUtc(a)) / 86400000) }
function shiftDays(value, days) {
  const utc = ymdToUtc(value) + Number(days || 0) * 86400000
  const d = new Date(utc)
  const pad = n => String(n).padStart(2, '0')
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
}
// 由起息日 + 首还日算首期天数（起息日晚于首还日 → 返回负值，交调用方校验）。
function firstPeriodDaysOf(interestStartDate, firstPaymentDate) {
  if (!isYmd(interestStartDate) || !isYmd(firstPaymentDate)) return null
  return daysBetween(interestStartDate, firstPaymentDate)
}

function percentToPpm(text) {
  const value = String(text == null ? '' : text).trim()
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('请填写正确的利率或费率百分数，不能为负')
  return String(Math.round(Number(value) * 10000))
}

function ppmToPercent(ppm) {
  const digits = String(ppm == null ? '0' : ppm).replace(/^0+(?=\d)/, '')
  const padded = digits.padStart(5, '0')
  const integer = padded.slice(0, -4).replace(/^0+(?=\d)/, '') || '0'
  const fraction = padded.slice(-4).replace(/0+$/, '')
  return fraction ? integer + '.' + fraction : integer
}

function indexOf(options, value) {
  const index = options.findIndex(option => option.value === value)
  return index >= 0 ? index : 0
}

function fromLoan(loan) {
  if (!loan || loan.scheduleMethod == null) return blank()
  const state = blank()
  state.terms = loan.scheduleTerms == null ? '' : String(loan.scheduleTerms)
  state.methodIndex = indexOf(METHOD_OPTIONS, loan.scheduleMethod)
  state.measurementIndex = loan.measurementKind === 'repayment' ? 1 : 0
  state.quoteIndex = indexOf(QUOTE_OPTIONS, loan.quoteType || QUOTE_OPTIONS[QUOTE_DEFAULT_INDEX].value)
  state.ratePercent = loan.measurementKind === 'rate' && loan.ratePpm != null ? ppmToPercent(loan.ratePpm) : ''
  state.repaymentYuan = loan.measurementKind === 'repayment' && loan.repaymentMinor != null ? money.minorToYuan(loan.repaymentMinor) : ''
  state.feePerTermYuan = loan.feePerTermMinor == null ? '' : money.minorToYuan(loan.feePerTermMinor)
  state.feeUpfrontYuan = loan.feeUpfrontMinor == null ? '' : money.minorToYuan(loan.feeUpfrontMinor)
  state.roundingIndex = indexOf(ROUNDING_OPTIONS, loan.principalRounding || 'yuan')
  state.firstPaymentDate = loan.firstPaymentDate || ''
  state.interestStartDate = loan.interestStartDate || (loan.installmentSetup && loan.installmentSetup.interestStartDate) || ''
  state.firstPeriodDays = state.interestStartDate && isYmd(state.firstPaymentDate) ? String(firstPeriodDaysOf(state.interestStartDate, state.firstPaymentDate)) : ''
  return state
}

function touched(state) {
  return ['terms', 'ratePercent', 'repaymentYuan', 'feePerTermYuan', 'feeUpfrontYuan', 'firstPaymentDate', 'interestStartDate']
    .some(field => String(state[field] == null ? '' : state[field]).trim() !== '')
}

function optionalMinor(text, label) {
  const value = String(text == null ? '' : text).trim()
  if (value === '') return null
  try { return money.yuanToMinor(value, { allowZero: true }) } catch (_) { throw new Error('请填写正确的' + label + '，不能为负') }
}

function repaymentLabel(method) {
  return method === 'interest_only' ? '每期利息' : method === 'equal_principal' ? '首期应还' : '每期应还'
}

// 返回 null 表示整区留空（只登记资料）；否则返回随 loans.create/update 一并提交的分期参数，校验失败抛错。
function payload(state, principalYuan) {
  const form = Object.assign(blank(), state || {})
  if (!touched(form)) return null
  const method = METHOD_OPTIONS[form.methodIndex] ? METHOD_OPTIONS[form.methodIndex].value : 'flat'
  const measurement = form.measurementIndex === 1 ? 'repayment' : 'rate'
  const quote = QUOTE_OPTIONS[form.quoteIndex] ? QUOTE_OPTIONS[form.quoteIndex].value : 'annual'
  const rounding = ROUNDING_OPTIONS[form.roundingIndex] ? ROUNDING_OPTIONS[form.roundingIndex].value : 'yuan'
  const termsText = String(form.terms).trim()
  if (!/^\d+$/.test(termsText) || Number(termsText) < 1 || Number(termsText) > MAX_TERMS) throw new Error('分期期数应为 1 到 ' + MAX_TERMS + ' 的整数')
  const terms = Number(termsText)
  if (quote === 'installment' && method !== 'flat') throw new Error('每期费率口径只支持等本等息')
  const principalText = String(principalYuan == null ? '' : principalYuan).trim()
  const principalMinor = principalText === '' ? null : money.yuanToMinor(principalText, { allowZero: true })
  const feePerTermMinor = optionalMinor(form.feePerTermYuan, '每期费用')
  const feeUpfrontMinor = optionalMinor(form.feeUpfrontYuan, '一次性费用')
  if (feeUpfrontMinor != null && principalMinor != null && addMinor(feeUpfrontMinor, '-' + principalMinor).charAt(0) !== '-') {
    throw new Error('一次性费用应小于已确认本金')
  }
  let ratePpm = null
  let repaymentMinor = null
  if (measurement === 'rate') {
    ratePpm = percentToPpm(form.ratePercent)
  } else {
    if (!form.firstPaymentDate) throw new Error('请选择首期还款日')
    const label = repaymentLabel(method)
    const repaymentText = String(form.repaymentYuan == null ? '' : form.repaymentYuan).trim()
    if (repaymentText === '') throw new Error('请填写' + label)
    repaymentMinor = money.yuanToMinor(repaymentText, { allowZero: method === 'interest_only' })
    if (method !== 'interest_only') {
      if (principalMinor == null || principalMinor === '0') throw new Error('按' + label + '测算前请先填写已确认本金')
      const principal = Number(principalMinor)
      const payment = Number(repaymentMinor)
      const perTerm = rounding === 'yuan' ? Math.floor(principal / terms / 100) * 100 : principal / terms
      if (method === 'equal_payment' && payment * terms + Math.round(Math.max(0.05, terms * 0.01) * 100) < principal) {
        throw new Error('总还款不能低于已确认本金')
      }
      if ((method === 'flat' || method === 'equal_principal') && payment + 1 < perTerm) {
        throw new Error(method === 'equal_principal' ? '首期应还不能低于每期本金' : '每期应还不能低于每期本金')
      }
    }
  }
  // 起息日仅在「日利率」口径下有意义（按实际天数计息的首期起点）；其它口径不下发该键，保持契约干净。
  const base = {
    scheduleMethod: method, scheduleTerms: terms, measurementKind: measurement,
    quoteType: measurement === 'rate' ? quote : null, ratePpm, repaymentMinor,
    principalRounding: rounding,
    feePerTermMinor, feeUpfrontMinor, firstPaymentDate: form.firstPaymentDate || null
  }
  if (measurement === 'rate' && quote === 'daily') {
    // 起息日：优先用起息日；只填了首期天数时由首还日反推。二者都基于首还日校验，起息日不得晚于首还日。
    let start = form.interestStartDate || null
    if (!start) {
      const n = Number(String(form.firstPeriodDays).trim())
      if (Number.isInteger(n) && n > 0 && isYmd(form.firstPaymentDate)) start = shiftDays(form.firstPaymentDate, -n)
    }
    if (start) {
      if (!isYmd(form.firstPaymentDate)) throw new Error('请先选择首期还款日')
      if (!isYmd(start)) throw new Error('起息日格式不正确')
      const days = daysBetween(start, form.firstPaymentDate)
      if (days <= 0) throw new Error('起息日不能晚于或等于首期还款日，请检查起息日或首期天数')
      base.interestStartDate = start
    }
  }
  return base
}

// 起息日或首期天数变化时，联动更新另一个字段，保证两者不矛盾。
// source: 'date'（用户改起息日）或 'days'（用户改首期天数）。
function syncFirstPeriod(state, source) {
  const form = Object.assign(blank(), state || {})
  if (!isYmd(form.firstPaymentDate)) return form
  if (source === 'days') {
    const n = Number(String(form.firstPeriodDays).trim())
    if (Number.isInteger(n) && n >= 0) form.interestStartDate = shiftDays(form.firstPaymentDate, -n)
  } else {
    const days = firstPeriodDaysOf(form.interestStartDate, form.firstPaymentDate)
    form.firstPeriodDays = days == null ? '' : String(days)
  }
  return form
}

// 每期费率口径与等本等息互锁：选每期费率时强制等本等息；每期费率下改选其他方式时回到年利率。
function selectQuote(state, index) {
  const form = Object.assign(blank(), state || {}, { quoteIndex: Number(index) || 0 })
  const quote = (QUOTE_OPTIONS[form.quoteIndex] || QUOTE_OPTIONS[0]).value
  if (quote === 'installment') {
    form.methodIndex = 0
    // 每期费率只需百分比，清掉可能残留的每期还款额，避免提交互斥组合。
    form.repaymentYuan = ''
  }
  // 本金取整随口径切换默认：日利率按实际天数计息、网贷账单按分结算，默认「到分」（ROUNDING_OPTIONS 索引1）；
  // 其它口径默认「到元」（索引0，银行整元平摊）。用户切完口径后仍可手动改，切换口径会重设回默认。
  form.roundingIndex = quote === 'daily' ? 1 : 0
  return form
}

function selectMethod(state, index) {
  const form = Object.assign(blank(), state || {}, { methodIndex: Number(index) || 0 })
  if ((QUOTE_OPTIONS[form.quoteIndex] || QUOTE_OPTIONS[0]).value === 'installment' && form.methodIndex !== 0) form.quoteIndex = QUOTE_DEFAULT_INDEX
  return form
}

// 切换测算依据（还款额↔利率）时清空对侧输入，杜绝"既有利率又有还款额"的互斥提交。
function selectMeasurement(state, index) {
  const measurementIndex = Number(index) === 1 ? 1 : 0
  const form = Object.assign(blank(), state || {}, { measurementIndex })
  if (measurementIndex === 1) form.ratePercent = ''
  else form.repaymentYuan = ''
  return form
}

function selectRounding(state, index) {
  const form = Object.assign(blank(), state || {}, { roundingIndex: Number(index) || 0 })
  return form
}

module.exports = {
  METHOD_OPTIONS, QUOTE_OPTIONS, MEASUREMENT_OPTIONS, ROUNDING_OPTIONS, METHOD_LABELS, MAX_TERMS, QUOTE_DEFAULT_INDEX,
  blank, fromLoan, payload, selectQuote, selectMethod, selectMeasurement, selectRounding, percentToPpm, ppmToPercent, repaymentLabel, touched, syncFirstPeriod, firstPeriodDaysOf, daysBetween, shiftDays, isYmd
}
