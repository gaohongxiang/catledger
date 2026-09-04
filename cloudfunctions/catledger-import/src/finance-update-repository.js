const { randomUUID } = require('node:crypto')

const { digestParts } = require('./digest')
const { PLAN_VERSION } = require('./domain-versions')
const { importError } = require('./errors')
const { buildPaymentMethodKey } = require('./identity')
const { paymentAccountDetails, paymentReferenceKey } = require('./payment-account')

const INSERT_CHUNK_SIZE = 100

function parseJson(value, fallback) {
  if (value == null) return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (error) {
    return fallback
  }
}

async function insertMany(connection, prefix, rows) {
  for (let index = 0; index < rows.length; index += INSERT_CHUNK_SIZE) {
    const part = rows.slice(index, index + INSERT_CHUNK_SIZE)
    const placeholders = part.map((row) => `(${row.map(() => '?').join(', ')})`).join(', ')
    await connection.execute(`${prefix} ${placeholders}`, part.flat())
  }
}

function publicUpdate(row) {
  if (!row) return null
  return {
    updateId: row.updateId,
    status: row.status,
    version: Number(row.version),
    planVersion: row.planVersion,
    requiresReorganization: ['draft', 'failed', 'review'].includes(row.status) && row.planVersion !== PLAN_VERSION,
    currentActionId: row.currentActionId || null,
    counts: {
      sources: Number(row.sourceCount),
      validEvidence: Number(row.validEvidenceCount),
      duplicateEvidence: Number(row.duplicateEvidenceCount),
      finalEvents: Number(row.finalEventCount),
      postedEvents: Number(row.postedEventCount),
      readyEvents: Number(row.readyEventCount),
      needsActionEvents: Number(row.needsActionEventCount),
      excludedEvents: Number(row.excludedEventCount)
    },
    errorCode: row.errorCode || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

async function selectUpdate(connection, uid, updateId, { forUpdate = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT update_id AS updateId, status, version, plan_version AS planVersion,
            current_action_id AS currentActionId, source_count AS sourceCount,
            valid_evidence_count AS validEvidenceCount,
            duplicate_evidence_count AS duplicateEvidenceCount,
            final_event_count AS finalEventCount, posted_event_count AS postedEventCount,
            ready_event_count AS readyEventCount,
            needs_action_event_count AS needsActionEventCount,
            excluded_event_count AS excludedEventCount,
            error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt
       FROM catledger_finance_updates
      WHERE uid = ? AND update_id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, updateId]
  )
  if (!rows[0]) throw importError('NOT_FOUND')
  return rows[0]
}

async function selectSourceBatches(connection, uid, batchIds, { forUpdate = false } = {}) {
  if (batchIds.length === 0) return []
  const [rows] = await connection.execute(
    `SELECT b.batch_id AS batchId, b.import_id AS importId,
            b.source_profile_id AS sourceProfileId, b.state AS batchState,
            b.source_type AS sourceType, b.source_format AS sourceFormat,
            b.parser_version AS parserVersion,
            b.normalization_version AS normalizationVersion,
            b.identity_version AS identityVersion,
            b.total_row_count AS totalRowCount, b.valid_row_count AS validRowCount,
            b.invalid_row_count AS invalidRowCount,
            f.state AS fileState, f.original_file_name AS fileName,
            f.content_sha256 AS contentSha256, f.cloud_file_id AS fileID
       FROM catledger_import_batches b
       JOIN catledger_import_files f
         ON f.uid = b.uid AND f.import_id = b.import_id
      WHERE b.uid = ? AND b.batch_id IN (${batchIds.map(() => '?').join(', ')})
      ORDER BY b.created_at, b.batch_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, ...batchIds]
  )
  return rows
}

async function assertBatchesAvailable(connection, uid, batchIds) {
  const batches = await selectSourceBatches(connection, uid, batchIds, { forUpdate: true })
  if (batches.length !== batchIds.length) throw importError('NOT_FOUND')
  if (batches.some((batch) => batch.batchState !== 'review_ready' || batch.fileState !== 'review_ready' || !batch.contentSha256)) {
    throw importError('CONFLICT')
  }
  const [active] = await connection.execute(
    `SELECT s.batch_id AS batchId
       FROM catledger_finance_update_sources s
       JOIN catledger_finance_updates u
         ON u.uid = s.uid AND u.update_id = s.update_id
      WHERE s.uid = ? AND s.batch_id IN (${batchIds.map(() => '?').join(', ')})
        AND u.status NOT IN ('abandoned', 'undone')
      LIMIT 1 FOR UPDATE`,
    [uid, ...batchIds]
  )
  if (active[0]) throw importError('CONFLICT')
  const byId = new Map(batches.map((batch) => [batch.batchId, batch]))
  return batchIds.map((batchId) => byId.get(batchId))
}

async function insertAction(connection, uid, {
  updateId, expectedVersion, appliedVersion, actionType, requestDigest,
  idempotencyKeyDigest = null, status = 'applied', decision = null, reasons = []
}) {
  const actionId = randomUUID()
  await connection.execute(
    `INSERT INTO catledger_finance_actions
       (uid, action_id, update_id, expected_update_version, applied_update_version,
        action_type, idempotency_key_digest, request_digest, status,
        decision_json, reason_codes_json, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3),
             CASE WHEN ? = 'applied' THEN CURRENT_TIMESTAMP(3) ELSE NULL END)`,
    [
      uid, actionId, updateId, expectedVersion, appliedVersion, actionType,
      digestParts('finance-action-v2', uid, updateId, actionType, idempotencyKeyDigest || requestDigest), requestDigest, status,
      decision == null ? null : JSON.stringify(decision), JSON.stringify(reasons), status
    ]
  )
  return actionId
}

async function createUpdate(connection, uid, batchIds, requestDigest, idempotencyKeyDigest) {
  const batches = await assertBatchesAvailable(connection, uid, batchIds)
  const updateId = randomUUID()
  await connection.execute(
    `INSERT INTO catledger_finance_updates
       (uid, update_id, status, version, plan_version, source_count)
     VALUES (?, ?, 'draft', 1, ?, ?)`,
    [uid, updateId, PLAN_VERSION, batches.length]
  )
  await insertMany(connection, `INSERT INTO catledger_finance_update_sources
    (uid, source_id, update_id, source_order, import_id, batch_id, source_profile_id,
     source_type_snapshot, source_format_snapshot, parser_version, normalization_version,
     identity_version, file_name_snapshot, file_content_sha256, total_row_count,
     valid_row_count, invalid_row_count) VALUES`, batches.map((batch, sourceOrder) => [
    uid, randomUUID(), updateId, sourceOrder, batch.importId, batch.batchId, batch.sourceProfileId,
    batch.sourceType, batch.sourceFormat, batch.parserVersion, batch.normalizationVersion,
    batch.identityVersion, batch.fileName, batch.contentSha256, Number(batch.totalRowCount),
    Number(batch.validRowCount), Number(batch.invalidRowCount)
  ]))
  const actionId = await insertAction(connection, uid, {
    updateId, expectedVersion: 0, appliedVersion: 1, actionType: 'create_update', requestDigest,
    idempotencyKeyDigest,
    reasons: ['finance_update_created']
  })
  await connection.execute(
    `UPDATE catledger_finance_updates SET current_action_id = ?
      WHERE uid = ? AND update_id = ?`,
    [actionId, uid, updateId]
  )
  return publicUpdate(await selectUpdate(connection, uid, updateId))
}

async function categoryIndexes(connection, uid) {
  const [categories] = await connection.execute(
    `SELECT category_id AS categoryId, kind, system_key AS systemKey
       FROM catledger_categories
      WHERE uid = ? AND archived_at IS NULL`,
    [uid]
  )
  const [mappings] = await connection.execute(
    `SELECT source_type AS sourceType, alias_key AS aliasKey, category_id AS categoryId
       FROM catledger_import_category_mappings
      WHERE uid = ?`,
    [uid]
  )
  return {
    byId: new Map(categories.map((category) => [category.categoryId, category])),
    bySystemKey: new Map(categories.filter((category) => category.systemKey)
      .map((category) => [`${category.kind}:${category.systemKey}`, category.categoryId])),
    mappings: new Map(mappings.map((mapping) => [`${mapping.sourceType}:${mapping.aliasKey}`, mapping.categoryId]))
  }
}

function suggestedCategory(row, indexes) {
  const evidence = parseJson(row.categoryEvidence, {})
  for (const aliasKey of Array.isArray(evidence.aliasKeys) ? evidence.aliasKeys : []) {
    const categoryId = indexes.mappings.get(`${row.sourceType}:${aliasKey}`)
    const category = indexes.byId.get(categoryId)
    if (category && category.kind === row.direction) return categoryId
  }
  return indexes.bySystemKey.get(`${row.direction}:${evidence.deterministicSystemKey}`) || null
}

async function selectPlanningRows(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT r.row_id AS rowId, r.batch_id AS batchId, s.import_id AS importId,
            s.source_order AS sourceOrder, s.source_type_snapshot AS sourceType,
            s.source_profile_id AS sourceProfileId,
            r.source_row_number AS rowNumber, r.parse_state AS parseState,
            r.identity_id AS identityId, r.identity_state AS identityState,
            r.source_transaction_id_raw AS sourceTransactionId,
            r.source_order_id_raw AS sourceOrderId,
            r.source_merchant_order_id_raw AS sourceMerchantOrderId,
            r.status_raw AS rawStatus, r.transaction_type_raw AS rawTransactionType,
            r.normalized_local_date AS localDate, r.normalized_local_at AS localAt,
            r.normalized_utc_at AS utcAt, r.timezone_offset_minutes AS timezoneOffsetMinutes,
            r.normalized_amount_minor AS amountMinor, r.currency,
            r.normalized_direction AS direction,
            r.normalized_transaction_type AS transactionType,
            r.economic_effect AS economicEffect, r.payment_method_key AS paymentMethodKey,
            r.payment_method_raw AS paymentMethod,
            r.category_evidence_json AS categoryEvidence,
            r.counterparty_raw AS counterparty, r.item_raw AS item, r.note_raw AS sourceNote,
            m.mapping_action AS mappingAction, m.account_id AS mappedAccountId,
            legacy.transaction_id AS existingTransactionId,
            t.version AS existingTransactionVersion
       FROM catledger_finance_update_sources s
       JOIN catledger_import_rows r
         ON r.uid = s.uid AND r.batch_id = s.batch_id
       LEFT JOIN catledger_import_account_mappings m
         ON m.uid = r.uid AND m.source_type = s.source_type_snapshot
        AND m.payment_method_key = r.payment_method_key AND m.disabled_at IS NULL
       LEFT JOIN catledger_import_transaction_links legacy
         ON legacy.uid = r.uid AND legacy.row_id = r.row_id
       LEFT JOIN catledger_transactions t
         ON t.uid = legacy.uid AND t.transaction_id = legacy.transaction_id AND t.deleted_at IS NULL
      WHERE s.uid = ? AND s.update_id = ?
      ORDER BY s.source_order, r.source_row_number, r.row_id`,
    [uid, updateId]
  )
  const identityIds = [...new Set(rows.map((row) => row.identityId).filter(Boolean))]
  const linkedByIdentity = new Map()
  if (identityIds.length > 0) {
    const [links] = await connection.execute(
      `SELECT r.identity_id AS identityId, linked.transaction_id AS transactionId,
              t.version AS transactionVersion
         FROM catledger_import_rows r
         JOIN catledger_event_evidence evidence
           ON evidence.uid = r.uid AND evidence.row_id = r.row_id
          AND evidence.evidence_role <> 'discarded'
         JOIN catledger_economic_event_transactions linked
           ON linked.uid = evidence.uid AND linked.event_id = evidence.event_id
          AND linked.role IN ('primary', 'refund_transaction', 'repayment_allocation', 'historical_primary')
         JOIN catledger_transactions t
           ON t.uid = linked.uid AND t.transaction_id = linked.transaction_id
          AND t.deleted_at IS NULL
        WHERE r.uid = ? AND r.identity_id IN (${identityIds.map(() => '?').join(', ')})
        ORDER BY linked.created_at, linked.link_id`,
      [uid, ...identityIds]
    )
    links.forEach((link) => {
      if (!linkedByIdentity.has(link.identityId)) linkedByIdentity.set(link.identityId, link)
    })
  }
  const indexes = await categoryIndexes(connection, uid)
  return rows.map((row) => {
    const linked = linkedByIdentity.get(row.identityId)
    return {
      ...row,
      existingTransactionId: row.existingTransactionId || linked && linked.transactionId || null,
      existingTransactionVersion: row.existingTransactionVersion || linked && linked.transactionVersion || null,
      sourceOrder: Number(row.sourceOrder),
      rowNumber: Number(row.rowNumber),
      timezoneOffsetMinutes: row.timezoneOffsetMinutes == null ? null : Number(row.timezoneOffsetMinutes),
      amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
      suggestedCategoryId: suggestedCategory(row, indexes)
    }
  })
}

