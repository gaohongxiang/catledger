const { test } = require('node:test')
const assert = require('node:assert/strict')
const { BUDGET, assertBudget, pageSize, ordinarySqlBudget } = require('../cloudfunctions/catledger-import/src/performance-contract')
const { createObserver } = require('../scripts/performance-observer')

test('UTF-8 budget rejects oversized requests and freezes bounded page sizes', () => {
  assert.throws(() => assertBudget({ note: '猫'.repeat(BUDGET.request / 2) }, 'request'), { publicCode: 'REQUEST_TOO_LARGE' })
  assert.equal(pageSize(), 40)
  assert.equal(pageSize(100), 100)
  for (const size of [0, 101, 1.1, '40']) assert.throws(() => pageSize(size), { publicCode: 'VALIDATION_ERROR' })
  assert.equal(ordinarySqlBudget('post', 24990), 2160)
})

test('SQL observer reports counts and rows without SQL literals or binding values', async () => {
  const privateText = 'private-synthetic-only'
  const observer = createObserver({ async getConnection() { return { async execute() { return [[{}, {}]] }, release() {} } } })
  const connection = await observer.pool.getConnection()
  await connection.execute("SELECT 'sensitive-literal' WHERE secret = ?", [privateText])
  const result = observer.snapshot()
  assert.equal(result.sqlCount, 1)
  assert.equal(result.sqlFingerprints[0].rows, 2)
  assert.doesNotMatch(JSON.stringify(result), /private-synthetic|sensitive-literal|SELECT|secret/)
  observer.reset()
  assert.equal(observer.snapshot().sqlCount, 0)
})


test('SQL chunks respect UTF-8 bytes, placeholder and row limits before writes', () => {
  const { chunks } = require('../cloudfunctions/catledger-import/src/sql-batch')
  const input = Array.from({ length: 201 }, () => ['合成'.repeat(6000), 1])
  const parts = [...chunks(input)]
  assert.equal(parts.flat().length, 201)
  for (const part of parts) {
    assert.ok(part.length <= 100)
    assert.ok(4096 + part.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 64, 0) <= BUDGET.sqlBytes)
  }
  assert.throws(() => [...chunks([['猫'.repeat(BUDGET.sqlBytes)]])], { publicCode: 'REQUEST_TOO_LARGE' })
  assert.equal([...chunks(Array.from({ length: 100 }, () => [1]), { parametersPerRow: 100, fixedParameters: 1 })][0].length, 59)
})
