const { eventAllocation, allocationAccountsValid } = require('./funds-allocation')
const accountGroups = require('./payment-account-groups')
const { inspectPaymentAccounts, paymentEvidenceFields, inspectPaymentResolution, paymentResolutionForEvent } = require('./payment-resolution')
const { synchronizeDraftReachability } = require('./account-draft')
const { randomUUID } = require('node:crypto')

const { digestParts } = require('./digest')
const { REVIEW_ISSUE_VERSION } = require('./domain-versions')
const { importError } = require('./errors')
const { stageAccountDraft, stageRepaymentAllocationDrafts } = require('./account-draft')
const {
  getUpdateView,
  insertAction,
  parseJson,
  publicIssue,
  selectIssues,
  selectPlanningRows,
  selectPaymentMappings,
  selectUpdate
} = require('./finance-update-repository')
const { executeIdempotentMutation, executeUserRead } = require('./import-transaction')
const {
  ECONOMIC_NATURE,
  EVENT_STATUS,
  FLOW_DIRECTION,
  REFUND_RELATION_STATE_VERSION,
  RELATION_STATUS,
  REVIEW_ISSUE_TYPE,
  REVIEW_DECISIONS,
  classifyReviewIssue,
  evaluatePostability,
  needsCategory,
  unique
} = require('./organizer-model')
const { validateUuid, validateVersion } = require('./validation')
const { createMappingIndex, reconcileProjectedAccounts } = require('./source-funds')
const { paymentReferenceKey } = require('./payment-account')
const {
  REPAYMENT_ALLOCATION_VERSION,
  inspectRepaymentAllocations,
  isAggregateRepayment,
  repaymentAllocationsForEvent
} = require('./repayment-allocation')

const FIELD_MASK = Object.freeze({
  ledgerAccountId: 1 << 0,
  counterpartyLedgerAccountId: 1 << 1,
  flowDirection: 1 << 2,
  economicNature: 1 << 3,
  occurredLocalAt: 1 << 4,
  amountMinor: 1 << 5,
  currency: 1 << 6,
  categoryId: 1 << 7,
  repaymentAllocations: 1 << 8,
  paymentResolution: 1 << 9,
  paymentAccounts: 1 << 10
})

const ISSUE_RESOLVED_REASONS = Object.freeze({
  account_mapping: new Set([
    'ledger_account_required', 'core_fields_missing',
    'payment_reference_mapping_required'
  ]),
  category_assignment: new Set(['category_required']),
  shared_fields: new Set(['core_fields_missing', 'economic_nature_required', 'postability_direction_conflict']),
  same_event: new Set(['same_event_candidate', 'relation_ambiguous']),
  refund_relation: new Set(['refund_relation_required', 'refund_relation_ambiguous', 'refund_relation_invalid', 'refund_amount_exceeded', 'relation_ambiguous']),
  transfer_accounts: new Set([
    'transfer_account_required', 'repayment_account_required', 'borrow_account_required', 'relation_ambiguous',
    'repayment_allocation_required', 'repayment_allocation_invalid',
    'repayment_allocation_amount_mismatch', 'repayment_allocation_account_duplicate',
    'repayment_allocation_target_not_allowed'
  ]),
  identity_conflict: new Set(['identity_conflict', 'identity_review_required']),
  field_conflict: new Set(['core_fields_conflict']),
  installment_origin: new Set(['installment_origin_required', 'installment_composition_required', 'economic_nature_required', 'core_fields_missing'])
})

function validateDecision(value) {
  if (!REVIEW_DECISIONS.has(value)) throw importError('VALIDATION_ERROR')
  return value
}

async function selectIssue(connection, uid, issueId, { forUpdate = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT issue_id AS issueId, update_id AS updateId, issue_key AS issueKey,
            issue_type AS issueType, status, version, blocking,
            primary_reason_code AS primaryReasonCode, member_count AS memberCount,
            candidate_count AS candidateCount, reason_codes_json AS reasonCodes
       FROM catledger_review_issues
      WHERE uid = ? AND issue_id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, issueId]
  )
  if (!rows[0]) throw importError('NOT_FOUND')
  return rows[0]
}

async function selectMembers(connection, uid, issueId) {
  const [rows] = await connection.execute(
    `SELECT member_id AS memberId, update_id AS updateId, issue_id AS issueId,
            object_type AS objectType, object_id AS objectId,
            object_version AS objectVersion, member_role AS memberRole,
            sort_order AS sortOrder
       FROM catledger_review_issue_members
      WHERE uid = ? AND issue_id = ? ORDER BY sort_order, member_id`,
    [uid, issueId]
  )
  return rows.map((row) => ({ ...row, objectVersion: Number(row.objectVersion), sortOrder: Number(row.sortOrder) }))
}

function domainEvent(row) {
  return {
    eventId: row.eventId,
    updateId: row.updateId,
    status: row.status,
    version: Number(row.version),
    flowDirection: row.flowDirection,
    economicNature: row.economicNature,
    ledgerAccountId: row.ledgerAccountId || null,
    counterpartyLedgerAccountId: row.counterpartyLedgerAccountId || null,
    localDate: row.localDate,
    localAt: row.localAt,
    utcAt: row.utcAt,
    timezoneOffsetMinutes: row.timezoneOffsetMinutes == null ? null : Number(row.timezoneOffsetMinutes),
    amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
    currency: row.currency,
    categoryId: row.categoryId || null,
    manualFieldMask: Number(row.manualFieldMask),
    fieldSources: parseJson(row.fieldSources, {}),
    reasonCodes: parseJson(row.reasonCodes, [])
  }
}

