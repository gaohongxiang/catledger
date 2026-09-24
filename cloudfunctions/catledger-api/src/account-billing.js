const { ledgerError } = require('./ledger-errors')
const { parseMinorUnits } = require('./money')

const FIELDS = ['statementDay', 'repaymentDay', 'creditLimitMinor']

// 省略保留，null 清空；旧客户端只改名时不能擦除账单资料。
function normalizeBilling(data, nature, current = {}) {
  const billing = {}
  for (const field of FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(data, field) ? data[field] : current[field]
    if (value == null) {
      billing[field] = null
    } else if (nature !== 'liability') {
      throw ledgerError('VALIDATION_ERROR')
    } else if (field === 'creditLimitMinor') {
      billing[field] = parseMinorUnits(value, { allowZero: true }).toString()
    } else {
      if (!Number.isInteger(value) || value < 1 || value > 31) throw ledgerError('VALIDATION_ERROR')
      billing[field] = value
    }
  }
  return billing
}

module.exports = { normalizeBilling }
