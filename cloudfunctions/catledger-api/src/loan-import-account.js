const { createHash } = require('node:crypto')
const { normalizeAccountName } = require('./account-name')
const { validateId } = require('./transaction-domain')
const { ledgerError } = require('./ledger-errors')

// 与 local-review-identity 的账户 ID 相同；不允许客户端指定任意已有账户 ID。
function draftAccountId(snapshotId, normalizedName) {
  const parts = ['local-review-v3', 'account', snapshotId, normalizedName, 'credit']
  const hex = createHash('sha256').update(parts.map(value => Buffer.byteLength(value) + ':' + value).join('')).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function createImportAccount(connection, uid, data, origin) {
  const draft = data.importAccountDraft
  if (draft == null) return null
  if (!origin || !draft || typeof draft !== 'object' || Array.isArray(draft) ||
      Object.keys(draft).some(key => !['snapshotId', 'name', 'type', 'currency'].includes(key)) ||
      draft.type !== 'credit' || draft.currency !== 'CNY') throw ledgerError('VALIDATION_ERROR')
  const snapshotId = validateId(draft.snapshotId), accountId = validateId(data.accountId)
  const { name, normalizedName } = normalizeAccountName(draft.name)
  const [[snapshot]] = await connection.execute(`SELECT o.object_id FROM catledger_import_review_objects o
    JOIN catledger_finance_updates u ON u.uid=o.uid AND u.update_id=o.update_id
    WHERE o.uid=? AND o.update_id=? AND o.object_id=? AND o.object_kind='snapshot'
      AND o.state='sealed' AND o.protocol_version=3 AND o.base_version=u.version AND u.status='review'`,
  [uid, origin.updateId, snapshotId])
  if (!snapshot) throw ledgerError('CONFLICT')
  if (draftAccountId(snapshotId, normalizedName) !== accountId) {
    // 旧服务端草稿迁入本机时保留原 ID，需由本批持久化草稿证明，不能仅信客户端。
    const [[stored]] = await connection.execute(`SELECT draft_account_id FROM catledger_finance_update_account_drafts
      WHERE uid=? AND update_id=? AND draft_account_id=? AND normalized_name=?
        AND type='credit' AND nature='liability' AND currency='CNY' AND materialized_at IS NULL AND superseded_at IS NULL`,
    [uid, origin.updateId, accountId, normalizedName])
    if (!stored) throw ledgerError('VALIDATION_ERROR')
  }
  const [[account]] = await connection.execute(`SELECT account_id AS accountId,normalized_name AS normalizedName,
      type,currency,archived_at AS archivedAt FROM catledger_accounts
    WHERE uid=? AND (account_id=? OR normalized_name=?) FOR UPDATE`, [uid, accountId, normalizedName])
  if (account) {
    if (account.accountId !== accountId || account.normalizedName !== normalizedName || account.type !== 'credit' ||
        account.currency !== 'CNY' || account.archivedAt != null) throw ledgerError('CONFLICT')
  } else {
    await connection.execute(`INSERT INTO catledger_accounts (uid,account_id,name,normalized_name,type,nature,currency)
      VALUES (?,?,?,?,'credit','liability','CNY')`, [uid, accountId, name, normalizedName])
  }
  return { accountId, snapshotId }
}

module.exports = { createImportAccount }