async function selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate = false } = {}) {
  if (eventIds.length === 0) return []
  const [rows] = await connection.execute(
    `SELECT event_id AS eventId, update_id AS updateId, status, version,
            flow_direction AS flowDirection, economic_nature AS economicNature,
            ledger_account_id AS ledgerAccountId,
            counterparty_ledger_account_id AS counterpartyLedgerAccountId,
            event_local_date AS localDate, event_local_at AS localAt, event_utc_at AS utcAt,
            timezone_offset_minutes AS timezoneOffsetMinutes, amount_minor AS amountMinor,
            currency, category_id AS categoryId, manual_field_mask AS manualFieldMask,
            field_sources_json AS fieldSources, reason_codes_json AS reasonCodes
       FROM catledger_economic_events
      WHERE uid = ? AND update_id = ? AND event_id IN (${eventIds.map(() => '?').join(', ')})
      ORDER BY event_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, updateId, ...eventIds]
  )
  const events = rows.map(domainEvent)
  const legacy = events.filter((event) => (event.fieldSources.semanticBlockers || []).includes('payment_components_ambiguous') &&
    !Object.prototype.hasOwnProperty.call(event.fieldSources, 'paymentComponents'))
  if (legacy.length) {
    const [evidence] = await connection.execute(`SELECT e.event_id AS eventId, r.normalized_direction AS direction, r.semantic_json AS semantic
      FROM catledger_event_evidence e JOIN catledger_import_rows r ON r.uid = e.uid AND r.row_id = e.row_id
      WHERE e.uid = ? AND e.update_id = ? AND e.event_id IN (${legacy.map(() => '?').join(', ')}) AND e.evidence_role <> 'discarded'
      ORDER BY e.event_id, r.row_id`, [uid, updateId, ...legacy.map((event) => event.eventId)])
    for (const event of legacy) event.fieldSources = { ...event.fieldSources, ...paymentEvidenceFields(evidence.filter((row) => row.eventId === event.eventId)
      .map((row) => ({ direction: row.direction, semantic: parseJson(row.semantic, {}) }))) }
  }
  return events
}

async function eventContext(connection, uid, updateId, eventId) {
  const [relations] = await connection.execute(
    `SELECT relation_id AS relationId, relation_type AS relationType, status,
            source_event_id AS sourceEventId, target_event_id AS targetEventId,
            amount_minor AS amountMinor, currency
       FROM catledger_economic_event_relations
      WHERE uid = ? AND update_id = ? AND (source_event_id = ? OR target_event_id = ?)`,
    [uid, updateId, eventId, eventId]
  )
  const [transactionLinks] = await connection.execute(
    `SELECT event_id AS eventId, transaction_id AS transactionId, role
       FROM catledger_economic_event_transactions
      WHERE uid = ? AND update_id = ? AND event_id = ?`,
    [uid, updateId, eventId]
  )
  return { relations, transactionLinks }
}

async function validateEventReferences(connection, uid, event) {
  const fieldSources = event && event.fieldSources || {}
  const plan = eventAllocation(event)
  if (plan.kind === 'conflict') throw importError('VALIDATION_ERROR')
  const hasAllocationDraft = Object.prototype.hasOwnProperty.call(fieldSources, 'repaymentAllocationVersion') ||
    Object.prototype.hasOwnProperty.call(fieldSources, 'repaymentAllocations')
  const allocation = isAggregateRepayment(event) && hasAllocationDraft ? repaymentAllocationsForEvent(event) : null
  if (allocation && !allocation.valid) throw importError('VALIDATION_ERROR')
  if (allocation && allocation.allocations.some((item) => item.accountId === event.ledgerAccountId)) {
    throw importError('VALIDATION_ERROR')
  }
  const payment = event.fieldSources && event.fieldSources.paymentResolution ? paymentResolutionForEvent(event) : null
  if (payment && !payment.valid) throw importError('VALIDATION_ERROR')
  const paymentAccounts = fieldSources.paymentAccounts ? inspectPaymentAccounts(event, fieldSources.paymentAccounts, { partial: true }) : null
  if (paymentAccounts && !paymentAccounts.valid) throw importError('VALIDATION_ERROR')
  const accountIds = unique([
    ...(paymentAccounts ? paymentAccounts.accounts.map((item) => item.accountId) : []),
    ...(payment ? payment.resolution.allocations.map((item) => item.accountId) : []),
    event.ledgerAccountId,
    event.counterpartyLedgerAccountId,
    ...(allocation ? allocation.allocations.map((item) => item.accountId) : [])
  ])
  if (accountIds.length > 0) {
    const [accounts] = await connection.execute(
      `SELECT account_id AS accountId, type, currency, archived_at AS archivedAt
         FROM catledger_accounts
        WHERE uid = ? AND account_id IN (${accountIds.map(() => '?').join(', ')}) FOR UPDATE`,
      [uid, ...accountIds]
    )
    if (accounts.some((account) => account.archivedAt != null || account.currency !== event.currency)) {
      throw importError('VALIDATION_ERROR')
    }
    const existingIds = new Set(accounts.map((account) => account.accountId))
    const draftIds = accountIds.filter((accountId) => !existingIds.has(accountId))
    if (draftIds.length > 0) {
      const [drafts] = await connection.execute(
        `SELECT draft_account_id AS accountId, type, currency
           FROM catledger_finance_update_account_drafts
          WHERE uid = ? AND update_id = ?
            AND draft_account_id IN (${draftIds.map(() => '?').join(', ')}) FOR UPDATE`,
        [uid, event.updateId, ...draftIds]
      )
      if (drafts.length !== draftIds.length || drafts.some((draft) => draft.currency !== event.currency)) {
        throw importError('VALIDATION_ERROR')
      }
      drafts.forEach((draft) => accounts.push(draft))
    }
    if (plan.valid && !allocationAccountsValid(event, plan, new Map(accounts.map((account) => [account.accountId, account])))) throw importError('VALIDATION_ERROR')
    if (event.counterpartyLedgerAccountId && (fieldSources.paymentAccountReferences || []).some((ref) => ref.memberRole === 'payment_target')) {
      const target = accounts.find((account) => account.accountId === event.counterpartyLedgerAccountId)
      if (!target || !['credit', 'other_liability'].includes(target.type)) throw importError('VALIDATION_ERROR')
    }
  }
  if (event.categoryId) {
    const [categories] = await connection.execute(
      `SELECT kind FROM catledger_categories
        WHERE uid = ? AND category_id = ? AND archived_at IS NULL LIMIT 1`,
      [uid, event.categoryId]
    )
    const expectedKind = event.economicNature === ECONOMIC_NATURE.INCOME ? 'income' : 'expense'
    if (!categories[0] || !['income', 'expense', 'fee'].includes(event.economicNature) || categories[0].kind !== expectedKind) {
      throw importError('VALIDATION_ERROR')
    }
  }
}

function resolvedReasons(issueType, reasons) {
  const removable = ISSUE_RESOLVED_REASONS[issueType] || new Set()
  return unique(reasons.filter((reason) => reason !== 'blocking_issue_open' && !removable.has(reason)))
}

function validateOptionalUuid(value) {
  return value == null || value === '' ? null : validateUuid(value)
}

function applyFields(event, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw importError('VALIDATION_ERROR')
  if (Object.prototype.hasOwnProperty.call(fields, 'paymentAccounts')) {
    const result = inspectPaymentAccounts(event, fields.paymentAccounts)
    if (Object.keys(fields).length !== 1 || !result.valid || event.fieldSources.paymentResolution) throw importError('VALIDATION_ERROR')
    return { ...event, fieldSources: { ...event.fieldSources, paymentAccounts: result.accounts },
      manualFieldMask: (event.manualFieldMask || 0) | FIELD_MASK.paymentAccounts }
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'paymentResolution')) {
    if (Object.keys(fields).length !== 1) throw importError('VALIDATION_ERROR')
    const result = inspectPaymentResolution(event, fields.paymentResolution)
    if (!result.valid) throw importError('VALIDATION_ERROR')
    const value = result.resolution
    return { ...event, ledgerAccountId: result.allocations[0].accountId, counterpartyLedgerAccountId: value.targetAccountId,
      economicNature: value.nature, flowDirection: value.nature === 'expense' ? 'outflow' : 'neutral',
      categoryId: value.nature === 'expense' ? event.categoryId : null,
      manualFieldMask: (event.manualFieldMask || 0) | FIELD_MASK.paymentResolution | FIELD_MASK.ledgerAccountId |
        FIELD_MASK.counterpartyLedgerAccountId | FIELD_MASK.economicNature | FIELD_MASK.flowDirection,
      fieldSources: { ...event.fieldSources, paymentResolution: value } }
  }
  let mask = 0
  const next = { ...event }
  for (const key of Object.keys(fields)) {
    if (key === 'timezoneOffsetMinutes') continue
    if (!Object.prototype.hasOwnProperty.call(FIELD_MASK, key)) throw importError('VALIDATION_ERROR')
    mask |= FIELD_MASK[key]
    if (key === 'ledgerAccountId' || key === 'counterpartyLedgerAccountId' || key === 'categoryId') {
      next[key] = validateOptionalUuid(fields[key])
    } else if (key === 'flowDirection') {
      if (!Object.values(FLOW_DIRECTION).includes(fields[key])) throw importError('VALIDATION_ERROR')
      next[key] = fields[key]
    } else if (key === 'economicNature') {
      if (!Object.values(ECONOMIC_NATURE).includes(fields[key])) throw importError('VALIDATION_ERROR')
      next[key] = fields[key]
    } else if (key === 'amountMinor') {
      if (typeof fields[key] !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(fields[key])) throw importError('VALIDATION_ERROR')
      next[key] = fields[key]
    } else if (key === 'currency') {
      if (fields[key] !== 'CNY') throw importError('VALIDATION_ERROR')
      next[key] = fields[key]
    } else if (key === 'occurredLocalAt') {
      if (typeof fields[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(fields[key])) {
        throw importError('VALIDATION_ERROR')
      }
      if (!Number.isInteger(fields.timezoneOffsetMinutes) || fields.timezoneOffsetMinutes < -840 || fields.timezoneOffsetMinutes > 840) {
        throw importError('VALIDATION_ERROR')
      }
      const normalized = fields[key].replace('T', ' ').replace(/\.\d{3}$/, '') + '.000'
      const localEpoch = Date.parse(normalized.replace(' ', 'T') + 'Z')
      if (!Number.isFinite(localEpoch)) throw importError('VALIDATION_ERROR')
      next.localAt = normalized
      next.localDate = normalized.slice(0, 10)
      next.timezoneOffsetMinutes = fields.timezoneOffsetMinutes
      next.utcAt = new Date(localEpoch + fields.timezoneOffsetMinutes * 60_000).toISOString().replace('T', ' ').replace('Z', '')
    } else if (key === 'repaymentAllocations') {
      if (!isAggregateRepayment(next)) throw importError('VALIDATION_ERROR')
      const allocation = inspectRepaymentAllocations(fields[key], next.amountMinor)
      if (!allocation.valid) throw importError('VALIDATION_ERROR')
      next.counterpartyLedgerAccountId = null
      next.fieldSources = {
        ...(next.fieldSources || {}),
        repaymentAllocationVersion: REPAYMENT_ALLOCATION_VERSION,
        repaymentAllocations: allocation.allocations
      }
    }
  }
  if (mask === 0) throw importError('VALIDATION_ERROR')
  next.manualFieldMask |= mask
  return next
}

async function saveEvent(connection, uid, current, next, actionId, { preserveReferences = false, actionSource = 'user' } = {}) {
  if (preserveReferences) {
    const sameReferences = ['ledgerAccountId', 'counterpartyLedgerAccountId', 'currency', 'categoryId'].every(key => current[key] === next[key]) &&
      ['paymentAccounts', 'paymentResolution', 'repaymentAllocations'].every(key =>
        JSON.stringify(current.fieldSources && current.fieldSources[key]) === JSON.stringify(next.fieldSources && next.fieldSources[key]))
    if (!sameReferences) throw importError('CONFLICT')
  } else await validateEventReferences(connection, uid, next)
  const context = await eventContext(connection, uid, next.updateId, next.eventId)
  const evaluated = evaluatePostability(next, context)
  next.status = evaluated.status
  next.reasonCodes = unique([...resolvedReasons(next.resolvingIssueType, next.reasonCodes), ...evaluated.reasonCodes])
  next.version = current.version + 1
  next.fieldSources = { ...(next.fieldSources || {}),
    [actionSource === 'semantic' ? 'lastSemanticActionId' : 'lastUserActionId']: actionId }
  const [result] = await connection.execute(
    `UPDATE catledger_economic_events
        SET state = ?, status = ?, flow_direction = ?, economic_nature = ?,
            ledger_account_id = ?, counterparty_ledger_account_id = ?,
            event_local_date = ?, event_local_at = ?, event_utc_at = ?,
            timezone_offset_minutes = ?, amount_minor = ?, currency = ?, category_id = ?,
            manual_field_mask = ?, field_sources_json = ?, reason_codes_json = ?, version = ?
      WHERE uid = ? AND event_id = ? AND update_id = ? AND version = ?`,
    [
      next.status, next.status, next.flowDirection, next.economicNature,
      next.ledgerAccountId, next.counterpartyLedgerAccountId, next.localDate, next.localAt,
      next.utcAt, next.timezoneOffsetMinutes, next.amountMinor, next.currency, next.categoryId,
      next.manualFieldMask, JSON.stringify(next.fieldSources), JSON.stringify(next.reasonCodes),
      next.version, uid, next.eventId, next.updateId, current.version
    ]
  )
  if (result.affectedRows !== 1) throw importError('CONFLICT')
  return next
}

async function stageAccountMappings(
  connection, uid, updateId, eventIds, accountId, actionId,
  mappingAction = 'account', mappingIndex = null
) {
  if (eventIds.length === 0) return []
  if (!['account', 'ignore'].includes(mappingAction)) throw importError('VALIDATION_ERROR')
  if ((mappingAction === 'account') !== Boolean(accountId)) throw importError('VALIDATION_ERROR')
  const [rows] = await connection.execute(
    `SELECT DISTINCT ee.event_id AS eventId,
            s.source_type_snapshot AS sourceType,
            r.payment_method_key AS paymentMethodKey,
            r.payment_method_raw AS paymentMethod
       FROM catledger_event_evidence ee
       JOIN catledger_import_rows r ON r.uid = ee.uid AND r.row_id = ee.row_id
       JOIN catledger_finance_update_sources s
         ON s.uid = ee.uid AND s.update_id = ee.update_id AND s.batch_id = r.batch_id
      WHERE ee.uid = ? AND ee.update_id = ?
        AND ee.event_id IN (${eventIds.map(() => '?').join(', ')})
        AND ee.evidence_role <> 'discarded' AND r.payment_method_key IS NOT NULL`,
    [uid, updateId, ...eventIds]
  )
  if (mappingAction === 'ignore' && rows.length === 0) throw importError('VALIDATION_ERROR')
  for (const row of rows) {
    await connection.execute(
      `INSERT INTO catledger_finance_update_account_mapping_drafts
         (uid, draft_mapping_id, update_id, event_id, source_type,
          payment_method_key, payment_method_hint, mapping_action, account_id, action_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint),
         mapping_action = VALUES(mapping_action), account_id = VALUES(account_id),
         action_id = VALUES(action_id)`,
      [uid, randomUUID(), updateId, row.eventId, row.sourceType, row.paymentMethodKey,
        String(row.paymentMethod || '').slice(0, 128), mappingAction, accountId, actionId]
    )
  }
  const paymentReferenceKeys = unique(rows.map(paymentReferenceKey))
  if (mappingIndex) {
    for (const key of paymentReferenceKeys) mappingIndex.set(key, mappingAction === 'account' ? accountId : null)
  }
  return paymentReferenceKeys
}

function mappingReferenceForMember(event, memberRole) {
  const grouped = accountGroups.referenceForRole(event, memberRole)
  if (grouped) return grouped
  const projection = event && event.fieldSources && event.fieldSources.fundsProjection
  if (memberRole === 'mapping_from') return projection && projection.from || null
  if (memberRole === 'mapping_to') return projection && projection.to || null
  if (memberRole === 'subject') {
    return event && event.fieldSources && event.fieldSources.ledgerAccountReference || null
  }
  return null
}

function applyMappedAccount(event, memberRole, accountId, mappingIndex) {
  const reference = accountGroups.referenceForRole(event, memberRole)
  if (reference) {
    if (memberRole === 'payment_target') return applyFields(event, { counterpartyLedgerAccountId: accountId })
    const accounts = (event.fieldSources.paymentAccounts || []).filter((item) => item.componentIndex !== reference.componentIndex)
    accounts.push({ componentIndex: reference.componentIndex, accountId })
    return { ...event, manualFieldMask: event.manualFieldMask | FIELD_MASK.paymentAccounts,
      fieldSources: { ...event.fieldSources, paymentAccounts: accounts.sort((a, b) => a.componentIndex - b.componentIndex) } }
  }
  if (memberRole === 'subject') return applyFields(event, { ledgerAccountId: accountId })
  return reconcileProjectedAccounts(event, mappingIndex, {
    preserveFrom: Boolean(event.manualFieldMask & FIELD_MASK.ledgerAccountId),
    preserveTo: Boolean(event.manualFieldMask & FIELD_MASK.counterpartyLedgerAccountId)
  }).event
}

function accountMappingEventMembers(members) {
  return members.filter((member) => member.objectType === 'event' &&
    (['subject', 'mapping_from', 'mapping_to', 'payment_target'].includes(member.memberRole) || /^payment_component_\d+$/.test(member.memberRole)))
}

async function stagePaymentReferenceMapping(
  connection, uid, updateId, eventId, reference, accountId, actionId,
  mappingAction = 'account', mappingIndex = null
) {
  if (reference && reference.memberRole && !reference.paymentMethodKey) return ''
  if (!reference || !reference.sourceType || !reference.paymentMethodKey) throw importError('VALIDATION_ERROR')
  if (!['account', 'ignore'].includes(mappingAction)) throw importError('VALIDATION_ERROR')
  if ((mappingAction === 'account') !== Boolean(accountId)) throw importError('VALIDATION_ERROR')
  await connection.execute(
    `INSERT INTO catledger_finance_update_account_mapping_drafts
       (uid, draft_mapping_id, update_id, event_id, source_type,
        payment_method_key, payment_method_hint, mapping_action, account_id, action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint),
       mapping_action = VALUES(mapping_action), account_id = VALUES(account_id),
       action_id = VALUES(action_id)`,
    [uid, randomUUID(), updateId, eventId, reference.sourceType,
      reference.paymentMethodKey, String(reference.label || '').slice(0, 128),
      mappingAction, accountId, actionId]
  )
  const key = paymentReferenceKey(reference)
  if (mappingIndex) mappingIndex.set(key, mappingAction === 'account' ? accountId : null)
  return key
}

async function deletePaymentReferenceMapping(connection, uid, updateId, eventId, reference) {
  if (reference && reference.memberRole && !reference.paymentMethodKey) return ''
  if (!reference || !reference.sourceType || !reference.paymentMethodKey) throw importError('VALIDATION_ERROR')
  await connection.execute(
    `DELETE FROM catledger_finance_update_account_mapping_drafts
      WHERE uid = ? AND update_id = ? AND event_id = ?
        AND source_type = ? AND payment_method_key = ?`,
    [uid, updateId, eventId, reference.sourceType, reference.paymentMethodKey]
  )
}

async function updateAccountMappingMemberVersions(connection, uid, updateId, event) {
  await connection.execute(
    `UPDATE catledger_review_issue_members member
       JOIN catledger_review_issues issue
         ON issue.uid = member.uid AND issue.issue_id = member.issue_id
        SET member.object_version = ?
      WHERE member.uid = ? AND issue.update_id = ? AND member.object_type = 'event'
        AND member.object_id = ? AND ((issue.issue_type = 'account_mapping'
        AND issue.status IN ('open', 'resolved')) OR (? = 1 AND issue.status = 'open'))`,
    [event.version, uid, updateId, event.eventId, Boolean(event.fieldSources && event.fieldSources.paymentAccountReferences)]
  )
}

async function stageProjectedAccountMappings(connection, uid, updateId, events, actionId, mappingIndex = null) {
  const paymentReferences = []
  for (const event of events) {
    const projection = event.fieldSources && event.fieldSources.fundsProjection
    if (!projection) continue
    const sides = [
      { reference: projection.from, accountId: event.ledgerAccountId },
      { reference: projection.to, accountId: event.counterpartyLedgerAccountId }
    ]
    for (const side of sides) {
      if (!side.reference || !side.reference.paymentMethodKey || !side.accountId) continue
      await connection.execute(
        `INSERT INTO catledger_finance_update_account_mapping_drafts
           (uid, draft_mapping_id, update_id, event_id, source_type,
            payment_method_key, payment_method_hint, mapping_action, account_id, action_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'account', ?, ?)
         ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint),
           mapping_action = 'account', account_id = VALUES(account_id), action_id = VALUES(action_id)`,
        [uid, randomUUID(), updateId, event.eventId, side.reference.sourceType,
          side.reference.paymentMethodKey, String(side.reference.label || '').slice(0, 128),
          side.accountId, actionId]
      )
      const referenceKey = paymentReferenceKey(side.reference)
      paymentReferences.push(referenceKey)
      if (mappingIndex) mappingIndex.set(referenceKey, side.accountId)
    }
  }
  return unique(paymentReferences)
}

async function createFollowUpIssue(connection, uid, updateId, event) {
  if (event.status !== EVENT_STATUS.NEEDS_ACTION &&
      !(event.status === EVENT_STATUS.READY && needsCategory(event))) return
  const classification = classifyReviewIssue(event)
  const [[existing]] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM catledger_review_issues issue
       JOIN catledger_review_issue_members member
         ON member.uid = issue.uid AND member.issue_id = issue.issue_id
      WHERE issue.uid = ? AND issue.update_id = ? AND issue.status = 'open'
        AND (issue.blocking = 1 OR issue.issue_type = ?)
        AND member.object_type = 'event' AND member.object_id = ?`,
    [uid, updateId, classification.issueType, event.eventId]
  )
  if (Number(existing.count) > 0) return
  let candidateRelations = []
  if (classification.issueType === REVIEW_ISSUE_TYPE.REFUND_RELATION) {
    const [rows] = await connection.execute(
      `SELECT relation_id AS relationId, version
         FROM catledger_economic_event_relations
        WHERE uid = ? AND update_id = ? AND source_event_id = ?
          AND relation_type = 'refund_of' AND status = 'proposed'
        ORDER BY relation_id`,
      [uid, updateId, event.eventId]
    )
    candidateRelations = rows.map((row) => ({ ...row, version: Number(row.version) }))
  }
  const issueId = randomUUID()
  const issueKey = digestParts('review-follow-up-v2', updateId, event.eventId, event.version, classification.issueType)
  await connection.execute(
    `INSERT INTO catledger_review_issues
       (uid, issue_id, update_id, issue_key, issue_key_version, issue_type, status,
        version, blocking, primary_reason_code, member_count, candidate_count,
        rule_version, reason_codes_json)
     VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?,
             ?, ?)`,
    [uid, issueId, updateId, issueKey, REVIEW_ISSUE_VERSION, classification.issueType,
      classification.issueType !== REVIEW_ISSUE_TYPE.CATEGORY_ASSIGNMENT,
      classification.primaryReason, 1 + candidateRelations.length, candidateRelations.length,
      REVIEW_ISSUE_VERSION, JSON.stringify(event.reasonCodes)]
  )
  await connection.execute(
    `INSERT INTO catledger_review_issue_members
       (uid, member_id, update_id, issue_id, object_type, object_id,
        object_version, member_role, sort_order)
     VALUES (?, ?, ?, ?, 'event', ?, ?, 'subject', 0)`,
    [uid, randomUUID(), updateId, issueId, event.eventId, event.version]
  )
  for (let index = 0; index < candidateRelations.length; index += 1) {
    const relation = candidateRelations[index]
    await connection.execute(
      `INSERT INTO catledger_review_issue_members
         (uid, member_id, update_id, issue_id, object_type, object_id,
          object_version, member_role, sort_order)
       VALUES (?, ?, ?, ?, 'relation', ?, ?, 'candidate', ?)`,
      [uid, randomUUID(), updateId, issueId, relation.relationId, relation.version, index + 1]
    )
  }
}

