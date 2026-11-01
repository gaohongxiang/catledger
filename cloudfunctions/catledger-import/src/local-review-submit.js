const { randomUUID } = require('node:crypto')
const { importError } = require('./errors')
const { executeUserRead, executeIdempotentMutation, findReplay } = require('./import-transaction')
const { loadObject, saveObject } = require('./local-review-objects')
const { validateState, split } = require('./local-review-protocol')
const { validateUuid, validateVersion } = require('./validation')
const repository = require('./finance-update-repository')
const store = require('./review/event-store')
const batchState = require('./local-review-batch')
const reconciliation = require('./review/reconciliation')
const { PLAN_VERSION } = require('./domain-versions')
const same = (a, b) => {
  if (a.length !== b.length) return false
  const left = [...a].sort(), right = [...b].sort()
  return left.every((id, i) => id === right[i])
}
const fail = () => { throw importError('VALIDATION_ERROR') }

function scopes(facts, splitIds = new Set()) {
  const result = new Map()
  for (const row of facts.evidence) if (row.evidenceRole !== 'discarded') {
    if (!result.has(row.eventId)) result.set(row.eventId, [])
    result.get(row.eventId).push(row.rowId)
  }
  for (const event of facts.events) for (const origin of event.fieldSources.mergeOrigins || []) {
    const id = origin.event.eventId || require('./local-review-identity').splitEventId(facts.update.updateId, origin.rowIds)
    if (id !== event.eventId || splitIds.has(event.eventId)) result.set(id, origin.rowIds)
  }
  // Older organized duplicates predate mergeOrigins. Reuse their original
  // planner groups to validate the stable identities restored by splitting.
  const rows = new Map(facts.rows.map(row => [row.rowId, row]))
  for (const event of facts.events) if (!event.fieldSources.mergeOrigins && (result.get(event.eventId) || []).length > 1) {
    let sequence = 0
    const identity = require('./local-review-identity')
    const plan = require('./organizer-plan-policy').buildOrganizePlan({ updateId: facts.update.updateId,
      rows: result.get(event.eventId).map(id => rows.get(id)), paymentMappings: facts.paymentMappings || [], accounts: facts.accounts,
      idFactory: () => identity.stableId('split-plan', event.eventId, String(sequence++)) })
    const primary = facts.evidence.find(row => row.eventId === event.eventId && row.evidenceRole === 'primary')
    for (const item of plan.events) {
      const id = item.fieldSources.rowIds.includes(primary?.rowId) ? event.eventId : identity.splitEventId(facts.update.updateId, item.fieldSources.rowIds)
      if (id !== event.eventId || splitIds.has(event.eventId)) result.set(id, item.fieldSources.rowIds)
    }
  }
  return result
}
function validateChoices(state, facts) {
  const baseline = scopes(facts), byId = scopes(facts, new Set(state.decisions.duplicates.filter(row => row.decision === 'distinct').map(row => row.eventId)))
  const allRows = new Set(facts.rows.map(row => row.rowId))
  for (const [kind, values] of Object.entries(state.decisions)) for (const item of values) {
    if (new Set(item.sourceIds).size !== item.sourceIds.length || item.sourceIds.some(id => !allRows.has(id))) fail()
    if (kind === 'events' || kind === 'duplicates') {
      const current = kind === 'duplicates' ? baseline : byId
      if (item.key !== item.eventId || !current.has(item.eventId)) fail()
      // A surviving event may now own the explicitly confirmed pair's sources.
      const merged = state.decisions.pairings.filter(pair => pair.decision === 'same' && pair.platformEventId === item.eventId)
      const allowed = [...new Set([...current.get(item.eventId), ...merged.flatMap(pair => pair.sourceIds)])]
      if (!same(item.sourceIds, current.get(item.eventId)) && !same(item.sourceIds, allowed)) fail()
    } else if (kind === 'pairings') {
      if (!['same','distinct'].includes(item.decision) || !byId.has(item.bankEventId) || !byId.has(item.platformEventId) ||
        !same(item.sourceIds, [...new Set([...byId.get(item.bankEventId), ...byId.get(item.platformEventId)])])) fail()
    } else {
      if (!Array.isArray(item.eventIds) || !item.eventIds.length || item.eventIds.some(id => !byId.has(id))) fail()
      if (!same(item.sourceIds, [...new Set(item.eventIds.flatMap(id => byId.get(id)))])) fail()
      if (kind === 'accounts' && !['apply_fields','exclude_events'].includes(item.decision)) fail()
      // Ignoring this import is never a permanent mapping rule.
      if (item.paymentRuleAction != null && !(kind === 'accounts' && item.paymentRuleAction === 'external' &&
          item.decision === 'apply_fields' && !Object.keys(item.fields || {}).length)) fail()
    }
  }
  const used = new Set()
  for (const pair of state.decisions.pairings.filter(pair => pair.decision === 'same')) for (const row of pair.sourceIds) {
    if (used.has(row)) fail(); used.add(row)
  }
}

