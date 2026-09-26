const { randomUUID } = require('node:crypto')
const { digestParts } = require('./digest')
const { importError } = require('./errors')
const { chunks, insertMany } = require('./sql-batch')

const REASON = 'historical_duplicate_candidate'
const VERSION = 'historical-review-v1'
const MAX_MATCHES = 10000

async function staleHistoricalLinks(connection, uid, updateId) {
  const [rows] = await connection.execute(`SELECT l.link_id AS linkId, l.event_id AS eventId
    FROM catledger_economic_event_transactions l JOIN catledger_economic_events e
      ON e.uid = l.uid AND e.event_id = l.event_id AND e.status = 'excluded'
    LEFT JOIN catledger_transactions t ON t.uid = l.uid AND t.transaction_id = l.transaction_id
    WHERE l.uid = ? AND l.update_id = ? AND l.role = 'historical_primary' AND l.superseded_at IS NULL
      AND (t.transaction_id IS NULL OR t.deleted_at IS NOT NULL OR t.version <> l.transaction_version)`, [uid, updateId])
  return rows
}

// Similarity produces a review obligation, never an automatic financial decision.
// The same user lock used by posting also protects these reads and decisions.
async function historicalGroups(connection, uid, updateId) {
  const [matches] = await connection.execute(`SELECT e.event_id AS eventId, e.version AS eventVersion,
      e.ledger_account_id AS accountId, e.counterparty_ledger_account_id AS otherAccountId,
      e.flow_direction AS flowDirection, e.amount_minor AS amountMinor, e.event_utc_at AS utcAt,
      t.transaction_id AS transactionId, t.version AS transactionVersion
    FROM catledger_economic_events e
    JOIN catledger_transactions t ON t.uid = e.uid AND t.deleted_at IS NULL
      AND t.type <> 'balance_adjustment' AND t.amount_minor = e.amount_minor
      AND t.occurred_local_date BETWEEN DATE_SUB(e.event_local_date, INTERVAL 3 DAY) AND DATE_ADD(e.event_local_date, INTERVAL 3 DAY)
      AND t.occurred_at_utc BETWEEN DATE_SUB(e.event_utc_at, INTERVAL 48 HOUR) AND DATE_ADD(e.event_utc_at, INTERVAL 48 HOUR)
      AND ((e.flow_direction = 'outflow' AND t.source_account_id = e.ledger_account_id)
        OR (e.flow_direction = 'inflow' AND t.destination_account_id = e.ledger_account_id)
        OR (e.flow_direction = 'neutral' AND t.source_account_id = e.ledger_account_id
          AND t.destination_account_id = e.counterparty_ledger_account_id))
    WHERE e.uid = ? AND e.update_id = ? AND e.status IN ('ready', 'needs_action')
      AND e.ledger_account_id IS NOT NULL AND e.currency = 'CNY'
      -- 明确合同收费交给费用身份路径逐项核对；不是以同额跳过一般历史核对。
      AND NOT EXISTS (SELECT 1 FROM catledger_loan_charges f
        JOIN catledger_loan_charge_contracts k ON k.uid=f.uid AND k.contract_id=f.contract_id
        WHERE f.uid=e.uid AND k.account_id=e.ledger_account_id AND f.transaction_id=t.transaction_id
          AND k.reference_key=JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.installment.referenceKey'))
          AND f.charge_key=CONCAT('period:',JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.installment.periodNumber')),':',
            JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.installment.component'))))
      AND NOT EXISTS (SELECT 1 FROM catledger_event_evidence current_evidence
        JOIN catledger_import_rows current_row ON current_row.uid = current_evidence.uid AND current_row.row_id = current_evidence.row_id
        JOIN catledger_import_rows prior_row ON prior_row.uid = current_row.uid AND prior_row.identity_id = current_row.identity_id
        JOIN catledger_event_evidence prior_evidence ON prior_evidence.uid = prior_row.uid AND prior_evidence.row_id = prior_row.row_id
        JOIN catledger_economic_event_transactions linked ON linked.uid = prior_evidence.uid AND linked.event_id = prior_evidence.event_id
        WHERE current_evidence.uid = e.uid AND current_evidence.event_id = e.event_id
          AND current_evidence.evidence_role <> 'discarded' AND prior_evidence.evidence_role <> 'discarded'
          AND current_row.identity_state <> 'identity_conflict' AND linked.transaction_id = t.transaction_id
          AND linked.superseded_at IS NULL AND linked.role IN ('primary', 'refund_transaction', 'repayment_allocation', 'payment_allocation', 'historical_primary'))
    ORDER BY e.event_id, t.transaction_id LIMIT ${MAX_MATCHES + 1}`, [uid, updateId])
  if (matches.length > MAX_MATCHES) throw importError('HISTORY_MATCH_LIMIT_EXCEEDED')
  const groups = new Map()
  for (const row of matches) {
    if (!groups.has(row.eventId)) groups.set(row.eventId, { ...row, candidates: [] })
    groups.get(row.eventId).candidates.push({ transactionId: row.transactionId, version: Number(row.transactionVersion) })
  }
  return [...groups.values()].map(group => ({ ...group, key: digestParts(VERSION, group.eventId,
    group.accountId, group.otherAccountId || '', group.flowDirection, String(group.amountMinor), group.utcAt,
    ...group.candidates.map(row => `${row.transactionId}:${row.version}`)) }))
}