function projectedPaymentReferenceKeys(fieldSources) {
  const projection = fieldSources && fieldSources.fundsProjection
  if (!projection) return []
  return unique([projection.from, projection.to].concat(projection.to && projection.to.candidates || [])
    .filter((reference) => reference && reference.sourceType && reference.paymentMethodKey)
    .map(paymentReferenceKey))
}

function isEventInProjectionRefreshScope(row, scope) {
  if (!scope) return true
  if (scope.eventIds.has(row.eventId)) return true
  return projectedPaymentReferenceKeys(parseJson(row.fieldSources, {}))
    .some((key) => scope.paymentReferenceKeys.has(key))
}

async function refreshProjectedEvents(connection, uid, updateId, actionId, scope = null) {
  const [rows] = await connection.execute(
    `SELECT event_id AS eventId, field_sources_json AS fieldSources
       FROM catledger_economic_events
      WHERE uid = ? AND update_id = ?
        AND status IN ('ready', 'needs_action')`,
    [uid, updateId]
  )
  const affectedEventIds = scope ? new Set(scope.eventIds || []) : null
  const changedReferenceKeys = scope ? new Set(scope.paymentReferenceKeys || []) : null
  const normalizedScope = scope
    ? { eventIds: affectedEventIds, paymentReferenceKeys: changedReferenceKeys }
    : null
  const eventIds = rows
    .filter((row) => isEventInProjectionRefreshScope(row, normalizedScope))
    .map((row) => row.eventId)
  const events = await selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate: true })
  const projected = events.filter((event) => event.fieldSources && event.fieldSources.fundsProjection)
  if (!projected.length) return []
  const mappingIndex = createMappingIndex(await selectPaymentMappings(connection, uid, updateId))
  const changed = []
  for (const event of projected) {
    const reconciled = reconcileProjectedAccounts(event, mappingIndex, {
      preserveFrom: Boolean(event.manualFieldMask & FIELD_MASK.ledgerAccountId),
      preserveTo: Boolean(event.manualFieldMask & FIELD_MASK.counterpartyLedgerAccountId)
    })
    if (!reconciled.changed) continue
    const next = { ...reconciled.event, resolvingIssueType: 'transfer_accounts' }
    await connection.execute(
      `UPDATE catledger_review_issues issue
       JOIN catledger_review_issue_members member
         ON member.uid = issue.uid AND member.issue_id = issue.issue_id
          SET issue.status = 'superseded', issue.blocking = 0,
              issue.version = issue.version + 1, issue.resolved_action_id = ?
        WHERE issue.uid = ? AND issue.update_id = ? AND issue.status = 'open'
          AND issue.issue_type <> 'account_mapping'
          AND member.object_type = 'event' AND member.object_id = ?`,
      [actionId, uid, updateId, event.eventId]
    )
    const saved = await saveEvent(connection, uid, event, next, actionId)
    changed.push(saved)
    await createFollowUpIssue(connection, uid, updateId, saved)
  }
  return changed
}