async function resolveIssue(connection, uid, updateId, item) {
  const issues = await repository.selectIssues(connection, uid, updateId)
  const candidates = issues.filter(issue => issue.issueType === item.issueType &&
    issue.primaryReasonCode === item.reasonCode && (same(issue.subjectEventIds || [], item.eventIds) ||
      item.decision === 'exclude_events' && item.eventIds.every(id => issue.subjectEventIds.includes(id))))
  const issue = candidates.find(row => row.issueId === item.issueId) || candidates.find(row => row.status === 'open')
  if (!issue || !['open','resolved'].includes(issue.status)) throw importError('LOCAL_RECHECK_REQUIRED')
  if (item.reasonCode === 'historical_duplicate_candidate') {
    const [members] = await connection.execute(`SELECT object_id AS id,object_version AS version FROM catledger_review_issue_members
      WHERE uid=? AND issue_id=? AND object_type='transaction' AND member_role='candidate'`, [uid, issue.issueId])
    const actual = members.map(row => `${row.id}:${Number(row.version)}`)
    if (!Array.isArray(item.candidates) || !same(actual, item.candidates.map(row => `${row.id}:${row.version}`))) throw importError('HISTORY_REVIEW_REQUIRED')
  }
  return issue
}

async function applyChoices(connection, uid, state, digest, batch) {
  const updateId = state.updateId, updateVersion = state.baseVersion, choices = state.decisions
  const actionId = await repository.insertAction(connection, uid, { updateId, expectedVersion: updateVersion,
    appliedVersion: updateVersion + 1, actionType: 'set_event_review', requestDigest: digest,
    decision: { protocolVersion: 3, snapshotId: state.snapshotId, counts: Object.fromEntries(Object.entries(choices).map(([key, value]) => [key, value.length])) }, reasons: ['local_review_submitted'] })
  batch.actionId = actionId
  for (const item of choices.duplicates) {
    batch.affected = [item.eventId]
    const [event] = await store.selectDomainEvents(connection, uid, updateId, [item.eventId], { forUpdate: true })
    if (!event || !['distinct','reopen'].includes(item.decision)) fail()
    const revise = require('./review/duplicate-revision')
    await (item.decision === 'distinct' ? revise.split : revise.reopenHistory)(connection, uid, item, digest,
      { updateId, updateVersion, eventId: event.eventId, eventVersion: event.version })
  }
  if (choices.accounts.length) {
    const items = []
    for (const item of choices.accounts) {
      batch.affected = item.eventIds
      const issue = await resolveIssue(connection, uid, updateId, { ...item, issueType: 'account_mapping' })
      items.push({ issueId: issue.issueId, issueVersion: issue.version, operation: issue.status === 'open' ? 'resolve' : 'revise',
        decision: item.decision, fields: item.fields, paymentRuleAction: item.paymentRuleAction })
    }
    await require('./review/account-mapping').resolveAccountMappings(connection, uid, {}, digest, { updateId, decisions: items }, { updateVersion })
  }
  const pairedBanks = new Set(choices.pairings.filter(item => item.decision === 'same').map(item => item.bankEventId))
  const memberEditors = new Map()
  for (const pair of choices.pairings) for (const [id, value] of Object.entries(pair.memberEditors || {})) {
    if (![pair.bankEventId, pair.platformEventId].includes(id)) fail()
    memberEditors.set(id, { eventId: id, editor: value })
  }
  for (const item of choices.events) if (pairedBanks.has(item.eventId)) memberEditors.set(item.eventId, item)
  await require('./review/event-review').saveEditors(connection, uid, updateId, [...memberEditors.values()], actionId)
  // Pairs are checked against current account/field facts before merging. The
  // platform event remains the stable editable event; suggestions aren't inputs.
  if (choices.pairings.length) {
    for (const decision of ['distinct', 'same']) {
      const selected = choices.pairings.filter(item => item.decision === decision)
      if (!selected.length) continue
      const hydrated = await require('./review/bank-channel-hydration').hydrate(connection, uid, updateId)
      const pairs = new Map(require('./bank-channel-matching').bankChannelEdges(hydrated).map(pair => [pair.pairKey, pair]))
      const validated = []
      for (const item of selected) {
      batch.affected = [item.bankEventId, item.platformEventId]
      const pair = pairs.get(item.key)
      if (!pair || pair.bank.eventId !== item.bankEventId || pair.platform.eventId !== item.platformEventId) throw importError('LOCAL_RECHECK_REQUIRED')
      // Distinct choices may share a candidate, while confirmed pairs may not.
        validated.push({ ...pair, decision: item.decision, repaymentConfirmed: item.repaymentConfirmed })
      }
      await require('./review/bank-channel-apply').applyPairs(connection, uid, updateId, validated, actionId, { overlappingDistinct: decision === 'distinct' })
    }
  }
  batch.affected = choices.events.map(item => item.eventId)
  await require('./review/event-review').saveEditors(connection, uid, updateId, choices.events.filter(item => !pairedBanks.has(item.eventId)), actionId)
  // Synchronize once before resolving historical choices so references returned
  // by a previous rolled-back attempt bind by event and candidate identities.
  await require('./historical-duplicates').synchronizeHistoricalReviews(connection, uid, updateId)
  for (const item of choices.reviews) {
    batch.affected = item.eventIds
    const issue = await resolveIssue(connection, uid, updateId, item)
    if (issue.status === 'resolved') continue
    const data = { ...item.input, decision: item.decision }
    if (item.decision === 'exclude_events') data.selection = same(issue.subjectEventIds, item.eventIds)
      ? { mode: 'all' } : { mode: 'include', eventIds: item.eventIds }
    if (data.paymentRuleAction != null) fail()
    await require('./review/event-decisions').resolve(connection, uid, data, digest,
      { updateId, updateVersion, issueId: issue.issueId, issueVersion: issue.version, decision: item.decision })
  }
  batch.affected = []
  return actionId
}

