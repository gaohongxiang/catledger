const { randomUUID } = require('node:crypto')

const { resolveAccountMappings } = require('./account-mapping-policy')
const { digestParts } = require('./digest')
const {
  accountIdentityKeyForReference,
  accountGroupingKey,
  expectedAccountType,
  paymentAccountDetails,
  paymentReferenceKey
} = require('./payment-account')
const {
  EVENT_KEY_VERSION,
  PLAN_VERSION,
  RELATION_KEY_VERSION,
  REVIEW_ISSUE_VERSION
} = require('./domain-versions')
const {
  createMappingIndex,
  projectSourceFunds,
  resolvePaymentMethod,
  resolveSourceFunds,
  withAggregateCandidates
} = require('./source-funds')
const {
  ECONOMIC_NATURE,
  EVENT_STATUS,
  EVIDENCE_ROLE,
  FLOW_DIRECTION,
  RELATION_STATUS,
  RELATION_TYPE,
  classifyReviewIssue,
  economicNatureForRow,
  evaluatePostability,
  flowDirectionForRow,
  unique
} = require('./organizer-model')
const {
  autoReasonCode,
  candidateReasonCode,
  selectRefundCandidates
} = require('./refund-relation-policy')

const STRONG_REFERENCE_WINDOW_MS = 72 * 60 * 60 * 1000
const SAME_EVENT_CANDIDATE_WINDOW_MS = 48 * 60 * 60 * 1000

function exactAccountName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
}

// 只有规范全名在当前账本中唯一精确命中时才自动沿用。
// 显式历史映射/本批决定会在 mappingIndex 中后写并覆盖这里的推断。
function inferExactAccountMappings(rows, accounts) {
  const accountsByName = new Map()
  ;(accounts || []).forEach((account) => {
    if (!account || !account.accountId || account.currency !== 'CNY') return
    const key = exactAccountName(account.name)
    if (!key) return
    const matches = accountsByName.get(key) || []
    matches.push(account.accountId)
    accountsByName.set(key, matches)
  })
  const inferred = new Map()
  function consider(sourceType, paymentMethodKey, displayName) {
    if (!sourceType || !paymentMethodKey) return
    const matches = accountsByName.get(exactAccountName(displayName)) || []
    if (matches.length !== 1) return
    const key = paymentReferenceKey(sourceType, paymentMethodKey)
    const candidate = {
      sourceType, paymentMethodKey, paymentMethodHint: displayName,
      mappingAction: 'account', accountId: matches[0], mappingScope: 'inferred'
    }
    const prior = inferred.get(key)
    if (!prior || prior.accountId === candidate.accountId) inferred.set(key, candidate)
    else inferred.delete(key)
  }
  ;(rows || []).forEach((row) => {
    const account = paymentAccountDetails(row.sourceType, row.paymentMethod)
    if (account.recognized) consider(row.sourceType, row.paymentMethodKey, account.displayName)
    const projection = projectSourceFunds(row)
    if (projection) {
      consider(projection.from.sourceType, projection.from.paymentMethodKey, projection.from.label)
      consider(projection.to.sourceType, projection.to.paymentMethodKey, projection.to.label)
    }
  })
  return [...inferred.values()]
}

function mappingReferenceHints(rows) {
  const hints = new Map()
  function add(sourceType, paymentMethodKey, label) {
    if (!sourceType || !paymentMethodKey || !label) return
    const key = paymentReferenceKey(sourceType, paymentMethodKey)
    if (!hints.has(key)) hints.set(key, label)
  }
  ;(rows || []).forEach((row) => {
    add(row.sourceType, row.paymentMethodKey, row.paymentMethod)
    const projection = projectSourceFunds(row)
    if (!projection) return
    add(projection.from.sourceType, projection.from.paymentMethodKey, projection.from.label)
    add(projection.to.sourceType, projection.to.paymentMethodKey, projection.to.label)
  })
  return hints
}