async function selectPaymentMappings(connection, uid, updateId) {
  const [saved] = await connection.execute(
    `SELECT mapping.source_type AS sourceType,
            mapping.payment_method_key AS paymentMethodKey,
            mapping.payment_method_hint AS paymentMethodHint,
            mapping.mapping_action AS mappingAction,
            mapping.account_id AS accountId,
            account.type AS accountType,
            'history' AS mappingScope
       FROM catledger_import_account_mappings mapping
       LEFT JOIN catledger_accounts account
         ON account.uid = mapping.uid AND account.account_id = mapping.account_id
      WHERE mapping.uid = ? AND mapping.disabled_at IS NULL`,
    [uid]
  )
  const [drafts] = await connection.execute(
    `SELECT draft.source_type AS sourceType,
            draft.payment_method_key AS paymentMethodKey,
            draft.payment_method_hint AS paymentMethodHint,
            draft.mapping_action AS mappingAction,
            draft.account_id AS accountId,
            COALESCE(account.type, draft_account.type) AS accountType,
            'batch' AS mappingScope
       FROM catledger_finance_update_account_mapping_drafts draft
       LEFT JOIN catledger_accounts account
         ON account.uid = draft.uid AND account.account_id = draft.account_id
       LEFT JOIN catledger_finance_update_account_drafts draft_account
         ON draft_account.uid = draft.uid
        AND draft_account.draft_account_id = draft.account_id
      WHERE draft.uid = ? AND draft.update_id = ?
      ORDER BY draft.created_at, draft.draft_mapping_id`,
    [uid, updateId]
  )
  // 仓储只负责返回事实，不能在这里依赖查询/数组顺序提前裁决。
  // 历史、本批及同级冲突统一交给 account-mapping-policy；否则同一
  // PaymentReference 的旧值会在进入领域层前被静默覆盖，规划与重算
  // 也会得到不同答案。
  return saved.concat(drafts)
}

