const { chunks, insertMany, loadEventContexts } = require('../sql-batch')
const { randomUUID } = require('node:crypto')
const { digestParts } = require('../digest')
const { REVIEW_ISSUE_VERSION } = require('../domain-versions')
const { importError } = require('../errors')
const { EVENT_STATUS, REVIEW_ISSUE_TYPE, classifyReviewIssue, needsCategory } = require('../organizer-model')

async function selectIssue(connection, uid, issueId, { forUpdate = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT issue_id AS issueId, update_id AS updateId, issue_key AS issueKey,
            issue_type AS issueType, status, version, blocking,
            primary_reason_code AS primaryReasonCode, member_count AS memberCount,
            candidate_count AS candidateCount, reason_codes_json AS reasonCodes
       FROM catledger_review_issues
      WHERE uid = ? AND issue_id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, issueId]
  )
  if (!rows[0]) throw importError('NOT_FOUND')
  return rows[0]
}

async function selectMembers(connection, uid, issueId) {
  const [rows] = await connection.execute(
    `SELECT member_id AS memberId, update_id AS updateId, issue_id AS issueId,
            object_type AS objectType, object_id AS objectId,
            object_version AS objectVersion, member_role AS memberRole,
            sort_order AS sortOrder
       FROM catledger_review_issue_members
      WHERE uid = ? AND issue_id = ? ORDER BY sort_order, member_id`,
    [uid, issueId]
  )
  return rows.map((row) => ({ ...row, objectVersion: Number(row.objectVersion), sortOrder: Number(row.sortOrder) }))
}

async function updateMappingMemberVersions(connection, uid, updateId, events, otherOpenOnly = false) {
  if (!events.length) return
  const byId = new Map(events.map(event => [event.eventId, event]))
  const [members] = await connection.execute(`SELECT member.member_id AS memberId, member.object_id AS eventId, issue.issue_type AS issueType
    FROM catledger_review_issue_members member JOIN catledger_review_issues issue ON issue.uid = member.uid AND issue.issue_id = member.issue_id
    WHERE member.uid = ? AND member.update_id = ? AND member.object_type = 'event'
      AND ${otherOpenOnly ? "issue.status = 'open' AND issue.issue_type <> 'account_mapping'" : "(issue.status = 'open' OR (issue.issue_type = 'account_mapping' AND issue.status = 'resolved'))"}`, [uid, updateId])
  const rows = members.filter(member => {
    const event = byId.get(member.eventId)
    return event && (otherOpenOnly || member.issueType === 'account_mapping' || event.fieldSources.paymentAccountReferences != null)
  }).map(member => [member.memberId, byId.get(member.eventId).version]).sort((a, b) => a[0].localeCompare(b[0]))
  for (const part of chunks(rows, { parametersPerRow: 3, fixedParameters: 2 })) {
    const [result] = await connection.execute(`UPDATE catledger_review_issue_members SET object_version = CASE member_id
      ${part.map(() => 'WHEN ? THEN ?').join(' ')} END
      WHERE uid = ? AND update_id = ? AND member_id IN (${part.map(() => '?').join(',')})`, [...part.flat(), uid, updateId, ...part.map(row => row[0])])
    if (result.affectedRows !== part.length) throw importError('CONFLICT')
  }
}

async function createFollowUpIssue(connection, uid, updateId, event) {
  return createFollowUpIssues(connection, uid, updateId, [event])
}

async function createFollowUpIssues(connection, uid, updateId, events) {
  const candidates = events.filter(event => event.status === EVENT_STATUS.NEEDS_ACTION || (event.status === EVENT_STATUS.READY && needsCategory(event)))
  if (!candidates.length) return
  const [existing] = await connection.execute(`SELECT member.object_id AS eventId, issue.issue_type AS issueType, issue.blocking
    FROM catledger_review_issues issue JOIN catledger_review_issue_members member ON member.uid = issue.uid AND member.issue_id = issue.issue_id
    WHERE issue.uid = ? AND issue.update_id = ? AND issue.status = 'open' AND member.object_type = 'event'`, [uid, updateId])
  const occupied = new Map()
  for (const row of existing) {
    if (!occupied.has(row.eventId)) occupied.set(row.eventId, new Set())
    occupied.get(row.eventId).add(row.blocking ? '*' : row.issueType)
  }
  const contexts = candidates.some(event => classifyReviewIssue(event).issueType === REVIEW_ISSUE_TYPE.REFUND_RELATION)
    ? await loadEventContexts(connection, uid, updateId) : null
  const issues = [], members = []
  for (const event of candidates) {
    const classification = classifyReviewIssue(event), prior = occupied.get(event.eventId)
    if (prior && (prior.has('*') || prior.has(classification.issueType))) continue
    const relations = classification.issueType === REVIEW_ISSUE_TYPE.REFUND_RELATION ? contexts.get(event.eventId).relations
      .filter(row => row.sourceEventId === event.eventId && row.relationType === 'refund_of' && row.status === 'proposed')
      .sort((a, b) => a.relationId.localeCompare(b.relationId)) : []
    const issueId = randomUUID()
    issues.push([uid, issueId, updateId, digestParts('review-follow-up-v2', updateId, event.eventId, event.version, classification.issueType),
      REVIEW_ISSUE_VERSION, classification.issueType, 'open', 1, classification.issueType !== REVIEW_ISSUE_TYPE.CATEGORY_ASSIGNMENT,
      classification.primaryReason, 1 + relations.length, relations.length, REVIEW_ISSUE_VERSION, JSON.stringify(event.reasonCodes)])
    members.push([uid, randomUUID(), updateId, issueId, 'event', event.eventId, event.version, 'subject', 0])
    relations.forEach((relation, index) => members.push([uid, randomUUID(), updateId, issueId, 'relation', relation.relationId, Number(relation.version), 'candidate', index + 1]))
    occupied.set(event.eventId, new Set([classification.issueType]))
  }
  await insertMany(connection, `INSERT INTO catledger_review_issues (uid, issue_id, update_id, issue_key, issue_key_version, issue_type,
    status, version, blocking, primary_reason_code, member_count, candidate_count, rule_version, reason_codes_json) VALUES`, issues)
  await insertMany(connection, `INSERT INTO catledger_review_issue_members (uid, member_id, update_id, issue_id, object_type, object_id,
    object_version, member_role, sort_order) VALUES`, members)
}

module.exports = { selectIssue, selectMembers, updateMappingMemberVersions, createFollowUpIssue, createFollowUpIssues }
