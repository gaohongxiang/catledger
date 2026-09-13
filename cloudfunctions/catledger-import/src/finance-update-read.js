const { selectDomainEvents, effectiveProjectedEvents } = require('./review-issue-service')
const { digestParts } = require('./digest')
const { PLAN_VERSION } = require('./domain-versions')
const { importError } = require('./errors')
const { executeUserRead } = require('./import-transaction')
const { validateUuid } = require('./validation')
const { BUDGET, assertBudget, jsonBytes, pageSize } = require('./performance-contract')
const { encodeCursor, decodeCursor } = require('./view-cursor')
const { selectUpdate, publicUpdate, publicEvent, selectSources, selectEvents, selectIssues, selectCoverageEvidence, selectPlanningRows, parseJson } = require('./finance-update-repository')
const { deriveRowDisposition } = require('./row-disposition')
const { getRowSemantic } = require('./row-semantic-resolver')
const { buildCoverageReport } = require('./coverage-report')
const { analysisFullyObserved } = require('./statement-analysis')
const accountGroups = require('./payment-account-groups')
const { workbenchSummary } = require('./workbench-summary')

async function readVersion(connection, uid, updateId) {
  const update = publicUpdate(await selectUpdate(connection, uid, updateId))
  const [directories] = await connection.execute(`SELECT 'accounts' AS kind, COUNT(*) AS count,
      COALESCE(SUM(version), 0) AS versions, MAX(updated_at) AS updatedAt FROM catledger_accounts WHERE uid = ?
    UNION ALL SELECT 'categories', COUNT(*), COALESCE(SUM(version), 0), MAX(updated_at) FROM catledger_categories WHERE uid = ?
    UNION ALL SELECT 'mappings', COUNT(*), COALESCE(SUM(version), 0), MAX(updated_at) FROM catledger_import_account_mappings WHERE uid = ?`, [uid, uid, uid])
  return { update, viewVersion: digestParts('finance-view-v2', uid, updateId, update.version,
    update.planVersion, PLAN_VERSION, accountGroups.VERSION, JSON.stringify(directories)) }
}

function scopeFor(uid, updateId, viewVersion, kind, filter) {
  return { uid, updateId, kind, filter, order: 'id-asc', viewVersion }
}
function preparePage(context, state, uid, kind, filter) {
  const data = context.data
  if (data.viewVersion != null && data.viewVersion !== state.viewVersion) throw importError('STALE_VIEW')
  const scope = scopeFor(uid, state.update.updateId, state.viewVersion, kind, filter)
  const last = decodeCursor(context.subjectHash, data.cursor, scope)
  if (last != null && (typeof last !== 'string' || !/^[0-9a-f-]{36}$/.test(last))) throw importError('INVALID_CURSOR')
  return { size: pageSize(data.pageSize), last: last || '', scope }
}
function boundedItem(item, key, kind) {
  if (jsonBytes(item) <= 16 * 1024) return item
  if (kind === 'event' && item.primaryEvidence) {
    const preview = Object.fromEntries(Object.entries(item.primaryEvidence).map(([name, value]) => [name,
      typeof value === 'string' && value.length > 120 ? value.slice(0, 120) + '…' : value]))
    const projected = { ...item, primaryEvidence: preview, detailRequired: true, detailKind: 'event' }
    if (jsonBytes(projected) <= 16 * 1024) return projected
  }
  // 明确引用完整详情；原字段仍留库并可通过分段接口取得。
  const result = { [key]: item[key], detailRequired: true, detailKind: kind }
  for (const name of ['version', 'status', 'issueType', 'blocking', 'memberCount', 'candidateCount', 'economicNature',
    'flowDirection', 'localAt', 'amountMinor', 'currency', 'ledgerAccountId', 'counterpartyLedgerAccountId', 'categoryId',
    'evidenceCount', 'duplicateEvidenceCount', 'objectId', 'objectType', 'objectVersion', 'memberRole']) {
    if (item[name] != null) result[name] = item[name]
  }
  return result
}
function finishPage(context, state, page, rows, total, key, kind) {
  const result = { protocolVersion: 2, viewVersion: state.viewVersion, update: state.update, items: [], total: Number(total), nextCursor: null }
  for (const row of rows.slice(0, page.size)) {
    const item = boundedItem(row, key, kind)
    const nextCursor = encodeCursor(context.subjectHash, page.scope, row[key])
    const candidate = { ...result, items: result.items.concat(item), nextCursor }
    // 留出小程序setData封装空间；仍低于对外256KiB最大预算。
    if (jsonBytes(candidate) > 48 * 1024) break
    result.items.push(item)
    result.nextCursor = nextCursor
  }
  if (result.items.length === rows.length && rows.length <= page.size) result.nextCursor = null
  if (rows.length && !result.items.length) throw importError('PAGINATION_REQUIRED')
  return assertBudget(result, 'page')
}
function optionalEnum(value, allowed) {
  if (value == null || value === '') return null
  if (!allowed.includes(value)) throw importError('VALIDATION_ERROR')
  return value
}
function searchText(value) {
  if (value == null) return ''
  if (typeof value !== 'string' || value.length > 80) throw importError('VALIDATION_ERROR')
  return value.trim()
}
const activeSql = "e.status IN ('ready','needs_action','posted')"
const needsCategorySql = "e.economic_nature IN ('income','expense','fee','unknown') AND (e.category_id IS NULL OR e.economic_nature = 'unknown')"
const requiredCategorySql = "e.economic_nature IN ('income','expense','fee','unknown')"
const reviewSql = `EXISTS (SELECT 1 FROM catledger_review_issue_members m JOIN catledger_review_issues i
  ON i.uid = m.uid AND i.update_id = m.update_id AND i.issue_id = m.issue_id
  WHERE m.uid = e.uid AND m.update_id = e.update_id AND m.object_id = e.event_id AND m.object_type = 'event'
    AND m.member_role <> 'candidate' AND i.status = 'open' AND i.blocking = 1 AND i.issue_type <> 'category_assignment')`
