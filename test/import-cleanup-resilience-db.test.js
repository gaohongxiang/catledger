const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const { createImportFileCleanup } = require('../cloudfunctions/catledger-import/src/import-file-cleanup')
const { createFinanceDraftCleanup } = require('../cloudfunctions/catledger-import/src/finance-draft-cleanup')
const { runScheduledMaintenance } = require('../cloudfunctions/catledger-import/src/scheduled-maintenance')
const { readCleanupBacklog } = require('../cloudfunctions/catledger-import/src/cleanup-policy')
const { createCleanupBudget } = require('../cloudfunctions/catledger-import/src/cleanup-runtime')
const { splitSqlStatements } = require('../migrations/runner')
const manifest = require('../cloudfunctions/catledger-api/src/export-manifest.json')
const skip = !process.env.CATLEDGER_TEST_DB_HOST

async function fileFixture(pool, uid, ageHours = 25) {
  const id = randomUUID(), fileID = 'cloud://synthetic.bucket/' + id + '.csv'
  await pool.execute(`INSERT INTO catledger_import_files
    (uid, import_id, state, original_file_name, declared_size, file_extension, storage_object_key, cloud_file_id, updated_at)
    VALUES (?, ?, 'failed', '合成清理.csv', 1, 'csv', ?, ?, DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR))`,
  [uid, id, 'synthetic/' + id, fileID, ageHours])
  return { uid, id, fileID }
}

