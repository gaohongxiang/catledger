const assert = require('node:assert/strict')
const path = require('node:path')
const { after, before, beforeEach, test } = require('node:test')

const mysql = require('mysql2/promise')

const { runMigrations } = require('../../../migrations/runner')
const { createAccountService } = require('../src/account-service')
const { createCategoryService } = require('../src/category-service')
const { DEFAULT_CATEGORIES } = require('../src/default-categories')
const { hashWechatSubject } = require('../src/handler')
const { createTransactionService } = require('../src/transaction-service')
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
let accountService
let categoryService
let transactionService

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
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectionLimit: 10
  })
  repository = createUserRepository({ getPool: () => pool })
  accountService = createAccountService({ getPool: () => pool })
  categoryService = createCategoryService({ getPool: () => pool })
  transactionService = createTransactionService({ getPool: () => pool })
  await runMigrations({
    pool,
    migrationsDirectory: path.resolve(__dirname, '../../../migrations')
  })
})

beforeEach(async () => {
  if (pool) {
    await pool.execute('DELETE FROM catledger_mutation_receipts')
    await pool.execute("DELETE FROM catledger_transactions WHERE type = 'refund'")
    await pool.execute('DELETE FROM catledger_transactions')
    await pool.execute('DELETE FROM catledger_accounts')
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
  assert.equal(rows.length, 3)
  assert.equal(rows[0].version, '0001_identity_and_categories.sql')
  assert.equal(rows[1].version, '0002_accounts_and_transactions.sql')
  assert.equal(rows[2].version, '0003_category_management_and_refunds.sql')
  assert.match(rows[0].checksum, /^[a-f0-9]{64}$/)
  assert.match(rows[1].checksum, /^[a-f0-9]{64}$/)
  assert.match(rows[2].checksum, /^[a-f0-9]{64}$/)
})

test('ledger schema keeps account, transaction and idempotency keys inside uid scope', { skip: !hasDatabase }, async () => {
  const [tables] = await pool.execute(
    `SELECT table_name AS tableName
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN ('catledger_accounts', 'catledger_transactions', 'catledger_mutation_receipts')
      ORDER BY table_name`
  )
  assert.deepEqual(tables.map((row) => row.tableName), [
    'catledger_accounts',
    'catledger_mutation_receipts',
    'catledger_transactions'
  ])

  const [indexes] = await pool.execute(
    `SELECT table_name AS tableName, index_name AS indexName, column_name AS columnName, seq_in_index AS position
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND index_name IN ('uk_catledger_category_scope', 'uk_catledger_account_active_name', 'PRIMARY')
        AND table_name IN ('catledger_categories', 'catledger_accounts', 'catledger_transactions', 'catledger_mutation_receipts')
      ORDER BY table_name, index_name, seq_in_index`
  )
  const scopedIndexes = new Map()
  for (const row of indexes) {
    const key = `${row.tableName}:${row.indexName}`
    scopedIndexes.set(key, [...(scopedIndexes.get(key) || []), row.columnName])
  }
  assert.deepEqual(scopedIndexes.get('catledger_categories:uk_catledger_category_scope'), ['uid', 'category_id'])
  assert.deepEqual(scopedIndexes.get('catledger_accounts:PRIMARY'), ['uid', 'account_id'])
  assert.deepEqual(scopedIndexes.get('catledger_accounts:uk_catledger_account_active_name'), ['uid', 'active_name_key'])
  assert.deepEqual(scopedIndexes.get('catledger_transactions:PRIMARY'), ['uid', 'transaction_id'])
  assert.deepEqual(scopedIndexes.get('catledger_mutation_receipts:PRIMARY'), ['uid', 'idempotency_key_digest'])
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

test('account creation is atomic, idempotent and uses signed liability balances', { skip: !hasDatabase }, async () => {
  const subjectHash = hashWechatSubject('integration-account-user')
  await repository.bootstrap({ provider: 'wechat-mini', subjectHash })
  const request = {
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: '0fca5d4b-bbf7-495c-8141-a26fbdb705a2',
      type: 'bank',
      name: '日常银行卡',
      currency: 'CNY',
      openingDisplayBalanceMinor: '12345',
      occurredLocalAt: '2026-08-29T12:00:00',
      timezoneOffsetMinutes: -480
    }
  }

  const first = await accountService.create(request)
  const replay = await accountService.create(request)
  assert.deepEqual(replay, first)
  assert.equal(first.bookBalanceMinor, '12345')

  const credit = await accountService.create({
    ...request,
    data: {
      ...request.data,
      requestId: 'f87b2f5e-800b-4b57-a687-ece46f552599',
      type: 'credit',
      name: '信用卡',
      openingDisplayBalanceMinor: '5000'
    }
  })
  assert.equal(credit.bookBalanceMinor, '-5000')
  assert.equal(credit.displayBalanceMinor, '5000')
  assert.equal(credit.balanceDirection, 'liability')

  const result = await accountService.list({ provider: 'wechat-mini', subjectHash })
  assert.equal(result.accounts.length, 2)
  const [[counts]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM catledger_accounts) AS accounts,
       (SELECT COUNT(*) FROM catledger_transactions WHERE type = 'balance_adjustment') AS adjustments,
       (SELECT COUNT(*) FROM catledger_mutation_receipts) AS receipts`
  )
  assert.deepEqual(
    {
      accounts: Number(counts.accounts),
      adjustments: Number(counts.adjustments),
      receipts: Number(counts.receipts)
    },
    { accounts: 2, adjustments: 2, receipts: 2 }
  )
})

test('account names and idempotency conflicts are isolated per user', { skip: !hasDatabase }, async () => {
  const firstSubject = hashWechatSubject('integration-account-isolation-one')
  const secondSubject = hashWechatSubject('integration-account-isolation-two')
  await repository.bootstrap({ provider: 'wechat-mini', subjectHash: firstSubject })
  await repository.bootstrap({ provider: 'wechat-mini', subjectHash: secondSubject })
  const data = {
    requestId: '031a7347-a10b-49dc-81cc-ad7c82220c5a',
    type: 'cash',
    name: '现金',
    openingDisplayBalanceMinor: '0'
  }

  await accountService.create({ provider: 'wechat-mini', subjectHash: firstSubject, data })
  await assert.rejects(
    accountService.create({
      provider: 'wechat-mini',
      subjectHash: firstSubject,
      data: { ...data, name: '备用现金' }
    }),
    { publicCode: 'IDEMPOTENCY_CONFLICT' }
  )
  await assert.rejects(
    accountService.create({
      provider: 'wechat-mini',
      subjectHash: firstSubject,
      data: { ...data, requestId: '2e41cc9c-c244-47cb-8d8c-664f2fdc4f84' }
    }),
    { publicCode: 'CONFLICT' }
  )
  const second = await accountService.create({
    provider: 'wechat-mini',
    subjectHash: secondSubject,
    data
  })
  assert.equal(second.name, '现金')
})

test('invalid opening balance time rolls back account and idempotency receipt', { skip: !hasDatabase }, async () => {
  const subjectHash = hashWechatSubject('integration-account-rollback')
  await repository.bootstrap({ provider: 'wechat-mini', subjectHash })
  const requestId = '7ea66a94-ce16-41c4-bf28-b82eaaf048cb'

  await assert.rejects(accountService.create({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId,
      type: 'bank',
      name: '工资卡',
      openingDisplayBalanceMinor: '1',
      occurredLocalAt: '2026-02-30T12:00:00',
      timezoneOffsetMinutes: -480
    }
  }), { publicCode: 'VALIDATION_ERROR' })

  const [[counts]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*) FROM catledger_accounts) AS accounts,
       (SELECT COUNT(*) FROM catledger_transactions) AS transactions,
       (SELECT COUNT(*) FROM catledger_mutation_receipts) AS receipts`
  )
  assert.deepEqual(
    {
      accounts: Number(counts.accounts),
      transactions: Number(counts.transactions),
      receipts: Number(counts.receipts)
    },
    { accounts: 0, transactions: 0, receipts: 0 }
  )
})

test('account rename, balance correction and archive preserve formal history', { skip: !hasDatabase }, async () => {
  const subjectHash = hashWechatSubject('integration-account-lifecycle')
  await repository.bootstrap({ provider: 'wechat-mini', subjectHash })
  const created = await accountService.create({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: '8f205d08-df7e-4aaa-9902-3526e0d7ff96',
      type: 'bank',
      name: '银行卡',
      openingDisplayBalanceMinor: '1000',
      occurredLocalAt: '2026-08-29T08:00:00',
      timezoneOffsetMinutes: -480
    }
  })
  const renamed = await accountService.update({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: '2a3ce6d3-214e-4d02-8afd-e015012404db',
      accountId: created.accountId,
      version: created.version,
      name: '生活银行卡'
    }
  })
  assert.equal(renamed.version, 2)
  assert.equal(renamed.name, '生活银行卡')

  const corrected = await accountService.correctBalance({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: 'f95f4c26-2c1a-4f30-8daa-11e74d31a474',
      accountId: created.accountId,
      displayBalanceMinor: '2500',
      occurredLocalAt: '2026-08-29T09:00:00',
      timezoneOffsetMinutes: -480
    }
  })
  assert.equal(corrected.bookBalanceMinor, '2500')

  const archived = await accountService.archive({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: '415d461f-c674-4536-87e5-28103ba1b15c',
      accountId: created.accountId,
      version: renamed.version
    }
  })
  assert.equal(archived.archived, true)
  const listed = await accountService.list({ provider: 'wechat-mini', subjectHash })
  assert.equal(listed.accounts[0].bookBalanceMinor, '2500')
  assert.equal(listed.accounts[0].archived, true)

  const [[adjustments]] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM catledger_transactions
      WHERE type = 'balance_adjustment' AND deleted_at IS NULL`
  )
  assert.equal(Number(adjustments.count), 2)
})

async function bootstrapLedgerUser(openid) {
  const subjectHash = hashWechatSubject(openid)
  const bootstrap = await repository.bootstrap({ provider: 'wechat-mini', subjectHash })
  return {
    subjectHash,
    expenseCategory: bootstrap.categories.find((category) => category.kind === 'expense'),
    incomeCategory: bootstrap.categories.find((category) => category.kind === 'income')
  }
}

async function createTestAccount(subjectHash, overrides = {}) {
  return accountService.create({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      type: 'bank',
      name: `测试账户-${Math.random().toString(16).slice(2, 10)}`,
      openingDisplayBalanceMinor: '0',
      ...overrides
    }
  })
}

let uuidCounter = 1
function randomTestUuid() {
  const suffix = String(uuidCounter).padStart(12, '0')
  uuidCounter += 1
  return `10000000-0000-4000-8000-${suffix}`
}

test('expense, income and one-row transfer update balances without double-counting cashflow', { skip: !hasDatabase }, async () => {
  const { subjectHash, expenseCategory, incomeCategory } = await bootstrapLedgerUser('integration-transactions')
  const bank = await createTestAccount(subjectHash, {
    name: '主银行卡',
    openingDisplayBalanceMinor: '10000',
    occurredLocalAt: '2026-08-01T08:00:00',
    timezoneOffsetMinutes: -480
  })
  const wallet = await createTestAccount(subjectHash, {
    type: 'wallet',
    name: '微信余额',
    openingDisplayBalanceMinor: '1000',
    occurredLocalAt: '2026-08-01T08:00:00',
    timezoneOffsetMinutes: -480
  })

  const expenseRequest = {
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      type: 'expense',
      sourceAccountId: bank.accountId,
      categoryId: expenseCategory.id,
      amountMinor: '2500',
      occurredLocalAt: '2026-08-10T12:00:00',
      timezoneOffsetMinutes: -480,
      note: '午餐'
    }
  }
  const expense = await transactionService.create(expenseRequest)
  assert.deepEqual(await transactionService.create(expenseRequest), expense)

  await transactionService.create({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      type: 'income',
      destinationAccountId: bank.accountId,
      categoryId: incomeCategory.id,
      amountMinor: '5000',
      occurredLocalAt: '2026-08-11T09:00:00',
      timezoneOffsetMinutes: -480
    }
  })
  await transactionService.create({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      type: 'transfer',
      sourceAccountId: bank.accountId,
      destinationAccountId: wallet.accountId,
      amountMinor: '2000',
      occurredLocalAt: '2026-08-12T10:00:00',
      timezoneOffsetMinutes: -480
    }
  })

  const accounts = await accountService.list({ provider: 'wechat-mini', subjectHash })
  const balances = Object.fromEntries(accounts.accounts.map((account) => [account.name, account.bookBalanceMinor]))
  assert.deepEqual(balances, { 主银行卡: '10500', 微信余额: '3000' })

  const page = await transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08' }
  })
  assert.deepEqual(page.summary, {
    incomeMinor: '5000',
    expenseMinor: '2500',
    netIncomeMinor: '2500'
  })
  assert.equal(page.transactions.filter((transaction) => transaction.type === 'transfer').length, 1)
  assert.equal(page.transactions.length, 5)

  const [[transferCount]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM catledger_transactions WHERE type = 'transfer'`
  )
  assert.equal(Number(transferCount.count), 1)
})

