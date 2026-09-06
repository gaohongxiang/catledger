const { paymentAccountDetails, paymentComponents } = require('./payment-account')
const { ledgerAccountReference } = require('./account-reference')
const { profileForRow } = require('./profiles')

const { RESOLUTION_STATUS, MONEY_EFFECT, SOURCE_ACTION } = require('./semantic-types')
const { mergeRuleOutputs } = require('./rule-evaluator')

const SINGLE_ACCOUNT_ACTIONS = new Set([
  SOURCE_ACTION.PURCHASE,
  SOURCE_ACTION.RECEIPT,
  SOURCE_ACTION.TRANSFER_SENT,
  SOURCE_ACTION.TRANSFER_RECEIVED,
  SOURCE_ACTION.REFUND_CREDIT,
  SOURCE_ACTION.FEE,
  SOURCE_ACTION.YIELD
])

const MOVEMENT_ACTIONS = new Set([
  SOURCE_ACTION.TOP_UP,
  SOURCE_ACTION.WITHDRAWAL,
  SOURCE_ACTION.REPAYMENT,
  SOURCE_ACTION.BORROW
])

function normalizedActionFallback(row) {
  if (row.rawTransactionType || !row.transactionType) return null
  const direction = row.direction
  if (row.economicEffect === 'refund' && direction !== 'expense') {
    return { sourceAction: SOURCE_ACTION.REFUND_CREDIT, legacyKind: 'refund', legacyTransactionType: 'payment', ruleId: 'compat.normalized.refund-credit.v1' }
  }
  if (row.transactionType === 'transfer' && ['income', 'expense'].includes(direction)) {
    return { sourceAction: direction === 'income' ? SOURCE_ACTION.TRANSFER_RECEIVED : SOURCE_ACTION.TRANSFER_SENT,
      legacyKind: 'external_transfer', legacyTransactionType: 'transfer', ruleId: 'compat.normalized.external-transfer.v1' }
  }
  if (row.transactionType === 'payment' && direction === 'income') {
    return { sourceAction: SOURCE_ACTION.RECEIPT, legacyKind: 'payment', legacyTransactionType: 'payment', ruleId: 'compat.normalized.receipt.v1' }
  }
  if (row.transactionType === 'payment' && direction === 'expense') {
    return { sourceAction: SOURCE_ACTION.PURCHASE, legacyKind: 'payment', legacyTransactionType: 'payment', ruleId: 'compat.normalized.purchase.v1' }
  }
  if (row.transactionType === 'fee') {
    return { sourceAction: SOURCE_ACTION.FEE, legacyKind: 'fee', legacyTransactionType: 'fee', ruleId: 'compat.normalized.fee.v1' }
  }
  if (row.transactionType === 'refund') {
    return { sourceAction: SOURCE_ACTION.REFUND_CREDIT, legacyKind: 'refund', legacyTransactionType: 'payment', ruleId: 'compat.normalized.refund-credit.v1' }
  }
  return null
}

function normalizedSettlementFallback(row, settlementResult) {
  if (settlementResult.moneyEffect !== MONEY_EFFECT.UNKNOWN || row.rawStatus || row.status) return settlementResult
  switch (row.economicEffect) {
    case 'normal':
      return { moneyEffect: MONEY_EFFECT.FINANCIAL, settlement: 'settled', ruleId: 'compat.normalized.settled.v1' }
    case 'refund':
      return { moneyEffect: MONEY_EFFECT.FINANCIAL, settlement: 'refund_settled', ruleId: 'compat.normalized.refund.v1' }
    case 'failed':
      return { moneyEffect: MONEY_EFFECT.FAILED, settlement: 'failed', ruleId: 'compat.normalized.failed.v1' }
    case 'closed':
      return { moneyEffect: MONEY_EFFECT.CLOSED, settlement: 'closed', ruleId: 'compat.normalized.closed.v1' }
    default:
      return settlementResult
  }
}

function splitPaymentComponents(sourceType, raw) {
  return paymentComponents(raw).map((component) => {
    if (component.kind === 'certified_discount') {
      return { value: component.value, componentKind: component.kind, amountMinor: null }
    }
    const details = paymentAccountDetails(sourceType, component.value)
    return {
      value: component.value,
      componentKind: component.kind,
      amountMinor: null,
      recognized: details.recognized,
      referenceKind: details.referenceKind,
      displayName: details.displayName
    }
  })
}

function selectedPaymentEndpoint(sourceType, components, role) {
  const financial = components.filter((component) => component.componentKind === 'financial')
  const unknown = components.filter((component) => component.componentKind === 'unknown')
  if (unknown.length > 0 || financial.length !== 1) return null
  const reference = ledgerAccountReference(sourceType, financial[0].value)
  return reference ? { ...reference, role } : null
}

