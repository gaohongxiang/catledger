// 一次性开发切换工具。仅在本机 *_test 库执行；不修改请求摘要、不合成缺失操作事实。
const { testConfig } = require('./isolated-mysql')
const mysql = require('../cloudfunctions/catledger-import/node_modules/mysql2/promise')
const { encodeReceipt } = require('../cloudfunctions/catledger-import/src/import-receipt')
const { BUDGET, jsonBytes } = require('../cloudfunctions/catledger-import/src/performance-contract')
function conversion(row) {
  const stored = typeof row.result === 'string' ? JSON.parse(row.result) : row.result
  if (stored && stored.receiptVersion === 1 && stored.kind === 'value') return { state: 'current' }
  const fact = stored && stored.appliedResult
  if (!stored || !['finance-update-view', 'review-issue-view'].includes(stored.kind) || !fact ||
      fact.protocolVersion !== 2 || fact.kind !== 'operation-receipt' || fact.action !== row.action ||
      fact.receiptId !== row.keyDigest || fact.updateId !== stored.updateId || !fact.update ||
      fact.update.updateId !== fact.updateId || fact.update.version !== fact.appliedVersion ||
      !Number.isInteger(fact.appliedVersion) || fact.appliedVersion < 1 || fact.status !== fact.update.status ||
      jsonBytes(fact) > BUDGET.receipt) return { state: 'unconfirmed' }
  return { state: 'convertible', value: encodeReceipt(fact) }
}
async function reconcileReceipts(pool, { apply = false } = {}) {
  const counts = { current: 0, convertible: 0, unconfirmed: 0, converted: 0 }
  let uid = '', key = ''
  while (true) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute(`SELECT uid, idempotency_key_digest AS keyDigest, action, result_json AS result
        FROM catledger_mutation_receipts WHERE (action LIKE 'financeUpdates.%' OR action LIKE 'reviewIssues.%' OR action = 'economicEvents.correct') AND (uid > ? OR (uid = ? AND idempotency_key_digest > ?))
        ORDER BY uid, idempotency_key_digest LIMIT 100 FOR UPDATE`, [uid, uid, key])
      for (const row of rows) {
        const result = conversion(row)
        counts[result.state]++
        if (apply && result.state === 'convertible') {
          await connection.execute(`UPDATE catledger_mutation_receipts SET result_json = ?
            WHERE uid = ? AND idempotency_key_digest = ?`, [JSON.stringify(result.value), row.uid, row.keyDigest])
          counts.converted++
        }
      }
      await connection.commit()
      if (rows.length < 100) break
      uid = rows.at(-1).uid; key = rows.at(-1).keyDigest
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
  return counts
}
async function main() {
  const pool = mysql.createPool(testConfig())
  try { process.stdout.write(JSON.stringify(await reconcileReceipts(pool, { apply: process.argv.includes('--apply') })) + '\n') }
  finally { await pool.end() }
}
if (require.main === module) main().catch(() => { process.stderr.write('隔离回执核对未完成；保留原键和事实后重试。\n'); process.exitCode = 1 })
module.exports = { conversion, reconcileReceipts }
