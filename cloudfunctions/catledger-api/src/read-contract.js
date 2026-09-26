const { ledgerError } = require('./ledger-errors')
const READ_VERSION = 1
const READ_ACTIONS = new Set(['loans.chargePlan', 'reads.validate', 'profile.get', 'catalog.get', 'categories.list', 'accounts.list',
  'dashboard.get', 'statistics.get', 'transactions.list', 'transactions.refundable',
  'loans.transaction', 'loans.unassigned', 'loans.payment', 'loans.payments', 'loans.installments', 'loans.installment', 'loans.installmentSources', 'loans.list', 'loans.get'])
function revision(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw ledgerError('VALIDATION_ERROR')
  return value
}
function metadata(uid, dataRevision, unchanged = false) {
  return { readVersion: READ_VERSION, uid, dataRevision: revision(dataRevision), unchanged }
}
module.exports = { READ_VERSION, READ_ACTIONS, revision, metadata }