const categoryIssueSql = `EXISTS (SELECT 1 FROM catledger_review_issue_members m JOIN catledger_review_issues i
  ON i.uid = m.uid AND i.update_id = m.update_id AND i.issue_id = m.issue_id
  WHERE m.uid = e.uid AND m.update_id = e.update_id AND m.object_id = e.event_id AND m.object_type = 'event'
    AND m.member_role <> 'candidate' AND i.status = 'open' AND i.issue_type = 'category_assignment')`
const pendingReviewSql = `(${reviewSql} OR (e.status = 'needs_action' AND NOT ${categoryIssueSql}))`

async function summary(connection, uid, updateId) {
  const state = await readVersion(connection, uid, updateId)
  const sources = await selectSources(connection, uid, updateId)
  // 汇总仅扫描必要字段；问题成员和原始展示字段独立分页。
  const [rows] = await connection.execute(`SELECT event_id AS eventId, status, economic_nature AS economicNature,
    flow_direction AS flowDirection, amount_minor AS amountMinor, ledger_account_id AS ledgerAccountId,
    counterparty_ledger_account_id AS counterpartyLedgerAccountId, field_sources_json AS fieldSources,
    category_id AS categoryId, event_local_at AS localAt, event_utc_at AS utcAt, currency, reason_codes_json AS reasonCodes FROM catledger_economic_events WHERE uid = ? AND update_id = ?`, [uid, updateId])
  const events = rows.map(row => ({ ...row, status: publicEvent(row).status, reasonCodes: parseJson(row.reasonCodes, []), fieldSources: parseJson(row.fieldSources, {}) }))
  const [pending] = await connection.execute(`SELECT m.object_id AS eventId,
    MAX(i.issue_type <> 'category_assignment' AND i.blocking = 1) AS review, MAX(i.issue_type = 'category_assignment') AS category
    FROM catledger_review_issues i JOIN catledger_review_issue_members m ON m.uid = i.uid AND m.update_id = i.update_id AND m.issue_id = i.issue_id
    WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND m.object_type = 'event' AND m.member_role <> 'candidate' GROUP BY m.object_id`, [uid, updateId])
  const [[duplicates]] = await connection.execute("SELECT COUNT(*) AS count FROM catledger_event_evidence WHERE uid = ? AND update_id = ? AND evidence_role = 'duplicate'", [uid, updateId])
  const [[drafts]] = await connection.execute('SELECT COUNT(*) AS count FROM catledger_finance_update_account_drafts WHERE uid = ? AND update_id = ? AND materialized_at IS NULL', [uid, updateId])
  const [issueCounts] = await connection.execute(`SELECT issue_type AS issueType, status,
    COUNT(*) AS count, SUM(blocking = 1 AND issue_type <> 'category_assignment') AS blockingCount
    FROM catledger_review_issues WHERE uid = ? AND update_id = ? GROUP BY issue_type, status`, [uid, updateId])
  const coverageEvidence = state.update.status === 'abandoned' ? { rows: [], evidence: [] } : await selectCoverageEvidence(connection, uid, updateId)
  const coverage = buildCoverageReport({ sources, events, ...coverageEvidence })
  coverage.openBlockingIssues = issueCounts.filter(row => row.status === 'open').reduce((n, row) => n + Number(row.blockingCount), 0)
  coverage.selectedEventsReadyToPost = coverage.selectedEventsReadyToPost && coverage.openBlockingIssues === 0 && state.update.planVersion === PLAN_VERSION
  const totals = {}
  for (const event of events) {
    const key = event.economicNature + ':' + event.status
    const value = totals[key] || { economicNature: event.economicNature, status: event.status, count: 0, amountMinor: '0' }
    value.count++; value.amountMinor = String(BigInt(value.amountMinor) + BigInt(event.amountMinor || 0))
    totals[key] = value
  }
  const [[posting]] = await connection.execute(`SELECT created_transaction_count AS createdTransactionCount,
    reused_transaction_count AS reusedTransactionCount FROM catledger_finance_update_postings
    WHERE uid = ? AND update_id = ? AND state = 'completed' ORDER BY completed_at DESC LIMIT 1`, [uid, updateId])
  return assertBudget({ protocolVersion: 2, ...state,
    workbench: workbenchSummary(events, pending, issueCounts, Number(duplicates.count), Number(drafts.count)),
    sources: sources.map(({ analysis, ...source }) => ({ ...source, observationsPassed: analysisFullyObserved(analysis) })),
    coverage, totals: Object.values(totals), issueCounts: issueCounts.map(row => ({ ...row, count: Number(row.count), blockingCount: Number(row.blockingCount) })),
    posting: posting ? { createdTransactionCount: Number(posting.createdTransactionCount), reusedTransactionCount: Number(posting.reusedTransactionCount) } : null,
    freshness: { viewRevision: state.viewVersion, accountGroupsVersion: accountGroups.VERSION,
      requiresAccountGroupRefresh: state.update.status === 'review' && accountGroups.needsExpansion(events, coverageEvidence.rows, coverageEvidence.evidence) }
  }, 'summary')
}