function wrappedPool(pool, beforeExecute) {
  return { async getConnection() {
    const connection = await pool.getConnection()
    return new Proxy(connection, { get(target, name) {
      if (name === 'execute') return async (sql, values) => {
        await beforeExecute(sql, values, connection)
        return connection.execute(sql, values)
      }
      const value = target[name]
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
}

function cleanupService(pool, storage) {
  return { ...createImportFileCleanup({ getPool: () => pool, storage }),
    ...createFinanceDraftCleanup({ getPool: () => pool }),
    cleanupBacklogGlobal: (kind, options) => readCleanupBacklog(() => pool, kind, options) }
}

test('失败原件持久退避且不刷新活动时间，续批越过失败项并保留跨用户隔离', { skip }, async () => {
  const lab = await isolatedMysql()
  try {
    const a = localServices({ apiPool: lab.owner, importPool: lab.owner, subject: 'synthetic-cleanup-a' })
    const b = localServices({ apiPool: lab.owner, importPool: lab.owner, subject: 'synthetic-cleanup-b' })
    const ia = await call(a.api, 'bootstrap'), ib = await call(b.api, 'bootstrap')
    const files = []
    for (let index = 0; index < 8; index += 1) files.push(await fileFixture(lab.owner, index < 2 ? ia.uid : ib.uid, 40 - index))
    const recent = await fileFixture(lab.owner, ia.uid, 23)
    const [[before]] = await lab.owner.execute('SELECT updated_at AS updatedAt, version FROM catledger_import_files WHERE uid=? AND import_id=?', [ia.uid, files[0].id])
    const [[revision]] = await lab.owner.execute('SELECT data_revision AS value FROM catledger_users WHERE uid=?', [ia.uid])
    const attempts = [], poison = new Set(files.slice(0, 2).map(file => file.fileID))
    const service = cleanupService(lab.owner, { async remove(fileID) {
      attempts.push(fileID)
      if (fileID === files[0].fileID && poison.size) throw new Error('synthetic storage failure')
      return !poison.has(fileID)
    } })
    const result = await runScheduledMaintenance(service)
    assert.equal(result.files.checked, 8)
    assert.equal(result.files.deleted, 6)
    assert.equal(result.files.failed, 2)
    assert.equal(result.files.backoffFailed, 0)
    assert.equal(new Set(attempts).size, 8)
    assert.equal(result.files.backlog.pending, 2)
    assert.equal(result.files.backlog.deferred, 2)
    assert.ok(result.files.backlog.oldestPendingAgeMs >= 39 * 3600000)
    assert.doesNotMatch(JSON.stringify(result), /cloud:\/\/|synthetic|"uid"|"id"/)
    const [[after]] = await lab.owner.execute(`SELECT updated_at AS updatedAt, version, cleanup_failure_count AS failures,
      TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(3), cleanup_retry_after) AS retryIn FROM catledger_import_files WHERE uid=? AND import_id=?`, [ia.uid, files[0].id])
    assert.equal(after.updatedAt, before.updatedAt)
    assert.equal(after.version, before.version)
    assert.equal(after.failures, 1)
    assert.ok(after.retryIn >= 3590 && after.retryIn <= 3600)
    const [[revisionAfter]] = await lab.owner.execute('SELECT data_revision AS value FROM catledger_users WHERE uid=?', [ia.uid])
    assert.equal(revisionAfter.value, revision.value, '纯失败退避不改变私有账本修订')
    const again = await runScheduledMaintenance(service)
    assert.equal(again.files.checked, 0)
    assert.equal(attempts.length, 8)

    await lab.owner.execute(`UPDATE catledger_import_files SET cleanup_failure_count=20,
      cleanup_retry_after=DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND), updated_at=updated_at WHERE uid=? AND import_id=?`, [ia.uid, files[0].id])
    const cappedRetry = await runScheduledMaintenance(service)
    assert.equal(cappedRetry.files.checked, 1)
    assert.equal(cappedRetry.files.failed, 1)
    const [[capped]] = await lab.owner.execute('SELECT TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(3), cleanup_retry_after) AS retryIn FROM catledger_import_files WHERE uid=? AND import_id=?', [ia.uid, files[0].id])
    assert.ok(capped.retryIn >= 604790 && capped.retryIn <= 604800, '反复失败最多退避7天')

    poison.clear()
    await lab.owner.execute(`UPDATE catledger_import_files SET cleanup_retry_after=DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND),
      updated_at=updated_at WHERE uid=? AND cleanup_failure_count>0`, [ia.uid])
    const retried = await runScheduledMaintenance(service)
    assert.equal(retried.files.deleted, 2)
    const [[cleaned]] = await lab.owner.execute('SELECT content_deleted_at AS deleted, cleanup_retry_after AS retryAfter, cleanup_failure_count AS failures FROM catledger_import_files WHERE uid=? AND import_id=?', [ia.uid, files[0].id])
    assert.ok(cleaned.deleted)
    assert.equal(cleaned.retryAfter, null)
    assert.equal(cleaned.failures, 0)
    const [[retained]] = await lab.owner.execute('SELECT content_deleted_at AS deleted FROM catledger_import_files WHERE uid=? AND import_id=?', [ia.uid, recent.id])
    assert.equal(retained.deleted, null)
  } finally { await lab.close() }
})

test('删除成功后登记失败可按原对象重试；退避登记失败也不阻塞同次后续批次', { skip }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap')
    const first = await fileFixture(lab.owner, identity.uid, 40)
    for (let index = 0; index < 6; index += 1) await fileFixture(lab.owner, identity.uid, 30 - index)
    await lab.owner.execute("UPDATE catledger_import_files SET updated_at='2026-01-01 00:00:00.000' WHERE uid=?", [identity.uid])
    let failMark = true
    const pool = wrappedPool(lab.owner, async (sql, values) => {
      if (failMark && /UPDATE catledger_import_files SET content_deleted_at/.test(sql) && values[1] === first.id) throw new Error('synthetic mark failure')
      if (failMark && /SET cleanup_retry_after = DATE_ADD/.test(sql) && values[1] === first.id) throw new Error('synthetic backoff failure')
    })
    const deleted = new Set(), attempts = []
    const service = cleanupService(pool, { async remove(fileID) { attempts.push(fileID); deleted.add(fileID); return true } })
    const result = await runScheduledMaintenance(service)
    assert.equal(result.files.checked, 7)
    assert.equal(result.files.deleted, 6)
    assert.equal(result.files.failed, 1)
    assert.equal(result.files.backoffFailed, 1)
    assert.equal(attempts.filter(id => id === first.fileID).length, 1, '内部游标跳过同轮失败项')
    assert.equal(deleted.size, 7)
    const [[before]] = await lab.owner.execute('SELECT content_deleted_at AS deleted FROM catledger_import_files WHERE uid=? AND import_id=?', [identity.uid, first.id])
    assert.equal(before.deleted, null)
    failMark = false
    const retried = await runScheduledMaintenance(service)
    assert.equal(retried.files.deleted, 1)
    assert.equal(deleted.size, 7, '重试沿用相同云对象，没有换身份或生成新对象')
  } finally { await lab.close() }
})

test('草稿清理中途失败原子回滚，失败草稿退避不妨碍后续草稿', { skip }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap')
    const first = await prepareSyntheticUpdate(services, 1, 'SYNTHETIC-CLEANUP-ROLLBACK')
    const second = await prepareSyntheticUpdate(services, 1, 'SYNTHETIC-CLEANUP-SUCCESS')
    await lab.owner.execute('UPDATE catledger_finance_updates SET updated_at=DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 49 HOUR) WHERE uid=?', [identity.uid])
    const [[before]] = await lab.owner.execute('SELECT version, updated_at AS updatedAt FROM catledger_finance_updates WHERE uid=? AND update_id=?', [identity.uid, first.updateId])
    const pool = wrappedPool(lab.owner, async (sql, values) => {
      if (sql.startsWith('DELETE FROM catledger_economic_events ') && values[1] === first.updateId) throw new Error('synthetic discard failure')
    })
    const result = await createFinanceDraftCleanup({ getPool: () => pool }).cleanupExpiredDraftsGlobal(10)
    assert.equal(result.checked, 2)
    assert.equal(result.cleaned, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.backoffFailed, 0)
    const [[failed]] = await lab.owner.execute('SELECT status, version, updated_at AS updatedAt, cleanup_failure_count AS failures FROM catledger_finance_updates WHERE uid=? AND update_id=?', [identity.uid, first.updateId])
    assert.equal(failed.status, 'review')
    assert.equal(failed.version, before.version)
    assert.equal(failed.updatedAt, before.updatedAt)
    assert.equal(failed.failures, 1)
    const [[events]] = await lab.owner.execute('SELECT COUNT(*) AS value FROM catledger_economic_events WHERE uid=? AND update_id=?', [identity.uid, first.updateId])
    assert.ok(Number(events.value) > 0)
    const [[cleaned]] = await lab.owner.execute('SELECT status FROM catledger_finance_updates WHERE uid=? AND update_id=?', [identity.uid, second.updateId])
    assert.equal(cleaned.status, 'abandoned')
    const [[actions]] = await lab.owner.execute("SELECT COUNT(*) AS value FROM catledger_finance_actions WHERE uid=? AND update_id=? AND action_type='abandon_update'", [identity.uid, first.updateId])
    assert.equal(Number(actions.value), 0)
  } finally { await lab.close() }
})

test('等待用户锁时发生原件续期或草稿入账，锁内重验后跳过旧候选', { skip }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap')
    for (const kind of ['files', 'drafts']) {
      const file = kind === 'files' ? await fileFixture(lab.owner, identity.uid) : null
      const draft = kind === 'drafts' ? await prepareSyntheticUpdate(services, 1, 'SYNTHETIC-CLEANUP-RACE') : null
      if (draft) await lab.owner.execute('UPDATE catledger_finance_updates SET updated_at=DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 49 HOUR) WHERE uid=? AND update_id=?', [identity.uid, draft.updateId])
      const blocker = await lab.owner.getConnection()
      let entered
      const waiting = new Promise(resolve => { entered = resolve })
      const pool = wrappedPool(lab.owner, async sql => { if (/SELECT uid FROM catledger_users.*FOR UPDATE/.test(sql)) entered() })
      let removed = 0
      const service = cleanupService(pool, { async remove() { removed += 1; return true } })
      try {
        await blocker.beginTransaction()
        await blocker.execute('SELECT uid FROM catledger_users WHERE uid=? FOR UPDATE', [identity.uid])
        const pending = kind === 'files' ? service.cleanupExpiredFilesGlobal(10) : service.cleanupExpiredDraftsGlobal(10)
        await Promise.race([waiting, pending.then(() => { throw new Error('Cleanup finished before reaching the user lock') })])
        if (file) await blocker.execute('UPDATE catledger_import_files SET updated_at=CURRENT_TIMESTAMP(3) WHERE uid=? AND import_id=?', [identity.uid, file.id])
        else await blocker.execute("UPDATE catledger_finance_updates SET status='posted' WHERE uid=? AND update_id=?", [identity.uid, draft.updateId])
        await blocker.commit()
        const result = await pending
        assert.equal(result.checked, 1)
        assert.equal(result.skipped, 1)
        assert.equal(result.failed, 0)
        assert.equal(removed, 0)
      } finally { await blocker.rollback(); blocker.release() }
    }
  } finally { await lab.close() }
})

