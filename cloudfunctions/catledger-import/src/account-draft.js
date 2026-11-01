const { chunks, insertMany } = require('./sql-batch')
const { importError } = require('./errors')
const draftPolicy = require('./account-draft-policy')
const identity = require('./local-review-identity')
const { digestParts } = require('./portable-digest')
const ACCOUNT_NATURES = draftPolicy.NATURES
const normalizeAccountName = draftPolicy.normalizeName

async function stageAccountDraft(connection, uid, updateId, value, actionId, context = {}) {
  const draft = draftPolicy.validate(value)
  if (draft.creationKey && draft.creationKey !== context.creationKey) throw importError('VALIDATION_ERROR')
  const batch = require('./local-review-batch').get(connection)
  const creationKey = draft.creationKey || (!batch && (context.creationKey || digestParts('account-action-v1', actionId, draft.normalizedName)))
  const draftAccountId = identity.accountId(batch ? batch.snapshotId : updateId, draft.name, draft.type, creationKey)
  // 旧冻结请求保留原来的账户ID，但不能让同批不同创建决定借同名合并。
  const owner = context.creationKey || actionId
  if (batch) {
    batch.accountCreationOwners ||= new Map()
    if (batch.accountCreationOwners.has(draftAccountId) && batch.accountCreationOwners.get(draftAccountId) !== owner) draftPolicy.conflict()
  }
  const [existing] = await connection.execute(
    `SELECT draft_account_id AS draftAccountId, name, normalized_name AS normalizedName,
            type, nature, currency, materialized_at AS materializedAt
       FROM catledger_finance_update_account_drafts
      WHERE uid = ? AND update_id = ? AND (draft_account_id = ? OR normalized_name = ?)
      FOR UPDATE`,
    [uid, updateId, draftAccountId, draft.normalizedName]
  )
  if (existing.some(row => row.draftAccountId !== draftAccountId)) draftPolicy.conflict()
  const [namedAccounts] = await connection.execute(`SELECT account_id AS accountId, normalized_name AS normalizedName,
    type, nature, currency, archived_at AS archivedAt FROM catledger_accounts
    WHERE uid = ? AND (account_id = ? OR normalized_name = ?) FOR UPDATE`, [uid, draftAccountId, draft.normalizedName])
  if (namedAccounts.some(row => row.accountId !== draftAccountId)) draftPolicy.conflict()
  if (namedAccounts.some(row => row.archivedAt != null || ['normalizedName', 'type', 'nature', 'currency']
    .some(key => row[key] !== draft[key]))) throw importError('CONFLICT')
  const previous = existing.find(row => row.draftAccountId === draftAccountId)
  if (previous) {
    const changed = ['name', 'normalizedName', 'type', 'nature', 'currency'].some(key => previous[key] !== draft[key])
    if (changed && previous.materializedAt != null) throw importError('CONFLICT')
    if (changed) await connection.execute(`UPDATE catledger_finance_update_account_drafts
      SET name = ?, normalized_name = ?, type = ?, nature = ?, currency = ?, action_id = ?, superseded_at = NULL
      WHERE uid = ? AND update_id = ? AND draft_account_id = ? AND materialized_at IS NULL`,
    [draft.name, draft.normalizedName, draft.type, draft.nature, draft.currency, actionId, uid, updateId, draftAccountId])
    else if (previous.materializedAt == null) await connection.execute(`UPDATE catledger_finance_update_account_drafts
      SET superseded_at = NULL WHERE uid = ? AND update_id = ? AND draft_account_id = ? AND materialized_at IS NULL`,
    [uid, updateId, draftAccountId])
  } else {
    try {
      await connection.execute(
        `INSERT INTO catledger_finance_update_account_drafts
           (uid, draft_account_id, update_id, name, normalized_name, type,
            nature, currency, action_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uid, draftAccountId, updateId, draft.name, draft.normalizedName,
          draft.type, draft.nature, draft.currency, actionId]
      )
    } catch (error) {
      if (error?.code === 'ER_DUP_ENTRY') draftPolicy.conflict()
      throw error
    }
  }
  if (batch) batch.accountCreationOwners.set(draftAccountId, owner)
  return draftAccountId
}

// 核对中补建目标与决定一起提交；外层幂等事务保证失败时不会留下孤立草稿。
async function stageRepaymentAllocationDrafts(connection, uid, updateId, allocations, actionId) {
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > 20) throw importError('VALIDATION_ERROR')
  const result = []
  for (const [index, item] of allocations.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some((key) => !['accountId', 'accountDraft', 'amountMinor'].includes(key)) ||
        Boolean(item.accountId) === Boolean(item.accountDraft)) throw importError('VALIDATION_ERROR')
    if (!item.accountDraft) { result.push(item); continue }
    const draft = item.accountDraft
    if (!['credit', 'other_liability'].includes(draft.type) || draft.currency !== 'CNY') throw importError('VALIDATION_ERROR')
    const accountId = await stageAccountDraft(connection, uid, updateId, draft, actionId,
      { creationKey: digestParts('repayment-account-creation-v1', actionId, String(index)) })
    result.push({ accountId, amountMinor: item.amountMinor })
  }
  return result
}

async function materializeAccountDrafts(connection, uid, updateId, reachableDraftIds) {
  if (!(reachableDraftIds instanceof Set)) throw importError('VALIDATION_ERROR')
  const [drafts] = await connection.execute(
    `SELECT draft_account_id AS accountId, type, nature, name, normalized_name AS normalizedName, currency
       FROM catledger_finance_update_account_drafts
      WHERE uid = ? AND update_id = ? AND materialized_at IS NULL
      ORDER BY draft_account_id FOR UPDATE`,
    [uid, updateId]
  )
  const reachable = drafts.filter((draft) => reachableDraftIds.has(draft.accountId))
  const existing = new Map()
  for (const part of chunks(reachable.map(draft => [draft.accountId]))) {
    const [rows] = await connection.execute(`SELECT account_id AS accountId,type,nature,normalized_name AS normalizedName,currency,archived_at AS archivedAt
      FROM catledger_accounts WHERE uid=? AND account_id IN (${part.map(() => '?').join(',')}) FOR UPDATE`, [uid, ...part.flat()])
    for (const row of rows) existing.set(row.accountId, row)
  }
  // 核对中显式新建计划可同时建立所属信用卡；入账沿用同一 ID，仍核验属性与可用状态。
  for (const draft of reachable) {
    const account = existing.get(draft.accountId)
    if (account && (account.archivedAt != null || ['type', 'nature', 'normalizedName', 'currency']
      .some(key => account[key] !== draft[key]))) throw importError('CONFLICT')
  }
  try {
    await insertMany(connection, `INSERT INTO catledger_accounts
      (uid, account_id, type, nature, name, normalized_name, currency) VALUES`,
      reachable.filter(draft => !existing.has(draft.accountId))
        .map(draft => [uid, draft.accountId, draft.type, draft.nature, draft.name, draft.normalizedName, draft.currency]))
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') draftPolicy.conflict()
    throw error
  }
  for (const part of chunks(reachable.map(draft => [draft.accountId]))) {
    await connection.execute(`UPDATE catledger_finance_update_account_drafts
      SET materialized_at = CURRENT_TIMESTAMP(3), superseded_at = NULL
      WHERE uid = ? AND update_id = ? AND materialized_at IS NULL
        AND draft_account_id IN (${part.map(() => '?').join(',')})`, [uid, updateId, ...part.flat()])
  }
  await connection.execute(`UPDATE catledger_finance_update_account_drafts
    SET superseded_at = COALESCE(superseded_at, CURRENT_TIMESTAMP(3))
    WHERE uid = ? AND update_id = ? AND materialized_at IS NULL`, [uid, updateId])
  return reachable
}

async function reachableDraftIds(connection, uid, updateId, events) {
  const reachable = reachableAccountIds(events)
  const [mappings] = await connection.execute(`SELECT d.event_id AS eventId, d.account_id AS accountId
    FROM catledger_finance_update_account_mapping_drafts d
    WHERE d.uid = ? AND d.update_id = ? AND d.mapping_action = 'account' AND d.account_id IS NOT NULL`, [uid, updateId])
  const eventIds = new Set(events.map((event) => event.eventId))
  for (const row of mappings) if (eventIds.has(row.eventId)) reachable.add(row.accountId)
  return reachable
}

async function synchronizeDraftReachability(connection, uid, updateId, { abandoned = false } = {}) {
  const [events] = abandoned ? [[]] : await connection.execute(
    `SELECT event_id AS eventId, status, ledger_account_id AS ledgerAccountId, counterparty_ledger_account_id AS counterpartyLedgerAccountId,
            field_sources_json AS fieldSources FROM catledger_economic_events
      WHERE uid = ? AND update_id = ? AND status IN ('ready', 'needs_action')`, [uid, updateId])
  const reachable = abandoned ? new Set() : await reachableDraftIds(connection, uid, updateId, events)
  if (!reachable.size) {
    await connection.execute(`UPDATE catledger_finance_update_account_drafts
      SET superseded_at = COALESCE(superseded_at, CURRENT_TIMESTAMP(3))
      WHERE uid = ? AND update_id = ? AND materialized_at IS NULL`, [uid, updateId])
    return
  }
  const [drafts] = await connection.execute(`SELECT draft_account_id AS accountId FROM catledger_finance_update_account_drafts
    WHERE uid = ? AND update_id = ? AND materialized_at IS NULL ORDER BY draft_account_id`, [uid, updateId])
  for (const part of chunks(drafts.map(draft => [draft.accountId, reachable.has(draft.accountId) ? 1 : 0]), { parametersPerRow: 3, fixedParameters: 2 })) {
    await connection.execute(`UPDATE catledger_finance_update_account_drafts SET superseded_at = CASE draft_account_id
      ${part.map(() => 'WHEN ? THEN IF(?, NULL, COALESCE(superseded_at, CURRENT_TIMESTAMP(3)))').join(' ')} END
      WHERE uid = ? AND update_id = ? AND materialized_at IS NULL AND draft_account_id IN (${part.map(() => '?').join(',')})`,
    [...part.flat(), uid, updateId, ...part.map(row => row[0])])
  }
}

function reachableAccountIds(events) {
  const result = new Set()
  for (const event of events) {
    for (const id of [event.ledgerAccountId, event.counterpartyLedgerAccountId]) if (id) result.add(id)
    const fields = typeof event.fieldSources === 'string' ? JSON.parse(event.fieldSources) : event.fieldSources || {}
    for (const allocation of fields.paymentAccounts || []) if (allocation.accountId) result.add(allocation.accountId)
    for (const allocation of (fields.paymentResolution && fields.paymentResolution.allocations) || []) if (allocation.accountId) result.add(allocation.accountId)
    for (const allocation of fields.editorOverrides?.incompleteComposition?.parts || []) if (allocation.accountId) result.add(allocation.accountId)
    for (const allocation of fields.repaymentAllocations || []) if (allocation.accountId) result.add(allocation.accountId)
  }
  return result
}

module.exports = {
  reachableDraftIds,
  reachableAccountIds,
  synchronizeDraftReachability,
  ACCOUNT_NATURES,
  materializeAccountDrafts,
  normalizeAccountName,
  stageAccountDraft,
  stageRepaymentAllocationDrafts
}