function endpointResolution(row, profile, actionResult, settlementResult, paymentComponents) {
  if (settlementResult.moneyEffect !== MONEY_EFFECT.FINANCIAL) {
    return { ledgerAccountRef: null, from: null, to: null, fundsProjection: null, ruleIds: [] }
  }
  const action = actionResult.sourceAction
  const ordinaryEndpoint = selectedPaymentEndpoint(profile.sourceType, paymentComponents, 'ledger_account')
  let common = { ledgerAccountRef: null, from: null, to: null, fundsProjection: null, ruleIds: [] }
  if ([SOURCE_ACTION.PURCHASE, SOURCE_ACTION.TRANSFER_SENT, SOURCE_ACTION.FEE].includes(action)) {
    common = {
      ledgerAccountRef: ordinaryEndpoint,
      from: ordinaryEndpoint,
      to: null,
      fundsProjection: null,
      ruleIds: ordinaryEndpoint ? ['common.account.payment-source.v1'] : []
    }
  }
  if ([SOURCE_ACTION.RECEIPT, SOURCE_ACTION.TRANSFER_RECEIVED, SOURCE_ACTION.REFUND_CREDIT, SOURCE_ACTION.YIELD].includes(action)) {
    common = {
      ledgerAccountRef: ordinaryEndpoint,
      from: null,
      to: ordinaryEndpoint,
      fundsProjection: null,
      ruleIds: ordinaryEndpoint ? ['common.account.payment-destination.v1'] : []
    }
  }
  if (!common.ledgerAccountRef && ordinaryEndpoint && row.direction === 'expense') {
    common = {
      ledgerAccountRef: ordinaryEndpoint,
      from: ordinaryEndpoint,
      to: null,
      fundsProjection: null,
      ruleIds: ['common.account.explicit-expense-reference.v1']
    }
  }
  if (!common.ledgerAccountRef && ordinaryEndpoint && row.direction === 'income') {
    common = {
      ledgerAccountRef: ordinaryEndpoint,
      from: null,
      to: ordinaryEndpoint,
      fundsProjection: null,
      ruleIds: ['common.account.explicit-income-reference.v1']
    }
  }
  const sourceSpecific = profile.resolveAccountEndpoints &&
    profile.resolveAccountEndpoints(row, actionResult, settlementResult)
  if (!sourceSpecific) return common
  return {
    ledgerAccountRef: sourceSpecific.ledgerAccountRef || null,
    from: sourceSpecific.fromAccountRef || null,
    to: sourceSpecific.toAccountRef || null,
    fundsProjection: sourceSpecific.fundsProjection || null,
    ruleIds: sourceSpecific.ruleIds || []
  }
}

function legacyEconomicEffect(settlementResult, actionResult) {
  if (settlementResult.moneyEffect === MONEY_EFFECT.FAILED) return 'failed'
  if (settlementResult.moneyEffect === MONEY_EFFECT.CLOSED) return 'closed'
  if (settlementResult.moneyEffect === MONEY_EFFECT.UNKNOWN) return 'unknown'
  if (actionResult.sourceAction === SOURCE_ACTION.REFUND_CREDIT) return 'refund'
  return 'normal'
}

