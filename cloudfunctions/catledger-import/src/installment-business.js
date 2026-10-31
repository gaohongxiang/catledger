// 分期业务的展示与入账角色。来源行和证据始终保留，合卡只改变工作台投影。
const hintOf = event => event && (event.fieldSources && event.fieldSources.disbursement || event.disbursement)
const isRegistration = event => Boolean(hintOf(event) && hintOf(event).role === 'registration')
const isPlanSource = event => Boolean(hintOf(event) && ['disbursement', 'registration'].includes(hintOf(event).role))
const hasPlan = event => {
  const plan = event && event.fieldSources && event.fieldSources.installmentPlan || event && event.installmentPlanDecision
  return Boolean(plan && ['link', 'create'].includes(plan.action) && plan.loanId && plan.accountId === event.ledgerAccountId)
}
const OFFSET_REASONS = new Set(['economic_nature_required', 'installment_offset_pair', 'strong_same_event'])
const HISTORICAL_OR_CONFLICT = new Set(['already_posted', 'linked_existing_transaction', 'identity_conflict',
  'identity_review_required', 'core_fields_conflict', 'source_group_conflict', 'row_semantic_conflict'])
function indexByRow(events) {
  const index = new Map()
  for (const event of events) for (const id of event.fieldSources && event.fieldSources.rowIds || []) index.set(id, event)
  return index
}
function hiddenOffset(event, byRow) {
  const hint = hintOf(event), fields = event.fieldSources || {}, reasons = event.reasonCodes || []
  if (!hint || hint.role !== 'offset' || !hint.partnerRowId || event.status !== 'excluded' ||
      Number(event.manualFieldMask || 0) || event.hasTransaction || (event.existingTransactionIds || []).length ||
      !reasons.includes('installment_offset_pair') || reasons.some(code => !OFFSET_REASONS.has(code)) ||
      (fields.semanticBlockers || []).length) return false
  const main = byRow.get(hint.partnerRowId), other = hintOf(main)
  return Boolean(main && main.eventId !== event.eventId && (!main.updateId || !event.updateId || main.updateId === event.updateId) &&
    other && other.role === 'disbursement' && (fields.rowIds || []).includes(other.partnerRowId) &&
    main.economicNature === 'borrow' && main.status !== 'corrected' &&
    !(main.reasonCodes || []).some(code => HISTORICAL_OR_CONFLICT.has(code)) &&
    !(main.fieldSources.semanticBlockers || []).length)
}
function visibleEvents(events) {
  const index = indexByRow(events)
  return events.filter(event => !hiddenOffset(event, index))
}
// 与 hiddenOffset 同一条件；分页、计数和分组先过滤再 LIMIT，避免空页或错误总数。
function visibleSql(alias = 'e') {
  const f = `${alias}.field_sources_json`, reasons = `${alias}.reason_codes_json`
  const path = (value, key) => `JSON_UNQUOTE(JSON_EXTRACT(${value},'$.${key}'))`
  return `NOT (COALESCE(${path(f, 'disbursement.role')},'') = 'offset'
    AND ${alias}.status = 'excluded' AND ${alias}.manual_field_mask = 0
    AND JSON_CONTAINS(${reasons},'"installment_offset_pair"')
    AND JSON_CONTAINS('${JSON.stringify([...OFFSET_REASONS])}',${reasons})
    AND COALESCE(JSON_LENGTH(JSON_EXTRACT(${f},'$.semanticBlockers')),0) = 0
    AND NOT EXISTS (SELECT 1 FROM catledger_economic_event_transactions t WHERE t.uid=${alias}.uid AND t.event_id=${alias}.event_id AND t.superseded_at IS NULL)
    AND EXISTS (SELECT 1 FROM catledger_event_evidence v JOIN catledger_economic_events main
      ON main.uid=v.uid AND main.update_id=v.update_id AND main.event_id=v.event_id
      WHERE v.uid=${alias}.uid AND v.update_id=${alias}.update_id AND v.evidence_role<>'discarded'
      AND v.row_id=${path(f, 'disbursement.partnerRowId')} AND main.event_id<>${alias}.event_id
      AND ${path('main.field_sources_json', 'disbursement.role')}='disbursement'
      AND JSON_CONTAINS(JSON_EXTRACT(${f},'$.rowIds'),JSON_EXTRACT(main.field_sources_json,'$.disbursement.partnerRowId'))
      AND main.economic_nature='borrow' AND main.status<>'corrected'
      AND COALESCE(JSON_LENGTH(JSON_EXTRACT(main.field_sources_json,'$.semanticBlockers')),0)=0
      AND NOT (${[...HISTORICAL_OR_CONFLICT].map(code => `JSON_CONTAINS(main.reason_codes_json,'"${code}"')`).join(' OR ')}))) `
}
module.exports = { hintOf, isRegistration, isPlanSource, hasPlan, indexByRow, hiddenOffset, visibleEvents, visibleSql }
