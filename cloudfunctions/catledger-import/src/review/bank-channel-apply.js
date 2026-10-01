const { importError } = require('../errors')
const { chunks } = require('../sql-batch')
const { hasSourceIdentityConflict } = require('../evidence-matching')
const { bankChannelPair } = require('../bank-channel-matching')
const { confirmedPrimary, mergeRelations } = require('./bank-channel-merge')
const { stageAccountMappings } = require('./account-mapping-stage')
const { saveEvents } = require('./event-store')
const { updateMappingMemberVersions, createFollowUpIssues } = require('./issue-store')
const { resolvedReasons } = require('./policy')
const { remember, markDistinct } = require('./bank-channel-decisions')

// 内部原子批处理；调用方已经取得用户/批次锁。局部校验不调用公开单笔命令。
async function applyPairs(connection, uid, updateId, pairs, actionId, { persistDecisions = true } = {}) {
  if (!pairs.length) return []
  const ids = pairs.flatMap(pair => [pair.bank.eventId, pair.platform.eventId])
  if (new Set(ids).size !== ids.length) throw importError('VALIDATION_ERROR')
  for (const part of chunks(ids.map(id => [id]))) {
    const [[linked]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_economic_event_transactions
      WHERE uid = ? AND update_id = ? AND event_id IN (${part.map(() => '?').join(',')})`, [uid, updateId, ...part.flat()])
    if (Number(linked.count)) throw importError('CONFLICT')
  }
  for (const pair of pairs) {
    if (!bankChannelPair(pair.bank, pair.platform) ||
      hasSourceIdentityConflict(pair.bank.relationEvidence.rows.concat(pair.platform.relationEvidence.rows))) throw importError('IDENTITY_CONFLICT')
  }
  if (persistDecisions) await remember(connection, uid, pairs, actionId)
  // 仅撤销受影响的旧派生问题；余下成员由同一次收尾按剩余边重建。
  for (const part of chunks(ids.map(id => [id]))) await connection.execute(`UPDATE catledger_review_issues i
    SET i.status = 'superseded', i.blocking = 0, i.version = i.version + 1, i.resolved_action_id = ?
    WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND i.issue_type <> 'account_mapping'
      AND EXISTS (SELECT 1 FROM catledger_review_issue_members m WHERE m.uid = i.uid AND m.issue_id = i.issue_id
        AND m.object_type = 'event' AND m.member_role <> 'candidate' AND m.object_id IN (${part.map(() => '?').join(',')}))`,
  [actionId, uid, updateId, ...part.flat()])
  const changes = [], merged = []
  for (const pair of pairs) {
    if (pair.decision === 'distinct') {
      markDistinct(pair)
      for (const event of [pair.bank, pair.platform]) changes.push({ current: event,
        next: { ...event, fieldSources: { ...event.fieldSources, bankChannelCandidate: undefined },
          reasonCodes: resolvedReasons('same_event', event.reasonCodes), resolvingIssueType: 'same_event' } })
      continue
    }
    if (pair.decision !== 'same') throw importError('VALIDATION_ERROR')
    const primary = await confirmedPrimary(connection, uid, updateId, [pair.bank, pair.platform], pair.platform.eventId,
      actionId, { hydratedEvents: [pair.bank, pair.platform] })
    await mergeRelations(connection, uid, updateId, primary.eventId, pair.bank.eventId, { syncMembers: false })
    await connection.execute(`UPDATE catledger_event_evidence SET event_id = ?,
      evidence_role = CASE WHEN evidence_role = 'discarded' THEN 'discarded' ELSE 'supporting' END
      WHERE uid = ? AND update_id = ? AND event_id = ?`, [primary.eventId, uid, updateId, pair.bank.eventId])
    // 所有关系已迁往保留事件；原成员/映射通过现有级联和下面的统一同步处理。
    const [deleted] = await connection.execute(`DELETE FROM catledger_economic_events
      WHERE uid = ? AND update_id = ? AND event_id = ? AND version = ? AND status IN ('ready', 'needs_action')`,
    [uid, updateId, pair.bank.eventId, pair.bank.version])
    if (deleted.affectedRows !== 1) throw importError('CONFLICT')
    merged.push(primary)
    changes.push({ current: pair.platform, next: { ...primary,
      reasonCodes: resolvedReasons('same_event', primary.reasonCodes), resolvingIssueType: 'same_event' } })
  }
  const removedIds = pairs.filter(pair => pair.decision === 'same').map(pair => pair.bank.eventId)
  for (const part of chunks(removedIds.map(id => [id]))) await connection.execute(`DELETE FROM catledger_review_issue_members
    WHERE uid = ? AND update_id = ? AND object_type = 'event' AND object_id IN (${part.map(() => '?').join(',')})`, [uid, updateId, ...part.flat()])
  await connection.execute(`UPDATE catledger_review_issue_members m JOIN catledger_economic_event_relations r
    ON r.uid = m.uid AND r.relation_id = m.object_id SET m.object_version = r.version
    WHERE m.uid = ? AND m.update_id = ? AND m.object_type = 'relation'`, [uid, updateId])
  await connection.execute(`UPDATE catledger_review_issues i SET member_count =
    (SELECT COUNT(*) FROM catledger_review_issue_members m WHERE m.uid = i.uid AND m.issue_id = i.issue_id)
    WHERE i.uid = ? AND i.update_id = ? AND i.status = 'superseded' AND i.resolved_action_id = ?`, [uid, updateId, actionId])
  // 相同账户的来源映射、引用校验、事件版本和后续问题各批量完成一次。
  const byAccount = new Map()
  for (const event of merged) {
    if (!byAccount.has(event.ledgerAccountId)) byAccount.set(event.ledgerAccountId, [])
    byAccount.get(event.ledgerAccountId).push(event.eventId)
  }
  for (const [accountId, eventIds] of byAccount) await stageAccountMappings(connection, uid, updateId, eventIds, accountId, actionId)
  const saved = await saveEvents(connection, uid, updateId, changes, actionId)
  await updateMappingMemberVersions(connection, uid, updateId, saved)
  await createFollowUpIssues(connection, uid, updateId, saved)
  if (merged.length) await connection.execute(`UPDATE catledger_finance_updates
    SET duplicate_evidence_count = duplicate_evidence_count + ? WHERE uid = ? AND update_id = ?`, [merged.length, uid, updateId])
  return saved
}
module.exports = { applyPairs }
