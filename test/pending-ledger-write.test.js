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

test('批量删除 exact 模式不把别的未完成操作当成当前选择重发', async () => {
  const h = harness()
  await assert.rejects(h.client.send('api', 'transactions.update', { transactionId: 'old', amountMinor: '100' }))
  h.committed = null; h.lost = false
  await assert.rejects(h.client.send('api', 'transactions.deleteMany', { items: [{ transactionId: 'new', version: 1 }] }, { exact: true }), { code: 'PENDING_OPERATION_EXISTS' })
  assert.deepEqual(h.calls.map(row => row.action), ['transactions.update', 'transactions.commandResult'])
  assert.equal(h.client.pending().action, 'transactions.update')
})

test('exact 确认旧回执后执行当前选择；同一删除恢复仍只查询回执', async () => {
  const h = harness()
  await assert.rejects(h.client.send('api', 'transactions.update', { amountMinor: '100' }))
  h.lost = false
  const data = { items: [{ transactionId: 'chosen', version: 1 }] }
  await h.client.send('api', 'transactions.deleteMany', data, { exact: true })
  assert.deepEqual(h.calls.map(row => row.action), ['transactions.update', 'transactions.commandResult', 'transactions.deleteMany'])
  assert.deepEqual(h.calls[2].data.items, data.items)
  h.lost = true
  await assert.rejects(h.client.send('api', 'transactions.deleteMany', data, { exact: true }))
  assert.equal((await h.client.send('api', 'transactions.deleteMany', data, { exact: true })).recovered, true)
  assert.equal(h.calls.filter(row => row.action === 'transactions.deleteMany').length, 2)
})

test('核实原删除期间换用户或退出，不在新身份下重发，原请求仍可恢复', async () => {
  for (const changedUid of ['1234567891', '']) {
    const h = harness()
    const data = { items: [{ transactionId: 'original', version: 1 }] }
    await assert.rejects(h.client.send('api', 'transactions.deleteMany', data, { exact: true }))
    h.committed = null
    const originalCall = h.options.call
    h.options.call = async (...args) => {
      if (args[1].endsWith('.commandResult')) h.uid = changedUid
      return originalCall(...args)
    }
    await assert.rejects(h.client.send('api', 'transactions.deleteMany', data, { exact: true }), { code: 'LOGIN_REQUIRED' })
    assert.equal(h.calls.filter(call => call.action === 'transactions.deleteMany').length, 1)
    h.uid = '1234567890'
    assert.equal(h.client.pending().payload.requestId, 'original-key')
  }
})

test('确认交接先可靠保存恢复位置，再清原请求；失败保留已成功事实供下次核实', async () => {
  const h = harness()
  h.lost = false
  h.options.onConfirmed = (packet, result, scope) => {
    assert.equal(scope, h.uid)
    assert.equal(packet.payload.requestId, h.client.pending().payload.requestId)
    assert.equal(result.saved, true)
    throw Object.assign(new Error('合成交接失败'), { code: 'DRAFT_STORAGE_FAILED' })
  }
  await assert.rejects(h.client.send('api', 'transactions.create', { amountMinor: '100' }), failure => {
    assert.equal(failure.confirmedResult.result.saved, true)
    return failure.code === 'DRAFT_STORAGE_FAILED'
  })
  assert.ok(h.client.pending())
  h.options.onConfirmed = () => {}
  assert.equal((await h.client.verify()).recovered, true)
  assert.equal(h.client.pending(), null)
})

test('核实未知原请求时页面离开，不再自动补发原命令', async () => {
  const h = harness()
  await assert.rejects(h.client.send('api', 'transactions.create', { amountMinor: '100' }))
  h.committed = null
  let active = true
  const call = h.options.call
  h.options.call = (...args) => { if (args[1].endsWith('.commandResult')) active = false; return call(...args) }
  await assert.rejects(h.client.send('api', 'transactions.create', { amountMinor: '100' }, { exact: true, canSend: () => active }), { code: 'VIEW_INACTIVE' })
  assert.equal(h.calls.filter(call => call.action === 'transactions.create').length, 1)
  assert.ok(h.client.pending())
})

test('旧响应迟到不能再次交接已核实的结果，或覆盖后续操作的恢复位置', async () => {
  const h = harness(), handed = []
  let release
  const call = h.options.call
  h.lost = false
  h.options.requestId = () => 'request-' + h.calls.length
  h.options.onConfirmed = packet => handed.push(packet.payload.requestId)
  h.options.call = async (...args) => {
    const result = await call(...args)
    if (args[1] === 'transactions.create') await new Promise(resolve => { release = resolve })
    return result
  }
  const first = h.client.send('api', 'transactions.create', { amountMinor: '100' })
  await new Promise(resolve => setImmediate(resolve))
  await h.client.verify()
  await h.client.send('api', 'transactions.update', { amountMinor: '200' })
  const before = [...handed]
  release(); await first
  assert.deepEqual(handed, before)
  assert.equal(handed.length, 2)
})