async function effectiveProjectedEvents(connection, uid, updateId, events) {
  if (!events.some((event) => event.fieldSources && event.fieldSources.fundsProjection)) return events
  const mappingIndex = createMappingIndex(await selectPaymentMappings(connection, uid, updateId))
  return effectiveProjectedEventsFromIndex(events, mappingIndex)
}

function effectiveProjectedEventsFromIndex(events, mappingIndex) {
  return events.map((event) => reconcileProjectedAccounts(event, mappingIndex, {
    preserveFrom: Boolean(event.manualFieldMask & FIELD_MASK.ledgerAccountId),
    preserveTo: Boolean(event.manualFieldMask & FIELD_MASK.counterpartyLedgerAccountId)
  }).event)
}

async function recalculateUpdateCounts(connection, uid, updateId, nextVersion, actionId, expectedVersion, duplicateEvidenceDelta = 0) {
  await synchronizeDraftReachability(connection, uid, updateId)
  const [[counts]] = await connection.execute(
    `SELECT COUNT(*) AS finalEventCount,
            SUM(status = 'ready') AS readyEventCount,
            SUM(status = 'needs_action') AS needsActionEventCount,
            SUM(status = 'excluded') AS excludedEventCount,
            SUM(status = 'posted') AS postedEventCount
       FROM catledger_economic_events WHERE uid = ? AND update_id = ?`,
    [uid, updateId]
  )
  const [result] = await connection.execute(
    `UPDATE catledger_finance_updates
        SET version = ?, current_action_id = ?, final_event_count = ?,
            ready_event_count = ?, needs_action_event_count = ?,
            excluded_event_count = ?, posted_event_count = ?,
            duplicate_evidence_count = duplicate_evidence_count + ?
      WHERE uid = ? AND update_id = ? AND version = ? AND status = 'review'`,
    [
      nextVersion, actionId, Number(counts.finalEventCount || 0), Number(counts.readyEventCount || 0),
      Number(counts.needsActionEventCount || 0), Number(counts.excludedEventCount || 0),
      Number(counts.postedEventCount || 0), duplicateEvidenceDelta, uid, updateId, expectedVersion
    ]
  )
  if (result.affectedRows !== 1) throw importError('CONFLICT')
}

async function issueDetails(connection, uid, issueId) {
  const issueRow = await selectIssue(connection, uid, issueId)
  const issue = publicIssue(issueRow)
  const members = await selectMembers(connection, uid, issueId)
  const view = await getUpdateView(connection, uid, issueRow.updateId, { includeOptions: true })
  const events = new Map(view.events.map((event) => [event.eventId, event]))
  const memberEventIds = members.filter((member) => member.objectType === 'event').map((member) => member.objectId)
  const effectiveEvents = await effectiveProjectedEvents(
    connection,
    uid,
    issueRow.updateId,
    await selectDomainEvents(connection, uid, issueRow.updateId, memberEventIds)
  )
  effectiveEvents.forEach((event) => {
    const current = events.get(event.eventId) || {}
    events.set(event.eventId, {
      ...current,
      ledgerAccountId: event.ledgerAccountId,
      counterpartyLedgerAccountId: event.counterpartyLedgerAccountId,
      paymentComponents: event.fieldSources.paymentComponents || [],
      paymentResolution: event.fieldSources.paymentResolution || null,
      paymentAccounts: event.fieldSources.paymentAccounts || null,
      fundsProjection: event.fieldSources && event.fieldSources.fundsProjection || current.fundsProjection || null,
      repaymentAllocations: event.fieldSources && event.fieldSources.repaymentAllocations || current.repaymentAllocations || []
    })
  })
  const [relations] = await connection.execute(
    `SELECT relation_id AS relationId, relation_type AS relationType, status, version,
            source_event_id AS sourceEventId, target_event_id AS targetEventId,
            amount_minor AS amountMinor, currency, reason_codes_json AS reasonCodes
       FROM catledger_economic_event_relations
      WHERE uid = ? AND update_id = ?`,
    [uid, issueRow.updateId]
  )
  const relationMap = new Map(relations.map((relation) => [relation.relationId, {
    ...relation,
    version: Number(relation.version),
    amountMinor: relation.amountMinor == null ? null : String(relation.amountMinor),
    reasonCodes: parseJson(relation.reasonCodes, []),
    targetEvent: events.get(relation.targetEventId) || null
  }]))
  const subjectMember = members.find((member) => member.objectType === 'event' && member.memberRole === 'subject') ||
    members.find((member) => member.objectType === 'event')
  const subjectEvent = subjectMember ? events.get(subjectMember.objectId) : null
  if (issue.subject && subjectEvent) {
    issue.subject = {
      ...issue.subject,
      ledgerAccountId: subjectEvent.ledgerAccountId,
      counterpartyLedgerAccountId: subjectEvent.counterpartyLedgerAccountId,
      fundsProjection: subjectEvent.fundsProjection || issue.subject.fundsProjection || null,
      paymentComponents: subjectEvent.paymentComponents || [],
      paymentResolution: subjectEvent.paymentResolution || null,
      paymentAccounts: subjectEvent.paymentAccounts || null,
      repaymentAllocations: subjectEvent.repaymentAllocations || issue.subject.repaymentAllocations || []
    }
    const projection = issue.subject.fundsProjection
    const missingReference = issue.issueType === 'transfer_accounts' && projection
      ? !issue.subject.ledgerAccountId ? projection.from
        : !issue.subject.counterpartyLedgerAccountId ? projection.to : null
      : null
    if (missingReference) {
      issue.accountContext = {
        ...(issue.accountContext || {}),
        label: missingReference.label,
        recognized: Boolean(missingReference.paymentMethodKey),
        sourceType: missingReference.sourceType || '',
        unresolvedReason: missingReference.unresolvedReason || ''
      }
    }
  }
  return {
    update: view.update,
    issue,
    members: members.map((member) => ({
      ...member,
      event: member.objectType === 'event' ? events.get(member.objectId) || null : null,
      relation: member.objectType === 'relation' ? relationMap.get(member.objectId) || null : null
    })),
    accounts: view.accounts,
    accountDrafts: view.accountDrafts,
    categories: view.categories
  }
}

function assertDecisionMatchesIssue(issue, decision) {
  if (decision === 'confirm_same' && issue.issueType !== 'same_event') throw importError('VALIDATION_ERROR')
  if (decision === 'confirm_distinct' && !['same_event', 'identity_conflict'].includes(issue.issueType)) throw importError('VALIDATION_ERROR')
  if (decision === 'link_refund' && issue.issueType !== 'refund_relation') throw importError('VALIDATION_ERROR')
  if (decision === 'mark_refund_pending' && issue.issueType !== 'refund_relation') throw importError('VALIDATION_ERROR')
  if (decision === 'confirm_installment_principal' && issue.issueType !== 'installment_origin') throw importError('VALIDATION_ERROR')
}

async function runAccountMappingBatch({ decisions, begin, applyDecision, finalize }) {
  const batch = await begin(decisions)
  for (const decision of batch.decisions || decisions) {
    await applyDecision(decision, batch)
  }
  return finalize(batch)
}

async function materializeAccountMappingFields(connection, uid, updateId, fields, actionId, revision = false) {
  let resolved = fields
  if (resolved && resolved.ledgerAccountDraft) {
    const draftAccountId = await stageAccountDraft(
      connection, uid, updateId, resolved.ledgerAccountDraft, actionId
    )
    resolved = revision
      ? { ledgerAccountId: draftAccountId }
      : { ...resolved, ledgerAccountId: draftAccountId }
    delete resolved.ledgerAccountDraft
  }
  if (!revision && resolved && resolved.counterpartyLedgerAccountDraft) {
    const draftAccountId = await stageAccountDraft(
      connection, uid, updateId, resolved.counterpartyLedgerAccountDraft, actionId
    )
    resolved = { ...resolved, counterpartyLedgerAccountId: draftAccountId }
    delete resolved.counterpartyLedgerAccountDraft
  }
  return resolved
}

async function materializeAccountMappingChoice(connection, uid, updateId, fields, actionId) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw importError('VALIDATION_ERROR')
  const draft = fields.mappingAccountDraft || fields.ledgerAccountDraft
  const accountId = draft
    ? await stageAccountDraft(connection, uid, updateId, draft, actionId)
    : fields.mappingAccountId || fields.ledgerAccountId
  return validateUuid(accountId)
}