async function eventPage(connection, uid, context, state) {
  const data = context.data
  const status = optionalEnum(data.status, ['ready', 'needs_action', 'excluded', 'posted', 'corrected', 'duplicate'])
  const eventId = data.eventId == null ? null : validateUuid(data.eventId)
  const issueId = data.issueId == null ? null : validateUuid(data.issueId)
  const nature = optionalEnum(data.economicNature, ['income', 'expense', 'refund', 'fee', 'internal_transfer', 'repayment', 'unknown', 'borrow', 'balance_adjustment'])
  const view = optionalEnum(data.view, ['active', 'review_pending', 'review_completed', 'category_pending', 'category_completed', 'category_none', 'expense', 'posted'])
  const accountId = data.accountId == null ? null : validateUuid(data.accountId)
  const query = searchText(data.query)
  const page = preparePage(context, state, uid, 'events', { status, eventId, issueId, nature, view, accountId, query })
  let where = 'e.uid = ? AND e.update_id = ?'
  const values = [uid, state.update.updateId]
  if (eventId) { where += ' AND e.event_id = ?'; values.push(eventId) }
  if (status === 'duplicate') where += " AND EXISTS (SELECT 1 FROM catledger_event_evidence v WHERE v.uid = e.uid AND v.update_id = e.update_id AND v.event_id = e.event_id AND v.evidence_role = 'duplicate')"
  else if (status) { where += ' AND e.status = ?'; values.push(status) }
  if (nature) { where += ' AND e.economic_nature = ?'; values.push(nature) }
  if (view === 'expense') where += " AND e.economic_nature IN ('expense','fee')"
  else if (view === 'posted') where += " AND e.status IN ('posted', 'corrected')"
  else if (view) {
    where += ' AND ' + activeSql
    if (view === 'review_pending') where += ' AND ' + pendingReviewSql
    if (view === 'review_completed') where += ' AND NOT ' + pendingReviewSql
    if (view === 'category_pending') where += ' AND (' + needsCategorySql + ')'
    if (view === 'category_completed') where += ' AND (' + requiredCategorySql + ') AND NOT (' + needsCategorySql + ')'
    if (view === 'category_none') where += ' AND NOT (' + requiredCategorySql + ')'
  }
  if (accountId) { where += ` AND (e.ledger_account_id = ? OR e.counterparty_ledger_account_id = ? OR JSON_SEARCH(e.field_sources_json, 'one', ?, NULL,
    '$.repaymentAllocations[*].accountId', '$.paymentResolution.allocations[*].accountId') IS NOT NULL)`; values.push(accountId, accountId, accountId) }
  if (query) { where += ` AND EXISTS (SELECT 1 FROM catledger_event_evidence v JOIN catledger_import_rows r ON r.uid = v.uid AND r.row_id = v.row_id
    WHERE v.uid = e.uid AND v.update_id = e.update_id AND v.event_id = e.event_id AND (LOCATE(?, r.item_raw) > 0 OR LOCATE(?, r.counterparty_raw) > 0))`; values.push(query, query) }
  if (issueId) { where += " AND EXISTS (SELECT 1 FROM catledger_review_issue_members m WHERE m.uid = e.uid AND m.update_id = e.update_id AND m.object_type = 'event' AND m.object_id = e.event_id AND m.issue_id = ?)"; values.push(issueId) }
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM catledger_economic_events e WHERE ${where}`, values)
  const [ids] = await connection.execute(`SELECT e.event_id AS eventId FROM catledger_economic_events e WHERE ${where} AND e.event_id > ? ORDER BY e.event_id LIMIT ?`, [...values, page.last, page.size + 1])
  const items = ids.length ? await selectEvents(connection, uid, state.update.updateId, { eventIds: ids.map(row => row.eventId) }) : []
  const byId = new Map(items.map(item => [item.eventId, item]))
  return finishPage(context, state, page, ids.map(row => byId.get(row.eventId)), count.total, 'eventId', 'event')
}

async function issuePage(connection, uid, context, state) {
  const status = optionalEnum(context.data.status, ['open', 'resolved', 'superseded'])
  const issueType = context.data.issueType == null ? null : context.data.issueType
  if (issueType && (typeof issueType !== 'string' || !/^[a-z_]{1,64}$/.test(issueType))) throw importError('VALIDATION_ERROR')
  const group = optionalEnum(context.data.group, ['accounts', 'review', 'category'])
  const query = searchText(context.data.query)
  const page = preparePage(context, state, uid, 'issues', { status, issueType, group, query })
  const values = [uid, state.update.updateId]
  let where = 'uid = ? AND update_id = ?'
  if (status) { where += ' AND status = ?'; values.push(status) }
  if (issueType) { where += ' AND issue_type = ?'; values.push(issueType) }
  if (group === 'accounts') where += " AND issue_type = 'account_mapping' AND status IN ('open','resolved')"
  if (group === 'review') where += " AND issue_type NOT IN ('account_mapping','category_assignment') AND blocking = 1"
  if (group === 'category') where += " AND issue_type = 'category_assignment'"
  if (query) {
    where += ` AND issue_id IN (SELECT m.issue_id FROM catledger_review_issue_members m
      JOIN catledger_event_evidence v ON v.uid = m.uid AND v.update_id = m.update_id AND v.event_id = m.object_id
      JOIN catledger_import_rows r ON r.uid = v.uid AND r.row_id = v.row_id
      WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'event' AND (LOCATE(?, r.item_raw) > 0 OR LOCATE(?, r.counterparty_raw) > 0))`
    values.push(uid, state.update.updateId, query, query)
  }
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM catledger_review_issues WHERE ${where}`, values)
  const [ids] = await connection.execute(`SELECT issue_id AS issueId FROM catledger_review_issues WHERE ${where} AND issue_id > ? ORDER BY issue_id LIMIT ?`, [...values, page.last, page.size + 1])
  const items = ids.length ? await selectIssues(connection, uid, state.update.updateId, { issueIds: ids.map(row => row.issueId), includeMembers: false }) : []
  const byId = new Map(items.map(item => [item.issueId, item]))
  return finishPage(context, state, page, ids.map(row => byId.get(row.issueId)), count.total, 'issueId', 'issue')
}