test('manual transaction update and soft delete recalculate balances and statistics', { skip: !hasDatabase }, async () => {
  const { subjectHash, expenseCategory } = await bootstrapLedgerUser('integration-transaction-edit')
  const first = await createTestAccount(subjectHash, { name: '账户甲' })
  const second = await createTestAccount(subjectHash, { type: 'wallet', name: '账户乙' })
  const created = await transactionService.create({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      type: 'expense',
      sourceAccountId: first.accountId,
      categoryId: expenseCategory.id,
      amountMinor: '100',
      occurredLocalAt: '2026-08-15T10:00:00',
      timezoneOffsetMinutes: -480
    }
  })
  const updated = await transactionService.update({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      transactionId: created.transactionId,
      version: created.version,
      type: 'transfer',
      sourceAccountId: first.accountId,
      destinationAccountId: second.accountId,
      amountMinor: '350',
      occurredLocalAt: '2026-08-16T10:00:00',
      timezoneOffsetMinutes: -480
    }
  })
  assert.equal(updated.type, 'transfer')
  assert.equal(updated.version, 2)

  await assert.rejects(transactionService.update({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      transactionId: created.transactionId,
      version: 1,
      type: 'transfer',
      sourceAccountId: first.accountId,
      destinationAccountId: second.accountId,
      amountMinor: '400',
      occurredLocalAt: '2026-08-16T10:00:00',
      timezoneOffsetMinutes: -480
    }
  }), { publicCode: 'CONFLICT' })

  const removed = await transactionService.remove({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      transactionId: created.transactionId,
      version: updated.version
    }
  })
  assert.equal(removed.deleted, true)

  const page = await transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08' }
  })
  assert.deepEqual(page.summary, {
    incomeMinor: '0',
    expenseMinor: '0',
    netIncomeMinor: '0'
  })
  assert.equal(page.transactions.length, 0)
  const accounts = await accountService.list({ provider: 'wechat-mini', subjectHash })
  assert.equal(accounts.accounts.every((account) => account.bookBalanceMinor === '0'), true)
})

