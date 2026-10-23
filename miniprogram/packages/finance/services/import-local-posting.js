const protocol = require('../domain/import-review/local-review-protocol')
const { stableId } = require('../domain/import-review/local-review-identity')

const STAGING = 'staging'
const SUBMITTED = 'submitted'
const REORGANIZE_MESSAGE = '提交前核验未通过，已保存的选择仍保留，请重新整理后继续'
const PREPARATION_REJECTIONS = new Set([
  'CONFLICT', 'VALIDATION_ERROR', 'INVALID_REQUEST', 'NOT_FOUND',
  'SNAPSHOT_INCOMPLETE', 'IDEMPOTENCY_CONFLICT', 'LOCAL_REVIEW_CAPACITY'
])

function needsVerification(flight) {
  // Legacy records lack a send boundary. Absence of a receipt never proves
  // that an old request was not sent.
  return Boolean(flight && flight.phase !== STAGING)
}

function applyPhase(state, change) {
  if (!state.postFlight || state.postFlight.payload.requestId !== change.requestId || change.phase !== SUBMITTED) {
    throw Object.assign(new Error('本机提交记录不完整，原文件已保留'), { code: 'DRAFT_CORRUPT' })
  }
  state.postFlight.phase = SUBMITTED
}

function isReceipt(receipt, updateId) {
  return Boolean(receipt && receipt.action === 'financeUpdates.post' && receipt.updateId === updateId &&
    (receipt.status === 'posted' || receipt.status === 'review' && receipt.outcome === 'recheck'))
}

function inspect(records, updateId) {
  const state = { postFlight: null, postRejection: null, confirmedReceipt: null }
  for (const record of records || []) for (const change of record.changes || []) {
    if (change.kind === 'ui' && (change.key === 'postFlight' || change.key === 'postRejection')) state[change.key] = change.value && { ...change.value }
    else if (change.kind === 'postPhase') applyPhase(state, change)
    else if (change.kind === 'receipt' && isReceipt(change.value && change.value.receipt, updateId) && change.value.receipt.status === 'posted') {
      state.confirmedReceipt = change.value.receipt
    }
  }
  return state
}

function reorganizationError() {
  return Object.assign(new Error(REORGANIZE_MESSAGE), { code: 'LOCAL_REORGANIZE_REQUIRED' })
}

function rejectionChanges(error, flight) {
  if (needsVerification(flight) || !flight || !PREPARATION_REJECTIONS.has(error.code)) return null
  return [
    { kind: 'ui', key: 'postFlight', value: null },
    { kind: 'ui', key: 'postRejection', value: { code: error.code } }
  ]
}

async function upload(flight, callNetwork, guard) {
  const packed = protocol.split(JSON.stringify(flight.value), 'decisions')
  for (const part of packed.parts) {
    guard()
    await callNetwork('financeUpdates.stageDecisions', {
      requestId: stableId(flight.payload.requestId, 'part', String(part.index)),
      updateId: flight.payload.updateId, snapshotId: flight.value.snapshotId,
      uploadId: flight.payload.uploadId, baseVersion: flight.value.baseVersion,
      ruleVersion: flight.value.ruleVersion, chunkCount: packed.chunkCount,
      index: part.index, content: part.content
    })
    guard()
  }
  const sealed = await callNetwork('financeUpdates.sealDecisions', {
    requestId: stableId(flight.payload.requestId, 'seal'), uploadId: flight.payload.uploadId,
    updateId: flight.payload.updateId, snapshotId: flight.value.snapshotId
  })
  guard()
  if (!sealed || sealed.digest !== flight.payload.payloadDigest) {
    throw Object.assign(new Error('提交内容校验失败，原选择已保留'), { code: 'SNAPSHOT_INCOMPLETE' })
  }
}

async function submit({ flight, callNetwork, guard, persist }) {
  if (needsVerification(flight)) {
    try {
      const receipt = await callNetwork('imports.commandResult', {
        requestId: flight.payload.requestId, commandAction: 'financeUpdates.post'
      })
      guard()
      if (receipt) return receipt
    } catch (error) {
      if (error.code !== 'OPERATION_UNCONFIRMED') throw error
    }
    guard()
  }
  try {
    await upload(flight, callNetwork, guard)
  } catch (error) {
    guard()
    const changes = rejectionChanges(error, flight)
    if (!changes) throw error
    persist(changes)
    throw reorganizationError()
  }
  // Persist a small transition, not another copy of the decision payload.
  // This barrier must succeed before a request capable of writing the ledger.
  if (!needsVerification(flight)) {
    persist([{ kind: 'postPhase', requestId: flight.payload.requestId, phase: SUBMITTED }])
  }
  guard()
  const receipt = await callNetwork('financeUpdates.post', flight.payload)
  guard()
  return receipt
}

function finish(receipt, { files, saveReceipt, cleanup = () => {}, receiptSaved = false }) {
  let saved = receiptSaved, cleaned = false, cleanupPending = false
  if (!saved) {
    try { saveReceipt(receipt); saved = true } catch (_) { cleanupPending = true }
  }
  if (saved) cleaned = files.clear()
  try { cleanup(cleaned) } catch (_) { cleanupPending = true }
  return { saved, cleaned, cleanupPending: cleanupPending || !cleaned }
}

module.exports = { STAGING, needsVerification, applyPhase, inspect, isReceipt, submit, finish, reorganizationError, REORGANIZE_MESSAGE }
