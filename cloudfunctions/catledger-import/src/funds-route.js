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
  const reverse = MOVEMENTS.has(event.economicNature) && !allocated &&
    fields.fundsProjection?.accountOrder !== 'actual' && event.sourceDirection === 'income'
  return { sourceAccountId: reverse ? event.counterpartyLedgerAccountId : event.ledgerAccountId,
    destinationAccountId: reverse ? event.ledgerAccountId : event.counterpartyLedgerAccountId, reverse }
}

// 旧银行草稿的 ledger 列保存账单观察端。首次采用实际方向投影时只搬动
// 同一个已选账户及其人工位；已有人工性质、两端或组成决定继续使用原存储契约。
function bankProjectionUpgrade(event, projection, rowDirection) {
  const fields = event.fieldSources || {}, { FIELD_MASK } = require('./manual-field-mask')
  if (projection?.kind !== 'bank_transfer' || projection.accountOrder !== 'actual' ||
      fields.fundsProjection?.accountOrder === 'actual') return null
  const protectedMask = FIELD_MASK.economicNature | FIELD_MASK.flowDirection | FIELD_MASK.counterpartyLedgerAccountId |
    FIELD_MASK.paymentResolution | FIELD_MASK.repaymentAllocations | FIELD_MASK.paymentAccounts
  if (fields.fundsProjection || event.manualFieldMask & protectedMask || fields.accountOwnership || fields.repaymentOwnership ||
      fields.installment || fields.disbursement || fields.installmentPlan || fields.repaymentChannelResolution ||
      fields.bankChannelResolution || fields.mergeOrigins?.length || fields.loanRepayment ||
      fields.editorOverrides?.incompleteRepayment || fields.editorOverrides?.incompleteComposition) return { preserve: true }
  if (!['income', 'expense'].includes(event.sourceDirection) || event.sourceDirection !== rowDirection) return { conflict: true }
  const reverse = event.sourceDirection === 'income', mask = event.manualFieldMask || 0
  return { patch: { ledgerAccountId: (reverse ? event.counterpartyLedgerAccountId : event.ledgerAccountId) || null,
    counterpartyLedgerAccountId: (reverse ? event.ledgerAccountId : event.counterpartyLedgerAccountId) || null,
    manualFieldMask: reverse ? (mask & ~(FIELD_MASK.ledgerAccountId | FIELD_MASK.counterpartyLedgerAccountId)) |
      (mask & FIELD_MASK.ledgerAccountId ? FIELD_MASK.counterpartyLedgerAccountId : 0) |
      (mask & FIELD_MASK.counterpartyLedgerAccountId ? FIELD_MASK.ledgerAccountId : 0) : mask } }
}

function preservesBankProjectionAccounts(current, next) {
  const change = bankProjectionUpgrade(current, next.fieldSources?.fundsProjection, next.sourceDirection)
  return Boolean(change?.patch && next.economicNature === 'internal_transfer' &&
    next.manualFieldMask === change.patch.manualFieldMask &&
    (next.ledgerAccountId || null) === change.patch.ledgerAccountId &&
    (next.counterpartyLedgerAccountId || null) === change.patch.counterpartyLedgerAccountId)
}

module.exports = { ASSETS, DEBTS, MOVEMENTS, has, overrides, funds, bankProjectionUpgrade, preservesBankProjectionAccounts }
