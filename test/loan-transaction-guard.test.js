const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { assertNoLoanTransactions } = require('../cloudfunctions/catledger-api/src/loan-transaction-guard')
test('跨部署贷款保护的分块、去重与用户范围一致', async () => {
  const api = fs.readFileSync(require.resolve('../cloudfunctions/catledger-api/src/loan-transaction-guard'), 'utf8')
  const importer = fs.readFileSync(require.resolve('../cloudfunctions/catledger-import/src/loan-transaction-guard'), 'utf8')
  assert.equal(importer, api.replace("const { ledgerError } = require('./ledger-errors')", "const { importError } = require('./errors')").replaceAll('throw ledgerError(', 'throw importError('))
  const counts = []
  const connection = { execute: async (sql, values) => { assert.match(sql, /uid=\? AND active_transaction_id IN/); assert.equal(values[0], 'synthetic-user'); counts.push(values.length - 1); return [[]] } }
  const ids = Array.from({ length: 24990 }, (_, n) => 'transaction-' + n)
  await assertNoLoanTransactions(connection, 'synthetic-user', ids.concat(ids))
  assert.equal(counts.length, 250); assert.equal(counts.at(-1), 90); assert.equal(Math.max(...counts), 100)
  await assert.rejects(assertNoLoanTransactions({ execute: async () => [[{ payment_id: 'bound' }]] }, 'synthetic-user', ['transaction']), { publicCode: 'LOAN_TRANSACTION_LOCKED' })
})
