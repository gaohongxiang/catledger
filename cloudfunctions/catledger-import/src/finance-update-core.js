const { buildOrganizePlan } = require('./organizer-planner')
const { importError } = require('./errors')
const {
  createUpdate,
  deleteDraftPlan,
  getUpdateView,
  insertAction,
  persistPlan,
  publicUpdate,
  selectActiveAccounts,
  selectDraftPaymentMappings,
  selectPlanningRows,
  selectPaymentMappings,
  selectEventEvidence,
  selectUpdate,
  restoreDraftPaymentMappings
} = require('./finance-update-repository')
const { executeIdempotentMutation, executeUserRead } = require('./import-transaction')
const { validateUuid, validateVersion } = require('./validation')

const MAX_UPDATE_SOURCES = 5

function validateBatchIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_UPDATE_SOURCES) {
    throw importError('VALIDATION_ERROR')
  }
  const ids = value.map(validateUuid)
  if (new Set(ids).size !== ids.length) throw importError('VALIDATION_ERROR')
  return ids
}

function createFinanceUpdateCore({ getPool }) {
  async function organizeUpdate(connection, uid, updateId, version, requestDigest) {
    const current = await selectUpdate(connection, uid, updateId, { forUpdate: true })
    // 未入账旧计划可按新规则原地重建。旧映射草稿引用旧事件，
    // 删除事件时会按外键级联删除，因此必须先冻结决定，重建后再
    // 绑定到新事件；正式账户、交易和余额始终不动。
    if (!['draft', 'failed', 'review'].includes(current.status) || Number(current.version) !== version) {
      throw importError('CONFLICT')
    }
    const rows = await selectPlanningRows(connection, uid, updateId)
    const paymentMappings = await selectPaymentMappings(connection, uid, updateId)
    const draftPaymentMappings = await selectDraftPaymentMappings(connection, uid, updateId)
    const accounts = await selectActiveAccounts(connection, uid)
    const plan = buildOrganizePlan({ updateId, rows, paymentMappings, accounts })
    await deleteDraftPlan(connection, uid, updateId)
    await persistPlan(connection, uid, updateId, plan)
    const appliedVersion = version + 1
    const actionId = await insertAction(connection, uid, {
      updateId,
      expectedVersion: version,
      appliedVersion,
      actionType: 'organize',
      requestDigest,
      reasons: ['finance_update_organized']
    })
    await restoreDraftPaymentMappings(
      connection,
      uid,
      updateId,
      plan.events,
      draftPaymentMappings,
      actionId
    )
    const counts = plan.counts
    const [result] = await connection.execute(
      `UPDATE catledger_finance_updates
          SET status = 'review', version = ?, plan_version = ?, current_action_id = ?,
              source_count = ?, valid_evidence_count = ?, duplicate_evidence_count = ?,
              final_event_count = ?, posted_event_count = ?, ready_event_count = ?,
              needs_action_event_count = ?, excluded_event_count = ?, error_code = NULL
        WHERE uid = ? AND update_id = ? AND version = ? AND status IN ('draft', 'failed', 'review')`,
      [
        appliedVersion, plan.planVersion, actionId, counts.sourceCount,
        counts.validEvidenceCount, counts.duplicateEvidenceCount, counts.finalEventCount,
        counts.postedEventCount, counts.readyEventCount, counts.needsActionEventCount,
        counts.excludedEventCount, uid, updateId, version
      ]
    )
    if (result.affectedRows !== 1) throw importError('CONFLICT')
    return getUpdateView(connection, uid, updateId)
  }

  async function create(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'financeUpdates.create',
      operation: (connection, uid, data, requestDigest, keyDigest) => createUpdate(
        connection, uid, validateBatchIds(data.batchIds), requestDigest, keyDigest
      )
    })
  }

  async function prepare(context) {
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'financeUpdates.prepare',
      operation: async (connection, uid, data, requestDigest, keyDigest) => {
        const update = await createUpdate(
          connection, uid, validateBatchIds(data.batchIds), requestDigest, keyDigest
        )
        return organizeUpdate(connection, uid, update.updateId, update.version, requestDigest)
      }
    })
  }

  async function organize(context) {
    const updateId = validateUuid(context.data.updateId)
    const version = validateVersion(context.data.version)
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'financeUpdates.organize',
      operation: (connection, uid, data, requestDigest) => organizeUpdate(
        connection, uid, updateId, version, requestDigest
      )
    })
  }

  async function get(context) {
    const updateId = validateUuid(context.data.updateId)
    if (context.data.includeEvents != null && typeof context.data.includeEvents !== 'boolean') {
      throw importError('VALIDATION_ERROR')
    }
    if (context.data.includeOptions != null && typeof context.data.includeOptions !== 'boolean') {
      throw importError('VALIDATION_ERROR')
    }
    return executeUserRead({
      getPool,
      ...context,
      operation: (connection, uid) => getUpdateView(connection, uid, updateId, {
        includeEvents: context.data.includeEvents !== false,
        includeOptions: context.data.includeOptions !== false
      })
    })
  }

  async function evidence(context) {
    const eventId = validateUuid(context.data.eventId)
    return executeUserRead({
      getPool,
      ...context,
      operation: (connection, uid) => selectEventEvidence(connection, uid, eventId)
    })
  }

  async function abandon(context) {
    const updateId = validateUuid(context.data.updateId)
    const version = validateVersion(context.data.version)
    return executeIdempotentMutation({
      getPool,
      ...context,
      action: 'financeUpdates.abandon',
      operation: async (connection, uid, data, requestDigest) => {
        const current = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        if (current.status === 'abandoned') return publicUpdate(current)
        if (!['draft', 'failed', 'review'].includes(current.status) || Number(current.version) !== version) {
          throw importError('CONFLICT')
        }
        const appliedVersion = version + 1
        const actionId = await insertAction(connection, uid, {
          updateId,
          expectedVersion: version,
          appliedVersion,
          actionType: 'abandon_update',
          requestDigest,
          reasons: ['finance_update_abandoned']
        })
        await connection.execute(
          `UPDATE catledger_finance_updates
              SET status = 'abandoned', version = ?, current_action_id = ?
            WHERE uid = ? AND update_id = ? AND version = ?`,
          [appliedVersion, actionId, uid, updateId, version]
        )
        return publicUpdate(await selectUpdate(connection, uid, updateId))
      }
    })
  }

  return { abandon, create, evidence, get, organize, prepare }
}

module.exports = {
  MAX_UPDATE_SOURCES,
  createFinanceUpdateCore,
  validateBatchIds
}
