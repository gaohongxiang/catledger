const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')
const { fixture, flush } = require('./helpers/paged-workbench')

const clone = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const error = code => ({ ok: false, error: { code, message: '合成服务拒绝' } })
async function until(check) {
  const end = Date.now() + 5000
  while (!check()) { if (Date.now() > end) throw new Error('合成页面等待超时'); await flush() }
}

function setup(storage) {
  const h = runtime(storage), view = fixture(2).summary
  let receipt = null
  h.view = view
  h.respond = async (action, data) => {
    if (action === 'financeUpdates.prepare') {
      receipt = { kind: 'operation-receipt', action, update: clone(view.update) }
      return { ok: true, data: receipt }
    }
    if (action === 'imports.commandResult') return receipt ? { ok: true, data: receipt } : error('OPERATION_UNCONFIRMED')
    if (action === 'financeUpdates.summary') return { ok: true, data: view }
    if (action === 'financeUpdates.organize') return { ok: true, data: { action, update: clone(view.update) } }
    throw new Error('Unexpected action: ' + action)
  }
  h.page = h.page('import-workbench')
  h.page.onLoad({ fresh: '1' })
  h.page.setData({ phase: 'files_ready', files: [{ state: 'ready', batchId: 'synthetic-batch' }], uploadSummary: { total: 1, ready: 1 } })
  return h
}

test('首次整理响应丢失，真实 Page 在发出前保留冻结载荷，重试只核实原回执', async () => {
  const h = setup(), page = h.page, respond = h.respond
  let frozen
  h.respond = async (action, data) => {
    const response = await respond(action, data)
    if (action === 'financeUpdates.prepare') {
      frozen = clone(h.load('services/pending-ledger-write').pending())
      throw new Error('合成响应丢失')
    }
    return response
  }
  await page.createFinanceUpdate()
  assert.ok(frozen, '发送之前必须保存原请求')
  assert.deepEqual(frozen.payload, clone(h.calls.find(call => call.action === 'financeUpdates.prepare').data))
  page.data.files = [{ state: 'ready', batchId: 'synthetic-new-selection' }]
  h.respond = respond
  await page.createFinanceUpdate()
  assert.equal(page.data.update.updateId, h.view.update.updateId)
  assert.equal(page.data.phase, 'review')
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.prepare').length, 1)
  assert.equal(h.calls.find(call => call.action === 'imports.commandResult').data.requestId, frozen.payload.requestId)
  assert.equal(h.load('services/pending-ledger-write').pending(), null)
  page.onUnload()
})

test('整理已成功而摘要读取失败，页面保留成功和刷新入口，不再次 prepare', async () => {
  const h = setup(), page = h.page, respond = h.respond
  h.respond = (action, data) => action === 'financeUpdates.summary' ? Promise.reject(new Error('合成读取失败')) : respond(action, data)
  await page.createFinanceUpdate()
  assert.equal(page.data.update && page.data.update.updateId, h.view.update.updateId)
  assert.equal(page.data.errorMessage, '整理已完成，结果待刷新')
  assert.equal(page.data.refreshRequired, true)
  assert.equal(h.load('services/pending-ledger-write').pending(), null)
  await page.createFinanceUpdate()
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.prepare').length, 1)
  page.onUnload()
})

test('首次整理在隐藏后完成，只保留恢复指针，迟到回执不继续读取或回填', async () => {
  const h = setup(), page = h.page, respond = h.respond, response = deferred()
  h.respond = async (action, data) => {
    const result = await respond(action, data)
    if (action === 'financeUpdates.prepare') await response.promise
    return result
  }
  const preparing = page.createFinanceUpdate()
  await flush(); page.onHide()
  const before = clone(page.data)
  response.resolve(); await preparing
  assert.deepEqual(clone(page.data), before)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.summary'), false)
  assert.equal(h.load('services/import-draft-session').lastUpdateId(), h.view.update.updateId)
  h.respond = respond
  await page.onShow()
  assert.equal(page.data.update.updateId, h.view.update.updateId)
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.prepare').length, 1)
  page.onUnload()
})

test('首次整理提交后重启，无本机文件也从同一请求恢复到原批次', async () => {
  const first = setup(), respond = first.respond
  first.respond = async (action, data) => {
    const result = await respond(action, data)
    if (action === 'financeUpdates.prepare') throw new Error('合成响应丢失')
    return result
  }
  await first.page.createFinanceUpdate()
  const original = clone(first.load('services/pending-ledger-write').pending())
  first.page.onUnload()
  const next = runtime(first.storage)
  next.respond = respond
  const page = next.page('import-workbench')
  page.onLoad({})
  await until(() => page.data.phase === 'review')
  assert.equal(page.data.update.updateId, first.view.update.updateId)
  assert.equal(next.calls.some(call => call.action === 'financeUpdates.prepare'), false)
  assert.equal(next.calls[0].action, 'imports.commandResult')
  assert.equal(next.calls[0].data.requestId, original.payload.requestId)
  assert.equal(next.load('services/pending-ledger-write').pending(), null)
  page.onUnload()
})

