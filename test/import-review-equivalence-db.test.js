const test = require('node:test')
const assert = require('node:assert/strict')
const { measure } = require('../scripts/measure-import-review')
test('MINI-1915 固定合成业务图、回执和 SQL 顺序与拆分前一致', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const expected = require('../specs/mini-1915-import-modularization/equivalence-baseline.json')
  assert.deepEqual(await measure(), expected)
})
