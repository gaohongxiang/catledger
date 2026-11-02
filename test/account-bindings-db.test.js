const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID, randomBytes, createHash } = require('node:crypto')
const { runMigrations, splitSqlStatements } = require('../migrations/runner')
const { testConfig } = require('../scripts/isolated-mysql')
const mysql = require('../cloudfunctions/catledger-import/node_modules/mysql2/promise')

const migration = '0038_scoped_account_bindings.sql'
const migrationsDirectory = path.resolve(__dirname, '../migrations')
const mappings = [
  { table: 'catledger_import_account_mappings', id: 'mapping_id', draft: false,
    check: 'chk_catledger_import_account_mapping_action', unique: 'uk_catledger_import_account_mapping',
    columns: ['uid', 'source_type', 'payment_method_key'] },
  { table: 'catledger_finance_update_account_mapping_drafts', id: 'draft_mapping_id', draft: true,
    check: 'chk_catledger_finance_update_draft_mapping_action', unique: 'uk_catledger_update_account_mapping_draft',
    columns: ['uid', 'update_id', 'event_id', 'source_type', 'payment_method_key'] }
]
const digest = value => createHash('sha256').update(value).digest('hex')
const checkRejected = error => error.errno === 3819

// 从真实 0037 前缀升级；不先建最新版表再删除列或约束伪造旧结构。
async function legacyDatabase() {
  const config = testConfig(), database = 'catledger_bindings_' + randomBytes(6).toString('hex') + '_test'
  const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'catledger-bindings-'))
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
    assert.equal((await runMigrations({ pool: owner, migrationsDirectory: prefix })).length, 37)
    return { owner, close }
  } catch (error) { await close(); throw error }
}
async function seed(pool, uid) {
  const c = { uid, accountId: randomUUID(), importId: randomUUID(), batchId: randomUUID(), updateId: randomUUID(), eventId: randomUUID(), actionId: randomUUID() }
  await pool.execute('INSERT INTO catledger_users(uid) VALUES(?)', [uid])
  await pool.execute("INSERT INTO catledger_accounts(uid,account_id,type,nature,name,normalized_name) VALUES(?,?,'bank','asset','合成绑定账户','合成绑定账户')", [uid, c.accountId])
  await pool.execute("INSERT INTO catledger_import_files(uid,import_id,state,original_file_name,declared_size,file_extension,storage_object_key) VALUES(?,?,'parsed','合成绑定.csv',1,'csv',?)", [uid, c.importId, 'synthetic/' + c.importId])
  await pool.execute(`INSERT INTO catledger_import_batches(uid,batch_id,import_id,state,source_type,source_format,parser_name,parser_version,
    normalization_version,identity_version,raw_snapshot_version,parse_fingerprint)
    VALUES(?,?,?,'parsed','alipay','csv','synthetic','synthetic-v1','synthetic-v1','synthetic-v1','synthetic-v1',?)`, [uid, c.batchId, c.importId, digest(c.batchId)])
  await pool.execute("INSERT INTO catledger_finance_updates(uid,update_id,status,plan_version) VALUES(?,?,'review','synthetic-v1')", [uid, c.updateId])
  await pool.execute(`INSERT INTO catledger_economic_events(uid,event_id,batch_id,update_id,event_type,state,event_core_digest,rule_version)
    VALUES(?,?,?,?,'expense','pending',?,'synthetic-v1')`, [uid, c.eventId, c.batchId, c.updateId, digest(c.eventId)])
  await pool.execute(`INSERT INTO catledger_finance_actions(uid,action_id,update_id,expected_update_version,action_type,idempotency_key_digest,request_digest,status,reason_codes_json)
    VALUES(?,?,?,1,'account_mapping',?,?,'applied','[]')`, [uid, c.actionId, c.updateId, digest(c.actionId), digest('request/' + c.actionId)])
  return c
}
function row(c, definition, fields = {}) {
  return { uid: c.uid, [definition.id]: randomUUID(), source_type: 'alipay', payment_method_key: digest(randomUUID()),
    payment_method_hint: '合成付款方式', mapping_action: 'account', account_id: c.accountId,
    ...(definition.draft ? { update_id: c.updateId, event_id: c.eventId, action_id: c.actionId } : {}), ...fields }
}
function insert(pool, definition, value) {
  return pool.execute('INSERT INTO ' + definition.table + ' (' + Object.keys(value).join(',') + ') VALUES (' + Object.keys(value).map(() => '?').join(',') + ')', Object.values(value))
}
function update(pool, definition, value, fields) {
  return pool.execute('UPDATE ' + definition.table + ' SET ' + Object.keys(fields).map(key => key + '=?').join(',') + ' WHERE uid=? AND ' + definition.id + '=?',
    [...Object.values(fields), value.uid, value[definition.id]])
}
async function snapshot(pool) {
  const result = {}
  for (const definition of mappings) {
    const [rows] = await pool.query('SELECT * FROM ' + definition.table + ' ORDER BY uid,' + definition.id)
    result[definition.table] = rows
  }
  return result
}
async function history(pool) {
  const [rows] = await pool.execute('SELECT version,checksum,applied_at FROM catledger_schema_migrations ORDER BY version')
  return rows
}
async function foreignKeys(pool) {
  const [rows] = await pool.execute(`SELECT r.table_name AS tableName,r.constraint_name AS constraintName,r.referenced_table_name AS referencedTable,
    r.update_rule AS updateRule,r.delete_rule AS deleteRule,k.column_name AS columnName,k.referenced_column_name AS referencedColumn,
    k.ordinal_position AS ordinalPosition FROM information_schema.referential_constraints r
    JOIN information_schema.key_column_usage k ON k.constraint_schema=r.constraint_schema AND k.constraint_name=r.constraint_name
    WHERE r.constraint_schema=DATABASE() AND r.table_name IN (?,?) ORDER BY r.table_name,r.constraint_name,k.ordinal_position`, mappings.map(item => item.table))
  return rows
}
async function bindingColumns(pool) {
  const [rows] = await pool.execute(`SELECT table_name AS tableName,data_type AS dataType,is_nullable AS isNullable,column_default AS defaultValue
    FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN (?,?) AND column_name='binding_json' ORDER BY table_name`, mappings.map(item => item.table))
  return rows
}
async function rawReplay(pool) {
  const connection = await pool.getConnection()
  try { for (const statement of splitSqlStatements(await fs.readFile(path.join(migrationsDirectory, migration), 'utf8'))) await connection.query(statement) }
  finally { connection.release() }
}