function accountReferences(rows) {
  const references = new Map()
  function add(reference) {
    const key = paymentReferenceKey(reference)
    if (!key || !accountIdentityKeyForReference(reference)) return
    if (!references.has(key)) references.set(key, reference)
  }
  ;(rows || []).forEach((row) => {
    const details = paymentAccountDetails(row.sourceType, row.paymentMethod)
    if (details.referenceKind === 'atomic' && details.recognized) {
      add({
        sourceType: row.sourceType,
        paymentMethodKey: row.paymentMethodKey,
        label: details.displayName,
        accountIdentityKey: accountGroupingKey(row.sourceType, row.paymentMethod),
        aggregateFamilies: details.aggregateFamilies || []
      })
    }
    const projection = projectSourceFunds(row)
    if (!projection) return
    add(projection.from)
    add(projection.to)
  })
  return [...references.values()]
}

function compatibleHistoricalMappings(mappings, rows, accounts) {
  const hints = mappingReferenceHints(rows)
  const accountsById = new Map((accounts || []).map((account) => [account.accountId, account]))
  return (mappings || []).filter((mapping) => {
    if (!mapping || mapping.mappingScope !== 'history' || mapping.mappingAction !== 'account') return true
    const account = accountsById.get(mapping.accountId)
    if (!account) return true
    const hint = hints.get(paymentReferenceKey(mapping))
    const expectedType = expectedAccountType(mapping.sourceType, hint)
    return !expectedType || account.type === expectedType
  })
}

function timeValue(value) {
  if (!value) return null
  const parsed = Date.parse(String(value).replace(' ', 'T') + 'Z')
  return Number.isFinite(parsed) ? parsed : null
}

