const { importError } = require('./errors')
const { MAINTENANCE_POLICY_VERSION } = require('./maintenance-policy')

// 表名和列名只由本模块的封闭枚举选择，值始终参数绑定。
const CONFIG = Object.freeze({
  account: { table: 'catledger_import_account_mappings', key: 'payment_method_key', property: 'paymentMethodKey',
    fields: 'mapping_action AS mappingAction, account_id AS accountId' },
  category: { table: 'catledger_import_category_mappings', key: 'alias_key', property: 'aliasKey',
    fields: 'category_id AS categoryId' }
})
async function readMapping(connection, uid, kind, key, forUpdate = true) {
  const config = CONFIG[kind]
  const [rows] = await connection.execute(`SELECT mapping_id AS mappingId, version, source_type AS sourceType,
    ${config.key} AS ${config.property}, ${config.fields}, disabled_at AS disabledAt
    FROM ${config.table} WHERE uid = ? AND source_type = ? AND ${config.key} = ?${forUpdate ? ' FOR UPDATE' : ''}`,
  [uid, key.sourceType, key[config.property]])
  return rows[0] ? { ...rows[0], version: Number(rows[0].version) } : null
}

async function inspectSideEffects(connection, uid, updateId, audit, { forUpdate = false } = {}) {
  if (!audit || audit.version !== MAINTENANCE_POLICY_VERSION) return { verified: false, mappings: [], accounts: [] }
  const mappings = []
  for (const [kind, saved] of [['account', audit.accountMappings], ['category', audit.categoryMappings]]) {
    for (const change of saved || []) {
      const current = await readMapping(connection, uid, kind, change.after, forUpdate)
      // 任意其他活动整理引用同一个规则均视为独立使用，避免撤销改变另一个整理的意图。
      const [used] = await connection.execute(kind === 'account' ?
        `SELECT evidence.event_id FROM catledger_event_evidence evidence
          JOIN catledger_import_rows source ON source.uid = evidence.uid AND source.row_id = evidence.row_id
          JOIN catledger_finance_update_sources origin ON origin.uid = evidence.uid AND origin.update_id = evidence.update_id AND origin.batch_id = source.batch_id
          JOIN catledger_finance_updates u ON u.uid = evidence.uid AND u.update_id = evidence.update_id
          WHERE evidence.uid = ? AND evidence.update_id <> ? AND origin.source_type_snapshot = ? AND (source.payment_method_key = ? OR EXISTS (
            SELECT 1 FROM catledger_finance_update_account_mapping_drafts d WHERE d.uid = evidence.uid
              AND d.update_id = evidence.update_id AND d.source_type = origin.source_type_snapshot AND d.payment_method_key = ?))
          AND u.status NOT IN ('abandoned', 'undone', 'failed') LIMIT 1` :
        `SELECT e.event_id FROM catledger_economic_events e
          JOIN catledger_finance_updates u ON u.uid = e.uid AND u.update_id = e.update_id
          WHERE e.uid = ? AND e.update_id <> ? AND e.category_id = ?
          AND u.status NOT IN ('abandoned', 'undone', 'failed') LIMIT 1`,
      kind === 'account' ? [uid, updateId, change.after.sourceType, change.after.paymentMethodKey, change.after.paymentMethodKey] : [uid, updateId, change.after.categoryId])
      let restoreValid = true
      const previousId = change.before && (kind === 'account' ? change.before.accountId : change.before.categoryId)
      if (previousId) {
        const [targets] = await connection.execute(kind === 'account' ?
          'SELECT account_id FROM catledger_accounts WHERE uid = ? AND account_id = ? AND archived_at IS NULL' :
          'SELECT category_id FROM catledger_categories WHERE uid = ? AND category_id = ? AND archived_at IS NULL', [uid, previousId])
        restoreValid = targets.length === 1
      }
      mappings.push({ kind, ...change, currentVersion: current && current.version, restoreValid,
        revert: Boolean(current && current.version === change.after.version && used.length === 0) })
    }
  }
  const accounts = []
  for (const saved of audit.accounts || []) {
    const [rows] = await connection.execute(`SELECT account_id AS accountId, version, archived_at AS archivedAt
      FROM catledger_accounts WHERE uid = ? AND account_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [uid, saved.accountId])
    const [used] = await connection.execute(`SELECT t.transaction_id FROM catledger_transactions t
      WHERE t.uid = ? AND t.deleted_at IS NULL AND (t.source_account_id = ? OR t.destination_account_id = ?)
      AND NOT EXISTS (SELECT 1 FROM catledger_economic_event_transactions l WHERE l.uid = t.uid
        AND l.update_id = ? AND l.transaction_id = t.transaction_id AND l.creation_method = 'created') LIMIT 1`,
    [uid, saved.accountId, saved.accountId, updateId])
    const [eventUse] = await connection.execute(`SELECT e.event_id FROM catledger_economic_events e
      JOIN catledger_finance_updates u ON u.uid = e.uid AND u.update_id = e.update_id
      WHERE e.uid = ? AND e.update_id <> ? AND u.status NOT IN ('abandoned', 'undone', 'failed')
      AND (e.ledger_account_id = ? OR e.counterparty_ledger_account_id = ?
        OR JSON_SEARCH(e.field_sources_json, 'one', ?, NULL, '$.repaymentAllocations[*].accountId') IS NOT NULL
        OR JSON_SEARCH(e.field_sources_json, 'one', ?, NULL, '$.paymentAccounts[*].accountId') IS NOT NULL
        OR JSON_SEARCH(e.field_sources_json, 'one', ?, NULL, '$.paymentResolution.allocations[*].accountId') IS NOT NULL
        OR EXISTS (SELECT 1 FROM catledger_finance_update_account_mapping_drafts d WHERE d.uid = e.uid
          AND d.update_id = e.update_id AND d.account_id = ? AND d.mapping_action = 'account')) LIMIT 1`,
    [uid, updateId, saved.accountId, saved.accountId, saved.accountId, saved.accountId, saved.accountId, saved.accountId])
    const [mapped] = await connection.execute(`SELECT mapping_id AS mappingId FROM catledger_import_account_mappings
      WHERE uid = ? AND account_id = ? AND disabled_at IS NULL`, [uid, saved.accountId])
    const mappingUse = mapped.some((row) => !mappings.some((item) => item.kind === 'account' && item.after.mappingId === row.mappingId && item.revert &&
      !(item.before && item.restoreValid && !item.before.disabledAt && item.before.accountId === saved.accountId)))
    accounts.push({ ...saved, currentVersion: rows[0] && Number(rows[0].version),
      archive: Boolean(rows[0] && !rows[0].archivedAt && Number(rows[0].version) === saved.version && !used.length && !eventUse.length && !mappingUse) })
  }
  return { verified: true, mappings, accounts }
}

async function revertSideEffects(connection, uid, effects) {
  if (!effects.verified) throw importError('CONFLICT')
  for (const item of effects.mappings.filter((row) => row.revert)) {
    const config = CONFIG[item.kind]
    const previous = item.before && item.restoreValid ? item.before : null
    const fields = item.kind === 'account' ? 'mapping_action = ?, account_id = ?,' : 'category_id = ?,'
    const values = item.kind === 'account' ? [previous ? previous.mappingAction : item.after.mappingAction, previous ? previous.accountId : item.after.accountId] :
      [previous ? previous.categoryId : item.after.categoryId]
    const [result] = await connection.execute(`UPDATE ${config.table} SET ${fields}
      disabled_at = ${previous && !previous.disabledAt ? 'NULL' : 'CURRENT_TIMESTAMP(3)'}, version = version + 1
      WHERE uid = ? AND mapping_id = ? AND version = ?`, [...values, uid, item.after.mappingId, item.after.version])
    if (result.affectedRows !== 1) throw importError('CONFLICT')
  }
  for (const item of effects.accounts.filter((row) => row.archive)) {
    const [result] = await connection.execute(`UPDATE catledger_accounts SET archived_at = CURRENT_TIMESTAMP(3), version = version + 1
      WHERE uid = ? AND account_id = ? AND version = ? AND archived_at IS NULL`, [uid, item.accountId, item.version])
    if (result.affectedRows !== 1) throw importError('CONFLICT')
  }
}
function publicSideEffects(effects) {
  return { verified: effects.verified,
    archivedAccountIds: effects.accounts.filter((row) => row.archive).map((row) => row.accountId),
    retainedAccountIds: effects.accounts.filter((row) => !row.archive).map((row) => row.accountId),
    revertedMappingCount: effects.mappings.filter((row) => row.revert).length,
    retainedMappingCount: effects.mappings.filter((row) => !row.revert).length }
}
module.exports = { readMapping, inspectSideEffects, revertSideEffects, publicSideEffects }