async function presentationEvents(connection, uid, updateId, ids) {
  if (!ids.length) return []
  const visible = await selectEvents(connection, uid, updateId, { eventIds: ids })
  const projected = await effectiveProjectedEvents(connection, uid, updateId,
    await selectDomainEvents(connection, uid, updateId, ids))
  const byId = new Map(projected.map(event => [event.eventId, event]))
  return visible.map(event => {
    const resolved = byId.get(event.eventId)
    const fields = resolved.fieldSources
    return { ...event, ledgerAccountId: resolved.ledgerAccountId, counterpartyLedgerAccountId: resolved.counterpartyLedgerAccountId,
      paymentComponents: fields.paymentComponents || [], paymentResolution: fields.paymentResolution || null,
      paymentAccounts: fields.paymentAccounts || null, fundsProjection: fields.fundsProjection || event.fundsProjection,
      repaymentAllocations: fields.repaymentAllocations || [] }
  })
}

async function memberPage(connection, uid, context, state) {
  const issueId = validateUuid(context.data.issueId)
  const memberKind = optionalEnum(context.data.memberKind, ['event', 'relation'])
  const page = preparePage(context, state, uid, 'members', { issueId, memberKind })
  const condition = memberKind ? ' AND object_type = ?' : ''
  const values = [uid, state.update.updateId, issueId, ...(memberKind ? [memberKind] : [])]
  const [[issue]] = await connection.execute('SELECT version FROM catledger_review_issues WHERE uid = ? AND update_id = ? AND issue_id = ?', [uid, state.update.updateId, issueId])
  if (!issue) throw importError('NOT_FOUND')
  const [[count]] = await connection.execute('SELECT COUNT(*) AS total FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND issue_id = ?' + condition, values)
  const [rows] = await connection.execute(`SELECT member_id AS memberId, object_type AS objectType, object_id AS objectId,
    object_version AS objectVersion, member_role AS memberRole, sort_order AS sortOrder FROM catledger_review_issue_members
    WHERE uid = ? AND update_id = ? AND issue_id = ?${condition} AND member_id > ? ORDER BY member_id LIMIT ?`, [...values, page.last, page.size + 1])
  const relationIds = rows.filter(row => row.objectType === 'relation').map(row => row.objectId)
  const relations = relationIds.length ? (await connection.execute(`SELECT relation_id AS relationId, relation_type AS relationType,
    status, version, source_event_id AS sourceEventId, target_event_id AS targetEventId, amount_minor AS amountMinor, currency
    FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ? AND relation_id IN (${relationIds.map(() => '?').join(',')})`,
  [uid, state.update.updateId, ...relationIds]))[0] : []
  const ids = [...new Set(rows.filter(row => row.objectType === 'event').map(row => row.objectId).concat(relations.map(row => row.targetEventId)).filter(Boolean))]
  const events = ids.length ? await presentationEvents(connection, uid, state.update.updateId, ids) : []
  const byId = new Map(events.map(event => [event.eventId, boundedItem(event, 'eventId', 'event')]))
  const byRelation = new Map(relations.map(row => [row.relationId, { ...row, version: Number(row.version), targetEvent: byId.get(row.targetEventId) || null }]))
  const result = finishPage(context, state, page, rows.map(row => ({ ...row, objectVersion: Number(row.objectVersion), event: byId.get(row.objectId) || null, relation: byRelation.get(row.objectId) || null })), count.total, 'memberId', 'member')
  return { ...result, issueId, issueVersion: Number(issue.version) }
}

