const { randomUUID } = require('node:crypto')

const { buildCategoryEvidence } = require('./category-mapping')
const { digestParts } = require('./digest')
const { importError } = require('./errors')
const { insertAction } = require('./finance-update-repository')
const {
  buildPaymentMethodKey,
  buildRowIdentity,
  buildSourceProfile
} = require('./identity')
const { ensureNormalizedForIdentity } = require('./parsers/normalize')

const INSERT_CHUNK_SIZE = 200

function chunks(values, size = INSERT_CHUNK_SIZE) {
  const result = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function insertRows(connection, prefix, rows, suffix = '') {
  if (rows.length === 0) return
  for (const part of chunks(rows)) {
    const placeholders = part.map((row) => `(${row.map(() => '?').join(', ')})`).join(', ')
    await connection.execute(`${prefix} ${placeholders} ${suffix}`, part.flat())
  }
}

async function selectImportFile(connection, uid, importId, { forUpdate = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT import_id AS importId, state, original_file_name AS fileName,
            declared_size AS declaredSize, actual_size AS actualSize,
            file_extension AS extension, mime_type AS mimeType,
            content_sha256 AS contentSha256,
            storage_object_key AS storageObjectKey,
            cloud_file_id AS fileID, error_code AS errorCode,
            version, content_deleted_at AS contentDeletedAt
       FROM catledger_import_files
      WHERE uid = ? AND import_id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, importId]
  )
  if (!rows[0]) throw importError('NOT_FOUND')
  return rows[0]
}

async function selectLatestBatch(connection, uid, importId) {
  const [rows] = await connection.execute(
    `SELECT batch_id AS batchId, state, source_type AS sourceType,
            source_format AS sourceFormat, parser_name AS parserName,
            parser_version AS parserVersion,
            normalization_version AS normalizationVersion,
            identity_version AS identityVersion,
            raw_snapshot_version AS rawSnapshotVersion,
            statement_start_local AS statementStartLocal,
            statement_end_local AS statementEndLocal,
            timezone_offset_minutes AS timezoneOffsetMinutes,
            total_row_count AS totalRowCount,
            valid_row_count AS validRowCount,
            invalid_row_count AS invalidRowCount,
            pending_row_count AS pendingRowCount,
            posted_row_count AS postedRowCount,
            error_code AS errorCode
       FROM catledger_import_batches
      WHERE uid = ? AND import_id = ?
      ORDER BY created_at DESC, batch_id DESC
      LIMIT 1`,
    [uid, importId]
  )
  return rows[0] || null
}

function publicImport(file, batch = null) {
  return {
    importId: file.importId,
    state: file.state,
    fileName: file.fileName,
    declaredSize: Number(file.declaredSize),
    actualSize: file.actualSize == null ? null : Number(file.actualSize),
    extension: file.extension,
    errorCode: file.errorCode,
    contentState: file.contentDeletedAt ? 'deleted' : file.fileID ? 'available' : 'awaiting_upload',
    sourceType: batch && batch.sourceType,
    sourceFormat: batch && batch.sourceFormat,
    version: Number(file.version)
  }
}

function publicBatch(batch) {
  if (!batch) return null
  return {
    batchId: batch.batchId,
    state: batch.state,
    sourceType: batch.sourceType,
    sourceFormat: batch.sourceFormat,
    parserVersion: batch.parserVersion,
    normalizationVersion: batch.normalizationVersion,
    statementStartLocal: batch.statementStartLocal,
    statementEndLocal: batch.statementEndLocal,
    timezoneOffsetMinutes: batch.timezoneOffsetMinutes == null ? null : Number(batch.timezoneOffsetMinutes),
    summary: {
      total: Number(batch.totalRowCount),
      valid: Number(batch.validRowCount),
      invalid: Number(batch.invalidRowCount),
      pending: Number(batch.pendingRowCount),
      posted: Number(batch.postedRowCount)
    },
    errorCode: batch.errorCode
  }
}

async function findDuplicateFile(connection, uid, importId, contentSha256) {
  const [rows] = await connection.execute(
    `SELECT import_id AS importId, state
       FROM catledger_import_files
      WHERE uid = ? AND content_sha256 = ? AND import_id <> ?
      LIMIT 1 FOR UPDATE`,
    [uid, contentSha256, importId]
  )
  return rows[0] || null
}

