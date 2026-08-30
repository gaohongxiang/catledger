const { ledgerError } = require('./ledger-errors')

function normalizeCategoryName(value) {
  if (typeof value !== 'string') {
    throw ledgerError('VALIDATION_ERROR')
  }
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (Array.from(name).length < 1 || Array.from(name).length > 32) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return {
    name,
    normalizedName: name.toLocaleLowerCase('zh-CN')
  }
}

module.exports = { normalizeCategoryName }
