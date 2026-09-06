const money = require('../../utils/money')
const CONFLICTS = {
  TRANSACTION_SET_CHANGED: '关联交易已发生变化，请刷新后核对',
  WHOLE_UPDATE_UNDO_REQUIRED: '这组记录需要整批撤销后重新整理',
  UPDATE_STATE_CHANGED: '本批账单状态已变化，请重新打开',
  INSUFFICIENT_CASH_BALANCE: '操作会导致现金余额不足',
  EXTERNAL_REFUND_DEPENDENCY: '其他交易的退款仍引用本批记录',
  LEGACY_SIDE_EFFECTS_UNVERIFIED: '此历史批次缺少撤销审计信息，暂不能自动撤销'
}
function fieldsForDraft(draft, accounts, categories) {
  const account = accounts[draft.accountIndex]
  if (!account) throw new Error('请选择有效账户')
  const fields = { amountMinor: money.yuanToMinor(draft.amountYuan), ledgerAccountId: account.accountId }
  if (draft.dual) {
    const other = accounts[draft.otherIndex]
    if (!other) throw new Error('请选择另一端账户')
    fields.counterpartyLedgerAccountId = other.accountId
  }
  if (draft.hasCategory) fields.categoryId = categories[draft.categoryIndex] && categories[draft.categoryIndex].categoryId || null
  if (draft.aggregate) fields.repaymentAllocations = draft.allocations.filter(function (row) { return row.amountYuan !== '' && row.amountYuan !== '0' && row.amountYuan !== '0.00' })
    .map(function (row) { return { accountId: row.accountId, amountMinor: money.yuanToMinor(row.amountYuan) } })
  return fields
}
function impactView(impact, accounts) {
  return Object.assign({}, impact, {
    conflictsText: (impact.conflicts || []).map(function (code) { return CONFLICTS[code] || '当前条件不允许操作，请刷新核对' }).join('；'),
    changes: (impact.accountImpacts || []).map(function (row) {
      const account = accounts.find(function (item) { return item.accountId === row.accountId })
      return { accountId: row.accountId, name: account && account.name || '已停用账户',
        oldText: money.formatMinor(row.oldMinor), newText: money.formatMinor(row.newMinor), deltaText: money.formatMinor(row.deltaMinor) }
    })
  })
}
module.exports = { fieldsForDraft: fieldsForDraft, impactView: impactView }