async function evidencePage(connection, uid, context, state) {
  const eventId = validateUuid(context.data.eventId)
  const page = preparePage(context, state, uid, 'evidence', { eventId })
  const [[count]] = await connection.execute('SELECT COUNT(*) AS total FROM catledger_event_evidence WHERE uid = ? AND update_id = ? AND event_id = ?', [uid, state.update.updateId, eventId])
  const [rows] = await connection.execute(`SELECT v.evidence_id AS evidenceId, v.evidence_role AS evidenceRole,
    r.row_id AS rowId, r.source_row_number AS rowNumber, r.source_locator AS sourceLocator,
    r.raw_snapshot_version AS rawSnapshotVersion, r.parser_version AS parserVersion,
    s.source_type_snapshot AS sourceType, s.file_name_snapshot AS fileName
    FROM catledger_event_evidence v JOIN catledger_import_rows r ON r.uid = v.uid AND r.row_id = v.row_id
    JOIN catledger_finance_update_sources s ON s.uid = r.uid AND s.update_id = v.update_id AND s.batch_id = r.batch_id
    WHERE v.uid = ? AND v.update_id = ? AND v.event_id = ? AND v.evidence_id > ? ORDER BY v.evidence_id LIMIT ?`, [uid, state.update.updateId, eventId, page.last, page.size + 1])
  return { ...finishPage(context, state, page, rows.map(row => ({ ...row, detailRequired: true })), count.total, 'evidenceId', 'evidence'), eventId }
}