test('category management is isolated, versioned, reorderable and history-safe', { skip: !hasDatabase }, async () => {
  const first = await bootstrapLedgerUser('integration-category-one')
  const second = await bootstrapLedgerUser('integration-category-two')
  const created = await categoryService.create({
    provider: 'wechat-mini', subjectHash: first.subjectHash,
    data: { requestId: randomTestUuid(), kind: 'expense', name: '宠物' }
  })
  assert.equal(created.name, '宠物')
  await assert.rejects(categoryService.create({
    provider: 'wechat-mini', subjectHash: first.subjectHash,
    data: { requestId: randomTestUuid(), kind: 'expense', name: '  宠物 ' }
  }), { publicCode: 'CONFLICT' })
  const renamed = await categoryService.update({
    provider: 'wechat-mini', subjectHash: first.subjectHash,
    data: { requestId: randomTestUuid(), categoryId: created.id, version: created.version, name: '毛孩子' }
  })
  const listed = await categoryService.list({ provider: 'wechat-mini', subjectHash: first.subjectHash, data: {} })
  const activeExpense = listed.categories.filter((item) => item.kind === 'expense' && !item.archived)
  const reordered = await categoryService.reorder({
    provider: 'wechat-mini', subjectHash: first.subjectHash,
    data: {
      requestId: randomTestUuid(), kind: 'expense',
      items: [activeExpense.find((item) => item.id === renamed.id)]
        .concat(activeExpense.filter((item) => item.id !== renamed.id))
        .map((item) => ({ categoryId: item.id, version: item.version }))
    }
  })
  assert.equal(reordered.categories[0].id, renamed.id)
  const archived = await categoryService.archive({
    provider: 'wechat-mini', subjectHash: first.subjectHash,
    data: { requestId: randomTestUuid(), categoryId: renamed.id, version: reordered.categories[0].version }
  })
  assert.equal(archived.archived, true)
  const restored = await categoryService.restore({
    provider: 'wechat-mini', subjectHash: first.subjectHash,
    data: { requestId: randomTestUuid(), categoryId: renamed.id, version: archived.version }
  })
  assert.equal(restored.archived, false)
  await assert.rejects(categoryService.update({
    provider: 'wechat-mini', subjectHash: second.subjectHash,
    data: { requestId: randomTestUuid(), categoryId: renamed.id, version: restored.version, name: '越权' }
  }), { publicCode: 'NOT_FOUND' })
})