async function selectDraftPaymentMappings(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT source_type AS sourceType, payment_method_key AS paymentMethodKey,
            payment_method_hint AS paymentMethodHint,
            mapping_action AS mappingAction, account_id AS accountId
       FROM catledger_finance_update_account_mapping_drafts
      WHERE uid = ? AND update_id = ?
      ORDER BY updated_at, draft_mapping_id`,
    [uid, updateId]
  )
  const byKey = new Map()
  rows.forEach((mapping) => {
    byKey.set(paymentReferenceKey(mapping), mapping)
  })
  return [...byKey.values()]
}

async function restoreDraftPaymentMappings(connection, uid, updateId, events, mappings, actionId) {
  if (!mappings.length || !events.length) return
  const byKey = new Map(mappings.map((mapping) => [
    paymentReferenceKey(mapping),
    mapping
  ]))
  for (const event of events) {
    const projection = event.fieldSources && event.fieldSources.fundsProjection
    const references = [
      { sourceType: event.sourceType, paymentMethodKey: event.paymentMethodKey, label: '' },
      projection && projection.from,
      projection && projection.to
    ].filter(Boolean)
    const restoredKeys = new Set()
    for (const reference of references) {
      if (!reference.sourceType || !reference.paymentMethodKey) continue
      const key = paymentReferenceKey(reference)
      if (restoredKeys.has(key)) continue
      const mapping = byKey.get(key)
      if (!mapping) continue
      restoredKeys.add(key)
      await connection.execute(
        `INSERT INTO catledger_finance_update_account_mapping_drafts
           (uid, draft_mapping_id, update_id, event_id, source_type,
            payment_method_key, payment_method_hint, mapping_action, account_id, action_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uid, randomUUID(), updateId, event.eventId, mapping.sourceType,
          mapping.paymentMethodKey,
          String(mapping.paymentMethodHint || reference.label || '').slice(0, 128),
          mapping.mappingAction, mapping.accountId || null, actionId]
      )
    }
  }
}

