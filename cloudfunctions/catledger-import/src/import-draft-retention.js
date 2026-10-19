// Server-side temporary import drafts stop auto-resuming after 24h and are
// hard-cleaned after 48h. Only lists/removes the derived review graph through
// the existing abandon transaction; source rows, receipts and formal ledger
// entries are never part of this cleanup.
const DRAFT_STATUSES = Object.freeze(['draft', 'failed', 'review'])
const SERVER_AUTO_RESUME_MS = 24 * 60 * 60 * 1000
const SERVER_HARD_EXPIRE_MS = 48 * 60 * 60 * 1000
const HARD_CLEANUP_HOURS = 48
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

function isDraftStatus(status) {
  return DRAFT_STATUSES.includes(status)
}

function classifyServerAge(ageMs) {
  const value = Number(ageMs)
  if (!Number.isFinite(value) || value < 0) return 'fresh'
  if (value >= SERVER_HARD_EXPIRE_MS) return 'expired'
  if (value >= SERVER_AUTO_RESUME_MS) return 'manual'
  return 'fresh'
}

module.exports = {
  DRAFT_STATUSES,
  SERVER_AUTO_RESUME_MS,
  SERVER_HARD_EXPIRE_MS,
  HARD_CLEANUP_HOURS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  classifyServerAge,
  isDraftStatus
}
