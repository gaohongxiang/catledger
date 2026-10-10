const { importError } = require('./errors')

const VERSION = 'repayment-ownership-v1'
function bankRepayment(event) {
  const source = event && event.fieldSources || {}
  const projection = source.fundsProjection
  const target = projection && projection.to
  return Boolean(projection && projection.kind === 'repayment' && target && target.referenceKind === 'atomic' &&
    /银行|信用卡|贷记卡/u.test(target.value || target.label || '') && !source.paymentResolution)
}
function decisionFor(event) {
  const decision = event && event.fieldSources && event.fieldSources.repaymentOwnership
  return decision && [VERSION, 'repayment-ownership-v2'].includes(decision.version) && decision.confirmedBy === 'user' ? decision : null
}
function requiresDecision(event) {
  if (event.fieldSources?.editorOverrides?.ownershipCleared) return false
  const decision = decisionFor(event)
  return (bankRepayment(event) || decision && decision.version === 'repayment-ownership-v2') && (!event.counterpartyLedgerAccountId || Boolean(decision && decision.owner === 'other'))
}
function reasonsFor(event) {
  if (event.fieldSources?.editorOverrides?.ownershipCleared) return []
  const decision = decisionFor(event)
  if (!bankRepayment(event) && (!decision || decision.version !== 'repayment-ownership-v2')) return []
  if (decision && decision.owner === 'other') {
    if (event.counterpartyLedgerAccountId || !['expense', 'unknown'].includes(event.economicNature) || event.flowDirection !== 'outflow') return ['repayment_ownership_invalid']
    return decision.treatment === 'pending' || event.economicNature === 'unknown' ? ['repayment_other_treatment_required'] : []
  }
  return !event.counterpartyLedgerAccountId && (!decision || decision.owner !== 'self') ? ['repayment_ownership_required'] : []
}
function applyDecision(event, value) {
  if (!bankRepayment(event) || !value || typeof value !== 'object' || Array.isArray(value)) throw importError('VALIDATION_ERROR')
  const self = value.owner === 'self'
  const other = value.owner === 'other' && ['expense', 'pending'].includes(value.treatment)
  const allowed = self ? ['owner'] : ['owner', 'treatment']
  if ((!self && !other) || Object.keys(value).some(key => !allowed.includes(key))) throw importError('VALIDATION_ERROR')
  if (self && (!event.counterpartyLedgerAccountId || event.counterpartyLedgerAccountId === event.ledgerAccountId)) throw importError('VALIDATION_ERROR')
  const decision = { version: VERSION, confirmedBy: 'user', owner: value.owner, ...(other ? { treatment: value.treatment } : {}) }
  return { ...event,
    economicNature: self ? 'repayment' : value.treatment === 'expense' ? 'expense' : 'unknown',
    flowDirection: self ? 'neutral' : 'outflow',
    counterpartyLedgerAccountId: self ? event.counterpartyLedgerAccountId : null,
    categoryId: null,
    fieldSources: { ...event.fieldSources, repaymentOwnership: decision }
  }
}
// 同一业务归属不依赖来源是否先识别为银行还款。编辑器已在用户事务中核验权限。
function applyEditorDecision(event, value) {
  if (!value || Array.isArray(value) || !['self', 'other'].includes(value.owner) ||
    Object.keys(value).some(key => !['owner', 'treatment'].includes(key))) throw importError('VALIDATION_ERROR')
  const own = value.owner === 'self'
  if (own ? event.economicNature !== 'repayment' || value.treatment != null
    : !['expense', 'pending'].includes(value.treatment) || !['repayment', 'expense', 'unknown'].includes(event.economicNature)) throw importError('VALIDATION_ERROR')
  const old = require('./editor-fields').funds(event)
  const decision = { version: 'repayment-ownership-v2', confirmedBy: 'user', owner: value.owner,
    ...(!own ? { treatment: value.treatment } : {}) }
  const mask = require('./manual-field-mask').FIELD_MASK
  return { ...event, economicNature: own ? 'repayment' : value.treatment === 'expense' ? 'expense' : 'unknown',
    flowDirection: own ? 'neutral' : 'outflow',
    ledgerAccountId: own ? event.ledgerAccountId : old.sourceAccountId,
    counterpartyLedgerAccountId: own ? event.counterpartyLedgerAccountId : null,
    categoryId: own || value.treatment !== 'expense' ? null : event.categoryId,
    manualFieldMask: (event.manualFieldMask || 0) | mask.repaymentOwnership | mask.economicNature | mask.flowDirection |
      mask.ledgerAccountId | mask.counterpartyLedgerAccountId,
    fieldSources: { ...event.fieldSources, repaymentOwnership: decision } }
}
module.exports = { VERSION, applyEditorDecision, bankRepayment, decisionFor, requiresDecision, reasonsFor, applyDecision }