function normalizedText(row) {
  return `${row.counterparty || ''} ${row.item || ''} ${row.sourceNote || ''}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 160)
}

function canonicalEvidenceText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 160)
}

const SHARED_DECISION_ISSUE_TYPES = new Set(['transfer_accounts', 'shared_fields', 'category_assignment'])
const SHARED_DECISION_REASON_CODES = new Set([
  'blocking_issue_open',
  'core_fields_missing',
  'economic_nature_required',
  'category_required',
  'ledger_account_required',
  'postability_direction_conflict',
  'transfer_account_required',
  'repayment_account_required',
  'borrow_account_required',
  'balance_adjustment_mapping_required'
])

function sharedReviewDecisionSignature(event, classification) {
  const projection = event.fieldSources && event.fieldSources.fundsProjection
  if (projection && projection.to && projection.to.referenceKind === 'aggregate') return event.eventKey
  const reasons = unique(event.reasonCodes || [])
    .filter((reason) => SHARED_DECISION_REASON_CODES.has(reason))
    .sort()
  const evidenceRows = event.relationEvidence && event.relationEvidence.rows || []
  const rowParts = unique(evidenceRows.map((row) => [
    row.sourceType,
    row.accountGroupingKey,
    row.transactionType,
    row.economicEffect,
    row.direction,
    row.currency,
    canonicalEvidenceText(row.rawTransactionType),
    canonicalEvidenceText(row.counterparty),
    canonicalEvidenceText(row.item),
    canonicalEvidenceText(row.paymentMethod)
  ].join('|')).sort())
  return digestParts(
    'review-decision-signature-v2',
    classification.issueType,
    event.economicNature,
    event.flowDirection,
    reasons.join(','),
    ...(rowParts.length ? rowParts : [event.eventKey])
  )
}

function stableReferences(row) {
  return [
    ['transaction', row.sourceTransactionId],
    ['order', row.sourceOrderId],
    ['merchant_order', row.sourceMerchantOrderId]
  ].filter(([, value]) => typeof value === 'string' && value.normalize('NFKC').trim().length >= 6)
    .map(([kind, value]) => `${kind}:${value.normalize('NFKC').trim().toLowerCase()}`)
}

function scopedStableReferences(row) {
  return stableReferences(row).map((reference) => `${row.sourceType || 'unknown'}|${reference}`)
}

function compatibleCore(left, right, windowMs = STRONG_REFERENCE_WINDOW_MS) {
  if (String(left.amountMinor) !== String(right.amountMinor) || left.currency !== right.currency || left.direction !== right.direction) {
    return false
  }
  const leftTime = timeValue(left.utcAt)
  const rightTime = timeValue(right.utcAt)
  return leftTime != null && rightTime != null && Math.abs(leftTime - rightTime) <= windowMs
}

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index)
  function find(value) {
    let current = value
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  return {
    find,
    union(left, right) {
      const leftRoot = find(left)
      const rightRoot = find(right)
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
    }
  }
}

function groupEvidence(rows) {
  const groups = new Map()
  const union = unionFind(rows.length)
  const identityIndexes = new Map()
  const referenceIndexes = new Map()

  rows.forEach((row, index) => {
    if (row.identityId && row.identityState !== 'identity_conflict') {
      const prior = identityIndexes.get(row.identityId)
      if (prior != null) union.union(prior, index)
      else identityIndexes.set(row.identityId, index)
    }
    stableReferences(row).forEach((reference) => {
      const candidates = referenceIndexes.get(reference) || []
      for (const prior of candidates) {
        if (rows[prior].sourceType !== row.sourceType && compatibleCore(rows[prior], row)) {
          union.union(prior, index)
        }
      }
      candidates.push(index)
      referenceIndexes.set(reference, candidates)
    })
  })

  rows.forEach((row, index) => {
    const root = union.find(index)
    const group = groups.get(root) || []
    group.push(row)
    groups.set(root, group)
  })
  return [...groups.values()].map((group) => group.sort((left, right) => (
    left.sourceOrder - right.sourceOrder || left.rowNumber - right.rowNumber || left.rowId.localeCompare(right.rowId)
  )))
}

function representativeEvent(updateId, group, idFactory, mappingIndex, mappingResolution, references) {
  const primary = group[0]
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
    const details = paymentAccountDetails(row.sourceType, row.paymentMethod)
    return details.referenceKind === 'atomic' && details.recognized
      ? resolvePaymentMethod(row.sourceType, row.paymentMethodKey, mappingIndex)
      : null
  }))
  const accountConflict = accountIds.length > 1
  const coreConflict = group.some((row) => !compatibleCore(primary, row, STRONG_REFERENCE_WINDOW_MS))
  const identityConflict = group.some((row) => row.identityState === 'identity_conflict')
  const ignoredBySavedRule = group.every((row) => row.mappingAction === 'ignore')
  const accountMappingConflict = group.some((row) => (
    mappingResolution.conflictIdentityKeys.has(accountGroupingKey(row.sourceType, row.paymentMethod))
  )) || [projection && projection.from, projection && projection.to].filter(Boolean).some((reference) => (
    mappingResolution.conflictIdentityKeys.has(accountIdentityKeyForReference(reference))
  ))
  const failedOrClosed = group.every((row) => ['failed', 'closed'].includes(row.economicEffect))
  const reasons = []
  if (identityConflict) reasons.push('identity_conflict')
  if (accountMappingConflict) reasons.push('account_mapping_conflict')
  if (accountConflict || coreConflict) reasons.push('core_fields_conflict')
  if (projectionConflict) reasons.push('core_fields_conflict')
  if (existingTransactionIds.length > 1) reasons.push('identity_conflict')
  if (nature === ECONOMIC_NATURE.UNKNOWN) reasons.push('economic_nature_required')
  if (primary.economicEffect === 'unknown') reasons.push('transaction_status_unknown')
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
    // “以后默认不计入”是可覆盖的账户归属偏好，不是静默过滤器。
    // 后续批次仍进入账户步骤，默认显示不计入，用户可改选账户。
    status: existingTransactionIds.length > 0 || failedOrClosed ? EVENT_STATUS.EXCLUDED : EVENT_STATUS.NEEDS_ACTION,
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
      primaryEvidenceId: null,
      rowIds: group.map((row) => row.rowId),
      fundsProjection: resolvedFunds ? resolvedFunds.projection : projection && !projectionConflict ? projection : null
    },
    reasonCodes: unique([
      ...reasons,
      existingTransactionIds.length > 0 ? 'already_posted' : null,
      ignoredBySavedRule ? 'source_account_ignored_default' : null,
      failedOrClosed ? primary.economicEffect === 'failed' ? 'transaction_failed' : 'transaction_closed' : null
    ]),
    version: 1,
    existingTransactionIds,
    paymentMethodKey: paymentAccountDetails(primary.sourceType, primary.paymentMethod).recognized
      ? primary.paymentMethodKey
      : null,
    accountGroupingKey: accountGroupingKey(primary.sourceType, primary.paymentMethod),
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
        rawTransactionType: row.rawTransactionType || '',
        direction: row.direction,
        economicEffect: row.economicEffect,
        utcAt: row.utcAt,
        amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
        currency: row.currency || 'CNY',
        counterparty: row.counterparty || '',
        item: row.item || '',
        paymentMethod: row.paymentMethod || '',
        rawStatus: row.rawStatus || ''
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

function refundRelation(updateId, refund, target, idFactory, status, reasonCode) {
  return {
    relationId: idFactory(),
    updateId,
    relationKey: digestParts(RELATION_KEY_VERSION, RELATION_TYPE.REFUND_OF, refund.eventKey, target.eventKey),
    relationKeyVersion: RELATION_KEY_VERSION,
    relationType: RELATION_TYPE.REFUND_OF,
    status,
    version: 1,
    sourceEventId: refund.eventId,
    targetEventId: target.eventId,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    manual: false,
    reasonCodes: [reasonCode]
  }
}

function sameEventCandidateGroups(events) {
  const buckets = new Map()
  events.forEach((event) => {
    if (event.status === EVENT_STATUS.EXCLUDED) return
    const key = `${event.amountMinor || ''}|${event.currency}|${event.flowDirection}`
    const bucket = buckets.get(key) || []
    bucket.push(event)
    buckets.set(key, bucket)
  })
  const result = []
  buckets.forEach((bucket) => {
    const available = new Set(bucket.map((event) => event.eventId))
    for (const event of bucket) {
      if (!available.has(event.eventId)) continue
      const text = normalizedText(event.display)
      const currentTime = timeValue(event.utcAt)
      const candidates = bucket.filter((candidate) => {
        if (!available.has(candidate.eventId) || candidate.eventId === event.eventId) return false
        if (candidate.sourceType === event.sourceType) return false
        const candidateTime = timeValue(candidate.utcAt)
        if (currentTime == null || candidateTime == null || Math.abs(currentTime - candidateTime) > SAME_EVENT_CANDIDATE_WINDOW_MS) return false
        const candidateText = normalizedText(candidate.display)
        return text.length >= 2 && candidateText.length >= 2 &&
          (text === candidateText || text.includes(candidateText) || candidateText.includes(text))
      })
      if (candidates.length === 0) continue
      const group = [event, ...candidates]
      group.forEach((candidate) => available.delete(candidate.eventId))
      const candidateKey = digestParts('same-event-candidate-v2', ...group.map((candidate) => candidate.eventKey).sort())
      group.forEach((candidate) => {
        candidate.sameEventCandidateKey = candidateKey
        candidate.status = EVENT_STATUS.NEEDS_ACTION
        candidate.reasonCodes = unique([...candidate.reasonCodes, 'same_event_candidate', 'relation_ambiguous'])
      })
      result.push({ candidateKey, events: group })
    }
  })
  return result
}

function buildRelations(updateId, events, idFactory) {
  const relations = []
  const chronological = [...events].sort((left, right) => (timeValue(left.utcAt) || 0) - (timeValue(right.utcAt) || 0))
  const uniqueRefundMatches = []
  chronological.forEach((event, index) => {
    if (event.status === EVENT_STATUS.EXCLUDED) return
    if (event.economicNature === ECONOMIC_NATURE.REFUND) {
      const selection = selectRefundCandidates(event, chronological.slice(0, index))
      const candidates = selection.candidates
      if (candidates.length === 0) {
        event.status = EVENT_STATUS.NEEDS_ACTION
        event.reasonCodes = unique([...event.reasonCodes, 'refund_relation_required'])
      } else if (selection.autoConfirm) {
        uniqueRefundMatches.push({ refund: event, target: candidates[0].event, matchKind: candidates[0].matchKind })
      } else {
        candidates.forEach((candidate) => {
          relations.push(refundRelation(updateId, event, candidate.event, idFactory, RELATION_STATUS.PROPOSED,
            candidateReasonCode(candidate.matchKind)))
        })
        event.status = EVENT_STATUS.NEEDS_ACTION
        event.reasonCodes = unique([...event.reasonCodes,
          candidates.length > 1 ? 'refund_relation_ambiguous' : 'refund_relation_required'])
      }
    }
  })

  const refundsByOriginal = new Map()
  uniqueRefundMatches.forEach((match) => {
    const matches = refundsByOriginal.get(match.target.eventId) || []
    matches.push(match)
    refundsByOriginal.set(match.target.eventId, matches)
  })
  refundsByOriginal.forEach((matches) => {
    const target = matches[0].target
    const total = matches.reduce((sum, match) => sum + BigInt(match.refund.amountMinor), 0n)
    const safe = target.amountMinor != null && total <= BigInt(target.amountMinor)
    matches.forEach((match) => {
      if (!safe) {
        relations.push(refundRelation(updateId, match.refund, match.target, idFactory, RELATION_STATUS.PROPOSED, 'refund_amount_exceeded'))
        match.refund.status = EVENT_STATUS.NEEDS_ACTION
        match.refund.reasonCodes = unique([...match.refund.reasonCodes, 'refund_amount_exceeded'])
        return
      }
      const relation = refundRelation(updateId, match.refund, match.target, idFactory, RELATION_STATUS.CONFIRMED,
        autoReasonCode(match.matchKind))
      relations.push(relation)
      match.refund.reasonCodes = unique(match.refund.reasonCodes
        .filter((reason) => !['refund_relation_required', 'refund_relation_ambiguous', 'relation_ambiguous'].includes(reason))
        .concat(autoReasonCode(match.matchKind)))
      const evaluated = evaluatePostability(match.refund, { relations: [relation] })
      match.refund.status = evaluated.status
      match.refund.reasonCodes = unique([...match.refund.reasonCodes, ...evaluated.reasonCodes])
    })
  })

  const movementEvents = chronological.filter((event) => (
    [ECONOMIC_NATURE.INTERNAL_TRANSFER, ECONOMIC_NATURE.REPAYMENT, ECONOMIC_NATURE.BORROW].includes(event.economicNature) &&
    event.status !== EVENT_STATUS.EXCLUDED
  ))
  movementEvents.forEach((event, index) => {
    const eventTime = timeValue(event.utcAt)
    const candidate = movementEvents.slice(index + 1).find((target) => {
      const targetTime = timeValue(target.utcAt)
      return target.currency === event.currency && String(target.amountMinor) === String(event.amountMinor) &&
        eventTime != null && targetTime != null && Math.abs(eventTime - targetTime) <= STRONG_REFERENCE_WINDOW_MS
    })
    if (!candidate) return
    const relationType = event.economicNature === ECONOMIC_NATURE.REPAYMENT || candidate.economicNature === ECONOMIC_NATURE.REPAYMENT
      ? RELATION_TYPE.REPAYMENT_OF
      : RELATION_TYPE.TRANSFER_BETWEEN
    relations.push({
      relationId: idFactory(),
      updateId,
      relationKey: digestParts(RELATION_KEY_VERSION, relationType, ...[event.eventKey, candidate.eventKey].sort()),
      relationKeyVersion: RELATION_KEY_VERSION,
      relationType,
      status: RELATION_STATUS.PROPOSED,
      version: 1,
      sourceEventId: event.eventId,
      targetEventId: candidate.eventId,
      amountMinor: event.amountMinor,
      currency: event.currency,
      manual: false,
      reasonCodes: ['relation_candidate']
    })
    ;[event, candidate].forEach((item) => {
      item.status = EVENT_STATUS.NEEDS_ACTION
      item.reasonCodes = unique([...item.reasonCodes, 'relation_ambiguous'])
    })
  })
  return relations
}

function buildReviewIssues(updateId, events, relations, candidateGroups, idFactory) {
  const candidateByEvent = new Map()
  candidateGroups.forEach((group) => group.events.forEach((event) => candidateByEvent.set(event.eventId, group.candidateKey)))
  const buckets = new Map()
  events.filter((event) => event.status === EVENT_STATUS.NEEDS_ACTION).forEach((event) => {
    const classification = classifyReviewIssue(event)
    const projection = event.fieldSources && event.fieldSources.fundsProjection
    const accountRequirements = classification.issueType === 'account_mapping' && projection
      ? [
          !event.ledgerAccountId && projection.from && projection.from.paymentMethodKey
            ? { reference: projection.from, memberRole: 'mapping_from' }
            : null,
          !event.counterpartyLedgerAccountId && projection.to && projection.to.paymentMethodKey
            ? { reference: projection.to, memberRole: 'mapping_to' }
            : null
        ].filter(Boolean)
      : []
    const descriptors = accountRequirements.length
      ? accountRequirements.map((requirement) => ({
          classification: {
            issueType: 'account_mapping',
            primaryReason: 'payment_reference_mapping_required'
          },
          memberRole: requirement.memberRole,
          signature: accountIdentityKeyForReference(requirement.reference) || paymentReferenceKey(requirement.reference)
        }))
      : [{ classification, memberRole: 'subject', signature: null }]

    descriptors.forEach((descriptor) => {
      const currentClassification = descriptor.classification
      let signature = descriptor.signature || event.eventKey
      if (currentClassification.issueType === 'same_event') signature = candidateByEvent.get(event.eventId) || event.eventKey
      if (currentClassification.issueType === 'account_mapping' && !descriptor.signature) {
        signature = event.accountGroupingKey || paymentReferenceKey(event.sourceType, event.paymentMethodKey) || event.eventKey
      } else if (SHARED_DECISION_ISSUE_TYPES.has(currentClassification.issueType)) {
        signature = sharedReviewDecisionSignature(event, currentClassification)
      }
      const key = digestParts(REVIEW_ISSUE_VERSION, updateId, currentClassification.issueType, signature)
      const bucket = buckets.get(key) || { key, classification: currentClassification, subjects: [], relations: [] }
      if (!bucket.subjects.some((item) => item.event.eventId === event.eventId && item.memberRole === descriptor.memberRole)) {
        bucket.subjects.push({ event, memberRole: descriptor.memberRole })
      }
      relations.filter((relation) => (
        relation.sourceEventId === event.eventId || relation.targetEventId === event.eventId
      ) && (
        currentClassification.issueType === 'refund_relation'
          ? relation.relationType === RELATION_TYPE.REFUND_OF && ![RELATION_STATUS.REJECTED, RELATION_STATUS.UNDONE].includes(relation.status)
          : ['same_event', 'transfer_accounts'].includes(currentClassification.issueType) && relation.status === RELATION_STATUS.PROPOSED
      ))
        .forEach((relation) => {
          if (!bucket.relations.some((item) => item.relationId === relation.relationId)) bucket.relations.push(relation)
        })
      buckets.set(key, bucket)
    })
  })

  const issues = []
  const members = []
  ;[...buckets.values()].sort((left, right) => left.key.localeCompare(right.key)).forEach((bucket) => {
    const issueId = idFactory()
    const reasonCodes = unique(bucket.subjects.flatMap((item) => item.event.reasonCodes)
      .concat(bucket.relations.flatMap((relation) => relation.reasonCodes)))
    issues.push({
      issueId,
      updateId,
      issueKey: bucket.key,
      issueKeyVersion: REVIEW_ISSUE_VERSION,
      issueType: bucket.classification.issueType,
      status: 'open',
      version: 1,
      blocking: true,
      primaryReasonCode: bucket.classification.primaryReason,
      memberCount: bucket.subjects.length + bucket.relations.length,
      candidateCount: bucket.classification.issueType === 'refund_relation'
        ? bucket.relations.filter((relation) => relation.status === RELATION_STATUS.PROPOSED).length
        : bucket.classification.issueType === 'same_event' ? Math.max(0, bucket.subjects.length - 1) : 0,
      ruleVersion: REVIEW_ISSUE_VERSION,
      reasonCodes
    })
    let sortOrder = 0
    bucket.subjects.forEach(({ event, memberRole }) => members.push({
      memberId: idFactory(), updateId, issueId, objectType: 'event', objectId: event.eventId,
      objectVersion: event.version, memberRole, sortOrder: sortOrder++
    }))
    bucket.relations.forEach((relation) => members.push({
      memberId: idFactory(), updateId, issueId, objectType: 'relation', objectId: relation.relationId,
      objectVersion: relation.version, memberRole: 'candidate', sortOrder: sortOrder++
    }))
  })
  return { issues, members }
}

// 唯一同名账户被自动沿用时，业务结果已经可入账，但账户步骤仍要给用户
// 一条可见、可修改的“已确认”记录，不能因为没有阻塞问题就从界面消失。
function buildConfirmedAccountIssues(updateId, events, effectiveMappings, idFactory) {
  const confirmedKeys = new Map((effectiveMappings || []).filter((mapping) => (
    mapping.mappingAction === 'account' && mapping.accountId
  )).map((mapping) => [paymentReferenceKey(mapping), mapping.accountId]))
  const groups = new Map()
  ;(events || []).forEach((event) => {
    const projection = event.fieldSources && event.fieldSources.fundsProjection
    const candidates = projection
      ? [
          { reference: projection.from, accountId: event.ledgerAccountId, memberRole: 'mapping_from' },
          { reference: projection.to, accountId: event.counterpartyLedgerAccountId, memberRole: 'mapping_to' }
        ]
      : [{
          reference: {
            sourceType: event.sourceType,
            paymentMethodKey: event.paymentMethodKey,
            accountIdentityKey: event.accountGroupingKey
          },
          accountId: event.ledgerAccountId,
          memberRole: 'subject'
        }]
    candidates.forEach((candidate) => {
      const reference = candidate.reference
      if (!reference || !reference.sourceType || !reference.paymentMethodKey || !candidate.accountId) return
      const confirmedAccountId = confirmedKeys.get(paymentReferenceKey(reference))
      if (!confirmedAccountId || confirmedAccountId !== candidate.accountId) return
      const identityKey = accountIdentityKeyForReference(reference) || paymentReferenceKey(reference)
      const key = `${identityKey}:${confirmedAccountId}`
      const group = groups.get(key) || []
      if (!group.some((item) => item.event.eventId === event.eventId && item.memberRole === candidate.memberRole)) {
        group.push({ event, memberRole: candidate.memberRole })
      }
      groups.set(key, group)
    })
  })
  const issues = []
  const members = []
  ;[...groups.entries()].sort((left, right) => left[0].localeCompare(right[0])).forEach(([groupKey, group]) => {
    const issueId = idFactory()
    const projected = group.some((item) => item.memberRole !== 'subject')
    issues.push({
      issueId,
      updateId,
      issueKey: digestParts(REVIEW_ISSUE_VERSION, updateId, 'account_mapping', groupKey),
      issueKeyVersion: REVIEW_ISSUE_VERSION,
      issueType: 'account_mapping',
      status: 'resolved',
      version: 1,
      blocking: false,
      primaryReasonCode: projected ? 'payment_reference_mapping_confirmed' : 'account_mapping_confirmed',
      memberCount: group.length,
      candidateCount: 0,
      ruleVersion: REVIEW_ISSUE_VERSION,
      reasonCodes: ['account_mapping_confirmed']
    })
    group.forEach(({ event, memberRole }, index) => members.push({
      memberId: idFactory(), updateId, issueId, objectType: 'event', objectId: event.eventId,
      objectVersion: event.version, memberRole, sortOrder: index
    }))
  })
  return { issues, members }
}

function buildOrganizePlan({ updateId, rows, paymentMappings = [], accounts = [], idFactory = randomUUID }) {
  const validRows = rows.filter((row) => row.parseState === 'valid')
  const inferredMappings = inferExactAccountMappings(validRows, accounts)
  // 优先级：名称精确推断 < 类型兼容的已发布历史映射 < 本批账户草稿。
  // selectPlanningRows 上的 mappingAction 只代表已发布历史映射，必须先于
  // paymentMappings 写入，否则会把用户刚在本批选择的账户重新覆盖掉。
  const historicalRowMappings = validRows.map((row) => ({
    sourceType: row.sourceType,
    paymentMethodKey: row.paymentMethodKey,
    paymentMethodHint: row.paymentMethod,
    mappingAction: row.mappingAction,
    accountId: row.mappedAccountId,
    mappingScope: 'history'
  }))
  const scopedPaymentMappings = paymentMappings.map((mapping) => ({
    ...mapping,
    mappingScope: mapping.mappingScope || 'batch'
  }))
  const references = accountReferences(validRows)
  const compatibleMappings = compatibleHistoricalMappings(
    inferredMappings.concat(historicalRowMappings, scopedPaymentMappings), validRows, accounts
  )
  const mappingResolution = resolveAccountMappings({ references, mappings: compatibleMappings, accounts })
  const effectiveMappings = mappingResolution.mappings
  const visibleMappingResolution = resolveAccountMappings({
    references,
    mappings: compatibleHistoricalMappings(inferredMappings.concat(scopedPaymentMappings), validRows, accounts),
    accounts
  })
  const mappingIndex = createMappingIndex(effectiveMappings)
  const grouped = groupEvidence(validRows)
  const events = []
  const evidence = []
  grouped.forEach((group) => {
    const planned = representativeEvent(updateId, group, idFactory, mappingIndex, mappingResolution, references)
    events.push(planned.event)
    evidence.push(...planned.evidence)
  })
  const candidateGroups = sameEventCandidateGroups(events)
  const relations = buildRelations(updateId, events, idFactory)
  const review = buildReviewIssues(updateId, events, relations, candidateGroups, idFactory)
  // 所有实际生效的账户归属都必须在账户步骤可见、可修改；不能因为来自
  // 历史映射就在界面中隐藏，否则错误映射会静默进入后续整理。
  const confirmedAccounts = buildConfirmedAccountIssues(updateId, events, visibleMappingResolution.mappings, idFactory)
  const counts = {
    sourceCount: new Set(rows.map((row) => row.batchId)).size,
    validEvidenceCount: validRows.length,
    duplicateEvidenceCount: validRows.length - events.length,
    finalEventCount: events.length,
    postedEventCount: 0,
    readyEventCount: events.filter((event) => event.status === EVENT_STATUS.READY).length,
    needsActionEventCount: events.filter((event) => event.status === EVENT_STATUS.NEEDS_ACTION).length,
    excludedEventCount: events.filter((event) => event.status === EVENT_STATUS.EXCLUDED).length
  }
  if (counts.finalEventCount !== counts.readyEventCount + counts.needsActionEventCount + counts.excludedEventCount) {
    throw new Error('Organizer event conservation mismatch')
  }
  return {
    planVersion: PLAN_VERSION,
    events,
    evidence,
    relations,
    issues: review.issues.concat(confirmedAccounts.issues),
    members: review.members.concat(confirmedAccounts.members),
    counts
  }
}

module.exports = {
  EVENT_KEY_VERSION,
  PLAN_VERSION,
  RELATION_KEY_VERSION,
  REVIEW_ISSUE_VERSION,
  buildOrganizePlan,
  compatibleHistoricalMappings,
  compatibleCore,
  inferExactAccountMappings,
  normalizedText,
  stableReferences
}
