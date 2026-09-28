const test = require('node:test')
const assert = require('node:assert/strict')
const { statements } = require('../scripts/print-permanent-delete-grants')

test('永久删除授权支持 CloudBase 带连字符的库名且只授予三张表', () => {
  assert.deepEqual(statements({ database: 'cloud1-synthetic-test', user: 'api_runtime', host: '%' }), [
    "GRANT DELETE ON `cloud1-synthetic-test`.`catledger_transactions` TO 'api_runtime'@'%';",
    "GRANT DELETE ON `cloud1-synthetic-test`.`catledger_economic_event_transactions` TO 'api_runtime'@'%';",
    "GRANT DELETE ON `cloud1-synthetic-test`.`catledger_review_issue_members` TO 'api_runtime'@'%';"
  ])
})

test('永久删除授权拒绝通配库名与 SQL 注入', () => {
  const input = { database: 'cloud1-synthetic-test', user: 'api_runtime', host: '%' }
  for (const database of ['*', 'db.table', 'db`.* TO x; --', 'db; GRANT ALL', '']) {
    assert.throws(() => statements({ ...input, database }))
  }
  assert.throws(() => statements({ ...input, user: "api'@'%' WITH GRANT OPTION; --" }))
  assert.throws(() => statements({ ...input, host: "%'; GRANT ALL ON *.*; --" }))
})
