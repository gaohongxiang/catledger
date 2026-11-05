// 入账前对一笔事件引用的账户、分类和资金角色做同一套检查。
// 服务端在事务里调用；本机用同一结果判断复核标记还指不指着这笔。
// “钱怎么走”的判定统一取自 funds-evidence，用户确认单账户后旧的逐成分账户证据
// 不再参与，避免复核放行、入账拒绝的两套标准。
const { unique } = require('../organizer-values')
const { eventAllocation, allocationAccountsValid } = require('../funds-allocation')
const { inspectPaymentAccounts, paymentResolutionForEvent } = require('../payment-resolution')
const { isAggregateRepayment, repaymentAllocationsForEvent } = require('../repayment-allocation')
const repaymentOwnership = require('../repayment-ownership')
const evidence = require('../funds-evidence')

function fieldSourcesOf(event) {
  return event && event.fieldSources || {}
}

function allocationOf(event) {
  const fieldSources = fieldSourcesOf(event)
  const hasAllocationDraft = Object.prototype.hasOwnProperty.call(fieldSources, 'repaymentAllocationVersion') ||
    Object.prototype.hasOwnProperty.call(fieldSources, 'repaymentAllocations')
  return isAggregateRepayment(event) && hasAllocationDraft ? repaymentAllocationsForEvent(event) : null
}

// 单账户确认优先：此时逐成分的 paymentResolution / paymentAccounts 都是过期证据。
const hasPaymentResolution = (event) => Boolean(fieldSourcesOf(event).paymentResolution) && !evidence.single(event)
const hasPaymentAccounts = (event) => Boolean(fieldSourcesOf(event).paymentAccounts) && evidence.pending(event) &&
  !evidence.single(event)

function referencedAccountIds(event) {
  const fieldSources = fieldSourcesOf(event)
  const incomplete = evidence.pendingComposition(event) ? fieldSources.editorOverrides.incompleteComposition : null
  const payment = hasPaymentResolution(event) ? paymentResolutionForEvent(event) : null
  const componentAccounts = hasPaymentAccounts(event) ? inspectPaymentAccounts(event, fieldSources.paymentAccounts, { partial: true }) : null
  const allocation = allocationOf(event)
  return unique([
    ...(incomplete && Array.isArray(incomplete.parts) ? incomplete.parts.map(item => item.accountId) : []),
    ...(componentAccounts && componentAccounts.valid ? componentAccounts.accounts.map(item => item.accountId) : []),
    ...(payment && payment.valid ? payment.resolution.allocations.map(item => item.accountId) : []),
    event && event.ledgerAccountId,
    event && event.counterpartyLedgerAccountId,
    ...(allocation && allocation.valid ? allocation.allocations.map(item => item.accountId) : [])
  ])
}

function referencedCategoryIds(event) {
  const fieldSources = fieldSourcesOf(event)
  return unique([event && event.categoryId, fieldSources.repaymentChannelResolution && fieldSources.repaymentChannelResolution.feeCategoryId])
}

function referenceFailure(event, catalog) {
  const accounts = catalog && catalog.accounts || new Map()
  const categories = catalog && catalog.categories || new Map()
  const fieldSources = fieldSourcesOf(event)
  if (fieldSources.repaymentChannelResolution && !require('../repayment-channel').relationValid(event)) return 'repayment_channel'
  const plan = eventAllocation(event)
  if (plan.kind === 'conflict') return 'allocation'
  const allocation = allocationOf(event)
  if (allocation && !allocation.valid) return 'allocation'
  if (allocation && allocation.allocations.some(item => item.accountId === event.ledgerAccountId)) return 'allocation'
  const payment = hasPaymentResolution(event) ? paymentResolutionForEvent(event) : null
  if (payment && !payment.valid) return 'payment'
  const componentAccounts = hasPaymentAccounts(event) ? inspectPaymentAccounts(event, fieldSources.paymentAccounts, { partial: true }) : null
  if (componentAccounts && !componentAccounts.valid) return 'payment_accounts'
  const accountIds = referencedAccountIds(event)
  if (accountIds.length) {
    const loaded = accountIds.map(id => accounts.get(id)).filter(Boolean)
    if (loaded.length !== accountIds.length || loaded.some(account => account.archivedAt != null || account.supersededAt != null || account.currency !== event.currency)) return 'account'
    const byId = new Map(loaded.map(account => [account.accountId, account]))
    if (!require('../editor-fields').accountRolesValid(event, byId)) return 'account_roles'
    if (fieldSources.accountOwnership && require('../account-ownership').resolve(event, { accounts: loaded }).reasons
      .some(reason => ['account_ownership_invalid', 'account_ownership_business_required'].includes(reason))) return 'ownership'
    if (plan.valid && !allocationAccountsValid(event, plan, byId)) return 'allocation_accounts'
    if (event.counterpartyLedgerAccountId && ((fieldSources.paymentAccountReferences || []).some(ref => ref.memberRole === 'payment_target') ||
      repaymentOwnership.decisionFor(event)?.owner === 'self' && repaymentOwnership.decisionFor(event)?.version === repaymentOwnership.VERSION)) {
      const target = byId.get(event.counterpartyLedgerAccountId)
      if (!target || !['credit', 'other_liability'].includes(target.type)) return 'target_type'
    }
  }
  if (event.categoryId) {
    const category = categories.get(event.categoryId)
    const expectedKind = event.economicNature === 'income' ? 'income' : 'expense'
    if (!category || category.archivedAt != null || !['income', 'expense', 'fee'].includes(event.economicNature) || category.kind !== expectedKind) return 'category'
  }
  const feeCategoryId = fieldSources.repaymentChannelResolution && fieldSources.repaymentChannelResolution.feeCategoryId
  if (feeCategoryId) {
    const category = categories.get(feeCategoryId)
    if (!category || category.archivedAt != null || category.kind !== 'expense') return 'fee_category'
  }
  return null
}

module.exports = { referencedAccountIds, referencedCategoryIds, referenceFailure }
