const { eventAllocation, allocationAccountsValid } = require('./funds-allocation')
const { correctionImpactResult, accountState, previewToken } = require('./maintenance-state')
const { inspectSideEffects, revertSideEffects, publicSideEffects } = require('./maintenance-side-effects')
const { isAggregateRepayment } = require('./repayment-allocation')
const { MAINTENANCE_POLICY_VERSION } = require('./maintenance-policy')
const { importError } = require('./errors')
const { getUpdateView, insertAction, parseJson, selectUpdate } = require('./finance-update-repository')
const { createTransactions, linkEventTransaction, transactionDrafts, eventContext } = require('./finance-update-posting')
const { executeIdempotentMutation, executeUserRead } = require('./import-transaction')
const { EVENT_STATUS, unique, evaluatePostability } = require('./organizer-model')
const { applyFields } = require('./review-issue-service')
const { validateUuid, validateVersion } = require('./validation')

async function selectCorrectableEvent(connection, uid, eventId, { forUpdate = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT e.event_id AS eventId, e.update_id AS updateId, e.status, e.version,
            e.flow_direction AS flowDirection, e.economic_nature AS economicNature,
            e.ledger_account_id AS ledgerAccountId,
            e.counterparty_ledger_account_id AS counterpartyLedgerAccountId,
            e.event_local_date AS localDate, e.event_local_at AS localAt,
            e.event_utc_at AS utcAt, e.timezone_offset_minutes AS timezoneOffsetMinutes,
            e.amount_minor AS amountMinor, e.currency, e.category_id AS categoryId,
            e.manual_field_mask AS manualFieldMask,
            e.field_sources_json AS fieldSources, e.reason_codes_json AS reasonCodes,
            r.normalized_direction AS sourceDirection,
            r.counterparty_raw AS counterparty, r.item_raw AS item, r.note_raw AS sourceNote
       FROM catledger_economic_events e
       LEFT JOIN catledger_event_evidence evidence
         ON evidence.uid = e.uid AND evidence.update_id = e.update_id
        AND evidence.event_id = e.event_id AND evidence.evidence_role = 'primary'
       LEFT JOIN catledger_import_rows r
         ON r.uid = evidence.uid AND r.row_id = evidence.row_id
      WHERE e.uid = ? AND e.event_id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, eventId]
  )
  if (!rows[0]) throw importError('NOT_FOUND')
  const row = rows[0]
  return {
    ...row,
    version: Number(row.version),
    timezoneOffsetMinutes: row.timezoneOffsetMinutes == null ? null : Number(row.timezoneOffsetMinutes),
    amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
    manualFieldMask: Number(row.manualFieldMask),
    fieldSources: parseJson(row.fieldSources, {}),
    reasonCodes: parseJson(row.reasonCodes, [])
  }
}

async function linkedTransactions(connection, uid, updateId, eventId, { forUpdate = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT links.link_id AS linkId, links.transaction_id AS transactionId,
            links.role, links.creation_method AS creationMethod,
            t.type, t.original_transaction_id AS originalTransactionId,
            links.transaction_version AS linkedVersion, t.origin,
            t.source_account_id AS sourceAccountId, t.destination_account_id AS destinationAccountId,
            t.amount_minor AS amountMinor, t.version, t.deleted_at AS deletedAt
       FROM catledger_economic_event_transactions links
       JOIN catledger_transactions t
         ON t.uid = links.uid AND t.transaction_id = links.transaction_id
      WHERE links.uid = ? AND links.update_id = ? AND links.event_id = ? AND links.superseded_at IS NULL
      ORDER BY links.created_at, links.link_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, updateId, eventId]
  )
  return rows.map((row) => ({ ...row, version: Number(row.version), linkedVersion: Number(row.linkedVersion), amountMinor: String(row.amountMinor) }))
}

