const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')

// 目录只描述可选项；余额和统计继续使用独立的正式账本读模型。
async function queryCatalog(connection, uid) {
  const [accounts] = await connection.execute(
    `SELECT account_id AS accountId, type, nature, name, currency,
            version, archived_at AS archivedAt
       FROM catledger_accounts WHERE uid = ?
      ORDER BY archived_at IS NOT NULL, nature, created_at, account_id`, [uid])
  const [categories] = await connection.execute(
    `SELECT category_id AS id, kind, system_key AS systemKey, name,
            sort_order AS sortOrder, version, archived_at AS archivedAt
       FROM catledger_categories WHERE uid = ?
      ORDER BY kind, sort_order, category_id`, [uid])
  return {
    uid,
    accounts: accounts.map(row => ({
      accountId: row.accountId, type: row.type, nature: row.nature,
      name: row.name, currency: row.currency, version: Number(row.version),
      archived: row.archivedAt != null
    })),
    categories: categories.map(row => ({
      id: row.id, kind: row.kind, systemKey: row.systemKey, name: row.name,
      sortOrder: Number(row.sortOrder), version: Number(row.version),
      archived: row.archivedAt != null
    }))
  }
}

function createCatalogService({ getPool }) {
  return {
    async get({ provider, subjectHash, data = {} }) {
      if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length) {
        throw ledgerError('VALIDATION_ERROR')
      }
      return executeLedgerRead({
        getPool, provider, subjectHash, consistentSnapshot: true,
        operation: queryCatalog
      })
    }
  }
}

module.exports = { createCatalogService, queryCatalog }
