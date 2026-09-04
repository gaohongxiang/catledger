const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { splitSqlStatements } = require('../migrations/runner')

const migrationPath = path.join(__dirname, '..', 'migrations', '0007_finance_update_write_barrier.sql')
const sql = fs.readFileSync(migrationPath, 'utf8')

test('0007 创建用户隔离且可重入的 FinanceUpdate 账户映射草稿表', function () {
  assert.equal(splitSqlStatements(sql).length, 2)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS catledger_finance_update_account_drafts/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS catledger_finance_update_account_mapping_drafts/)
  assert.match(sql, /PRIMARY KEY \(uid, draft_mapping_id\)/)
  assert.match(sql, /UNIQUE KEY uk_catledger_update_account_mapping_draft\s*\(uid, update_id, event_id, source_type, payment_method_key\)/)
  assert.match(sql, /FOREIGN KEY \(uid, update_id\)/)
  assert.match(sql, /UNIQUE KEY uk_catledger_finance_update_account_draft_name\s*\(uid, update_id, normalized_name\)/)
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|DATABASE)/i)
})
