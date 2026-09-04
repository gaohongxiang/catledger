const crypto = require('node:crypto')

const { PUBLIC_ERROR_CODES, failure } = require('./errors')
const { databaseErrorCode, isRetryableDatabaseError } = require('./database-errors')

const IDENTITY_FIELDS = ['uid', 'openid', 'openId', 'OPENID']
const DIAGNOSTIC_PHASES = new Set([
  'select_file',
  'download_file',
  'validate_file',
  'parse_file',
  'persist_file'
])

function inspectClientData(event) {
  const pending = [event]
  const visited = new Set()
  let inspected = 0
  while (pending.length > 0) {
    const value = pending.pop()
    if (!value || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    inspected += 1
    if (inspected > 1000) return 'too-complex'
    if (IDENTITY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field))) return 'identity'
    for (const child of Object.values(value)) pending.push(child)
  }
  return null
}

function hashWechatSubject(openid) {
  return crypto.createHash('sha256').update(`wechat-mini:${openid}`, 'utf8').digest('hex')
}

function traceIdFromContext(context) {
  const value = context && (context.request_id || context.requestId)
  return typeof value === 'string' && value.length <= 128 ? value : 'unavailable'
}

function writeLog(logger, level, entry) {
  const method = logger && typeof logger[level] === 'function'
    ? logger[level]
    : logger && typeof logger.log === 'function' ? logger.log : null
  if (method) method.call(logger, entry)
}

function createHandler({ getWxContext, services, logger = console, now = Date.now, slowThresholdMs = 1000 }) {
  return async function handler(event = {}, context = {}) {
    const startedAt = now()
    const action = event.action
    const actionHandler = services[action]
    if (typeof actionHandler !== 'function') return failure('UNSUPPORTED_ACTION')
    const publicData = event.data && typeof event.data === 'object' ? event.data : {}
    const clientDataIssue = inspectClientData(publicData)
    if (clientDataIssue) return failure(clientDataIssue === 'identity' ? 'INVALID_REQUEST' : 'VALIDATION_ERROR')

    try {
      const { OPENID } = getWxContext() || {}
      if (!OPENID) return failure('AUTH_REQUIRED')
      const result = await actionHandler({
        provider: 'wechat-mini',
        subjectHash: hashWechatSubject(OPENID),
        data: publicData
      })
      const elapsedMs = Math.max(0, now() - startedAt)
      if (elapsedMs >= slowThresholdMs) {
        writeLog(logger, 'warn', {
          event: 'catledger-import-slow',
          action: typeof action === 'string' ? action : 'invalid',
          traceId: traceIdFromContext(context),
          elapsedMs
        })
      }
      return { ok: true, data: result }
    } catch (error) {
      const code = PUBLIC_ERROR_CODES.has(error.publicCode)
        ? error.publicCode
        : isRetryableDatabaseError(error) ? 'SERVICE_TEMPORARY_UNAVAILABLE' : 'INTERNAL_ERROR'
      const failureLog = {
        event: 'catledger-import-failure',
        action: typeof action === 'string' ? action : 'invalid',
        traceId: traceIdFromContext(context),
        code,
        databaseCode: databaseErrorCode(error) || undefined,
        elapsedMs: Math.max(0, now() - startedAt)
      }
      if (DIAGNOSTIC_PHASES.has(error && error.diagnosticPhase)) failureLog.phase = error.diagnosticPhase
      writeLog(logger, 'error', failureLog)
      return failure(code)
    }
  }
}

module.exports = {
  createHandler,
  hashWechatSubject,
  inspectClientData,
  traceIdFromContext
}