test('单项跨过预算后不能继续登记或处理下一项，数据库连接被销毁回滚', { skip }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap')
    await fileFixture(lab.owner, identity.uid, 30)
    await fileFixture(lab.owner, identity.uid, 29)
    let clock = 0, removed = 0
    const budget = createCleanupBudget({ now: () => clock, timeoutMs: 1000 })
    const cleanup = createImportFileCleanup({ getPool: () => lab.owner, storage: { async remove() { removed += 1; clock = 1001; return true } } })
    const result = await cleanup.cleanupExpiredFilesGlobal(10, { budget })
    assert.equal(result.checked, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.backoffFailed, 1)
    assert.equal(removed, 1)
    const [[marked]] = await lab.owner.execute('SELECT COUNT(*) AS value FROM catledger_import_files WHERE uid=? AND content_deleted_at IS NOT NULL', [identity.uid])
    assert.equal(Number(marked.value), 0)
  } finally { await lab.close() }
})

test('0035维护迁移可重入，新增状态不进入私有账本导出列', { skip }, async () => {
  const lab = await isolatedMysql()
  try {
    const sql = await fs.readFile(path.resolve(__dirname, '../migrations/0035_import_cleanup_retry.sql'), 'utf8')
    const connection = await lab.owner.getConnection()
    try { for (const statement of splitSqlStatements(sql)) await connection.query(statement) }
    finally { connection.release() }
    const [columns] = await lab.owner.execute(`SELECT table_name AS tableName, column_name AS columnName, column_default AS defaultValue
      FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name IN ('cleanup_retry_after','cleanup_failure_count')`)
    assert.equal(columns.length, 4)
    assert.equal(columns.filter(column => column.columnName === 'cleanup_failure_count' && String(column.defaultValue) === '0').length, 2)
    for (const table of manifest) assert.ok(!table.columns.some(column => column.startsWith('cleanup_')))
    assert.equal(lab.migrations, 35)
  } finally { await lab.close() }
})
