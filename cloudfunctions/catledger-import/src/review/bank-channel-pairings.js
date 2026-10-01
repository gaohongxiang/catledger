const { digestParts } = require('../digest')
const { importError } = require('../errors')
const { validateUuid } = require('../validation')
const { assertBudget } = require('../performance-contract')
const { encodeCursor, decodeCursor } = require('../view-cursor')
const { readVersion } = require('../finance-update-read')
const { executeUserRead, executeIdempotentMutation } = require('../import-transaction')
const { insertAction, parseJson } = require('../finance-update-repository')
const { commandResult } = require('../command-result')
const { bankChannelEdges, REASON } = require('../bank-channel-matching')
const { hydrate } = require('./bank-channel-hydration')
const { applyPairs } = require('./bank-channel-apply')
const { synchronize } = require('./bank-channel-candidates')
const { recalculateUpdateCounts } = require('./reconciliation')

const MAX_BATCH = 100
const MAX_EXCEPTIONS = 500
const MAX_PAGE = 20
function keys(value, limit = MAX_EXCEPTIONS) {
  if (!Array.isArray(value) || value.length > limit || value.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) ||
    new Set(value).size !== value.length) throw importError('VALIDATION_ERROR')
  return value
}
function eventFacts(event) {
  return [event.eventId, event.ledgerAccountId, event.counterpartyLedgerAccountId, event.economicNature,
    event.flowDirection, event.amountMinor, event.currency, event.utcAt, event.categoryId, event.manualFieldMask,
    event.relationEvidence.rows.map(row => [row.rowId, row.identityId, row.identityState, row.amountMinor,
      row.currency, row.direction, row.utcAt, row.rawTransactionTime, row.rawTransactionType, row.rawStatus, row.semantic])]
}
function collectionDigest(pairs, versions = false) {
  return digestParts('bank-pair-range-v1', ...pairs.map(pair => JSON.stringify([pair.pairKey,
    eventFacts(pair.bank), eventFacts(pair.platform), ...(versions ? [pair.bank.version, pair.platform.version] : [])])))
}
async function graph(connection, uid, updateId, { forUpdate = false } = {}) {
  const state = await readVersion(connection, uid, updateId)
  if (state.update.status !== 'review' || state.update.requiresReorganization) throw importError('CONFLICT')
  const [[user]] = await connection.execute('SELECT CAST(data_revision AS CHAR) AS revision FROM catledger_users WHERE uid = ? AND status = \'active\'', [uid])
  if (!user) throw importError('INITIALIZATION_REQUIRED')
  const events = await hydrate(connection, uid, updateId, null, null, { forUpdate })
  const [accounts] = await connection.execute(`SELECT account_id AS id, currency FROM catledger_accounts WHERE uid = ? AND archived_at IS NULL
    UNION ALL SELECT draft_account_id, currency FROM catledger_finance_update_account_drafts WHERE uid = ? AND update_id = ?`, [uid, uid, updateId])
  const active = new Map(accounts.map(account => [account.id, account.currency]))
  const [occupied] = await connection.execute('SELECT DISTINCT event_id AS id FROM catledger_economic_event_transactions WHERE uid = ? AND update_id = ?', [uid, updateId])
  const unavailable = new Set(occupied.map(row => row.id))
  const [members] = await connection.execute(`SELECT i.issue_id AS issueId, i.version AS issueVersion, m.object_id AS eventId
    FROM catledger_review_issues i JOIN catledger_review_issue_members m ON m.uid = i.uid AND m.issue_id = i.issue_id
    WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND i.issue_type = 'same_event'
      AND i.primary_reason_code = ? AND m.object_type = 'event' AND m.member_role = 'subject'`, [uid, updateId, REASON])
  const issues = new Map()
  for (const member of members) {
    if (!issues.has(member.eventId)) issues.set(member.eventId, new Set())
    issues.get(member.eventId).add(member.issueId)
  }
  // 完整有效图先计算双向度数；分页和当前问题筛选只能发生在这之后。
  const all = bankChannelEdges(events.filter(event => !unavailable.has(event.eventId) && active.get(event.ledgerAccountId) === event.currency))
    .filter(pair => !require('../evidence-matching').hasSourceIdentityConflict(pair.bank.relationEvidence.rows.concat(pair.platform.relationEvidence.rows)))
    .sort((a, b) => a.pairKey.localeCompare(b.pairKey))
  const degrees = new Map()
  for (const pair of all) for (const event of [pair.bank, pair.platform]) degrees.set(event.eventId, (degrees.get(event.eventId) || 0) + 1)
  const pairs = all.map(pair => ({ ...pair,
    issueIds: [...(issues.get(pair.bank.eventId) || [])].filter(id => issues.get(pair.platform.eventId)?.has(id)),
    unique: degrees.get(pair.bank.eventId) === 1 && degrees.get(pair.platform.eventId) === 1 }))
    .filter(pair => pair.issueIds.length)
  return { ...state, revision: String(user.revision), pairs,
    digest: digestParts(collectionDigest(all, true), JSON.stringify(members.map(row => [row.issueId, row.issueVersion, row.eventId]).sort())) }
}
function range(graph, mode, issueId) {
  return graph.pairs.filter(pair => (mode === 'suggested' ? pair.unique : issueId || !pair.unique) && (!issueId || pair.issueIds.includes(issueId)))
}
function scope(uid, updateId, state, kind) { return { uid, updateId, kind, viewVersion: state.viewVersion } }
function previewEvent(event) {
  const row = event.relationEvidence.rows[0]
  return { eventId: event.eventId, version: event.version, sourceType: event.sourceType, localAt: event.localAt,
    amountMinor: event.amountMinor, currency: event.currency, counterparty: String(row.counterparty || '').slice(0, 100),
    item: String(row.item || '').slice(0, 160), evidenceCount: event.relationEvidence.rows.length }
}
function previewPair(pair) {
  return { pairKey: pair.pairKey, bank: previewEvent(pair.bank), platform: previewEvent(pair.platform),
    economicNature: pair.platform.economicNature, reason: 'same_account_amount_currency_direction_minute_channel' }
}
function assertScope(state, frozen) {
  if (!frozen || frozen.graphDigest !== state.digest || frozen.revision !== state.revision) throw importError('STALE_VIEW')
}
function createBankChannelPairings({ getPool }) {
  async function list(context) {
    const updateId = validateUuid(context.data.updateId), mode = context.data.mode || 'suggested'
    if (!['suggested', 'ambiguous'].includes(mode)) throw importError('VALIDATION_ERROR')
    const issueId = context.data.issueId == null ? null : validateUuid(context.data.issueId)
    const pageSize = context.data.pageSize == null ? 8 : context.data.pageSize
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE) throw importError('VALIDATION_ERROR')
    const recheckKeys = context.data.recheckPairKeys == null ? null : keys(context.data.recheckPairKeys)
    return executeUserRead({ getPool, ...context, consistentSnapshot: true, operation: async (connection, uid) => {
      const state = await graph(connection, uid, updateId)
      if (context.data.viewVersion != null && context.data.viewVersion !== state.viewVersion) throw importError('STALE_VIEW')
      const selected = range(state, mode, issueId)
      const frozen = { mode, issueId, graphDigest: state.digest, revision: state.revision }
      // 翻页游标只定位 pairKey，不绑数据修订：无关账本写入也推进 revision，不能把游标永久失效；
      // 范围一致性由提交时的 scopeToken（frozen）校验。
      const pageScope = { ...scope(uid, updateId, state, 'bank-pair-page'), mode, issueId, graphDigest: state.digest }
      const last = decodeCursor(context.subjectHash, context.data.cursor, pageScope)
      if (last != null) keys([last], 1)
      const remaining = selected.filter(pair => !last || pair.pairKey > last)
      const items = remaining.slice(0, pageSize).map(previewPair)
      const available = new Set(selected.map(pair => pair.pairKey))
      const result = { protocolVersion: 2, viewVersion: state.viewVersion, update: state.update, items,
        total: selected.length, suggestedTotal: state.pairs.filter(pair => pair.unique).length,
        scopeNatureCounts: { expense: selected.filter(pair => pair.platform.economicNature === 'expense').length,
          refund: selected.filter(pair => pair.platform.economicNature === 'refund').length },
        scopeSourceCount: selected.reduce((count, pair) => count + pair.bank.relationEvidence.rows.length + pair.platform.relationEvidence.rows.length, 0),
        scopeToken: encodeCursor(context.subjectHash, scope(uid, updateId, state, 'bank-pair-scope'), frozen),
        nextCursor: remaining.length > items.length ? encodeCursor(context.subjectHash, pageScope, items.at(-1).pairKey) : null }
      if (recheckKeys) Object.assign(result, { returnedKeys: recheckKeys.filter(key => available.has(key)), missingKeys: recheckKeys.filter(key => !available.has(key)) })
      return assertBudget(result, 'page')
    } })
  }
  async function resolve(context) {
    const updateId = validateUuid(context.data.updateId)
    return executeIdempotentMutation({ getPool, ...context, action: 'reviewIssues.resolvePairings',
      operation: async (connection, uid, data, requestDigest) => {
        const state = await graph(connection, uid, updateId, { forUpdate: true })
        let frozen, selection, rootActionId = null, savedCount = 0, totalCount, chosen
        if (data.continuationToken) {
          if (data.scopeToken || data.selection) throw importError('VALIDATION_ERROR')
          frozen = decodeCursor(context.subjectHash, data.continuationToken, scope(uid, updateId, state, 'bank-pair-continuation'))
          assertScope(state, frozen)
          rootActionId = validateUuid(frozen.rootActionId)
          const [[root]] = await connection.execute(`SELECT decision_json AS decision FROM catledger_finance_actions
            WHERE uid = ? AND update_id = ? AND action_id = ? AND action_type = 'resolve_bank_pairings' AND status = 'applied'`, [uid, updateId, rootActionId])
          if (!root) throw importError('CONFLICT')
          selection = parseJson(root.decision, {}).selection
          if (!selection || selection.mode !== 'all_except') throw importError('CONFLICT')
          const excluded = new Set(keys(selection.excludedPairKeys))
          chosen = range(state, 'suggested', null).filter(pair => !excluded.has(pair.pairKey)).map(pair => ({ ...pair, decision: 'same' }))
          if (collectionDigest(chosen) !== frozen.remainingDigest || chosen.length !== frozen.remainingCount) throw importError('STALE_VIEW')
          savedCount = frozen.savedCount; totalCount = frozen.totalCount
          if (!Number.isInteger(savedCount) || savedCount < 1 || totalCount !== savedCount + chosen.length) throw importError('CONFLICT')
        } else {
          frozen = decodeCursor(context.subjectHash, data.scopeToken, scope(uid, updateId, state, 'bank-pair-scope'))
          assertScope(state, frozen)
          const candidates = range(state, frozen.mode, frozen.issueId), byKey = new Map(candidates.map(pair => [pair.pairKey, pair]))
          selection = data.selection
          if (!selection || typeof selection !== 'object') throw importError('VALIDATION_ERROR')
          if (selection.mode === 'all_except') {
            if (frozen.mode !== 'suggested' || frozen.issueId) throw importError('VALIDATION_ERROR')
            const excluded = new Set(keys(selection.excludedPairKeys || []))
            if ([...excluded].some(key => !byKey.has(key))) throw importError('STALE_VIEW')
            selection = { mode: 'all_except', excludedPairKeys: [...excluded] }
            chosen = candidates.filter(pair => !excluded.has(pair.pairKey)).map(pair => ({ ...pair, decision: 'same' }))
          } else if (selection.mode === 'include') {
            if (!Array.isArray(selection.pairs) || !selection.pairs.length || selection.pairs.length > MAX_BATCH) throw importError('VALIDATION_ERROR')
            keys(selection.pairs.map(pair => pair.pairKey), MAX_BATCH)
            chosen = selection.pairs.map(pair => {
              if (!byKey.has(pair.pairKey) || !['same', 'distinct'].includes(pair.decision)) throw importError('VALIDATION_ERROR')
              return { ...byKey.get(pair.pairKey), decision: pair.decision }
            })
          } else throw importError('VALIDATION_ERROR')
          totalCount = chosen.length
        }
        if (!chosen.length) throw importError('VALIDATION_ERROR')
        const batch = chosen.slice(0, MAX_BATCH), remaining = chosen.slice(MAX_BATCH)
        const version = state.update.version, nextVersion = version + 1
        const actionId = await insertAction(connection, uid, { updateId, expectedVersion: version, appliedVersion: nextVersion,
          actionType: 'resolve_bank_pairings', requestDigest,
          decision: rootActionId ? { rootActionId, continuationToken: data.continuationToken } : { selection, scopeToken: data.scopeToken },
          reasons: ['bank_channel_pairs_confirmed'] })
        rootActionId = rootActionId || actionId
        await applyPairs(connection, uid, updateId, batch, actionId)
        await synchronize(connection, uid, updateId, actionId, null, { reuseDecisions: false })
        await recalculateUpdateCounts(connection, uid, updateId, nextVersion, actionId, version)
        const after = remaining.length ? await graph(connection, uid, updateId) : null
        let continuationToken = null
        if (after) {
          const excluded = new Set(selection.excludedPairKeys)
          const next = range(after, 'suggested', null).filter(pair => !excluded.has(pair.pairKey))
          // 自身版本推进只能延续逐对事实完全不变的原剩余集合，不能重新扩大范围。
          if (collectionDigest(next) !== collectionDigest(remaining)) throw importError('CONFLICT')
          continuationToken = encodeCursor(context.subjectHash, scope(uid, updateId, after, 'bank-pair-continuation'), {
            rootActionId, graphDigest: after.digest, revision: String(BigInt(state.revision) + 1n),
            remainingDigest: collectionDigest(next), remainingCount: next.length,
            totalCount, savedCount: savedCount + batch.length })
        }
        const result = await commandResult(connection, uid, updateId)
        return { ...result, pairing: { savedCount: savedCount + batch.length, totalCount,
          remainingCount: remaining.length, batchSavedCount: batch.length, continuationToken } }
      } })
  }
  return { list, resolve }
}
module.exports = { createBankChannelPairings, graph, collectionDigest, MAX_BATCH, MAX_EXCEPTIONS, MAX_PAGE }