async function deleteDraftPlan(connection, uid, updateId) {
  await connection.execute('DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ?', [uid, updateId])
  await connection.execute('DELETE FROM catledger_review_issues WHERE uid = ? AND update_id = ?', [uid, updateId])
  await connection.execute('DELETE FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ?', [uid, updateId])
  await connection.execute('DELETE FROM catledger_economic_event_transactions WHERE uid = ? AND update_id = ?', [uid, updateId])
  await connection.execute('DELETE FROM catledger_event_evidence WHERE uid = ? AND update_id = ?', [uid, updateId])
  await connection.execute('DELETE FROM catledger_economic_events WHERE uid = ? AND update_id = ?', [uid, updateId])
}

async function persistPlan(connection, uid, updateId, plan) {
  await insertMany(connection, `INSERT INTO catledger_economic_events
    (uid, event_id, batch_id, update_id, event_key, event_key_version, event_type,
     state, status, flow_direction, economic_nature, ledger_account_id,
     counterparty_ledger_account_id, event_local_date, event_local_at, event_utc_at,
     timezone_offset_minutes, amount_minor, currency, category_id, manual_field_mask,
     field_sources_json, reason_codes_json, event_core_digest, rule_version, version) VALUES`,
  plan.events.map((event) => [
    uid, event.eventId, event.batchId, updateId, event.eventKey, event.eventKeyVersion,
    event.economicNature, event.status, event.status, event.flowDirection, event.economicNature,
    event.ledgerAccountId, event.counterpartyLedgerAccountId, event.localDate, event.localAt,
    event.utcAt, event.timezoneOffsetMinutes, event.amountMinor, event.currency, event.categoryId,
    event.manualFieldMask, JSON.stringify(event.fieldSources), JSON.stringify(event.reasonCodes),
    event.eventKey, plan.planVersion, event.version
  ]))
  await insertMany(connection, `INSERT INTO catledger_event_evidence
    (uid, evidence_id, update_id, event_id, row_id, evidence_role, field_mask,
     relation_rule_version) VALUES`, plan.evidence.map((evidence) => [
    uid, evidence.evidenceId, updateId, evidence.eventId, evidence.rowId,
    evidence.evidenceRole, evidence.fieldMask, plan.planVersion
  ]))
  await insertMany(connection, `INSERT INTO catledger_economic_event_relations
    (uid, relation_id, update_id, relation_key, relation_key_version, relation_type,
     status, version, source_event_id, target_event_id, amount_minor, currency,
     manual, rule_version, reason_codes_json) VALUES`, plan.relations.map((relation) => [
    uid, relation.relationId, updateId, relation.relationKey, relation.relationKeyVersion,
    relation.relationType, relation.status, relation.version, relation.sourceEventId,
    relation.targetEventId, relation.amountMinor, relation.currency, relation.manual ? 1 : 0,
    plan.planVersion, JSON.stringify(relation.reasonCodes)
  ]))
  await insertMany(connection, `INSERT INTO catledger_review_issues
    (uid, issue_id, update_id, issue_key, issue_key_version, issue_type, status,
     version, blocking, primary_reason_code, member_count, candidate_count,
     rule_version, reason_codes_json) VALUES`, plan.issues.map((issue) => [
    uid, issue.issueId, updateId, issue.issueKey, issue.issueKeyVersion, issue.issueType,
    issue.status, issue.version, issue.blocking ? 1 : 0, issue.primaryReasonCode,
    issue.memberCount, issue.candidateCount, issue.ruleVersion, JSON.stringify(issue.reasonCodes)
  ]))
  await insertMany(connection, `INSERT INTO catledger_review_issue_members
    (uid, member_id, update_id, issue_id, object_type, object_id, object_version,
     member_role, sort_order) VALUES`, plan.members.map((member) => [
    uid, member.memberId, updateId, member.issueId, member.objectType, member.objectId,
    member.objectVersion, member.memberRole, member.sortOrder
  ]))

  for (const event of plan.events) {
    for (const transactionId of event.existingTransactionIds) {
      const [[transaction]] = await connection.execute(
        `SELECT version FROM catledger_transactions
          WHERE uid = ? AND transaction_id = ? AND deleted_at IS NULL LIMIT 1`,
        [uid, transactionId]
      )
      if (!transaction) continue
      await connection.execute(
        `INSERT IGNORE INTO catledger_economic_event_transactions
           (uid, link_id, update_id, event_id, transaction_id, role,
            creation_method, rule_version, transaction_version)
         VALUES (?, ?, ?, ?, ?, 'historical_primary', 'reused', ?, ?)`,
        [uid, randomUUID(), updateId, event.eventId, transactionId, plan.planVersion, Number(transaction.version)]
      )
    }
  }
}

