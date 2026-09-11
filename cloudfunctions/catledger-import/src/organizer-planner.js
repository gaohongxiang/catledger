const { randomUUID } = require('node:crypto')

const { resolveAccountMappings } = require('./account-mapping-policy')
const { digestParts } = require('./digest')
const {
  accountIdentityKeyForReference,
  expectedAccountType,
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
  ledgerAccountReferenceForRow,
  projectSourceFunds
} = require('./source-funds')
const { getRowSemantic } = require('./row-semantic-resolver')
const {
  EVENT_STATUS,
  RELATION_STATUS,
  RELATION_TYPE,
  classifyReviewIssue,
  needsCategory,
  unique
} = require('./organizer-model')

const { representativeEvent } = require('./economic-event-builder')
const { sameEventCandidateGroups, buildRelations } = require('./relation-resolver')
const { normalizedText, stableReferences, compatibleCore, groupEvidence } = require('./evidence-matching')

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
    const ledgerReference = ledgerAccountReferenceForRow(row)
    if (ledgerReference) {
      consider(ledgerReference.sourceType, ledgerReference.paymentMethodKey, ledgerReference.label)
    }
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
    const ledgerReference = ledgerAccountReferenceForRow(row)
    if (ledgerReference) add(ledgerReference.sourceType, ledgerReference.paymentMethodKey, ledgerReference.label)
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
    add(ledgerAccountReferenceForRow(row))
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
    if (!mapping || !['history', 'history_alias'].includes(mapping.mappingScope) || mapping.mappingAction !== 'account') return true
    const account = accountsById.get(mapping.accountId)
    if (!account) return true
    const hint = hints.get(paymentReferenceKey(mapping))
    const expectedType = expectedAccountType(mapping.sourceType, hint)
    return !expectedType || account.type === expectedType
  })
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
  if (['repayment_ownership_required', 'repayment_other_treatment_required'].includes(classification.primaryReason)) return event.eventKey
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
    row.sourceAction || '',
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

function buildReviewIssues(updateId, events, relations, candidateGroups, idFactory) {
  const candidateByEvent = new Map()
  candidateGroups.forEach((group) => group.events.forEach((event) => candidateByEvent.set(event.eventId, group.candidateKey)))
  const buckets = new Map()
  events.filter((event) => event.status === EVENT_STATUS.NEEDS_ACTION ||
    event.status === EVENT_STATUS.READY && needsCategory(event)).forEach((event) => {
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
      blocking: bucket.classification.issueType !== 'category_assignment',
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

// 自动沿用账户或命中长期忽略时，账户步骤仍保留一条非阻塞、可修改的
// 已确认记录；历史决定直接生效，但不会变成不可见、不可覆盖的黑盒。
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
          reference: event.fieldSources && event.fieldSources.ledgerAccountReference || {
            sourceType: event.sourceType,
            paymentMethodKey: event.paymentMethodKey,
            accountIdentityKey: event.accountGroupingKey
          },
          accountId: event.ledgerAccountId,
          memberRole: 'subject'
        }]
    candidates.forEach((candidate) => {
      const reference = candidate.reference
      if (!reference || !reference.sourceType || !reference.paymentMethodKey) return
      const ignored = event.reasonCodes.includes('source_account_ignored_default') && !candidate.accountId
      const confirmedAccountId = confirmedKeys.get(paymentReferenceKey(reference))
      if (!ignored && (!confirmedAccountId || confirmedAccountId !== candidate.accountId)) return
      const identityKey = accountIdentityKeyForReference(reference) || paymentReferenceKey(reference)
      const key = `${identityKey}:${ignored ? 'ignore' : confirmedAccountId}`
      const group = groups.get(key) || { ignored, items: [] }
      if (!group.items.some((item) => item.event.eventId === event.eventId && item.memberRole === candidate.memberRole)) {
        group.items.push({ event, memberRole: candidate.memberRole })
      }
      groups.set(key, group)
    })
  })
  const issues = []
  const members = []
  ;[...groups.entries()].sort((left, right) => left[0].localeCompare(right[0])).forEach(([groupKey, group]) => {
    const issueId = idFactory()
    const projected = group.items.some((item) => item.memberRole !== 'subject')
    issues.push({
      issueId,
      updateId,
      issueKey: digestParts(REVIEW_ISSUE_VERSION, updateId, 'account_mapping', groupKey),
      issueKeyVersion: REVIEW_ISSUE_VERSION,
      issueType: 'account_mapping',
      status: 'resolved',
      version: 1,
      blocking: false,
      primaryReasonCode: group.ignored
        ? 'payment_reference_ignored_by_history'
        : projected ? 'payment_reference_mapping_confirmed' : 'account_mapping_confirmed',
      memberCount: group.items.length,
      candidateCount: 0,
      ruleVersion: REVIEW_ISSUE_VERSION,
      reasonCodes: group.ignored ? ['source_account_ignored_default'] : ['account_mapping_confirmed']
    })
    group.items.forEach(({ event, memberRole }, index) => members.push({
      memberId: idFactory(), updateId, issueId, objectType: 'event', objectId: event.eventId,
      objectVersion: event.version, memberRole, sortOrder: index
    }))
  })
  return { issues, members }
}

function buildOrganizePlan({ updateId, rows, paymentMappings = [], accounts = [], idFactory = randomUUID }) {
  const validRows = rows.filter((row) => row.parseState === 'valid')
    .map((row) => ({ ...row, semantic: getRowSemantic(row) }))
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
  buildReviewIssues,
  compatibleHistoricalMappings,
  compatibleCore,
  inferExactAccountMappings,
  normalizedText,
  stableReferences
}