async function selectActiveUpdateForImport(connection, uid, importId) {
  const [rows] = await connection.execute(
    `SELECT u.update_id AS updateId, u.status, u.version
       FROM catledger_finance_update_sources s
       JOIN catledger_finance_updates u
         ON u.uid = s.uid AND u.update_id = s.update_id
      WHERE s.uid = ? AND s.import_id = ?
        AND u.status NOT IN ('abandoned', 'undone')
      ORDER BY u.created_at DESC, u.update_id DESC
      LIMIT 1 FOR UPDATE`,
    [uid, importId]
  )
  return rows[0] || null
}

async function replaceUnpostedUpdate(connection, uid, update, requestDigest, idempotencyKeyDigest) {
  if (!['draft', 'failed', 'review'].includes(update.status)) throw importError('CONFLICT')
  const expectedVersion = Number(update.version)
  const appliedVersion = expectedVersion + 1
  const actionId = await insertAction(connection, uid, {
    updateId: update.updateId,
    expectedVersion,
    appliedVersion,
    actionType: 'replace_unposted_update',
    requestDigest,
    idempotencyKeyDigest,
    reasons: ['unposted_update_replaced_by_reparse']
  })
  const [result] = await connection.execute(
    `UPDATE catledger_finance_updates
        SET status = 'abandoned', version = ?, current_action_id = ?
      WHERE uid = ? AND update_id = ? AND version = ?
        AND status IN ('draft', 'failed', 'review')`,
    [appliedVersion, actionId, uid, update.updateId, expectedVersion]
  )
  if (result.affectedRows !== 1) throw importError('CONFLICT')
  return update.updateId
}

async function upsertSourceProfile(connection, uid, sourceType, candidate) {
  const profile = buildSourceProfile({ sourceType, candidate })
  const sourceProfileId = randomUUID()
  await connection.execute(
    `INSERT INTO catledger_import_source_profiles
       (uid, source_profile_id, source_type, profile_key, key_version, masked_display_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       last_seen_at = CURRENT_TIMESTAMP(3),
       masked_display_name = COALESCE(VALUES(masked_display_name), masked_display_name)`,
    [uid, sourceProfileId, sourceType, profile.profileKey, profile.keyVersion, profile.maskedDisplayName]
  )
  const [rows] = await connection.execute(
    `SELECT source_profile_id AS sourceProfileId
       FROM catledger_import_source_profiles
      WHERE uid = ? AND source_type = ? AND profile_key = ?
      LIMIT 1 FOR UPDATE`,
    [uid, sourceType, profile.profileKey]
  )
  return { ...profile, sourceProfileId: rows[0].sourceProfileId }
}

async function selectIdentities(connection, uid, sourceType, identityKeys) {
  const result = new Map()
  for (const part of chunks([...new Set(identityKeys)])) {
    if (part.length === 0) continue
    const [rows] = await connection.execute(
      `SELECT identity_id AS identityId, identity_key AS identityKey,
              core_digest AS coreDigest
         FROM catledger_source_identities
        WHERE uid = ? AND source_type = ?
          AND identity_key IN (${part.map(() => '?').join(', ')})
        FOR UPDATE`,
      [uid, sourceType, ...part]
    )
    rows.forEach((row) => result.set(row.identityKey, row))
  }
  return result
}

