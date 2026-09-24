const { commandResult } = require('../command-result')
const { digestParts } = require('../digest')
const { REVIEW_ISSUE_VERSION } = require('../domain-versions')
const { insertAction, selectIssues, selectPlanningRows, selectPaymentMappings, selectUpdate } = require('../finance-update-repository')
const { validateVersion, validateUuid } = require('../validation')
const { createMappingIndex, reconcileProjectedAccounts } = require('../source-funds')
const { saveEvent, selectDomainEvents, saveEvents } = require('./event-store')
const { selectIssue, selectMembers, updateMappingMemberVersions, createFollowUpIssues } = require('./issue-store')
const { refreshProjectedEvents, recalculateUpdateCounts, effectiveProjectedEvents, effectiveProjectedEventsFromIndex } = require('./reconciliation')
const { chunks, insertMany } = require('../sql-batch')
const accountGroups = require('../payment-account-groups')
const { randomUUID } = require('node:crypto')
const { importError } = require('../errors')
const { stageAccountDraft } = require('../account-draft')
const { EVENT_STATUS, unique } = require('../organizer-model')
const { paymentReferenceKey } = require('../payment-account')
const { FIELD_MASK, resolvedReasons, applyFields } = require('./policy')

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

async function refreshAccountGroups(connection, uid, data, requestDigest, { updateId, version }, input) {
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
        if (!candidates.length) return commandResult(connection, uid, updateId, input)
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
        return commandResult(connection, uid, updateId, input)
      }

async function resolveAccountMappings(connection, uid, data, requestDigest, { updateId, decisions }, input) {
  return runAccountMappingBatch({
        decisions,
        begin: async function (items) {
          const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
          if (update.status !== 'review' || (Number(update.version) !== validateVersion(input.updateVersion))) throw importError('CONFLICT')
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
          return commandResult(connection, uid, updateId, input)
        }
      })
}

async function reviseAccountMapping(connection, uid, data, requestDigest, { updateId, issueId, updateVersion, issueVersion, decision }, input) {
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
        return commandResult(connection, uid, updateId, input)
      }

module.exports = { stageAccountMappings, applyMappedAccount, stagePaymentReferenceMapping, stageProjectedAccountMappings, runAccountMappingBatch, resolveOpenAccountMapping, reviseResolvedAccountMapping, refreshAccountGroups, resolveAccountMappings, reviseAccountMapping }
