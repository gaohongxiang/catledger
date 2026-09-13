const { createHmac, timingSafeEqual } = require('node:crypto')
const { importError } = require('./errors')

function sign(secret, value) { return createHmac('sha256', secret).update(value).digest('base64url') }
function encodeCursor(secret, scope, last) {
  const payload = Buffer.from(JSON.stringify({ v: 2, scope, last })).toString('base64url')
  return payload + '.' + sign(secret, payload)
}
function decodeCursor(secret, cursor, scope) {
  if (cursor == null) return null
  if (typeof cursor !== 'string' || cursor.length > 4096) throw importError('INVALID_CURSOR')
  try {
    const [payload, signature, extra] = cursor.split('.')
    const expected = sign(secret, payload)
    if (extra || !signature || signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('signature')
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (value.v !== 2 || !value.scope) throw new Error('version')
    const { viewVersion, ...identity } = value.scope
    const { viewVersion: expectedVersion, ...expectedIdentity } = scope
    if (JSON.stringify(identity) !== JSON.stringify(expectedIdentity)) throw new Error('scope')
    if (viewVersion !== expectedVersion) throw importError('STALE_VIEW')
    return value.last
  } catch (error) { throw error.publicCode === 'STALE_VIEW' ? error : importError('INVALID_CURSOR') }
}
module.exports = { encodeCursor, decodeCursor }