function publicSource(row) {
  return {
    sourceId: row.sourceId,
    sourceOrder: Number(row.sourceOrder),
    importId: row.importId,
    batchId: row.batchId,
    sourceType: row.sourceType,
    sourceFormat: row.sourceFormat,
    fileName: row.fileName,
    parserVersion: row.parserVersion,
    normalizationVersion: row.normalizationVersion,
    identityVersion: row.identityVersion,
    summary: {
      total: Number(row.totalRowCount),
      valid: Number(row.validRowCount),
      invalid: Number(row.invalidRowCount)
    }
  }
}

async function selectSources(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT source_id AS sourceId, source_order AS sourceOrder, import_id AS importId,
            batch_id AS batchId, source_type_snapshot AS sourceType,
            source_format_snapshot AS sourceFormat, file_name_snapshot AS fileName,
            parser_version AS parserVersion, normalization_version AS normalizationVersion,
            identity_version AS identityVersion, total_row_count AS totalRowCount,
            valid_row_count AS validRowCount, invalid_row_count AS invalidRowCount
       FROM catledger_finance_update_sources
      WHERE uid = ? AND update_id = ? ORDER BY source_order`,
    [uid, updateId]
  )
  return rows.map(publicSource)
}

function publicEvent(row) {
  const fieldSources = parseJson(row.fieldSources, {})
  return {
    eventId: row.eventId,
    status: row.status,
    version: Number(row.version),
    flowDirection: row.flowDirection,
    economicNature: row.economicNature,
    ledgerAccountId: row.ledgerAccountId || null,
    counterpartyLedgerAccountId: row.counterpartyLedgerAccountId || null,
    localAt: row.localAt,
    amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
    currency: row.currency,
    categoryId: row.categoryId || null,
    reasonCodes: parseJson(row.reasonCodes, []),
    fundsProjection: fieldSources.fundsProjection || null,
    repaymentAllocations: fieldSources.repaymentAllocations || [],
    evidenceCount: Number(row.evidenceCount),
    primaryEvidence: row.primaryRowId ? {
      rowId: row.primaryRowId,
      sourceType: row.sourceType,
      fileName: row.fileName,
      rowNumber: Number(row.rowNumber),
      counterparty: row.counterparty || '',
      item: row.item || '',
      note: row.sourceNote || '',
      paymentMethod: row.paymentMethod || ''
    } : null
  }
}

async function selectEvents(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT e.event_id AS eventId, e.status, e.version,
            e.flow_direction AS flowDirection, e.economic_nature AS economicNature,
            e.ledger_account_id AS ledgerAccountId,
            e.counterparty_ledger_account_id AS counterpartyLedgerAccountId,
            e.event_local_at AS localAt, e.amount_minor AS amountMinor, e.currency,
            e.category_id AS categoryId, e.reason_codes_json AS reasonCodes,
            e.field_sources_json AS fieldSources,
            COUNT(all_evidence.row_id) AS evidenceCount,
            primary_evidence.row_id AS primaryRowId,
            r.source_row_number AS rowNumber, r.counterparty_raw AS counterparty,
            r.item_raw AS item, r.note_raw AS sourceNote,
            r.payment_method_raw AS paymentMethod,
            s.source_type_snapshot AS sourceType, s.file_name_snapshot AS fileName
       FROM catledger_economic_events e
       LEFT JOIN catledger_event_evidence all_evidence
         ON all_evidence.uid = e.uid AND all_evidence.update_id = e.update_id
        AND all_evidence.event_id = e.event_id AND all_evidence.evidence_role <> 'discarded'
       LEFT JOIN catledger_event_evidence primary_evidence
         ON primary_evidence.uid = e.uid AND primary_evidence.update_id = e.update_id
        AND primary_evidence.event_id = e.event_id AND primary_evidence.evidence_role = 'primary'
       LEFT JOIN catledger_import_rows r
         ON r.uid = primary_evidence.uid AND r.row_id = primary_evidence.row_id
       LEFT JOIN catledger_finance_update_sources s
         ON s.uid = r.uid AND s.update_id = e.update_id AND s.batch_id = r.batch_id
      WHERE e.uid = ? AND e.update_id = ?
      GROUP BY e.event_id, e.status, e.version, e.flow_direction, e.economic_nature,
               e.ledger_account_id, e.counterparty_ledger_account_id, e.event_local_at,
               e.amount_minor, e.currency, e.category_id, e.reason_codes_json,
               e.field_sources_json,
               primary_evidence.row_id, r.source_row_number, r.counterparty_raw,
               r.item_raw, r.note_raw, r.payment_method_raw,
               s.source_type_snapshot, s.file_name_snapshot
      ORDER BY e.event_local_at, e.event_id`,
    [uid, updateId]
  )
  return rows.map(publicEvent)
}