function selectedAccountProblems(state, facts, accounts) {
  const events = new Map(facts.events.map(event => [event.eventId, event])), pendingDraftIds = new Set()
  const types = require('./account-type-policy'), { memberReference } = require('./account-reference-context')
  const unavailable = new Set()
  for (const item of state.decisions.accounts) for (const key of ['mappingAccountDraft', 'ledgerAccountDraft']) {
    const draft = item.fields?.[key]
    if (draft && typeof draft.name === 'string' && typeof draft.type === 'string') {
      pendingDraftIds.add(require('./local-review-identity').accountId(state.snapshotId, draft.name, draft.type, draft.creationKey))
    }
  }
  const inspect = (eventId, accountId, reference, memberRole) => {
    const event = events.get(eventId)
    if (!event || !accountId) return
    const account = accounts.get(accountId)
    // 本请求尚未执行到的新建决定不是失效账户；创建及重名仍由原写入校验裁决。
    if (!account && pendingDraftIds.has(accountId)) return
    if (!types.compatible(reference || { currency: event.currency }, account,
      reference ? { event, memberRole } : undefined)) unavailable.add(eventId)
  }
  for (const item of state.decisions.accounts) {
    if (item.decision !== 'apply_fields' || item.paymentRuleAction === 'external') continue
    const accountId = item.fields?.mappingAccountId || item.fields?.ledgerAccountId
    if (!accountId) continue
    const issue = facts.issues.find(issue => issue.issueType === 'account_mapping' &&
      issue.primaryReasonCode === item.reasonCode && same(issue.subjectEventIds || [], item.eventIds))
    const members = issue ? facts.members.filter(member => member.issueId === issue.issueId &&
      member.objectType === 'event' && member.memberRole !== 'candidate') : []
    for (const eventId of item.eventIds) {
      const actual = members.filter(member => member.objectId === eventId)
      if (!actual.length) inspect(eventId, accountId)
      for (const member of actual) inspect(eventId, accountId, memberReference(events.get(eventId) || {}, member), member.memberRole)
    }
  }
  for (const item of state.decisions.events) {
    const editor = item.editor || {}, fields = editor.fields || {}
    const parts = Array.isArray(editor.composition?.parts) ? editor.composition.parts : []
    for (const id of [fields.ledgerAccountId, fields.counterpartyLedgerAccountId,
      ...parts.filter(part => part && part.kind !== 'external').map(part => part.accountId),
      ...Object.values(editor.decisions?.accountOwnership || {}).filter(side => side?.kind === 'ledger').map(side => side.accountId)]) {
      inspect(item.eventId, id)
    }
  }
  return [...unavailable].map(eventId => ({ eventIds: [eventId], reason: 'account_unavailable', issueType: 'server_recheck' }))
}

