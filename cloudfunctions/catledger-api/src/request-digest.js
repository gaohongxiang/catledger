const crypto = require('node:crypto')

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (value[key] !== undefined) {
          result[key] = canonicalize(value[key])
        }
        return result
      }, {})
  }

  return value
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function digestRequest(action, data) {
  return sha256(JSON.stringify(canonicalize({ action, data })))
}

function digestIdempotencyKey(requestId) {
  if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) {
    const error = new Error('Mutation requestId must be a UUID')
    error.publicCode = 'VALIDATION_ERROR'
    throw error
  }

  return sha256(requestId.toLowerCase())
}

module.exports = {
  canonicalize,
  digestIdempotencyKey,
  digestRequest
}
