const { paymentEvidenceFields } = require('./payment-resolution')
const { digestParts } = require('./digest')
const { EVENT_KEY_VERSION } = require('./domain-versions')
const { getRowSemantic } = require('./row-semantic-resolver')
const { semanticBlockers } = require('./semantic-policy')
const { isNonFinancialSourceRecord } = require('./source-action')
const { accountGroupingKey, accountIdentityKeyForReference } = require('./payment-account')
const { ledgerAccountReferenceForRow, projectSourceFunds, withAggregateCandidates, resolveSourceFunds, resolvePaymentMethod } = require('./source-funds')
const { ECONOMIC_NATURE, EVENT_STATUS, EVIDENCE_ROLE, FLOW_DIRECTION, economicNatureForRow, evaluatePostability, flowDirectionForRow, unique } = require('./organizer-model')
const { compatibleCore, STRONG_REFERENCE_WINDOW_MS, stableReferences, scopedStableReferences } = require('./evidence-matching')

function representativeEvent(updateId, group, idFactory, mappingIndex, mappingResolution, references) {
  const primary = group[0]
  const primarySemantic = getRowSemantic(primary)
  const primaryLedgerReference = ledgerAccountReferenceForRow(primary)
  const identities = unique(group.map((row) => row.identityId))
  const existingTransactionIds = unique(group.map((row) => row.existingTransactionId))
  const projections = group.map(projectSourceFunds)
    .filter(Boolean)
    .map((candidate) => withAggregateCandidates(candidate, references))
  const projection = projections[0] || null
  const projectionConflict = projections.some((candidate) => (
    !projection || candidate.kind !== projection.kind ||
    candidate.from.paymentMethodKey !== projection.from.paymentMethodKey ||
    candidate.to.paymentMethodKey !== projection.to.paymentMethodKey
  ))
  const resolvedFunds = projection && !projectionConflict ? resolveSourceFunds(projection, mappingIndex) : null
  const nature = projection && !projectionConflict
    ? projection.kind === 'repayment' ? ECONOMIC_NATURE.REPAYMENT : ECONOMIC_NATURE.INTERNAL_TRANSFER
    : economicNatureForRow(primary)
  const flowDirection = [ECONOMIC_NATURE.INTERNAL_TRANSFER, ECONOMIC_NATURE.REPAYMENT, ECONOMIC_NATURE.BORROW].includes(nature)
    ? FLOW_DIRECTION.NEUTRAL
    : [ECONOMIC_NATURE.INCOME, ECONOMIC_NATURE.REFUND].includes(nature)
      ? FLOW_DIRECTION.INFLOW
      : [ECONOMIC_NATURE.EXPENSE, ECONOMIC_NATURE.FEE].includes(nature)
        ? FLOW_DIRECTION.OUTFLOW
        : flowDirectionForRow(primary)
  const accountIds = unique(group.map((row) => {
    // mappingIndex 已按“本批决定最后写入”汇总，不能再从原始 planning row
    // 直取旧永久映射，否则本批刚选的账户会被旧值反向覆盖。
    const reference = ledgerAccountReferenceForRow(row)
    return reference ? resolvePaymentMethod(reference.sourceType, reference.paymentMethodKey, mappingIndex) : null
  }))
  const accountConflict = accountIds.length > 1
  const coreConflict = group.some((row) => !compatibleCore(primary, row, STRONG_REFERENCE_WINDOW_MS))
  const identityConflict = group.some((row) => row.identityState === 'identity_conflict')
  const ignoredBySavedRule = group.every((row) => {
    const reference = ledgerAccountReferenceForRow(row)
    return row.mappingAction === 'ignore' || Boolean(reference &&
      mappingResolution.ignoredIdentityKeys.has(accountIdentityKeyForReference(reference)))
  })
  const accountMappingConflict = group.some((row) => (
    mappingResolution.conflictIdentityKeys.has(accountGroupingKey(row.sourceType, row.paymentMethod))
  )) || [projection && projection.from, projection && projection.to].filter(Boolean).some((reference) => (
    mappingResolution.conflictIdentityKeys.has(accountIdentityKeyForReference(reference))
  ))
  const failedOrClosed = group.every((row) => ['failed', 'closed'].includes(row.economicEffect))
  const nonFinancial = group.every(isNonFinancialSourceRecord)
  const rowBlockers = unique(group.flatMap((row) => semanticBlockers(getRowSemantic(row))))
  const reasons = [...rowBlockers]
  if (identityConflict) reasons.push('identity_conflict')
  if (accountMappingConflict) reasons.push('account_mapping_conflict')
  if (accountConflict || coreConflict) reasons.push('core_fields_conflict')
  if (projectionConflict) reasons.push('core_fields_conflict')
  if (existingTransactionIds.length > 1) reasons.push('identity_conflict')
  if (nature === ECONOMIC_NATURE.UNKNOWN) reasons.push('economic_nature_required')
  if (primary.economicEffect === 'unknown') reasons.push('transaction_status_unknown')
  if (primarySemantic.issues.some((issue) => issue.code === 'account_endpoint_unknown')) {
    reasons.push('source_account_endpoint_unknown')
  }
  if (group.length > 1) reasons.push('strong_same_event')
  if (!primary.localAt || primary.amountMinor == null) reasons.push('core_fields_missing')

  const eventId = idFactory()
  const eventKey = digestParts(
    EVENT_KEY_VERSION,
    updateId,
    ...group.map((row) => row.identityId || row.rowId).sort()
  )
  const event = {
    eventId,
    updateId,
    batchId: primary.batchId,
    eventKey,
    eventKeyVersion: EVENT_KEY_VERSION,
    // “以后不计入”直接应用到后续匹配事件，同时保留一条可见、可修改的
    // 已确认账户项；用户无需重复选择，也不会失去覆盖历史决定的入口。
    status: existingTransactionIds.length > 0 || failedOrClosed || nonFinancial || ignoredBySavedRule
      ? EVENT_STATUS.EXCLUDED
      : EVENT_STATUS.NEEDS_ACTION,
    flowDirection,
    economicNature: nature,
    ledgerAccountId: resolvedFunds ? resolvedFunds.fromAccountId : accountConflict ? null : accountIds[0] || null,
    counterpartyLedgerAccountId: resolvedFunds ? resolvedFunds.toAccountId : null,
    localDate: primary.localDate,
    localAt: primary.localAt,
    utcAt: primary.utcAt,
    timezoneOffsetMinutes: primary.timezoneOffsetMinutes,
    amountMinor: primary.amountMinor == null ? null : String(primary.amountMinor),
    currency: primary.currency || 'CNY',
    categoryId: [ECONOMIC_NATURE.INCOME, ECONOMIC_NATURE.EXPENSE, ECONOMIC_NATURE.FEE].includes(nature)
      ? primary.suggestedCategoryId || null
      : null,
    manualFieldMask: 0,
    fieldSources: {
      semanticBlockers: rowBlockers,
      ...paymentEvidenceFields(group.map((row) => ({ direction: row.direction, semantic: getRowSemantic(row) }))),
      primaryEvidenceId: null,
      rowIds: group.map((row) => row.rowId),
      ledgerAccountReference: primaryLedgerReference,
      fundsProjection: resolvedFunds ? resolvedFunds.projection : projection && !projectionConflict ? projection : null
    },
    reasonCodes: unique([
      ...reasons,
      existingTransactionIds.length > 0 ? 'already_posted' : null,
      ignoredBySavedRule ? 'source_account_ignored_default' : null,
      nonFinancial ? 'source_non_financial' : null,
      failedOrClosed ? primary.economicEffect === 'failed' ? 'transaction_failed' : 'transaction_closed' : null
    ]),
    version: 1,
    existingTransactionIds,
    paymentMethodKey: primaryLedgerReference ? primaryLedgerReference.paymentMethodKey : null,
    accountGroupingKey: primaryLedgerReference ? accountIdentityKeyForReference(primaryLedgerReference) : '',
    sourceType: primary.sourceType,
    display: {
      counterparty: primary.counterparty || '',
      item: primary.item || '',
      sourceNote: primary.sourceNote || ''
    },
    // 仅供本次内存规划使用；persistPlan 会按白名单字段写库。
    relationEvidence: {
      stableReferences: unique(group.flatMap(stableReferences)),
      scopedStableReferences: unique(group.flatMap(scopedStableReferences)),
      rows: group.map((row) => ({
        sourceType: row.sourceType,
        sourceProfileId: row.sourceProfileId || '',
        accountGroupingKey: accountGroupingKey(row.sourceType, row.paymentMethod),
        transactionType: row.transactionType || '',
        sourceAction: row.semantic.sourceAction,
        relationHints: row.semantic.relationHints,
        direction: row.direction,
        economicEffect: row.economicEffect,
        utcAt: row.utcAt,
        amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
        currency: row.currency || 'CNY',
        counterparty: row.counterparty || '',
        item: row.item || '',
        paymentMethod: row.paymentMethod || '',
        moneyEffect: row.semantic.moneyEffect
      }))
    }
  }
  if (event.status !== EVENT_STATUS.EXCLUDED) {
    const evaluated = evaluatePostability(event)
    event.status = evaluated.status
    event.reasonCodes = unique([...event.reasonCodes, ...evaluated.reasonCodes])
  }
  const evidence = group.map((row, index) => {
    const sameIdentityAsPrimary = index > 0 && primary.identityId && row.identityId === primary.identityId
    const evidenceId = idFactory()
    if (index === 0) event.fieldSources.primaryEvidenceId = evidenceId
    return {
      evidenceId,
      updateId,
      eventId,
      rowId: row.rowId,
      evidenceRole: index === 0
        ? EVIDENCE_ROLE.PRIMARY
        : sameIdentityAsPrimary ? EVIDENCE_ROLE.DUPLICATE : EVIDENCE_ROLE.SUPPORTING,
      fieldMask: index === 0 ? 255 : 0
    }
  })
  return { event, evidence }
}

module.exports = { representativeEvent }
