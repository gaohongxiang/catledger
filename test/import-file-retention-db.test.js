const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, syntheticBill } = require('./helpers/local-services')

test('原件分级清理：按期删除已解析/失败/待上传/已提交对象，保留宽限期内的对象', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const lab = await isolatedMysql()
  try {
    const removed = []
    const storage = {
      async downloadExact() { return null },
      async remove(fileID) { removed.push(fileID); return true }
    }
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner, storage })
    const identity = await call(services.api, 'bootstrap')
    const content = syntheticBill(1, 'SYNTHETIC-RETENTION')
    const prepared = []
    for (let index = 0; index < 6; index += 1) {
      const result = await call(services.import, 'imports.prepareMany', {
        requestId: randomUUID(), files: [{ fileName: '合成保留' + index + '.csv', size: content.length }]
      })
      prepared.push(result.files[0])
    }
    const states = ['review_ready', 'failed', 'awaiting_upload', 'committed', 'review_ready', 'failed']
    const ages = [8, 31, 2, 0, 6, 29]
    for (let index = 0; index < prepared.length; index += 1) {
      const file = prepared[index]
      await lab.owner.execute(
        `UPDATE catledger_import_files
            SET state = ?, cloud_file_id = ?, updated_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${ages[index]} DAY)
          WHERE uid = ? AND import_id = ?`,
        [states[index], 'cloud://synthetic.bucket/' + file.cloudPath, identity.uid, file.importId]
      )
    }
    const trigger = await call(services.import, 'imports.prepareMany', {
      requestId: randomUUID(), files: [{ fileName: '合成保留触发.csv', size: content.length }]
    })
    assert.equal(trigger.files.length, 1)
    const [rows] = await lab.owner.execute(
      'SELECT import_id AS importId, state, content_deleted_at AS deletedAt FROM catledger_import_files WHERE uid = ? ORDER BY import_id',
      [identity.uid]
    )
    const byId = new Map(rows.map(row => [row.importId, row]))
    assert.equal(removed.length, 4)
    for (const index of [0, 1, 2, 3]) assert.ok(byId.get(prepared[index].importId).deletedAt)
    for (const index of [4, 5]) assert.equal(byId.get(prepared[index].importId).deletedAt, null)
    assert.equal(byId.get(trigger.files[0].importId).deletedAt, null)
  } finally { await lab.close() }
})

test('全局定时清理跨用户删除到期原件，不碰未到期对象', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const lab = await isolatedMysql()
  try {
    const removed = []
    const storage = {
      async downloadExact() { return null },
      async remove(fileID) { removed.push(fileID); return true }
    }
    const a = localServices({ apiPool: lab.owner, importPool: lab.owner, storage, subject: 'synthetic-retention-a' })
    const b = localServices({ apiPool: lab.owner, importPool: lab.owner, storage, subject: 'synthetic-retention-b' })
    const identityA = await call(a.api, 'bootstrap'), identityB = await call(b.api, 'bootstrap')
    const content = syntheticBill(1, 'SYNTHETIC-GLOBAL-RETENTION')
    const create = async services => (await call(services.import, 'imports.prepareMany', {
      requestId: randomUUID(), files: [{ fileName: '合成全局保留.csv', size: content.length }]
    })).files[0]
    const agedA = await create(a), recentA = await create(a)
    const agedB = await create(b), recentB = await create(b)
    const update = async (services, file, days) => lab.owner.execute(
      `UPDATE catledger_import_files SET state = 'review_ready', cloud_file_id = ?,
              updated_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${days} DAY)
        WHERE uid = ? AND import_id = ?`,
      ['cloud://synthetic.bucket/' + file.cloudPath, services === a ? identityA.uid : identityB.uid, file.importId]
    )
    await update(a, agedA, 8); await update(a, recentA, 6)
    await update(b, agedB, 8); await update(b, recentB, 6)
    const result = await a.importer.cleanupExpiredFilesGlobal(10)
    assert.equal(result.checked, 2)
    assert.equal(result.deleted, 2)
    assert.equal(removed.length, 2)
    const [rows] = await lab.owner.execute(
      'SELECT uid, import_id AS importId, content_deleted_at AS deletedAt FROM catledger_import_files WHERE uid IN (?, ?)',
      [identityA.uid, identityB.uid]
    )
    const byId = new Map(rows.map(row => [row.importId, row]))
    assert.ok(byId.get(agedA.importId).deletedAt)
    assert.ok(byId.get(agedB.importId).deletedAt)
    assert.equal(byId.get(recentA.importId).deletedAt, null)
    assert.equal(byId.get(recentB.importId).deletedAt, null)
    const [[revisionA]] = await lab.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [identityA.uid])
    const [[revisionB]] = await lab.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [identityB.uid])
    assert.ok(Number(revisionA.revision) >= 1 && Number(revisionB.revision) >= 1)
  } finally { await lab.close() }
})
