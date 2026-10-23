const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')

const skip = !process.env.CATLEDGER_TEST_DB_HOST

test('48h 未入账草稿硬清理：复用 abandon 事务，保留来源行、回执与已入账批次', { skip }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap')
    const expired = await prepareSyntheticUpdate(services, 2, 'SYNTHETIC-DRAFT-EXPIRED')
    const current = await prepareSyntheticUpdate(services, 2, 'SYNTHETIC-DRAFT-CURRENT')
    const posted = await prepareSyntheticUpdate(services, 2, 'SYNTHETIC-DRAFT-POSTED')
    await lab.owner.execute("UPDATE catledger_finance_updates SET status='posted' WHERE uid=? AND update_id=?", [identity.uid, posted.updateId])
    await lab.owner.execute('UPDATE catledger_finance_updates SET updated_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 49 HOUR) WHERE uid=? AND update_id IN (?,?)',
      [identity.uid, expired.updateId, posted.updateId])
    const [[expiredBefore]] = await lab.owner.execute('SELECT version FROM catledger_finance_updates WHERE uid=? AND update_id=?', [identity.uid, expired.updateId])
    const [[receiptsBefore]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_mutation_receipts WHERE uid=?', [identity.uid])
    const [[revisionBefore]] = await lab.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [identity.uid])
    await lab.owner.execute(`INSERT INTO catledger_mutation_receipts
      (uid, idempotency_key_digest, action, request_digest, result_json) VALUES (?,?,?,?,?)`,
    [identity.uid, 'a'.repeat(64), 'financeUpdates.post', 'b'.repeat(64), JSON.stringify({ protocolVersion: 2, status: 'posted' })])

    const result = await services.importer.cleanupExpiredDraftsGlobal(10)
    assert.deepEqual(result, { checked: 1, cleaned: 1, skipped: 0, failed: 0, backoffFailed: 0 })

    const [[expiredRow]] = await lab.owner.execute('SELECT status, version, error_code AS errorCode FROM catledger_finance_updates WHERE uid=? AND update_id=?', [identity.uid, expired.updateId])
    assert.equal(expiredRow.status, 'abandoned')
    assert.equal(expiredRow.errorCode, 'DRAFT_EXPIRED')
    assert.equal(Number(expiredRow.version), Number(expiredBefore.version) + 1)
    const [[currentRow]] = await lab.owner.execute('SELECT status FROM catledger_finance_updates WHERE uid=? AND update_id=?', [identity.uid, current.updateId])
    const [[postedRow]] = await lab.owner.execute('SELECT status FROM catledger_finance_updates WHERE uid=? AND update_id=?', [identity.uid, posted.updateId])
    assert.equal(currentRow.status, 'review')
    assert.equal(postedRow.status, 'posted')

    const [[events]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_economic_events WHERE uid=? AND update_id=?', [identity.uid, expired.updateId])
    assert.equal(Number(events.count), 0, '硬清理删除派生整理数据')
    const [[sources]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_finance_update_sources WHERE uid=? AND update_id=?', [identity.uid, expired.updateId])
    const [[rows]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM catledger_import_rows r
      JOIN catledger_import_batches b ON b.uid=r.uid AND b.batch_id=r.batch_id
      JOIN catledger_finance_update_sources s ON s.uid=b.uid AND s.batch_id=b.batch_id
      WHERE s.uid=? AND s.update_id=?`, [identity.uid, expired.updateId])
    const [[files]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM catledger_import_files f
      JOIN catledger_finance_update_sources s ON s.uid=f.uid AND s.import_id=f.import_id
      WHERE s.uid=? AND s.update_id=?`, [identity.uid, expired.updateId])
    assert.ok(Number(sources.count) > 0)
    assert.ok(Number(rows.count) > 0)
    assert.ok(Number(files.count) > 0)
    const [[actions]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM catledger_finance_actions
      WHERE uid=? AND update_id=? AND action_type='abandon_update' AND JSON_CONTAINS(reason_codes_json, '"expired_draft_cleanup"')`,
    [identity.uid, expired.updateId])
    assert.equal(Number(actions.count), 1)
    const [[after]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_mutation_receipts WHERE uid=?', [identity.uid])
    assert.equal(Number(after.count), Number(receiptsBefore.count) + 1, '硬清理不删除任何回执')
    const [[postedReceipt]] = await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_mutation_receipts WHERE uid=? AND action='financeUpdates.post'", [identity.uid])
    assert.equal(Number(postedReceipt.count), 1)
    const [[revisionAfter]] = await lab.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [identity.uid])
    assert.equal(Number(revisionAfter.revision), Number(revisionBefore.revision) + 1)

    const again = await services.importer.cleanupExpiredDraftsGlobal(10)
    assert.deepEqual(again, { checked: 0, cleaned: 0, skipped: 0, failed: 0, backoffFailed: 0 })
  } finally { await lab.close() }
})

test('硬清理有界且只选择 draft/failed/review，不删除正式账本', { skip }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap')
    const updates = []
    for (let index = 0; index < 3; index += 1) updates.push(await prepareSyntheticUpdate(services, 1, 'SYNTHETIC-DRAFT-LIMIT-' + index))
    await lab.owner.execute('UPDATE catledger_finance_updates SET updated_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 49 HOUR) WHERE uid=?', [identity.uid])
    const result = await services.importer.cleanupExpiredDraftsGlobal(2)
    assert.equal(result.checked, 2)
    assert.equal(result.cleaned, 2)
    const [rows] = await lab.owner.execute('SELECT update_id AS updateId, status FROM catledger_finance_updates WHERE uid=? ORDER BY update_id', [identity.uid])
    assert.equal(rows.filter(row => row.status === 'abandoned').length, 2)
    assert.equal(rows.filter(row => row.status === 'review').length, 1)
    const [[transactions]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [identity.uid])
    assert.equal(Number(transactions.count), 0)
  } finally { await lab.close() }
})
