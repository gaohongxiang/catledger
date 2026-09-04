const assert = require('node:assert/strict')
const test = require('node:test')

const {
  assertRuntimePermissions,
  missingRuntimePermissions
} = require('../src/runtime-permission-contract')

const BASE_GRANTS = [
  'GRANT SELECT, INSERT, UPDATE ON `catledger`.`catledger_finance_update_sources` TO `catledger_app`@`%`',
  'GRANT SELECT, INSERT, UPDATE ON `catledger`.`catledger_import_transaction_links` TO `catledger_app`@`%`',
  'GRANT SELECT, INSERT, DELETE ON `catledger`.`catledger_review_issue_members` TO `catledger_app`@`%`'
]

test('账户归属批处理会在旧权限清单上复现 object_version 更新权限缺失', () => {
  const missing = missingRuntimePermissions(BASE_GRANTS)
  assert.deepEqual(missing.map((item) => ({
    table: item.table,
    privilege: item.privilege,
    columns: [...item.columns]
  })), [{
    table: 'catledger_review_issue_members',
    privilege: 'UPDATE',
    columns: ['object_version']
  }])
  assert.throws(() => assertRuntimePermissions(BASE_GRANTS), {
    code: 'CATLEDGER_DB_PERMISSION_MISSING'
  })
})

test('补充最小列权限后同一权限检查通过', () => {
  assert.doesNotThrow(() => assertRuntimePermissions([
    ...BASE_GRANTS,
    'GRANT UPDATE (`object_version`) ON `catledger`.`catledger_review_issue_members` TO `catledger_app`@`%`'
  ]))
})

test('已有整表 UPDATE 权限同样满足契约', () => {
  assert.doesNotThrow(() => assertRuntimePermissions([
    ...BASE_GRANTS.slice(0, 2),
    'GRANT SELECT, INSERT, UPDATE, DELETE ON `catledger`.`catledger_review_issue_members` TO `catledger_app`@`%`'
  ]))
})
