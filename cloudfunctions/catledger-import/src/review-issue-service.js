const { assertNoLoanTransactions } = require('./loan-transaction-guard')
const { chunks, insertMany } = require('./sql-batch')
const { commandResult } = require('./command-result')
const { assertIdentityIntegrity } = require('./evidence-integrity')
const accountGroups = require('./payment-account-groups')
const { randomUUID } = require('node:crypto')
const { digestParts } = require('./digest')
const { REVIEW_ISSUE_VERSION } = require('./domain-versions')
const { importError } = require('./errors')
const { stageAccountDraft, stageRepaymentAllocationDrafts } = require('./account-draft')
const { insertAction, selectIssues, selectPlanningRows, selectPaymentMappings, selectUpdate } = require('./finance-update-repository')
const { executeIdempotentMutation } = require('./import-transaction')
const { ECONOMIC_NATURE, EVENT_STATUS, REFUND_RELATION_STATE_VERSION, unique } = require('./organizer-model')
const { validateUuid, validateVersion } = require('./validation')
const { createMappingIndex, reconcileProjectedAccounts } = require('./source-funds')
const { paymentReferenceKey } = require('./payment-account')
const { isAggregateRepayment } = require('./repayment-allocation')
const { FIELD_MASK, validateDecision, resolvedReasons, applyFields, assertDecisionMatchesIssue } = require('./review/policy')
const { selectDomainEvents, loadReferenceCatalog, saveEvents, saveEvent } = require('./review/event-store')
const { selectIssue, selectMembers, updateMappingMemberVersions, createFollowUpIssues } = require('./review/issue-store')
const { refreshProjectedEvents, effectiveProjectedEvents, effectiveProjectedEventsFromIndex, recalculateUpdateCounts } = require('./review/reconciliation')

