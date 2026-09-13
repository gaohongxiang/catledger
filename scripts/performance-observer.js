const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')

function createObserver(pool, options = {}) {
  let current
  function reset() { current = { sqlCount: 0, sqlMs: 0, userLockHoldMs: 0, userLockWaitMs: 0, calls: new Map() } }
  reset()
  return {
    reset,
    snapshot() {
      return { sqlCount: current.sqlCount, sqlMs: current.sqlMs, userLockHoldMs: current.userLockHoldMs, userLockWaitMs: current.userLockWaitMs,
        sqlFingerprints: [...current.calls.values()].sort((a, b) => b.ms - a.ms) }
    },
    pool: { async getConnection() {
      const connection = await pool.getConnection()
      let acquired = null
      return new Proxy(connection, { get(target, key) {
        if (!['execute', 'query', 'beginTransaction', 'commit', 'rollback'].includes(key)) {
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        }
        return async (...args) => {
          const sql = typeof args[0] === 'string' ? args[0] : key
          const fingerprint = createHash('sha256').update(sql.replace(/\(\?(?:,\s*\?)*\)/g, '(?)').replace(/\s+/g, ' ')).digest('hex').slice(0, 16)
          const callsite = (new Error().stack.match(/catledger-(?:api|import)\/src\/[\w-]+\.js:\d+/) || ['transaction-control'])[0]
          const id = fingerprint + ':' + callsite
          const record = current.calls.get(id) || { fingerprint, callsite, count: 0, ms: 0, rows: 0 }
          current.calls.set(id, record)
          current.sqlCount++; record.count++
          const start = performance.now()
          try {
            const result = await target[key](...args)
            if (/SELECT uid FROM catledger_users[\s\S]*FOR UPDATE/i.test(sql)) {
              acquired = performance.now(); current.userLockWaitMs += acquired - start
              if (options.onUserLock) options.onUserLock()
            }
            if (Array.isArray(result)) record.rows += Array.isArray(result[0]) ? result[0].length : Number(result[0].affectedRows || 0)
            return result
          } finally {
            const elapsed = performance.now() - start
            current.sqlMs += elapsed; record.ms += elapsed
            if (['commit', 'rollback'].includes(key) && acquired !== null) { current.userLockHoldMs += performance.now() - acquired; acquired = null }
          }
        }
      } })
    } }
  }
}
module.exports = { createObserver }
