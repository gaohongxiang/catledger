const crypto = require('node:crypto')

const { importError } = require('./errors')
const { validateUuid } = require('./validation')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function stableValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw importError('VALIDATION_ERROR')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen))
  if (!value || typeof value !== 'object' || seen.has(value)) throw importError('VALIDATION_ERROR')

  seen.add(value)
  const normalized = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined || typeof value[key] === 'function') throw importError('VALIDATION_ERROR')
    normalized[key] = stableValue(value[key], seen)
  }
  seen.delete(value)
  return normalized
}

function digestRequest(action, data) {
  return sha256(Buffer.from(JSON.stringify(stableValue({ action, data })), 'utf8'))
}

function digestIdempotencyKey(requestId) {
  return sha256(Buffer.from(`catledger-import-request-v1\u0000${validateUuid(requestId)}`, 'utf8'))
}

function encodeLengthPrefixed(values) {
  return Buffer.from(values.map((value) => {
    const text = String(value)
    return `${Buffer.byteLength(text, 'utf8')}:${text}`
  }).join(''), 'utf8')
}

function digestParts(...values) {
  return sha256(encodeLengthPrefixed(values))
}

module.exports = {
  digestIdempotencyKey,
  digestParts,
  digestRequest,
  sha256,
  stableValue
}