async function selectEventEvidence(connection, uid, eventId) {
  const [events] = await connection.execute(
    `SELECT event_id AS eventId, update_id AS updateId
       FROM catledger_economic_events
      WHERE uid = ? AND event_id = ? LIMIT 1`,
    [uid, eventId]
  )
  if (!events[0]) throw importError('NOT_FOUND')
  const [rows] = await connection.execute(
    `SELECT evidence.evidence_id AS evidenceId, evidence.evidence_role AS evidenceRole,
            import_row.row_id AS rowId, import_row.source_row_number AS rowNumber,
            import_row.source_locator AS sourceLocator, import_row.raw_fields_json AS rawFields,
            import_row.raw_snapshot_version AS rawSnapshotVersion, import_row.parser_version AS parserVersion,
            source.source_type_snapshot AS sourceType,
            source.file_name_snapshot AS fileName
       FROM catledger_event_evidence evidence
       JOIN catledger_import_rows import_row
         ON import_row.uid = evidence.uid AND import_row.row_id = evidence.row_id
       JOIN catledger_finance_update_sources source
         ON source.uid = evidence.uid AND source.update_id = evidence.update_id
        AND source.batch_id = import_row.batch_id
      WHERE evidence.uid = ? AND evidence.update_id = ? AND evidence.event_id = ?
      ORDER BY FIELD(evidence.evidence_role, 'primary', 'supporting', 'duplicate', 'discarded'),
               import_row.source_row_number, evidence.evidence_id`,
    [uid, events[0].updateId, eventId]
  )
  return {
    eventId,
    updateId: events[0].updateId,
    evidence: rows.map((row) => ({
      evidenceId: row.evidenceId,
      evidenceRole: row.evidenceRole,
      rowId: row.rowId,
      rowNumber: Number(row.rowNumber),
      sourceLocator: row.sourceLocator,
      sourceType: row.sourceType,
      fileName: row.fileName,
      rawSnapshotVersion: row.rawSnapshotVersion,
      parserVersion: row.parserVersion,
      rawFields: parseJson(row.rawFields, {})
    }))
  }
}

function safeIssueSummary(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .replace(/\d{8,}/gu, function (digits) { return '****' + digits.slice(-4) })
    .trim()
    .slice(0, 96)
}