async function resolveIdentities(connection, uid, sourceType, sourceProfile, fileSha256, documentRows) {
  const candidates = []
  for (const row of documentRows) {
    if (row.parseState !== 'valid') continue
    ensureNormalizedForIdentity(row)
    candidates.push({
      row,
      candidate: buildRowIdentity({
        sourceType,
        sourceProfileKey: sourceProfile.profileKey,
        fileSha256,
        row
      })
    })
  }

  let existing = await selectIdentities(connection, uid, sourceType, candidates.map((item) => item.candidate.identityKey))
  const inserts = candidates.filter((item) => !existing.has(item.candidate.identityKey)).map((item) => [
    uid,
    randomUUID(),
    sourceProfile.sourceProfileId,
    sourceType,
    item.candidate.kind,
    item.candidate.identityKey,
    item.candidate.coreDigest,
    item.candidate.identityVersion,
    item.candidate.coreDigestVersion
  ])
  const attemptedNewKeys = new Set(inserts.map((insert) => insert[5]))
  await insertRows(
    connection,
    `INSERT IGNORE INTO catledger_source_identities
       (uid, identity_id, source_profile_id, source_type, identity_kind,
        identity_key, core_digest, identity_version, core_digest_version) VALUES`,
    inserts
  )
  existing = await selectIdentities(connection, uid, sourceType, candidates.map((item) => item.candidate.identityKey))

  const identityIds = [...existing.values()].map((item) => item.identityId)
  const linkedTransactions = new Map()
  for (const part of chunks(identityIds)) {
    if (part.length === 0) continue
    const [rows] = await connection.execute(
      `SELECT r.identity_id AS identityId, l.transaction_id AS transactionId
         FROM catledger_import_rows r
         JOIN catledger_import_transaction_links l
           ON l.uid = r.uid AND l.row_id = r.row_id
        WHERE r.uid = ? AND r.identity_id IN (${part.map(() => '?').join(', ')})
        ORDER BY l.created_at, l.link_id`,
      [uid, ...part]
    )
    rows.forEach((row) => {
      if (!linkedTransactions.has(row.identityId)) linkedTransactions.set(row.identityId, row.transactionId)
    })
  }

  const byRow = new Map()
  candidates.forEach(({ row, candidate }) => {
    const identity = existing.get(candidate.identityKey)
    const identityState = identity.coreDigest !== candidate.coreDigest
      ? 'identity_conflict'
      : attemptedNewKeys.has(candidate.identityKey)
        ? 'new'
        : 'exact_duplicate'
    byRow.set(row, {
      ...candidate,
      identityId: identity.identityId,
      identityState,
      linkedTransactionId: linkedTransactions.get(identity.identityId) || null
    })
  })
  return byRow
}

function eventType(row) {
  if ((row.normalized.transactionType === 'payment' || row.normalized.transactionType === 'fee') &&
      (row.normalized.direction === 'income' || row.normalized.direction === 'expense')) {
    return row.normalized.direction
  }
  return row.normalized.transactionType
}

function rowOutcome(row, identity) {
  if (row.parseState !== 'valid' || row.eligibility === 'non_postable') {
    return { state: 'ignored', disposition: 'skip', reason: 'not_postable', processingState: 'ignored' }
  }
  if (identity.identityState === 'identity_conflict') {
    return { state: 'pending', disposition: 'pending', reason: 'identity_conflict', processingState: 'pending' }
  }
  if (identity.identityState === 'exact_duplicate' && identity.linkedTransactionId) {
    return { state: 'linked', disposition: 'reuse', reason: 'exact_duplicate', processingState: 'linked' }
  }
  return {
    state: 'pending',
    disposition: 'pending',
    reason: row.eligibility === 'postable' ? 'mapping_required' : 'semantic_review_required',
    processingState: 'pending'
  }
}

