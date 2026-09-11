const { getRowSemantic, SOURCE_ACTION } = require('./row-semantic-resolver')
const { accountReference, unresolvedAccountReference } = require('./account-reference')
const { paymentComponents, accountIdentityKeyForReference, paymentReferenceKey } = require('./payment-account')

const VERSION = 'payment-account-groups-v1'
function referencesForRows(rows) {
  if (!rows.length) return []
  const all = rows.map((row) => {
    // 取原始付款串的独立金融成分，不能把合成串当作一个账户。
    const financial = paymentComponents(row.paymentMethod).map((part, componentIndex) => ({ ...part, componentIndex })).filter((part) => part.kind === 'financial')
    const result = financial.length > 1 ? financial.map((part) => {
      const reference = accountReference(row.sourceType, part.value, 'payment_method') || unresolvedAccountReference(row.sourceType, part.value, 'payment_method', 'account_identity_missing')
      return reference && { ...reference, memberRole: 'payment_component_' + part.componentIndex, componentIndex: part.componentIndex }
    }).filter(Boolean) : []
    const semantic = getRowSemantic(row)
    if (semantic.sourceAction === SOURCE_ACTION.REPAYMENT && semantic.toAccountRef?.paymentMethodKey) {
      result.push({ ...semantic.toAccountRef, memberRole: 'payment_target' })
    }
    return result
  })
  return all.every((refs) => JSON.stringify(refs) === JSON.stringify(all[0])) ? all[0] : []
}
// 与刷新动作的候选条件一致，读取已有证据即可判断是否有分组待补，不写状态。
function needsExpansion(events, rows, evidence) {
  const byRow = new Map(rows.map(row => [row.rowId, row]))
  const byEvent = new Map()
  for (const item of evidence) {
    if (item.evidenceRole === 'discarded' || !byRow.has(item.rowId)) continue
    if (!byEvent.has(item.eventId)) byEvent.set(item.eventId, [])
    byEvent.get(item.eventId).push(byRow.get(item.rowId))
  }
  return events.some(event => ['needs_action', 'ready'].includes(event.status) &&
    !event.fieldSources?.paymentAccountGroupsVersion && !event.fieldSources?.paymentResolution &&
    referencesForRows(byEvent.get(event.eventId) || []).length > 0)
}
function groupKey(reference) { return accountIdentityKeyForReference(reference) || paymentReferenceKey(reference) }
function referenceForRole(event, role) {
  return (event.fieldSources && event.fieldSources.paymentAccountReferences || []).find((ref) => ref.memberRole === role) || null
}
function mappedAccount(event, reference) {
  if (reference.memberRole === 'payment_target') return event.counterpartyLedgerAccountId || null
  return (event.fieldSources.paymentAccounts || []).find((item) => item.componentIndex === reference.componentIndex)?.accountId || null
}
module.exports = { VERSION, needsExpansion, referencesForRows, groupKey, referenceForRole, mappedAccount }
