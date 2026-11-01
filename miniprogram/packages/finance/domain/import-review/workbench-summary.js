// 只汇总金额与数量，原始证据、事件和成员始终从版本分页读取。
const active = event => ['ready', 'needs_action', 'posted'].includes(event.status)
const { effectAmounts } = require('./funds-allocation')
const categoryRequired = event => !require('./installment-business').isRegistration(event) && ['income', 'expense', 'fee', 'unknown'].includes(event.economicNature)
function accountIds(event) {
  const fields = event.fieldSources || {}
  return [...new Set([event.ledgerAccountId, event.counterpartyLedgerAccountId]
    .concat((fields.repaymentAllocations || []).map(row => row.accountId))
    .concat((fields.paymentResolution && fields.paymentResolution.allocations || []).map(row => row.accountId)).filter(Boolean))]
}
const money = value => { const n = String(value || '0').padStart(3, '0'); return '¥' + n.slice(0, -2) + '.' + n.slice(-2) }
function repaymentExpense(event) {
  const allocation = effectAmounts(event)
  if (allocation && event.economicNature === 'repayment') return allocation.expense
  const channel = event.repaymentChannel || event.fieldSources && event.fieldSources.repaymentChannelResolution
  if (channel) return (event.repaymentChannel ? channel.confirmed === true : channel.repaymentConfirmed === true)
    ? BigInt(channel.feeMinor || '0') : 0n
  const value = event.loanRepayment || event.fieldSources && event.fieldSources.loanRepayment
  // 仅为已入账旧记录保留历史展示；待提交草稿不再把还款拆出费用。
  if (!['posted','corrected'].includes(event.status) || !value || !value.confirmed) return 0n
  return ['interest','fee'].reduce((sum,field)=>sum + (value[field+'Treatment'] === 'expense' ? BigInt(value[field+'Minor'] || '0') : 0n),0n)
}
function workbenchSummary(events, pending, issueCounts, duplicateCount, draftCount) {
  events = require('./installment-business').visibleEvents(events)
  const reviewIds = new Set(pending.filter(row => Number(row.review)).map(row => row.eventId))
  const categoryIds = new Set(pending.filter(row => Number(row.category)).map(row => row.eventId))
  const rows = events.filter(active)
  const reviewPending = rows.filter(row => reviewIds.has(row.eventId) || (row.status === 'needs_action' && !categoryIds.has(row.eventId))).length
  const categoryPending = rows.filter(row => categoryRequired(row) && (!row.categoryId || row.economicNature === 'unknown')).length
  const categoryComplete = rows.filter(row => categoryRequired(row) && row.categoryId && row.economicNature !== 'unknown').length
  const historical = row => row.status === 'excluded' && (row.reasonCodes || []).some(reason => ['already_posted', 'linked_existing_transaction'].includes(reason))
  const excluded = events.filter(row => row.status === 'excluded' && !historical(row)).length
  duplicateCount += events.filter(historical).length
  const ready = events.filter(row => row.status === 'ready')
  const sum = natures => ready.filter(row => natures.includes(row.economicNature)).reduce((n, row) => {
    const allocated = effectAmounts(row)
    return n + (allocated && row.economicNature === 'expense' ? allocated.expense : BigInt(row.amountMinor))
  }, 0n)
  const count = natures => ready.filter(row => natures.includes(row.economicNature)).length
  const countIssues = (type, status) => issueCounts.filter(row => row.issueType === type && row.status === status).reduce((n, row) => n + Number(row.count), 0)
  const accountOpen = countIssues('account_mapping', 'open'), accountResolved = countIssues('account_mapping', 'resolved')
  const categoryCount = ready.filter(categoryRequired).length, categorizedCount = ready.filter(row => categoryRequired(row) && row.categoryId).length
  return {
    accountStepSummary: { total: accountOpen + accountResolved, open: accountOpen, pending: accountOpen, confirmed: accountResolved, dirty: 0, invalid: 0 },
    recordSummary: { activeCount: rows.length, excludedCount: excluded, duplicateCount, totalCount: rows.length + excluded + duplicateCount },
    reviewStatusTabs: [{ value: 'pending', label: '待核对', count: reviewPending }, { value: 'completed', label: '已核对', count: rows.length - reviewPending },
      { value: 'excluded', label: '已排除', count: excluded }, { value: 'duplicate', label: '重复', count: duplicateCount }],
    categoryStatusTabs: [{ value: 'pending', label: '待分类', count: categoryPending }, { value: 'completed', label: '已分类', count: categoryComplete },
      { value: 'none', label: '无需分类', count: rows.filter(row => !categoryRequired(row)).length }],
    categoryEventCount: categoryPending, categorizedEventCount: categoryComplete,
    finalSummary: { expenseCount: count(['expense', 'fee']) + ready.filter(e=>repaymentExpense(e)>0n).length,
      incomeCount: count(['income']) + ready.filter(e => (effectAmounts(e)?.income || 0n) > 0n).length, refundCount: count(['refund']),
      expenseText: money(sum(['expense', 'fee']) + ready.reduce((sum,e)=>sum+repaymentExpense(e),0n)),
      incomeText: money(sum(['income']) + ready.reduce((sum,e)=>sum+(effectAmounts(e)?.income || 0n),0n)), refundText: money(sum(['refund'])),
      transferCount: ready.filter(e => ['internal_transfer', 'repayment', 'borrow'].includes(e.economicNature) &&
        (!effectAmounts(e) || effectAmounts(e).transfer > 0n)).length, categoryCount, categorizedCount,
      categoryCoverageText: categoryCount ? categorizedCount + ' / ' + categoryCount : '无需分类', categoryComplete: categoryCount === categorizedCount,
      newAccountCount: draftCount, affectedAccountCount: new Set(ready.flatMap(accountIds)).size },
    fundsFlowGroups: [['internal_transfer', '内部转账'], ['borrow', '借款'], ['repayment', '还款']].map(([nature, label]) =>
      ({ nature, label, count: count([nature]), amountText: money(ready.filter(row => row.economicNature === nature)
        .reduce((total, row) => total + (effectAmounts(row)?.transfer ?? BigInt(row.fieldSources?.repaymentChannelResolution?.repaymentMinor || row.amountMinor)), 0n)), records: [] }))
  }
}
module.exports = { workbenchSummary, accountIds, repaymentExpense, categoryRequired }