async function stageAccountMappings(
  connection, uid, updateId, eventIds, accountId, actionId,
  mappingAction = 'account', mappingIndex = null
) {
  if (eventIds.length === 0) return []
  if (!['account', 'ignore'].includes(mappingAction)) throw importError('VALIDATION_ERROR')
  if ((mappingAction === 'account') !== Boolean(accountId)) throw importError('VALIDATION_ERROR')
  const rows = []
  for (const part of chunks([...new Set(eventIds)].sort().map(id => [id]))) {
  const [found] = await connection.execute(
    `SELECT DISTINCT ee.event_id AS eventId,
            s.source_type_snapshot AS sourceType,
            r.payment_method_key AS paymentMethodKey,
            r.payment_method_raw AS paymentMethod
       FROM catledger_event_evidence ee
       JOIN catledger_import_rows r ON r.uid = ee.uid AND r.row_id = ee.row_id
       JOIN catledger_finance_update_sources s
         ON s.uid = ee.uid AND s.update_id = ee.update_id AND s.batch_id = r.batch_id
      WHERE ee.uid = ? AND ee.update_id = ?
        AND ee.event_id IN (${part.map(() => '?').join(', ')})
        AND ee.evidence_role <> 'discarded' AND r.payment_method_key IS NOT NULL`,
    [uid, updateId, ...part.flat()]
  )
  rows.push(...found)
  }
  if (mappingAction === 'ignore' && rows.length === 0) throw importError('VALIDATION_ERROR')
  await insertMany(connection, `INSERT INTO catledger_finance_update_account_mapping_drafts
    (uid, draft_mapping_id, update_id, event_id, source_type, payment_method_key, payment_method_hint, mapping_action, account_id, action_id) VALUES`,
  rows.map(row => [uid, randomUUID(), updateId, row.eventId, row.sourceType, row.paymentMethodKey,
    String(row.paymentMethod || '').slice(0, 128), mappingAction, accountId, actionId]),
  ` ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint), mapping_action = VALUES(mapping_action),
    account_id = VALUES(account_id), action_id = VALUES(action_id)`)
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
  mappingAction = 'account', mappingIndex = null, pendingRows = null
) {
  if (reference && reference.memberRole && !reference.paymentMethodKey) return ''
  if (!reference || !reference.sourceType || !reference.paymentMethodKey) throw importError('VALIDATION_ERROR')
  if (!['account', 'ignore'].includes(mappingAction)) throw importError('VALIDATION_ERROR')
  if ((mappingAction === 'account') !== Boolean(accountId)) throw importError('VALIDATION_ERROR')
  const row = [uid, randomUUID(), updateId, eventId, reference.sourceType,
    reference.paymentMethodKey, String(reference.label || '').slice(0, 128), mappingAction, accountId, actionId]
  if (pendingRows) pendingRows.push(row)
  else await connection.execute(
    `INSERT INTO catledger_finance_update_account_mapping_drafts
       (uid, draft_mapping_id, update_id, event_id, source_type,
        payment_method_key, payment_method_hint, mapping_action, account_id, action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint),
       mapping_action = VALUES(mapping_action), account_id = VALUES(account_id),
       action_id = VALUES(action_id)`,
    row
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

async function applyAccountMappingEvents(connection, uid, updateId, events, eventMembers, decision, actionId, mappingIndex, revision = false) {
  const membersById = new Map(eventMembers.map(member => [member.objectId, member]))
  const references = new Map(events.map(event => [event.eventId, mappingReferenceForMember(event, membersById.get(event.eventId).memberRole)]))
  if (revision) {
    const exact = [], whole = []
    for (const event of events) {
      const ref = references.get(event.eventId)
      if (ref && ref.paymentMethodKey) exact.push([event.eventId, ref.sourceType, ref.paymentMethodKey])
      else if (!ref) whole.push([event.eventId])
    }
    for (const part of chunks(exact)) await connection.execute(`DELETE FROM catledger_finance_update_account_mapping_drafts
      WHERE uid = ? AND update_id = ? AND (event_id, source_type, payment_method_key) IN (${part.map(() => '(?,?,?)').join(',')})`, [uid, updateId, ...part.flat()])
    for (const part of chunks(whole)) await connection.execute(`DELETE FROM catledger_finance_update_account_mapping_drafts
      WHERE uid = ? AND update_id = ? AND event_id IN (${part.map(() => '?').join(',')})`, [uid, updateId, ...part.flat()])
  }
  const accountId = decision.decision === 'apply_fields' ? await materializeAccountMappingChoice(connection, uid, updateId, decision.fields, actionId) : null
  const mappingAction = accountId ? 'account' : decision.paymentRuleAction === 'ignore' ? 'ignore' : null
  const mappingRows = [], ordinary = [], paymentReferenceKeys = []
  if (mappingAction) for (const event of events) {
    const ref = references.get(event.eventId)
    if (!ref) { ordinary.push(event.eventId); continue }
    if (ref.memberRole && !ref.paymentMethodKey) continue
    if (!ref.sourceType || !ref.paymentMethodKey) throw importError('VALIDATION_ERROR')
    mappingRows.push([uid, randomUUID(), updateId, event.eventId, ref.sourceType, ref.paymentMethodKey,
      String(ref.label || '').slice(0, 128), mappingAction, accountId, actionId])
    const key = paymentReferenceKey(ref)
    paymentReferenceKeys.push(key)
    if (mappingIndex) mappingIndex.set(key, accountId)
  }
  await insertMany(connection, `INSERT INTO catledger_finance_update_account_mapping_drafts
    (uid, draft_mapping_id, update_id, event_id, source_type, payment_method_key, payment_method_hint, mapping_action, account_id, action_id) VALUES`, mappingRows,
  ` ON DUPLICATE KEY UPDATE payment_method_hint = VALUES(payment_method_hint), mapping_action = VALUES(mapping_action), account_id = VALUES(account_id), action_id = VALUES(action_id)`)
  if (ordinary.length) paymentReferenceKeys.push(...await stageAccountMappings(connection, uid, updateId, ordinary, accountId, actionId, mappingAction, mappingIndex))
  const pairs = events.map(event => {
    let next
    if (decision.decision === 'apply_fields') {
      const base = revision ? { ...event, status: EVENT_STATUS.NEEDS_ACTION,
        reasonCodes: unique(event.reasonCodes.filter(reason => !['manual_exclusion', 'account_mapping_excluded', 'source_account_ignored_default'].includes(reason))) } : event
      next = references.get(event.eventId) ? applyMappedAccount(base, membersById.get(event.eventId).memberRole, accountId, mappingIndex) : applyFields(base, { ledgerAccountId: accountId })
      if (!revision) next = { ...next, reasonCodes: resolvedReasons('account_mapping', next.reasonCodes) }
    } else next = { ...event, status: EVENT_STATUS.EXCLUDED,
      reasonCodes: unique([...(revision ? event.reasonCodes.filter(reason => reason !== 'source_account_ignored_default') : resolvedReasons('account_mapping', event.reasonCodes)), 'manual_exclusion', 'account_mapping_excluded']) }
    next.resolvingIssueType = 'account_mapping'
    return { current: event, next }
  })
  const affected = await saveEvents(connection, uid, updateId, pairs, actionId)
  await updateMappingMemberVersions(connection, uid, updateId, affected)
  return { events: affected, paymentReferenceKeys: unique(paymentReferenceKeys) }
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
  const membersById = new Map(eventMembers.map(member => [member.objectId, member]))
  const storedEvents = await selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate: true })
  if (storedEvents.length !== eventIds.length || storedEvents.some((event) => {
    const member = membersById.get(event.eventId)
    return !member || member.objectVersion !== event.version || ['posted', 'corrected'].includes(event.status)
  })) throw importError('CONFLICT')
  const events = mappingIndex
    ? effectiveProjectedEventsFromIndex(storedEvents, mappingIndex)
    : await effectiveProjectedEvents(connection, uid, updateId, storedEvents)
  const applied = await applyAccountMappingEvents(connection, uid, updateId, events, eventMembers, decision, actionId, mappingIndex)
  const affected = applied.events
  const [resolved] = await connection.execute(
    `UPDATE catledger_review_issues
        SET status = 'resolved', version = version + 1, blocking = 0,
            resolved_action_id = ?
      WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'open'`,
    [actionId, uid, issue.issueId, Number(issue.version)]
  )
  if (resolved.affectedRows !== 1) throw importError('CONFLICT')
  await createFollowUpIssues(connection, uid, updateId, affected)
  return applied
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
  for (const part of chunks(eventIds.map(id => [id]))) {
  const [[laterResolved]] = await connection.execute(
    `SELECT COUNT(DISTINCT later.issue_id) AS count
       FROM catledger_review_issues later
       JOIN catledger_review_issue_members member
         ON member.uid = later.uid AND member.issue_id = later.issue_id
      WHERE later.uid = ? AND later.update_id = ? AND later.issue_id <> ?
        AND later.status = 'resolved' AND later.issue_type <> 'account_mapping'
        AND member.object_type = 'event'
        AND member.object_id IN (${part.map(() => '?').join(', ')})`,
    [uid, updateId, issue.issueId, ...part.flat()]
  )
  if (Number(laterResolved.count) > 0) throw importError('CONFLICT')
  }

  const applied = await applyAccountMappingEvents(connection, uid, updateId, events, eventMembers, decision, actionId, mappingIndex, true)
  const affected = applied.events
  const [revised] = await connection.execute(
    `UPDATE catledger_review_issues
        SET version = version + 1, resolved_action_id = ?
      WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'resolved'`,
    [actionId, uid, issue.issueId, Number(issue.version)]
  )
  if (revised.affectedRows !== 1) throw importError('CONFLICT')
  await createFollowUpIssues(connection, uid, updateId, affected)
  await updateMappingMemberVersions(connection, uid, updateId, affected, true)
  return applied
}

