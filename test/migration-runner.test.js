const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { splitSqlStatements } = require('../migrations/runner')

test('迁移分句支持存储过程分隔符，忽略字符串和注释中的分号', () => {
  const sql = `-- comment with ' and ;
DELIMITER $$
CREATE PROCEDURE example()
BEGIN
  SELECT 'a;b', 'it''s;ok', "DELIMITER ;";
  /* quote ' ; $$ */
  SELECT 2;
END$$
DELIMITER ;
CALL example(); # ignored ; '
SELECT 'tail;';`
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 3)
  assert.match(statements[0], /^CREATE PROCEDURE example\(\)[\s\S]*SELECT 2;\s*END$/)
  assert.equal(statements[1], 'CALL example()')
  assert.equal(statements[2], "SELECT 'tail;'")
  assert.throws(() => splitSqlStatements("SELECT 'unfinished"), /unterminated quoted/)
  assert.throws(() => splitSqlStatements('SELECT /* unfinished'), /unterminated comment/)
})

test('0011在同一CALL里完成事务，创建与清理过程分别执行', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/0011_short_user_ids.sql'), 'utf8')
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 4)
  assert.equal(statements[0], 'DROP PROCEDURE IF EXISTS catledger_migrate_short_user_ids')
  assert.match(statements[1], /^CREATE PROCEDURE catledger_migrate_short_user_ids\(\)/)
  assert.equal(statements[2], 'CALL catledger_migrate_short_user_ids()')
  assert.equal(statements[3], 'DROP PROCEDURE catledger_migrate_short_user_ids')
})
