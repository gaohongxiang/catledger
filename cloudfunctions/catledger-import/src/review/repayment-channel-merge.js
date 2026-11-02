const { randomUUID } = require('node:crypto')
const channel = require('../repayment-channel')
const { importError } = require('../errors')
const { mergeText } = require('../editor-fields')
const { FIELD_MASK } = require('../manual-field-mask')
const { mergeOrigins } = require('./merge-origins')
const { insertMany } = require('../sql-batch')
const { paymentReferenceKey } = require('../payment-account')
const { mappingRow, saveMappings } = require('./account-binding-store')

async function completePlatformTarget(connection, uid, updateId, primary, actionId, bankIssueIds = []) {
  // 逐对确认只完成当前笔的还入账户，共享账户组的其他成员仍自行核对。
  const [members] = await connection.execute(`SELECT m.member_id AS memberId,m.issue_id AS issueId
    FROM catledger_review_issue_members m JOIN catledger_review_issues i ON i.uid=m.uid AND i.issue_id=m.issue_id
    WHERE m.uid=? AND m.update_id=? AND m.object_type='event' AND m.object_id=?
      AND m.member_role IN ('mapping_to','payment_target') AND i.issue_type='account_mapping'
      AND i.status IN ('open','resolved')
      ${bankIssueIds.length ? `AND i.issue_id NOT IN (${bankIssueIds.map(() => '?').join(',')})` : ''}`,
  [uid, updateId, primary.eventId, ...bankIssueIds])
  for (const member of members) await connection.execute(`DELETE FROM catledger_review_issue_members
    WHERE uid=? AND update_id=? AND member_id=?`, [uid, updateId, member.memberId])
  for (const issueId of new Set(members.map(member => member.issueId))) {
    const [[remaining]] = await connection.execute(`SELECT COUNT(DISTINCT object_type,object_id) AS count FROM catledger_review_issue_members
      WHERE uid=? AND update_id=? AND issue_id=?`, [uid, updateId, issueId])
    const count = Number(remaining.count)
    await connection.execute(`UPDATE catledger_review_issues SET member_count=?,version=version+1,
      status=IF(?=0,'resolved',status),blocking=IF(?=0,0,blocking),resolved_action_id=IF(?=0,?,resolved_action_id)
      WHERE uid=? AND update_id=? AND issue_id=?`, [count, count, count, count, actionId, uid, updateId, issueId])
  }
}

async function stageTargetReferences(connection, uid, updateId, primary, references, actionId) {
  const distinct = new Map()
  for (const reference of references) {
    if (!reference || !reference.sourceType || !reference.paymentMethodKey) continue
    distinct.set(paymentReferenceKey(reference), reference)
  }
  await saveMappings(connection, [...distinct.values()].map(reference =>
    mappingRow(uid, updateId, primary.eventId, reference, primary.counterpartyLedgerAccountId, actionId)))
}