const OPTIONS = Object.freeze({
  accounts: { table: 'catledger_accounts', key: 'account_id', fields: 'name, type, nature, currency, version', condition: 'archived_at IS NULL' },
  categories: { table: 'catledger_categories', key: 'category_id', fields: 'name, kind, system_key AS systemKey, sort_order AS sortOrder, version', condition: 'archived_at IS NULL' },
  accountDrafts: { table: 'catledger_finance_update_account_drafts', key: 'draft_account_id', fields: 'name, type, nature, currency', condition: 'update_id = ? AND materialized_at IS NULL' }
})
async function optionPage(connection, uid, context, state) {
  const kind = context.data.kind
  if (['new_accounts', 'affected_accounts'].includes(kind)) return affectedAccountPage(connection, uid, context, state)
  if (!Object.hasOwn(OPTIONS, kind)) throw importError('VALIDATION_ERROR')
  const option = OPTIONS[kind]
  const query = searchText(context.data.query)
  const id = context.data.id == null ? null : validateUuid(context.data.id)
  const ids = context.data.ids == null ? null : context.data.ids
  if (ids && (!Array.isArray(ids) || ids.length > 100 || !ids.length)) throw importError('VALIDATION_ERROR')
  const selectedIds = ids ? [...new Set(ids.map(validateUuid))].sort() : null
  const page = preparePage(context, state, uid, 'options', { kind, query, id, ids: selectedIds })
  const values = kind === 'accountDrafts' ? [uid, state.update.updateId] : [uid]
  let condition = option.condition
  if (query) { condition += ' AND LOCATE(?, name) > 0'; values.push(query) }
  if (id) { condition += ` AND ${option.key} = ?`; values.push(id) }
  if (selectedIds) { condition += ` AND ${option.key} IN (${selectedIds.map(() => '?').join(',')})`; values.push(...selectedIds) }
  const key = kind === 'categories' ? 'categoryId' : 'accountId'
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM ${option.table} WHERE uid = ? AND ${condition}`, values)
  const [rows] = await connection.execute(`SELECT ${option.key} AS ${key}, ${option.fields} FROM ${option.table} WHERE uid = ? AND ${condition} AND ${option.key} > ? ORDER BY ${option.key} LIMIT ?`, [...values, page.last, page.size + 1])
  return finishPage(context, state, page, rows, count.total, key, kind)
}

async function affectedAccountPage(connection, uid, context, state) {
  const kind = context.data.kind
  const page = preparePage(context, state, uid, 'options', { kind })
  const catalog = `(SELECT account_id AS accountId, name, type, 0 AS isDraft FROM catledger_accounts WHERE uid = ?
    UNION ALL SELECT draft_account_id, name, type, 1 FROM catledger_finance_update_account_drafts WHERE uid = ? AND update_id = ? AND materialized_at IS NULL) a`
  const membership = `e.uid = ? AND e.update_id = ? AND e.status = 'ready' AND (e.ledger_account_id = a.accountId OR e.counterparty_ledger_account_id = a.accountId
    OR JSON_SEARCH(e.field_sources_json, 'one', a.accountId, NULL, '$.repaymentAllocations[*].accountId', '$.paymentResolution.allocations[*].accountId') IS NOT NULL)`
  const where = kind === 'new_accounts' ? 'a.isDraft = 1' : `EXISTS (SELECT 1 FROM catledger_economic_events e WHERE ${membership})`
  const base = [uid, uid, state.update.updateId], args = [uid, state.update.updateId]
  const values = [...base, ...(kind === 'new_accounts' ? [] : args)]
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS total FROM ${catalog} WHERE ${where}`, values)
  const [rows] = await connection.execute(`SELECT a.*, (SELECT COUNT(*) FROM catledger_economic_events e WHERE ${membership}) AS count
    FROM ${catalog} WHERE ${where} AND a.accountId > ? ORDER BY a.accountId LIMIT ?`, [...args, ...values, page.last, page.size + 1])
  return finishPage(context, state, page, rows.map(row => ({ ...row, count: Number(row.count), isDraft: Boolean(row.isDraft) })), count.total, 'accountId', kind)
}

