const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { checksum, runMigrations, splitSqlStatements } = require('../migrations/runner')

function migrationDirectory(t, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catledger-migration-manifest-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), sql)
  return directory
}

function migrationDatabase({ history = null, acquire = 1, historyError, onQuery, releaseError, onHistory } = {}) {
  let rows = history && history.map(row => ({ ...row }))
  let locked = false
  const writes = [], statements = [], locks = []
  let releases = 0, destroyed = 0
  const connection = {
    async execute(sql, values = []) {
      if (sql.includes('GET_LOCK')) {
        locks.push(values[0]); locked = acquire === 1
        return [[{ acquired: acquire }]]
      }
      if (sql.includes('RELEASE_LOCK')) {
        assert.equal(locked, true)
        assert.equal(values[0], locks.at(-1))
        locked = false
        if (releaseError) throw releaseError
        return [[{ released: 1 }]]
      }
      assert.equal(locked, true, 'migration reads and writes must keep the same connection lock')
      if (sql.startsWith('SELECT version, checksum')) {
        if (historyError) throw historyError
        if (onHistory) onHistory()
        if (!rows) throw Object.assign(new Error('synthetic absent registry'), { code: 'ER_NO_SUCH_TABLE' })
        return [[...rows].sort((a, b) => a.version.localeCompare(b.version))]
      }
      writes.push(sql)
      if (sql.includes('CREATE TABLE IF NOT EXISTS catledger_schema_migrations')) rows = rows || []
      else if (sql.startsWith('INSERT INTO catledger_schema_migrations')) {
        rows.push({ version: values[0], checksum: values[1] })
      } else assert.fail('unexpected migration SQL')
      return [[]]
    },
    async query(sql) {
      assert.equal(locked, true)
      writes.push(sql); statements.push(sql)
      if (onQuery) await onQuery(sql)
      return [[]]
    },
    release() { releases++ },
    destroy() { destroyed++ }
  }
  return { pool: { getConnection: async () => connection }, writes, statements, locks,
    get rows() { return rows }, get releases() { return releases }, get destroyed() { return destroyed } }
}

function migrationRecord(file, sql) { return { version: file, checksum: checksum(sql) } }

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

test('迁移清单缺号、重复编号、空包和非法SQL文件在任何DDL前拒绝', async t => {
  const cases = [
    ['empty', {}, /manifest is empty/],
    ['missing first', { '0002_next.sql': 'SELECT 2;' }, /unique and continuous/],
    ['gap', { '0001_base.sql': 'SELECT 1;', '0003_next.sql': 'SELECT 3;' }, /unique and continuous/],
    ['duplicate number', { '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 2;' }, /unique and continuous/],
    ['invalid SQL filename', { '0001_base.sql': 'SELECT 1;', 'next.sql': 'SELECT 2;' }, /Invalid migration file/],
    ['wrong case', { '0001_base.SQL': 'SELECT 1;' }, /Invalid migration file/],
    ['late parse failure', { '0001_base.sql': 'SELECT 1;', '0002_next.sql': "SELECT 'unfinished" }, /unterminated quoted/]
  ]
  for (const [name, files, error] of cases) await t.test(name, async t => {
    const database = migrationDatabase()
    await assert.rejects(runMigrations({ pool: database.pool, migrationsDirectory: migrationDirectory(t, files) }), error)
    assert.deepEqual(database.writes, [])
    assert.equal(database.rows, null, 'invalid manifests must not create the registry')
    assert.equal(database.releases, 1)
  })
})

test('SQL文件链接不能被忽略为已完整校验的发布包', async t => {
  const directory = migrationDirectory(t, { '0001_base.sql': 'SELECT 1;' })
  fs.symlinkSync(path.join(directory, '0001_base.sql'), path.join(directory, '0002_link.sql'))
  const database = migrationDatabase()
  await assert.rejects(runMigrations({ pool: database.pool, migrationsDirectory: directory }), /Invalid migration file/)
  assert.deepEqual(database.writes, [])
})

test('数据库历史必须为当前清单的完整前缀，全部校验通过前不写库', async t => {
  const files = { '0001_base.sql': 'SELECT 1;', '0002_next.sql': 'SELECT 2;', '0003_last.sql': 'SELECT 3;' }
  const records = Object.entries(files).map(([file, sql]) => migrationRecord(file, sql))
  const cases = [
    ['missing historical file', [records[0], migrationRecord('0002_removed.sql', 'SELECT 2;')], /not a prefix/],
    ['newer database', [...records, migrationRecord('0004_future.sql', 'SELECT 4;')], /not a prefix/],
    ['history starts late', [records[1]], /not a prefix/],
    ['history has a hole', [records[0], records[2]], /not a prefix/],
    ['late checksum mismatch', [records[0], { ...records[1], checksum: checksum('SELECT changed;') }], /checksum mismatch/]
  ]
  for (const [name, history, error] of cases) await t.test(name, async t => {
    const database = migrationDatabase({ history })
    await assert.rejects(runMigrations({ pool: database.pool, migrationsDirectory: migrationDirectory(t, files) }), error)
    assert.deepEqual(database.writes, [])
    assert.equal(database.releases, 1)
  })
})

