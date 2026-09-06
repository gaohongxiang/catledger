const { semanticBlockers } = require('./semantic-policy')
const { digestParts, stableValue } = require('./digest')
const SNAPSHOT_VERSION = 'semantic-analysis-v2'
const ordered = (values) => values.sort((a, b) => JSON.stringify(stableValue(a)).localeCompare(JSON.stringify(stableValue(b))))
const hash = (value) => digestParts(SNAPSHOT_VERSION, JSON.stringify(stableValue(value)))
const ref = (value) => value ? { sourceType: value.sourceType || null, key: value.paymentMethodKey || null } : null

// 仅用于诊断与差分，不代替事务版本和锁；随机对象 ID 通过物理证据键消解。
function buildAnalysisSnapshot({ rows, plan, versions = {}, decisions = [], files = [] }) {
  const rowKeys = new Map()
  for (const row of rows) {
    if (!row.evidenceKey || rowKeys.has(row.rowId)) throw new Error('ANALYSIS_EVIDENCE_INVALID')
    rowKeys.set(row.rowId, row.evidenceKey)
  }
  if (new Set(rowKeys.values()).size !== rows.length) throw new Error('ANALYSIS_EVIDENCE_DUPLICATE')
  const eventKeys = new Map(plan.events.map((event) => [event.eventId, hash(
    plan.evidence.filter((link) => link.eventId === event.eventId).map((link) => rowKeys.get(link.rowId)).sort()
  )]))
  const eventKey = (id) => {
    if (!eventKeys.has(id)) throw new Error('ANALYSIS_EVENT_MISSING')
    return eventKeys.get(id)
  }
  const content = {
    files: ordered(files),
    rows: ordered(rows.map((row) => ({
      key: row.evidenceKey, profile: row.sourceFormat, parseState: row.parseState,
      resolutionStatus: row.analysisResolution || row.semantic && row.semantic.resolutionStatus || null,
      blockers: semanticBlockers(row.semantic).sort(),
      action: row.analysisAction || row.semantic && row.semantic.sourceAction || null,
      moneyEffect: row.analysisMoneyEffect || row.semantic && row.semantic.moneyEffect || null,
      amountMinor: row.amountMinor, currency: row.currency,
      endpoint: ref(row.analysisEndpoint || row.semantic && row.semantic.ledgerAccountRef),
      from: ref(row.analysisProjection && row.analysisProjection.from || row.semantic && row.semantic.fromAccountRef),
      to: ref(row.analysisProjection && row.analysisProjection.to || row.semantic && row.semantic.toAccountRef)
    }))),
    events: ordered(plan.events.map((event) => ({
      key: eventKey(event.eventId), economicNature: event.economicNature, flowDirection: event.flowDirection,
      amountMinor: event.amountMinor, currency: event.currency, utcAt: event.utcAt,
      ledgerAccountId: event.ledgerAccountId || null, counterpartyLedgerAccountId: event.counterpartyLedgerAccountId || null,
      categoryId: event.categoryId || null, status: event.status,
      allocations: ordered((event.fieldSources && event.fieldSources.repaymentAllocations || []).map((item) => ({
        accountId: item.accountId, amountMinor: String(item.amountMinor)
      })))
    }))),
    evidence: ordered(plan.evidence.map((link) => {
      if (!rowKeys.has(link.rowId)) throw new Error('ANALYSIS_ROW_MISSING')
      return { row: rowKeys.get(link.rowId), event: eventKey(link.eventId), role: link.evidenceRole }
    })),
    relations: ordered(plan.relations.map((relation) => ({
      source: eventKey(relation.sourceEventId), target: eventKey(relation.targetEventId),
      type: relation.relationType, status: relation.status, amountMinor: relation.amountMinor || null
    }))),
    decisions: ordered(decisions.map((decision) => ({
      event: eventKey(decision.eventId), decision: decision.decision,
      // 调用者提供规范化的用户决定字段；摘要覆盖决定，不输出原始字段。
      fieldsDigest: hash(decision.fields || {})
    })))
  }
  return { version: SNAPSHOT_VERSION, versions, content, contentDigest: hash(content), digest: hash({ content, versions }) }
}

function compareAnalysisSnapshots(before, after) {
  const changes = []
  for (const section of ['files', 'rows', 'events']) {
    const left = new Map((before.content[section] || []).map((item) => [item.key, item]))
    const right = new Map((after.content[section] || []).map((item) => [item.key, item]))
    if (left.size !== (before.content[section] || []).length || right.size !== (after.content[section] || []).length) throw new Error('ANALYSIS_KEY_COLLISION')
    for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      if (!left.has(key) || !right.has(key)) changes.push({ section, key, kind: left.has(key) ? 'removed' : 'added', fields: [] })
      else {
        const fields = [...new Set([...Object.keys(left.get(key)), ...Object.keys(right.get(key))])].filter((field) => hash(left.get(key)[field]) !== hash(right.get(key)[field]))
        if (fields.length) changes.push({ section, key, kind: 'changed', fields })
      }
    }
  }
  for (const section of ['evidence', 'relations', 'decisions']) {
    if (hash(before.content[section]) !== hash(after.content[section])) changes.push({ section, kind: 'changed', fields: [] })
  }
  return { version: SNAPSHOT_VERSION, equal: changes.length === 0, beforeDigest: before.digest, afterDigest: after.digest, changes }
}
module.exports = { SNAPSHOT_VERSION, buildAnalysisSnapshot, compareAnalysisSnapshots }