async function resolveOpenAccountMapping(
  connection, uid, updateId, issue, decision, actionId, mappingIndex = null
) {
  if (decision.paymentRuleAction != null &&
      (decision.paymentRuleAction !== 'ignore' || decision.decision !== 'exclude_events')) {
    throw importError('VALIDATION_ERROR')
  }
  const members = await selectMembers(connection, uid, issue.issueId)
  const eventMembers = accountMappingEventMembers(members)
  const eventIds = eventMembers.map((member) => member.objectId)
  const storedEvents = await selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate: true })
  if (storedEvents.length !== eventIds.length || storedEvents.some((event) => {
    const member = eventMembers.find((item) => item.objectId === event.eventId)
    return !member || member.objectVersion !== event.version || ['posted', 'corrected'].includes(event.status)
  })) throw importError('CONFLICT')
  const events = mappingIndex
    ? effectiveProjectedEventsFromIndex(storedEvents, mappingIndex)
    : await effectiveProjectedEvents(connection, uid, updateId, storedEvents)
  const affected = []
  const paymentReferenceKeys = []

  if (decision.decision === 'apply_fields') {
    const accountId = await materializeAccountMappingChoice(
      connection, uid, updateId, decision.fields, actionId
    )
    for (const event of events) {
      const member = eventMembers.find((item) => item.objectId === event.eventId)
      const reference = mappingReferenceForMember(event, member && member.memberRole)
      let next
      if (reference) {
        paymentReferenceKeys.push(await stagePaymentReferenceMapping(
          connection, uid, updateId, event.eventId, reference, accountId, actionId, 'account', mappingIndex
        ))
        next = applyMappedAccount(event, member && member.memberRole, accountId, mappingIndex)
        next = { ...next, reasonCodes: resolvedReasons(issue.issueType, next.reasonCodes) }
      } else {
        next = applyFields({
          ...event,
          reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes)
        }, { ledgerAccountId: accountId })
        paymentReferenceKeys.push(...await stageAccountMappings(
          connection, uid, updateId, [event.eventId], accountId, actionId, 'account', mappingIndex
        ))
      }
      next.resolvingIssueType = issue.issueType
      const saved = await saveEvent(connection, uid, event, next, actionId)
      affected.push(saved)
      await updateAccountMappingMemberVersions(connection, uid, updateId, saved)
    }
  } else {
    for (const event of events) {
      const member = eventMembers.find((item) => item.objectId === event.eventId)
      const reference = mappingReferenceForMember(event, member && member.memberRole)
      const next = {
        ...event,
        status: EVENT_STATUS.EXCLUDED,
        reasonCodes: unique([
          ...resolvedReasons(issue.issueType, event.reasonCodes),
          'manual_exclusion',
          'account_mapping_excluded'
        ]),
        resolvingIssueType: issue.issueType
      }
      const saved = await saveEvent(connection, uid, event, next, actionId)
      affected.push(saved)
      await updateAccountMappingMemberVersions(connection, uid, updateId, saved)
      if (decision.paymentRuleAction === 'ignore' && reference) {
        paymentReferenceKeys.push(await stagePaymentReferenceMapping(
          connection, uid, updateId, event.eventId, reference, null, actionId, 'ignore', mappingIndex
        ))
      }
    }
    if (decision.paymentRuleAction === 'ignore') {
      const ordinaryEventIds = events.filter((event) => {
        const member = eventMembers.find((item) => item.objectId === event.eventId)
        return !mappingReferenceForMember(event, member && member.memberRole)
      }).map((event) => event.eventId)
      if (ordinaryEventIds.length) {
        paymentReferenceKeys.push(...await stageAccountMappings(
          connection, uid, updateId, ordinaryEventIds, null, actionId, 'ignore', mappingIndex
        ))
      }
    }
  }

  const [resolved] = await connection.execute(
    `UPDATE catledger_review_issues
        SET status = 'resolved', version = version + 1, blocking = 0,
            resolved_action_id = ?
      WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'open'`,
    [actionId, uid, issue.issueId, Number(issue.version)]
  )
  if (resolved.affectedRows !== 1) throw importError('CONFLICT')
  for (const event of affected) await createFollowUpIssue(connection, uid, updateId, event)
  return { events: affected, paymentReferenceKeys: unique(paymentReferenceKeys) }
}

async function reviseResolvedAccountMapping(
  connection, uid, updateId, issue, decision, actionId, mappingIndex = null
) {
  if (decision.paymentRuleAction != null &&
      (decision.paymentRuleAction !== 'ignore' || decision.decision !== 'exclude_events')) {
    throw importError('VALIDATION_ERROR')
  }
  const members = await selectMembers(connection, uid, issue.issueId)
  const eventMembers = accountMappingEventMembers(members)
  const eventIds = eventMembers.map((member) => member.objectId)
  if (!eventIds.length) throw importError('CONFLICT')
  const events = await selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate: true })
  if (events.length !== eventIds.length || events.some((event) => ['posted', 'corrected'].includes(event.status))) {
    throw importError('CONFLICT')
  }
  const [[laterResolved]] = await connection.execute(
    `SELECT COUNT(DISTINCT later.issue_id) AS count
       FROM catledger_review_issues later
       JOIN catledger_review_issue_members member
         ON member.uid = later.uid AND member.issue_id = later.issue_id
      WHERE later.uid = ? AND later.update_id = ? AND later.issue_id <> ?
        AND later.status = 'resolved' AND later.issue_type <> 'account_mapping'
        AND member.object_type = 'event'
        AND member.object_id IN (${eventIds.map(() => '?').join(', ')})`,
    [uid, updateId, issue.issueId, ...eventIds]
  )
  if (Number(laterResolved.count) > 0) throw importError('CONFLICT')

  for (const event of events) {
    const member = eventMembers.find((item) => item.objectId === event.eventId)
    const reference = mappingReferenceForMember(event, member && member.memberRole)
    if (reference) await deletePaymentReferenceMapping(connection, uid, updateId, event.eventId, reference)
    else {
      await connection.execute(
        `DELETE FROM catledger_finance_update_account_mapping_drafts
          WHERE uid = ? AND update_id = ? AND event_id = ?`,
        [uid, updateId, event.eventId]
      )
    }
  }

  const accountId = decision.decision === 'apply_fields'
    ? await materializeAccountMappingChoice(connection, uid, updateId, decision.fields, actionId)
    : null
  const affected = []
  const paymentReferenceKeys = []
  for (const event of events) {
    const member = eventMembers.find((item) => item.objectId === event.eventId)
    const reference = mappingReferenceForMember(event, member && member.memberRole)
    if (decision.decision === 'apply_fields') {
      const base = {
        ...event,
        status: EVENT_STATUS.NEEDS_ACTION,
        reasonCodes: unique(event.reasonCodes.filter((reason) => ![
          'manual_exclusion', 'account_mapping_excluded', 'source_account_ignored_default'
          ].includes(reason)))
      }
      let next
      if (reference) {
        paymentReferenceKeys.push(await stagePaymentReferenceMapping(
          connection, uid, updateId, event.eventId, reference, accountId, actionId, 'account', mappingIndex
        ))
        next = applyMappedAccount(base, member && member.memberRole, accountId, mappingIndex)
      } else {
        next = applyFields(base, { ledgerAccountId: accountId })
        paymentReferenceKeys.push(...await stageAccountMappings(
          connection, uid, updateId, [event.eventId], accountId, actionId, 'account', mappingIndex
        ))
      }
      next.resolvingIssueType = 'account_mapping'
      const saved = await saveEvent(connection, uid, event, next, actionId)
      affected.push(saved)
      await updateAccountMappingMemberVersions(connection, uid, updateId, saved)
    } else {
      const next = {
        ...event,
        status: EVENT_STATUS.EXCLUDED,
        reasonCodes: unique([
          ...event.reasonCodes.filter((reason) => reason !== 'source_account_ignored_default'),
          'manual_exclusion',
          'account_mapping_excluded'
        ]),
        resolvingIssueType: 'account_mapping'
      }
      const saved = await saveEvent(connection, uid, event, next, actionId)
      affected.push(saved)
      await updateAccountMappingMemberVersions(connection, uid, updateId, saved)
      if (decision.paymentRuleAction === 'ignore' && reference) {
        paymentReferenceKeys.push(await stagePaymentReferenceMapping(
          connection, uid, updateId, event.eventId, reference, null, actionId, 'ignore', mappingIndex
        ))
      }
    }
  }
  if (decision.decision !== 'apply_fields' && decision.paymentRuleAction === 'ignore') {
    const ordinaryEventIds = events.filter((event) => {
      const member = eventMembers.find((item) => item.objectId === event.eventId)
      return !mappingReferenceForMember(event, member && member.memberRole)
    }).map((event) => event.eventId)
    if (ordinaryEventIds.length) {
      paymentReferenceKeys.push(...await stageAccountMappings(
        connection, uid, updateId, ordinaryEventIds, null, actionId, 'ignore', mappingIndex
      ))
    }
  }
  const [revised] = await connection.execute(
    `UPDATE catledger_review_issues
        SET version = version + 1, resolved_action_id = ?
      WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'resolved'`,
    [actionId, uid, issue.issueId, Number(issue.version)]
  )
  if (revised.affectedRows !== 1) throw importError('CONFLICT')
  for (const event of affected) await createFollowUpIssue(connection, uid, updateId, event)
  for (const event of affected) {
    await connection.execute(
      `UPDATE catledger_review_issue_members member
         JOIN catledger_review_issues issue
           ON issue.uid = member.uid AND issue.issue_id = member.issue_id
          SET member.object_version = ?
        WHERE member.uid = ? AND issue.update_id = ? AND member.object_type = 'event'
          AND member.object_id = ? AND issue.status = 'open'
          AND issue.issue_type <> 'account_mapping'`,
      [event.version, uid, updateId, event.eventId]
    )
  }
  return { events: affected, paymentReferenceKeys: unique(paymentReferenceKeys) }
}

