const { ledgerError } = require('../ledger-errors')
const { parseMinorUnits } = require('../money')
const { isDate } = require('./schedule-dates')

const MAX_TERMS = 600
const METHODS = new Set(['flat', 'equal_payment', 'equal_principal', 'interest_only'])
const QUOTE_TYPES = new Set(['annual', 'monthly', 'daily', 'installment'])
const PRINCIPAL_ROUNDINGS = new Set(['cent', 'yuan'])

// 结构化校验错误：每个失败点带精确 publicCode + fields，供 handler 出中文人话、前端高亮字段。
function minor(value, { required = false, field = 'amount' } = {}) {
  if (value == null || value === '') {
    if (required) throw ledgerError('SCHEDULE_AMOUNT_REQUIRED', null, [field])
    return null
  }
  let parsed
  try {
    parsed = Number(parseMinorUnits(value, { allowZero: true }))
  } catch (error) {
    // 非字符串/格式错/负数等统一转成结构化金额错误，避免漏出笼统的 VALIDATION_ERROR。
    throw ledgerError('SCHEDULE_AMOUNT_INVALID', null, [field])
  }
  if (!Number.isSafeInteger(parsed)) throw ledgerError('SCHEDULE_AMOUNT_INVALID', null, [field])
  return parsed
}

function parseScheduleParams(data, { requirePrincipal = true } = {}) {
  const source = data || {}
  const principalMinor = minor(source.principalMinor, { required: requirePrincipal, field: 'principalMinor' })
  if (requirePrincipal && !(principalMinor > 0)) throw ledgerError('SCHEDULE_PRINCIPAL_REQUIRED', null, ['principalMinor'])
  if (!METHODS.has(source.scheduleMethod)) throw ledgerError('SCHEDULE_METHOD_INVALID', null, ['scheduleMethod'])
  if (!Number.isInteger(source.scheduleTerms) || source.scheduleTerms < 1 || source.scheduleTerms > MAX_TERMS) {
    throw ledgerError('SCHEDULE_TERMS_INVALID', null, ['scheduleTerms'])
  }
  const kind = source.measurementKind
  if (kind !== 'rate' && kind !== 'repayment') throw ledgerError('SCHEDULE_MEASUREMENT_INVALID', null, ['measurementKind'])
  // 以「测算依据(measurementKind)」为唯一口径：选哪个就用哪一组字段，自动忽略另一组的残留（如编辑时把还款额改成利率、
  // 旧还款额还留着），不再因互斥字段报错——用户切到哪就按哪个来。只在真正缺本口径必需字段时才提示。
  let ratePpm = minor(source.ratePpm, { field: 'ratePpm' })
  let repaymentMinor = minor(source.repaymentMinor, { field: 'repaymentMinor' })
  let quoteType = source.quoteType == null || source.quoteType === '' ? null : source.quoteType
  if (kind === 'rate') {
    repaymentMinor = null // 利率口径忽略每期还款额
    if (!QUOTE_TYPES.has(quoteType)) throw ledgerError('SCHEDULE_QUOTE_REQUIRED', null, ['quoteType'])
    if (ratePpm == null) throw ledgerError('SCHEDULE_RATE_REQUIRED', null, ['ratePpm'])
  } else {
    quoteType = null // 还款额口径忽略利率/口径
    ratePpm = null
    if (repaymentMinor == null) throw ledgerError('SCHEDULE_PAYMENT_REQUIRED', null, ['repaymentMinor'])
  }
  if (quoteType === 'installment' && source.scheduleMethod !== 'flat') throw ledgerError('SCHEDULE_INSTALLMENT_NEEDS_FLAT', null, ['scheduleMethod', 'quoteType'])
  const feePerTermMinor = minor(source.feePerTermMinor, { field: 'feePerTermMinor' }) || 0
  const feeUpfrontMinor = minor(source.feeUpfrontMinor, { field: 'feeUpfrontMinor' }) || 0
  if (principalMinor != null && feeUpfrontMinor >= principalMinor) throw ledgerError('SCHEDULE_UPFRONT_FEE_TOO_HIGH', null, ['feeUpfrontMinor'])
  const firstPaymentDate = source.firstPaymentDate == null || source.firstPaymentDate === '' ? null : source.firstPaymentDate
  if (firstPaymentDate != null && !isDate(firstPaymentDate)) throw ledgerError('SCHEDULE_DATE_INVALID', null, ['firstPaymentDate'])
  // 起息日（放款/借款当日）：仅「日利率 + 利率口径」按实际天数计息时用于算第 1 期天数。
  // 其它口径忽略；填了但非法日期则报错（避免静默算错首期）。
  const interestStartDate = source.interestStartDate == null || source.interestStartDate === '' ? null : source.interestStartDate
  if (interestStartDate != null && !isDate(interestStartDate)) throw ledgerError('SCHEDULE_DATE_INVALID', null, ['interestStartDate'])
  // 起息日必须早于首期还款日，否则首期天数为 0/负，会被静默算成 0 利息——直接拒绝，避免用户以为算对了。
  if (interestStartDate != null && firstPaymentDate != null && interestStartDate >= firstPaymentDate) {
    throw ledgerError('SCHEDULE_DATE_INVALID', null, ['interestStartDate'])
  }
  const discountKind = source.discountKind || null, discountValue = minor(source.discountValue, { field: 'discountValue' })
  if ((discountKind === null) !== (discountValue === null) || (discountKind && !['interest_rate','per_period','total'].includes(discountKind)) ||
    (discountKind && !(discountValue > 0)) || (discountKind === 'interest_rate' && discountValue > 1000000)) throw ledgerError('SCHEDULE_DISCOUNT_INVALID', null, ['discountKind', 'discountValue'])
  // 本金取整口径：cent（到分）或 yuan（到元，跟银行账单整元平摊、尾差进末期）。新建默认到元。
  const principalRounding = source.principalRounding == null || source.principalRounding === '' ? 'yuan' : source.principalRounding
  if (!PRINCIPAL_ROUNDINGS.has(principalRounding)) throw ledgerError('SCHEDULE_ROUNDING_INVALID', null, ['principalRounding'])
  const params = { principalMinor, terms: source.scheduleTerms, method: source.scheduleMethod,
    measurement: { kind, quoteType, ratePpm, repaymentMinor }, feePerTermMinor, feeUpfrontMinor, firstPaymentDate, interestStartDate, discountKind, discountValue, principalRounding }
  validateRepaymentMeasurement(params)
  return params
}

