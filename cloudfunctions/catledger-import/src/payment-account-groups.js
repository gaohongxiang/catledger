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
function groupKey(reference) { return accountIdentityKeyForReference(reference) || paymentReferenceKey(reference) }
function referenceForRole(event, role) {
  return (event.fieldSources && event.fieldSources.paymentAccountReferences || []).find((ref) => ref.memberRole === role) || null
}
function mappedAccount(event, reference) {
  if (reference.memberRole === 'payment_target') return event.counterpartyLedgerAccountId || null
  return (event.fieldSources.paymentAccounts || []).find((item) => item.componentIndex === reference.componentIndex)?.accountId || null
}
module.exports = { VERSION, referencesForRows, groupKey, referenceForRole, mappedAccount }