async function recheckFacts(connection, uid, state, code, affected) {
  const facts = await require('./local-review-facts').loadFacts(connection, uid, state.updateId)
  const issues = facts.issues.filter(row => row.status === 'open' && row.blocking)
  const problems = issues.map(issue => ({ issueId: issue.issueId, eventIds: issue.subjectEventIds,
    reason: issue.primaryReasonCode, issueType: issue.issueType }))
  const accounts = new Map(facts.accounts.concat(facts.accountDrafts).map(row => [row.accountId,row]))
  const categories = new Map(facts.categories.map(row => [row.categoryId,row]))
  for (const event of facts.events.filter(row => ['ready','needs_action'].includes(row.status))) {
    const ids = [event.ledgerAccountId,event.counterpartyLedgerAccountId,...(event.fieldSources.paymentResolution?.allocations || []).map(row=>row.accountId)].filter(Boolean)
    if (ids.some(id=>!accounts.has(id)||accounts.get(id).archivedAt)) problems.push({ eventIds:[event.eventId],reason:'account_unavailable',issueType:'server_recheck' })
    if (event.categoryId && (!categories.has(event.categoryId)||categories.get(event.categoryId).archivedAt)) problems.push({ eventIds:[event.eventId],reason:'category_unavailable',issueType:'server_recheck' })
  }
  if (affected.length) problems.push({ eventIds: affected, reason: code, issueType: 'server_recheck' })
  // 映射或编辑在应用前已拒绝时，服务端事件仍是旧值；必须核对本请求实际选择。
  // 只信本用户当前目录与原引用，并让具体原因优先于本机恢复时的一般校验错误。
  problems.push(...selectedAccountProblems(state, facts, accounts))
  if (!problems.length) problems.push({ eventIds: facts.events.filter(row=>['ready','needs_action'].includes(row.status)).map(row=>row.eventId), reason:code,issueType:'server_recheck' })
  return { protocolVersion: 3, snapshotId: state.snapshotId, updateId: state.updateId, baseVersion: state.baseVersion,
    problems, issues, members: facts.members.filter(member => issues.some(issue => issue.issueId === member.issueId)),
    history: facts.history, historyGroups: facts.historyGroups, historyCoverage: facts.historyCoverage, refundCandidates: facts.refundCandidates,
    refundCandidatesCovered: facts.refundCandidatesCovered,
    accounts: facts.accounts, categories: facts.categories, loans: facts.loans, contracts: facts.contracts, charges: facts.charges }
}