function publicIssue(row) {
  const subjectFieldSources = parseJson(row.subjectFieldSources, {})
  const fundsProjection = subjectFieldSources.fundsProjection || null
  const subjectDetails = row.subjectEventId
    ? paymentAccountDetails(row.subjectSourceType, row.subjectPaymentMethod)
    : null
  const subjectAccount = subjectDetails ? {
    sourceType: row.subjectSourceType || '',
    paymentMethodKey: buildPaymentMethodKey(row.subjectSourceType, row.subjectPaymentMethod),
    label: subjectDetails.displayName,
    recognized: subjectDetails.recognized,
    fundsSide: 'ordinary',
    accountId: row.subjectLedgerAccountId || null
  } : null
  const mappingSide = row.subjectMemberRole === 'mapping_from'
    ? 'from'
    : row.subjectMemberRole === 'mapping_to' ? 'to' : ''
  const mappingReference = row.issueType === 'account_mapping' && fundsProjection && mappingSide
    ? fundsProjection[mappingSide]
    : null
  const mappingAccount = mappingReference ? {
    ...mappingReference,
    fundsSide: mappingSide,
    accountId: mappingSide === 'from'
      ? row.subjectLedgerAccountId || null
      : row.subjectCounterpartyLedgerAccountId || null
  } : null
  const projectedAccount = row.issueType === 'transfer_accounts' && fundsProjection
    ? !row.subjectLedgerAccountId ? fundsProjection.from
      : !row.subjectCounterpartyLedgerAccountId ? fundsProjection.to : null
    : null
  const account = mappingAccount || projectedAccount || subjectAccount
  const reasonCodes = parseJson(row.reasonCodes, [])
  return {
    issueId: row.issueId,
    issueType: row.issueType,
    status: row.status,
    version: Number(row.version),
    blocking: Boolean(row.blocking),
    primaryReasonCode: row.primaryReasonCode,
    memberCount: Number(row.memberCount),
    candidateCount: Number(row.candidateCount),
    reasonCodes,
    subject: row.subjectEventId ? {
      eventId: row.subjectEventId,
      status: row.subjectEventStatus,
      flowDirection: row.subjectFlowDirection,
      economicNature: row.subjectEconomicNature,
      ledgerAccountId: row.subjectLedgerAccountId || null,
      counterpartyLedgerAccountId: row.subjectCounterpartyLedgerAccountId || null,
      fundsProjection,
      repaymentAllocations: subjectFieldSources.repaymentAllocations || [],
      localAt: row.subjectLocalAt,
      amountMinor: row.subjectAmountMinor == null ? null : String(row.subjectAmountMinor),
      currency: row.subjectCurrency,
      primaryEvidence: {
        sourceType: row.subjectSourceType || '',
        fileName: safeIssueSummary(row.subjectFileName),
        counterparty: safeIssueSummary(row.subjectCounterparty),
        item: safeIssueSummary(row.subjectItem),
        note: '',
        paymentMethod: subjectDetails ? subjectDetails.displayName : ''
      }
    } : null,
    accountContext: account ? {
      label: account.label,
      recognized: Boolean(account.paymentMethodKey) && account.recognized !== false,
      sourceType: account.sourceType || '',
      paymentMethodKey: account.paymentMethodKey || null,
      fundsSide: account.fundsSide || '',
      accountId: account.accountId || null,
      unresolvedReason: account.unresolvedReason || '',
      item: safeIssueSummary(row.subjectItem),
      counterparty: safeIssueSummary(row.subjectCounterparty),
      defaultIgnored: reasonCodes.includes('source_account_ignored_default')
    } : null
  }
}

