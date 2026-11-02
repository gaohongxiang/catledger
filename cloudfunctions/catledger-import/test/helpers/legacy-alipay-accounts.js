// 合成 v34 夹具：保留来源身份，仅恢复当时花呗/信用购各自的账户语义。
const { randomUUID } = require('node:crypto')
const { digestParts } = require('../../src/digest')
const { memberReference } = require('../../src/account-issue-grouping')
const methods = new Set(['花呗', '江苏银行信用购'])
const parse = value => typeof value === 'string' ? JSON.parse(value) : value

function legacyReference(reference, method) {
  if (!reference || reference.sourceType !== 'alipay' || reference.referenceKind !== 'atomic') return reference
  return { ...reference, paymentMethodKey: digestParts('payment-method-v1', 'alipay', method),
    accountIdentityKey: 'account-identity-v2:alipay:' + method,
    label: method === '花呗' ? '支付宝花呗' : method }
}

function legacyFields(value, method = null) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => legacyFields(item, method))
  const result = Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['bindingKey', 'binding', 'accountBindingVersion'].includes(key))
    .map(([key, item]) => [key, legacyFields(item, method)]))
  return method ? legacyReference(result, method) : result
}

async function legacyAlipayAccounts(pool, uid, batchId) {
  const [rows] = await pool.execute('SELECT row_id AS rowId,payment_method_raw AS method,semantic_json AS semantic FROM catledger_import_rows WHERE uid=? AND batch_id=?', [uid, batchId])
  for (const row of rows) {
    if (!methods.has(row.method)) continue
    const semantic = legacyFields(parse(row.semantic), row.method)
    const key = digestParts('payment-method-v1', 'alipay', row.method)
    await pool.execute('UPDATE catledger_import_rows SET payment_method_key=?,semantic_json=? WHERE uid=? AND row_id=?', [key, JSON.stringify(semantic), uid, row.rowId])
  }
}

// 现规则 prepare 会重新生成 scoped references；仅改源行已不能产生旧图。
// 夹具在 prepare 后恢复已存图，事件/证据/成员 ID 不变，旧账户项按原引用拆开。
async function restoreLegacyAccountPlan(pool, uid, updateId) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.execute(`SELECT e.event_id AS eventId,r.payment_method_raw AS method,
      r.semantic_json AS semantic FROM catledger_event_evidence e JOIN catledger_import_rows r
      ON r.uid=e.uid AND r.row_id=e.row_id WHERE e.uid=? AND e.update_id=? AND e.evidence_role='primary'`, [uid, updateId])
    const sourceByEvent = new Map(rows.map(row => [row.eventId, row]))
    const candidates = [...new Map(rows.filter(row => methods.has(row.method)).map(row => {
      const reference = legacyFields(parse(row.semantic).ledgerAccountRef, row.method)
      return [reference.paymentMethodKey, reference]
    })).values()]
    if (candidates.length !== 2) throw new Error('Legacy fixture requires both distinct Alipay credit references')
    const [events] = await connection.execute(`SELECT event_id AS eventId,field_sources_json AS fields
      FROM catledger_economic_events WHERE uid=? AND update_id=?`, [uid, updateId])
    const byId = new Map()
    for (const event of events) {
      const method = sourceByEvent.get(event.eventId)?.method
      const fieldSources = legacyFields(parse(event.fields), methods.has(method) ? method : null)
      const target = fieldSources.fundsProjection?.to
      if (target?.referenceKind === 'aggregate') target.candidates = candidates
        .filter(reference => (reference.aggregateFamilies || []).includes(target.aggregateFamily))
        .map(({ sourceType, paymentMethodKey, label, accountIdentityKey, aggregateFamilies }) =>
          ({ sourceType, paymentMethodKey, label, accountIdentityKey, aggregateFamilies }))
      await connection.execute('UPDATE catledger_economic_events SET field_sources_json=? WHERE uid=? AND update_id=? AND event_id=?',
        [JSON.stringify(fieldSources), uid, updateId, event.eventId])
      byId.set(event.eventId, { eventId: event.eventId, fieldSources })
    }
    const [members] = await connection.execute(`SELECT m.member_id AS memberId,m.issue_id AS issueId,
      m.object_id AS objectId,m.member_role AS memberRole FROM catledger_review_issue_members m
      JOIN catledger_review_issues i ON i.uid=m.uid AND i.issue_id=m.issue_id
      WHERE m.uid=? AND m.update_id=? AND m.object_type='event' AND i.issue_type='account_mapping'
        AND i.status IN ('open','resolved') ORDER BY m.issue_id,m.sort_order,m.member_id`, [uid, updateId])
    const byIssue = new Map()
    for (const member of members) {
      const reference = memberReference(byId.get(member.objectId), member)
      if (!reference) throw new Error('Legacy account fixture member has no reference')
      if (!byIssue.has(member.issueId)) byIssue.set(member.issueId, new Map())
      const groups = byIssue.get(member.issueId), key = reference.accountIdentityKey || reference.paymentMethodKey
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(member)
    }
    for (const [originalId, groups] of byIssue) {
      if (groups.size < 2) continue
      let first = true
      for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
        const issueId = first ? originalId : randomUUID()
        const count = new Set(group.map(member => member.objectId)).size
        const issueKey = digestParts('synthetic-legacy-account-plan-v34', updateId, originalId, key)
        if (first) await connection.execute('UPDATE catledger_review_issues SET issue_key=?,member_count=? WHERE uid=? AND issue_id=?',
          [issueKey, count, uid, issueId])
        else await connection.execute(`INSERT INTO catledger_review_issues
          (uid,issue_id,update_id,issue_key,issue_key_version,issue_type,status,version,blocking,
           primary_reason_code,member_count,candidate_count,rule_version,reason_codes_json,resolved_action_id)
          SELECT uid,?,update_id,?,issue_key_version,issue_type,status,version,blocking,
            primary_reason_code,?,candidate_count,rule_version,reason_codes_json,resolved_action_id
          FROM catledger_review_issues WHERE uid=? AND issue_id=?`, [issueId, issueKey, count, uid, originalId])
        for (const [sortOrder, member] of group.entries()) await connection.execute(
          'UPDATE catledger_review_issue_members SET issue_id=?,sort_order=? WHERE uid=? AND member_id=?',
          [issueId, sortOrder, uid, member.memberId])
        first = false
      }
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

module.exports = { legacyAlipayAccounts, restoreLegacyAccountPlan }
