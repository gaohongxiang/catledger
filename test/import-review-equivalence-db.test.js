const test = require('node:test')
const assert = require('node:assert/strict')
const { measure } = require('../scripts/measure-import-review')
test('当前分类预设下导入业务图、回执、请求量与 SQL 顺序保持', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  // 本轮逐字段对照 c4e04a8：交易、余额、关系及回执业务内容保持；仅整理/问题版本及其派生键更新。
  // 查询轮次不变；event-store 增读稳定 event_key，用于关闭消费与退款的来源冲突复核。
  const expected = require('./fixtures/import-review-baseline.json')
  assert.deepEqual(await measure(), expected)
})
