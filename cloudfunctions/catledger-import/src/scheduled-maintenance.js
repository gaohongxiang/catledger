const { createCleanupBudget, FUNCTION_TIMEOUT_MS, SAFETY_MARGIN_MS } = require('./cleanup-runtime')

const BATCH_SIZE = 5
const MAX_ROUNDS = 20
const METRICS_RESERVE_MS = 2_000

async function runScheduledMaintenance(service, { now = Date.now,
  timeoutMs = FUNCTION_TIMEOUT_MS - SAFETY_MARGIN_MS, maxRounds = MAX_ROUNDS } = {}) {
  const totalBudget = createCleanupBudget({ now, timeoutMs })
  const workBudget = createCleanupBudget({ now, timeoutMs: Math.max(0, timeoutMs - METRICS_RESERVE_MS) })
  const kinds = [
    { name: 'drafts', run: service.cleanupExpiredDraftsGlobal.bind(service), success: 'cleaned' },
    { name: 'files', run: service.cleanupExpiredFilesGlobal.bind(service), success: 'deleted' }
  ]
  const result = { startedAt: new Date(now()).toISOString() }
  for (const kind of kinds) {
    kind.progress = {}
    result[kind.name] = { checked: 0, [kind.success]: 0, skipped: 0, failed: 0, backoffFailed: 0, batches: 0, batchFailures: 0 }
  }
  const rounds = Math.max(1, Math.min(MAX_ROUNDS, Number.isInteger(maxRounds) ? maxRounds : MAX_ROUNDS))
  for (let round = 0; round < rounds && workBudget.canStart(); round += 1) {
    for (const kind of kinds) {
      if (kind.progress.done || !workBudget.canStart()) continue
      const totals = result[kind.name]
      totals.batches += 1
      try {
        const batch = await kind.run(BATCH_SIZE, { budget: workBudget, progress: kind.progress })
        // Cursor includes private row identifiers and remains within this invocation.
        for (const key of ['checked', kind.success, 'skipped', 'failed', 'backoffFailed']) totals[key] += batch[key] || 0
      } catch (_) {
        totals.batchFailures += 1
        kind.progress.done = true
      }
    }
    if (kinds.every(kind => kind.progress.done)) break
  }
  result.stopReason = !workBudget.canStart() ? 'time_budget' : kinds.some(kind => result[kind.name].batchFailures) ? 'partial_failure' :
    kinds.every(kind => kind.progress.done) ? 'drained' : 'batch_limit'
  for (const kind of kinds) {
    try { result[kind.name].backlog = await service.cleanupBacklogGlobal(kind.name, { budget: totalBudget }) }
    catch (_) { result[kind.name].backlog = { available: false } }
  }
  result.elapsedMs = totalBudget.elapsed()
  return result
}

module.exports = { runScheduledMaintenance, BATCH_SIZE, MAX_ROUNDS }
