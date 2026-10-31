const { decisionFor: repaymentOwnershipFor } = require('./repayment-ownership')
const { createMappingIndex, accountIdFromIndex, indexForEvent, resolutionFromIndex } = require('./account-mapping-policy')
const { ledgerAccountReference } = require('./account-reference')
const {
  ACCOUNT_REFERENCE_KIND,
  paymentReferenceKey
} = require('./payment-account')
const { getRowSemantic } = require('./row-semantic-resolver')

const SOURCE_FUNDS_VERSION = 'source-funds-v9'

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
      bindingKey: reference.bindingKey,
      binding: reference.binding,
      label: reference.label,
      accountIdentityKey: reference.accountIdentityKey || '',
      aggregateFamilies: reference.aggregateFamilies || []
    })
  })
  return { ...projection, to: { ...projection.to, candidates } }
}

function ledgerAccountReferenceForRow(row) {
  const semantic = getRowSemantic({
    ...row,
    amountMinor: row.amountMinor == null ? '1' : row.amountMinor,
    economicEffect: row.economicEffect || 'normal'
  })
  const reference = semantic.ledgerAccountRef ||
    (semantic.issues && semantic.issues.some((issue) => issue.code === 'source_profile_unknown')
      ? ledgerAccountReference(row.sourceType, row.paymentMethod)
      : null)
  if (!reference) return null
  // 规划行上的 paymentMethodKey 是该批证据已经固化的引用键。不能在这里
  // 重新计算并替换它，否则旧批次、键版本迁移期及测试构造的稳定引用会
  // 与对应映射失联。只有来源没有给出可识别账户时才派生新引用。
  return {
    ...reference,
    paymentMethodKey: reference.inferenceRule ? reference.paymentMethodKey : (row.paymentMethodKey || reference.paymentMethodKey),
    ...(reference.binding ? { binding: { ...reference.binding, legacyPaymentMethodKey:
      reference.inferenceRule ? reference.paymentMethodKey : row.paymentMethodKey || reference.paymentMethodKey } } : {}),
    ruleVersion: SOURCE_FUNDS_VERSION
  }
}

function projectSourceFunds(row) {
  const semantic = getRowSemantic({ ...row, economicEffect: row.economicEffect || 'normal' })
  return semantic.fundsProjection
    ? { ...semantic.fundsProjection, ruleVersion: SOURCE_FUNDS_VERSION }
    : null
}

function resolveReference(reference, mappingIndex) {
  if (!reference) return null
  return accountIdFromIndex(mappingIndex, reference)
}

function resolvePaymentMethod(sourceType, paymentMethodKey, mappingIndex) {
  if (!sourceType || !paymentMethodKey) return null
  return accountIdFromIndex(mappingIndex, paymentReferenceKey(sourceType, paymentMethodKey))
}

function resolveSourceFunds(projection, mappingIndex) {
  if (!projection) return null
  if (!(projection.to && projection.to.referenceKind === ACCOUNT_REFERENCE_KIND.AGGREGATE)) {
    return {
      projection,
      fromAccountId: resolveReference(projection.from, mappingIndex),
      toAccountId: resolveReference(projection.to, mappingIndex)
    }
  }
  // 自动归属要求候选完整且全部收敛到同一账户；未知、忽略或冲突映射
  // 都不能在去重时消失。每次从当前映射重算，同时移除旧的唯一结论。
  const candidates = (projection.to.candidates || []).map((candidate) => ({
    ...candidate,
    accountId: resolveReference(candidate, mappingIndex)
  }))
  const accountIds = candidates.map(candidate => candidate.accountId)
  const uniqueAccountId = accountIds.length > 0 && accountIds.every(id => typeof id === 'string' && id && id === accountIds[0])
    ? accountIds[0] : null
  const target = { ...projection.to }
  delete target.resolvedAccountId
  return {
    projection: { ...projection, to: { ...target, candidates, ...(uniqueAccountId ? { resolvedAccountId: uniqueAccountId } : {}) } },
    fromAccountId: resolveReference(projection.from, mappingIndex),
    toAccountId: uniqueAccountId
  }
}

function reconcileProjectedAccounts(event, mappingIndex, { preserveFrom = false, preserveTo = false } = {}) {
  mappingIndex = indexForEvent(mappingIndex, event)
  const projection = event && event.fieldSources && event.fieldSources.fundsProjection
  if (!projection) return { event, changed: false }
  if (event.fieldSources?.accountOwnership) return { event, changed: false }
  const ownership = repaymentOwnershipFor(event)
  // 他人还款保留原始银行线索作证据，不再把该目标映射进本人的账本。
  if (ownership && ownership.owner === 'other') {
    return { event: { ...event, counterpartyLedgerAccountId: null }, changed: Boolean(event.counterpartyLedgerAccountId) }
  }
  const resolved = resolveSourceFunds(projection, mappingIndex)
  let next = {
    ...event,
    ledgerAccountId: preserveFrom ? event.ledgerAccountId : resolved.fromAccountId,
    counterpartyLedgerAccountId: preserveTo ? event.counterpartyLedgerAccountId : resolved.toAccountId,
    fieldSources: {
      ...(event.fieldSources || {}),
      fundsProjection: resolved.projection
    }
  }
  for (const [role, reference] of [['mapping_from', projection.from], ['mapping_to', projection.to]]) {
    if (resolutionFromIndex(mappingIndex, reference).kind === 'external') {
      const decision = require('./account-reference-decision')
      if (decision.supported(next, role)) next = { ...decision.apply(next, role, 'external'), manualFieldMask: event.manualFieldMask }
    }
  }
  const projectionChanged = JSON.stringify(resolved.projection) !== JSON.stringify(projection)
  return {
    event: next,
    changed: next.ledgerAccountId !== event.ledgerAccountId ||
      next.counterpartyLedgerAccountId !== event.counterpartyLedgerAccountId || projectionChanged ||
      next.economicNature !== event.economicNature || JSON.stringify(next.fieldSources.accountOwnership) !== JSON.stringify(event.fieldSources.accountOwnership)
  }
}

module.exports = {
  SOURCE_FUNDS_VERSION,
  createMappingIndex,
  ledgerAccountReferenceForRow,
  projectSourceFunds,
  reconcileProjectedAccounts,
  resolveReference,
  resolvePaymentMethod,
  resolveSourceFunds,
  withAggregateCandidates
}
