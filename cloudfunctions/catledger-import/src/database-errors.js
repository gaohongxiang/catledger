const { randomInt } = require('node:crypto')

const RETRYABLE_DATABASE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'ER_CON_COUNT_ERROR',
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_SERVER_SHUTDOWN',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'
])

function databaseErrorCode(error) {
  let current = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current.code === 'string') return current.code
    current = current.cause
  }
  return ''
}

function isRetryableDatabaseError(error) {
  return RETRYABLE_DATABASE_CODES.has(databaseErrorCode(error))
}

async function safeRollback(connection) {
  if (!connection || typeof connection.rollback !== 'function') return
  try {
    await connection.rollback()
  } catch (error) {
    // Preserve the original failure and retry with a fresh pooled connection.
  }
}

async function waitBeforeDatabaseRetry(attempt) {
  const maximumDelayMs = Math.min(160, 16 * (2 ** attempt))
  const delayMs = randomInt(1, maximumDelayMs + 1)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

module.exports = {
  databaseErrorCode,
  isRetryableDatabaseError,
  safeRollback,
  waitBeforeDatabaseRetry
}
