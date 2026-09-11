const { ledgerError } = require('./ledger-errors')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { validateId, parseVersion } = require('./transaction-domain')

// 分类是正式交易的展示归属；不重新解释导入事件，也不改动任何资金字段。
async function setTransactionCategory(connection, uid, data) {
  const allowed = new Set(['requestId', 'transactionId', 'version', 'categoryId'])
  if (Object.keys(data).some(key => !allowed.has(key)) || !Object.hasOwn(data, 'categoryId')) throw ledgerError('VALIDATION_ERROR')
  const transactionId = validateId(data.transactionId)
  const version = parseVersion(data.version)
  const categoryId = data.categoryId === null ? null : validateId(data.categoryId)
  const [rows] = await connection.execute(
    `SELECT transaction_id AS transactionId, type, category_id AS categoryId, version
       FROM catledger_transactions
      WHERE uid = ? AND transaction_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`, [uid, transactionId])
  const row = rows[0]
  if (!row) throw ledgerError('NOT_FOUND')
  if (!['income', 'expense'].includes(row.type)) throw ledgerError('VALIDATION_ERROR')
  if (Number(row.version) !== version) throw ledgerError('CONFLICT')
  if (categoryId !== null) {
    const [categories] = await connection.execute(
      `SELECT kind FROM catledger_categories
        WHERE uid = ? AND category_id = ? AND archived_at IS NULL LIMIT 1 FOR UPDATE`, [uid, categoryId])
    if (!categories[0]) throw ledgerError('NOT_FOUND')
    if (categories[0].kind !== row.type) throw ledgerError('VALIDATION_ERROR')
  }
  if (row.categoryId === categoryId) return { transactionId, version, categoryId }
  const [result] = await connection.execute(
    `UPDATE catledger_transactions SET category_id = ?, version = version + 1
      WHERE uid = ? AND transaction_id = ? AND version = ? AND deleted_at IS NULL`,
    [categoryId, uid, transactionId, version])
  if (result.affectedRows !== 1) throw ledgerError('CONFLICT')
  if (row.type === 'expense') {
    await connection.execute(
      `UPDATE catledger_transactions SET category_id = ?, version = version + 1
        WHERE uid = ? AND original_transaction_id = ? AND type = 'refund' AND deleted_at IS NULL`,
      [categoryId, uid, transactionId])
  }
  return { transactionId, version: version + 1, categoryId }
}

function createTransactionCategoryService({ getPool }) {
  return context => executeIdempotentMutation({ getPool, ...context,
    action: 'transactions.setCategory', operation: setTransactionCategory })
}
module.exports = { createTransactionCategoryService, setTransactionCategory }
