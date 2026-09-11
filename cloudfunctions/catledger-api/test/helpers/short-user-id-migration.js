const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const test = require('node:test')
const { splitSqlStatements } = require('../../../../migrations/runner')
const { migrateShortUserIds } = require('../../../../migrations/short-user-id-native')
const { createUserRepository } = require('../../src/user-repository')
const { createAccountService } = require('../../src/account-service')
const { createTransactionService } = require('../../src/transaction-service')
const { executeIdempotentMutation } = require('../../src/ledger-transaction')
const { hashWechatSubject } = require('../../src/handler')
const { createImportService } = require('../../../catledger-import/src/import-service')
const { objectKeyFromFileId } = require('../../../catledger-import/src/storage-gateway')
const { digestParts } = require('../../../catledger-import/src/digest')

const migration = fs.readFileSync(path.resolve(__dirname, '../../../../migrations/0011_short_user_ids.sql'), 'utf8')
const content = fs.readFileSync(path.resolve(__dirname, '../../../catledger-import/test/fixtures/wechat-pay.csv'))
const context = (user, data) => ({ provider: 'wechat-mini', subjectHash: user.subjectHash, data })


const historicalTables = ['catledger_import_transaction_links', 'catledger_import_decisions', 'catledger_import_postings', 'catledger_import_batch_issues']
async function ensureHistoricalTables(pool) {
  for (const filename of ['0004_single_file_import.sql', '0006_unified_finance_updates.sql']) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../../migrations', filename), 'utf8')
    for (const statement of splitSqlStatements(source)) {
      const match = statement.match(/^CREATE TABLE IF NOT EXISTS (catledger_\w+)/)
      if (match && historicalTables.includes(match[1])) await pool.query(statement)
    }
  }
}

async function uidTables(pool) {
  const [rows] = await pool.execute(`SELECT table_name AS name FROM information_schema.columns
    WHERE table_schema = DATABASE() AND LEFT(table_name, 10) = 'catledger_' AND column_name = 'uid' ORDER BY table_name`)
  return rows.map(row => row.name)
}

async function snapshot(pool) {
  const result = {}
  for (const table of await uidTables(pool)) {
    const [rows] = await pool.query('SELECT * FROM `' + table + '`')
    result[table] = rows.map(row => ({ ...row })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }
  return result
}

function withMigratedUids(before, mapping) {
  return Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, rows
    .map(row => ({ ...row, uid: mapping.get(row.uid) || row.uid }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]))
}

async function applyUidMigration(pool, source = migration) {
  const connection = await pool.getConnection()
  let report
  try {
    if (process.env.CATLEDGER_TEST_NATIVE_UID_MIGRATION === '1') {
      return await migrateShortUserIds(connection, source === migration ? {} : { generateUid: () => '1000000000' })
    }
    for (const statement of splitSqlStatements(source)) {
      const [rows] = await connection.query(statement)
      if (statement.startsWith('CALL ')) report = rows[0][0]
    }
    return report
  } finally {
    const [[state]] = await connection.query(`SELECT @@SESSION.foreign_key_checks AS foreignKeys,
      IS_USED_LOCK('catledger:schema-migrations') AS lockOwner`)
    assert.equal(Number(state.foreignKeys), 1)
    assert.equal(state.lockOwner, null)
    await assert.rejects(connection.query('SELECT * FROM catledger_uid_migration_map'), { code: 'ER_NO_SUCH_TABLE' })
    await connection.query('DROP PROCEDURE IF EXISTS catledger_migrate_short_user_ids')
    connection.release()
  }
}

