const { importError } = require('./errors')

function encodeReceipt(result) {
  if (result && result.update && result.issue && typeof result.issue.issueId === 'string' && Array.isArray(result.members)) {
    return { receiptVersion: 1, kind: 'review-issue-view', updateId: result.update.updateId, issueId: result.issue.issueId }
  }
  if (result && result.update && typeof result.update.updateId === 'string' &&
      Array.isArray(result.events) && Array.isArray(result.issues)) {
    return { receiptVersion: 1, kind: 'finance-update-view', updateId: result.update.updateId }
  }
  return { receiptVersion: 1, kind: 'value', value: result }
}

async function readReceipt(connection, uid, stored, readIssue) {
  const receipt = typeof stored === 'string' ? JSON.parse(stored) : stored
  if (!receipt || receipt.receiptVersion !== 1) throw importError('IDEMPOTENCY_CONFLICT')
  if (receipt.kind === 'value') return receipt.value
  if (!['finance-update-view', 'review-issue-view'].includes(receipt.kind) || typeof receipt.updateId !== 'string') {
    throw importError('IDEMPOTENCY_CONFLICT')
  }
  // 幂等键保证动作只执行一次；视图引用读取用户当前已提交的批次状态。
  const { getUpdateView, selectUpdate, publicUpdate } = require('./finance-update-repository')
  if (receipt.kind === 'review-issue-view') {
    const update = publicUpdate(await selectUpdate(connection, uid, receipt.updateId))
    const [[issue]] = await connection.execute('SELECT issue_id FROM catledger_review_issues WHERE uid = ? AND update_id = ? AND issue_id = ?',
      [uid, receipt.updateId, receipt.issueId])
    if (!issue) return { update, issue: null, members: [], accounts: [], accountDrafts: [], categories: [] }
    if (typeof readIssue !== 'function') throw importError('IDEMPOTENCY_CONFLICT')
    return readIssue(connection, uid, receipt.issueId)
  }
  return getUpdateView(connection, uid, receipt.updateId)
}

module.exports = { encodeReceipt, readReceipt }