async function migrateBankAccount(connection, uid, updateId, bank, primary, actionId) {
  // 银行来源映射继续指向到账信用卡，不能跟随平台主记录改成付款资产。
  const [mappings] = await connection.execute(`SELECT source_type AS sourceType,payment_method_key AS paymentMethodKey,
    payment_method_hint AS hint,mapping_action AS action,account_id AS accountId,binding_json AS binding
    FROM catledger_finance_update_account_mapping_drafts WHERE uid=? AND update_id=? AND event_id=?`, [uid, updateId, bank.eventId])
  if (mappings.some(row => row.action !== 'account' || row.accountId !== bank.ledgerAccountId)) throw importError('VALIDATION_ERROR')
  await saveMappings(connection,
  mappings.map(row => [uid, randomUUID(), updateId, primary.eventId, row.sourceType, row.paymentMethodKey,
    row.hint, row.action, row.accountId, actionId, typeof row.binding === 'string' ? row.binding : row.binding ? JSON.stringify(row.binding) : null]))
  const [members] = await connection.execute(`SELECT m.member_id AS memberId,m.issue_id AS issueId,m.sort_order AS sortOrder
    FROM catledger_review_issue_members m JOIN catledger_review_issues i ON i.uid=m.uid AND i.issue_id=m.issue_id
    WHERE m.uid=? AND m.update_id=? AND m.object_type='event' AND m.object_id=? AND i.issue_type='account_mapping'
      AND i.status IN ('open','resolved')`, [uid, updateId, bank.eventId])
  for (const member of members) {
    const [[existing]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issue_members
      WHERE uid=? AND update_id=? AND issue_id=? AND object_type='event' AND object_id=? AND member_role='mapping_to'`,
    [uid, updateId, member.issueId, primary.eventId])
    await connection.execute('DELETE FROM catledger_review_issue_members WHERE uid=? AND update_id=? AND member_id=?', [uid, updateId, member.memberId])
    if (!Number(existing.count)) await connection.execute(`INSERT INTO catledger_review_issue_members
      (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order)
      VALUES (?,?,?,?,'event',?,?,'mapping_to',?)`,
    [uid, member.memberId, updateId, member.issueId, primary.eventId, primary.version + 1, Number(member.sortOrder)])
  }
  for (const issueId of new Set(members.map(member => member.issueId))) await connection.execute(`UPDATE catledger_review_issues i
    SET member_count=(SELECT COUNT(DISTINCT m.object_type,m.object_id) FROM catledger_review_issue_members m
      WHERE m.uid=i.uid AND m.issue_id=i.issue_id),version=version+1 WHERE i.uid=? AND i.update_id=? AND i.issue_id=?`,
  [uid, updateId, issueId])
  return [...new Set(members.map(member => member.issueId))].sort()
}

async function confirmDetails(connection, uid, updateId, event, actionId) {
  if (!channel.relationValid(event)) throw importError('VALIDATION_ERROR')
  const pending = channel.resolutionFor(event)
  if (pending.repaymentConfirmed === true) return event
  const [[category]] = pending.feeMinor === '0' ? [[]] : await connection.execute(`SELECT category_id AS categoryId
    FROM catledger_categories WHERE uid=? AND system_key='finance__service' AND kind='expense' AND archived_at IS NULL LIMIT 1`, [uid])
  const resolution = { ...pending, repaymentConfirmed: true, detailsActionId: actionId,
    feeCategoryId: category && category.categoryId || null }
  const next = { ...event, fieldSources: { ...event.fieldSources, repaymentChannelResolution: resolution },
    reasonCodes: (event.reasonCodes || []).filter(reason => reason !== 'repayment_channel_details_required') }
  await completePlatformTarget(connection, uid, updateId, next, actionId, resolution.bankAccountIssueIds || [])
  await stageTargetReferences(connection, uid, updateId, next, [resolution.platformTargetReference], actionId)
  return next
}

async function confirmedPrimary(connection, uid, updateId, pair, actionId) {
  const next = require('./pair-primary-policy').repaymentPrimary(pair, actionId)
  const primary = next, resolution = next.fieldSources.repaymentChannelResolution
  const bankReference = pair.bank.fieldSources.ledgerAccountReference
  // 等额来源可能已有系统推测的还款关系；明确同笔后该关系不再独立存在。
  // 只撤回这两个端点间尚未确认的自动候选，人工确认及其他关系仍由合并门禁保护。
  await connection.execute(`UPDATE catledger_economic_event_relations SET status='rejected',version=version+1
    WHERE uid=? AND update_id=? AND relation_type='repayment_of' AND status='proposed' AND manual=0
      AND ((source_event_id=? AND target_event_id=?) OR (source_event_id=? AND target_event_id=?))`,
  [uid, updateId, pair.bank.eventId, pair.platform.eventId, pair.platform.eventId, pair.bank.eventId])
  resolution.bankAccountIssueIds = await migrateBankAccount(connection, uid, updateId, pair.bank, next, actionId)
  await stageTargetReferences(connection, uid, updateId, next, [bankReference], actionId)
  return pair.repaymentConfirmed === true ? confirmDetails(connection, uid, updateId, next, actionId) : next
}

module.exports = { confirmedPrimary, confirmDetails }