async function persistDocumentRows(connection, uid, batchId, sourceProfile, fileSha256, document) {
  const identities = await resolveIdentities(
    connection, uid, document.descriptor.sourceType, sourceProfile, fileSha256, document.rows
  )
  const rowInserts = []
  const eventInserts = []
  const evidenceInserts = []
  const decisionInserts = []
  let valid = 0
  let invalid = 0
  let pending = 0

  for (const row of document.rows) {
    const rowId = randomUUID()
    const identity = identities.get(row)
    const outcome = identity
      ? rowOutcome(row, identity)
      : { state: 'ignored', disposition: 'skip', reason: 'invalid_row', processingState: 'ignored' }
    const issues = [...row.issues]
    if (identity && identity.identityState === 'identity_conflict') {
      issues.push({ code: 'source_identity_conflict', field: 'identity', severity: 'error' })
    } else if (identity && identity.identityState === 'exact_duplicate') {
      issues.push({ code: 'source_identity_duplicate', field: 'identity', severity: 'info' })
    }
    if (identity && identity.kind === 'physical_record') {
      issues.push({ code: 'source_identity_physical_only', field: 'identity', severity: 'warning' })
    }

    if (row.parseState === 'valid') valid += 1
    else invalid += 1
    if (outcome.processingState === 'pending') pending += 1

    const paymentMethodKey = buildPaymentMethodKey(document.descriptor.sourceType, row.normalized.paymentMethod)
    const categoryEvidence = buildCategoryEvidence(document.descriptor.sourceType, row)
    rowInserts.push([
      uid, rowId, batchId, identity && identity.identityId, row.rowNumber, row.sourceLocator,
      row.parseState, identity ? identity.identityState : 'not_evaluated', outcome.processingState,
      row.raw.transactionTime || null, row.raw.amount || null, row.raw.direction || null,
      row.raw.status || null, row.raw.transactionType || null, row.raw.counterparty || null,
      row.raw.item || null, row.raw.paymentMethod || null, row.raw.note || null,
      row.identifiers.transactionId || null, row.identifiers.orderId || null,
      row.identifiers.merchantOrderId || null, row.normalized.localDate, row.normalized.localAt,
      row.normalized.utcAt, row.normalized.timezoneOffsetMinutes, row.normalized.amountMinor,
      row.normalized.currency, row.normalized.direction, row.normalized.transactionType,
      row.normalized.economicEffect, paymentMethodKey, JSON.stringify(categoryEvidence),
      identity && identity.identityKey, identity && identity.coreDigest,
      issues[0] ? issues[0].code : null, JSON.stringify(issues), JSON.stringify(row.rawFields),
      document.rawSnapshotVersion, document.descriptor.parserVersion,
      document.descriptor.normalizationVersion
    ])

    if (row.parseState === 'valid') {
      const eventId = randomUUID()
      const decisionId = randomUUID()
      const eventDigest = digestParts(
        'economic-event-v1', identity.coreDigest, row.normalized.localAt, row.sourceLocator
      )
      eventInserts.push([
        uid, eventId, batchId, eventType(row), outcome.state, eventDigest, 'economic-event-v1'
      ])
      evidenceInserts.push([uid, eventId, rowId, 'primary', 'event-evidence-v1'])
      decisionInserts.push([
        uid, decisionId, eventId, 1, outcome.disposition, 'system', outcome.reason,
        null, null, digestParts('decision-v1', outcome.disposition, outcome.reason)
      ])
    }
  }

  await insertRows(connection, `INSERT INTO catledger_import_rows
    (uid, row_id, batch_id, identity_id, source_row_number, source_locator,
     parse_state, identity_state, processing_state, transaction_time_raw, amount_raw,
     direction_raw, status_raw, transaction_type_raw, counterparty_raw, item_raw,
     payment_method_raw, note_raw, source_transaction_id_raw, source_order_id_raw,
     source_merchant_order_id_raw, normalized_local_date, normalized_local_at,
     normalized_utc_at, timezone_offset_minutes, normalized_amount_minor, currency,
     normalized_direction, normalized_transaction_type, economic_effect, payment_method_key,
     category_evidence_json,
     observed_identity_key, observed_core_digest, primary_issue_code, issues_json,
     raw_fields_json, raw_snapshot_version, parser_version, normalization_version) VALUES`, rowInserts)
  await insertRows(connection, `INSERT INTO catledger_economic_events
    (uid, event_id, batch_id, event_type, state, event_core_digest, rule_version) VALUES`, eventInserts)
  await insertRows(connection, `INSERT INTO catledger_event_evidence
    (uid, event_id, row_id, evidence_role, relation_rule_version) VALUES`, evidenceInserts)
  await insertRows(connection, `INSERT INTO catledger_import_decisions
    (uid, decision_id, event_id, decision_version, disposition, decision_origin,
     reason_code, account_id, category_id, decision_digest) VALUES`, decisionInserts)
  return { total: document.rows.length, valid, invalid, pending }
}

