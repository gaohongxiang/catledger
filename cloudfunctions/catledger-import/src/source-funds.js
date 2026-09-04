const { buildPaymentMethodKey } = require('./identity')
const { createMappingIndex } = require('./account-mapping-policy')
const {
  ACCOUNT_REFERENCE_KIND,
  accountGroupingKey,
  aggregateAccountFamily,
  aggregateFamilyDisplayName,
  paymentAccountDetails,
  paymentReferenceKey
} = require('./payment-account')
const { classifySourceAction } = require('./source-action')

const SOURCE_FUNDS_VERSION = 'source-funds-v6'

function clean(value) {
  return String(value || '').normalize('NFKC').trim()
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
    paymentMethodKey,
    label: details.displayName,
    accountIdentityKey: accountGroupingKey(sourceType, paymentMethod),
    aggregateFamilies: details.aggregateFamilies || []
  }
}

function unresolvedAccountReference(sourceType, paymentMethod, role, reason) {
  const details = paymentAccountDetails(sourceType, paymentMethod)
  return {
    role,
    referenceKind: ACCOUNT_REFERENCE_KIND.ATOMIC,
    sourceType,
    paymentMethodKey: null,
    label: details.displayName,
    accountIdentityKey: accountGroupingKey(sourceType, paymentMethod),
    unresolvedReason: reason
  }
}

