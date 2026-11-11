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
    // Preserve the original database failure; the next attempt uses a new connection.
  }
}

// 连接被拒（ECONNREFUSED）与建连超时（ETIMEDOUT）几乎总是瞬时的：数据库实例切换、连接数瞬时打满、
// 冷启动那一刻 VPC 抖动。index.js 里把 connectTimeout 降到 2s，重试总预算约 0.2s 退避，单次读最多两次
// 尝试、单次写最多四次尝试，都能在云函数超时内完成，不再死等 3s 才把红条抛给首页。
const RETRYABLE_TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT'])

async function waitBeforeDatabaseRetry(attempt) {
  // 传输层抖动通常 <100ms 即恢复；退避上限提到 300ms，让第二次尝试有更高概率落在恢复窗口内，
  // 又不至于在一次失败里连续空转多秒。随机起点避免同一时刻所有并发请求齐步重连。
  const maximumDelayMs = Math.min(300, 50 * (2 ** attempt))
  const delayMs = randomInt(1, maximumDelayMs + 1)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

module.exports = {
  databaseErrorCode,
  isRetryableDatabaseError,
  isRetryableTransportError: (error) => RETRYABLE_TRANSPORT_CODES.has(databaseErrorCode(error)),
  safeRollback,
  waitBeforeDatabaseRetry
}
