const test = require('node:test')
const assert = require('node:assert/strict')
const { measure } = require('../scripts/measure-import-review')
test('当前分类预设下导入业务图、回执、请求量与 SQL 顺序保持', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const expected = require('./fixtures/import-review-baseline.json')
  assert.deepEqual(await measure(), expected)
})