test('refunds credit accounts and reduce expense statistics without becoming income', { skip: !hasDatabase }, async () => {
  const { subjectHash, expenseCategory } = await bootstrapLedgerUser('integration-refund')
  const account = await createTestAccount(subjectHash, {
    name: '退款测试账户', openingDisplayBalanceMinor: '2000',
    occurredLocalAt: '2026-08-01T08:00:00', timezoneOffsetMinutes: -480
  })
  const expense = await transactionService.create({
    provider: 'wechat-mini', subjectHash,
    data: {
      requestId: randomTestUuid(), type: 'expense', sourceAccountId: account.accountId,
      categoryId: expenseCategory.id, amountMinor: '1000',
      occurredLocalAt: '2026-08-10T10:00:00', timezoneOffsetMinutes: -480, note: '原消费'
    }
  })
  const refund = await transactionService.create({
    provider: 'wechat-mini', subjectHash,
    data: {
      requestId: randomTestUuid(), type: 'refund', destinationAccountId: account.accountId,
      originalTransactionId: expense.transactionId, amountMinor: '300',
      occurredLocalAt: '2026-08-20T10:00:00', timezoneOffsetMinutes: -480, note: '部分退款'
    }
  })
  assert.equal(refund.originalTransaction.transactionId, expense.transactionId)
  const firstPage = await transactionService.list({ provider: 'wechat-mini', subjectHash, data: { month: '2026-08' } })
  assert.deepEqual(firstPage.summary, { incomeMinor: '0', expenseMinor: '700', netIncomeMinor: '-700' })
  const firstStats = await transactionService.statistics({ provider: 'wechat-mini', subjectHash, data: { month: '2026-08' } })
  assert.equal(firstStats.expenseCategories[0].amountMinor, '700')
  assert.equal((await accountService.list({ provider: 'wechat-mini', subjectHash })).accounts[0].bookBalanceMinor, '1300')
  await assert.rejects(transactionService.create({
    provider: 'wechat-mini', subjectHash,
    data: {
      requestId: randomTestUuid(), type: 'refund', destinationAccountId: account.accountId,
      originalTransactionId: expense.transactionId, amountMinor: '701',
      occurredLocalAt: '2026-08-21T10:00:00', timezoneOffsetMinutes: -480
    }
  }), { publicCode: 'REFUND_EXCEEDS_ORIGINAL' })
  const updatedRefund = await transactionService.update({
    provider: 'wechat-mini', subjectHash,
    data: {
      requestId: randomTestUuid(), transactionId: refund.transactionId, version: refund.version,
      type: 'refund', destinationAccountId: account.accountId,
      originalTransactionId: expense.transactionId, amountMinor: '200',
      occurredLocalAt: '2026-08-20T10:00:00', timezoneOffsetMinutes: -480
    }
  })
  await assert.rejects(transactionService.update({
    provider: 'wechat-mini', subjectHash,
    data: {
      requestId: randomTestUuid(), transactionId: expense.transactionId, version: expense.version,
      type: 'expense', sourceAccountId: account.accountId, categoryId: expenseCategory.id,
      amountMinor: '100', occurredLocalAt: '2026-08-10T10:00:00', timezoneOffsetMinutes: -480
    }
  }), { publicCode: 'REFUNDED_TRANSACTION_LOCKED' })
  await assert.rejects(transactionService.remove({
    provider: 'wechat-mini', subjectHash,
    data: { requestId: randomTestUuid(), transactionId: expense.transactionId, version: expense.version }
  }), { publicCode: 'REFUNDED_TRANSACTION_LOCKED' })
  await transactionService.remove({
    provider: 'wechat-mini', subjectHash,
    data: { requestId: randomTestUuid(), transactionId: refund.transactionId, version: updatedRefund.version }
  })
  const finalPage = await transactionService.list({ provider: 'wechat-mini', subjectHash, data: { month: '2026-08' } })
  assert.equal(finalPage.summary.expenseMinor, '1000')
})

