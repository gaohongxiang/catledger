const assert = require('node:assert/strict')
const path = require('node:path')
const { after, before, beforeEach, test } = require('node:test')

const mysql = require('mysql2/promise')

const { runMigrations } = require('../../../migrations/runner')
const { DEFAULT_CATEGORIES } = require('../src/default-categories')
const { hashWechatSubject } = require('../src/handler')
const { createUserRepository } = require('../src/user-repository')

const requiredEnvironment = [
  'CATLEDGER_TEST_DB_HOST',
  'CATLEDGER_TEST_DB_USER',
  'CATLEDGER_TEST_DB_PASSWORD',
  'CATLEDGER_TEST_DB_NAME'
]
const hasDatabase = requiredEnvironment.every((key) => process.env[key])

let pool
let repository

before(async () => {
  if (!hasDatabase) {
    return
  }

  pool = mysql.createPool({
    host: process.env.CATLEDGER_TEST_DB_HOST,
    port: Number(process.env.CATLEDGER_TEST_DB_PORT || 3306),
    user: process.env.CATLEDGER_TEST_DB_USER,
    password: process.env.CATLEDGER_TEST_DB_PASSWORD,
    database: process.env.CATLEDGER_TEST_DB_NAME,
    charset: 'utf8mb4',
    connectionLimit: 10
  })
  repository = createUserRepository({ getPool: () => pool })
  await runMigrations({
    pool,
    migrationsDirectory: path.resolve(__dirname, '../../../migrations')
  })
})

beforeEach(async () => {
  if (pool) {
    await pool.execute('DELETE FROM catledger_users')
  }
})

after(async () => {
  if (pool) {
    await pool.end()
  }
})

test('migration is repeatable and checksum-protected', { skip: !hasDatabase }, async () => {
  const migrationsDirectory = path.resolve(__dirname, '../../../migrations')
  const applied = await runMigrations({ pool, migrationsDirectory })
  const [rows] = await pool.execute(
    'SELECT version, checksum FROM catledger_schema_migrations ORDER BY version'
  )

  assert.deepEqual(applied, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].version, '0001_identity_and_categories.sql')
  assert.match(rows[0].checksum, /^[a-f0-9]{64}$/)
})

test('same identity bootstraps once and remains idempotent', { skip: !hasDatabase }, async () => {
  const subjectHash = hashWechatSubject('integration-user-one')
  const first = await repository.bootstrap({ provider: 'wechat-mini', subjectHash })
  const second = await repository.bootstrap({ provider: 'wechat-mini', subjectHash })

  assert.equal(first.isNewUser, true)
  assert.equal(second.isNewUser, false)
  assert.equal(first.categories.length, DEFAULT_CATEGORIES.length)
  assert.equal(second.categories.length, DEFAULT_CATEGORIES.length)

  const [[counts]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM catledger_users) AS users,
      (SELECT COUNT(*) FROM catledger_user_identities) AS identities,
      (SELECT COUNT(*) FROM catledger_categories) AS categories
  `)
  assert.deepEqual(
    { users: Number(counts.users), identities: Number(counts.identities), categories: Number(counts.categories) },
    { users: 1, identities: 1, categories: DEFAULT_CATEGORIES.length }
  )
})

test('concurrent bootstrap is resolved by the identity unique constraint', { skip: !hasDatabase }, async () => {
  const subjectHash = hashWechatSubject('integration-concurrent-user')
  const results = await Promise.all(
    Array.from({ length: 8 }, () => repository.bootstrap({ provider: 'wechat-mini', subjectHash }))
  )

  assert.equal(results.filter((result) => result.isNewUser).length, 1)
  const [[counts]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM catledger_users) AS users,
      (SELECT COUNT(*) FROM catledger_user_identities) AS identities,
      (SELECT COUNT(*) FROM catledger_categories) AS categories
  `)
  assert.equal(Number(counts.users), 1)
  assert.equal(Number(counts.identities), 1)
  assert.equal(Number(counts.categories), DEFAULT_CATEGORIES.length)
})

test('different identities stay isolated and raw OpenID is never stored', { skip: !hasDatabase }, async () => {
  const subjects = ['raw-openid-alpha', 'raw-openid-beta']
  await Promise.all(subjects.map((openid) => repository.bootstrap({
    provider: 'wechat-mini',
    subjectHash: hashWechatSubject(openid)
  })))

  const [identities] = await pool.query(
    'SELECT uid, subject_hash AS subjectHash FROM catledger_user_identities ORDER BY subject_hash'
  )
  const [[counts]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM catledger_users) AS users,
      (SELECT COUNT(*) FROM catledger_categories) AS categories
  `)

  assert.equal(identities.length, 2)
  assert.notEqual(identities[0].uid, identities[1].uid)
  assert.equal(Number(counts.users), 2)
  assert.equal(Number(counts.categories), DEFAULT_CATEGORIES.length * 2)
  assert.equal(identities.some((identity) => subjects.includes(identity.subjectHash)), false)
})

test('failed default-category creation rolls back user and identity', { skip: !hasDatabase }, async () => {
  const invalidRepository = createUserRepository({
    getPool: () => pool,
    defaultCategories: [
      ...DEFAULT_CATEGORIES,
      { kind: 'expense', systemKey: 'invalid', name: null, sortOrder: 999 }
    ]
  })

  await assert.rejects(invalidRepository.bootstrap({
    provider: 'wechat-mini',
    subjectHash: hashWechatSubject('integration-rollback-user')
  }))

  const [[counts]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM catledger_users) AS users,
      (SELECT COUNT(*) FROM catledger_user_identities) AS identities,
      (SELECT COUNT(*) FROM catledger_categories) AS categories
  `)
  assert.equal(Number(counts.users), 0)
  assert.equal(Number(counts.identities), 0)
  assert.equal(Number(counts.categories), 0)
})
