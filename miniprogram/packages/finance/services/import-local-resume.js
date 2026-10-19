// Local review resume and retention boundaries. This module is client-only:
// the server has its own hard-retention clock and never infers local activity.
const { PLAN_VERSION } = require('../domain/import-review/domain-versions')
const { VERSIONS } = require('../domain/import-review/identity')
const { profileForFormat } = require('../domain/import-review/profiles/index')

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const AUTO_RESUME_MS = 12 * HOUR_MS
const SNAPSHOT_RETENTION_MS = 24 * HOUR_MS
const SERVER_AUTO_RESUME_MS = 24 * HOUR_MS
const SERVER_HARD_EXPIRE_MS = 48 * HOUR_MS
const MISSING_ORIGINAL_STATES = new Set(['discarded', 'committed', 'duplicate'])

function ageOf(lastActiveAt, now) {
  if (lastActiveAt == null || lastActiveAt === '') return null
  const value = Number(lastActiveAt)
  if (!Number.isFinite(value)) return null
  const current = Number(now)
  return Math.max(0, (Number.isFinite(current) ? current : Date.now()) - value)
}

// <12h opens automatically; 12h-24h needs an explicit choice; >=24h is cleared.
function localActivityState(lastActiveAt, now = Date.now()) {
  const ageMs = ageOf(lastActiveAt, now)
  if (ageMs == null) return { state: 'fresh', ageMs: null, auto: true, continueAllowed: true }
  if (ageMs >= SNAPSHOT_RETENTION_MS) {
    return { state: 'expired', ageMs, auto: false, continueAllowed: false }
  }
  if (ageMs >= AUTO_RESUME_MS) {
    return { state: 'idle', ageMs, auto: false, continueAllowed: true }
  }
  return { state: 'fresh', ageMs, auto: true, continueAllowed: true }
}

// Server drafts stop auto-opening after 24h; the manual window closes at 48h.
function serverActivityState(ageMs) {
  const value = Number(ageMs)
  if (!Number.isFinite(value) || value < 0) return { state: 'fresh', ageMs: null, auto: true, continueAllowed: true }
  if (value >= SERVER_HARD_EXPIRE_MS) return { state: 'expired', ageMs: value, auto: false, continueAllowed: false }
  if (value >= SERVER_AUTO_RESUME_MS) return { state: 'idle', ageMs: value, auto: false, continueAllowed: true }
  return { state: 'fresh', ageMs: value, auto: true, continueAllowed: true }
}

function sourceVersions(source) {
  const profile = profileForFormat(source && source.sourceFormat)
  return {
    parserVersion: profile ? profile.parserVersion : null,
    normalizationVersion: profile ? profile.normalizationVersion || null : null,
    identityVersion: VERSIONS.SOURCE_IDENTITY
  }
}

function versionMismatches(facts) {
  const changes = []
  if (!facts || facts.ruleVersion !== PLAN_VERSION) {
    changes.push({ kind: 'rule', expected: PLAN_VERSION, actual: facts && facts.ruleVersion || null })
  }
  for (const source of (facts && facts.sources) || []) {
    const expected = sourceVersions(source)
    for (const kind of ['parserVersion', 'normalizationVersion', 'identityVersion']) {
      if (!expected[kind]) continue
      if (source[kind] !== expected[kind]) {
        changes.push({ kind, sourceId: source.sourceId || null, sourceFormat: source.sourceFormat || null,
          expected: expected[kind], actual: source[kind] || null })
      }
    }
  }
  return changes
}

// Parsing changes require the original file again. Semantic-only changes can
// re-plan the stored raw rows and replace the snapshot without re-uploading.
function versionState(facts) {
  const changes = versionMismatches(facts)
  if (!changes.length) return null
  const reparse = changes.some(change => change.kind !== 'rule')
  const originalMissing = reparse && ((facts && facts.sources) || []).some(source =>
    source.contentDeletedAt || MISSING_ORIGINAL_STATES.has(source.contentState))
  return {
    state: reparse ? 'reparse' : 'semantic',
    version: reparse ? 'reparse' : 'semantic',
    changes,
    originalMissing,
    canContinue: !reparse,
    requiresReorganize: !reparse
  }
}

module.exports = {
  AUTO_RESUME_MS,
  SNAPSHOT_RETENTION_MS,
  SERVER_AUTO_RESUME_MS,
  SERVER_HARD_EXPIRE_MS,
  localActivityState,
  serverActivityState,
  versionMismatches,
  versionState
}