test('transaction validation rejects foreign, inactive and semantically invalid relations atomically', { skip: !hasDatabase }, async () => {
  const firstUser = await bootstrapLedgerUser('integration-transaction-validation-one')
  const secondUser = await bootstrapLedgerUser('integration-transaction-validation-two')
  const firstAccount = await createTestAccount(firstUser.subjectHash, { name: '本人账户' })
  const foreignAccount = await createTestAccount(secondUser.subjectHash, { name: '他人账户' })

  const base = {
    requestId: randomTestUuid(),
    type: 'expense',
    sourceAccountId: firstAccount.accountId,
    categoryId: firstUser.expenseCategory.id,
    amountMinor: '100',
    occurredLocalAt: '2026-08-20T10:00:00',
    timezoneOffsetMinutes: -480
  }
  await assert.rejects(transactionService.create({
    provider: 'wechat-mini',
    subjectHash: firstUser.subjectHash,
    data: { ...base, requestId: randomTestUuid(), sourceAccountId: foreignAccount.accountId }
  }), { publicCode: 'NOT_FOUND' })
  await assert.rejects(transactionService.create({
    provider: 'wechat-mini',
    subjectHash: firstUser.subjectHash,
    data: { ...base, requestId: randomTestUuid(), categoryId: firstUser.incomeCategory.id }
  }), { publicCode: 'VALIDATION_ERROR' })
  await assert.rejects(transactionService.create({
    provider: 'wechat-mini',
    subjectHash: firstUser.subjectHash,
    data: {
      ...base,
      requestId: randomTestUuid(),
      type: 'transfer',
      categoryId: null,
      sourceAccountId: firstAccount.accountId,
      destinationAccountId: firstAccount.accountId
    }
  }), { publicCode: 'VALIDATION_ERROR' })

  const archived = await accountService.archive({
    provider: 'wechat-mini',
    subjectHash: firstUser.subjectHash,
    data: { requestId: randomTestUuid(), accountId: firstAccount.accountId, version: firstAccount.version }
  })
  assert.equal(archived.archived, true)
  await assert.rejects(transactionService.create({
    provider: 'wechat-mini',
    subjectHash: firstUser.subjectHash,
    data: { ...base, requestId: randomTestUuid() }
  }), { publicCode: 'ACCOUNT_INACTIVE' })

  const [[transactions]] = await pool.execute(
    `SELECT COUNT(*) AS count FROM catledger_transactions WHERE origin = 'manual'`
  )
  assert.equal(Number(transactions.count), 0)
})

