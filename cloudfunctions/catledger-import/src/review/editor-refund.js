// 当前用户事务内的退款候选和关系编辑；候选读取绝不创建关系。
const { randomUUID } = require('node:crypto')
const { importError } = require('../errors')
const { validateUuid } = require('../validation')
const { digestParts } = require('../digest')
const { RELATION_KEY_VERSION } = require('../domain-versions')
const { REFUND_RELATION_STATE_VERSION } = require('../organizer-model')
const fail = () => { throw importError('VALIDATION_ERROR') }
// 已通过可靠来源身份复用到正式退款的待整理事件不再次消耗额度。
// 相似金额/日期/文字不参与去重；正式余额仍只由原 posting 边界改变。
const unpostedRefund = `NOT EXISTS (SELECT 1 FROM catledger_event_evidence se
  JOIN catledger_import_rows sr ON sr.uid=se.uid AND sr.row_id=se.row_id
  JOIN catledger_import_rows pr ON pr.uid=sr.uid AND pr.identity_id=sr.identity_id
  JOIN catledger_event_evidence pe ON pe.uid=pr.uid AND pe.row_id=pr.row_id AND pe.evidence_role<>'discarded'
  JOIN catledger_economic_event_transactions pl ON pl.uid=pe.uid AND pl.event_id=pe.event_id
    AND pl.superseded_at IS NULL AND pl.role IN ('primary','refund_transaction','historical_primary')
  JOIN catledger_transactions pt ON pt.uid=pl.uid AND pt.transaction_id=pl.transaction_id
    AND pt.deleted_at IS NULL AND pt.type='refund' AND pt.original_transaction_id=e.transaction_id
  WHERE se.uid=s.uid AND se.event_id=s.event_id AND se.evidence_role<>'discarded'
    AND sr.identity_id IS NOT NULL AND sr.identity_state<>'identity_conflict' AND pr.identity_state<>'identity_conflict')`