function createReviewIssueService({ getPool }) {
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
        if (!candidates.length) return commandResult(connection, uid, updateId, context.data)
        const actionId = await insertAction(connection, uid, { updateId, expectedVersion: version, appliedVersion: version + 1,
          actionType: 'refresh_account_groups', requestDigest, decision: { version: accountGroups.VERSION }, reasons: ['account_references_expanded'] })
        const existingIssues = await selectIssues(connection, uid, updateId, { includeMembers: false })
        const groups = new Map()
        for (const issue of existingIssues) {
          if (issue.issueType !== 'account_mapping' || !['open', 'resolved'].includes(issue.status) || !issue.accountContext?.recognized) continue
          const key = accountGroups.groupKey(issue.accountContext) + ':' + (issue.subject?.currency || 'CNY')
          if (key && !groups.has(key)) groups.set(key, { issue, count: issue.memberCount, added: 0 })
        }
        const events = await selectDomainEvents(connection, uid, updateId, candidates.map((item) => item.eventId), { forUpdate: true })
        const mappingIndex = createMappingIndex(await selectPaymentMappings(connection, uid, updateId))
        const referencesById = new Map(candidates.map(item => [item.eventId, item.references]))
        const componentIds = candidates.filter(item => item.references.some(ref => ref.memberRole.startsWith('payment_component_'))).map(item => item.eventId)
        // 同一旧问题在一个块内只升版一次，后续块见 superseded 后不再改写。
        for (const ids of chunks(componentIds.map(id => [id]))) await connection.execute(`UPDATE catledger_review_issues i JOIN catledger_review_issue_members m
          ON m.uid=i.uid AND m.issue_id=i.issue_id SET i.status='superseded',i.blocking=0,i.version=i.version+1,i.resolved_action_id=?
          WHERE i.uid=? AND i.update_id=? AND i.issue_type='account_mapping' AND i.status IN ('open','resolved')
            AND m.object_type='event' AND m.member_role='subject' AND m.object_id IN (${ids.map(() => '?').join(',')})`, [actionId,uid,updateId,...ids.flat()])
        const pairs = [], issueRows = [], memberRows = [], mappingRows = []
        for (const event of events) {
          const references = referencesById.get(event.eventId)
          let next = { ...event, fieldSources: { ...event.fieldSources, paymentAccountReferences: references, paymentAccountGroupsVersion: accountGroups.VERSION } }
          for (const reference of references) {
            const key = (reference.paymentMethodKey ? accountGroups.groupKey(reference) : event.eventId + ':' + reference.memberRole) + ':' + event.currency
            let group = groups.get(key)
            if (!group) {
              const issueId = randomUUID()
              const issueKey = digestParts(accountGroups.VERSION, updateId, key)
              issueRows.push([uid, issueId, updateId, issueKey, REVIEW_ISSUE_VERSION, 'account_mapping', 'open', 1, 1,
                'payment_reference_mapping_required', 0, 0, REVIEW_ISSUE_VERSION, JSON.stringify(['payment_reference_mapping_required'])])
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
              await stagePaymentReferenceMapping(connection, uid, updateId, event.eventId, reference, known, actionId, 'account', mappingIndex, mappingRows)
            }
            if (group.issue.status === 'resolved' && !known) {
              await connection.execute("UPDATE catledger_review_issues SET status = 'open', blocking = 1 WHERE uid = ? AND issue_id = ?", [uid, group.issue.issueId])
              group.issue.status = 'open'
            }
            memberRows.push([uid, randomUUID(), updateId, group.issue.issueId, 'event', event.eventId,
              event.version + 1, reference.memberRole, group.count + group.added])
            group.added += 1
          }
          pairs.push({ current: event, next })
        }
        await insertMany(connection, `INSERT INTO catledger_review_issues
          (uid,issue_id,update_id,issue_key,issue_key_version,issue_type,status,version,blocking,primary_reason_code,
           member_count,candidate_count,rule_version,reason_codes_json) VALUES`, issueRows)
        await insertMany(connection, `INSERT INTO catledger_review_issue_members
          (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order) VALUES`, memberRows)
        await insertMany(connection, `INSERT INTO catledger_finance_update_account_mapping_drafts
          (uid,draft_mapping_id,update_id,event_id,source_type,payment_method_key,payment_method_hint,mapping_action,account_id,action_id) VALUES`, mappingRows,
          'ON DUPLICATE KEY UPDATE payment_method_hint=VALUES(payment_method_hint),mapping_action=VALUES(mapping_action),account_id=VALUES(account_id),action_id=VALUES(action_id)')
        const savedEvents = await saveEvents(connection, uid, updateId, pairs, actionId)
        await updateMappingMemberVersions(connection, uid, updateId, savedEvents)
        for (const group of groups.values()) if (group.added) {
          const confirmed = group.created && group.priorAccounts.every(Boolean) && new Set(group.priorAccounts).size === 1
          await connection.execute(`UPDATE catledger_review_issues
            SET member_count = member_count + ?, version = version + 1,
              status = IF(?, 'resolved', status), blocking = IF(?, 0, blocking) WHERE uid = ? AND issue_id = ?`,
            [group.added, Boolean(confirmed), Boolean(confirmed), uid, group.issue.issueId])
        }
        await createFollowUpIssues(connection, uid, updateId, savedEvents)
        await recalculateUpdateCounts(connection, uid, updateId, version + 1, actionId, version)
        return commandResult(connection, uid, updateId, context.data)
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
        issueVersion: validateVersion(item.issueVersion),
        operation,
        decision,
        fields: item.fields,
        paymentRuleAction: item.paymentRuleAction
      }
    })
    if (new Set(decisions.map((item) => item.issueId)).size !== decisions.length) {
      throw importError('VALIDATION_ERROR')
    }

    return executeIdempotentMutation({       getPool,
      ...context,
      action: 'reviewIssues.resolveAccountMappings',
      operation: (connection, uid, data, requestDigest) => runAccountMappingBatch({
        decisions,
        begin: async function (items) {
          const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
          if (update.status !== 'review' || (Number(update.version) !== validateVersion(context.data.updateVersion))) throw importError('CONFLICT')
          const issues = new Map()
          const sortedIssueIds = items.map((item) => item.issueId).sort()
          for (const issueId of sortedIssueIds) {
            const issue = await selectIssue(connection, uid, issueId, { forUpdate: true })
            if (issue.updateId !== updateId || issue.issueType !== 'account_mapping') {
              throw importError('VALIDATION_ERROR')
            }
            if (Number(issue.version) !== items.find(item => item.issueId === issueId).issueVersion) throw importError('CONFLICT')
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
          return commandResult(connection, uid, updateId, context.data)
        }
      })
    })
  }

  async function setRepayment(context) {
    const updateId = validateUuid(context.data.updateId), eventId = validateUuid(context.data.eventId)
    const updateVersion = validateVersion(context.data.updateVersion), eventVersion = validateVersion(context.data.eventVersion)
    return executeIdempotentMutation({ getPool,...context,action:'financeUpdates.setRepayment',
      operation:async (connection,uid,data,requestDigest) => {
        const update = await selectUpdate(connection,uid,updateId,{ forUpdate:true })
        if (update.status !== 'review' || Number(update.version) !== updateVersion) throw importError('CONFLICT')
        const stored = await selectDomainEvents(connection,uid,updateId,[eventId],{ forUpdate:true })
        const [event] = await effectiveProjectedEvents(connection,uid,updateId,stored)
        if (!event || event.version !== eventVersion || !['ready','needs_action'].includes(event.status)) throw importError('CONFLICT')
        if (!['repayment','internal_transfer'].includes(event.economicNature)) throw importError('VALIDATION_ERROR')
        const { booking,inputForEvent } = require('./explicit-repayment')
        let decision = null
        if (data.repayment != null) {
          if (data.repayment.mode === 'review') decision = { mode:'review' }
          else {
            decision = booking.normalize(data.repayment,event.amountMinor)
            inputForEvent({ ...event,fieldSources:{ ...event.fieldSources,loanRepayment:decision } })
            // 整理决定不创建账户；已映射的草稿账户在整批入账时再次完整鉴权。
            const catalog = await loadReferenceCatalog(connection,uid,updateId,[event])
            const asset = catalog.accounts.get(decision.assetAccountId) || catalog.drafts.get(decision.assetAccountId)
            const debt = catalog.accounts.get(decision.liabilityAccountId) || catalog.drafts.get(decision.liabilityAccountId)
            if (!asset || !debt || !['cash','bank','wallet','other_asset'].includes(asset.type) || debt.type !== 'other_liability') throw importError('VALIDATION_ERROR')
          }
        }
        const actionId = await insertAction(connection,uid,{ updateId,expectedVersion:updateVersion,appliedVersion:updateVersion+1,
          actionType:'set_loan_repayment',requestDigest,decision:{ eventId,repayment:decision },reasons:['loan_repayment_decided'] })
        await connection.execute(`UPDATE catledger_review_issues i JOIN catledger_review_issue_members m ON m.uid=i.uid AND m.issue_id=i.issue_id
          SET i.status='superseded',i.blocking=0,i.version=i.version+1,i.resolved_action_id=?
          WHERE i.uid=? AND i.update_id=? AND m.object_id=? AND m.object_type='event' AND i.status='open'
          AND i.primary_reason_code='loan_repayment_required'`,[actionId,uid,updateId,eventId])
        const next = { ...event,fieldSources:{ ...event.fieldSources,loanRepayment:decision },
          reasonCodes:event.reasonCodes.filter(r=>r!=='loan_repayment_required' && r!=='blocking_issue_open') }
        const affected = await saveEvents(connection,uid,updateId,[{ current:event,next }],actionId)
        await updateMappingMemberVersions(connection,uid,updateId,affected)
        await createFollowUpIssues(connection,uid,updateId,affected)
        await recalculateUpdateCounts(connection,uid,updateId,updateVersion+1,actionId,updateVersion,0)
        return commandResult(connection,uid,updateId,data)
      } })
  }

  async function resolve(context) {
    const updateId = validateUuid(context.data.updateId)
    const issueId = validateUuid(context.data.issueId)
    const updateVersion = validateVersion(context.data.updateVersion)
    const issueVersion = validateVersion(context.data.issueVersion)
    const decision = validateDecision(context.data.decision)
    return executeIdempotentMutation({       getPool,
      ...context,
      action: 'reviewIssues.resolve',
      operation: async (connection, uid, data, requestDigest) => {
        const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        const issue = await selectIssue(connection, uid, issueId, { forUpdate: true })
        if (issue.updateId !== updateId || update.status !== 'review' || Number(update.version) !== updateVersion ||
            issue.status !== 'open' || Number(issue.version) !== issueVersion) throw importError('CONFLICT')
        assertDecisionMatchesIssue(issue, decision)
        if (data.selection != null && !['exclude_events'].includes(decision)) throw importError('VALIDATION_ERROR')
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
          await assertIdentityIntegrity(connection, uid, updateId, eventIds, { merge: true })
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
        } else if (decision === 'confirm_distinct' && issue.primaryReasonCode === 'historical_duplicate_candidate') {
          await require('./historical-duplicates').assertHistoricalChoice(connection, uid, updateId, issue)
        } else if (decision === 'confirm_distinct') {
          await assertIdentityIntegrity(connection, uid, updateId, eventIds)
          for (const part of chunks(eventIds.map(id => [id]))) await connection.execute(
            `UPDATE catledger_economic_event_relations SET status = 'rejected', version = version + 1
              WHERE uid = ? AND update_id = ? AND status = 'proposed'
                AND (source_event_id IN (${part.map(() => '?').join(', ')})
                  OR target_event_id IN (${part.map(() => '?').join(', ')}))`,
            [uid, updateId, ...part.flat(), ...part.flat()]
          )
          affected.push(...await saveEvents(connection, uid, updateId, events.map(event => ({ current: event,
            next: { ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes), resolvingIssueType: issue.issueType } })), actionId))
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
          affected.push(...await saveEvents(connection, uid, updateId, events.map(event => ({ current: event,
            next: { ...applyFields({ ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes) }, fields), resolvingIssueType: issue.issueType } })), actionId))
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
        } else if (decision === 'exclude_events') {
          let selected
          {
            const selection = data.selection || (data.eventIds == null ? { mode: 'all' } : { mode: 'include', eventIds: data.eventIds })
            if (!['all', 'include', 'all_except'].includes(selection.mode)) throw importError('VALIDATION_ERROR')
            const ids = selection.eventIds == null ? [] : selection.eventIds
            if (!Array.isArray(ids) || ids.length > 100 || (selection.mode === 'include' && !ids.length) || (selection.mode === 'all' && ids.length)) throw importError('VALIDATION_ERROR')
            const explicit = new Set(ids.map(validateUuid))
            if (explicit.size !== ids.length || [...explicit].some(id => !eventIds.includes(id))) throw importError('VALIDATION_ERROR')
            selected = selection.mode === 'all' ? new Set(eventIds) : selection.mode === 'include' ? explicit : new Set(eventIds.filter(id => !explicit.has(id)))
            if (!selected.size) throw importError('VALIDATION_ERROR')
          }
          if ([...selected].some((eventId) => !eventIds.includes(eventId))) throw importError('VALIDATION_ERROR')
          const pairs = events.filter(item => selected.has(item.eventId)).map(event => {
            const exclusionReasons = issue.issueType === 'account_mapping'
              ? ['manual_exclusion', 'account_mapping_excluded']
              : ['manual_exclusion']
            const next = {
              ...event,
              status: EVENT_STATUS.EXCLUDED,
              reasonCodes: unique([...resolvedReasons(issue.issueType, event.reasonCodes),
                ...exclusionReasons]),
              resolvingIssueType: issue.issueType
            }
            return { current: event, next }
          })
          affected.push(...await saveEvents(connection, uid, updateId, pairs, actionId))
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
          const [evidenceRows] = await connection.execute('SELECT event_id AS eventId FROM catledger_event_evidence WHERE uid = ? AND update_id = ? AND evidence_id = ? FOR UPDATE', [uid, updateId, evidenceId])
          if (!evidenceRows[0] || !eventIds.includes(evidenceRows[0].eventId)) throw importError('NOT_FOUND')
          const [result] = await connection.execute(
            `UPDATE catledger_event_evidence SET evidence_role = 'discarded'
              WHERE uid = ? AND update_id = ? AND evidence_id = ?`,
            [uid, updateId, evidenceId]
          )
          if (result.affectedRows !== 1) throw importError('NOT_FOUND')
          affected.push(...await saveEvents(connection, uid, updateId, events.map(event => ({ current: event,
            next: { ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes), resolvingIssueType: issue.issueType } })), actionId))
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
          await require('./historical-duplicates').assertHistoricalChoice(connection, uid, updateId, issue, transactionId)
          await assertNoLoanTransactions(connection, uid, [transactionId])
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
          await connection.execute(`UPDATE catledger_review_issues i SET status = 'superseded', blocking = 0, version = version + 1,
            resolved_action_id = ? WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND i.issue_id <> ?
            AND EXISTS (SELECT 1 FROM catledger_review_issue_members m WHERE m.uid = i.uid AND m.issue_id = i.issue_id
              AND m.object_type = 'event' AND m.object_id = ? AND m.member_role <> 'candidate')
            AND NOT EXISTS (SELECT 1 FROM catledger_review_issue_members m JOIN catledger_economic_events e
              ON e.uid = m.uid AND e.event_id = m.object_id WHERE m.uid = i.uid AND m.issue_id = i.issue_id
              AND m.object_type = 'event' AND m.member_role <> 'candidate' AND e.status <> 'excluded')`,
          [actionId, uid, updateId, issueId, event.eventId])
        }

        const partialExclusion = ['exclude_events'].includes(decision) && affected.length < events.length
        if (partialExclusion) {
          // 只移出本次已明确排除的成员，余下成员保留原阻塞问题和新版本。
          for (let offset = 0; offset < affected.length; offset += 100) {
            const ids = affected.slice(offset, offset + 100).map(event => event.eventId)
            await connection.execute(`DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND issue_id = ?
              AND object_type = 'event' AND object_id IN (${ids.map(() => '?').join(',')})`, [uid, updateId, issueId, ...ids])
          }
        }
        const [resolved] = await connection.execute(
          partialExclusion ? `UPDATE catledger_review_issues SET version = version + 1,
            member_count = (SELECT COUNT(*) FROM catledger_review_issue_members WHERE uid = ? AND issue_id = ?)
            WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'open'`
            : `UPDATE catledger_review_issues SET status = 'resolved', version = version + 1, blocking = 0,
              resolved_action_id = ? WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'open'`,
          partialExclusion ? [uid, issueId, uid, issueId, issueVersion] : [actionId, uid, issueId, issueVersion]
        )
        if (resolved.affectedRows !== 1) throw importError('CONFLICT')
        await createFollowUpIssues(connection, uid, updateId, affected)
        await refreshProjectedEvents(connection, uid, updateId, actionId)
        await recalculateUpdateCounts(connection, uid, updateId, appliedVersion, actionId, updateVersion, duplicateEvidenceDelta)
        return commandResult(connection, uid, updateId, data, issueId)
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
    return executeIdempotentMutation({       getPool,
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
        await createFollowUpIssues(connection, uid, updateId, affected)
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
        return commandResult(connection, uid, updateId, context.data)
      }
    })
  }

  return { setRepayment, resolve, resolveAccountMappings, reviseAccountMapping, refreshAccountGroups }
}

module.exports = { createReviewIssueService, runAccountMappingBatch }
