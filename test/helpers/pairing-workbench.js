const { runtime, fixture } = require('./paged-workbench')
const copy = value => JSON.parse(JSON.stringify(value))
const tap = (key, decision) => ({ currentTarget: { dataset: { key, decision } } })
const pageDirection = value => ({ currentTarget: { dataset: { direction: value } } })
function pair(index, options = {}) {
  const record = (side) => ({ eventId: side + '-' + index, version: 1, sourceType: side === 'bank' ? 'bank' : 'wechat',
    localAt: '2026-09-01 12:00:00', amountMinor: '100', currency: 'CNY', counterparty: '合成商户', item: '合成商品', evidenceCount: 1 })
  return { pairKey: 'pair-' + index, bank: record('bank'), platform: record('platform'), economicNature: 'expense',
    reason: 'same_account_amount_currency_direction_minute_channel', ...options }
}
function setup(count = 100, data = fixture(2, true)) {
  const h = runtime(data)
  h.pairs = Array.from({ length: count }, (_, index) => pair(index))
  h.onPairingCall = null
  const receipts = new Map()
  let task
  h.intercept = async (action, input) => {
    if (h.onPairingCall) { const value = await h.onPairingCall(action, input); if (value !== undefined) return value }
    if (action === 'reviewIssues.pairings') {
      const rows = h.pairs.filter(pair => !input.issueId || !pair.issueId || pair.issueId === input.issueId)
      const start = Number(input.cursor || 0), size = input.pageSize
      const response = { protocolVersion: 2, viewVersion: h.summary.viewVersion, update: h.summary.update,
        items: copy(rows.slice(start, start + size)), total: rows.length, suggestedTotal: rows.length,
        nextCursor: start + size < rows.length ? String(start + size) : null,
        scopeToken: 'signed-scope-' + h.summary.viewVersion + '-' + input.mode + '-' + (input.issueId || 'all'),
        scopeSourceCount: rows.reduce((n, row) => n + row.bank.evidenceCount + row.platform.evidenceCount, 0),
        scopeNatureCounts: { expense: rows.filter(row => row.economicNature === 'expense').length, refund: rows.filter(row => row.economicNature === 'refund').length } }
      if (input.recheckPairKeys) {
        response.returnedKeys = input.recheckPairKeys.filter(key => rows.some(row => row.pairKey === key))
        response.missingKeys = input.recheckPairKeys.filter(key => !rows.some(row => row.pairKey === key))
      }
      return response
    }
    if (action === 'reviewIssues.resolvePairings') {
      if (receipts.has(input.requestId)) return copy(receipts.get(input.requestId))
      if (!input.continuationToken) {
        const keys = input.selection.mode === 'all_except' ? h.pairs.filter(row => !input.selection.excludedPairKeys.includes(row.pairKey)).map(row => row.pairKey)
          : input.selection.pairs.map(pair => pair.pairKey)
        task = { keys, saved: 0, total: keys.length }
      }
      const count = Math.min(100, task.total - task.saved), keys = task.keys.slice(task.saved, task.saved + count)
      task.saved += count; h.pairs = h.pairs.filter(row => !keys.includes(row.pairKey))
      h.summary = { ...h.summary, viewVersion: 'v' + (h.summary.update.version + 1), update: { ...h.summary.update, version: h.summary.update.version + 1 } }
      const receipt = { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update,
        pairing: { savedCount: task.saved, totalCount: task.total, remainingCount: task.total - task.saved,
          batchSavedCount: count, continuationToken: task.saved < task.total ? 'signed-next-' + task.saved : null } }
      receipts.set(input.requestId, copy(receipt)); return receipt
    }
    return undefined
  }
  return h
}
module.exports = { setup, pair, tap, pageDirection }
