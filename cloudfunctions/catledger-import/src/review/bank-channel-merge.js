const { VERSION, bankChannelPair } = require('../bank-channel-matching')
const { importError } = require('../errors')
const { hydrate, hasBankPlatformEvidence } = require('./bank-channel-hydration')

async function confirmedPrimary(connection, uid, updateId, events, requestedId, actionId, { required = true, hydratedEvents = null } = {}) {
  const hydrated = hydratedEvents || await hydrate(connection, uid, updateId, events)
  if (!required && !hasBankPlatformEvidence(hydrated)) return null
  const primary = require('./pair-primary-policy').ordinaryPrimary(hydrated, requestedId, actionId)
  const banks = hydrated.filter(event => event.sourceType === 'bank')
  const accountContexts = { ...primary.fieldSources.bankChannelAccountContexts }
  const [accountMembers] = await connection.execute(`SELECT m.member_id AS memberId, m.issue_id AS issueId, m.member_role AS role, m.sort_order AS sortOrder
    FROM catledger_review_issue_members m JOIN catledger_review_issues i ON i.uid = m.uid AND i.issue_id = m.issue_id
    WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'event' AND m.object_id = ? AND i.issue_type = 'account_mapping'`,
  [uid, updateId, banks[0].eventId])
  for (const member of accountMembers) {
    const [[existing]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issue_members
      WHERE uid = ? AND update_id = ? AND issue_id = ? AND object_type = 'event' AND object_id = ? AND member_role = ?`,
    [uid, updateId, member.issueId, primary.eventId, member.role])
    if (Number(existing.count)) {
      await connection.execute('DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND member_id = ?', [uid, updateId, member.memberId])
    } else {
      await connection.execute('DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND member_id = ?', [uid, updateId, member.memberId])
      await connection.execute(`INSERT INTO catledger_review_issue_members
        (uid, member_id, update_id, issue_id, object_type, object_id, object_version, member_role, sort_order)
        VALUES (?, ?, ?, ?, 'event', ?, ?, ?, ?)`,
      [uid, member.memberId, updateId, member.issueId, primary.eventId, primary.version + 1, member.role, Number(member.sortOrder)])
      const reference = banks[0].fieldSources.ledgerAccountReference
      if (reference) accountContexts[member.issueId] = { ...reference, fundsSide: 'ordinary' }
    }
  }
  for (const issueId of new Set(accountMembers.map(member => member.issueId))) await connection.execute(`UPDATE catledger_review_issues i
    SET member_count=(SELECT COUNT(DISTINCT m.object_type,m.object_id) FROM catledger_review_issue_members m
      WHERE m.uid=i.uid AND m.issue_id=i.issue_id),version=version+1 WHERE i.uid=? AND i.update_id=? AND i.issue_id=?`,
  [uid, updateId, issueId])
  return { ...primary, fieldSources: { ...primary.fieldSources, bankChannelAccountContexts: accountContexts } }
}

async function mergeRelations(connection, uid, updateId, primaryId, secondaryId, { syncMembers = true } = {}) {
  const [relations] = await connection.execute(`SELECT relation_id AS relationId, relation_type AS type, status,
    source_event_id AS sourceId, target_event_id AS targetId, amount_minor AS amountMinor, currency
    FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ?
      AND (source_event_id IN (?, ?) OR target_event_id IN (?, ?)) FOR UPDATE`,
  [uid, updateId, primaryId, secondaryId, primaryId, secondaryId])
  const projected = relations.map(relation => ({ ...relation,
    nextSource: relation.sourceId === secondaryId ? primaryId : relation.sourceId,
    nextTarget: relation.targetId === secondaryId ? primaryId : relation.targetId }))
  const active = projected.filter(relation => !['rejected', 'undone'].includes(relation.status))
  if (active.some(relation => relation.nextSource === relation.nextTarget)) throw importError('VALIDATION_ERROR')
  const confirmedBySource = new Map()
  for (const relation of active.filter(item => item.type === 'refund_of' && item.status === 'confirmed')) {
    const target = confirmedBySource.get(relation.nextSource)
    if (target && target !== relation.nextTarget) throw importError('VALIDATION_ERROR')
    confirmedBySource.set(relation.nextSource, relation.nextTarget)
  }
  for (const relation of projected.filter(item => item.sourceId === secondaryId || item.targetId === secondaryId)) {
    const prior = active.find(item => item !== relation && item.sourceId !== secondaryId && item.targetId !== secondaryId &&
      item.type === relation.type && item.nextSource === relation.nextSource && item.nextTarget === relation.nextTarget)
    if (prior && relation.status === 'confirmed' && prior.status !== 'confirmed') {
      await connection.execute(`UPDATE catledger_economic_event_relations SET status = 'confirmed', version = version + 1
        WHERE uid = ? AND update_id = ? AND relation_id = ?`, [uid, updateId, prior.relationId])
    }
    await connection.execute(`UPDATE catledger_economic_event_relations SET source_event_id = ?, target_event_id = ?,
      status = ?, version = version + 1 WHERE uid = ? AND update_id = ? AND relation_id = ?`,
    [relation.nextSource, relation.nextTarget, prior ? 'rejected' : relation.status, uid, updateId, relation.relationId])
  }
  // 被合并消费的退款核对可能在另一问题中；关系版本必须同步，避免旧版本永远无法提交。
  if (syncMembers) await connection.execute(`UPDATE catledger_review_issue_members m JOIN catledger_economic_event_relations r
    ON r.uid = m.uid AND r.relation_id = m.object_id SET m.object_version = r.version
    WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'relation'`, [uid, updateId])
}

module.exports = { confirmedPrimary, mergeRelations }