function validateRepaymentMeasurement(params) {
  if (params.measurement.kind !== 'repayment') return
  const payment = params.measurement.repaymentMinor
  // 每期本金下限随取整口径走：到分用四舍五入到分，到元用整元（向下取整到 100 分）。
  const minimumPrincipal = params.method === 'interest_only' ? 0 : params.principalRounding === 'yuan'
    ? Math.floor(params.principalMinor / params.terms / 100) * 100 : Math.round(params.principalMinor / params.terms)
  if (!(payment > 0) && params.method !== 'interest_only') throw ledgerError('SCHEDULE_PAYMENT_REQUIRED', null, ['repaymentMinor'])
  if (params.method === 'equal_payment' && payment * params.terms + Math.max(5, params.terms) < params.principalMinor) {
    throw ledgerError('SCHEDULE_PAYMENT_TOO_LOW_TOTAL', null, ['repaymentMinor'])
  }
  if ((params.method === 'flat' || params.method === 'equal_principal') && payment < minimumPrincipal) {
    throw ledgerError('SCHEDULE_PAYMENT_TOO_LOW', null, ['repaymentMinor'])
  }
}

// 分期参数校验的结构化错误码，供 handler 统一配文案与前端高亮字段。
const SCHEDULE_ERROR_CODES = Object.freeze([
  'SCHEDULE_PRINCIPAL_REQUIRED', 'SCHEDULE_METHOD_INVALID', 'SCHEDULE_TERMS_INVALID', 'SCHEDULE_MEASUREMENT_INVALID',
  'SCHEDULE_FIELD_CONFLICT', 'SCHEDULE_QUOTE_REQUIRED', 'SCHEDULE_RATE_REQUIRED', 'SCHEDULE_PAYMENT_REQUIRED',
  'SCHEDULE_INSTALLMENT_NEEDS_FLAT', 'SCHEDULE_AMOUNT_REQUIRED', 'SCHEDULE_AMOUNT_INVALID',
  'SCHEDULE_UPFRONT_FEE_TOO_HIGH', 'SCHEDULE_DATE_INVALID', 'SCHEDULE_DISCOUNT_INVALID', 'SCHEDULE_ROUNDING_INVALID',
  'SCHEDULE_PAYMENT_TOO_LOW', 'SCHEDULE_PAYMENT_TOO_LOW_TOTAL'
])

module.exports = { MAX_TERMS, METHODS, QUOTE_TYPES, SCHEDULE_ERROR_CODES, parseScheduleParams, validateRepaymentMeasurement }