test('0038 账户绑定迁移保留旧映射，约束、用户隔离及事务回滚有效', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
  const lab = await legacyDatabase(), pool = lab.owner
  try {
    const c = await seed(pool, 'SynB380001'), other = await seed(pool, 'SynB380002')
    for (const definition of mappings) {
      await insert(pool, definition, row(c, definition))
      await insert(pool, definition, row(c, definition, { mapping_action: 'ignore', account_id: null }))
      await assert.rejects(insert(pool, definition, row(c, definition, { mapping_action: 'external', account_id: null })), checkRejected)
    }
    const before = await snapshot(pool), beforeHistory = await history(pool), beforeKeys = await foreignKeys(pool)
    assert.equal(beforeHistory.length, 37)
    assert.deepEqual(await bindingColumns(pool), [])
    await t.test('中断后恢复及直接重复执行保持旧行和原 37 个迁移校验和', async () => {
      let executed = 0
      const interruptedPool = { async getConnection() {
        const connection = await pool.getConnection()
        return { execute: (...args) => connection.execute(...args), release: () => connection.release(), destroy: () => connection.destroy(),
          async query(sql) {
            const result = await connection.query(sql)
            if (/^EXECUTE catledger_(binding|external)_statement/.test(sql) && ++executed === 2) throw new Error('synthetic migration interruption')
            return result
          } }
      } }
      await assert.rejects(runMigrations({ pool: interruptedPool, migrationsDirectory }), /synthetic migration interruption/)
      assert.deepEqual(await history(pool), beforeHistory)
      assert.equal((await bindingColumns(pool)).length, 1)
      assert.deepEqual(await runMigrations({ pool, migrationsDirectory }), [migration])
      assert.deepEqual(await runMigrations({ pool, migrationsDirectory }), [])
      await rawReplay(pool)
      await rawReplay(pool)
      assert.deepEqual((await history(pool)).slice(0, 37), beforeHistory)
      assert.equal((await history(pool)).length, 38)
      assert.deepEqual(await bindingColumns(pool), mappings.map(item => ({ tableName: item.table, dataType: 'json', isNullable: 'YES', defaultValue: null })).sort((a, b) => a.tableName.localeCompare(b.tableName)))
      const after = await snapshot(pool)
      for (const definition of mappings) {
        assert.ok(after[definition.table].every(value => value.binding_json === null))
        assert.deepEqual(after[definition.table].map(({ binding_json, ...value }) => value), before[definition.table])
        const [[constraint]] = await pool.execute(`SELECT enforced AS enforced FROM information_schema.table_constraints
          WHERE constraint_schema=DATABASE() AND table_name=? AND constraint_name=? AND constraint_type='CHECK'`, [definition.table, definition.check])
        assert.equal(constraint.enforced, 'YES')
      }
      assert.deepEqual(await foreignKeys(pool), beforeKeys)
    })
    await t.test('两表只接受 account+ID、ignore/external+NULL，失败 INSERT/UPDATE 不改旧行', async () => {
      for (const definition of mappings) {
        const target = row(c, definition, { binding_json: JSON.stringify({ version: 1, confirmed: true, scope: 'synthetic' }) })
        await insert(pool, definition, target)
        for (const action of ['ignore', 'external']) await insert(pool, definition, row(c, definition, { mapping_action: action, account_id: null, binding_json: target.binding_json }))
        for (const fields of [{ mapping_action: 'account', account_id: null }, { mapping_action: 'external', account_id: c.accountId },
          { mapping_action: 'ignore', account_id: c.accountId }, { mapping_action: 'unknown', account_id: null }, { mapping_action: 'EXTERNAL', account_id: null }]) {
          const saved = await snapshot(pool)
          await assert.rejects(insert(pool, definition, row(c, definition, fields)), checkRejected)
          await assert.rejects(update(pool, definition, target, fields), checkRejected)
          assert.deepEqual(await snapshot(pool), saved)
        }
        await update(pool, definition, target, { mapping_action: 'external', account_id: null })
        await update(pool, definition, target, { mapping_action: 'account', account_id: c.accountId })
      }
      const saved = await snapshot(pool)
      await rawReplay(pool)
      assert.deepEqual(await snapshot(pool), saved, '重放迁移不得清空已确认的 binding_json')
    })
    await t.test('同一用户和作用域禁止重复键；不同用户允许独立保存同一付款键', async () => {
      for (const definition of mappings) {
        const value = row(c, definition)
        await insert(pool, definition, value)
        await assert.rejects(insert(pool, definition, { ...value, [definition.id]: randomUUID() }), { errno: 1062 })
        await insert(pool, definition, row(other, definition, { [definition.id]: value[definition.id], payment_method_key: value.payment_method_key }))
        await insert(pool, definition, { ...value, [definition.id]: randomUUID(), source_type: 'wechat' })
        const [columns] = await pool.execute(`SELECT column_name AS name FROM information_schema.statistics
          WHERE table_schema=DATABASE() AND table_name=? AND index_name=? AND non_unique=0 ORDER BY seq_in_index`, [definition.table, definition.unique])
        assert.deepEqual(columns.map(item => item.name), definition.columns)
      }
    })
    await t.test('正式映射账户及草稿图关系外键保留同用户隔离与 RESTRICT', async () => {
      const permanent = mappings[0], draft = mappings[1], value = row(c, permanent)
      await insert(pool, permanent, value)
      for (const accountId of [other.accountId, randomUUID()]) {
        await assert.rejects(insert(pool, permanent, row(c, permanent, { account_id: accountId })), { errno: 1452 })
        await assert.rejects(update(pool, permanent, value, { account_id: accountId }), { errno: 1452 })
      }
      await assert.rejects(pool.execute('DELETE FROM catledger_accounts WHERE uid=? AND account_id=?', [c.uid, c.accountId]), { errno: 1451 })
      const draftValue = row(c, draft)
      await insert(pool, draft, draftValue)
      for (const fields of [{ update_id: other.updateId }, { event_id: other.eventId }, { action_id: other.actionId }]) {
        await assert.rejects(insert(pool, draft, row(c, draft, fields)), { errno: 1452 })
        await assert.rejects(update(pool, draft, draftValue, fields), { errno: 1452 })
      }
      // 草稿账户可尚未入正式 accounts；此边界由服务端保存时验证，不能增加正式账户外键。
      assert.equal(beforeKeys.some(key => key.tableName === draft.table && key.referencedTable === 'catledger_accounts'), false)
      await assert.rejects(pool.execute('DELETE FROM catledger_finance_actions WHERE uid=? AND action_id=?', [c.uid, c.actionId]), { errno: 1451 })
      assert.deepEqual(await foreignKeys(pool), beforeKeys)
    })
    await t.test('单条多行写入失败以及跨两表事务回滚均不留下半份绑定', async () => {
      const saved = await snapshot(pool)
      for (const definition of mappings) {
        const good = row(c, definition), bad = row(c, definition, { mapping_action: 'external', account_id: c.accountId })
        await assert.rejects(pool.query('INSERT INTO ' + definition.table + ' (' + Object.keys(good).join(',') + ') VALUES ?', [[Object.values(good), Object.values(bad)]]), checkRejected)
        assert.deepEqual(await snapshot(pool), saved)
      }
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        for (const definition of mappings) await insert(connection, definition, row(c, definition, { mapping_action: 'external', account_id: null, binding_json: JSON.stringify({ scope: 'rollback' }) }))
        await assert.rejects(insert(connection, mappings[0], row(c, mappings[0], { account_id: other.accountId })), { errno: 1452 })
        await connection.rollback()
      } finally { connection.release() }
      assert.deepEqual(await snapshot(pool), saved)
      assert.deepEqual((await history(pool)).slice(0, 37), beforeHistory)
    })
  } finally { await lab.close() }
})
