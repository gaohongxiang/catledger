const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, syntheticBill } = require('./helpers/local-services')
const { runtime } = require('./helpers/read-runtime')

async function parsedSource(services, prefix) {
  const content = syntheticBill(1, prefix)
  const prepared = await call(services.import, 'imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成首次整理.csv', size: content.length }] })
  const file = prepared.files[0]
  services.objects.set(file.cloudPath, content)
  return call(services.import, 'imports.parseFile', { requestId: randomUUID(), importId: file.importId,
    fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
}

function pageRuntime(services, uid, batchId) {
  const ui = runtime()
  ui.uid = ui.app.globalData.uid = uid
  ui.rawResponse = true
  ui.respond = (action, data) => services.import({ action, data })
  const page = ui.page('import-workbench')
  page.onLoad({ fresh: '1' })
  page.setData({ phase: 'files_ready', files: [{ state: 'ready', batchId }], uploadSummary: { total: 1, ready: 1 } })
  return { ui, page }
}

test('首次整理真实 Page、handler 与隔离 MySQL：提交后丢响应恢复同一批次和来源', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap')
    const parsed = await parsedSource(services, 'SYNTHETIC-PREPARE-RECOVERY')
    const { ui, page } = pageRuntime(services, identity.uid, parsed.batch.batchId)
    let lose = true, failSummary = false
    ui.respond = async (action, data) => {
      if (action === 'financeUpdates.summary' && failSummary) throw new Error('合成成功后读取失败')
      const response = await services.import({ action, data })
      if (action === 'financeUpdates.prepare' && lose) throw new Error('合成提交后响应丢失')
      return response
    }
    await page.createFinanceUpdate()
    const original = ui.calls.find(entry => entry.action === 'financeUpdates.prepare').data
    const receipt = await call(services.import, 'imports.commandResult', { requestId: original.requestId, commandAction: 'financeUpdates.prepare' })
    lose = false; failSummary = true
    await page.createFinanceUpdate()
    assert.equal(page.data.update && page.data.update.updateId, receipt.updateId)
    assert.equal(page.data.phase, 'review')
    assert.equal(page.data.errorMessage, '整理已完成，结果待刷新')
    assert.equal(ui.load('services/pending-ledger-write').pending(), null)
    failSummary = false
    await page.retryPagedView()
    assert.equal(page.data.errorMessage, '')
    assert.equal(ui.calls.filter(entry => entry.action === 'financeUpdates.prepare').length, 1)
    assert.equal(ui.calls.find(entry => entry.action === 'imports.commandResult').data.requestId, original.requestId)
    const [[count]] = await lab.owner.execute('SELECT COUNT(*) AS total FROM catledger_finance_updates WHERE uid=?', [identity.uid])
    const [[source]] = await lab.owner.execute('SELECT COUNT(*) AS total FROM catledger_finance_update_sources WHERE uid=? AND update_id=? AND batch_id=?', [identity.uid, receipt.updateId, parsed.batch.batchId])
    assert.equal(Number(count.total), 1)
    assert.equal(Number(source.total), 1)
    const replayed = await Promise.all(Array.from({ length: 3 }, () => call(services.import, 'financeUpdates.prepare', original)))
    replayed.forEach(result => assert.deepEqual(result, receipt))
    await assert.rejects(call(services.import, 'financeUpdates.organize', {
      requestId: randomUUID(), updateId: receipt.updateId, version: receipt.appliedVersion - 1
    }), { publicCode: 'CONFLICT' })
    const other = localServices({ apiPool: lab.owner, importPool: lab.owner, subject: 'synthetic-prepare-other' })
    await call(other.api, 'bootstrap')
    await assert.rejects(call(other.import, 'imports.commandResult', { requestId: original.requestId, commandAction: 'financeUpdates.prepare' }), { publicCode: 'OPERATION_UNCONFIRMED' })
    await assert.rejects(call(other.import, 'financeUpdates.prepare', original), { publicCode: 'NOT_FOUND' })
    page.onUnload()
  } finally { await lab.close() }
})

test('首次整理事务中途失败全部回滚，真实 Page 查询未确认后用原请求恢复，不遗留来源占用', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap')
    const parsed = await parsedSource(services, 'SYNTHETIC-PREPARE-ROLLBACK')
    const { ui, page } = pageRuntime(services, identity.uid, parsed.batch.batchId)
    await lab.owner.query("CREATE TRIGGER fail_prepare_event BEFORE INSERT ON catledger_economic_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic prepare rollback'")
    try { await page.createFinanceUpdate() } finally { await lab.owner.query('DROP TRIGGER fail_prepare_event') }
    assert.equal(page.data.update, null)
    assert.equal(page.data.preparePending, true)
    const original = ui.calls.find(entry => entry.action === 'financeUpdates.prepare').data
    for (const table of ['catledger_finance_updates', 'catledger_finance_update_sources', 'catledger_economic_events']) {
      const [[count]] = await lab.owner.execute('SELECT COUNT(*) AS total FROM ' + table + ' WHERE uid=?', [identity.uid])
      assert.equal(Number(count.total), 0, table)
    }
    await assert.rejects(call(services.import, 'imports.commandResult', { requestId: original.requestId, commandAction: 'financeUpdates.prepare' }), { publicCode: 'OPERATION_UNCONFIRMED' })
    await page.createFinanceUpdate()
    assert.equal(page.data.phase, 'review')
    assert.equal(page.data.errorMessage, '')
    const sends = ui.calls.filter(entry => entry.action === 'financeUpdates.prepare')
    assert.equal(sends.length, 2)
    assert.deepEqual(JSON.parse(JSON.stringify(sends[1].data)), JSON.parse(JSON.stringify(original)))
    assert.equal(ui.load('services/pending-ledger-write').pending(), null)
    const [[result]] = await lab.owner.execute(`SELECT
      (SELECT COUNT(*) FROM catledger_finance_updates WHERE uid=?) AS updates,
      (SELECT COUNT(*) FROM catledger_finance_update_sources WHERE uid=?) AS sources,
      (SELECT COUNT(*) FROM catledger_mutation_receipts WHERE uid=? AND action='financeUpdates.prepare') AS receipts,
      (SELECT COUNT(*) FROM catledger_transactions WHERE uid=?) AS transactions`, [identity.uid, identity.uid, identity.uid, identity.uid])
    assert.deepEqual(Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Number(value)])), { updates: 1, sources: 1, receipts: 1, transactions: 0 })
    page.onUnload()
  } finally { await lab.close() }
})