async function post(context, postInTransaction) {
  const data = context.data
  if (Object.keys(data).some(key => !['requestId','protocolVersion','updateId','version','snapshotId','uploadId','payloadDigest'].includes(key))) fail()
  validateUuid(data.updateId); validateUuid(data.snapshotId); validateUuid(data.uploadId); validateVersion(data.version)
  const replay = await findReplay(context, 'financeUpdates.post')
  if (replay) return replay
  // Hash, decode and validate the immutable payload outside the user write lock.
  const captured = await executeUserRead({ ...context, consistentSnapshot: true, operation: async (connection, uid) => {
    const payload = await loadObject(connection, uid, data.uploadId, 'decisions')
    const snapshot = await loadObject(connection, uid, data.snapshotId, 'snapshot')
    const state = validateState(payload.value)
    if (payload.header.digest !== data.payloadDigest || payload.header.snapshotId !== data.snapshotId ||
      state.updateId !== data.updateId || state.snapshotId !== data.snapshotId || state.baseVersion !== data.version || payload.header.ruleVersion !== PLAN_VERSION || snapshot.header.ruleVersion !== PLAN_VERSION ||
      snapshot.header.updateId !== data.updateId || snapshot.header.baseVersion !== data.version || state.ruleVersion !== PLAN_VERSION) fail()
    validateChoices(state, snapshot.value)
    return state
  } })
  return executeIdempotentMutation({ ...context, action: 'financeUpdates.post', operation: async (connection, uid, input, digest) => {
    const current = await repository.selectUpdate(connection, uid, input.updateId, { forUpdate: true })
    if (current.status === 'posted') return require('./command-result').commandResult(connection, uid, input.updateId)
    if (current.status !== 'review' || Number(current.version) !== input.version || current.reviewMode !== 'local_v3' || current.planVersion !== PLAN_VERSION) throw importError('CONFLICT')
    await connection.query('SAVEPOINT local_review')
    const batch = batchState.begin(connection, repository.publicUpdate(current)); batch.snapshotId = input.snapshotId; batch.affected = []
    let postingStarted = false
    try {
      const actionId = await applyChoices(connection, uid, captured, digest, batch)
      batchState.end(connection)
      await reconciliation.refreshProjectedEvents(connection, uid, input.updateId, actionId)
      await require('./review/bank-channel-candidates').synchronize(connection, uid, input.updateId, actionId, null, { reuseDecisions: false })
      await require('./review/issue-store').collapseInstallmentIssues(connection, uid, input.updateId, actionId)
      await reconciliation.recalculateUpdateCounts(connection, uid, input.updateId, input.version, actionId, input.version, batch.duplicateEvidenceDelta)
      await connection.query('SAVEPOINT local_post')
      postingStarted = true
      const result = await postInTransaction(connection, uid, { updateId: input.updateId, version: input.version }, digest)
      // Transport copies include raw evidence. Remove every generation/upload
      // in the same commit as the ledger and receipt; chunks cascade with them.
      // Receipt replay is checked before loading objects, so recovery needs no
      // retained snapshot. A delete or receipt failure rolls everything back.
      await connection.execute('DELETE FROM catledger_import_review_objects WHERE uid=? AND update_id=?', [uid, input.updateId])
      return result
    } catch (error) {
      batchState.end(connection)
      // Unexpected DB/process failures roll back the outer transaction, leaving
      // the request unknown and safe to replay. Business failures are definitive.
      if (!error.publicCode || ['IDEMPOTENCY_CONFLICT','INITIALIZATION_REQUIRED'].includes(error.publicCode)) throw error
      if (postingStarted) await connection.query('ROLLBACK TO SAVEPOINT local_post')
      const supplemental = await recheckFacts(connection, uid, captured, error.publicCode, batch.affected)
      await connection.query('ROLLBACK TO SAVEPOINT local_review')
      const recheck = await saveObject(connection, uid, { objectId: randomUUID(), updateId: input.updateId, snapshotId: input.snapshotId,
        kind: 'recheck', baseVersion: input.version, ruleVersion: PLAN_VERSION }, split(JSON.stringify(supplemental)))
      return { update: repository.publicUpdate(current), outcome: 'recheck', recheck }
    } finally { batchState.end(connection) }
  } })
}
module.exports = { post, validateChoices, scopes, selectedAccountProblems }