async function historicalIssues(connection, uid, updateId) {
  const [rows] = await connection.execute(`SELECT issue_id AS issueId, issue_key AS issueKey, status
    FROM catledger_review_issues WHERE uid = ? AND update_id = ? AND primary_reason_code = ?`, [uid, updateId, REASON])
  return rows
}

async function synchronizeHistoricalReviews(connection, uid, updateId) {
  const groups = await historicalGroups(connection, uid, updateId)
  const prior = await historicalIssues(connection, uid, updateId)
  const byKey = new Map(prior.map(issue => [issue.issueKey, issue]))
  const activeKeys = new Set(groups.map(group => group.key))
  const supersede = prior.filter(issue => issue.status === 'open' && !activeKeys.has(issue.issueKey)).map(issue => issue.issueId)
  let changed = supersede.length > 0
  for (const part of chunks(supersede.map(id => [id]))) {
    await connection.execute(`UPDATE catledger_review_issues SET status = 'superseded', blocking = 0, version = version + 1
      WHERE uid = ? AND update_id = ? AND issue_id IN (${part.map(() => '?').join(',')})`, [uid, updateId, ...part.flat()])
  }
  const issues = [], members = [], reopen = []
  for (const group of groups) {
    const old = byKey.get(group.key)
    if (old) {
      if (old.status === 'superseded') reopen.push(old.issueId)
      continue
    }
    changed = true
    const issueId = randomUUID()
    issues.push([uid, issueId, updateId, group.key, VERSION, 'same_event', 'open', 1, 1, REASON,
      1, group.candidates.length, VERSION, JSON.stringify([REASON])])
    members.push([uid, randomUUID(), updateId, issueId, 'event', group.eventId, Number(group.eventVersion), 'subject', 0])
    group.candidates.forEach((candidate, index) => members.push([uid, randomUUID(), updateId, issueId, 'transaction',
      candidate.transactionId, candidate.version, 'candidate', index + 1]))
  }
  await insertMany(connection, `INSERT INTO catledger_review_issues (uid,issue_id,update_id,issue_key,issue_key_version,issue_type,
    status,version,blocking,primary_reason_code,member_count,candidate_count,rule_version,reason_codes_json) VALUES`, issues)
  await insertMany(connection, `INSERT INTO catledger_review_issue_members
    (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order) VALUES`, members)
  for (const part of chunks(reopen.map(id => [id]))) {
    changed = true
    await connection.execute(`UPDATE catledger_review_issues SET status = 'open', blocking = 1, version = version + 1
      WHERE uid = ? AND update_id = ? AND issue_id IN (${part.map(() => '?').join(',')})`, [uid, updateId, ...part.flat()])
  }
  // Other decisions may change the event version without changing the matching facts.
  const [versions] = await connection.execute(`UPDATE catledger_review_issue_members m
    JOIN catledger_review_issues i ON i.uid = m.uid AND i.issue_id = m.issue_id
    JOIN catledger_economic_events e ON e.uid = m.uid AND e.update_id = m.update_id AND e.event_id = m.object_id
    SET m.object_version = e.version WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'event'
      AND i.primary_reason_code = ? AND i.status = 'open' AND m.object_version <> e.version`, [uid, updateId, REASON])
  return changed || versions.affectedRows > 0
}

async function assertHistoricalReviewsCurrent(connection, uid, updateId) {
  if ((await staleHistoricalLinks(connection, uid, updateId)).length) throw importError('HISTORY_REVIEW_REQUIRED')
  const groups = await historicalGroups(connection, uid, updateId)
  if (!groups.length) return
  const reviewed = new Set((await historicalIssues(connection, uid, updateId))
    .filter(issue => issue.status === 'resolved').map(issue => issue.issueKey))
  if (groups.some(group => !reviewed.has(group.key))) throw importError('HISTORY_REVIEW_REQUIRED')
}

async function assertHistoricalChoice(connection, uid, updateId, issue, transactionId = null) {
  if (issue.primaryReasonCode !== REASON) throw importError('VALIDATION_ERROR')
  const [keys] = await connection.execute('SELECT issue_key AS issueKey FROM catledger_review_issues WHERE uid = ? AND issue_id = ?', [uid, issue.issueId])
  const group = (await historicalGroups(connection, uid, updateId)).find(item => keys[0] && item.key === keys[0].issueKey)
  if (!group) throw importError('HISTORY_REVIEW_REQUIRED')
  if (transactionId && !group.candidates.some(item => item.transactionId === transactionId)) throw importError('VALIDATION_ERROR')
  return group
}

module.exports = { REASON, staleHistoricalLinks, historicalGroups, synchronizeHistoricalReviews, assertHistoricalReviewsCurrent, assertHistoricalChoice }
