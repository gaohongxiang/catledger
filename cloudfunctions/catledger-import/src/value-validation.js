const { importError } = require('./errors')
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validateUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw importError('VALIDATION_ERROR')
  }
  return value.toLowerCase()
}

function validateTimezoneOffset(value) {
  if (!Number.isInteger(value) || value < -840 || value > 840) {
    throw importError('VALIDATION_ERROR')
  }
  return value
}

function validateVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw importError('VALIDATION_ERROR')
  return value
}

module.exports = { validateUuid, validateVersion, validateTimezoneOffset }
