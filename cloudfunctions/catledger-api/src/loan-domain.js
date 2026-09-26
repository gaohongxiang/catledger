const { ledgerError } = require('./ledger-errors')
const { parseMinorUnits } = require('./money')
const { parseLocalDate } = require('./local-time')
const { validateId } = require('./transaction-domain')
const { normalizeSetup,parseSetup } = require('./loan-installment')
function text(value, { required = false, max = 80 } = {}) {
  if (value == null || value === '') {
    if (required) throw ledgerError('VALIDATION_ERROR')
    return null
  }
  if (typeof value !== 'string') throw ledgerError('VALIDATION_ERROR')
  const result = value.normalize('NFKC').trim()
  if (Array.from(result).length > max || (required && !result)) throw ledgerError('VALIDATION_ERROR')
  return result || null
}
function date(value) { return value == null || value === '' ? null : parseLocalDate(value).startDate }
const SCHEDULE_METHODS = new Set(['flat','equal_payment','equal_principal','interest_only'])
const QUOTE_TYPES = new Set(['annual','monthly','daily','installment'])
function optionalMinor(value) { return value == null || value === '' ? null : parseMinorUnits(value, { allowZero: true }).toString() }
function scheduleMetadata(data, baselinePrincipalMinor) {
  const scheduleMethod = data.scheduleMethod == null ? null : data.scheduleMethod
  const measurementKind = data.measurementKind == null ? null : data.measurementKind
  const scheduleTerms = data.scheduleTerms == null ? null : data.scheduleTerms
  if ((scheduleMethod === null) !== (scheduleTerms === null) || (scheduleMethod === null) !== (measurementKind === null)) throw ledgerError('VALIDATION_ERROR')
  const quoteType = data.quoteType == null || data.quoteType === '' ? null : data.quoteType
  const ratePpm = optionalMinor(data.ratePpm), repaymentMinor = optionalMinor(data.repaymentMinor)
  const feePerTermMinor = optionalMinor(data.feePerTermMinor), feeUpfrontMinor = optionalMinor(data.feeUpfrontMinor)
  const firstPaymentDate = date(data.firstPaymentDate)
  if (scheduleMethod === null) {
    if (quoteType !== null || ratePpm !== null || repaymentMinor !== null) throw ledgerError('VALIDATION_ERROR')
    return { scheduleMethod: null, scheduleTerms: null, measurementKind: null, quoteType: null, ratePpm: null,
      repaymentMinor: null, feePerTermMinor, feeUpfrontMinor, firstPaymentDate }
  }
  if (!SCHEDULE_METHODS.has(scheduleMethod) || !Number.isInteger(scheduleTerms) || scheduleTerms < 1 || scheduleTerms > 600) throw ledgerError('VALIDATION_ERROR')
  if (measurementKind === 'rate') {
    if (!QUOTE_TYPES.has(quoteType) || ratePpm === null || repaymentMinor !== null) throw ledgerError('VALIDATION_ERROR')
  } else if (measurementKind === 'repayment') {
    if (repaymentMinor === null || quoteType !== null || ratePpm !== null) throw ledgerError('VALIDATION_ERROR')
  } else throw ledgerError('VALIDATION_ERROR')
  if (quoteType === 'installment' && scheduleMethod !== 'flat') throw ledgerError('VALIDATION_ERROR')
  if (feeUpfrontMinor !== null && baselinePrincipalMinor !== null && BigInt(feeUpfrontMinor) >= BigInt(baselinePrincipalMinor)) throw ledgerError('VALIDATION_ERROR')
  return { scheduleMethod, scheduleTerms, measurementKind, quoteType, ratePpm, repaymentMinor, feePerTermMinor, feeUpfrontMinor, firstPaymentDate }
}
function loanMetadata(data) {
  const allowed = new Set(['loanId','version','name','institution','kind','accountId','baselinePrincipalMinor','baselineDate','startDate','endDate','repaymentMethod',
    'scheduleMethod','scheduleTerms','measurementKind','quoteType','ratePpm','repaymentMinor','feePerTermMinor','feeUpfrontMinor','firstPaymentDate','installmentSetup','generatePlan','confirmed','sourceItemId','originKind'])
  if (Object.keys(data).some(key => !allowed.has(key))) throw ledgerError('VALIDATION_ERROR')
  if(data.originKind!==undefined&&!['cash_borrowing','recorded_consumption','new_consumption','historical'].includes(data.originKind))throw ledgerError('VALIDATION_ERROR')
  if (!['borrowing','installment'].includes(data.kind)) throw ledgerError('VALIDATION_ERROR')
  const baselinePrincipalMinor = data.baselinePrincipalMinor == null ? null : parseMinorUnits(data.baselinePrincipalMinor, { allowZero: true }).toString()
  const baselineDate = date(data.baselineDate), startDate = date(data.startDate), endDate = date(data.endDate)
  if ((baselinePrincipalMinor === null) !== (baselineDate === null) || (startDate && endDate && startDate > endDate)) throw ledgerError('VALIDATION_ERROR')
  const installmentSetup = normalizeSetup(data.installmentSetup,data.scheduleTerms)
  if (data.generatePlan !== undefined && (data.generatePlan !== true || data.confirmed !== true || !installmentSetup || !data.firstPaymentDate || baselinePrincipalMinor === null)) throw ledgerError('VALIDATION_ERROR')
  return { name: text(data.name, { required: true }), institution: text(data.institution), kind: data.kind,
    accountId: validateId(data.accountId), baselinePrincipalMinor, baselineDate, startDate, endDate, repaymentMethod: text(data.repaymentMethod),
    installmentSetup,...scheduleMetadata(data, installmentSetup ? installmentSetup.originalPrincipalMinor : baselinePrincipalMinor) }
}
function publicLoan(row) {
  const remainingPrincipalMinor = row.remainingPrincipalMinor == null ? null : String(row.remainingPrincipalMinor)
  return { loanId: row.loanId, name: row.name, institution: row.institution, kind: row.kind,
    accountId: row.accountId, accountName: row.accountName, accountArchived: row.accountArchived != null, archived:row.archivedAt!=null,
    currency: 'CNY', installmentSetup:parseSetup(row.installmentSetup), baselinePrincipalMinor: row.baselinePrincipalMinor == null ? null : String(row.baselinePrincipalMinor),
    baselineDate: row.baselineDate, startDate: row.startDate, endDate: row.endDate, repaymentMethod: row.repaymentMethod,
    scheduleMethod: row.scheduleMethod ?? null, scheduleTerms: row.scheduleTerms == null ? null : Number(row.scheduleTerms),
    measurementKind: row.measurementKind ?? null, quoteType: row.quoteType ?? null,
    ratePpm: row.ratePpm == null ? null : String(row.ratePpm), repaymentMinor: row.repaymentMinor == null ? null : String(row.repaymentMinor),
    feePerTermMinor: row.feePerTermMinor == null ? null : String(row.feePerTermMinor),
    feeUpfrontMinor: row.feeUpfrontMinor == null ? null : String(row.feeUpfrontMinor), firstPaymentDate: row.firstPaymentDate ?? null,
    ...(row.installmentSummary ? {installmentSummary:row.installmentSummary} : {}),
    remainingPrincipalMinor, status: remainingPrincipalMinor == null ? 'unknown' : remainingPrincipalMinor === '0' ? 'settled' : 'active', version: Number(row.version) }
}
module.exports = { loanMetadata, publicLoan, text, date }