test('month list uses stable filtered cursors and rejects cursor tampering', { skip: !hasDatabase }, async () => {
  const { subjectHash, expenseCategory } = await bootstrapLedgerUser('integration-transaction-pagination')
  const account = await createTestAccount(subjectHash, { name: '分页账户' })
  for (let index = 0; index < 5; index += 1) {
    await transactionService.create({
      provider: 'wechat-mini',
      subjectHash,
      data: {
        requestId: randomTestUuid(),
        type: 'expense',
        sourceAccountId: account.accountId,
        categoryId: expenseCategory.id,
        amountMinor: String(index + 1),
        occurredLocalAt: `2026-08-2${index}T10:00:00`,
        timezoneOffsetMinutes: -480,
        note: index === 3 ? '咖啡_100%' : '日常'
      }
    })
  }

  const first = await transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08', pageSize: 2 }
  })
  const second = await transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08', pageSize: 2, cursor: first.nextCursor }
  })
  const ids = [...first.transactions, ...second.transactions].map((transaction) => transaction.transactionId)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(first.nextCursor != null, true)

  await assert.rejects(transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-07', pageSize: 2, cursor: first.nextCursor }
  }), { publicCode: 'VALIDATION_ERROR' })
  await assert.rejects(transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08', pageSize: 2, cursor: `${first.nextCursor}x` }
  }), { publicCode: 'VALIDATION_ERROR' })

  const searched = await transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08', search: '_100%' }
  })
  assert.equal(searched.transactions.length, 1)

  const selectedDate = await transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08', date: '2026-08-23' }
  })
  assert.equal(selectedDate.date, '2026-08-23')
  assert.equal(selectedDate.transactions.length, 1)
  assert.equal(selectedDate.summary.expenseMinor, '4')
  await assert.rejects(transactionService.list({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08', date: '2026-07-23' }
  }), { publicCode: 'VALIDATION_ERROR' })
})

