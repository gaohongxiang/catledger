const { buildPaymentMethodKey } = require('./identity')
const {
  ACCOUNT_REFERENCE_KIND,
  accountGroupingKey,
  aggregateAccountFamily,
  aggregateFamilyDisplayName,
  paymentAccountDetails
} = require('./payment-account')

function clean(value) {
  return String(value || '').normalize('NFKC').trim()
}

function hasStableCardLocator(value) {
  const text = clean(value)
  return /(?:尾号|末四位|后四位|[*＊xX]{2,})\s*\(?\d{4}\)?/u.test(text) ||
    /(?:银行|信用卡|贷记卡|储蓄卡|借记卡)\s*\(\d{4}\)/u.test(text)
}

function unresolvedAccountReference(sourceType, paymentMethod, role, reason) {
  const details = paymentAccountDetails(sourceType, paymentMethod)
  return {
    role,
    referenceKind: ACCOUNT_REFERENCE_KIND.ATOMIC,
    sourceType,
    value: clean(paymentMethod),
    displayName: details.displayName,
    paymentMethodKey: null,
    label: details.displayName,
    accountIdentityKey: accountGroupingKey(sourceType, paymentMethod),
    unresolvedReason: reason
  }
}

function accountReference(sourceType, paymentMethod, role) {
  const details = paymentAccountDetails(sourceType, paymentMethod)
  const raw = clean(paymentMethod)
  if (/(?:银行|信用卡|贷记卡|储蓄卡|借记卡)/u.test(raw) && !hasStableCardLocator(raw)) {
    return unresolvedAccountReference(sourceType, paymentMethod, role, 'card_locator_missing')
  }
  const paymentMethodKey = buildPaymentMethodKey(sourceType, paymentMethod)
  if (!paymentMethodKey || !details.recognized) return null
  return {
    role,
    referenceKind: ACCOUNT_REFERENCE_KIND.ATOMIC,
    sourceType,
    value: clean(paymentMethod),
    displayName: details.displayName,
    paymentMethodKey,
    label: details.displayName,
    accountIdentityKey: accountGroupingKey(sourceType, paymentMethod),
    aggregateFamilies: details.aggregateFamilies || []
  }
}

function ledgerAccountReference(sourceType, paymentMethod) {
  const details = paymentAccountDetails(sourceType, paymentMethod)
  const paymentMethodKey = buildPaymentMethodKey(sourceType, paymentMethod)
  if (!paymentMethodKey || !details.recognized || details.referenceKind !== ACCOUNT_REFERENCE_KIND.ATOMIC) return null
  return {
    role: 'ledger_account',
    referenceKind: ACCOUNT_REFERENCE_KIND.ATOMIC,
    sourceType,
    value: clean(paymentMethod),
    displayName: details.displayName,
    paymentMethodKey,
    label: details.displayName,
    accountIdentityKey: accountGroupingKey(sourceType, paymentMethod),
    aggregateFamilies: details.aggregateFamilies || []
  }
}

function repaymentTargetReference(sourceType, value) {
  const raw = clean(value)
  const label = raw.replace(/还款(?:成功)?$/u, '').trim() || raw
  const aggregateFamily = aggregateAccountFamily(sourceType, label)
  if (aggregateFamily) {
    return {
      role: 'repayment_target',
      referenceKind: ACCOUNT_REFERENCE_KIND.AGGREGATE,
      aggregateFamily,
      sourceType,
      paymentMethodKey: null,
      label: aggregateFamilyDisplayName(aggregateFamily),
      accountIdentityKey: '',
      unresolvedReason: 'aggregate_allocation_required',
      candidates: []
    }
  }
  if (/(?:银行|信用卡|贷记卡)/u.test(raw) && !hasStableCardLocator(raw)) {
    return unresolvedAccountReference(sourceType, label, 'repayment_target', 'card_locator_missing')
  }
  return accountReference(sourceType, label, 'repayment_target') ||
    unresolvedAccountReference(sourceType, label, 'repayment_target', 'account_identity_missing')
}

function sameReference(left, right) {
  return Boolean(left && right && left.sourceType === right.sourceType &&
    left.paymentMethodKey === right.paymentMethodKey)
}

function firstAccountOtherThan(excluded, ...references) {
  return references.find((reference) => reference && !sameReference(reference, excluded)) || null
}

function movement(kind, sourceType, from, to) {
  if (!from || !to || (from.paymentMethodKey && from.paymentMethodKey === to.paymentMethodKey)) return null
  return { kind, sourceType, from, to }
}

module.exports = {
  accountReference,
  clean,
  firstAccountOtherThan,
  hasStableCardLocator,
  ledgerAccountReference,
  movement,
  repaymentTargetReference,
  sameReference,
  unresolvedAccountReference
}