async function validateDraftReferences(connection, uid, event, draft, forUpdate = false) {
  const accountIds = [...new Set([draft.sourceAccountId, draft.destinationAccountId].filter(Boolean))].sort()
  if (accountIds.length > 0) {
    const [accounts] = await connection.execute(
      `SELECT account_id AS accountId, currency, archived_at AS archivedAt
         FROM catledger_accounts
        WHERE uid = ? AND account_id IN (${accountIds.map(() => '?').join(', ')}) ORDER BY account_id${forUpdate ? ' FOR UPDATE' : ''}`,
      [uid, ...accountIds]
    )
    if (accounts.length !== accountIds.length || accounts.some((account) => account.archivedAt != null || account.currency !== event.currency)) {
      throw importError('VALIDATION_ERROR')
    }
  }
  if (draft.categoryId) {
    const [categories] = await connection.execute(
      `SELECT kind FROM catledger_categories
        WHERE uid = ? AND category_id = ? AND archived_at IS NULL LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
      [uid, draft.categoryId]
    )
    if (!categories[0] || categories[0].kind !== draft.type) throw importError('VALIDATION_ERROR')
  }
}

async function validateCorrectionRelations(connection, uid, transaction, draft, amountMinor, forUpdate = false) {
  const [[dependent]] = await connection.execute(
    `SELECT COALESCE(SUM(amount_minor), 0) AS amountMinor
       FROM catledger_transactions
      WHERE uid = ? AND original_transaction_id = ? AND type = 'refund' AND deleted_at IS NULL`,
    [uid, transaction.transactionId]
  )
  const dependentAmount = BigInt(String(dependent.amountMinor))
  if (dependentAmount > 0n && (draft.type !== 'expense' || dependentAmount > BigInt(amountMinor))) {
    throw importError('VALIDATION_ERROR')
  }
  if (draft.type !== 'refund') return
  const [originals] = await connection.execute(
    `SELECT amount_minor AS amountMinor FROM catledger_transactions
      WHERE uid = ? AND transaction_id = ? AND type = 'expense' AND deleted_at IS NULL
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, draft.originalTransactionId]
  )
  if (!originals[0]) throw importError('VALIDATION_ERROR')
  const [[otherRefunds]] = await connection.execute(
    `SELECT COALESCE(SUM(amount_minor), 0) AS amountMinor
       FROM catledger_transactions
      WHERE uid = ? AND original_transaction_id = ? AND type = 'refund'
        AND transaction_id <> ? AND deleted_at IS NULL`,
    [uid, draft.originalTransactionId, transaction.transactionId]
  )
  if (BigInt(String(otherRefunds.amountMinor)) + BigInt(amountMinor) > BigInt(String(originals[0].amountMinor))) {
    throw importError('VALIDATION_ERROR')
  }
}

async function prepareCorrection(connection, uid, update, event, transactions, fields, forUpdate = false) {
  const impact = correctionImpactResult(event, transactions)
  const created = transactions.filter((row) => row.creationMethod === 'created' && row.role !== 'refund_original')
  const next = fields ? applyFields(event, fields) : event
  // 聚合事件不能通过改性质退化为局部单笔编辑。
  if (isAggregateRepayment(event) !== isAggregateRepayment(next)) throw importError('VALIDATION_ERROR')
  let drafts = []
  if (impact.canCorrect) {
    const original = next.economicNature === 'refund' ? created[0].originalTransactionId : null
    if (next.economicNature === 'refund' && !original) throw importError('VALIDATION_ERROR')
    const evaluated = evaluatePostability({ ...next, status: 'needs_action' }, await eventContext(connection, uid, event.updateId, event.eventId))
    if (evaluated.status !== 'ready') throw importError('UNRESOLVED_IMPORT')
    drafts = transactionDrafts(next, original)
  }
  const state = await accountState(connection, uid, created, drafts, { forUpdate })
  for (const draft of drafts) {
    await validateDraftReferences(connection, uid, next, draft, forUpdate)
  }
  if (drafts.length && !allocationAccountsValid(next, eventAllocation(next), new Map(state.accounts.map((row) => [row.accountId, row])))) throw importError('VALIDATION_ERROR')
  if (created.length === 1 && drafts.length === 1) await validateCorrectionRelations(connection, uid, created[0], drafts[0], drafts[0].amountMinor, forUpdate)
  if (state.deficits.length) impact.conflicts.push('INSUFFICIENT_CASH_BALANCE')
  if (update.status !== 'posted') impact.conflicts.push('UPDATE_STATE_CHANGED')
  impact.canCorrect = impact.conflicts.length === 0
  return { next, drafts, created, impact: { ...impact, updateVersion: Number(update.version), accountImpacts: state.impacts,
    previewToken: previewToken(uid, 'correct', { updateVersion: Number(update.version), event, transactions, fields: fields || null, state }) } }
}

