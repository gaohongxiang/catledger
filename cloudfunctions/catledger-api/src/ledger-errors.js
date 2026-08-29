class LedgerError extends Error {
  constructor(publicCode, message) {
    super(message || publicCode)
    this.name = 'LedgerError'
    this.publicCode = publicCode
  }
}

function ledgerError(publicCode, message) {
  return new LedgerError(publicCode, message)
}

module.exports = {
  LedgerError,
  ledgerError
}
