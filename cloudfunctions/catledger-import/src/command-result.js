const { assertBudget } = require('./performance-contract')

async function commandResult(connection, uid, updateId, data = {}) {
  const repository = require('./finance-update-repository')
  if (data.resultMode !== 'receipt') return assertBudget(await repository.getUpdateView(connection, uid, updateId), 'legacy')
  const update = repository.publicUpdate(await repository.selectUpdate(connection, uid, updateId))
  const [[posting]] = await connection.execute(`SELECT created_transaction_count AS createdTransactionCount,
    reused_transaction_count AS reusedTransactionCount FROM catledger_finance_update_postings
    WHERE uid = ? AND update_id = ? AND state = 'completed' ORDER BY completed_at DESC LIMIT 1`, [uid, updateId])
  return { update, posting: posting ? { createdTransactionCount: Number(posting.createdTransactionCount),
    reusedTransactionCount: Number(posting.reusedTransactionCount) } : null }
}
function operationReceipt(result, action, receiptId) {
  const update = result.update || result
  return assertBudget({ protocolVersion: 2, kind: 'operation-receipt', receiptId, action,
    updateId: update.updateId, appliedVersion: update.version, status: update.status,
    counts: update.counts, update, posting: result.posting || null,
    invalidates: ['summary', 'events', 'issues', 'members', 'options', 'evidence'] }, 'receipt')
}
module.exports = { commandResult, operationReceipt }
