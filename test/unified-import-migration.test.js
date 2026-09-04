const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { splitSqlStatements } = require('../migrations/runner')

const migrationPath = path.join(__dirname, '..', 'migrations', '0006_unified_finance_updates.sql')
const sql = fs.readFileSync(migrationPath, 'utf8')

const NEW_TABLES = [
  'catledger_finance_updates',
  'catledger_finance_update_sources',
  'catledger_import_batch_issues',
  'catledger_economic_event_relations',
  'catledger_economic_event_transactions',
  'catledger_finance_actions',
  'catledger_review_issues',
  'catledger_review_issue_members',
  'catledger_finance_update_postings'
]

test('0006 可由迁移执行器完整分句且所有新表 forward-only 创建', function () {
  assert.ok(splitSqlStatements(sql).length >= 20)
  for (const table of NEW_TABLES) {
    assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\('))
  }
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|DATABASE)/i)
})

test('0006 新领域表的主键、唯一键和外键都包含 uid 用户范围', function () {
  for (const table of NEW_TABLES) {
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS ' + table)
    const end = sql.indexOf(') ENGINE=InnoDB', start)
    const definition = sql.slice(start, end)
    assert.match(definition, /uid CHAR\(36\)[\s\S]*NOT NULL/)
    assert.match(definition, /PRIMARY KEY \(uid, /)
    for (const line of definition.split('\n').filter(function (item) {
      return /(?:UNIQUE KEY|FOREIGN KEY)/.test(item)
    })) {
      assert.match(line, /\(uid(?:, |\))/, table + ' 存在未按 uid 隔离的约束: ' + line.trim())
    }
  }
})

test('0006 对旧事件和证据表只通过 information_schema 守卫扩展', function () {
  assert.match(sql, /information_schema\.columns[\s\S]*ALTER TABLE catledger_economic_events/)
  assert.match(sql, /information_schema\.columns[\s\S]*ALTER TABLE catledger_event_evidence/)
  assert.match(sql, /uk_catledger_event_update_key \(uid, update_id, event_key\)/)
  assert.match(sql, /uk_catledger_event_evidence_update_row \(uid, update_id, row_id\)/)
})
