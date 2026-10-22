const { decisionFor: repaymentOwnershipFor } = require('./repayment-ownership')
const { createMappingIndex } = require('./account-mapping-policy')
const { ledgerAccountReference } = require('./account-reference')
const {
  ACCOUNT_REFERENCE_KIND,
  paymentReferenceKey
} = require('./payment-account')
const { getRowSemantic } = require('./row-semantic-resolver')

const SOURCE_FUNDS_VERSION = 'source-funds-v8'

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
  return mappingIndex.get(paymentReferenceKey(reference)) || null
}

function resolvePaymentMethod(sourceType, paymentMethodKey, mappingIndex) {
  if (!sourceType || !paymentMethodKey) return null
  return mappingIndex.get(paymentReferenceKey(sourceType, paymentMethodKey)) || null
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
  // 聚合族（如花呗｜信用购）在族内已经收敛为同一账户身份。解析候选账户后，
  // 若用户账本里该族只对应一个账户，就直接落到它，不再要求人工分配——
  // 一笔还款还向唯一的负债账户，分摊没有意义。只有族内仍对应多个账户
  // （历史脏数据）或多个候选无法唯一时，才保持待分配，绝不静默猜测。
  const candidates = (projection.to.candidates || []).map((candidate) => ({
    ...candidate,
    accountId: resolveReference(candidate, mappingIndex)
  }))
  const resolvedIds = uniqueAccountIds(candidates.map((candidate) => candidate.accountId))
  if (candidates.length > 0 && resolvedIds.length === 1) {
    return {
      projection: { ...projection, to: { ...projection.to, candidates, resolvedAccountId: resolvedIds[0] } },
      fromAccountId: resolveReference(projection.from, mappingIndex),
      toAccountId: resolvedIds[0]
    }
  }
  return {
    projection: { ...projection, to: { ...projection.to, candidates } },
    fromAccountId: resolveReference(projection.from, mappingIndex),
    toAccountId: null
  }
}

function uniqueAccountIds(values) {
  return [...new Set((values || []).filter((value) => typeof value === 'string' && value))]
}

function reconcileProjectedAccounts(event, mappingIndex, { preserveFrom = false, preserveTo = false } = {}) {
  const projection = event && event.fieldSources && event.fieldSources.fundsProjection
  if (!projection) return { event, changed: false }
  const ownership = repaymentOwnershipFor(event)
  // 他人还款保留原始银行线索作证据，不再把该目标映射进本人的账本。
  if (ownership && ownership.owner === 'other') {
    return { event: { ...event, counterpartyLedgerAccountId: null }, changed: Boolean(event.counterpartyLedgerAccountId) }
  }
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
  ledgerAccountReferenceForRow,
  projectSourceFunds,
  reconcileProjectedAccounts,
  resolvePaymentMethod,
  resolveSourceFunds,
  withAggregateCandidates
}
