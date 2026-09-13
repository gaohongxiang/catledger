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