async function selectIssues(connection, uid, updateId, { status = null } = {}) {
  const values = [uid, updateId]
  const statusSql = status ? ' AND issue.status = ?' : ''
  if (status) values.push(status)
  const [rows] = await connection.execute(
    `SELECT issue.issue_id AS issueId, issue.issue_type AS issueType,
            issue.status, issue.version, issue.blocking,
            issue.primary_reason_code AS primaryReasonCode,
            issue.member_count AS memberCount,
            issue.candidate_count AS candidateCount,
            issue.reason_codes_json AS reasonCodes,
            subject.object_id AS subjectEventId,
            subject.member_role AS subjectMemberRole,
            subject_event.status AS subjectEventStatus,
            subject_event.flow_direction AS subjectFlowDirection,
            subject_event.economic_nature AS subjectEconomicNature,
            subject_event.ledger_account_id AS subjectLedgerAccountId,
            subject_event.counterparty_ledger_account_id AS subjectCounterpartyLedgerAccountId,
            subject_event.field_sources_json AS subjectFieldSources,
            subject_event.event_local_at AS subjectLocalAt,
            subject_event.amount_minor AS subjectAmountMinor,
            subject_event.currency AS subjectCurrency,
            source.source_type_snapshot AS subjectSourceType,
            source.file_name_snapshot AS subjectFileName,
            source_row.payment_method_raw AS subjectPaymentMethod,
            source_row.item_raw AS subjectItem,
            source_row.counterparty_raw AS subjectCounterparty
       FROM catledger_review_issues issue
       LEFT JOIN catledger_review_issue_members subject
         ON subject.uid = issue.uid AND subject.issue_id = issue.issue_id
       AND subject.object_type = 'event' AND subject.sort_order = 0
       LEFT JOIN catledger_economic_events subject_event
         ON subject_event.uid = subject.uid AND subject_event.update_id = issue.update_id
        AND subject_event.event_id = subject.object_id
       LEFT JOIN catledger_event_evidence primary_evidence
         ON primary_evidence.uid = subject.uid
        AND primary_evidence.update_id = issue.update_id
        AND primary_evidence.event_id = subject.object_id
        AND primary_evidence.evidence_role = 'primary'
       LEFT JOIN catledger_import_rows source_row
         ON source_row.uid = primary_evidence.uid
        AND source_row.row_id = primary_evidence.row_id
       LEFT JOIN catledger_finance_update_sources source
         ON source.uid = source_row.uid AND source.update_id = issue.update_id
        AND source.batch_id = source_row.batch_id
      WHERE issue.uid = ? AND issue.update_id = ?${statusSql}
      ORDER BY issue.status = 'open' DESC, issue.created_at, issue.issue_id`,
    values
  )
  return rows.map(publicIssue)
}

async function listOptions(connection, uid, updateId) {
  const [accounts] = await connection.execute(
    `SELECT account_id AS accountId, name, type, nature, currency
       FROM catledger_accounts WHERE uid = ? AND archived_at IS NULL ORDER BY created_at, account_id`,
    [uid]
  )
  const [categories] = await connection.execute(
    `SELECT category_id AS categoryId, kind, name, system_key AS systemKey
       FROM catledger_categories WHERE uid = ? AND archived_at IS NULL ORDER BY kind, sort_order, category_id`,
    [uid]
  )
  const [accountDrafts] = await connection.execute(
    `SELECT draft_account_id AS accountId, name, type, nature, currency
       FROM catledger_finance_update_account_drafts
      WHERE uid = ? AND update_id = ? AND materialized_at IS NULL
      ORDER BY created_at, draft_account_id`,
    [uid, updateId]
  )
  const [accountMappingDrafts] = await connection.execute(
    `SELECT event_id AS eventId, source_type AS sourceType,
            payment_method_key AS paymentMethodKey, payment_method_hint AS paymentMethodHint,
            mapping_action AS mappingAction, account_id AS accountId
       FROM catledger_finance_update_account_mapping_drafts
      WHERE uid = ? AND update_id = ?
      ORDER BY created_at, draft_mapping_id`,
    [uid, updateId]
  )
  return { accounts, accountDrafts, accountMappingDrafts, categories }
}

async function selectActiveAccounts(connection, uid) {
  const [accounts] = await connection.execute(
    `SELECT account_id AS accountId, name, type, nature, currency
       FROM catledger_accounts
      WHERE uid = ? AND archived_at IS NULL
      ORDER BY created_at, account_id`,
    [uid]
  )
  return accounts
}

async function getUpdateView(connection, uid, updateId, { includeEvents = true, includeOptions = true } = {}) {
  const update = publicUpdate(await selectUpdate(connection, uid, updateId))
  const result = {
    update,
    sources: await selectSources(connection, uid, updateId),
    issues: await selectIssues(connection, uid, updateId),
    events: includeEvents ? await selectEvents(connection, uid, updateId) : []
  }
  if (includeOptions) Object.assign(result, await listOptions(connection, uid, updateId))
  const [postings] = await connection.execute(
    `SELECT created_transaction_count AS createdTransactionCount,
            reused_transaction_count AS reusedTransactionCount
       FROM catledger_finance_update_postings
      WHERE uid = ? AND update_id = ? AND state = 'completed'
      ORDER BY completed_at DESC LIMIT 1`,
    [uid, updateId]
  )
  result.posting = postings[0] ? {
    createdTransactionCount: Number(postings[0].createdTransactionCount),
    reusedTransactionCount: Number(postings[0].reusedTransactionCount)
  } : null
  return result
}

module.exports = {
  createUpdate,
  deleteDraftPlan,
  getUpdateView,
  insertAction,
  insertMany,
  parseJson,
  persistPlan,
  publicIssue,
  publicUpdate,
  selectActiveAccounts,
  selectDraftPaymentMappings,
  selectEvents,
  selectEventEvidence,
  selectIssues,
  selectPaymentMappings,
  selectPlanningRows,
  selectSourceBatches,
  selectSources,
  selectUpdate,
  restoreDraftPaymentMappings
}
