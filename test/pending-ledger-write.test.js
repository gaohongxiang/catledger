const test = require('node:test')
const assert = require('node:assert/strict')
const { createPendingWrite } = require('../miniprogram/services/pending-ledger-write')
const clone = value => JSON.parse(JSON.stringify(value))
function harness(storage = new Map()) {
  const h = { storage, calls: [], uid: '1234567890', committed: null, lost: true }
  h.options = { scope: () => h.uid, read: key => storage.get(key), write: (key, value) => storage.set(key, clone(value)),
    remove: key => storage.delete(key), requestId: () => 'original-key', async call(target, action, data) {
      h.calls.push({ target, action, data: clone(data) })
      if (action.endsWith('.commandResult')) {
        if (!h.committed) throw Object.assign(new Error('未确认'), { code: 'OPERATION_UNCONFIRMED' })
        return { action: h.committed.action, receiptId: 'digest', result: { saved: true } }
      }
      h.committed = { action, data: clone(data) }
      if (h.lost) throw Object.assign(new Error('响应丢失'), { code: 'CLOUD_CALL_FAILED' })
      return { saved: true }
    } }
  h.client = createPendingWrite(h.options)
  return h
}
test('响应丢失后编辑内容和重启只核实原请求，不再提交新金额', async () => {
  const h = harness()
  await assert.rejects(h.client.send('api', 'transactions.create', { amountMinor: '100' }))
  const restarted = createPendingWrite(h.options)
  const result = await restarted.send('api', 'transactions.create', { amountMinor: '999' })
  assert.equal(result.recovered, true)
  assert.deepEqual(h.calls.map(c => c.action), ['transactions.create', 'transactions.commandResult'])
  assert.equal(h.calls[1].data.requestId, 'original-key')
  assert.equal(restarted.pending(), null)
})
test('未知原操作不会因新表单/删除意图换键，只重试原 payload', async () => {
  const h = harness()
  await assert.rejects(h.client.send('api', 'transactions.update', { amountMinor: '100' }))
  h.committed = null; h.lost = false
  await h.client.send('api', 'transactions.delete', { transactionId: 'new' })
  assert.equal(h.calls[2].action, 'transactions.update')
  assert.deepEqual(h.calls[2].data, h.calls[0].data)
})
test('只读恢复不会重发；用户隔离和存储失败均不丢原在途请求', async () => {
  const h = harness()
  await assert.rejects(h.client.send('api', 'transactions.create', { amountMinor: '100' }))
  h.committed = null
  await assert.rejects(h.client.verify(), { code: 'OPERATION_UNCONFIRMED' })
  assert.ok(h.client.pending())
  h.uid = '1234567891'; assert.equal(h.client.pending(), null)
  h.uid = '1234567890'; assert.ok(h.client.pending())
  assert.equal(h.calls.filter(c => c.action === 'transactions.create').length, 1)
  const broken = createPendingWrite({ ...h.options, scope: () => 'fresh', write() { throw new Error('full') } })
  await assert.rejects(broken.send('api', 'transactions.create', { amountMinor: '100' }), { code: 'DRAFT_STORAGE_FAILED' })
  assert.equal(h.calls.filter(c => c.action === 'transactions.create').length, 1)
})
