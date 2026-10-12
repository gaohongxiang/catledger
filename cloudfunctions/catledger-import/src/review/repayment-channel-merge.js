const { randomUUID } = require('node:crypto')
const channel = require('../repayment-channel')
const { importError } = require('../errors')
const { mergeText } = require('../editor-fields')
const { FIELD_MASK } = require('../manual-field-mask')
const { mergeOrigins } = require('./merge-origins')
const { insertMany } = require('../sql-batch')

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
    const [[remaining]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issue_members
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
    distinct.set(`${reference.sourceType}:${reference.paymentMethodKey}`, reference)
  }
  await insertMany(connection, `INSERT INTO catledger_finance_update_account_mapping_drafts
    (uid,draft_mapping_id,update_id,event_id,source_type,payment_method_key,payment_method_hint,mapping_action,account_id,action_id) VALUES`,
  [...distinct.values()].map(reference => [uid, randomUUID(), updateId, primary.eventId, reference.sourceType,
    reference.paymentMethodKey, String(reference.label || '').slice(0, 128), 'account', primary.counterpartyLedgerAccountId, actionId]),
  ` ON DUPLICATE KEY UPDATE payment_method_hint=VALUES(payment_method_hint),account_id=VALUES(account_id),
    mapping_action=VALUES(mapping_action),action_id=VALUES(action_id)`)
}

async function migrateBankAccount(connection, uid, updateId, bank, primary, actionId) {
  // 银行来源映射继续指向到账信用卡，不能跟随平台主记录改成付款资产。
  const [mappings] = await connection.execute(`SELECT source_type AS sourceType,payment_method_key AS paymentMethodKey,
    payment_method_hint AS hint,mapping_action AS action,account_id AS accountId
    FROM catledger_finance_update_account_mapping_drafts WHERE uid=? AND update_id=? AND event_id=?`, [uid, updateId, bank.eventId])
  if (mappings.some(row => row.action !== 'account' || row.accountId !== bank.ledgerAccountId)) throw importError('VALIDATION_ERROR')
  await insertMany(connection, `INSERT INTO catledger_finance_update_account_mapping_drafts
    (uid,draft_mapping_id,update_id,event_id,source_type,payment_method_key,payment_method_hint,mapping_action,account_id,action_id) VALUES`,
  mappings.map(row => [uid, randomUUID(), updateId, primary.eventId, row.sourceType, row.paymentMethodKey,
    row.hint, row.action, row.accountId, actionId]),
  ' ON DUPLICATE KEY UPDATE account_id=VALUES(account_id),mapping_action=VALUES(mapping_action),action_id=VALUES(action_id)')
  const [members] = await connection.execute(`SELECT m.member_id AS memberId,m.issue_id AS issueId,m.sort_order AS sortOrder
    FROM catledger_review_issue_members m JOIN catledger_review_issues i ON i.uid=m.uid AND i.issue_id=m.issue_id
    WHERE m.uid=? AND m.update_id=? AND m.object_type='event' AND m.object_id=? AND i.issue_type='account_mapping'
      AND i.status IN ('open','resolved')`, [uid, updateId, bank.eventId])
  for (const member of members) {
    const [[existing]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issue_members
      WHERE uid=? AND update_id=? AND issue_id=? AND object_type='event' AND object_id=? AND member_role='mapping_to'`,
    [uid, updateId, member.issueId, primary.eventId])
    await connection.execute('DELETE FROM catledger_review_issue_members WHERE uid=? AND update_id=? AND member_id=?', [uid, updateId, member.memberId])
    if (Number(existing.count)) await connection.execute(`UPDATE catledger_review_issues SET member_count=member_count-1,version=version+1
      WHERE uid=? AND update_id=? AND issue_id=?`, [uid, updateId, member.issueId])
    else await connection.execute(`INSERT INTO catledger_review_issue_members
      (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order)
      VALUES (?,?,?,?,'event',?,?,'mapping_to',?)`,
    [uid, member.memberId, updateId, member.issueId, primary.eventId, primary.version + 1, Number(member.sortOrder)])
  }
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
  const facts = channel.pairFacts(pair.bank, pair.platform)
  if (!facts) throw importError('VALIDATION_ERROR')
  const bankRows = pair.bank.relationEvidence.rows, platformRows = pair.platform.relationEvidence.rows
  const primary = mergeText(pair.platform, [pair.bank, pair.platform])
  const projection = primary.fieldSources.fundsProjection
  const bankReference = pair.bank.fieldSources.ledgerAccountReference
  if (!projection || !projection.from || !bankReference || !bankReference.paymentMethodKey) throw importError('VALIDATION_ERROR')
  const resolution = { version: channel.VERSION, confirmedBy: 'user', repaymentConfirmed: false, actionId,
    totalMinor: facts.totalMinor, repaymentMinor: facts.repaymentMinor, feeMinor: facts.feeMinor,
    targetAccountId: facts.targetAccountId, feeCategoryId: null,
    localAt: primary.localAt, utcAt: primary.utcAt, platformType: platformRows[0].sourceType,
    platformTargetReference: projection.to || null,
    bankRowIds: bankRows.map(row => row.rowId), platformRowIds: platformRows.map(row => row.rowId),
    basisDigest: channel.evidenceDigest(bankRows.concat(platformRows)) }
  const next = { ...primary, counterpartyLedgerAccountId: facts.targetAccountId,
    manualFieldMask: primary.manualFieldMask | FIELD_MASK.counterpartyLedgerAccountId | FIELD_MASK.repaymentOwnership,
    fieldSources: { ...primary.fieldSources, bankChannelCandidate: undefined,
      mergeOrigins: mergeOrigins([pair.bank, pair.platform]),
      rowIds: platformRows.concat(bankRows).map(row => row.rowId),
      fundsProjection: { ...projection, to: { ...bankReference, role: 'repayment_target' } },
      repaymentOwnership: { version: 'repayment-ownership-v2', confirmedBy: 'user', owner: 'self' },
      repaymentChannelResolution: resolution },
    reasonCodes: primary.reasonCodes.filter(reason => !['repayment_account_required', 'repayment_ownership_required'].includes(reason)) }
  if (!channel.evidenceValid(next, bankRows.concat(platformRows))) throw importError('VALIDATION_ERROR')
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
