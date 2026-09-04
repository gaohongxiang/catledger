const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { splitSqlStatements } = require('../migrations/runner')

const migrationPath = path.join(__dirname, '..', 'migrations', '0008_finance_update_payment_rules.sql')
const sql = fs.readFileSync(migrationPath, 'utf8')

test('0008 让 FinanceUpdate 草稿安全表达账户映射或永久忽略', function () {
  assert.equal(splitSqlStatements(sql).length, 15)
  assert.match(sql, /ADD COLUMN mapping_action VARCHAR\(16\).*DEFAULT ''account''/s)
  assert.match(sql, /MODIFY COLUMN account_id CHAR\(36\).*DEFAULT NULL/s)
  assert.match(sql, /mapping_action = ''account'' AND account_id IS NOT NULL/)
  assert.match(sql, /mapping_action = ''ignore'' AND account_id IS NULL/)
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|DATABASE)/i)
})
