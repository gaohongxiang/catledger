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
  return decision && decision.version === VERSION && decision.confirmedBy === 'user' ? decision : null
}
function requiresDecision(event) {
  const decision = decisionFor(event)
  return bankRepayment(event) && (!event.counterpartyLedgerAccountId || Boolean(decision && decision.owner === 'other'))
}
function reasonsFor(event) {
  const decision = decisionFor(event)
  if (!bankRepayment(event)) return []
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
module.exports = { VERSION, bankRepayment, decisionFor, requiresDecision, reasonsFor, applyDecision }
