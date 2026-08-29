class AccountNameValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AccountNameValidationError'
    this.publicCode = 'VALIDATION_ERROR'
  }
}

function normalizeAccountName(value) {
  if (typeof value !== 'string') {
    throw new AccountNameValidationError('Account name must be text')
  }

  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  const length = Array.from(name).length

  if (length < 1 || length > 32) {
    throw new AccountNameValidationError('Account name length is invalid')
  }

  return {
    name,
    normalizedName: name.toLocaleLowerCase('zh-CN')
  }
}

module.exports = {
  AccountNameValidationError,
  normalizeAccountName
}
