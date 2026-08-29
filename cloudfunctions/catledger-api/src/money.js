const MAX_MINOR_UNITS = 9223372036854775807n

class MoneyValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MoneyValidationError'
    this.publicCode = 'VALIDATION_ERROR'
  }
}

function parseMinorUnits(value, { allowZero = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new MoneyValidationError('Amount must be a canonical minor-unit string')
  }

  const amount = BigInt(value)
  if ((!allowZero && amount === 0n) || amount > MAX_MINOR_UNITS) {
    throw new MoneyValidationError('Amount is outside the supported range')
  }

  return amount
}

function minorUnitsToString(value) {
  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value)) {
    return value
  }

  throw new MoneyValidationError('Database amount is not an integer string')
}

module.exports = {
  MAX_MINOR_UNITS,
  MoneyValidationError,
  minorUnitsToString,
  parseMinorUnits
}
