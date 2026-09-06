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
  ledgerAccountReferenceForRow,
  projectSourceFunds,
  reconcileProjectedAccounts,
  resolvePaymentMethod,
  resolveSourceFunds,
  withAggregateCandidates
}