function resolveRowSemantic(row) {
  const profile = profileForRow(row)
  if (!profile) {
    return {
      resolutionStatus: RESOLUTION_STATUS.UNKNOWN,
      moneyEffect: MONEY_EFFECT.UNKNOWN,
      sourceAction: null,
      settlement: 'unknown',
      amountMinor: row && row.amountMinor != null ? String(row.amountMinor) : null,
      currency: (row && row.currency) || 'CNY',
      fromAccountRef: null,
      toAccountRef: null,
      ledgerAccountRef: null,
      fundsProjection: null,
      paymentComponents: [],
      identityRefs: (row && row.identityRefs) || [],
      ruleIds: ['profile.unsupported.v1'],
      issues: [{ code: 'source_profile_unknown', field: 'profile', severity: 'warning' }],
      legacy: { kind: 'unknown', transactionType: 'unknown', economicEffect: 'unknown', rule: 'unsupported_source' }
    }
  }

  const profileAction = profile.resolveAction(row, profile)
  const actionResult = profileAction.sourceAction || profileAction.resolutionStatus === RESOLUTION_STATUS.CONFLICT
    ? profileAction : (normalizedActionFallback(row) || profileAction)
  const settlementResult = normalizedSettlementFallback(row, profile.resolveSettlement(row, actionResult))
  const paymentComponents = splitPaymentComponents(profile.sourceType, row.paymentMethod)
  const endpoints = endpointResolution(row, profile, actionResult, settlementResult, paymentComponents)
  const issues = []
  if (actionResult.resolutionStatus === RESOLUTION_STATUS.CONFLICT) {
    issues.push({ code: 'row_semantic_conflict', field: 'transaction_type', severity: 'warning' })
  }
  if (Object.prototype.hasOwnProperty.call(row, 'amountMinor') &&
      (row.amountMinor == null || !/^\d+$/u.test(String(row.amountMinor)))) {
    issues.push({ code: 'row_amount_invalid', field: 'amount', severity: 'error' })
  }
  const financialComponents = paymentComponents.filter((component) => component.componentKind === 'financial')
  if (settlementResult.moneyEffect === MONEY_EFFECT.FINANCIAL && financialComponents.length > 1) {
    issues.push({ code: 'payment_components_ambiguous', field: 'payment_method', severity: 'warning' })
  }
  if (settlementResult.moneyEffect === MONEY_EFFECT.UNKNOWN) {
    issues.push({ code: 'row_status_unknown', field: 'status', severity: 'warning' })
  }
  if (settlementResult.moneyEffect === MONEY_EFFECT.FINANCIAL && !actionResult.sourceAction) {
    issues.push({ code: 'row_transaction_type_unknown', field: 'transaction_type', severity: 'warning' })
  }
  if (settlementResult.moneyEffect === MONEY_EFFECT.FINANCIAL &&
      ((SINGLE_ACCOUNT_ACTIONS.has(actionResult.sourceAction) && !endpoints.ledgerAccountRef && !endpoints.fundsProjection) ||
       (MOVEMENT_ACTIONS.has(actionResult.sourceAction) && !endpoints.fundsProjection))) {
    issues.push({ code: 'account_endpoint_unknown', field: 'payment_method', severity: 'warning' })
  }

  const resolutionStatus = issues.some((issue) => issue.severity === 'error') ? RESOLUTION_STATUS.INVALID
    : actionResult.resolutionStatus === RESOLUTION_STATUS.CONFLICT ? RESOLUTION_STATUS.CONFLICT
    : issues.some((issue) => ['payment_components_ambiguous', 'account_endpoint_unknown'].includes(issue.code)) ||
      settlementResult.moneyEffect === MONEY_EFFECT.UNKNOWN ||
      (settlementResult.moneyEffect === MONEY_EFFECT.FINANCIAL && !actionResult.sourceAction)
    ? RESOLUTION_STATUS.UNKNOWN
    : RESOLUTION_STATUS.RESOLVED

  return {
    resolutionStatus,
    moneyEffect: settlementResult.moneyEffect,
    sourceAction: settlementResult.moneyEffect === MONEY_EFFECT.NON_FINANCIAL ? null : actionResult.sourceAction,
    settlement: settlementResult.settlement,
    amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
    currency: row.currency || 'CNY',
    fromAccountRef: endpoints.from,
    toAccountRef: endpoints.to,
    ledgerAccountRef: endpoints.ledgerAccountRef,
    fundsProjection: endpoints.fundsProjection,
    paymentComponents,
    relationHints: profile.relationHints(row, settlementResult),
    identityRefs: row.identityRefs || [],
    ruleIds: [...new Set([...(actionResult.ruleIds || [actionResult.ruleId]), settlementResult.ruleId, ...endpoints.ruleIds])].filter(Boolean).sort(),
    issues,
    transactionTypeRole: profile.transactionTypeRole || 'action',
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    policyVersion: profile.policyVersion,
    legacy: {
      kind: actionResult.legacyKind,
      transactionType: actionResult.legacyTransactionType,
      economicEffect: legacyEconomicEffect(settlementResult, actionResult),
      rule: actionResult.ruleId
    }
  }
}

// 同一规划只计算一次；旧持久化结果必须匹配当前 profile 版本才能复用。
function getRowSemantic(row = {}) {
  const profile = profileForRow(row)
  if (row.semantic && profile && row.semantic.policyVersion === profile.policyVersion &&
      row.semantic.profileId === profile.profileId && row.semantic.profileVersion === profile.profileVersion) {
    return row.semantic
  }
  return resolveRowSemantic(row)
}

module.exports = {
  MONEY_EFFECT,
  RESOLUTION_STATUS,
  SOURCE_ACTION,
  mergeRuleOutputs,
  getRowSemantic,
  resolveRowSemantic,
  splitPaymentComponents
}