test('dashboard returns net worth, month summary, cash-flow trend and recent formal transactions', { skip: !hasDatabase }, async () => {
  const { subjectHash, expenseCategory, incomeCategory } = await bootstrapLedgerUser('integration-dashboard')
  const account = await createTestAccount(subjectHash, {
    name: '首页账户',
    openingDisplayBalanceMinor: '900',
    occurredLocalAt: '2026-08-01T08:00:00',
    timezoneOffsetMinutes: -480
  })
  await transactionService.create({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      type: 'income',
      destinationAccountId: account.accountId,
      categoryId: incomeCategory.id,
      amountMinor: '100',
      occurredLocalAt: '2026-08-29T08:00:00',
      timezoneOffsetMinutes: -480
    }
  })
  await transactionService.create({
    provider: 'wechat-mini',
    subjectHash,
    data: {
      requestId: randomTestUuid(),
      type: 'expense',
      sourceAccountId: account.accountId,
      categoryId: expenseCategory.id,
      amountMinor: '40',
      occurredLocalAt: '2026-08-29T09:00:00',
      timezoneOffsetMinutes: -480
    }
  })

  const dashboard = await transactionService.dashboard({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08' }
  })
  assert.equal(dashboard.netWorthMinor, '960')
  assert.equal(dashboard.summary.incomeMinor, '100')
  assert.equal(dashboard.summary.expenseMinor, '40')
  assert.equal(dashboard.cashFlowTrend.length, 6)
  assert.equal(dashboard.cashFlowTrend[0].month, '2026-03')
  assert.equal(dashboard.cashFlowTrend[5].month, '2026-08')
  assert.equal(dashboard.cashFlowTrend[5].incomeMinor, '100')
  assert.equal(dashboard.cashFlowTrend[5].expenseMinor, '40')
  assert.equal(dashboard.cashFlowTrend[5].incomeHeightPermille, 1000)
  assert.equal(dashboard.cashFlowTrend[5].expenseHeightPermille, 400)
  assert.equal(dashboard.accounts.length, 1)
  assert.equal(dashboard.recentTransactions.length, 3)

  const statistics = await transactionService.statistics({
    provider: 'wechat-mini',
    subjectHash,
    data: { month: '2026-08' }
  })
  assert.equal(statistics.summary.incomeMinor, '100')
  assert.equal(statistics.summary.expenseMinor, '40')
  assert.equal(statistics.expenseCategories[0].amountMinor, '40')
  assert.equal(statistics.incomeCategories.length, 1)
  assert.equal(statistics.incomeCategories[0].amountMinor, '100')
  assert.equal(statistics.incomeCategories[0].shareBasisPoints, 10000)
  assert.equal(statistics.daily.length, 31)
  assert.equal(statistics.daily[28].incomeMinor, '100')
})