test('首次整理未送达，重启只查回执；明确继续后按原请求和载荷重放', async () => {
  const first = setup()
  first.respond = () => Promise.reject(new Error('合成请求未送达'))
  await first.page.createFinanceUpdate()
  const original = clone(first.load('services/pending-ledger-write').pending())
  first.page.onUnload()
  const next = runtime(first.storage), respond = setup().respond
  next.respond = respond
  const page = next.page('import-workbench')
  page.onLoad({})
  await until(() => page.data.preparePending && !page.data.busy)
  assert.deepEqual(next.calls.map(call => call.action), ['imports.commandResult'])
  assert.equal(page.data.files.length, 0)
  await page.createFinanceUpdate()
  const replay = next.calls.find(call => call.action === 'financeUpdates.prepare')
  assert.deepEqual(clone(replay.data), original.payload)
  assert.equal(page.data.phase, 'review')
  page.onUnload()
})

test('写入存储失败或没有真正落盘，首次整理不发送命令', async () => {
  for (const write of [() => { throw new Error('合成空间不足') }, () => {}]) {
    const h = setup()
    h.wx.setStorageSync = write
    await h.page.createFinanceUpdate()
    assert.equal(h.calls.length, 0)
    assert.match(h.page.data.errorMessage, /本机未能保存请求/)
    h.page.onUnload()
  }
})

test('回执成功后本机恢复指针保存失败，页面仍确认整理完成并保留原请求', async () => {
  const h = setup(), write = h.wx.setStorageSync
  h.wx.setStorageSync = (key, value) => {
    if (key.endsWith(':last')) throw new Error('合成指针存储失败')
    write(key, value)
  }
  await h.page.createFinanceUpdate()
  assert.equal(h.page.data.update.updateId, h.view.update.updateId)
  assert.equal(h.page.data.errorMessage, '整理已完成，结果待刷新')
  assert.ok(h.load('services/pending-ledger-write').pending())
  h.wx.setStorageSync = write
  await h.load('services/pending-ledger-write').verify()
  assert.equal(h.load('services/pending-ledger-write').pending(), null)
  assert.equal(h.load('services/import-draft-session').lastUpdateId(), h.view.update.updateId)
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.prepare').length, 1)
  h.page.onUnload()
})

for (const leave of ['unload', 'logout', 'switch']) test('首次整理期间' + leave + '，迟到结果不回填；原用户请求仍可恢复', async () => {
  const h = setup(), page = h.page, respond = h.respond, response = deferred()
  h.respond = async (action, data) => {
    const result = await respond(action, data)
    if (action === 'financeUpdates.prepare') await response.promise
    return result
  }
  const preparing = page.createFinanceUpdate()
  await flush()
  const original = clone(h.load('services/pending-ledger-write').pending())
  if (leave === 'unload') page.onUnload()
  else {
    h.cache.reset()
    if (leave === 'logout') { h.app.approved = false; h.app.globalData.uid = '' }
    else h.app.globalData.uid = '1234567891'
    page.onShow()
  }
  const before = clone(page.data)
  response.resolve(); await preparing
  assert.deepEqual(clone(page.data), before)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.summary'), false)
  if (leave !== 'unload') {
    assert.equal(h.load('services/import-draft-session').lastUpdateId(), '')
    h.app.approved = true; h.app.globalData.uid = '1234567890'; h.cache.reset()
    assert.equal(h.load('services/pending-ledger-write').pending().payload.requestId, original.payload.requestId)
    h.respond = respond
    await page.onShow()
    assert.equal(page.data.update.updateId, h.view.update.updateId)
    page.onUnload()
  }
})

test('核实首次整理期间隐藏，未发现回执也不再发出 prepare；返回可继续原请求', async () => {
  const h = setup(), page = h.page
  h.respond = () => Promise.reject(new Error('合成未送达'))
  await page.createFinanceUpdate()
  const original = clone(h.load('services/pending-ledger-write').pending()), verify = deferred()
  h.respond = action => action === 'imports.commandResult' ? verify.promise : Promise.reject(new Error('不应发送'))
  const retry = page.createFinanceUpdate()
  await flush(); page.onHide()
  verify.resolve(error('OPERATION_UNCONFIRMED'))
  await retry
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.prepare').length, 1)
  assert.deepEqual(clone(h.load('services/pending-ledger-write').pending()), original)
  page.onUnload()
})

test('明确重新开始后原整理迟到，只记录原结果；同页返回不重新恢复旧批次', async () => {
  const h = setup(), page = h.page, respond = h.respond, response = deferred()
  h.respond = async (action, data) => {
    const result = await respond(action, data)
    if (action === 'financeUpdates.prepare') await response.promise
    return result
  }
  const preparing = page.createFinanceUpdate()
  await flush(); page.startAnother()
  const before = clone(page.data)
  response.resolve(); await preparing
  assert.deepEqual(clone(page.data), before)
  page.onHide(); await page.onShow()
  assert.equal(page.data.update, null)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.summary'), false)
  page.onUnload()
})

test('首次整理遇自动网络重试前切用户，重试不能把原请求发送到新用户身份', async () => {
  const h = setup(), page = h.page
  h.respond = () => Promise.reject(new Error('request:fail timeout'))
  const preparing = page.createFinanceUpdate()
  await until(() => h.calls.length === 1)
  const original = clone(h.load('services/pending-ledger-write').pending())
  h.app.globalData.uid = '1234567891'; h.cache.reset()
  await page.onShow()
  await preparing
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.prepare').length, 1)
  assert.equal(page.data.update, null)
  h.app.globalData.uid = '1234567890'
  assert.equal(h.load('services/pending-ledger-write').pending().payload.requestId, original.payload.requestId)
  page.onUnload()
})
