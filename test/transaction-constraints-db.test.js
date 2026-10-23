const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID, randomBytes } = require('node:crypto')
const { runMigrations, splitSqlStatements } = require('../migrations/runner')
const { testConfig } = require('../scripts/isolated-mysql')
const mysql = require('../cloudfunctions/catledger-import/node_modules/mysql2/promise')

const migration = '0036_transaction_shape_constraints.sql'
const migrationsDirectory = path.resolve(__dirname, '../migrations')
const checkNames = ['type', 'origin', 'amount', 'version', 'accounts', 'category', 'original', 'local_date', 'offset', 'utc']
const rejected = error => error.errno === 3819

// 从真实 0035 前缀升级，不能通过先建最新版表再删 CHECK 伪造迁移前状态。
async function legacyDatabase() {
  const config = testConfig(), database = 'catledger_constraints_' + randomBytes(6).toString('hex') + '_test'
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'catledger-constraints-'))
  const admin = mysql.createPool(config)
  let owner, created = false, closed = false
  async function close() {
    if (closed) return
    closed = true
    if (owner) await owner.end()
    if (created) await admin.query('DROP DATABASE `' + database + '`')
    await admin.end()
    await fs.rm(prefix, { recursive: true, force: true })
  }
  try {
    for (const file of await fs.readdir(migrationsDirectory)) {
      if (/^\d{4}_.+\.sql$/.test(file) && file < migration) await fs.copyFile(path.join(migrationsDirectory, file), path.join(prefix, file))
    }
    await admin.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    created = true
    owner = mysql.createPool({ ...config, database })
    assert.equal((await runMigrations({ pool: owner, migrationsDirectory: prefix })).length, 35)
    return { owner, close }
  } catch (error) { await close(); throw error }
}
async function seed(pool) {
  const uid = 'SynE100001', otherUid = 'SynE100002', accountA = randomUUID(), accountB = randomUUID(), otherAccount = randomUUID(), category = randomUUID()
  await pool.execute('INSERT INTO catledger_users(uid) VALUES(?),(?)', [uid, otherUid])
  for (const [user, id, name] of [[uid, accountA, '合成甲'], [uid, accountB, '合成乙'], [otherUid, otherAccount, '合成他人']]) {
    await pool.execute("INSERT INTO catledger_accounts(uid,account_id,type,nature,name,normalized_name) VALUES(?,?,'bank','asset',?,?)", [user, id, name, name])
  }
  await pool.execute("INSERT INTO catledger_categories(uid,category_id,kind,name,normalized_name) VALUES(?,?,'expense','合成分类','合成分类')", [uid, category])
  return { uid, otherUid, accountA, accountB, otherAccount, category }
}
function row(c, fields = {}) {
  return { uid: c.uid, transaction_id: randomUUID(), type: 'expense', source_account_id: c.accountA, destination_account_id: null,
    category_id: null, original_transaction_id: null, amount_minor: '100', occurred_local_date: '2026-10-23',
    occurred_local_at: '2026-10-23 12:13:14.123', timezone_offset_minutes: -480, occurred_at_utc: '2026-10-23 04:13:14.123',
    note: '合成约束验证', origin: 'import', version: 1, deleted_at: null, creation_provenance_json: null, ...fields }
}
function insert(pool, value) {
  return pool.execute('INSERT INTO catledger_transactions (' + Object.keys(value).join(',') + ') VALUES (' + Object.keys(value).map(() => '?').join(',') + ')', Object.values(value))
}
async function transactions(pool) {
  const [rows] = await pool.execute('SELECT * FROM catledger_transactions ORDER BY uid,transaction_id')
  return rows
}
async function checks(pool) {
  const [rows] = await pool.execute("SELECT constraint_name AS name,enforced AS enforced FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='catledger_transactions' AND constraint_type='CHECK' ORDER BY constraint_name")
  return rows
}
async function foreignKeys(pool) {
  const [rows] = await pool.execute(`SELECT r.constraint_name,r.table_name,r.referenced_table_name,r.update_rule,r.delete_rule,
    k.column_name,k.referenced_column_name,k.ordinal_position FROM information_schema.referential_constraints r
    JOIN information_schema.key_column_usage k ON k.constraint_schema=r.constraint_schema AND k.constraint_name=r.constraint_name
    WHERE r.constraint_schema=DATABASE() AND (r.table_name='catledger_transactions' OR r.referenced_table_name='catledger_transactions')
    ORDER BY r.table_name,r.constraint_name,k.ordinal_position`)
  return rows
}
async function assertUnregistered(pool) {
  const [[record]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_schema_migrations WHERE version=?', [migration])
  assert.equal(Number(record.count), 0)
}

test('0036 交易形状约束保留旧账、外键与原子性，失败和中断后可重入', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
  const lab = await legacyDatabase(), pool = lab.owner
  try {
    const c = await seed(pool)
    const original = row(c), pending = row(c, { type: 'refund', source_account_id: null, destination_account_id: c.accountA, category_id: c.category })
    await insert(pool, original)
    const legacy = [pending,
      row(c, { origin: 'manual' }), row(c, { origin: 'loan_plan' }),
      row(c, { type: 'income', source_account_id: null, destination_account_id: c.accountA }),
      row(c, { type: 'transfer', destination_account_id: c.accountB }),
      row(c, { type: 'balance_adjustment', origin: 'system', amount_minor: '9223372036854775808' }),
      row(c, { type: 'balance_adjustment', origin: 'system', source_account_id: null, destination_account_id: c.accountA }),
      row(c, { type: 'refund', source_account_id: null, destination_account_id: c.accountA, original_transaction_id: original.transaction_id, deleted_at: '2026-10-23 13:00:00.000' })]
    for (const value of legacy) await insert(pool, value)
    const before = await transactions(pool), beforeKeys = await foreignKeys(pool)
    await t.test('非法旧行不自动修账或登记；已生效 DDL 遇中断后恢复', async () => {
      const invalid = row(c, { amount_minor: '0' })
      await insert(pool, invalid)
      const dirty = await transactions(pool)
      await assert.rejects(runMigrations({ pool, migrationsDirectory }), rejected)
      await assertUnregistered(pool)
      assert.deepEqual(await transactions(pool), dirty)
      assert.equal((await checks(pool)).length, 2)
      // 只删除本测试故意制造的坏行，迁移本身不能做数据修正。
      await pool.execute('DELETE FROM catledger_transactions WHERE uid=? AND transaction_id=?', [c.uid, invalid.transaction_id])
      let executed = 0
      const interruptedPool = { async getConnection() {
        const connection = await pool.getConnection()
        return { execute: (...args) => connection.execute(...args), release: () => connection.release(), destroy: () => connection.destroy(),
          async query(sql) {
            const result = await connection.query(sql)
            if (/^EXECUTE catledger_check_statement/.test(sql) && ++executed === 3) throw new Error('synthetic connection interruption after DDL')
            return result
          } }
      } }
      await assert.rejects(runMigrations({ pool: interruptedPool, migrationsDirectory }), /synthetic connection interruption/)
      await assertUnregistered(pool)
      assert.equal((await checks(pool)).length, 3)
      assert.deepEqual(await runMigrations({ pool, migrationsDirectory }), [migration])
      assert.deepEqual(await runMigrations({ pool, migrationsDirectory }), [])
      const connection = await pool.getConnection()
      try { for (const statement of splitSqlStatements(await fs.readFile(path.join(migrationsDirectory, migration), 'utf8'))) await connection.query(statement) }
      finally { connection.release() }
      assert.deepEqual(await transactions(pool), before)
      assert.deepEqual(await foreignKeys(pool), beforeKeys)
      assert.deepEqual(await checks(pool), checkNames.map(name => ({ name: 'ck_catledger_transaction_' + name, enforced: 'YES' })).sort((a, b) => a.name.localeCompare(b.name)))
    })
    await t.test('五类交易的全部账户端点组合及合法时区边界', async () => {
      for (const [type, allowed] of [['expense', ['source']], ['income', ['destination']], ['refund', ['destination']], ['transfer', ['different']], ['balance_adjustment', ['source', 'destination']]]) {
        for (const [shape, source, destination] of [['neither', null, null], ['source', c.accountA, null], ['destination', null, c.accountA], ['same', c.accountA, c.accountA], ['different', c.accountA, c.accountB]]) {
          const operation = insert(pool, row(c, { type, source_account_id: source, destination_account_id: destination }))
          if (allowed.includes(shape)) await operation
          else await assert.rejects(operation, rejected, type + '/' + shape)
        }
      }
      for (const [offset, utc] of [[-840, '2026-10-22 22:13:14.123'], [0, '2026-10-23 12:13:14.123'], [840, '2026-10-24 02:13:14.123']]) {
        await insert(pool, row(c, { timezone_offset_minutes: offset, occurred_at_utc: utc }))
      }
    })
    await t.test('每条约束同时拒绝 INSERT 和 UPDATE，失败更新保留原行', async () => {
      const target = row(c)
      await insert(pool, target)
      const cases = [
        { type: 'unknown' }, { type: 'expense ' }, { type: 'EXPENSE' }, { origin: 'legacy' }, { origin: 'import ' }, { origin: 'IMPORT' },
        { amount_minor: '0' }, { version: 0 }, { source_account_id: null },
        { type: 'transfer', destination_account_id: c.accountB, category_id: c.category },
        { type: 'balance_adjustment', origin: 'system', category_id: c.category },
        { original_transaction_id: original.transaction_id },
        { occurred_local_date: '2026-10-22' }, { timezone_offset_minutes: -841 }, { timezone_offset_minutes: 841 },
        { occurred_at_utc: '2026-10-23 20:13:14.123' }, { occurred_at_utc: '2026-10-23 04:13:14.124' }
      ]
      for (const fields of cases) {
        await assert.rejects(insert(pool, row(c, fields)), rejected)
        const snapshot = await transactions(pool)
        await assert.rejects(pool.execute('UPDATE catledger_transactions SET ' + Object.keys(fields).map(key => key + '=?').join(',') + ' WHERE uid=? AND transaction_id=?',
          [...Object.values(fields), c.uid, target.transaction_id]), rejected)
        assert.deepEqual(await transactions(pool), snapshot)
      }
      const id = randomUUID()
      await assert.rejects(insert(pool, row(c, { transaction_id: id, type: 'refund', source_account_id: null, destination_account_id: c.accountA, original_transaction_id: id })), rejected)
      await pool.execute('UPDATE catledger_transactions SET original_transaction_id=NULL,category_id=?,version=version+1 WHERE uid=? AND transaction_id=?', [c.category, c.uid, legacy.at(-1).transaction_id])
    })
    await t.test('用户范围外键及 RESTRICT 保持；同语句和事务失败无部分资金写入', async () => {
      await assert.rejects(insert(pool, row(c, { source_account_id: c.otherAccount })), { errno: 1452 })
      await assert.rejects(insert(pool, row(c, { source_account_id: randomUUID() })), { errno: 1452 })
      await assert.rejects(pool.execute('DELETE FROM catledger_accounts WHERE uid=? AND account_id=?', [c.uid, c.accountA]), { errno: 1451 })
      const snapshot = await transactions(pool), good = row(c), bad = row(c, { amount_minor: '0' })
      await assert.rejects(pool.query('INSERT INTO catledger_transactions (' + Object.keys(good).join(',') + ') VALUES ?', [[Object.values(good), Object.values(bad)]]), rejected)
      assert.deepEqual(await transactions(pool), snapshot)
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        await insert(connection, good)
        await assert.rejects(insert(connection, bad), rejected)
        await connection.rollback()
      } finally { connection.release() }
      assert.deepEqual(await transactions(pool), snapshot)
      assert.deepEqual(await foreignKeys(pool), beforeKeys)
    })
  } finally { await lab.close() }
})
