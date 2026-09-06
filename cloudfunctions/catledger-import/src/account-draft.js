const { randomUUID } = require('node:crypto')

const { importError } = require('./errors')

const ACCOUNT_NATURES = Object.freeze({
  cash: 'asset',
  bank: 'asset',
  wallet: 'asset',
  credit: 'liability',
  other_asset: 'asset',
  other_liability: 'liability'
})

function normalizeAccountName(value) {
  if (typeof value !== 'string') throw importError('VALIDATION_ERROR')
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  const length = Array.from(name).length
  if (length < 1 || length > 32) throw importError('VALIDATION_ERROR')
  return { name, normalizedName: name.toLocaleLowerCase('zh-CN') }
}

async function stageAccountDraft(connection, uid, updateId, value, actionId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw importError('VALIDATION_ERROR')
  const type = value.type
  const nature = ACCOUNT_NATURES[type]
  if (!nature || value.currency !== 'CNY') throw importError('VALIDATION_ERROR')
  const accountName = normalizeAccountName(value.name)
  const [existing] = await connection.execute(
    `SELECT draft_account_id AS draftAccountId, type, nature, currency
       FROM catledger_finance_update_account_drafts
      WHERE uid = ? AND update_id = ? AND normalized_name = ?
      LIMIT 1 FOR UPDATE`,
    [uid, updateId, accountName.normalizedName]
  )
  if (existing[0]) {
    if (existing[0].type !== type || existing[0].nature !== nature || existing[0].currency !== value.currency) {
      throw importError('CONFLICT')
    }
    return existing[0].draftAccountId
  }
  const draftAccountId = randomUUID()
  await connection.execute(
    `INSERT INTO catledger_finance_update_account_drafts
       (uid, draft_account_id, update_id, name, normalized_name, type,
        nature, currency, action_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uid, draftAccountId, updateId, accountName.name, accountName.normalizedName,
      type, nature, value.currency, actionId]
  )
  return draftAccountId
}

// 核对中补建目标与决定一起提交；外层幂等事务保证失败时不会留下孤立草稿。
async function stageRepaymentAllocationDrafts(connection, uid, updateId, allocations, actionId) {
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > 20) throw importError('VALIDATION_ERROR')
  const result = []
  for (const item of allocations) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some((key) => !['accountId', 'accountDraft', 'amountMinor'].includes(key)) ||
        Boolean(item.accountId) === Boolean(item.accountDraft)) throw importError('VALIDATION_ERROR')
    if (!item.accountDraft) { result.push(item); continue }
    const draft = item.accountDraft
    if (!['credit', 'other_liability'].includes(draft.type) || draft.currency !== 'CNY') throw importError('VALIDATION_ERROR')
    const name = normalizeAccountName(draft.name)
    const [existing] = await connection.execute(`SELECT account_id AS accountId, type, currency, archived_at AS archivedAt
      FROM catledger_accounts WHERE uid = ? AND normalized_name = ? FOR UPDATE`, [uid, name.normalizedName])
    if (existing.length > 1 || existing.some((account) => account.type !== draft.type || account.currency !== draft.currency || account.archivedAt != null)) throw importError('CONFLICT')
    const accountId = existing[0] ? existing[0].accountId : await stageAccountDraft(connection, uid, updateId, draft, actionId)
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
  for (const draft of reachable) {
    try {
      await connection.execute(
        `INSERT INTO catledger_accounts
           (uid, account_id, type, nature, name, normalized_name, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uid, draft.accountId, draft.type, draft.nature, draft.name, draft.normalizedName, draft.currency]
      )
    } catch (error) {
      if (error && error.code === 'ER_DUP_ENTRY') throw importError('CONFLICT')
      throw error
    }
  }
  if (reachable.length > 0) {
    await connection.execute(
      `UPDATE catledger_finance_update_account_drafts
          SET materialized_at = CURRENT_TIMESTAMP(3), superseded_at = NULL
        WHERE uid = ? AND update_id = ? AND materialized_at IS NULL
          AND draft_account_id IN (${reachable.map(() => '?').join(', ')})`,
      [uid, updateId, ...reachable.map((draft) => draft.accountId)]
    )
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
  await connection.execute(`UPDATE catledger_finance_update_account_drafts
    SET superseded_at = ${reachable.size ? `IF(draft_account_id IN (${[...reachable].map(() => '?').join(', ')}), NULL, COALESCE(superseded_at, CURRENT_TIMESTAMP(3)))` : 'COALESCE(superseded_at, CURRENT_TIMESTAMP(3))'}
    WHERE uid = ? AND update_id = ? AND materialized_at IS NULL`, [...reachable, uid, updateId])
}

function reachableAccountIds(events) {
  const result = new Set()
  for (const event of events) {
    for (const id of [event.ledgerAccountId, event.counterpartyLedgerAccountId]) if (id) result.add(id)
    const fields = typeof event.fieldSources === 'string' ? JSON.parse(event.fieldSources) : event.fieldSources || {}
    for (const allocation of fields.paymentAccounts || []) if (allocation.accountId) result.add(allocation.accountId)
    for (const allocation of (fields.paymentResolution && fields.paymentResolution.allocations) || []) if (allocation.accountId) result.add(allocation.accountId)
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
