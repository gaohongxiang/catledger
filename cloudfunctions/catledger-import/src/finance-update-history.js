const { executeUserRead } = require('./import-transaction')
const { encodeCursor, decodeCursor } = require('./view-cursor')
const { importError } = require('./errors')

function createFinanceUpdateHistory({ getPool }) {
  return context => executeUserRead({ getPool, ...context, consistentSnapshot: true,
    operation: async (connection, uid) => {
      const size = context.data.pageSize == null ? 20 : context.data.pageSize
      if (!Number.isInteger(size) || size < 1 || size > 40) throw importError('VALIDATION_ERROR')
      const scope = { uid, kind: 'finance-history', order: 'created-desc' }
      const last = decodeCursor(context.subjectHash, context.data.cursor, scope)
      if (last && (!Array.isArray(last) || last.length !== 2 || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/.test(last[0]) || !/^[0-9a-f-]{36}$/.test(last[1]))) throw importError('INVALID_CURSOR')
      const [rows] = await connection.execute(`SELECT update_id AS updateId, status, version, source_count AS sourceCount,
        created_at AS createdAt FROM catledger_finance_updates WHERE uid = ? AND status IN ('posted', 'undone')
        ${last ? 'AND (created_at < ? OR (created_at = ? AND update_id < ?))' : ''}
        ORDER BY created_at DESC, update_id DESC LIMIT ?`, [uid, ...(last ? [last[0], last[0], last[1]] : []), size + 1])
      const items = rows.slice(0, size).map(row => ({ ...row, version: Number(row.version), sourceCount: Number(row.sourceCount), transactionCount: 0, deletedTransactionCount: 0, files: [] }))
      if (items.length) {
        const [sources] = await connection.execute(`SELECT update_id AS updateId, file_name_snapshot AS fileName
          FROM catledger_finance_update_sources WHERE uid = ? AND update_id IN (${items.map(() => '?').join(', ')})
          ORDER BY update_id, source_order`, [uid, ...items.map(row => row.updateId)])
        const byId = new Map(items.map(row => [row.updateId, row]))
        for (const source of sources) byId.get(source.updateId).files.push(source.fileName)
        const [counts] = await connection.execute(`SELECT l.update_id AS updateId,
          COUNT(DISTINCT CASE WHEN t.deleted_at IS NULL THEN t.transaction_id END) AS transactionCount,
          COUNT(DISTINCT CASE WHEN t.deleted_at IS NOT NULL THEN t.transaction_id END) AS deletedTransactionCount
          FROM catledger_economic_event_transactions l JOIN catledger_transactions t
            ON t.uid = l.uid AND t.transaction_id = l.transaction_id
          WHERE l.uid = ? AND l.update_id IN (${items.map(() => '?').join(', ')})
            AND l.superseded_at IS NULL AND l.role <> 'refund_original'
          GROUP BY l.update_id`, [uid, ...items.map(row => row.updateId)])
        for (const row of counts) Object.assign(byId.get(row.updateId), { transactionCount: Number(row.transactionCount), deletedTransactionCount: Number(row.deletedTransactionCount) })
      }
      const tail = items[items.length - 1]
      return { items, nextCursor: rows.length > size ? encodeCursor(context.subjectHash, scope, [tail.createdAt, tail.updateId]) : null }
    }
  })
}
module.exports = { createFinanceUpdateHistory }
