const { randomUUID } = require('node:crypto')

const { digestParts, sha256 } = require('./digest')
const { importError } = require('./errors')
const { createFinanceUpdateCore } = require('./finance-update-core')
const { createFinanceUpdateMaintenance } = require('./finance-update-maintenance')
const { createFinanceUpdatePosting } = require('./finance-update-posting')
const { getImport } = require('./import-query')
const {
  markParseFailure,
  persistParsedImport,
  publicImport,
  selectImportFile
} = require('./import-repository')
const { executeIdempotentMutation, executeUserRead } = require('./import-transaction')
const { commitImport } = require('./ledger-writer')
const { parseEvidenceFile } = require('./parsers')
const { createReviewIssueService } = require('./review-issue-service')
const {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_BYTES,
  normalizeFileName,
  validateActualContent,
  validateDeclaredSize,
  validateTimezoneOffset,
  validateUuid,
  validateVersion
} = require('./validation')

const PARSE_FAILURE_CODES = new Set([
  'CSV_COLUMN_LIMIT_EXCEEDED',
  'CSV_RECORD_LIMIT_EXCEEDED',
  'FILE_ENCODING_INVALID',
  'FILE_FORMAT_UNSUPPORTED',
  'FILE_SIZE_INVALID',
  'VALIDATION_ERROR'
])
const MAX_FILES_PER_UPDATE = 5

async function diagnosePhase(phase, operation) {
  try {
    return await operation()
  } catch (error) {
    if (error && typeof error === 'object' && !error.diagnosticPhase) error.diagnosticPhase = phase
    throw error
  }
}

function createObjectKey(uid, importId, extension) {
  const userScope = digestParts('storage-scope-v1', uid).slice(0, 32)
  return `catledger-import/${userScope}/${importId}/${randomUUID()}.${extension}`
}

async function markContentDeleted(getPool, provider, subjectHash, importId, fileID) {
  return executeUserRead({
    getPool,
    provider,
    subjectHash,
    operation: async (connection, uid) => {
      await connection.execute(
        `UPDATE catledger_import_files
            SET content_deleted_at = COALESCE(content_deleted_at, CURRENT_TIMESTAMP(3))
          WHERE uid = ? AND import_id = ? AND cloud_file_id = ?`,
        [uid, importId, fileID]
      )
    }
  })
}