async function detail(connection, uid, context, state) {
  const eventId = validateUuid(context.data.eventId)
  const evidenceId = context.data.evidenceId == null ? null : validateUuid(context.data.evidenceId)
  if (context.data.viewVersion != null && context.data.viewVersion !== state.viewVersion) throw importError('STALE_VIEW')
  const scope = scopeFor(uid, state.update.updateId, state.viewVersion, 'detail', { eventId, evidenceId })
  const offset = decodeCursor(context.subjectHash, context.data.cursor, scope) || 0
  if (!Number.isInteger(offset) || offset < 0) throw importError('INVALID_CURSOR')
  let text
  if (evidenceId) {
    const [[row]] = await connection.execute(`SELECT SUBSTRING(CAST(r.raw_fields_json AS CHAR CHARACTER SET utf8mb4), ?, 2048) AS part,
      CHAR_LENGTH(CAST(r.raw_fields_json AS CHAR CHARACTER SET utf8mb4)) AS length FROM catledger_event_evidence v
      JOIN catledger_import_rows r ON r.uid = v.uid AND r.row_id = v.row_id
      WHERE v.uid = ? AND v.update_id = ? AND v.event_id = ? AND v.evidence_id = ?`, [offset + 1, uid, state.update.updateId, eventId, evidenceId])
    if (!row || offset > row.length) throw importError('NOT_FOUND')
    return assertBudget({ protocolVersion: 2, viewVersion: state.viewVersion, eventId, evidenceId, format: 'json-text', part: row.part,
      nextCursor: offset + 2048 < Number(row.length) ? encodeCursor(context.subjectHash, scope, offset + 2048) : null }, 'page')
  }
  const events = await selectEvents(connection, uid, state.update.updateId, { eventIds: [eventId] })
  if (!events[0]) throw importError('NOT_FOUND')
  text = JSON.stringify(events[0])
  if (offset > text.length) throw importError('INVALID_CURSOR')
  return assertBudget({ protocolVersion: 2, viewVersion: state.viewVersion, eventId, format: 'json-text', part: text.slice(offset, offset + 2048),
    nextCursor: offset + 2048 < text.length ? encodeCursor(context.subjectHash, scope, offset + 2048) : null }, 'page')
}

