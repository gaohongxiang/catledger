// 分期参数（选填）表单状态与校验的纯函数；口径与计算器 loan-form-model/repayment-entry 一致，金额一律整数分字符串。
const money = require('../../utils/money')
const { addMinor } = require('../../utils/minor-arithmetic')

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
const MEASUREMENT_OPTIONS = [{ value: 'rate', label: '按利率' }, { value: 'repayment', label: '按还款额' }]
const METHOD_LABELS = Object.fromEntries(METHOD_OPTIONS.map(option => [option.value, option.label]))
const MAX_TERMS = 600

function blank() {
  return { terms: '', methodIndex: 0, measurementIndex: 0, quoteIndex: 0, ratePercent: '', repaymentYuan: '', feePerTermYuan: '', feeUpfrontYuan: '', firstPaymentDate: '' }
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
  state.quoteIndex = indexOf(QUOTE_OPTIONS, loan.quoteType || 'annual')
  state.ratePercent = loan.measurementKind === 'rate' && loan.ratePpm != null ? ppmToPercent(loan.ratePpm) : ''
  state.repaymentYuan = loan.measurementKind === 'repayment' && loan.repaymentMinor != null ? money.minorToYuan(loan.repaymentMinor) : ''
  state.feePerTermYuan = loan.feePerTermMinor == null ? '' : money.minorToYuan(loan.feePerTermMinor)
  state.feeUpfrontYuan = loan.feeUpfrontMinor == null ? '' : money.minorToYuan(loan.feeUpfrontMinor)
  state.firstPaymentDate = loan.firstPaymentDate || ''
  return state
}

function touched(state) {
  return ['terms', 'ratePercent', 'repaymentYuan', 'feePerTermYuan', 'feeUpfrontYuan', 'firstPaymentDate']
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
    if (!form.firstPaymentDate) throw new Error('按还款额测算必须选择首次还款日')
    const label = repaymentLabel(method)
    const repaymentText = String(form.repaymentYuan == null ? '' : form.repaymentYuan).trim()
    if (repaymentText === '') throw new Error('请填写' + label)
    repaymentMinor = money.yuanToMinor(repaymentText, { allowZero: method === 'interest_only' })
    if (method !== 'interest_only') {
      if (principalMinor == null || principalMinor === '0') throw new Error('按' + label + '测算前请先填写已确认本金')
      const principal = Number(principalMinor)
      const payment = Number(repaymentMinor)
      if (method === 'equal_payment' && payment * terms + Math.round(Math.max(0.05, terms * 0.01) * 100) < principal) {
        throw new Error('总还款不能低于已确认本金')
      }
      if ((method === 'flat' || method === 'equal_principal') && payment + 1 < principal / terms) {
        throw new Error(method === 'equal_principal' ? '首期应还不能低于每期本金' : '每期应还不能低于每期本金')
      }
    }
  }
  return {
    scheduleMethod: method, scheduleTerms: terms, measurementKind: measurement,
    quoteType: measurement === 'rate' ? quote : null, ratePpm, repaymentMinor,
    feePerTermMinor, feeUpfrontMinor, firstPaymentDate: form.firstPaymentDate || null
  }
}

// 每期费率口径与等本等息互锁：选每期费率时强制等本等息；每期费率下改选其他方式时回到年利率。
function selectQuote(state, index) {
  const form = Object.assign(blank(), state || {}, { quoteIndex: Number(index) || 0 })
  if ((QUOTE_OPTIONS[form.quoteIndex] || QUOTE_OPTIONS[0]).value === 'installment') form.methodIndex = 0
  return form
}

function selectMethod(state, index) {
  const form = Object.assign(blank(), state || {}, { methodIndex: Number(index) || 0 })
  if ((QUOTE_OPTIONS[form.quoteIndex] || QUOTE_OPTIONS[0]).value === 'installment' && form.methodIndex !== 0) form.quoteIndex = 0
  return form
}

module.exports = {
  METHOD_OPTIONS, QUOTE_OPTIONS, MEASUREMENT_OPTIONS, METHOD_LABELS, MAX_TERMS,
  blank, fromLoan, payload, selectQuote, selectMethod, percentToPpm, ppmToPercent, repaymentLabel
}
