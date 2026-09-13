const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { reconcileReceipts } = require('../scripts/reconcile-import-receipts')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const { digestRequest, digestIdempotencyKey } = require('../cloudfunctions/catledger-import/src/digest')
const hasDatabase = Boolean(process.env.CATLEDGER_TEST_DB_HOST)
test('单协议切换保护旧请求摘要；只转换冻结事实，跨用户/事实缺失拒绝，重入不重复', { skip: !hasDatabase }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const identity = await call(services.api, 'bootstrap', {})
    const prepared = await prepareSyntheticUpdate(services, 3)
    const requestId = randomUUID()
    const original = { requestId, updateId: prepared.updateId, version: prepared.appliedVersion }
    const receipt = await call(services.import, 'financeUpdates.organize', original)
    const uid = identity.uid, key = receipt.receiptId
    const oldDigest = digestRequest(receipt.action, { updateId: original.updateId, version: original.version, resultMode: 'receipt' })
    await lab.owner.execute('UPDATE catledger_mutation_receipts SET request_digest = ?, result_json = ? WHERE uid = ? AND idempotency_key_digest = ?',
      [oldDigest, JSON.stringify({ receiptVersion: 1, kind: 'finance-update-view', updateId: receipt.updateId, appliedResult: receipt }), uid, key])
    const unknownId = randomUUID(), unknownKey = digestIdempotencyKey(unknownId)
    const unknown = { receiptVersion: 1, kind: 'finance-update-view', updateId: receipt.updateId }
    await lab.owner.execute('INSERT INTO catledger_mutation_receipts (uid,idempotency_key_digest,action,request_digest,result_json) VALUES (?,?,?,?,?)',
      [uid, unknownKey, 'financeUpdates.post', '0'.repeat(64), JSON.stringify(unknown)])
    const before = await reconcileReceipts(lab.owner)
    assert.equal(before.convertible, 1); assert.equal(before.unconfirmed, 1); assert.equal(before.converted, 0)
    assert.equal((await reconcileReceipts(lab.owner, { apply: true })).converted, 1)
    assert.equal((await reconcileReceipts(lab.owner, { apply: true })).converted, 0)
    const [[stored]] = await lab.owner.execute('SELECT request_digest AS digest,result_json AS result FROM catledger_mutation_receipts WHERE uid=? AND idempotency_key_digest=?', [uid,key])
    assert.equal(stored.digest, oldDigest); assert.deepEqual(stored.result.value, receipt)
    assert.deepEqual(await call(services.import, 'imports.commandResult', { requestId, commandAction: receipt.action }), receipt)
    await assert.rejects(call(services.import, receipt.action, original), { publicCode: 'IDEMPOTENCY_CONFLICT' })
    const [[untouched]] = await lab.owner.execute('SELECT result_json AS result FROM catledger_mutation_receipts WHERE uid=? AND idempotency_key_digest=?', [uid,unknownKey])
    assert.deepEqual(untouched.result, unknown)
    await assert.rejects(call(services.import, 'imports.commandResult', { requestId: unknownId, commandAction: 'financeUpdates.post' }), { publicCode: 'RECEIPT_RECONCILIATION_REQUIRED' })
    const other = localServices({ apiPool: lab.owner, importPool: lab.owner, subject: 'synthetic-cutover-other' })
    await call(other.api, 'bootstrap', {})
    await assert.rejects(call(other.import, 'imports.commandResult', { requestId: unknownId, commandAction: 'financeUpdates.post' }), { publicCode: 'OPERATION_UNCONFIRMED' })
    const events = await call(services.import, 'economicEvents.list', { updateId: receipt.updateId })
    const eventId = events.items[0].eventId
    const evidence = await call(services.import, 'economicEvents.evidence', { eventId })
    assert.ok(evidence.items.length)
    assert.equal(evidence.items[0].detailRequired, true)
    const evidenceId = evidence.items[0].evidenceId
    const detail = await call(services.import, 'economicEvents.detail', { eventId, evidenceId })
    const [[raw]] = await lab.owner.execute(`SELECT r.raw_fields_json AS fields FROM catledger_import_rows r
      JOIN catledger_event_evidence e ON e.uid=r.uid AND e.row_id=r.row_id WHERE e.uid=? AND e.evidence_id=?`, [uid, evidenceId])
    assert.deepEqual(JSON.parse(detail.part), raw.fields)
    await assert.rejects(call(other.import, 'economicEvents.evidence', { eventId }), { publicCode: 'NOT_FOUND' })
    await assert.rejects(call(other.import, 'economicEvents.detail', { eventId, evidenceId }), { publicCode: 'NOT_FOUND' })
    const [[count]] = await lab.owner.execute('SELECT COUNT(*) AS total FROM catledger_transactions WHERE uid=?', [uid])
    assert.equal(Number(count.total), 0)
  } finally { await lab.close() }
})