async function prepareUndo(connection, uid, update, forUpdate = false) {
  const updateId = update.updateId
  const [linked] = await connection.execute(`SELECT l.transaction_id AS transactionId, l.transaction_version AS linkedVersion,
    l.creation_method AS creationMethod, t.version, t.origin, t.deleted_at AS deletedAt,
    t.source_account_id AS sourceAccountId, t.destination_account_id AS destinationAccountId, t.amount_minor AS amountMinor
    FROM catledger_economic_event_transactions l JOIN catledger_transactions t
      ON t.uid = l.uid AND t.transaction_id = l.transaction_id
    WHERE l.uid = ? AND l.update_id = ? AND l.superseded_at IS NULL AND l.role <> 'refund_original'
    ORDER BY l.transaction_id, l.link_id${forUpdate ? ' FOR UPDATE' : ''}`, [uid, updateId])
  const transactions = linked.map((row) => ({ ...row, linkedVersion: Number(row.linkedVersion), version: Number(row.version), amountMinor: String(row.amountMinor) }))
  const created = [...new Map(transactions.filter((row) => row.creationMethod === 'created').map((row) => [row.transactionId, row])).values()]
  const ids = created.map((row) => row.transactionId)
  const [dependents] = ids.length ? await connection.execute(`SELECT transaction_id AS transactionId, version
    FROM catledger_transactions WHERE uid = ? AND original_transaction_id IN (${ids.map(() => '?').join(', ')})
      AND deleted_at IS NULL AND transaction_id NOT IN (${ids.map(() => '?').join(', ')})
    ORDER BY transaction_id${forUpdate ? ' FOR UPDATE' : ''}`, [uid, ...ids, ...ids]) : [[]]
  const audit = parseJson(update.sideEffects, null)
  const state = await accountState(connection, uid, created, [], { forUpdate,
    additionalAccountIds: (audit && audit.accounts || []).map((row) => row.accountId) })
  const effects = await inspectSideEffects(connection, uid, updateId, audit, { forUpdate })
  const conflicts = []
  if (update.status !== 'posted') conflicts.push('UPDATE_STATE_CHANGED')
  if (created.some((row) => row.deletedAt != null || row.origin !== 'import' || row.version !== row.linkedVersion)) conflicts.push('TRANSACTION_SET_CHANGED')
  if (dependents.length) conflicts.push('EXTERNAL_REFUND_DEPENDENCY')
  if (!effects.verified) conflicts.push('LEGACY_SIDE_EFFECTS_UNVERIFIED')
  if (state.deficits.length) conflicts.push('INSUFFICIENT_CASH_BALANCE')
  return { ids, effects, impact: {
    update: { updateId, status: update.status, version: Number(update.version) },
    createdTransactionCount: created.length,
    reusedTransactionCount: new Set(transactions.filter((row) => row.creationMethod === 'reused').map((row) => row.transactionId)).size,
    dependentTransactionCount: dependents.length, accountImpacts: state.impacts, sideEffects: publicSideEffects(effects),
    conflicts, canUndo: conflicts.length === 0, policyVersion: MAINTENANCE_POLICY_VERSION,
    previewToken: previewToken(uid, 'undo', { updateId, updateVersion: Number(update.version), transactions, dependents, state, effects })
  } }
}