test('无登记表才初始化，正常升级按顺序登记且重复执行零写入', async t => {
  const files = { '0001_base.sql': 'SELECT 1;', '0002_next.sql': 'SELECT 2;' }
  const directory = migrationDirectory(t, files), database = migrationDatabase()
  assert.deepEqual(await runMigrations({ pool: database.pool, migrationsDirectory: directory }), Object.keys(files))
  assert.deepEqual(database.rows, Object.entries(files).map(([file, sql]) => migrationRecord(file, sql)))
  assert.deepEqual(database.statements, ['SELECT 1', 'SELECT 2'])
  database.writes.length = 0
  assert.deepEqual(await runMigrations({ pool: database.pool, migrationsDirectory: directory }), [])
  assert.deepEqual(database.writes, [])
  assert.equal(database.releases, 2)
  assert.equal(database.locks.length, 2)
})

test('执行使用已完整预检的SQL快照，文件随后改变不改变本次迁移', async t => {
  const files = { '0001_base.sql': 'SELECT 1;', '0002_next.sql': 'SELECT 2;' }
  const directory = migrationDirectory(t, files)
  const database = migrationDatabase({ onHistory() { fs.writeFileSync(path.join(directory, '0002_next.sql'), 'SELECT changed;') } })
  await runMigrations({ pool: database.pool, migrationsDirectory: directory })
  assert.deepEqual(database.statements, ['SELECT 1', 'SELECT 2'])
  assert.equal(database.rows[1].checksum, checksum(files['0002_next.sql']))
})

test('DDL中途失败不登记未完成文件，重试从完整前缀继续并保留重入', async t => {
  const files = { '0001_base.sql': 'SELECT 1;', '0002_next.sql': 'SELECT 2; SELECT 3;' }
  let fail = true
  const database = migrationDatabase({ onQuery(sql) {
    if (sql === 'SELECT 3' && fail) { fail = false; throw new Error('synthetic mid-migration failure') }
  } })
  const directory = migrationDirectory(t, files)
  await assert.rejects(runMigrations({ pool: database.pool, migrationsDirectory: directory }), /mid-migration failure/)
  assert.deepEqual(database.rows.map(row => row.version), ['0001_base.sql'])
  assert.deepEqual(await runMigrations({ pool: database.pool, migrationsDirectory: directory }), ['0002_next.sql'])
  assert.deepEqual(database.statements, ['SELECT 1', 'SELECT 2', 'SELECT 3', 'SELECT 2', 'SELECT 3'])
  assert.equal(database.releases, 2)
})

test('取锁失败或读取登记表失败都不尝试DDL，连接仍释放', async t => {
  const directory = migrationDirectory(t, { '0001_base.sql': 'SELECT 1;' })
  for (const options of [{ acquire: 0 }, { historyError: Object.assign(new Error('synthetic denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }) }]) {
    const database = migrationDatabase(options)
    await assert.rejects(runMigrations({ pool: database.pool, migrationsDirectory: directory }))
    assert.deepEqual(database.writes, [])
    assert.equal(database.releases, 1)
  }
})

test('释放迁移锁失败时丢弃连接，不把可能持锁的连接放回池', async t => {
  const sql = 'SELECT 1;', database = migrationDatabase({
    history: [migrationRecord('0001_base.sql', sql)], releaseError: new Error('synthetic connection failure')
  })
  await assert.rejects(runMigrations({ pool: database.pool, migrationsDirectory: migrationDirectory(t, { '0001_base.sql': sql }) }), /connection failure/)
  assert.equal(database.releases, 0)
  assert.equal(database.destroyed, 1)
})

test('迁移与解锁都失败时保留原迁移错误，并丢弃连接', async t => {
  const database = migrationDatabase({ releaseError: new Error('synthetic unlock failure'),
    onQuery() { throw new Error('synthetic migration failure') } })
  await assert.rejects(runMigrations({ pool: database.pool,
    migrationsDirectory: migrationDirectory(t, { '0001_base.sql': 'SELECT 1;' }) }), /migration failure/)
  assert.equal(database.destroyed, 1)
  assert.equal(database.releases, 0)
})