async function persistParsedImport(connection, uid, {
  importId, fileID, contentSha256, actualSize, timezoneOffsetMinutes, document,
  requestDigest, idempotencyKeyDigest
}) {
  const file = await selectImportFile(connection, uid, importId, { forUpdate: true })
  if (file.state === 'review_ready' || file.state === 'committed') {
    const batch = await selectLatestBatch(connection, uid, importId)
    return { import: publicImport(file, batch), batch: publicBatch(batch) }
  }
  if (!['awaiting_upload', 'failed'].includes(file.state)) throw importError('CONFLICT')

  const duplicate = await findDuplicateFile(connection, uid, importId, contentSha256)
  if (duplicate) {
    await connection.execute(
      `UPDATE catledger_import_files
          SET state = 'duplicate', cloud_file_id = ?, actual_size = ?, error_code = NULL,
              version = version + 1
        WHERE uid = ? AND import_id = ?`,
      [fileID, actualSize, uid, importId]
    )
    const current = await selectImportFile(connection, uid, importId)
    if (duplicate.state !== 'committed') {
      const duplicateBatch = await selectLatestBatch(connection, uid, duplicate.importId)
      if (duplicateBatch && duplicateBatch.state === 'review_ready' &&
          ['review_ready', 'discarded'].includes(duplicate.state)) {
        const activeUpdate = await selectActiveUpdateForImport(connection, uid, duplicate.importId)
        const replacedUpdateId = activeUpdate
          ? await replaceUnpostedUpdate(
            connection, uid, activeUpdate, requestDigest, idempotencyKeyDigest
          )
          : null
        if (duplicate.state === 'discarded') {
          await connection.execute(
            `UPDATE catledger_import_files
                SET state = 'review_ready', version = version + 1, error_code = NULL
              WHERE uid = ? AND import_id = ? AND state = 'discarded'`,
            [uid, duplicate.importId]
          )
        }
        const reusableFile = await selectImportFile(connection, uid, duplicate.importId)
        return {
          import: publicImport(reusableFile, duplicateBatch),
          batch: publicBatch(duplicateBatch),
          reusedImportId: duplicate.importId,
          replacedUpdateId: replacedUpdateId || undefined,
          duplicateDisposition: replacedUpdateId ? 'replaced_unposted_update' : 'reused_unposted'
        }
      }
      throw importError('CONFLICT')
    }
    return {
      import: publicImport(current),
      batch: null,
      duplicateImportId: duplicate.importId,
      duplicateDisposition: 'already_posted'
    }
  }

  const sourceProfile = await upsertSourceProfile(
    connection, uid, document.descriptor.sourceType, document.metadata.sourceProfile
  )
  const batchId = randomUUID()
  const parseFingerprint = digestParts(
    'parse-run-v1', contentSha256, document.descriptor.parserVersion,
    document.descriptor.normalizationVersion, document.identityVersion, timezoneOffsetMinutes
  )
  await connection.execute(
    `INSERT INTO catledger_import_batches
       (uid, batch_id, import_id, source_profile_id, state, source_type, source_format,
        parser_name, parser_version, normalization_version, identity_version,
        raw_snapshot_version, parse_fingerprint, statement_start_local,
        statement_end_local, timezone_offset_minutes)
     VALUES (?, ?, ?, ?, 'review_ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uid, batchId, importId, sourceProfile.sourceProfileId,
      document.descriptor.sourceType, document.descriptor.sourceFormat,
      document.descriptor.parserName, document.descriptor.parserVersion,
      document.descriptor.normalizationVersion, document.identityVersion,
      document.rawSnapshotVersion, parseFingerprint,
      document.metadata.statementStartLocal, document.metadata.statementEndLocal,
      timezoneOffsetMinutes
    ]
  )
  const counts = await persistDocumentRows(connection, uid, batchId, sourceProfile, contentSha256, document)
  await connection.execute(
    `UPDATE catledger_import_batches
        SET total_row_count = ?, valid_row_count = ?, invalid_row_count = ?,
            pending_row_count = ?, completed_at = CURRENT_TIMESTAMP(3)
      WHERE uid = ? AND batch_id = ?`,
    [counts.total, counts.valid, counts.invalid, counts.pending, uid, batchId]
  )
  await connection.execute(
    `UPDATE catledger_import_files
        SET state = 'review_ready', actual_size = ?, content_sha256 = ?, cloud_file_id = ?,
            mime_type = ?, error_code = NULL, version = version + 1
      WHERE uid = ? AND import_id = ?`,
    [
      actualSize, contentSha256, fileID,
      document.descriptor.sourceFormat.endsWith('xlsx')
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv',
      uid, importId
    ]
  )
  const current = await selectImportFile(connection, uid, importId)
  const batch = await selectLatestBatch(connection, uid, importId)
  return { import: publicImport(current, batch), batch: publicBatch(batch) }
}

async function markParseFailure(connection, uid, importId, fileID, errorCode) {
  const file = await selectImportFile(connection, uid, importId, { forUpdate: true })
  if (file.state === 'review_ready' || file.state === 'committed') {
    const batch = await selectLatestBatch(connection, uid, importId)
    return { import: publicImport(file, batch), batch: publicBatch(batch) }
  }
  if (!['awaiting_upload', 'failed'].includes(file.state)) throw importError('CONFLICT')
  await connection.execute(
    `UPDATE catledger_import_files
        SET state = 'failed', cloud_file_id = ?, error_code = ?, version = version + 1
      WHERE uid = ? AND import_id = ?`,
    [fileID, errorCode, uid, importId]
  )
  const current = await selectImportFile(connection, uid, importId)
  return { import: publicImport(current), batch: null }
}

module.exports = {
  markParseFailure,
  persistParsedImport,
  publicBatch,
  publicImport,
  selectImportFile,
  selectLatestBatch
}