function createFinanceUpdateMaintenance({ getPool }) {
  async function correctionImpact(context) {
    const eventId = validateUuid(context.data.eventId)
    return executeUserRead({
      getPool,
      ...context,
      consistentSnapshot: true,
      operation: async (connection, uid) => {
        const event = await selectCorrectableEvent(connection, uid, eventId)
        const update = await selectUpdate(connection, uid, event.updateId)
        const transactions = await linkedTransactions(connection, uid, event.updateId, eventId)
        return (await prepareCorrection(connection, uid, update, event, transactions, context.data.fields)).impact
      }
    })
  }

  async function correct(context) {
    const updateId = validateUuid(context.data.updateId)
    const eventId = validateUuid(context.data.eventId)
    const updateVersion = validateVersion(context.data.updateVersion)
    const eventVersion = validateVersion(context.data.eventVersion)
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
      ...context,
      action: 'economicEvents.correct',
      operation: async (connection, uid, data, requestDigest) => {
        const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        const event = await selectCorrectableEvent(connection, uid, eventId, { forUpdate: true })
        if (update.status !== 'posted' || Number(update.version) !== updateVersion || event.updateId !== updateId ||
            ![EVENT_STATUS.POSTED, EVENT_STATUS.CORRECTED].includes(event.status) || event.version !== eventVersion) {
          throw importError('CONFLICT')
        }
        const transactions = await linkedTransactions(connection, uid, updateId, eventId, { forUpdate: true })
        const { next, drafts, created, impact } = await prepareCorrection(connection, uid, update, event, transactions, data.fields, true)
        if (!impact.canCorrect) throw importError(impact.conflicts.includes('INSUFFICIENT_CASH_BALANCE') ? 'INSUFFICIENT_CASH_BALANCE' : 'CONFLICT')
        if (!data.previewToken || data.previewToken !== impact.previewToken) throw importError('CONFLICT')
        const draft = drafts[0]
        if (isAggregateRepayment(event)) {
          const ids = created.map((row) => row.transactionId)
          await connection.execute(`UPDATE catledger_transactions SET deleted_at = CURRENT_TIMESTAMP(3), version = version + 1
            WHERE uid = ? AND transaction_id IN (${ids.map(() => '?').join(', ')})`, [uid, ...ids])
          await connection.execute(`UPDATE catledger_economic_event_transactions SET superseded_at = CURRENT_TIMESTAMP(3)
            WHERE uid = ? AND update_id = ? AND event_id = ? AND superseded_at IS NULL AND creation_method = 'created'`, [uid, updateId, eventId])
          for (const replacement of await createTransactions(connection, uid, updateId, next)) {
            await linkEventTransaction(connection, uid, updateId, next, replacement.transactionId, 'created', 1, replacement.role)
          }
        } else {
        const [transactionResult] = await connection.execute(
          `UPDATE catledger_transactions
              SET type = ?, source_account_id = ?, destination_account_id = ?, category_id = ?,
                  original_transaction_id = ?, amount_minor = ?, occurred_local_date = ?,
                  occurred_local_at = ?, timezone_offset_minutes = ?, occurred_at_utc = ?,
                  note = ?, version = version + 1
            WHERE uid = ? AND transaction_id = ? AND version = ? AND origin = 'import'
              AND deleted_at IS NULL`,
          [
            draft.type, draft.sourceAccountId, draft.destinationAccountId, draft.categoryId,
            draft.originalTransactionId, next.amountMinor, next.localDate, next.localAt,
            next.timezoneOffsetMinutes, next.utcAt,
            [next.item, next.counterparty, next.sourceNote].filter(Boolean).join(' · ').slice(0, 200) || null,
            uid, created[0].transactionId, created[0].version
          ]
        )
        if (transactionResult.affectedRows !== 1) throw importError('CONFLICT')
        }
        const appliedVersion = updateVersion + 1
        const actionId = await insertAction(connection, uid, {
          updateId,
          expectedVersion: updateVersion,
          appliedVersion,
          actionType: 'correct_event',
          requestDigest,
          decision: data,
          reasons: ['economic_event_corrected']
        })
        const nextEventVersion = eventVersion + 1
        const [eventResult] = await connection.execute(
          `UPDATE catledger_economic_events
              SET state = 'corrected', status = 'corrected', flow_direction = ?,
                  economic_nature = ?, ledger_account_id = ?,
                  counterparty_ledger_account_id = ?, event_local_date = ?, event_local_at = ?,
                  event_utc_at = ?, timezone_offset_minutes = ?, amount_minor = ?, currency = ?,
                  category_id = ?, manual_field_mask = ?, field_sources_json = ?,
                  reason_codes_json = ?, version = ?
            WHERE uid = ? AND update_id = ? AND event_id = ? AND version = ?`,
          [
            next.flowDirection, next.economicNature, next.ledgerAccountId,
            next.counterpartyLedgerAccountId, next.localDate, next.localAt, next.utcAt,
            next.timezoneOffsetMinutes, next.amountMinor, next.currency, next.categoryId,
            next.manualFieldMask, JSON.stringify({ ...next.fieldSources, lastUserActionId: actionId }),
            JSON.stringify(unique([...next.reasonCodes, 'manual_correction'])), nextEventVersion,
            uid, updateId, eventId, eventVersion
          ]
        )
        if (eventResult.affectedRows !== 1) throw importError('CONFLICT')
        if (!isAggregateRepayment(event)) await connection.execute(
          `UPDATE catledger_economic_event_transactions
              SET transaction_version = transaction_version + 1
            WHERE uid = ? AND update_id = ? AND event_id = ? AND transaction_id = ?`,
          [uid, updateId, eventId, created[0].transactionId]
        )
        const [updateResult] = await connection.execute(
          `UPDATE catledger_finance_updates SET version = ?, current_action_id = ?
            WHERE uid = ? AND update_id = ? AND version = ? AND status = 'posted'`,
          [appliedVersion, actionId, uid, updateId, updateVersion]
        )
        if (updateResult.affectedRows !== 1) throw importError('CONFLICT')
        return getUpdateView(connection, uid, updateId)
      }
    })
  }

  async function undoImpact(context) {
    const updateId = validateUuid(context.data.updateId)
    return executeUserRead({
      getPool,
      ...context,
      consistentSnapshot: true,
      operation: async (connection, uid) => {
        const update = await selectUpdate(connection, uid, updateId)
        return (await prepareUndo(connection, uid, update)).impact
      }
    })
  }

  async function undo(context) {
    const updateId = validateUuid(context.data.updateId)
    const version = validateVersion(context.data.version)
    return executeIdempotentMutation({
      getPool,
      currentReads: true,
      ...context,
      action: 'financeUpdates.undo',
      operation: async (connection, uid, data, requestDigest) => {
        const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        if (update.status === 'undone') return getUpdateView(connection, uid, updateId)
        if (update.status !== 'posted' || Number(update.version) !== version) throw importError('CONFLICT')
        const { ids, effects, impact } = await prepareUndo(connection, uid, update, true)
        if (!impact.canUndo) throw importError(impact.conflicts.includes('INSUFFICIENT_CASH_BALANCE') ? 'INSUFFICIENT_CASH_BALANCE' : 'CONFLICT')
        if (!data.previewToken || data.previewToken !== impact.previewToken) throw importError('CONFLICT')
        if (ids.length) {
          const [deleted] = await connection.execute(`UPDATE catledger_transactions SET deleted_at = CURRENT_TIMESTAMP(3), version = version + 1
            WHERE uid = ? AND transaction_id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL`, [uid, ...ids])
          if (deleted.affectedRows !== ids.length) throw importError('CONFLICT')
        }
        await revertSideEffects(connection, uid, effects)
        await connection.execute(
          `UPDATE catledger_economic_events
              SET state = 'corrected', status = 'corrected', version = version + 1,
                  reason_codes_json = JSON_ARRAY_APPEND(COALESCE(reason_codes_json, JSON_ARRAY()), '$', 'finance_update_undone')
            WHERE uid = ? AND update_id = ? AND status IN ('posted', 'corrected')`,
          [uid, updateId]
        )
        await connection.execute(
          `UPDATE catledger_economic_event_relations
              SET status = 'undone', version = version + 1
            WHERE uid = ? AND update_id = ? AND status = 'confirmed'`,
          [uid, updateId]
        )
        const appliedVersion = version + 1
        const actionId = await insertAction(connection, uid, {
          updateId,
          expectedVersion: version,
          appliedVersion,
          actionType: 'undo',
          requestDigest,
          reasons: ['finance_update_undone']
        })
        const [result] = await connection.execute(
          `UPDATE catledger_finance_updates
              SET status = 'undone', version = ?, current_action_id = ?,
                  posted_event_count = 0, ready_event_count = 0,
                  needs_action_event_count = 0,
                  excluded_event_count = final_event_count
            WHERE uid = ? AND update_id = ? AND version = ? AND status = 'posted'`,
          [appliedVersion, actionId, uid, updateId, version]
        )
        if (result.affectedRows !== 1) throw importError('CONFLICT')
        return getUpdateView(connection, uid, updateId)
      }
    })
  }

  return { correct, correctionImpact, undo, undoImpact }
}

module.exports = {
  correctionImpactResult,
  createFinanceUpdateMaintenance
}