async function seedUser(pool, uid = randomUUID()) {
  const subjectHash = hashWechatSubject('synthetic-short-uid-' + randomUUID())
  const repository = createUserRepository({ getPool: () => pool, generateUid: () => uid })
  const initialized = await repository.bootstrap({ provider: 'wechat-mini', subjectHash })
  const user = { uid, subjectHash, categoryId: initialized.categories.find(row => row.kind === 'expense').id }
  const request = context(user, { requestId: randomUUID(), type: 'wallet', name: '合成迁移账户',
    currency: 'CNY', openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T12:00:00', timezoneOffsetMinutes: -480 })
  const result = await createAccountService({ getPool: () => pool }).create(request)
  return { ...user, accountId: result.accountId, request, result }
}

async function seedImports(pool, user) {
  const objects = new Map()
  const service = createImportService({ getPool: () => pool, storage: {
    async downloadExact(fileID, objectKey) {
      assert.equal(objectKeyFromFileId(fileID), objectKey)
      assert.ok(objects.has(objectKey))
      return objects.get(objectKey)
    },
    async remove() { return true }
  } })
  const prepared = await service.prepareMany(context(user, { requestId: randomUUID(),
    files: [{ fileName: '合成迁移账单.csv', size: content.length }] }))
  const file = prepared.files[0]
  objects.set(file.cloudPath, content)
  const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId,
    fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }))
  let view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] }))
  const issues = view.issues.filter(issue => issue.status === 'open' && issue.issueType === 'account_mapping')
  view = await service.reviewIssueResolveAccountMappings(context(user, { requestId: randomUUID(), updateId: view.update.updateId,
    decisions: issues.map(issue => ({ issueId: issue.issueId, operation: 'resolve', decision: 'apply_fields',
      fields: { ledgerAccountDraft: { name: '合成迁移导入账户', type: 'wallet', currency: 'CNY' } } })) }))
  while (view.issues.some(issue => issue.status === 'open' && issue.issueType === 'category_assignment')) {
    const issue = view.issues.find(issue => issue.status === 'open' && issue.issueType === 'category_assignment')
    await service.reviewIssueResolve(context(user, { requestId: randomUUID(), updateId: view.update.updateId,
      issueId: issue.issueId, issueVersion: issue.version, updateVersion: view.update.version,
      decision: 'apply_fields', fields: { categoryId: user.categoryId } }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
  }
  const postRequest = context(user, { requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version, mode: 'all_ready' })
  const posted = await service.financeUpdatePost(postRequest)
  assert.equal(posted.update.status, 'posted')

  // 留一条合法的历史关系和批次问题，验证不常见的uid外键表也被迁移。
  await pool.execute(`INSERT INTO catledger_economic_event_relations
    (uid, relation_id, update_id, relation_key, relation_key_version, relation_type, status,
     source_event_id, target_event_id, currency, rule_version, reason_codes_json)
    VALUES (?, ?, ?, ?, 'synthetic-v1', 'transfer_pair', 'superseded', ?, ?, 'CNY', 'synthetic-v1', '[]')`,
  [user.uid, randomUUID(), view.update.updateId, digestParts('synthetic-migration-relation', view.update.updateId),
    view.events[0].eventId, view.events[1].eventId])
  await pool.execute(`INSERT INTO catledger_import_batch_issues
    (uid, batch_issue_id, batch_id, issue_code, severity, details_json)
    VALUES (?, ?, ?, 'synthetic_migration_audit', 'info', '{}')`, [user.uid, randomUUID(), parsed.batch.batchId])

  const legacyPostingId = randomUUID()
  await pool.execute(`INSERT INTO catledger_import_postings
    (uid, posting_id, import_id, request_digest, state) VALUES (?, ?, ?, ?, 'completed')`,
    [user.uid, legacyPostingId, file.importId, digestParts('synthetic-legacy-posting', file.importId)])
  const [links] = await pool.execute(`SELECT t.event_id AS eventId, t.transaction_id AS transactionId, e.row_id AS rowId
    FROM catledger_economic_event_transactions t JOIN catledger_event_evidence e ON e.uid=t.uid AND e.event_id=t.event_id
    WHERE t.uid=? AND t.update_id=?`, [user.uid, view.update.updateId])
  for (const link of links) {
    await pool.execute(`INSERT INTO catledger_import_decisions
      (uid,decision_id,event_id,decision_version,disposition,decision_origin,reason_code,account_id,category_id,decision_digest)
      VALUES (?,?,?,1,'post','manual','synthetic_migration',?,?,?)`,
      [user.uid,randomUUID(),link.eventId,user.accountId,user.categoryId,digestParts('synthetic-decision',link.eventId)])
    await pool.execute(`INSERT INTO catledger_import_transaction_links
      (uid,link_id,posting_id,event_id,row_id,transaction_id,relation_role,creation_method,rule_version)
      VALUES (?,?,?,?,?,?,'primary','created','synthetic-v1')`,
      [user.uid,randomUUID(),legacyPostingId,link.eventId,link.rowId,link.transactionId])
  }

  const pendingContent = Buffer.from(content.toString('utf8').replaceAll('WX-SYNTH-', 'WX-MIGRATION-PENDING-'))
  const pendingRequest = context(user, { requestId: randomUUID(), files: [{ fileName: '合成待上传.csv', size: pendingContent.length }] })
  const pending = await service.prepareMany(pendingRequest)
  objects.set(pending.files[0].cloudPath, pendingContent)
  return { service, postRequest, posted, pendingRequest, pending }
}

function registerShortUserIdMigrationTests({ getPool, hasDatabase }) {
  test.describe('0011历史schema回归', () => {
    test.beforeEach(async () => { if (hasDatabase) await ensureHistoricalTables(getPool()) })
    test.afterEach(async () => { if (hasDatabase) for (const table of historicalTables) await getPool().query('DROP TABLE IF EXISTS ' + table) })
  test('0011迁移完整用户账本，保留29张表数据、时间、对象路径和幂等重放', { skip: !hasDatabase, timeout: 30000 }, async () => {
    const pool = getPool()
    const user = await seedUser(pool), other = await seedUser(pool), existingShort = await seedUser(pool, '1234567890')
    const extraCategories = Array.from({ length: 257 }, (_, index) => [randomUUID(), user.uid, 'expense', '迁移分段'+index, '迁移分段'+index])
    await pool.query('INSERT INTO catledger_categories(category_id,uid,kind,name,normalized_name) VALUES ?', [extraCategories])
    const imports = await seedImports(pool, user)
    const accountService = createAccountService({ getPool: () => pool })
    const transactions = createTransactionService({ getPool: () => pool })
    const beforeStatistics = await transactions.statistics(context(user, { month: '2026-08' }))
    const before = await snapshot(pool)
    assert.equal(Object.keys(before).length, 29)
    assert.deepEqual(Object.entries(before).filter(([, rows]) => rows.length === 0).map(([table]) => table), [], '全部uid表都需要非空合成夹具')
    const report = await applyUidMigration(pool)
    assert.equal(Number(report.users_migrated), 2)
    assert.equal(Number(report.tables_verified), 29)
    assert.ok(Number(report.foreign_keys_verified) > 29)
    const [identities] = await pool.query('SELECT uid, subject_hash AS subjectHash FROM catledger_user_identities')
    const mapping = new Map([user, other, existingShort].map(previous => [previous.uid, identities.find(row => row.subjectHash === previous.subjectHash).uid]))
    assert.equal(new Set(mapping.values()).size, 3)
    for (const value of mapping.values()) assert.match(value, /^[1-9][0-9]{9}$/)
    assert.equal(mapping.get(existingShort.uid), existingShort.uid)
    assert.deepEqual(await snapshot(pool), withMigratedUids(before, mapping))
    const repeat = await applyUidMigration(pool)
    assert.equal(Number(repeat.users_migrated), 0)
    assert.deepEqual(await snapshot(pool), withMigratedUids(before, mapping))
    for (const previous of [user, other, existingShort]) {
      const initialized = await createUserRepository({ getPool: () => pool }).bootstrap(context(previous))
      assert.equal(initialized.uid, mapping.get(previous.uid))
      assert.equal(initialized.isNewUser, false)
    }
    assert.deepEqual(await accountService.create(user.request), user.result)
    await assert.rejects(accountService.create({ ...user.request, data: { ...user.request.data, name: '不同请求' } }), { publicCode: 'IDEMPOTENCY_CONFLICT' })
    assert.deepEqual(await transactions.statistics(context(user, { month: '2026-08' })), beforeStatistics)
    assert.deepEqual(await imports.service.prepareMany(imports.pendingRequest), imports.pending)
    assert.equal((await imports.service.financeUpdatePost(imports.postRequest)).update.updateId, imports.posted.update.updateId)
    const pending = imports.pending.files[0]
    await assert.rejects(imports.service.getFile(context(other, { importId: pending.importId })), { publicCode: 'NOT_FOUND' })
    const parsed = await imports.service.parseFile(context(user, { requestId: randomUUID(), importId: pending.importId,
      fileID: 'cloud://synthetic.bucket/' + pending.cloudPath, timezoneOffsetMinutes: -480 }))
    assert.equal(parsed.import.state, 'review_ready')
    const [[oldRows]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_users WHERE uid IN (?, ?)', [user.uid, other.uid])
    assert.equal(Number(oldRows.count), 0)
  })

  test('0011外键校验失败时整体回滚并恢复连接设置', { skip: !hasDatabase, timeout: 30000 }, async () => {
    const pool = getPool(), user = await seedUser(pool)
    const connection = await pool.getConnection()
    try {
      await connection.query('SET FOREIGN_KEY_CHECKS = 0')
      await connection.execute('UPDATE catledger_transactions SET destination_account_id = ? WHERE uid = ?', [randomUUID(), user.uid])
    } finally { await connection.query('SET FOREIGN_KEY_CHECKS = 1'); connection.release() }
    const before = await snapshot(pool)
    await assert.rejects(applyUidMigration(pool), /foreign key validation failed/)
    assert.deepEqual(await snapshot(pool), before)
  })

  test('0011迁移分配碰撞达到上限时不改原身份', { skip: !hasDatabase, timeout: 30000 }, async () => {
    const pool = getPool()
    await seedUser(pool, '1000000000')
    await seedUser(pool)
    const before = await snapshot(pool)
    const collisionSource = migration.replaceAll('CONV(HEX(RANDOM_BYTES(6)), 16, 10)', '0')
    await assert.rejects(applyUidMigration(pool, collisionSource), /collision limit exceeded/)
    assert.deepEqual(await snapshot(pool), before)
  })

  test('0011维护模式分段中断后可用固定映射恢复且数据保持', { skip: !hasDatabase, timeout: 30000 }, async () => {
    const pool = getPool(), user = await seedUser(pool)
    await seedImports(pool, user)
    const before = await snapshot(pool), connection = await pool.getConnection()
    const fixedMappings = [{ oldUid: user.uid, newUid: '1000000001' }]
    let fail = true
    try {
      await assert.rejects(migrateShortUserIds(connection, { fixedMappings, commitChunks: true, afterBatch: async () => { if (fail) { fail = false; throw new Error('synthetic batch interruption') } } }), /synthetic batch interruption/)
      await migrateShortUserIds(connection, { fixedMappings, commitChunks: true })
      assert.deepEqual(await snapshot(pool), withMigratedUids(before, new Map([[user.uid, '1000000001']])))
      await migrateShortUserIds(connection, { fixedMappings, commitChunks: true })
      assert.deepEqual(await snapshot(pool), withMigratedUids(before, new Map([[user.uid, '1000000001']])))
    } finally { connection.release() }
  })

  test('新用户短UID撞号由数据库主键裁决并重新分配', { skip: !hasDatabase }, async () => {
    const pool = getPool(), existing = await seedUser(pool, '1000000000')
    const ids = ['1000000000', '1000000001']
    const repo = createUserRepository({ getPool: () => pool, generateUid: () => ids.shift() })
    const result = await repo.bootstrap({ provider: 'wechat-mini', subjectHash: hashWechatSubject('synthetic-uid-collision') })
    assert.equal(result.uid, '1000000001')
    assert.equal(ids.length, 0)
    assert.equal((await createUserRepository({ getPool: () => pool }).bootstrap(context(existing))).uid, existing.uid)
  })

  test('0011等待已开始的写事务，迁移后原请求只重放一次', { skip: !hasDatabase, timeout: 30000 }, async () => {
    const pool = getPool(), user = await seedUser(pool)
    let entered, release
    const started = new Promise(resolve => { entered = resolve })
    const barrier = new Promise(resolve => { release = resolve })
    const request = { getPool: () => pool, ...context(user, { requestId: randomUUID() }), action: 'synthetic.uid-migration',
      operation: async (connection, uid) => {
        await connection.execute('UPDATE catledger_accounts SET name = ? WHERE uid = ? AND account_id = ?', ['迁移前已完成修改', uid, user.accountId])
        entered()
        await barrier
        return { done: true }
      } }
    const write = executeIdempotentMutation(request)
    await started
    let finished = false
    const migrating = applyUidMigration(pool).then(result => { finished = true; return result })
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [[waiting]] = await pool.query('SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits')
        if (Number(waiting.count)) break
        if (attempt === 99) assert.fail('迁移未等待已开始的事务')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(finished, false)
    } finally { release() }
    await write
    await migrating
    const replay = await executeIdempotentMutation({ ...request, operation: async () => assert.fail('旧requestId不应再次写入') })
    assert.deepEqual(replay, { done: true })
    const [rows] = await pool.query('SELECT name, uid FROM catledger_accounts')
    assert.equal(rows[0].name, '迁移前已完成修改')
    assert.match(rows[0].uid, /^[1-9][0-9]{9}$/)
  })
  })
}

module.exports = { registerShortUserIdMigrationTests }