function createImportService({ getPool, storage }) {
  const financeUpdates = createFinanceUpdateCore({ getPool })
  const maintenance = createFinanceUpdateMaintenance({ getPool })
  const reviewIssues = createReviewIssueService({ getPool })
  const posting = createFinanceUpdatePosting({ getPool })

  async function insertPreparedFile(connection, uid, data) {
    const { fileName, extension } = normalizeFileName(data.fileName)
    const declaredSize = validateDeclaredSize(data.size)
    const importId = randomUUID()
    const cloudPath = createObjectKey(uid, importId, extension)
    await connection.execute(
      `INSERT INTO catledger_import_files
         (uid, import_id, state, original_file_name, declared_size,
          file_extension, storage_object_key)
       VALUES (?, ?, 'awaiting_upload', ?, ?, ?, ?)`,
      [uid, importId, fileName, declaredSize, extension, cloudPath]
    )
    return {
      importId,
      cloudPath,
      fileName,
      acceptedFormats: [...ACCEPTED_EXTENSIONS],
      maxBytes: MAX_FILE_BYTES,
      version: 1
    }
  }

  async function prepare(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'imports.prepare',
      operation: (connection, uid, data) => insertPreparedFile(connection, uid, data)
    })
  }

  async function prepareMany(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'imports.prepareMany',
      operation: async (connection, uid, data) => {
        if (!Array.isArray(data.files) || data.files.length < 1 || data.files.length > MAX_FILES_PER_UPDATE) {
          throw importError('VALIDATION_ERROR')
        }
        const files = []
        for (const file of data.files) {
          if (!file || typeof file !== 'object' || Array.isArray(file)) throw importError('VALIDATION_ERROR')
          files.push(await insertPreparedFile(connection, uid, file))
        }
        return { files, maxFiles: MAX_FILES_PER_UPDATE }
      }
    })
  }

  async function parseWithAction(context, action) {
    const importId = validateUuid(context.data.importId)
    const timezoneOffsetMinutes = validateTimezoneOffset(context.data.timezoneOffsetMinutes)
    const fileID = context.data.fileID
    const file = await diagnosePhase('select_file', () => executeUserRead({
      getPool,
      ...context,
      operation: (connection, uid) => selectImportFile(connection, uid, importId)
    }))
    if (!['awaiting_upload', 'failed', 'review_ready', 'committed', 'duplicate'].includes(file.state)) {
      throw importError('CONFLICT')
    }
    if (file.state === 'review_ready' || file.state === 'committed') {
      return executeUserRead({
        getPool,
        ...context,
        operation: (connection, uid) => getImport(connection, uid, { importId, pageSize: 1 })
      })
    }
    if (file.state === 'duplicate') {
      return executeIdempotentMutation({
        getPool,
        ...context,
        action,
        operation: async () => { throw importError('CONFLICT') }
      })
    }

    const downloaded = await diagnosePhase('download_file', () => storage.downloadExact(fileID, file.storageObjectKey))
    const content = await diagnosePhase('validate_file', () => validateActualContent(downloaded))
    const contentSha256 = sha256(content)
    let document
    try {
      document = await diagnosePhase('parse_file', () => parseEvidenceFile({
        content,
        extension: file.extension,
        timezoneOffsetMinutes
      }))
    } catch (error) {
      if (!PARSE_FAILURE_CODES.has(error.publicCode)) throw error
      return executeIdempotentMutation({
        getPool,
        ...context,
        action,
        operation: (connection, uid) => markParseFailure(
          connection, uid, importId, fileID, error.publicCode
        )
      })
    }

    const result = await diagnosePhase('persist_file', () => executeIdempotentMutation({
      getPool,
      ...context,
      action,
      operation: (connection, uid, data, requestDigest, idempotencyKeyDigest) => persistParsedImport(connection, uid, {
        importId,
        fileID,
        contentSha256,
        actualSize: content.length,
        timezoneOffsetMinutes,
        document,
        requestDigest,
        idempotencyKeyDigest
      })
    }))
    const uploadedCopyIsRedundant = Boolean(
      result.duplicateImportId || result.reusedImportId
    )
    if (uploadedCopyIsRedundant && await storage.remove(fileID)) {
      await markContentDeleted(getPool, context.provider, context.subjectHash, importId, fileID)
      if (result.import.importId === importId) result.import.contentState = 'deleted'
    }
    return result
  }

  async function parse(context) {
    return parseWithAction(context, 'imports.parse')
  }

  async function parseFile(context) {
    return parseWithAction(context, 'imports.parseFile')
  }

  async function get(context) {
    const importId = validateUuid(context.data.importId)
    if (context.data.includeOptions != null && typeof context.data.includeOptions !== 'boolean') {
      throw importError('VALIDATION_ERROR')
    }
    return executeUserRead({
      getPool,
      ...context,
      operation: (connection, uid) => getImport(connection, uid, {
        importId,
        pageSize: context.data.pageSize,
        cursor: context.data.cursor,
        includeOptions: context.data.includeOptions !== false
      })
    })
  }

  async function getFile(context) {
    return get(context)
  }

  async function cleanup(context, importId, fileID, result) {
    if (result.contentState === 'deleted') return result
    if (!fileID || !await storage.remove(fileID)) {
      result.contentState = fileID ? 'cleanup_pending' : 'deleted'
      return result
    }
    await markContentDeleted(getPool, context.provider, context.subjectHash, importId, fileID)
    result.contentState = 'deleted'
    return result
  }

  async function commit(context) {
    const importId = validateUuid(context.data.importId)
    const version = validateVersion(context.data.version)
    const file = await executeUserRead({
      getPool,
      ...context,
      operation: (connection, uid) => selectImportFile(connection, uid, importId)
    })
    const result = await executeIdempotentMutation({
      getPool,
      ...context,
      action: 'imports.commit',
      operation: (connection, uid, data, requestDigest) => commitImport(
        connection,
        uid,
        { importId, version, decisions: data.decisions },
        requestDigest
      )
    })
    return cleanup(context, importId, file.fileID, result)
  }

  async function discardWithAction(context, action) {
    const importId = validateUuid(context.data.importId)
    const version = validateVersion(context.data.version)
    const result = await executeIdempotentMutation({
      getPool,
      ...context,
      action,
      operation: async (connection, uid) => {
        const file = await selectImportFile(connection, uid, importId, { forUpdate: true })
        if (file.state === 'committed') throw importError('CONFLICT')
        if (file.state !== 'discarded') {
          if (Number(file.version) !== version) throw importError('CONFLICT')
          await connection.execute(
            `UPDATE catledger_import_files
                SET state = 'discarded', version = version + 1, error_code = NULL
              WHERE uid = ? AND import_id = ? AND version = ?`,
            [uid, importId, version]
          )
        }
        const current = await selectImportFile(connection, uid, importId)
        return { ...publicImport(current), fileID: current.fileID }
      }
    })
    const fileID = result.fileID
    delete result.fileID
    return cleanup(context, importId, fileID, result)
  }

  async function discard(context) {
    return discardWithAction(context, 'imports.discard')
  }

  async function discardFile(context) {
    return discardWithAction(context, 'imports.discardFile')
  }

  async function cleanupUpdateSources(context, sources) {
    for (const source of sources || []) {
      try {
        const file = await executeUserRead({
          getPool,
          ...context,
          operation: (connection, uid) => selectImportFile(connection, uid, source.importId)
        })
        if (file.fileID && await storage.remove(file.fileID)) {
          await markContentDeleted(getPool, context.provider, context.subjectHash, source.importId, file.fileID)
        }
      } catch (error) {
        // Temporary source cleanup is best-effort and must never falsify a committed ledger result.
      }
    }
  }

  async function postFinanceUpdate(context) {
    const result = await posting.post(context)
    await cleanupUpdateSources(context, result.sources)
    return result
  }

  async function abandonFinanceUpdate(context) {
    const result = await financeUpdates.abandon(context)
    try {
      const view = await financeUpdates.get({ ...context, data: { updateId: result.updateId } })
      await cleanupUpdateSources(context, view.sources)
    } catch (error) {
      // Abandon is already durable; cleanup failure remains recoverable lifecycle work.
    }
    return result
  }

  return {
    commit,
    discard,
    discardFile,
    get,
    getFile,
    parse,
    parseFile,
    prepare,
    prepareMany,
    financeUpdateAbandon: abandonFinanceUpdate,
    financeUpdateCreate: financeUpdates.create,
    financeUpdateGet: financeUpdates.get,
    financeUpdateOrganize: financeUpdates.organize,
    financeUpdatePrepare: financeUpdates.prepare,
    financeUpdatePost: postFinanceUpdate,
    financeUpdateUndo: maintenance.undo,
    financeUpdateUndoImpact: maintenance.undoImpact,
    economicEventCorrect: maintenance.correct,
    economicEventCorrectionImpact: maintenance.correctionImpact,
    economicEventEvidence: financeUpdates.evidence,
    reviewIssueGet: reviewIssues.get,
    reviewIssueList: reviewIssues.list,
    reviewIssueResolveAccountMappings: reviewIssues.resolveAccountMappings,
    reviewIssueReviseAccountMapping: reviewIssues.reviseAccountMapping,
    reviewIssueResolve: reviewIssues.resolve
  }
}

module.exports = {
  MAX_FILES_PER_UPDATE,
  createImportService,
  createObjectKey
}