function createReviewIssueService({ getPool }) {
  async function list(context) {
    const updateId = validateUuid(context.data.updateId)
    const status = context.data.status == null ? null : context.data.status
    if (status != null && !['open', 'resolved', 'superseded'].includes(status)) throw importError('VALIDATION_ERROR')
    return executeUserRead({
      getPool,
      ...context,
      operation: async (connection, uid) => ({
        update: (await getUpdateView(connection, uid, updateId, { includeEvents: false, includeOptions: false })).update,
        issues: await selectIssues(connection, uid, updateId, { status })
      })
    })
  }

  async function get(context) {
    const issueId = validateUuid(context.data.issueId)
    return executeUserRead({
      getPool,
      ...context,
      operation: (connection, uid) => issueDetails(connection, uid, issueId)
    })
  }

  async function refreshAccountGroups(context) {
    const updateId = validateUuid(context.data.updateId)
    validateUuid(context.data.requestId)
    const version = validateVersion(context.data.version)
    return executeIdempotentMutation({ getPool, ...context, action: 'reviewIssues.refreshAccountGroups',
      operation: async (connection, uid, data, requestDigest) => {
        const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        if (update.status !== 'review' || Number(update.version) !== version) throw importError('CONFLICT')
        const planningRows = new Map((await selectPlanningRows(connection, uid, updateId)).map(row => [row.rowId, row]))
        const [rows] = await connection.execute(`SELECT e.event_id AS eventId, v.row_id AS rowId
          FROM catledger_economic_events e JOIN catledger_event_evidence v ON v.uid = e.uid AND v.event_id = e.event_id
          WHERE e.uid = ? AND e.update_id = ? AND e.status IN ('needs_action', 'ready')
            AND v.evidence_role <> 'discarded'
            AND JSON_EXTRACT(e.field_sources_json, '$.paymentAccountGroupsVersion') IS NULL
            AND JSON_EXTRACT(e.field_sources_json, '$.paymentResolution') IS NULL
          ORDER BY e.event_id, v.row_id`, [uid, updateId])
        const byEvent = new Map()
        for (const row of rows) {
          if (!byEvent.has(row.eventId)) byEvent.set(row.eventId, [])
          const evidence = planningRows.get(row.rowId)
          if (evidence) byEvent.get(row.eventId).push(evidence)
        }
        const candidates = [...byEvent].map(([eventId, evidence]) => ({ eventId, references: accountGroups.referencesForRows(evidence) }))
          .filter((item) => item.references.length)
        if (!candidates.length) return getUpdateView(connection, uid, updateId)
        const actionId = await insertAction(connection, uid, { updateId, expectedVersion: version, appliedVersion: version + 1,
          actionType: 'refresh_account_groups', requestDigest, decision: { version: accountGroups.VERSION }, reasons: ['account_references_expanded'] })
        const existingIssues = await selectIssues(connection, uid, updateId)
        const groups = new Map()
        for (const issue of existingIssues) {
          if (issue.issueType !== 'account_mapping' || !['open', 'resolved'].includes(issue.status) || !issue.accountContext?.recognized) continue
          const key = accountGroups.groupKey(issue.accountContext) + ':' + (issue.subject?.currency || 'CNY')
          if (key && !groups.has(key)) groups.set(key, { issue, count: issue.memberCount, added: 0 })
        }
        const events = await selectDomainEvents(connection, uid, updateId, candidates.map((item) => item.eventId), { forUpdate: true })
        const mappingIndex = createMappingIndex(await selectPaymentMappings(connection, uid, updateId))
        const savedEvents = []
        for (const event of events) {
          const references = candidates.find((item) => item.eventId === event.eventId).references
          const components = references.filter((ref) => ref.memberRole.startsWith('payment_component_'))
          if (components.length) {
            // 只替换旧组合账户问题；不撤销退款、分类等已确认决定。
            await connection.execute(`UPDATE catledger_review_issues i JOIN catledger_review_issue_members m
              ON m.uid = i.uid AND m.issue_id = i.issue_id SET i.status = 'superseded', i.blocking = 0,
              i.version = i.version + 1, i.resolved_action_id = ?
              WHERE i.uid = ? AND i.update_id = ? AND i.issue_type = 'account_mapping'
                AND i.status IN ('open', 'resolved') AND m.object_type = 'event' AND m.object_id = ? AND m.member_role = 'subject'`,
              [actionId, uid, updateId, event.eventId])
          }
          let next = { ...event, fieldSources: { ...event.fieldSources, paymentAccountReferences: references, paymentAccountGroupsVersion: accountGroups.VERSION } }
          for (const reference of references) {
            const key = (reference.paymentMethodKey ? accountGroups.groupKey(reference) : event.eventId + ':' + reference.memberRole) + ':' + event.currency
            let group = groups.get(key)
            if (!group) {
              const issueId = randomUUID()
              const issueKey = digestParts(accountGroups.VERSION, updateId, key)
              await connection.execute(`INSERT INTO catledger_review_issues
                (uid, issue_id, update_id, issue_key, issue_key_version, issue_type, status, version, blocking,
                 primary_reason_code, member_count, candidate_count, rule_version, reason_codes_json)
                VALUES (?, ?, ?, ?, ?, 'account_mapping', 'open', 1, 1, 'payment_reference_mapping_required', 0, 0, ?, ?)`,
                [uid, issueId, updateId, issueKey, REVIEW_ISSUE_VERSION, REVIEW_ISSUE_VERSION, JSON.stringify(['payment_reference_mapping_required'])])
              group = { issue: { issueId, status: 'open', version: 1 }, count: 0, added: 0, created: true, priorAccounts: [] }
              groups.set(key, group)
            }
            const priorAccount = accountGroups.mappedAccount(next, reference)
            if (priorAccount && group.issue.status === 'resolved' && group.issue.accountContext?.accountId && priorAccount !== group.issue.accountContext.accountId) {
              await connection.execute("UPDATE catledger_review_issues SET status = 'open', blocking = 1 WHERE uid = ? AND issue_id = ?", [uid, group.issue.issueId])
              group.issue.status = 'open'
            }
            const known = priorAccount || (group.issue.status === 'resolved' && group.issue.accountContext?.accountId)
            if (group.created) group.priorAccounts.push(known || '')
            if (known) {
              next = applyMappedAccount(next, reference.memberRole, known, mappingIndex)
              await stagePaymentReferenceMapping(connection, uid, updateId, event.eventId, reference, known, actionId, 'account', mappingIndex)
            }
            if (group.issue.status === 'resolved' && !known) {
              await connection.execute("UPDATE catledger_review_issues SET status = 'open', blocking = 1 WHERE uid = ? AND issue_id = ?", [uid, group.issue.issueId])
              group.issue.status = 'open'
            }
            await connection.execute(`INSERT INTO catledger_review_issue_members
              (uid, member_id, update_id, issue_id, object_type, object_id, object_version, member_role, sort_order)
              VALUES (?, ?, ?, ?, 'event', ?, ?, ?, ?)`,
              [uid, randomUUID(), updateId, group.issue.issueId, event.eventId, event.version + 1, reference.memberRole, group.count + group.added])
            group.added += 1
          }
          const saved = await saveEvent(connection, uid, event, next, actionId)
          await updateAccountMappingMemberVersions(connection, uid, updateId, saved)
          savedEvents.push(saved)
        }
        for (const group of groups.values()) if (group.added) {
          const confirmed = group.created && group.priorAccounts.every(Boolean) && new Set(group.priorAccounts).size === 1
          await connection.execute(`UPDATE catledger_review_issues
            SET member_count = member_count + ?, version = version + 1,
              status = IF(?, 'resolved', status), blocking = IF(?, 0, blocking) WHERE uid = ? AND issue_id = ?`,
            [group.added, Boolean(confirmed), Boolean(confirmed), uid, group.issue.issueId])
        }
        for (const event of savedEvents) await createFollowUpIssue(connection, uid, updateId, event)
        await recalculateUpdateCounts(connection, uid, updateId, version + 1, actionId, version)
        return getUpdateView(connection, uid, updateId)
      }
    })
  }

  async function resolveAccountMappings(context) {
    const updateId = validateUuid(context.data.updateId)
    validateUuid(context.data.requestId)
    if (!Array.isArray(context.data.decisions) || context.data.decisions.length < 1 || context.data.decisions.length > 50) {
      throw importError('VALIDATION_ERROR')
    }
    const decisions = context.data.decisions.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw importError('VALIDATION_ERROR')
      const operation = item.operation
      if (!['resolve', 'revise'].includes(operation)) throw importError('VALIDATION_ERROR')
      const decision = item.decision
      if (!['apply_fields', 'exclude_events'].includes(decision)) throw importError('VALIDATION_ERROR')
      return {
        issueId: validateUuid(item.issueId),
        operation,
        decision,
        fields: item.fields,
        paymentRuleAction: item.paymentRuleAction
      }
    })
    if (new Set(decisions.map((item) => item.issueId)).size !== decisions.length) {
      throw importError('VALIDATION_ERROR')
    }

    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'reviewIssues.resolveAccountMappings',
      operation: (connection, uid, data, requestDigest) => runAccountMappingBatch({
        decisions,
        begin: async function (items) {
          const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
          if (update.status !== 'review') throw importError('CONFLICT')
          const issues = new Map()
          const sortedIssueIds = items.map((item) => item.issueId).sort()
          for (const issueId of sortedIssueIds) {
            const issue = await selectIssue(connection, uid, issueId, { forUpdate: true })
            if (issue.updateId !== updateId || issue.issueType !== 'account_mapping') {
              throw importError('VALIDATION_ERROR')
            }
            issues.set(issueId, issue)
          }
          const actionable = items.filter((item) => {
            const issue = issues.get(item.issueId)
            if (issue.status === 'superseded' ||
                (item.operation === 'resolve' && issue.status === 'resolved')) return false
            if (item.operation === 'resolve' && issue.status !== 'open') throw importError('CONFLICT')
            if (item.operation === 'revise' && issue.status !== 'resolved') throw importError('CONFLICT')
            return true
          })
          if (!actionable.length) {
            return { decisions: [], issues, updateVersion: Number(update.version), actionId: null }
          }
          const updateVersion = Number(update.version)
          const actionId = await insertAction(connection, uid, {
            updateId,
            expectedVersion: updateVersion,
            appliedVersion: updateVersion + 1,
            actionType: 'resolve_account_mappings',
            requestDigest,
            decision: { decisions: actionable },
            reasons: ['account_mappings_resolved']
          })
          return {
            decisions: actionable,
            issues,
            updateVersion,
            actionId,
            mappingIndex: createMappingIndex(await selectPaymentMappings(connection, uid, updateId)),
            affectedEventIds: new Set(),
            paymentReferenceKeys: new Set()
          }
        },
        applyDecision: async function (item, batch) {
          const issue = batch.issues.get(item.issueId)
          const result = item.operation === 'revise'
            ? await reviseResolvedAccountMapping(
              connection, uid, updateId, issue, item, batch.actionId, batch.mappingIndex
            )
            : await resolveOpenAccountMapping(
              connection, uid, updateId, issue, item, batch.actionId, batch.mappingIndex
            )
          for (const event of result.events) batch.affectedEventIds.add(event.eventId)
          for (const key of result.paymentReferenceKeys) batch.paymentReferenceKeys.add(key)
        },
        finalize: async function (batch) {
          if (batch.actionId) {
            await refreshProjectedEvents(connection, uid, updateId, batch.actionId, {
              eventIds: [...batch.affectedEventIds],
              paymentReferenceKeys: [...batch.paymentReferenceKeys]
            })
            await recalculateUpdateCounts(
              connection, uid, updateId, batch.updateVersion + 1,
              batch.actionId, batch.updateVersion
            )
          }
          return getUpdateView(connection, uid, updateId)
        }
      })
    })
  }

  async function resolve(context) {
    const updateId = validateUuid(context.data.updateId)
    const issueId = validateUuid(context.data.issueId)
    const updateVersion = validateVersion(context.data.updateVersion)
    const issueVersion = validateVersion(context.data.issueVersion)
    const decision = validateDecision(context.data.decision)
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'reviewIssues.resolve',
      operation: async (connection, uid, data, requestDigest) => {
        const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        const issue = await selectIssue(connection, uid, issueId, { forUpdate: true })
        if (issue.updateId !== updateId || update.status !== 'review' || Number(update.version) !== updateVersion ||
            issue.status !== 'open' || Number(issue.version) !== issueVersion) throw importError('CONFLICT')
        assertDecisionMatchesIssue(issue, decision)
        const paymentRuleAction = data.paymentRuleAction == null ? null : data.paymentRuleAction
        if (paymentRuleAction != null &&
            (paymentRuleAction !== 'ignore' || decision !== 'exclude_events' || issue.issueType !== 'account_mapping')) {
          throw importError('VALIDATION_ERROR')
        }
        const members = await selectMembers(connection, uid, issueId)
        const eventMembers = members.filter((member) => member.objectType === 'event' && member.memberRole === 'subject')
        const eventIds = eventMembers.map((member) => member.objectId)
        const storedEvents = await selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate: true })
        if (storedEvents.length !== eventIds.length || storedEvents.some((event) => {
          const member = eventMembers.find((item) => item.objectId === event.eventId)
          return !member || member.objectVersion !== event.version || ['posted', 'corrected'].includes(event.status)
        })) throw importError('CONFLICT')
        // 事件可能仍带着整理前的历史映射快照。执行任何人工裁决前先按
        // “历史映射 < 本批映射草稿 < 已手工端点”得到当前有效资金端，
        // 避免用户只选择转入端时把过期的转出端一并保存。
        const events = await effectiveProjectedEvents(connection, uid, updateId, storedEvents)

        const appliedVersion = updateVersion + 1
        const actionId = await insertAction(connection, uid, {
          updateId,
          expectedVersion: updateVersion,
          appliedVersion,
          actionType: 'resolve_review_issue',
          requestDigest,
          decision: data,
          reasons: ['review_issue_resolved', `decision:${decision}`]
        })
        const affected = []
        let duplicateEvidenceDelta = 0

        if (decision === 'confirm_same') {
          const primaryEventId = validateUuid(data.primaryEventId)
          if (!eventIds.includes(primaryEventId) || eventIds.length < 2) throw importError('VALIDATION_ERROR')
          for (const event of events) {
            if (event.eventId === primaryEventId) continue
            const [[linkCount]] = await connection.execute(
              `SELECT COUNT(*) AS count FROM catledger_economic_event_transactions
                WHERE uid = ? AND update_id = ? AND event_id = ?`,
              [uid, updateId, event.eventId]
            )
            if (Number(linkCount.count) !== 0) throw importError('CONFLICT')
            await connection.execute(
              `UPDATE catledger_event_evidence
                  SET event_id = ?, evidence_role = CASE WHEN evidence_role = 'discarded' THEN 'discarded' ELSE 'supporting' END
                WHERE uid = ? AND update_id = ? AND event_id = ?`,
              [primaryEventId, uid, updateId, event.eventId]
            )
            await connection.execute(
              `DELETE FROM catledger_economic_event_relations
                WHERE uid = ? AND update_id = ? AND (source_event_id = ? OR target_event_id = ?)`,
              [uid, updateId, event.eventId, event.eventId]
            )
            const [deleted] = await connection.execute(
              `DELETE FROM catledger_economic_events
                WHERE uid = ? AND update_id = ? AND event_id = ? AND version = ?
                  AND status IN ('ready', 'needs_action', 'excluded')`,
              [uid, updateId, event.eventId, event.version]
            )
            if (deleted.affectedRows !== 1) throw importError('CONFLICT')
            duplicateEvidenceDelta += 1
          }
          const primary = events.find((event) => event.eventId === primaryEventId)
          const next = { ...primary, reasonCodes: resolvedReasons(issue.issueType, primary.reasonCodes), resolvingIssueType: issue.issueType }
          affected.push(await saveEvent(connection, uid, primary, next, actionId))
        } else if (decision === 'confirm_distinct') {
          await connection.execute(
            `UPDATE catledger_economic_event_relations SET status = 'rejected', version = version + 1
              WHERE uid = ? AND update_id = ? AND status = 'proposed'
                AND (source_event_id IN (${eventIds.map(() => '?').join(', ')})
                  OR target_event_id IN (${eventIds.map(() => '?').join(', ')}))`,
            [uid, updateId, ...eventIds, ...eventIds]
          )
          for (const event of events) {
            const next = { ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes), resolvingIssueType: issue.issueType }
            affected.push(await saveEvent(connection, uid, event, next, actionId))
          }
        } else if (decision === 'apply_fields') {
          let fields = data.fields
          if (fields && fields.repaymentAllocations) {
            if (events.some((event) => !isAggregateRepayment(event))) throw importError('VALIDATION_ERROR')
            fields = { ...fields, repaymentAllocations: await stageRepaymentAllocationDrafts(connection, uid, updateId, fields.repaymentAllocations, actionId) }
          }
          if (fields && fields.ledgerAccountDraft) {
            const draftAccountId = await stageAccountDraft(
              connection,
              uid,
              updateId,
              fields.ledgerAccountDraft,
              actionId
            )
            fields = { ...fields, ledgerAccountId: draftAccountId }
            delete fields.ledgerAccountDraft
          }
          if (fields && fields.counterpartyLedgerAccountDraft) {
            const draftAccountId = await stageAccountDraft(
              connection,
              uid,
              updateId,
              fields.counterpartyLedgerAccountDraft,
              actionId
            )
            fields = { ...fields, counterpartyLedgerAccountId: draftAccountId }
            delete fields.counterpartyLedgerAccountDraft
          }
          for (const event of events) {
            const next = applyFields({ ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes) }, fields)
            next.resolvingIssueType = issue.issueType
            affected.push(await saveEvent(connection, uid, event, next, actionId))
          }
          if (fields && fields.ledgerAccountId) {
            const ordinaryEventIds = affected.filter((event) => !event.fieldSources.fundsProjection).map((event) => event.eventId)
            if (ordinaryEventIds.length) {
              await stageAccountMappings(
                connection,
                uid,
                updateId,
                ordinaryEventIds,
                validateUuid(fields.ledgerAccountId),
                actionId
              )
            }
          }
          await stageProjectedAccountMappings(connection, uid, updateId, affected, actionId)
        } else if (decision === 'exclude_events' || decision === 'confirm_installment_principal') {
          if (decision === 'confirm_installment_principal') validateUuid(data.installmentCandidateId)
          const selected = Array.isArray(data.eventIds) && data.eventIds.length > 0
            ? new Set(data.eventIds.map(validateUuid))
            : new Set(eventIds)
          if ([...selected].some((eventId) => !eventIds.includes(eventId))) throw importError('VALIDATION_ERROR')
          for (const event of events.filter((item) => selected.has(item.eventId))) {
            const exclusionReasons = issue.issueType === 'account_mapping'
              ? ['manual_exclusion', 'account_mapping_excluded']
              : ['manual_exclusion']
            const next = {
              ...event,
              status: EVENT_STATUS.EXCLUDED,
              reasonCodes: unique([...resolvedReasons(issue.issueType, event.reasonCodes),
                ...(decision === 'confirm_installment_principal'
                  ? ['installment_principal_confirmed']
                  : exclusionReasons)]),
              resolvingIssueType: issue.issueType
            }
            affected.push(await saveEvent(connection, uid, event, next, actionId))
          }
          if (paymentRuleAction === 'ignore') {
            await stageAccountMappings(
              connection,
              uid,
              updateId,
              [...selected],
              null,
              actionId,
              'ignore'
            )
          }
        } else if (decision === 'discard_evidence') {
          const evidenceId = validateUuid(data.evidenceId)
          const [result] = await connection.execute(
            `UPDATE catledger_event_evidence SET evidence_role = 'discarded'
              WHERE uid = ? AND update_id = ? AND evidence_id = ?
                AND event_id IN (${eventIds.map(() => '?').join(', ')})`,
            [uid, updateId, evidenceId, ...eventIds]
          )
          if (result.affectedRows !== 1) throw importError('NOT_FOUND')
          for (const event of events) {
            const next = { ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes), resolvingIssueType: issue.issueType }
            affected.push(await saveEvent(connection, uid, event, next, actionId))
          }
        } else if (decision === 'mark_refund_pending') {
          if (events.length !== 1 || Number(issue.candidateCount) !== 0) throw importError('VALIDATION_ERROR')
          const source = events[0]
          if (source.economicNature !== ECONOMIC_NATURE.REFUND) throw importError('VALIDATION_ERROR')
          const [proposed] = await connection.execute(
            `SELECT relation_id AS relationId
               FROM catledger_economic_event_relations
              WHERE uid = ? AND update_id = ? AND source_event_id = ?
                AND relation_type = 'refund_of' AND status = 'proposed' FOR UPDATE`,
            [uid, updateId, source.eventId]
          )
          if (proposed.length !== 0) throw importError('VALIDATION_ERROR')
          const next = {
            ...source,
            fieldSources: {
              ...(source.fieldSources || {}),
              refundRelation: {
                version: REFUND_RELATION_STATE_VERSION,
                status: 'pending',
                confirmedBy: 'user'
              }
            },
            reasonCodes: resolvedReasons(issue.issueType, source.reasonCodes),
            resolvingIssueType: issue.issueType
          }
          affected.push(await saveEvent(connection, uid, source, next, actionId))
        } else if (decision === 'link_refund') {
          if (events.length !== 1) throw importError('VALIDATION_ERROR')
          const source = events[0]
          if (source.economicNature !== ECONOMIC_NATURE.REFUND) throw importError('VALIDATION_ERROR')
          const targetEventId = validateUuid(data.targetEventId)
          const [selectedRelations] = await connection.execute(
            `SELECT relation.relation_id AS relationId, relation.status, relation.version
               FROM catledger_economic_event_relations relation
               JOIN catledger_review_issue_members member
                 ON member.uid = relation.uid AND member.update_id = relation.update_id
                AND member.object_type = 'relation' AND member.object_id = relation.relation_id
                AND member.member_role = 'candidate'
              WHERE relation.uid = ? AND relation.update_id = ? AND relation.source_event_id = ?
                AND relation.target_event_id = ? AND relation.relation_type = 'refund_of'
                AND relation.status = 'proposed' AND member.issue_id = ?
              LIMIT 1 FOR UPDATE`,
            [uid, updateId, source.eventId, targetEventId, issueId]
          )
          const selectedRelation = selectedRelations[0]
          if (!selectedRelation) throw importError('VALIDATION_ERROR')
          const [targets] = await connection.execute(
            `SELECT event_id AS eventId, status, economic_nature AS economicNature,
                    event_utc_at AS utcAt, amount_minor AS amountMinor, currency
               FROM catledger_economic_events
              WHERE uid = ? AND update_id = ? AND event_id = ? LIMIT 1`,
            [uid, updateId, targetEventId]
          )
          const target = targets[0]
          if (target && target.fieldSources && target.fieldSources.paymentResolution) throw importError('PAYMENT_REFUND_ALLOCATION_REQUIRED')
          if (!target || source.eventId === targetEventId || target.status === EVENT_STATUS.EXCLUDED ||
              ![ECONOMIC_NATURE.EXPENSE, ECONOMIC_NATURE.FEE].includes(target.economicNature) || target.currency !== source.currency ||
              BigInt(String(target.amountMinor)) < BigInt(source.amountMinor) ||
              !target.utcAt || !source.utcAt || String(target.utcAt) > String(source.utcAt)) {
            throw importError('VALIDATION_ERROR')
          }
          const [[refundTotal]] = await connection.execute(
            `SELECT COALESCE(SUM(amount_minor), 0) AS amountMinor
               FROM catledger_economic_event_relations
              WHERE uid = ? AND update_id = ? AND target_event_id = ?
                AND relation_type = 'refund_of' AND status = 'confirmed' AND source_event_id <> ?`,
            [uid, updateId, targetEventId, source.eventId]
          )
          if (BigInt(String(refundTotal.amountMinor)) + BigInt(source.amountMinor) > BigInt(String(target.amountMinor))) {
            throw importError('VALIDATION_ERROR')
          }
          const selectedRelationId = selectedRelation.relationId
          const [updatedRelation] = await connection.execute(
            `UPDATE catledger_economic_event_relations
                SET status = 'confirmed', manual = 1, amount_minor = ?, currency = ?,
                    reason_codes_json = JSON_ARRAY('manual_refund_relation'), version = version + 1
              WHERE uid = ? AND relation_id = ? AND version = ? AND status = 'proposed'`,
            [source.amountMinor, source.currency, uid, selectedRelationId, Number(selectedRelation.version)]
          )
          if (updatedRelation.affectedRows !== 1) throw importError('CONFLICT')
          await connection.execute(
            `UPDATE catledger_economic_event_relations
                SET status = 'rejected', version = version + 1
              WHERE uid = ? AND update_id = ? AND source_event_id = ?
                AND relation_type = 'refund_of' AND relation_id <> ? AND status = 'proposed'`,
            [uid, updateId, source.eventId, selectedRelationId]
          )
          const next = { ...source, reasonCodes: resolvedReasons(issue.issueType, source.reasonCodes), resolvingIssueType: issue.issueType }
          affected.push(await saveEvent(connection, uid, source, next, actionId))
        } else if (decision === 'link_existing_transaction') {
          const transactionId = validateUuid(data.transactionId)
          const primaryEventId = data.primaryEventId ? validateUuid(data.primaryEventId) : eventIds[0]
          const event = events.find((item) => item.eventId === primaryEventId)
          const [transactions] = await connection.execute(
            `SELECT version FROM catledger_transactions
              WHERE uid = ? AND transaction_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
            [uid, transactionId]
          )
          if (!event || !transactions[0]) throw importError('NOT_FOUND')
          await connection.execute(
            `INSERT INTO catledger_economic_event_transactions
               (uid, link_id, update_id, event_id, transaction_id, role,
                creation_method, rule_version, transaction_version)
             VALUES (?, ?, ?, ?, ?, 'historical_primary', 'reused',
                     'event-transaction-link-v2', ?)`,
            [uid, randomUUID(), updateId, event.eventId, transactionId, Number(transactions[0].version)]
          )
          const next = {
            ...event,
            status: EVENT_STATUS.EXCLUDED,
            reasonCodes: unique([...resolvedReasons(issue.issueType, event.reasonCodes), 'linked_existing_transaction']),
            resolvingIssueType: issue.issueType
          }
          affected.push(await saveEvent(connection, uid, event, next, actionId))
        }

        const [resolved] = await connection.execute(
          `UPDATE catledger_review_issues
              SET status = 'resolved', version = version + 1, blocking = 0,
                  resolved_action_id = ?
            WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'open'`,
          [actionId, uid, issueId, issueVersion]
        )
        if (resolved.affectedRows !== 1) throw importError('CONFLICT')
        for (const event of affected) await createFollowUpIssue(connection, uid, updateId, event)
        await refreshProjectedEvents(connection, uid, updateId, actionId)
        await recalculateUpdateCounts(connection, uid, updateId, appliedVersion, actionId, updateVersion, duplicateEvidenceDelta)
        return issueDetails(connection, uid, issueId)
      }
    })
  }

  async function reviseAccountMapping(context) {
    const updateId = validateUuid(context.data.updateId)
    const issueId = validateUuid(context.data.issueId)
    const updateVersion = validateVersion(context.data.updateVersion)
    const issueVersion = validateVersion(context.data.issueVersion)
    const decision = context.data.decision
    if (!['apply_fields', 'exclude_events'].includes(decision)) throw importError('VALIDATION_ERROR')
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'reviewIssues.reviseAccountMapping',
      operation: async (connection, uid, data, requestDigest) => {
        const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        const issue = await selectIssue(connection, uid, issueId, { forUpdate: true })
        if (issue.updateId !== updateId || update.status !== 'review' || Number(update.version) !== updateVersion ||
            issue.issueType !== 'account_mapping' || issue.status !== 'resolved' || Number(issue.version) !== issueVersion) {
          throw importError('CONFLICT')
        }
        const members = await selectMembers(connection, uid, issueId)
        const eventIds = members.filter((member) => member.objectType === 'event' && member.memberRole === 'subject')
          .map((member) => member.objectId)
        if (eventIds.length === 0) throw importError('CONFLICT')
        const events = await selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate: true })
        if (events.length !== eventIds.length || events.some((event) => ['posted', 'corrected'].includes(event.status))) {
          throw importError('CONFLICT')
        }
        const [[laterResolved]] = await connection.execute(
          `SELECT COUNT(DISTINCT later.issue_id) AS count
             FROM catledger_review_issues later
             JOIN catledger_review_issue_members member
               ON member.uid = later.uid AND member.issue_id = later.issue_id
            WHERE later.uid = ? AND later.update_id = ? AND later.issue_id <> ?
              AND later.status = 'resolved' AND member.object_type = 'event'
              AND member.object_id IN (${eventIds.map(() => '?').join(', ')})`,
          [uid, updateId, issueId, ...eventIds]
        )
        if (Number(laterResolved.count) > 0) throw importError('CONFLICT')

        const appliedVersion = updateVersion + 1
        const actionId = await insertAction(connection, uid, {
          updateId,
          expectedVersion: updateVersion,
          appliedVersion,
          actionType: 'revise_account_mapping',
          requestDigest,
          decision: data,
          reasons: ['account_mapping_revised']
        })
        await connection.execute(
          `UPDATE catledger_review_issues later
             JOIN catledger_review_issue_members member
               ON member.uid = later.uid AND member.issue_id = later.issue_id
              SET later.status = 'superseded', later.blocking = 0, later.version = later.version + 1,
                  later.resolved_action_id = ?
            WHERE later.uid = ? AND later.update_id = ? AND later.issue_id <> ?
              AND later.status = 'open' AND later.issue_type = 'account_mapping'
              AND member.object_type = 'event'
              AND member.object_id IN (${eventIds.map(() => '?').join(', ')})`,
          [actionId, uid, updateId, issueId, ...eventIds]
        )
        await connection.execute(
          `DELETE FROM catledger_finance_update_account_mapping_drafts
            WHERE uid = ? AND update_id = ? AND event_id IN (${eventIds.map(() => '?').join(', ')})`,
          [uid, updateId, ...eventIds]
        )

        let fields = data.fields
        if (decision === 'apply_fields') {
          if (fields && fields.ledgerAccountDraft) {
            const draftAccountId = await stageAccountDraft(connection, uid, updateId, fields.ledgerAccountDraft, actionId)
            fields = { ledgerAccountId: draftAccountId }
          }
          if (!fields || !fields.ledgerAccountId) throw importError('VALIDATION_ERROR')
        } else if (data.paymentRuleAction != null && data.paymentRuleAction !== 'ignore') {
          throw importError('VALIDATION_ERROR')
        }

        const affected = []
        for (const event of events) {
          if (decision === 'apply_fields') {
            const base = {
              ...event,
              status: EVENT_STATUS.NEEDS_ACTION,
              reasonCodes: unique(event.reasonCodes.filter((reason) => ![
                'manual_exclusion', 'account_mapping_excluded', 'source_account_ignored_default'
              ].includes(reason)))
            }
            const next = applyFields(base, fields)
            next.resolvingIssueType = 'account_mapping'
            affected.push(await saveEvent(connection, uid, event, next, actionId))
          } else {
            const next = {
              ...event,
              status: EVENT_STATUS.EXCLUDED,
              reasonCodes: unique([
                ...event.reasonCodes.filter((reason) => reason !== 'source_account_ignored_default'),
                'manual_exclusion',
                'account_mapping_excluded'
              ]),
              resolvingIssueType: 'account_mapping'
            }
            affected.push(await saveEvent(connection, uid, event, next, actionId))
          }
        }
        if (decision === 'apply_fields') {
          await stageAccountMappings(connection, uid, updateId, eventIds, validateUuid(fields.ledgerAccountId), actionId)
        } else if (data.paymentRuleAction === 'ignore') {
          await stageAccountMappings(connection, uid, updateId, eventIds, null, actionId, 'ignore')
        }
        await connection.execute(
          `UPDATE catledger_review_issues
              SET version = version + 1, resolved_action_id = ?
            WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'resolved'`,
          [actionId, uid, issueId, issueVersion]
        )
        for (const event of affected) await createFollowUpIssue(connection, uid, updateId, event)
        for (const event of affected) {
          await connection.execute(
            `UPDATE catledger_review_issue_members member
               JOIN catledger_review_issues issue
                 ON issue.uid = member.uid AND issue.issue_id = member.issue_id
                SET member.object_version = ?
              WHERE member.uid = ? AND issue.update_id = ? AND member.object_type = 'event'
                AND member.object_id = ? AND issue.status = 'open'
                AND issue.issue_type <> 'account_mapping'`,
            [event.version, uid, updateId, event.eventId]
          )
        }
        await refreshProjectedEvents(connection, uid, updateId, actionId)
        await recalculateUpdateCounts(connection, uid, updateId, appliedVersion, actionId, updateVersion)
        return getUpdateView(connection, uid, updateId)
      }
    })
  }

  return { get, list, resolve, resolveAccountMappings, reviseAccountMapping, refreshAccountGroups }
}

module.exports = {
  selectDomainEvents, saveEvent, createFollowUpIssue, recalculateUpdateCounts,
  FIELD_MASK,
  applyFields,
  createReviewIssueService,
  isEventInProjectionRefreshScope,
  runAccountMappingBatch,
  resolvedReasons,
  validateDecision
}
