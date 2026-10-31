// 资金的实际方向与事件存储方向独立；此模块不依赖任何业务配对规则。
const ASSETS = new Set(['cash', 'bank', 'wallet', 'other_asset'])
const DEBTS = new Set(['credit', 'other_liability'])
const MOVEMENTS = new Set(['internal_transfer', 'repayment', 'borrow'])
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key)
function overrides(event) {
  const value = event.fieldSources && event.fieldSources.editorOverrides
  return value && value.version === 1 ? value : {}
}
function funds(event) {
  const fields = event.fieldSources || {}, editor = overrides(event)
  const allocated = editor.composition ? editor.composition !== 'single' : fields.paymentResolution || (fields.repaymentAllocations || []).length
  const reverse = MOVEMENTS.has(event.economicNature) && !allocated && event.sourceDirection === 'income'
  return { sourceAccountId: reverse ? event.counterpartyLedgerAccountId : event.ledgerAccountId,
    destinationAccountId: reverse ? event.ledgerAccountId : event.counterpartyLedgerAccountId, reverse }
}
module.exports = { ASSETS, DEBTS, MOVEMENTS, has, overrides, funds }
