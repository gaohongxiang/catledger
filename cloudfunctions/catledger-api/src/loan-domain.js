const { ledgerError } = require('./ledger-errors')
const { parseMinorUnits } = require('./money')
const { parseLocalDate } = require('./local-time')
const { validateId } = require('./transaction-domain')
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
function loanMetadata(data) {
  const allowed = new Set(['loanId','version','name','institution','kind','accountId','baselinePrincipalMinor','baselineDate','startDate','endDate','repaymentMethod'])
  if (Object.keys(data).some(key => !allowed.has(key))) throw ledgerError('VALIDATION_ERROR')
  if (!['borrowing','installment'].includes(data.kind)) throw ledgerError('VALIDATION_ERROR')
  const baselinePrincipalMinor = data.baselinePrincipalMinor == null ? null : parseMinorUnits(data.baselinePrincipalMinor, { allowZero: true }).toString()
  const baselineDate = date(data.baselineDate), startDate = date(data.startDate), endDate = date(data.endDate)
  if ((baselinePrincipalMinor === null) !== (baselineDate === null) || (startDate && endDate && startDate > endDate)) throw ledgerError('VALIDATION_ERROR')
  return { name: text(data.name, { required: true }), institution: text(data.institution), kind: data.kind,
    accountId: validateId(data.accountId), baselinePrincipalMinor, baselineDate, startDate, endDate, repaymentMethod: text(data.repaymentMethod) }
}
function publicLoan(row) {
  const remainingPrincipalMinor = row.remainingPrincipalMinor == null ? null : String(row.remainingPrincipalMinor)
  return { loanId: row.loanId, name: row.name, institution: row.institution, kind: row.kind,
    accountId: row.accountId, accountName: row.accountName, accountArchived: row.accountArchived != null,
    currency: 'CNY', baselinePrincipalMinor: row.baselinePrincipalMinor == null ? null : String(row.baselinePrincipalMinor),
    baselineDate: row.baselineDate, startDate: row.startDate, endDate: row.endDate, repaymentMethod: row.repaymentMethod,
    remainingPrincipalMinor, status: remainingPrincipalMinor == null ? 'unknown' : remainingPrincipalMinor === '0' ? 'settled' : 'active', version: Number(row.version) }
}
module.exports = { loanMetadata, publicLoan, text, date }