function candidateQuery(uid, refund, kind, { id, after = '', query = '' } = {}) {
  const batch = kind === 'event'
  if (!batch && kind !== 'transaction') fail()
  const key = batch ? 'e.event_id' : 'e.transaction_id'
  const at = batch ? 'e.event_utc_at' : 'e.occurred_at_utc'
  const localAt = batch ? 'e.event_local_at' : 'e.occurred_local_at'
  const currency = batch ? 'e.currency' : "'CNY'"
  const note = batch ? `CONCAT_WS(' ',
    (SELECT r.item_raw FROM catledger_event_evidence v JOIN catledger_import_rows r ON r.uid=v.uid AND r.row_id=v.row_id
      WHERE v.uid=e.uid AND v.update_id=e.update_id AND v.event_id=e.event_id AND v.evidence_role='primary' LIMIT 1),
    JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.editorOverrides.counterparty')),
    JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.editorOverrides.note')))` : 'e.note'
  const total = batch ? `(SELECT COALESCE(SUM(r.amount_minor),0) FROM catledger_economic_event_relations r
    JOIN catledger_economic_events s ON s.uid=r.uid AND s.update_id=r.update_id AND s.event_id=r.source_event_id
    WHERE r.uid=e.uid AND r.update_id=e.update_id AND r.target_event_id=e.event_id AND r.relation_type='refund_of'
      AND r.status='confirmed' AND s.status IN ('ready','needs_action') AND s.event_id<>?)`
    : `(SELECT COALESCE(SUM(t.amount_minor),0) FROM catledger_transactions t WHERE t.uid=e.uid
        AND t.original_transaction_id=e.transaction_id AND t.type='refund' AND t.deleted_at IS NULL)
      + (SELECT COALESCE(SUM(s.amount_minor),0) FROM catledger_economic_events s
        WHERE s.uid=e.uid AND s.status IN ('ready','needs_action') AND s.economic_nature='refund' AND s.event_id<>? AND ${unpostedRefund}
          AND (EXISTS (SELECT 1 FROM catledger_economic_event_transactions l WHERE l.uid=s.uid AND l.event_id=s.event_id
            AND l.role='refund_original' AND l.superseded_at IS NULL AND l.transaction_id=e.transaction_id)
          OR EXISTS (SELECT 1 FROM catledger_economic_event_relations r JOIN catledger_economic_event_transactions l
            ON l.uid=r.uid AND l.update_id=r.update_id AND l.event_id=r.target_event_id
            WHERE r.uid=s.uid AND r.update_id=s.update_id AND r.source_event_id=s.event_id AND r.relation_type='refund_of'
              AND r.status='confirmed' AND l.role IN ('primary','historical_primary') AND l.superseded_at IS NULL AND l.transaction_id=e.transaction_id)))`
  const filters = batch ? `e.update_id=? AND e.event_id<>? AND e.status IN ('ready','needs_action') AND e.economic_nature IN ('expense','fee')
      AND COALESCE(JSON_TYPE(JSON_EXTRACT(e.field_sources_json,'$.paymentResolution')),'NULL')='NULL'
      AND COALESCE(JSON_TYPE(JSON_EXTRACT(e.field_sources_json,'$.loanRepayment')),'NULL')='NULL'
      AND COALESCE(JSON_TYPE(JSON_EXTRACT(e.field_sources_json,'$.installment')),'NULL')='NULL'
      AND NOT JSON_CONTAINS(e.reason_codes_json,JSON_QUOTE('row_status_unknown'))
      AND NOT JSON_CONTAINS(e.reason_codes_json,JSON_QUOTE('refund_source_conflict'))`
    : `e.deleted_at IS NULL AND e.type='expense'
      AND NOT EXISTS (SELECT 1 FROM catledger_loan_payment_transactions p WHERE p.uid=e.uid AND p.active_transaction_id=e.transaction_id)
      AND NOT EXISTS (SELECT 1 FROM catledger_loan_charges c WHERE c.uid=e.uid AND (c.transaction_id=e.transaction_id OR c.balance_adjustment_id=e.transaction_id))
      AND NOT EXISTS (SELECT 1 FROM catledger_economic_event_transactions p WHERE p.uid=e.uid AND p.transaction_id=e.transaction_id
        AND p.superseded_at IS NULL AND p.role IN ('payment_allocation','repayment_allocation'))`
  const values = [refund.eventId, uid, ...(batch ? [refund.updateId, refund.eventId] : []), refund.utcAt, refund.currency]
  let where = ''
  if (id) { where += ` AND ${key}=?`; values.push(validateUuid(id)) }
  if (after) { where += ` AND ${key}>?`; values.push(validateUuid(after)) }
  if (query) { where += ` AND LOCATE(?, COALESCE(${note},''))>0`; values.push(query) }
  values.push(refund.amountMinor)
  return { sql: `SELECT ${key} AS id,e.version,${localAt} AS localAt,${at} AS utcAt,e.amount_minor AS amountMinor,
      ${currency} AS currency,LEFT(${note},160) AS note,e.amount_minor-(${total}) AS remainingMinor
    FROM ${batch ? 'catledger_economic_events' : 'catledger_transactions'} e
    WHERE e.uid=? AND ${filters} AND ${at}<=? AND ${currency}=?${where}
    HAVING remainingMinor>=?`, values }
}
async function candidates(connection, uid, refund, kind, options = {}) {
  const built = candidateQuery(uid, refund, kind, options)
  const countQuery = candidateQuery(uid, refund, kind, { ...options, after: '' })
  const [[count]] = await connection.execute(`SELECT COUNT(*) AS count FROM (${countQuery.sql}) candidates`, countQuery.values)
  const [rows] = await connection.execute(`${built.sql} ORDER BY id LIMIT ?`, [...built.values, options.limit || 21])
  return { total: Number(count.count), items: rows.map(row => ({ ...row, kind, version: Number(row.version),
    amountMinor: String(row.amountMinor), remainingMinor: String(row.remainingMinor) })) }
}
async function currentOriginals(connection, uid, event) {
  const [batch] = await connection.execute(`SELECT r.relation_id AS relationId,r.version AS relationVersion,r.target_event_id AS id,e.version
    FROM catledger_economic_event_relations r JOIN catledger_economic_events e ON e.uid=r.uid AND e.event_id=r.target_event_id
    WHERE r.uid=? AND r.update_id=? AND r.source_event_id=? AND r.relation_type='refund_of' AND r.status='confirmed'`,
  [uid, event.updateId, event.eventId])
  const [history] = await connection.execute(`SELECT l.transaction_id AS id,t.version FROM catledger_economic_event_transactions l
    JOIN catledger_transactions t ON t.uid=l.uid AND t.transaction_id=l.transaction_id
    WHERE l.uid=? AND l.update_id=? AND l.event_id=? AND l.role='refund_original' AND l.superseded_at IS NULL`,
  [uid, event.updateId, event.eventId])
  return batch.map(row => ({ ...row, kind: 'event' })).concat(history.map(row => ({ ...row, kind: 'transaction' })))
}
async function expectations(connection, uid, event) {
  const originals = await currentOriginals(connection, uid, event), result = []
  for (const row of originals) {
    result.push({ kind: row.kind, id: row.id, version: Number(row.version) })
    if (row.relationId) result.push({ kind: 'refund_relation', id: row.relationId, version: Number(row.relationVersion) })
  }
  const loanId = event.fieldSources?.loanRepayment?.loanId || event.fieldSources?.editorOverrides?.incompleteRepayment?.loanId
  if (loanId) {
    const [[loan]] = await connection.execute('SELECT version FROM catledger_loans WHERE uid=? AND loan_id=? AND deleted_at IS NULL', [uid, loanId])
    if (loan) result.push({ kind: 'loan', id: loanId, version: Number(loan.version) })
  }
  return result.sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id))
}
async function validateExpectations(connection, uid, event, value) {
  // 兼容最初的 editor-v1 调用；新版客户端每次传递完整的依赖快照。
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 84) fail()
  for (const row of value) {
    if (!row || Object.keys(row).some(key => !['kind','id','version'].includes(key)) ||
      !['event','transaction','refund_relation','loan'].includes(row.kind) || !Number.isSafeInteger(row.version) || row.version < 1) fail()
    validateUuid(row.id)
  }
  const expected = value.map(row => ({ kind: row.kind, id: row.id, version: row.version })).sort((a, b) => (a.kind + a.id).localeCompare(b.kind + b.id))
  if (JSON.stringify(expected) !== JSON.stringify(await expectations(connection, uid, event))) throw importError('CONFLICT')
}
async function detach(connection, uid, event) {
  await connection.execute(`UPDATE catledger_economic_event_relations SET status='rejected',manual=1,version=version+1
    WHERE uid=? AND update_id=? AND source_event_id=? AND relation_type='refund_of' AND status IN ('proposed','confirmed')`,
  [uid, event.updateId, event.eventId])
  await connection.execute(`UPDATE catledger_economic_event_transactions SET superseded_at=CURRENT_TIMESTAMP(3)
    WHERE uid=? AND update_id=? AND event_id=? AND role='refund_original' AND superseded_at IS NULL`,
  [uid, event.updateId, event.eventId])
}
async function apply(connection, uid, current, next, data) {
  // 原消费被其他退款引用时，改性质、时间或金额必须在同一事务重新验证。
  const [dependents] = await connection.execute(`SELECT r.amount_minor AS amountMinor,s.event_utc_at AS utcAt
    FROM catledger_economic_event_relations r JOIN catledger_economic_events s ON s.uid=r.uid AND s.event_id=r.source_event_id
    WHERE r.uid=? AND r.update_id=? AND r.target_event_id=? AND r.relation_type='refund_of' AND r.status='confirmed'
      AND s.status IN ('ready','needs_action')`, [uid, current.updateId, current.eventId])
  if (dependents.length && (!['expense','fee'].includes(next.economicNature) || !next.utcAt || next.amountMinor == null ||
    dependents.some(row => String(row.utcAt) < next.utcAt) ||
    dependents.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n) > BigInt(next.amountMinor))) fail()
  const old = await currentOriginals(connection, uid, current)
  const requested = data.decisions && data.decisions.refund
  if (old.length > 1) fail()
  if (next.economicNature === 'refund' && (!next.utcAt || next.amountMinor == null)) {
    if (old.length || requested && requested.mode !== 'unlinked') fail()
    return
  }
  if (next.economicNature !== 'refund') {
    if (old.length && !(data.acknowledgedChanges || []).includes('refund')) fail()
    if (current.economicNature === 'refund') { await detach(connection, uid, current); delete next.fieldSources.refundRelation }
    return
  }
  if (next.fieldSources.refundSourceConflict && requested) fail()
  const choice = requested || (old[0] ? { mode: 'link', kind: old[0].kind, id: old[0].id, version: Number(old[0].version) } : null)
  if (!choice) return
  const changed = old.length && (choice.mode !== 'link' || choice.kind !== old[0].kind || choice.id !== old[0].id)
  if (changed && !(data.acknowledgedChanges || []).includes('refund')) fail()
  if (choice.mode === 'link') {
    const result = await candidates(connection, uid, next, choice.kind, { id: choice.id, limit: 1 })
    const original = result.items[0]
    if (!original || !Number.isInteger(choice.version) || original.version !== choice.version) throw importError('CONFLICT')
    if (choice.kind === 'transaction') await require('../loan-transaction-guard').assertNoLoanTransactions(connection, uid, [choice.id])
    // 无关系修改且金额币种不变时只重验，不重写关系版本或形成新链接。
    if (!requested && old.length && current.amountMinor === next.amountMinor && current.currency === next.currency) return
    await detach(connection, uid, current)
    if (choice.kind === 'event') {
      await connection.execute(`INSERT INTO catledger_economic_event_relations
        (uid,relation_id,update_id,relation_key,relation_key_version,relation_type,status,version,source_event_id,target_event_id,amount_minor,currency,manual,rule_version,reason_codes_json)
        VALUES (?,?,?,?,?,'refund_of','confirmed',1,?,?,?,?,1,'editor-refund-v1',JSON_ARRAY('manual_refund_relation'))
        ON DUPLICATE KEY UPDATE status='confirmed',amount_minor=VALUES(amount_minor),currency=VALUES(currency),manual=1,version=version+1`,
      [uid, randomUUID(), next.updateId, digestParts(RELATION_KEY_VERSION, 'refund_of', next.eventId, choice.id), RELATION_KEY_VERSION,
        next.eventId, choice.id, next.amountMinor, next.currency])
    } else {
      await connection.execute(`INSERT INTO catledger_economic_event_transactions
        (uid,link_id,update_id,event_id,transaction_id,role,creation_method,rule_version,transaction_version)
        VALUES (?,?,?,?,?,'refund_original','reused','event-transaction-link-v2',?)
        ON DUPLICATE KEY UPDATE superseded_at=NULL,transaction_version=VALUES(transaction_version)`,
      [uid, randomUUID(), next.updateId, next.eventId, choice.id, choice.version])
    }
    delete next.fieldSources.refundRelation
  } else if (choice.mode === 'pending') {
    if (next.fieldSources.refundSourceConflict || ['row_status_unknown','transaction_status_unknown','refund_source_conflict',
      'source_profile_unknown','identity_conflict','identity_review_required','core_fields_conflict','row_semantic_conflict','same_event_candidate','bank_channel_same_event_candidate'].some(reason =>
      (next.reasonCodes || []).concat(next.fieldSources.semanticBlockers || []).includes(reason))) fail()
    for (const kind of ['event', 'transaction']) if ((await candidates(connection, uid, next, kind, { limit: 1 })).total) fail()
    await detach(connection, uid, current)
    next.fieldSources.refundRelation = { version: REFUND_RELATION_STATE_VERSION, status: 'pending', confirmedBy: 'user' }
  } else if (choice.mode === 'unlinked') {
    await detach(connection, uid, current); delete next.fieldSources.refundRelation
  } else fail()
  const [[group]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issues i JOIN catledger_review_issue_members m
    ON m.uid=i.uid AND m.issue_id=i.issue_id WHERE i.uid=? AND i.update_id=? AND i.status='open' AND i.issue_type='same_event'
      AND m.object_type='event' AND m.object_id=? AND m.member_role<>'candidate'`, [uid, next.updateId, next.eventId])
  if (!Number(group.count)) next.reasonCodes = next.reasonCodes.filter(reason => reason !== 'relation_ambiguous')
  next.reasonCodes = next.reasonCodes.filter(reason => !['refund_relation_required','refund_relation_invalid','refund_relation_ambiguous',
    'refund_amount_exceeded'].includes(reason))
}
module.exports = { candidates, candidateQuery, apply, currentOriginals, expectations, validateExpectations }
