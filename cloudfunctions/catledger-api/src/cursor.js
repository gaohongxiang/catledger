const crypto = require('node:crypto')

const { ledgerError } = require('./ledger-errors')

function signature(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
}

function encodeCursor(secret, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${payload}.${signature(secret, payload)}`
}

function decodeCursor(secret, value) {
  if (typeof value !== 'string' || value.length > 1024) {
    throw ledgerError('VALIDATION_ERROR')
  }
  const parts = value.split('.')
  if (parts.length !== 2) {
    throw ledgerError('VALIDATION_ERROR')
  }
  const [payload, providedSignature] = parts
  const expectedSignature = signature(secret, payload)
  const provided = Buffer.from(providedSignature)
  const expected = Buffer.from(expectedSignature)
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw ledgerError('VALIDATION_ERROR')
  }

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw ledgerError('VALIDATION_ERROR')
  }
}

module.exports = {
  decodeCursor,
  encodeCursor
}
