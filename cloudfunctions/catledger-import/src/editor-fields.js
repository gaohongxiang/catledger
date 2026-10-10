// 单笔编辑的有效文本与真实资金角色；原始凭据保持独立。
const ASSETS = new Set(['cash', 'bank', 'wallet', 'other_asset'])
const DEBTS = new Set(['credit', 'other_liability'])
const MOVEMENTS = new Set(['internal_transfer', 'repayment', 'borrow'])
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
function overrides(event) {
  const value = event.fieldSources && event.fieldSources.editorOverrides
  return value && value.version === 1 ? value : {}
}
function effectiveText(event, source = event) {
  const value = overrides(event)
  return { counterparty: has(value, 'counterparty') ? value.counterparty : source.counterparty || '',
    note: has(value, 'note') ? value.note : source.sourceNote || source.note || '' }
}
function funds(event) {
  const fields = event.fieldSources || {}
  const editor = overrides(event)
  const allocated = editor.composition ? editor.composition !== 'single' : fields.paymentResolution || (fields.repaymentAllocations || []).length
  const reverse = MOVEMENTS.has(event.economicNature) && !allocated && event.sourceDirection === 'income'
  return { sourceAccountId: reverse ? event.counterpartyLedgerAccountId : event.ledgerAccountId,
    destinationAccountId: reverse ? event.ledgerAccountId : event.counterpartyLedgerAccountId, reverse }
}
function accountRolesValid(event, accounts) {
  const fields = event.fieldSources || {}, primary = fields.installment
  if (primary && primary.creditStatement && primary.component === 'principal') {
    return !event.ledgerAccountId || accounts.get(event.ledgerAccountId)?.type === 'credit'
  }
  if (fields.repaymentOwnership && fields.repaymentOwnership.owner === 'other' && event.ledgerAccountId && !ASSETS.has(accounts.get(event.ledgerAccountId)?.type)) return false
  if (!['borrow', 'repayment'].includes(event.economicNature)) return true
  const route = funds(event)
  const incomplete = overrides(event).incompleteComposition
  const sources = incomplete && incomplete.kind === 'payment' ? incomplete.parts.map(part => part.accountId) : fields.paymentResolution ? fields.paymentResolution.allocations.map(part => part.accountId) : [route.sourceAccountId]
  const destinations = incomplete && incomplete.kind === 'repayment' ? incomplete.parts.map(part => part.accountId) : (fields.repaymentAllocations || []).length ? fields.repaymentAllocations.map(part => part.accountId) : [route.destinationAccountId]
  const allowedFrom = event.economicNature === 'borrow' ? DEBTS : ASSETS
  const allowedTo = event.economicNature === 'borrow' ? ASSETS : DEBTS
  return sources.every(id => !id || allowedFrom.has(accounts.get(id)?.type)) &&
    destinations.every(id => !id || allowedTo.has(accounts.get(id)?.type))
}
// 合并仅继承唯一、明确的人工文本；冲突必须先逐笔裁决，不能丢掉另一来源的人工值。
function mergeText(primary, events) {
  const editor = { ...overrides(primary) }, mask = require('./manual-field-mask').FIELD_MASK
  let bits = primary.manualFieldMask || 0, changed = false
  for (const key of ['counterparty', 'note']) {
    const values = [...new Set(events.filter(event => has(overrides(event), key)).map(event => overrides(event)[key]))]
    if (values.length > 1) throw require('./errors').importError('VALIDATION_ERROR')
    if (values.length) { editor[key] = values[0]; bits |= mask[key]; changed = true }
  }
  return changed ? { ...primary, manualFieldMask: bits, fieldSources: { ...primary.fieldSources, editorOverrides: { ...editor, version: 1 } } } : primary
}
module.exports = { ASSETS, DEBTS, MOVEMENTS, has, overrides, effectiveText, funds, accountRolesValid, mergeText }
