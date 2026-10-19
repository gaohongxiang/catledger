// Original files are only needed while they can still be reparsed or audited.
// Parsed rows and source evidence remain in MySQL; deleting the object does not
// delete the evidence used by review or the final posting checks.
const RETENTION_DAYS = Object.freeze({
  awaiting_upload: 1,
  failed: 30,
  review_ready: 7,
  committed: 0,
  duplicate: 0,
  discarded: 0
})
const DAY_MS = 24 * 60 * 60 * 1000

function isExpired(state, updatedAt, now = Date.now()) {
  const days = RETENTION_DAYS[state]
  if (days === undefined) return false
  const time = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime()
  return Number.isFinite(time) && time <= now - days * DAY_MS
}

module.exports = { RETENTION_DAYS, DAY_MS, isExpired }
