const { ledgerError } = require('../ledger-errors')
const { parseMinorUnits } = require('../money')
const { isDate } = require('./schedule-dates')

const MAX_TERMS = 600
const METHODS = new Set(['flat', 'equal_payment', 'equal_principal', 'interest_only'])
const QUOTE_TYPES = new Set(['annual', 'monthly', 'daily', 'installment'])

function minor(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw ledgerError('VALIDATION_ERROR')
    return null
  }
  const parsed = Number(parseMinorUnits(value, { allowZero: true }))
  if (!Number.isSafeInteger(parsed)) throw ledgerError('VALIDATION_ERROR')
  return parsed
}

function parseScheduleParams(data, { requirePrincipal = true } = {}) {
  const source = data || {}
  const principalMinor = minor(source.principalMinor, { required: requirePrincipal })
  if (requirePrincipal && !(principalMinor > 0)) throw ledgerError('VALIDATION_ERROR')
  if (!METHODS.has(source.scheduleMethod) || !Number.isInteger(source.scheduleTerms) ||
    source.scheduleTerms < 1 || source.scheduleTerms > MAX_TERMS) throw ledgerError('VALIDATION_ERROR')
  const kind = source.measurementKind
  if (kind !== 'rate' && kind !== 'repayment') throw ledgerError('VALIDATION_ERROR')
  const ratePpm = minor(source.ratePpm)
  const repaymentMinor = minor(source.repaymentMinor)
  const quoteType = source.quoteType == null || source.quoteType === '' ? null : source.quoteType
  if (kind === 'rate') {
    if (!QUOTE_TYPES.has(quoteType) || ratePpm == null || repaymentMinor != null) throw ledgerError('VALIDATION_ERROR')
  } else if (repaymentMinor == null || quoteType != null || ratePpm != null) throw ledgerError('VALIDATION_ERROR')
  if (quoteType === 'installment' && source.scheduleMethod !== 'flat') throw ledgerError('VALIDATION_ERROR')
  const feePerTermMinor = minor(source.feePerTermMinor) || 0
  const feeUpfrontMinor = minor(source.feeUpfrontMinor) || 0
  if (principalMinor != null && feeUpfrontMinor >= principalMinor) throw ledgerError('VALIDATION_ERROR')
  const firstPaymentDate = source.firstPaymentDate == null || source.firstPaymentDate === '' ? null : source.firstPaymentDate
  if (firstPaymentDate != null && !isDate(firstPaymentDate)) throw ledgerError('VALIDATION_ERROR')
  const discountKind = source.discountKind || null, discountValue = minor(source.discountValue)
  if ((discountKind === null) !== (discountValue === null) || (discountKind && !['interest_rate','per_period','total'].includes(discountKind)) ||
    (discountKind && !(discountValue > 0)) || (discountKind === 'interest_rate' && discountValue > 1000000)) throw ledgerError('VALIDATION_ERROR')
  const params = { principalMinor, terms: source.scheduleTerms, method: source.scheduleMethod,
    measurement: { kind, quoteType, ratePpm, repaymentMinor }, feePerTermMinor, feeUpfrontMinor, firstPaymentDate, discountKind, discountValue }
  validateRepaymentMeasurement(params)
  return params
}

function validateRepaymentMeasurement(params) {
  if (params.measurement.kind !== 'repayment') return
  const payment = params.measurement.repaymentMinor
  const minimumPrincipal = params.method === 'interest_only' ? 0 : Math.round(params.principalMinor / params.terms)
  if (!(payment > 0) && params.method !== 'interest_only') throw ledgerError('VALIDATION_ERROR')
  if (params.method === 'equal_payment' && payment * params.terms + Math.max(5, params.terms) < params.principalMinor) throw ledgerError('VALIDATION_ERROR')
  if ((params.method === 'flat' || params.method === 'equal_principal') && payment < minimumPrincipal) throw ledgerError('VALIDATION_ERROR')
}

module.exports = { MAX_TERMS, METHODS, QUOTE_TYPES, parseScheduleParams, validateRepaymentMeasurement }
