const { randomUUID } = require('node:crypto')
const { executeIdempotentMutation, executeUserRead } = require('./import-transaction')
const { importError } = require('./errors')
const { validateUuid, validateVersion } = require('./validation')
const { sha256 } = require('./digest')
const { selectUpdate, publicUpdate, parseJson } = require('./finance-update-repository')
const { split, rootDigest, validateManifest, validateState, LIMITS } = require('./local-review-protocol')
const { PLAN_VERSION } = require('./domain-versions')
const { insertMany } = require('./sql-batch')

const INLINE_SNAPSHOT_WIRE_BYTES = 200 * 1024

function header(row) {
  return { objectId: row.objectId, updateId: row.updateId, snapshotId: row.snapshotId || null, kind: row.kind,
    baseVersion: Number(row.baseVersion), protocolVersion: Number(row.protocolVersion), ruleVersion: row.ruleVersion,
    chunkCount: Number(row.chunkCount), bytes: Number(row.bytes), digest: row.digest, state: row.state,
    ...parseJson(row.metadata, {}) }
}
async function object(connection, uid, id, { sealed = true } = {}) {
  const [[row]] = await connection.execute(`SELECT object_id AS objectId,update_id AS updateId,snapshot_id AS snapshotId,
    object_kind AS kind,base_version AS baseVersion,rule_version AS ruleVersion,protocol_version AS protocolVersion,
    state,chunk_count AS chunkCount,byte_count AS bytes,content_digest AS digest,metadata_json AS metadata
    FROM catledger_import_review_objects WHERE uid=? AND object_id=?`, [uid, validateUuid(id)])
  if (!row || sealed && row.state !== 'sealed') throw importError('SNAPSHOT_INCOMPLETE')
  return header(row)
}
async function saveObject(connection, uid, value, packed) {
  await connection.execute(`INSERT INTO catledger_import_review_objects
    (uid,object_id,update_id,snapshot_id,object_kind,base_version,rule_version,protocol_version,state,chunk_count,byte_count,content_digest,metadata_json)
    VALUES (?,?,?,?,?,?,?,3,'sealed',?,?,?,?)`, [uid, value.objectId, value.updateId, value.snapshotId || null, value.kind,
    value.baseVersion, value.ruleVersion, packed.chunkCount, packed.bytes, packed.digest, JSON.stringify(value.metadata || {})])
  await insertMany(connection, `INSERT INTO catledger_import_review_chunks
    (uid,object_id,part_index,byte_count,content_digest,content_text) VALUES`,
  packed.parts.map(part => [uid, value.objectId, part.index, part.bytes, part.digest, part.content]))
  return { ...value, ...value.metadata, protocolVersion: 3, chunkCount: packed.chunkCount, bytes: packed.bytes, digest: packed.digest, state: 'sealed' }
}
async function loadObject(connection, uid, id, kind) {
  const meta = await object(connection, uid, id)
  if (kind && meta.kind !== kind) throw importError('VALIDATION_ERROR')
  const [parts] = await connection.execute(`SELECT part_index AS \`index\`,byte_count AS bytes,content_digest AS digest,content_text AS content
    FROM catledger_import_review_chunks WHERE uid=? AND object_id=? ORDER BY part_index`, [uid, id])
  validateManifest(meta, parts.map(part => ({ ...part, bytes: Number(part.bytes), index: Number(part.index) })))
  if (parts.some(part => sha256(part.content) !== part.digest)) throw importError('SNAPSHOT_INCOMPLETE')
  let value
  try {
    if(meta.kind==='snapshot'){
      const codec=require('./local-review-snapshot')
      function* contents(){for(let index=0;index<parts.length;index++){const content=parts[index].content;parts[index]=null;yield content}}
      value=codec.validateFacts(codec.decodeParts(contents()),meta)
    }else value=JSON.parse(parts.map(part => part.content).join(''))
  } catch (_) { throw importError('SNAPSHOT_INCOMPLETE') }
  parts.length=0
  return { header: meta, value }
}
function inlineSnapshot(packed, objectId, baseVersion) {
  if (!packed || packed.chunkCount !== 1 || !packed.parts || packed.parts.length !== 1) return null
  const part = packed.parts[0]
  if (!part || typeof part.content !== 'string' || part.bytes > INLINE_SNAPSHOT_WIRE_BYTES) return null
  if (Buffer.byteLength(JSON.stringify(part.content)) > INLINE_SNAPSHOT_WIRE_BYTES) return null
  return { objectId, baseVersion, index: part.index,
    bytes: part.bytes, digest: part.digest, content: part.content }
}
function createLocalReviewObjects({ getPool }) {
  const read = (context, operation) => executeUserRead({ getPool, ...context, consistentSnapshot: true, operation })
  const write = (context, action, operation) => executeIdempotentMutation({ getPool, ...context, action, operation })
  async function prepare(context) {
    const replay = await require('./import-transaction').findReplay({ getPool, ...context }, 'financeUpdates.prepareSnapshot')
    if (replay) return replay
    if (context.data.force != null && typeof context.data.force !== 'boolean') throw importError('VALIDATION_ERROR')
    const force = context.data.force === true
    const updateId = validateUuid(context.data.updateId), version = validateVersion(context.data.version)
    const captured = await read(context, async (connection, uid) => {
      const update = await selectUpdate(connection, uid, updateId)
      if (update.status !== 'review' || Number(update.version) !== version) throw importError('CONFLICT')
      if (!force && update.reviewMode === 'local_v3') {
        const [[prior]] = await connection.execute(`SELECT object_id AS id FROM catledger_import_review_objects
          WHERE uid=? AND update_id=? AND object_kind='snapshot' AND base_version=? AND state='sealed' ORDER BY created_at DESC LIMIT 1`, [uid, updateId, version])
        if (prior) return { existing: await object(connection, uid, prior.id) }
      }
      return { facts: await require('./local-review-facts').loadFacts(connection, uid, updateId) }
    })
    const objectId = captured.existing ? captured.existing.objectId : randomUUID()
    let packed, counts
    if (captured.facts) {
      captured.facts.update.version = version + 1; captured.facts.update.reviewMode = 'local_v3'
      captured.facts.snapshotId = objectId
      captured.facts.summary.update = captured.facts.update
      const codec=require('./local-review-snapshot')
      counts=codec.counts(captured.facts)
      packed = split(codec.encodeText(captured.facts,{consume:true}))
      captured.facts=null
    }
    return write(context, 'financeUpdates.prepareSnapshot', async (connection, uid) => {
      const current = await selectUpdate(connection, uid, updateId, { forUpdate: true })
      if (current.status !== 'review' || Number(current.version) !== version || current.planVersion !== PLAN_VERSION) throw importError('CONFLICT')
      if (captured.existing) {
        // Re-opening a still-valid local snapshot is also the bounded lease
        // refresh that keeps the 48h server hard cleanup from deleting a draft
        // the user is actively reviewing. Version and rule version stay fixed.
        await connection.execute(`UPDATE catledger_finance_updates SET updated_at = CURRENT_TIMESTAMP(3)
          WHERE uid = ? AND update_id = ? AND version = ? AND status = 'review'`, [uid, updateId, version])
        return { update: publicUpdate(await selectUpdate(connection, uid, updateId)), snapshot: captured.existing }
      }
      await connection.execute("UPDATE catledger_finance_updates SET review_mode='local_v3',version=version+1 WHERE uid=? AND update_id=?", [uid, updateId])
      const snapshot = await saveObject(connection, uid, { objectId, updateId, kind: 'snapshot', baseVersion: version + 1, ruleVersion: PLAN_VERSION,
        metadata: { counts, capabilities: ['complete-facts','local-review','atomic-post'] } }, packed)
      const inline = inlineSnapshot(packed, objectId, version + 1)
      return { update: publicUpdate(await selectUpdate(connection, uid, updateId)), snapshot, ...(inline ? { inline } : {}) }
    })
  }
  async function manifest(context) {
    return read(context, async (connection, uid) => {
      const meta = await object(connection, uid, context.data.objectId), offset = context.data.offset || 0
      if (!Number.isInteger(offset) || offset < 0 || offset >= meta.chunkCount) throw importError('VALIDATION_ERROR')
      const [parts] = await connection.execute(`SELECT part_index AS \`index\`,byte_count AS bytes,content_digest AS digest
        FROM catledger_import_review_chunks WHERE uid=? AND object_id=? AND part_index>=? ORDER BY part_index LIMIT ?`,
      [uid, meta.objectId, offset, LIMITS.manifestPage])
      return { header: meta, parts, nextOffset: offset + parts.length < meta.chunkCount ? offset + parts.length : null }
    })
  }
  async function chunk(context) {
    return read(context, async (connection, uid) => {
      const meta = await object(connection, uid, context.data.objectId), index = context.data.index
      if (!Number.isInteger(index) || index < 0 || index >= meta.chunkCount) throw importError('VALIDATION_ERROR')
      const [[part]] = await connection.execute(`SELECT content_digest AS digest,content_text AS content
        FROM catledger_import_review_chunks WHERE uid=? AND object_id=? AND part_index=?`, [uid, meta.objectId, index])
      if (!part) throw importError('SNAPSHOT_INCOMPLETE')
      return { objectId: meta.objectId, baseVersion: meta.baseVersion, index, ...part }
    })
  }
  async function stage(context) {
    const data = context.data, uploadId = validateUuid(data.uploadId), updateId = validateUuid(data.updateId), snapshotId = validateUuid(data.snapshotId)
    validateVersion(data.baseVersion)
    if (typeof data.content !== 'string' || !data.content.length || data.content.length > LIMITS.decisionChunkChars ||
      !Number.isInteger(data.chunkCount) || data.chunkCount < 1 || data.chunkCount > LIMITS.chunks ||
      !Number.isInteger(data.index) || data.index < 0 || data.index >= data.chunkCount || data.ruleVersion !== PLAN_VERSION) throw importError('VALIDATION_ERROR')
    const digest = sha256(data.content), bytes = Buffer.byteLength(data.content)
    return write(context, 'financeUpdates.stageDecisions', async (connection, uid) => {
      const snapshot = await object(connection, uid, snapshotId), update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
      if (snapshot.kind !== 'snapshot' || snapshot.updateId !== updateId || snapshot.baseVersion !== data.baseVersion ||
        snapshot.ruleVersion !== data.ruleVersion || update.status !== 'review' || Number(update.version) !== data.baseVersion || update.reviewMode !== 'local_v3') throw importError('CONFLICT')
      await connection.execute(`INSERT IGNORE INTO catledger_import_review_objects
        (uid,object_id,update_id,snapshot_id,object_kind,base_version,rule_version,protocol_version,state,chunk_count,metadata_json)
        VALUES (?,?,?,?,'decisions',?,?,3,'writing',?,'{}')`, [uid, uploadId, updateId, snapshotId, data.baseVersion, data.ruleVersion, data.chunkCount])
      const meta = await object(connection, uid, uploadId, { sealed: false })
      if (meta.kind !== 'decisions' || meta.updateId !== updateId || meta.snapshotId !== snapshotId || meta.baseVersion !== data.baseVersion || meta.chunkCount !== data.chunkCount) throw importError('IDEMPOTENCY_CONFLICT')
      const [[prior]] = await connection.execute(`SELECT content_digest AS digest,content_text AS content FROM catledger_import_review_chunks
        WHERE uid=? AND object_id=? AND part_index=?`, [uid, uploadId, data.index])
      if (prior) {
        if (prior.digest !== digest || prior.content !== data.content) throw importError('IDEMPOTENCY_CONFLICT')
      } else {
        if (meta.state !== 'writing' || meta.bytes + bytes > LIMITS.decisionBytes) throw importError('LOCAL_REVIEW_CAPACITY')
        await connection.execute(`INSERT INTO catledger_import_review_chunks (uid,object_id,part_index,byte_count,content_digest,content_text)
          VALUES (?,?,?,?,?,?)`, [uid, uploadId, data.index, bytes, digest, data.content])
        await connection.execute('UPDATE catledger_import_review_objects SET byte_count=byte_count+? WHERE uid=? AND object_id=?', [bytes, uid, uploadId])
      }
      return { uploadId, index: data.index, digest }
    })
  }
  async function seal(context) {
    const data = context.data, uploadId = validateUuid(data.uploadId), updateId = validateUuid(data.updateId), snapshotId = validateUuid(data.snapshotId)
    // Parse and hash outside the write lock. Individual chunks are insert-only;
    // an existing index can never be replaced, including before sealing.
    const packed = await read(context, async (connection, uid) => {
      const meta = await object(connection, uid, uploadId, { sealed: false })
      if (meta.kind !== 'decisions' || meta.updateId !== updateId || meta.snapshotId !== snapshotId) throw importError('VALIDATION_ERROR')
      const [parts] = await connection.execute(`SELECT part_index AS \`index\`,byte_count AS bytes,content_digest AS digest,content_text AS content
        FROM catledger_import_review_chunks WHERE uid=? AND object_id=? ORDER BY part_index`, [uid, uploadId])
      const digest = rootDigest(parts)
      validateManifest({ ...meta, digest }, parts)
      if (parts.some(part => sha256(part.content) !== part.digest)) throw importError('SNAPSHOT_INCOMPLETE')
      let state
      try { state = JSON.parse(parts.map(part => part.content).join('')) } catch (_) { throw importError('VALIDATION_ERROR') }
      validateState(state)
      if (state.snapshotId !== snapshotId || state.updateId !== updateId || state.baseVersion !== meta.baseVersion || state.ruleVersion !== meta.ruleVersion) throw importError('VALIDATION_ERROR')
      return { uploadId, digest, bytes: meta.bytes, chunkCount: meta.chunkCount }
    })
    return write(context, 'financeUpdates.sealDecisions', async (connection, uid) => {
      const meta = await object(connection, uid, uploadId, { sealed: false })
      if (meta.bytes !== packed.bytes || meta.state === 'consumed' || meta.digest && meta.digest !== packed.digest) throw importError('IDEMPOTENCY_CONFLICT')
      await connection.execute("UPDATE catledger_import_review_objects SET state='sealed',content_digest=? WHERE uid=? AND object_id=?", [packed.digest, uid, uploadId])
      return packed
    })
  }
  return { prepare, manifest, chunk, stage, seal }
}
module.exports = { createLocalReviewObjects, object, saveObject, loadObject, inlineSnapshot }
