const { resolveAccountMappings, accountIdFromIndex } = require('./account-mapping-policy')
const { digestParts } = require('./portable-digest')
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
const { applyInstallmentDisbursements } = require('./installment-disbursement')
const { referencesForRows, mappedAccount, VERSION: ACCOUNT_GROUPS_VERSION } = require('./payment-account-groups')
const { coalesceAccountIssues } = require('./account-issue-grouping')
const { EVENT_STATUS, RELATION_STATUS, RELATION_TYPE, REVIEW_ISSUE_TYPE, classifyReviewIssue, needsCategory } = require('./organizer-model')
const { unique } = require('./organizer-values')

const { representativeEvent } = require('./economic-event-builder')
const { sameEventCandidateGroups, buildRelations } = require('./relation-resolver')
const { normalizedText, stableReferences, compatibleCore, groupEvidence } = require('./evidence-matching')
const {
  REASON_CODE: INSTALLMENT_ATTRIBUTION_REASON,
  attributionFor,
  effectiveInstallment,
  needsAttribution,
  groupKeyOf: installmentGroupKeyOf
} = require('./installment-plan')

function exactAccountName(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN')
}

// 名称命中只产生候选；统一绑定裁决不会把 inferred 当成用户确认。
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
      if (projection.from) consider(projection.from.sourceType, projection.from.paymentMethodKey, projection.from.label)
      if (projection.to) consider(projection.to.sourceType, projection.to.paymentMethodKey, projection.to.label)
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
    if (projection.from) add(projection.from.sourceType, projection.from.paymentMethodKey, projection.from.label)
    if (projection.to) add(projection.to.sourceType, projection.to.paymentMethodKey, projection.to.label)
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
    // 组合付款的每个成分也是本批真实用到的付款账户：只有把它们一起交给映射解析，
    // 历史决定才能按成分键自动沿用，账户步骤才只问真正没定过的那些。
    referencesForRows([row]).forEach(add)
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
    .replace(/[\s!-/:-@\[-`{-~\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2010-\u2027\u2030-\u205e\u00b7\u2026\u2014\u2018\u2019\u201c\u201d\u3001\u3002\uff0c\uff1b\uff1a\uff1f\uff01]+/g, '')
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
  if (['repayment_ownership_required', 'repayment_other_treatment_required', 'repayment_channel_details_required'].includes(classification.primaryReason)) return event.eventKey
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

// 分期费用行的归属要看到同期次的全部本金，单事件层面判不出来，所以放在整批事件都生成之后。
// 判不出归属的费用行降为待核对：待核对视图由服务端按 needs_action 筛选，客户端挪不动事件，
// 所以“进待核对”必须在整理阶段落地。用户在核对里指定计划后该原因码被清掉，事件自然回到已核对。
//
// 整组一起进待核对：本金行留在已核对会让本息分离，用户也没法在同一张卡里把利息配到本金上。
// 本金行不写原因码——它没有自己的归属问题，写下来只会留下一个随用户操作立即过期的快照；
// 它靠“同组事项的成员”身份出现在待核对里（见 buildReviewIssues），事项收尾时一起离开。
function applyInstallmentAttribution(events) {
  events.forEach((event) => {
    // 分组键在这里就落到事件上：来源账户身份不落库，读取层算不回来，客户端也不能自己拼，
    // 否则整理期和展示期会按不同口径分组。
    if (!effectiveInstallment(event)) return
    const key = installmentGroupKeyOf(event)
    if (key) event.fieldSources.installment = { ...event.fieldSources.installment, groupKey: key }
  })
  const attributions = attributionFor(events)
  events.forEach((event) => {
    if (!effectiveInstallment(event)) return
    if ([EVENT_STATUS.EXCLUDED, EVENT_STATUS.POSTED, EVENT_STATUS.CORRECTED].includes(event.status)) return
    const attribution = attributions.get(event.eventId)
    // 归属是整理的产物，不是账单事实：这一轮没算出来就必须把上一轮的结论清掉。
    // 否则用户把利息指定完再重新整理，本金行还挂着“本期次还有待指定”的旧上下文。
    if (attribution) event.fieldSources.installmentAttribution = attribution
    else delete event.fieldSources.installmentAttribution
    // 判不出来、而本期次确实有可选项的费用行才拦下来等用户指定；
    // 没有候选就无从指定，那是来源侧的问题，不在这里制造死结。
    if (!attribution || !needsAttribution(event)) return
    event.reasonCodes = unique([...event.reasonCodes, INSTALLMENT_ATTRIBUTION_REASON])
    if (event.status === EVENT_STATUS.READY) event.status = EVENT_STATUS.NEEDS_ACTION
  })
}

// 同一期次的分期行：金额、日期、卡号和行序都没有区分度，只有「同组」这一个事实，
// 所以待核对必须让用户看到整组——本金锚在上面，本期次的费用都列在同一条事项里。
function installmentGroupMembers(events) {
  const groups = new Map()
  ;(events || []).forEach((event) => {
    const attribution = event.fieldSources && event.fieldSources.installmentAttribution
    const key = attribution && attribution.groupKey || installmentGroupKeyOf(event)
    if (!key) return
    if (![EVENT_STATUS.READY, EVENT_STATUS.NEEDS_ACTION].includes(event.status)) return
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(event)
  })
  // 本金置前：事项的 sort_order=0 就是这张卡的门面，应当是用户可以点进去的锚点。
  groups.forEach((members) => members.sort((left, right) => (
    Number(right.fieldSources.installment.component === 'principal') -
    Number(left.fieldSources.installment.component === 'principal')) ||
    String(left.eventId).localeCompare(String(right.eventId))))
  return groups
}

function buildReviewIssues(updateId, events, relations, candidateGroups, idFactory) {
  const candidateByEvent = new Map()
  candidateGroups.forEach((group) => group.events.forEach((event) => candidateByEvent.set(event.eventId, group.candidateKey)))
  // 同一个期次的本金和费用必须落在一个事项里：用户在一条待核对事项里看到整组的本息，
  // 指定完归属后整组一起离开；拆成多条只会让“哪笔利息属于哪个计划”无从对照。
  const installmentGroups = installmentGroupMembers(events)
  const buckets = new Map(), relationsByEvent = new Map()
  for (const relation of relations) {
    for (const eventId of new Set([relation.sourceEventId, relation.targetEventId])) {
      if (!relationsByEvent.has(eventId)) relationsByEvent.set(eventId, [])
      relationsByEvent.get(eventId).push(relation)
    }
  }
  events.filter((event) => event.status === EVENT_STATUS.NEEDS_ACTION ||
    event.status === EVENT_STATUS.READY && needsCategory(event)).forEach((event) => {
    const classification = classifyReviewIssue(event)
    const projection = event.fieldSources && event.fieldSources.fundsProjection
    const ownership = require('./account-ownership').read(event)
    const accountRequirements = classification.issueType === 'account_mapping' && projection
      ? [
          ownership.source.kind !== 'external' && !ownership.source.accountId && projection.from && projection.from.paymentMethodKey
            ? { reference: projection.from, memberRole: 'mapping_from' }
            : null,
          ownership.destination.kind !== 'external' && !ownership.destination.accountId && projection.to && projection.to.paymentMethodKey
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
      if (currentClassification.primaryReason === 'installment_attribution_required') {
        // 同一期次的待归属费用合到一个事项：用户要在一个界面里看到本期次的全部计划和全部待归属费用。
        signature = (event.fieldSources.installmentAttribution || {}).groupKey || event.eventKey
      } else if (currentClassification.issueType === 'account_mapping' && !descriptor.signature) {
        signature = event.accountGroupingKey || paymentReferenceKey(event.sourceType, event.paymentMethodKey) || event.eventKey
      } else if (SHARED_DECISION_ISSUE_TYPES.has(currentClassification.issueType)) {
        signature = sharedReviewDecisionSignature(event, currentClassification)
      }
      const key = digestParts(REVIEW_ISSUE_VERSION, updateId, currentClassification.issueType, signature)
      const bucket = buckets.get(key) || { key, classification: currentClassification, subjects: [], relations: [], subjectKeys: new Set(), relationIds: new Set() }
      const pushSubject = (member, memberRole) => {
        const subjectKey = member.eventId + ':' + memberRole
        if (bucket.subjectKeys.has(subjectKey)) return
        bucket.subjectKeys.add(subjectKey)
        bucket.subjects.push({ event: member, memberRole })
      }
      if (currentClassification.primaryReason === 'installment_attribution_required') {
        // 事项只装还没归属的费用：本金和已经归好的费用已经确定，不再被绑在待核对里陪着等。
        // 那些行各自回到已核对，按计划合成本息一张卡；剩下这几笔仍由用户选归属。
        const pending = (installmentGroups.get(signature) || [event])
          .filter((member) => (member.reasonCodes || []).includes(INSTALLMENT_ATTRIBUTION_REASON))
        ;(pending.length ? pending : [event]).forEach((member) => pushSubject(member, descriptor.memberRole))
      } else pushSubject(event, descriptor.memberRole)
      ;(relationsByEvent.get(event.eventId) || []).filter((relation) => (
        currentClassification.primaryReason === 'bank_channel_same_event_candidate' ? false :
        currentClassification.issueType === 'refund_relation'
          ? relation.relationType === RELATION_TYPE.REFUND_OF && ![RELATION_STATUS.REJECTED, RELATION_STATUS.UNDONE].includes(relation.status)
          : ['same_event', 'transfer_accounts'].includes(currentClassification.issueType) && relation.status === RELATION_STATUS.PROPOSED
      ))
        .forEach((relation) => {
          if (!bucket.relationIds.has(relation.relationId)) {
            bucket.relationIds.add(relation.relationId)
            bucket.relations.push(relation)
          }
        })
      buckets.set(key, bucket)
    })
  })

  // 整组分期事项不能挂在 classification 上：分期行只要还缺账户，organizer-model 就会先把它判成
  // account_mapping（primaryReason=ledger_account_required），上面那条 installment 分支因此永远不进，
  // 事项就建不出来。这里改按「本期次确实有判不出归属的费用行」独立判定，与 applyInstallmentAttribution 同源。
  // 成员只收这些待归属的费用：本金不需要人核对，已归好的费用也已经定了，它们照常进已核对。
  installmentGroups.forEach((groupMembers, groupKey) => {
    const pending = groupMembers.filter((member) => (member.reasonCodes || []).includes(INSTALLMENT_ATTRIBUTION_REASON))
    if (!pending.length) return
    const classification = { issueType: REVIEW_ISSUE_TYPE.INSTALLMENT_ORIGIN, primaryReason: INSTALLMENT_ATTRIBUTION_REASON }
    const key = digestParts(REVIEW_ISSUE_VERSION, updateId, classification.issueType, groupKey)
    const bucket = buckets.get(key) || { key, classification, subjects: [], relations: [], subjectKeys: new Set(), relationIds: new Set() }
    pending.forEach((member) => {
      const subjectKey = member.eventId + ':subject'
      if (bucket.subjectKeys.has(subjectKey)) return
      bucket.subjectKeys.add(subjectKey)
      bucket.subjects.push({ event: member, memberRole: 'subject' })
    })
    buckets.set(key, bucket)
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
    if (bucket.classification.primaryReason === 'bank_channel_same_event_candidate') {
      bucket.subjects.sort((left, right) => Number(right.event.sourceType !== 'bank') - Number(left.event.sourceType !== 'bank') ||
        left.event.eventKey.localeCompare(right.event.eventKey))
    }
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
// 「仅本次不计入」同理：它只影响本批事件，不留任何可复用规则，但已决的
// 排除结果必须照样重建为已解决的账户项——否则重新整理会因为缺少账户而
// 退回待核对，同一支付方式每次恢复都要求用户重新选一次。
// 「仅本次不计入」的事件保留了来源账户（只是被排除），所以这里只能看状态
// 与原因码，不能要求账户为空。
function excludedThisImport(event) {
  if (event.status !== EVENT_STATUS.EXCLUDED) return false
  const reasons = event.reasonCodes || []
  return reasons.includes('account_mapping_excluded') && reasons.includes('manual_exclusion') &&
    !reasons.includes('source_account_ignored_default')
}

// 付款方式里有多个资金成分时，账户步骤的单元是“每个账户”，不是“这笔事件”。
// 成分引用属于来源事实，先固化成事件上的一份引用：账户事项、金额分摊、重新整理
// 读的是同一份，不再靠整理之后再补一次分组，也就不存在“重排后分组没了”的中间态。
function applyPaymentAccountReferences(events, rowsByEvent, mappingIndex) {
  events.forEach((event, index) => {
    const eventIndex = require('./account-mapping-policy').indexForEvent(mappingIndex, event)
    if (![EVENT_STATUS.READY, EVENT_STATUS.NEEDS_ACTION].includes(event.status)) return
    const references = referencesForRows(rowsByEvent.get(event.eventId) || [])
    if (!references.length) return
    const next = { ...event, fieldSources: { ...event.fieldSources,
      paymentAccountReferences: references, paymentAccountGroupsVersion: ACCOUNT_GROUPS_VERSION } }
    // 已发布的历史映射和本批草稿按成分键直接落到事件上：账户步骤只显示还需要确认的成分。
    const accounts = new Map((event.fieldSources.paymentAccounts || []).map((item) => [item.componentIndex, item]))
    references.forEach((reference) => {
      const accountId = accountIdFromIndex(eventIndex, reference)
      if (!accountId) return
      // 还款目标与付款成分使用同一份映射。只把事项标成已确认却漏写目标账户，
      // 会使快照出现“已解决但没有账户”的矛盾，页面曾把它误显示为不计入。
      if (reference.memberRole === 'payment_target') next.counterpartyLedgerAccountId = accountId
      else if (reference.memberRole && reference.memberRole.startsWith('payment_component_')) {
        accounts.set(reference.componentIndex, { componentIndex: reference.componentIndex, accountId })
      }
    })
    if (accounts.size) next.fieldSources.paymentAccounts = [...accounts.values()]
      .sort((left, right) => left.componentIndex - right.componentIndex)
    events[index] = next
  })
}

// 账户事项的唯一来源：每个账户引用一条。已确定账户的是已解决记录，没有账户的是
// 待确认；历史映射、本批决定、来源成分引用都在同一个循环里收敛，不再分两处实现。
function buildAccountIssues(updateId, events, rowsByEvent, effectiveMappings, idFactory) {
  const confirmedKeys = new Map((effectiveMappings || []).filter((mapping) => (
    mapping.mappingAction === 'account' && mapping.accountId
  )).map((mapping) => [(mapping.eventId || '') + ':' + paymentReferenceKey(mapping), mapping.accountId]))
  const groups = new Map()
  ;(events || []).forEach((event) => {
    const projection = event.fieldSources && event.fieldSources.fundsProjection
    // 已排除、已入账的事件不需要账户：成分引用只在仍要入账的事件上成组。
    const componentReferences = [EVENT_STATUS.READY, EVENT_STATUS.NEEDS_ACTION].includes(event.status)
      ? referencesForRows(rowsByEvent.get(event.eventId) || []) : []
    // 组合付款的每个成分、还款目标各自成组：账户还没确定也先立一条待确认。
    const candidates = componentReferences.length
      ? componentReferences.map((reference) => ({ reference, memberRole: reference.memberRole,
          accountId: mappedAccount(event, reference), required: true }))
      : projection
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
      // 本次排除的事件可能仍带着来源账户，所以排除判定只看状态与原因码；
      // 它们只用来把同一支付方式的排除组认出来，不会写成已确认账户。
      const current = excludedThisImport(event)
      const historical = event.reasonCodes.includes('source_account_ignored_default') && !candidate.accountId
      const ignored = current || historical
      const actual = require('./account-issue-grouping').memberDecision(event, { memberRole: candidate.memberRole }, reference)
      const external = actual.kind === 'external'
      const confirmedAccountId = confirmedKeys.get(event.eventId + ':' + paymentReferenceKey(reference)) ||
        confirmedKeys.get(':' + paymentReferenceKey(reference))
      // 已确认必须以事件实际写入的账户为准，不能用映射索引中的值掩盖漏写。
      const accountId = actual.accountId || null
      // 单账户的老路径只在“已确认或已忽略”时成组；成分引用是账户步骤的正式单元，
      // 还没有账户也要立组，否则组合付款又会退回一条合并的待核对。
      if (!candidate.required && !ignored && !external && (!confirmedAccountId || confirmedAccountId !== accountId)) return
      const identityKey = accountIdentityKeyForReference(reference) || paymentReferenceKey(reference)
      const pending = !ignored && !external && !accountId
      // 「仅本次不计入」只是这次排除，不是账户决定，不能和同一支付方式的
      // 已确认账户并进一组，否则会把排除改成记入。
      const key = external ? `${identityKey}:external` : current ? `${identityKey}:excluded`
        : ignored ? `${identityKey}:ignore`
        : pending ? `${identityKey}:pending` : `${identityKey}:${accountId}`
      const group = groups.get(key) || { ignored: false, current: false, pending: false, items: [], memberKeys: new Set() }
      group.ignored = group.ignored || ignored
      group.current = group.current || current
      group.pending = group.pending || pending
      const memberKey = `${event.eventId}:${candidate.memberRole}`
      if (!group.memberKeys.has(memberKey)) {
        group.memberKeys.add(memberKey)
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
      status: group.pending ? 'open' : 'resolved',
      version: 1,
      blocking: group.pending,
      primaryReasonCode: group.current
        ? 'payment_reference_excluded_this_import'
        : group.ignored
          ? 'payment_reference_ignored_by_history'
          : group.pending ? 'payment_reference_mapping_required'
          : projected ? 'payment_reference_mapping_confirmed' : 'account_mapping_confirmed',
      memberCount: new Set(group.items.map(item => item.event.eventId)).size,
      candidateCount: 0,
      ruleVersion: REVIEW_ISSUE_VERSION,
      // 本次排除与长期忽略的原因码分开：前者不进入以后导入的自动排除，只
      // 让账户步骤显示“本次不计入”并可改回。
      reasonCodes: group.current ? ['account_mapping_excluded']
        : group.ignored ? ['source_account_ignored_default']
        : group.pending ? ['payment_reference_mapping_required'] : ['account_mapping_confirmed']
    })
    group.items.forEach(({ event, memberRole }, index) => members.push({
      memberId: idFactory(), updateId, issueId, objectType: 'event', objectId: event.eventId,
      objectVersion: event.version, memberRole, sortOrder: index
    }))
  })
  return { issues, members }
}

function buildOrganizePlan({ updateId, rows, paymentMappings = [], accounts = [], idFactory }) {
  // 放款对先于分组：一组来源事实（同卡同日同额的两行现金分期放款）决定这两行各自的性质，
  // 识别后放款行是借款、对行不产生资金流，后面的分组、配对和问题分类都按来源事实走。
  const validRows = applyInstallmentDisbursements(rows.filter((row) => row.parseState === 'valid')
    .map((row) => ({ ...row, semantic: getRowSemantic(row) })))
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
  const drafts = require('./account-draft-binding'), draftIndex = drafts.lookup(compatibleMappings)
  const mappingResolution = resolveAccountMappings({ references, mappings: draftIndex.common, accounts })
  const effectiveMappings = mappingResolution.mappings
  const visibleMappingResolution = resolveAccountMappings({
    references,
    mappings: draftIndex.common,
    accounts
  })
  const mappingIndex = createMappingIndex(effectiveMappings, { accounts })
  const grouped = groupEvidence(validRows)
  const events = []
  const evidence = []
  grouped.forEach((group) => {
    const groupReferences = accountReferences(group)
    const decisions = drafts.forMembers(draftIndex, group.map(row => row.rowId), groupReferences)
    const scoped = decisions.length ? resolveAccountMappings({ references: groupReferences,
      mappings: draftIndex.common.concat(decisions), accounts }) : mappingResolution
    const eventIndex = decisions.length ? createMappingIndex(scoped.mappings, { accounts }) : mappingIndex
    const planned = representativeEvent(updateId, group, idFactory, eventIndex, scoped, references)
    if (decisions.length) {
      mappingIndex.eventIndexes.set(planned.event.eventId, eventIndex)
      visibleMappingResolution.mappings.push(...scoped.mappings.map(mapping => ({ ...mapping, eventId: planned.event.eventId })))
    }
    events.push(planned.event)
    evidence.push(...planned.evidence)
  })
  // 账户引用先于问题分类：组合付款的事件一旦带上成分引用，账户归属就由每个
  // 账户各自的待确认事项承接，不再产生一条合并的“组合支付”待核对。
  const rowsByEvent = new Map()
  const rowById = new Map(validRows.map((row) => [row.rowId, row]))
  evidence.forEach((link) => {
    const row = rowById.get(link.rowId)
    if (!row || !link.eventId) return
    if (!rowsByEvent.has(link.eventId)) rowsByEvent.set(link.eventId, [])
    rowsByEvent.get(link.eventId).push(row)
  })
  applyPaymentAccountReferences(events, rowsByEvent, mappingIndex)
  const candidateGroups = sameEventCandidateGroups(events)
  const relations = buildRelations(updateId, events, idFactory)
  applyInstallmentAttribution(events)
  const review = buildReviewIssues(updateId, events, relations, candidateGroups, idFactory)
  // 所有实际生效的账户归属都必须在账户步骤可见、可修改；不能因为来自
  // 历史映射就在界面中隐藏，否则错误映射会静默进入后续整理。
  const confirmedAccounts = buildAccountIssues(updateId, events, rowsByEvent, visibleMappingResolution.mappings, idFactory)
  const accountGroups = coalesceAccountIssues(events, review.issues.concat(confirmedAccounts.issues),
    review.members.concat(confirmedAccounts.members), idFactory)
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
    issues: accountGroups.issues,
    members: accountGroups.members,
    counts
  }
}

module.exports = {
  EVENT_KEY_VERSION,
  PLAN_VERSION,
  RELATION_KEY_VERSION,
  REVIEW_ISSUE_VERSION,
  buildOrganizePlan,
  accountReferences,
  applyInstallmentAttribution,
  applyPaymentAccountReferences,
  buildAccountIssues,
  buildReviewIssues,
  installmentGroupMembers,
  compatibleHistoricalMappings,
  compatibleCore,
  inferExactAccountMappings,
  normalizedText,
  stableReferences
}
