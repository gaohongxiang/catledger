// 本机验证专用：只创建并清理本次生成的库/账号，不清空调用者的测试库。
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { runMigrations } = require('../migrations/runner')
const mysql = require('../cloudfunctions/catledger-import/node_modules/mysql2/promise')

const UPDATE_COLUMNS = new Set(['object_version','row_id','state','status','version','economic_nature','flow_direction',
  'ledger_account_id','counterparty_ledger_account_id','category_id','manual_field_mask','field_sources_json',
  'reason_codes_json','superseded_at','transaction_version','current_action_id'])
function validRuntimePrivileges(value) {
  if (typeof value !== 'string') return false
  const tokens = value.match(/SELECT|INSERT|DELETE|UPDATE(?:\([a-z_,]+\))?/g) || []
  return tokens.join(', ') === value && tokens.every(token => !token.startsWith('UPDATE(') ||
    token.slice(7,-1).split(',').every(column => UPDATE_COLUMNS.has(column)))
}

function testConfig(env = process.env) {
  if (!['127.0.0.1', 'localhost'].includes(env.CATLEDGER_TEST_DB_HOST) || !/^[a-zA-Z0-9_]+_test$/.test(env.CATLEDGER_TEST_DB_NAME || '')) {
    throw new Error('仅允许本机、名称以 _test 结尾的一次性测试库')
  }
  return { host: env.CATLEDGER_TEST_DB_HOST, port: Number(env.CATLEDGER_TEST_DB_PORT || 3306),
    user: env.CATLEDGER_TEST_DB_USER, password: env.CATLEDGER_TEST_DB_PASSWORD, database: env.CATLEDGER_TEST_DB_NAME,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 4 }
}

async function isolatedMysql() {
  const config = testConfig(), suffix = randomBytes(6).toString('hex'), database = 'catledger_verify_' + suffix + '_test'
  const admin = mysql.createPool(config), users = [], pools = []
  let created = false, closed = false
  async function close() {
    if (closed) return
    closed = true
    for (const pool of pools) await pool.end()
    for (const user of users) await admin.query('DROP USER IF EXISTS ' + mysql.escape(user) + "@'%'")
    if (created) await admin.query('DROP DATABASE `' + database + '`')
    await admin.end()
  }
  try {
    await admin.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    created = true
    const owner = mysql.createPool({ ...config, database }); pools.push(owner)
    const options = { pool: owner, migrationsDirectory: path.resolve(__dirname, '../migrations') }
    const migrations = await runMigrations(options)
    const reapplied = await runMigrations(options)
    if (reapplied.length) throw new Error('迁移重复执行产生了新变更')
    async function role(name, grants) {
      if (!/^[a-z]+$/.test(name)) throw new Error('Invalid role name')
      const user = 'cl_' + name + '_' + suffix, password = randomBytes(24).toString('hex')
      await admin.query('CREATE USER ' + mysql.escape(user) + "@'%' IDENTIFIED BY " + mysql.escape(password))
      users.push(user)
      for (const [table, privileges] of Object.entries(grants)) {
        if (!/^catledger_[a-z_]+$/.test(table) || !validRuntimePrivileges(privileges)) throw new Error('Invalid runtime grant')
        await admin.query('GRANT ' + privileges + ' ON `' + database + '`.`' + table + '` TO ' + mysql.escape(user) + "@'%'")
      }
      const pool = mysql.createPool({ ...config, database, user, password }); pools.push(pool)
      return pool
    }
    return { owner, database, config: { ...config, database }, role, close, migrations: migrations.length }
  } catch (error) { await close(); throw error }
}

module.exports = { isolatedMysql, testConfig, validRuntimePrivileges }