async function rowPage(connection, uid, context, state) {
  const page = preparePage(context, state, uid, 'rows', {})
  const [[count]] = await connection.execute(`SELECT SUM(total_row_count) AS total FROM catledger_finance_update_sources WHERE uid = ? AND update_id = ?`, [uid, state.update.updateId])
  const [ids] = await connection.execute(`SELECT r.row_id AS rowId FROM catledger_import_rows r JOIN catledger_finance_update_sources s
    ON s.uid = r.uid AND s.batch_id = r.batch_id WHERE s.uid = ? AND s.update_id = ? AND r.row_id > ? ORDER BY r.row_id LIMIT ?`,
  [uid, state.update.updateId, page.last, page.size + 1])
  if (!ids.length) return finishPage(context, state, page, [], count.total, 'rowId', 'row')
  const rows = await selectPlanningRows(connection, uid, state.update.updateId, ids.map(row => row.rowId))
  const [links] = await connection.execute(`SELECT row_id AS rowId, event_id AS eventId, evidence_role AS evidenceRole FROM catledger_event_evidence
    WHERE uid = ? AND update_id = ? AND row_id IN (${ids.map(() => '?').join(',')})`, [uid, state.update.updateId, ...ids.map(row => row.rowId)])
  const events = await selectEvents(connection, uid, state.update.updateId, { eventIds: [...new Set(links.map(row => row.eventId))] })
  const byId = new Map(events.map(event => [event.eventId, event]))
  const byRow = new Map(rows.map(row => [row.rowId, row]))
  return finishPage(context, state, page, ids.map(({ rowId }) => {
    const row = byRow.get(rowId)
    return { ...deriveRowDisposition({ ...row, semantic: getRowSemantic(row), issues: parseJson(row.issues, []) }, links.filter(link => link.rowId === rowId), byId),
      rowNumber: row.rowNumber, sourceType: row.sourceType, sourceOrder: row.sourceOrder }
  }), count.total, 'rowId', 'row')
}

async function issueDetail(connection, uid, context, state) {
  const issueId = validateUuid(context.data.issueId)
  const issues = await selectIssues(connection, uid, state.update.updateId, { issueIds: [issueId], includeMembers: false })
  if (!issues[0]) throw importError('NOT_FOUND')
  const page = await memberPage(connection, uid, context, state)
  const subject = issues[0].subject && (await presentationEvents(connection, uid, state.update.updateId, [issues[0].subject.eventId]))[0]
  return assertBudget({ protocolVersion: 2, viewVersion: state.viewVersion, update: state.update,
    issue: boundedItem(issues[0], 'issueId', 'issue'), subject: subject ? boundedItem(subject, 'eventId', 'event') : null,
    members: page.items, total: page.total, nextCursor: page.nextCursor }, 'page')
}

function createFinanceUpdateRead({ getPool }) {
  function read(operation, kind) { return context => executeUserRead({ getPool, ...context, consistentSnapshot: true,
    operation: async (connection, uid) => {
      let updateId = context.data.updateId == null ? null : validateUuid(context.data.updateId)
      if (!updateId && kind === 'issue') {
        const [[issue]] = await connection.execute('SELECT update_id AS updateId FROM catledger_review_issues WHERE uid = ? AND issue_id = ?', [uid, validateUuid(context.data.issueId)])
        if (!issue) throw importError('NOT_FOUND')
        updateId = issue.updateId
      }
      if (!updateId && ['evidence', 'detail'].includes(kind)) {
        const [[event]] = await connection.execute('SELECT update_id AS updateId FROM catledger_economic_events WHERE uid = ? AND event_id = ?', [uid, validateUuid(context.data.eventId)])
        if (!event) throw importError('NOT_FOUND')
        updateId = event.updateId
      }
      if (!updateId) throw importError('VALIDATION_ERROR')
      if (kind === 'summary') return summary(connection, uid, updateId)
      return operation(connection, uid, context, await readVersion(connection, uid, updateId))
    } }) }
  return {
    rows: read(rowPage), issue: read(issueDetail, 'issue'), summary: read(summary, 'summary'), events: read(eventPage), issues: read(issuePage), members: read(memberPage),
    evidence: read(evidencePage, 'evidence'), options: read(optionPage), detail: read(detail, 'detail') }
}
module.exports = { createFinanceUpdateRead, readVersion, finishPage, summary }