function hasStableCardLocator(value) {
  const text = clean(value)
  return /(?:尾号|末四位|后四位|[*＊xX]{2,})\s*\(?\d{4}\)?/u.test(text) ||
    /(?:银行|信用卡|贷记卡|储蓄卡|借记卡)\s*\(\d{4}\)/u.test(text)
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

function movement(kind, sourceType, from, to) {
  if (!from || !to || (from.paymentMethodKey && from.paymentMethodKey === to.paymentMethodKey)) return null
  return { ruleVersion: SOURCE_FUNDS_VERSION, kind, sourceType, from, to }
}

function withAggregateCandidates(projection, references) {
  if (!projection || !projection.to || projection.to.referenceKind !== ACCOUNT_REFERENCE_KIND.AGGREGATE) return projection
  const family = projection.to.aggregateFamily
  const candidates = []
  const seen = new Set()
  ;(references || []).forEach((reference) => {
    if (!reference || !reference.paymentMethodKey || !(reference.aggregateFamilies || []).includes(family)) return
    const key = paymentReferenceKey(reference)
    if (!key || seen.has(key)) return
    seen.add(key)
    candidates.push({
      sourceType: reference.sourceType,
      paymentMethodKey: reference.paymentMethodKey,
      label: reference.label,
      accountIdentityKey: reference.accountIdentityKey || '',
      aggregateFamilies: reference.aggregateFamilies || []
    })
  })
  return { ...projection, to: { ...projection.to, candidates } }
}

function sameReference(left, right) {
  return Boolean(left && right && left.sourceType === right.sourceType &&
    left.paymentMethodKey === right.paymentMethodKey)
}

function firstAccountOtherThan(excluded, ...references) {
  return references.find((reference) => reference && !sameReference(reference, excluded)) || null
}

function alipayProjection(row) {
  const transactionType = clean(row.rawTransactionType)
  const item = clean(row.item)
  const counterparty = clean(row.counterparty)
  const text = `${transactionType} ${item}`
  const balance = accountReference('alipay', '账户余额', 'platform_balance')
  const yuEBao = accountReference('alipay', '余额宝', 'platform_savings')
  const payment = accountReference('alipay', row.paymentMethod, 'payment_method')
  const counterpartyAccount = accountReference('alipay', counterparty, 'counterparty_account')
  const action = classifySourceAction(row)

  if (action.kind === 'savings_out') {
    const destination = firstAccountOtherThan(yuEBao, payment, counterpartyAccount) ||
      (/(?:转出到|转至)(?:账户)?余额/u.test(text) ? balance : null)
    return movement('platform_savings_out', 'alipay', yuEBao, destination)
  }
  if (action.kind === 'savings_in') {
    const source = firstAccountOtherThan(yuEBao, payment, counterpartyAccount) ||
      (/(?:账户)?余额.*转入.*余额宝/u.test(text) ? balance : null)
    return movement('platform_savings_in', 'alipay', source, yuEBao)
  }
  if (action.kind === 'withdrawal') {
    // 先相信原始“收/付款方式”：余额或余额宝明确出现时，它才是转出端。
    // 某些官方“账户存取 / 提现-…”记录把到账银行卡写在付款方式列，
    // 此时才允许用严格动作类型兜底到账户余额；不能凭任意文案中的
    // “提现”二字把来源写死为账户余额。
    const explicitPlatformSource = sameReference(payment, balance) || sameReference(payment, yuEBao)
      ? payment
      : null
    const source = explicitPlatformSource || balance
    const destination = firstAccountOtherThan(source, explicitPlatformSource ? counterpartyAccount : payment, counterpartyAccount)
    return movement('withdrawal', 'alipay', source, destination)
  }
  if (action.kind === 'top_up') {
    const explicitPlatformTarget = sameReference(payment, balance) || sameReference(payment, yuEBao)
      ? payment
      : null
    const target = explicitPlatformTarget || balance
    const source = firstAccountOtherThan(target, explicitPlatformTarget ? counterpartyAccount : payment, counterpartyAccount)
    return movement('top_up', 'alipay', source, target)
  }
  if (action.kind === 'repayment') {
    const target = repaymentTargetReference('alipay', counterparty || item)
    return movement('repayment', 'alipay', payment, target)
  }
  return null
}

function wechatProjection(row) {
  const item = clean(row.item)
  const counterparty = clean(row.counterparty)
  const change = accountReference('wechat', '零钱', 'platform_balance')
  const payment = accountReference('wechat', row.paymentMethod, 'payment_method')
  const counterpartyAccount = accountReference('wechat', counterparty, 'counterparty_account')
  const action = classifySourceAction(row)

  if (action.kind === 'top_up') {
    return movement('top_up', 'wechat', firstAccountOtherThan(change, payment, counterpartyAccount), change)
  }
  if (action.kind === 'withdrawal') {
    return movement('withdrawal', 'wechat', change, firstAccountOtherThan(change, payment, counterpartyAccount))
  }
  if (action.kind === 'repayment') {
    const target = repaymentTargetReference('wechat', counterparty || item)
    return movement('repayment', 'wechat', payment, target)
  }
  return null
}

function projectSourceFunds(row) {
  if (row.sourceType === 'alipay') return alipayProjection(row)
  if (row.sourceType === 'wechat') return wechatProjection(row)
  return null
}

function resolveReference(reference, mappingIndex) {
  if (!reference) return null
  return mappingIndex.get(paymentReferenceKey(reference)) || null
}

function resolvePaymentMethod(sourceType, paymentMethodKey, mappingIndex) {
  if (!sourceType || !paymentMethodKey) return null
  return mappingIndex.get(paymentReferenceKey(sourceType, paymentMethodKey)) || null
}

function resolveSourceFunds(projection, mappingIndex) {
  if (!projection) return null
  const resolvedProjection = projection.to && projection.to.referenceKind === ACCOUNT_REFERENCE_KIND.AGGREGATE
    ? {
        ...projection,
        to: {
          ...projection.to,
          candidates: (projection.to.candidates || []).map((candidate) => ({
            ...candidate,
            accountId: resolveReference(candidate, mappingIndex)
          }))
        }
      }
    : projection
  return {
    projection: resolvedProjection,
    fromAccountId: resolveReference(resolvedProjection.from, mappingIndex),
    toAccountId: resolvedProjection.to.referenceKind === ACCOUNT_REFERENCE_KIND.AGGREGATE
      ? null
      : resolveReference(resolvedProjection.to, mappingIndex)
  }
}

function reconcileProjectedAccounts(event, mappingIndex, { preserveFrom = false, preserveTo = false } = {}) {
  const projection = event && event.fieldSources && event.fieldSources.fundsProjection
  if (!projection) return { event, changed: false }
  const resolved = resolveSourceFunds(projection, mappingIndex)
  const next = {
    ...event,
    ledgerAccountId: preserveFrom ? event.ledgerAccountId : resolved.fromAccountId,
    counterpartyLedgerAccountId: preserveTo ? event.counterpartyLedgerAccountId : resolved.toAccountId,
    fieldSources: {
      ...(event.fieldSources || {}),
      fundsProjection: resolved.projection
    }
  }
  const projectionChanged = JSON.stringify(resolved.projection) !== JSON.stringify(projection)
  return {
    event: next,
    changed: next.ledgerAccountId !== event.ledgerAccountId ||
      next.counterpartyLedgerAccountId !== event.counterpartyLedgerAccountId || projectionChanged
  }
}

module.exports = {
  SOURCE_FUNDS_VERSION,
  createMappingIndex,
  projectSourceFunds,
  reconcileProjectedAccounts,
  resolvePaymentMethod,
  resolveSourceFunds,
  withAggregateCandidates
}
