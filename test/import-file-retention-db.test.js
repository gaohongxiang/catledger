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
