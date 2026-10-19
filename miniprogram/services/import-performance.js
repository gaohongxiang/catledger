// Local import diagnostics. Only stages, durations, counts and booleans are
// accepted; raw bill fields, account names and user identifiers never enter
// this record. The ring buffer is deliberately small and best-effort.
const STORAGE_KEY = 'catledger_import_perf_v1'
const MAX_RECORDS = 10
const NUMBER_FIELDS = new Set(['files', 'rows', 'events', 'issues', 'bytes', 'chunks', 'reused'])
const STAGE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

function create({ now = Date.now } = {}) {
  const startedAt = now(), marks = []
  function mark(stage, detail) {
    if (typeof stage !== 'string' || !STAGE_PATTERN.test(stage)) return
    const safe = {}
    if (detail && typeof detail === 'object') {
      for (const key of NUMBER_FIELDS) {
        const value = Number(detail[key])
        if (Number.isFinite(value) && value >= 0) safe[key] = Math.round(value)
      }
      if (detail.inline === true) safe.inline = true
    }
    marks.push({ stage, at: Math.max(0, Math.round(now() - startedAt)), ...safe })
  }
  function finish() {
    return { totalMs: Math.max(0, Math.round(now() - startedAt)), marks: marks.slice(0, 32) }
  }
  return { mark, finish }
}

function storage() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function' ? wx : null
}

function record(trace) {
  if (!trace || typeof trace.finish !== 'function') return null
  const value = trace.finish()
  try {
    const store = storage()
    if (store) {
      const prior = store.getStorageSync(STORAGE_KEY)
      const list = Array.isArray(prior) ? prior.filter(item => item && typeof item === 'object') : []
      list.unshift(value)
      store.setStorageSync(STORAGE_KEY, list.slice(0, MAX_RECORDS))
    }
  } catch (_) { /* diagnostics must never break the import */ }
  return value
}

function recent() {
  try {
    const store = storage(), value = store && store.getStorageSync(STORAGE_KEY)
    return Array.isArray(value) ? value.slice(0, MAX_RECORDS) : []
  } catch (_) { return [] }
}

module.exports = { create, record, recent, STORAGE_KEY, MAX_RECORDS }
