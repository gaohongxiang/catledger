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

async function materializeAccountDrafts(connection, uid, updateId) {
  const [drafts] = await connection.execute(
    `SELECT draft_account_id AS accountId, type, nature, name, normalized_name AS normalizedName, currency
       FROM catledger_finance_update_account_drafts
      WHERE uid = ? AND update_id = ? AND materialized_at IS NULL
      ORDER BY draft_account_id FOR UPDATE`,
    [uid, updateId]
  )
  for (const draft of drafts) {
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
  if (drafts.length > 0) {
    await connection.execute(
      `UPDATE catledger_finance_update_account_drafts
          SET materialized_at = CURRENT_TIMESTAMP(3)
        WHERE uid = ? AND update_id = ? AND materialized_at IS NULL`,
      [uid, updateId]
    )
  }
  return drafts
}

module.exports = {
  ACCOUNT_NATURES,
  materializeAccountDrafts,
  normalizeAccountName,
  stageAccountDraft
}
