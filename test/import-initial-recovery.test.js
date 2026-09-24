const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')

const clone = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const setup = options => runtime(fixture(81), { realDraftManager: true, ...options })
const nextView = (h, version = 2) => ({ ...clone(h.summary), viewVersion: 'v' + version,
  update: { ...h.summary.update, version } })
const postedView = h => ({ ...nextView(h, 3), update: { ...h.summary.update, version: 3, status: 'posted' },
  posting: { createdTransactionCount: h.events.length } })

async function initialRestore() {
  const h = setup({ approved: false, initialView: false,
    pageOptions: { updateId: 'synthetic-update', evidenceEventId: 'synthetic-event-0' } })
  h.page.onShow(); await flush(); h.app.approved = true
  const summary = deferred()
  h.intercept = action => action === 'financeUpdates.summary' ? summary.promise : undefined
  const pending = h.loginOptions.afterLogin()
  await flush()
  return { h, page: h.page, summary, pending }
}

test('首次恢复中放弃成功，隐藏返回及迟到登录不再读取旧批次', async () => {
  const { h, page, summary, pending } = await initialRestore()
  const abandoning = page.abandonRestoringUpdate()
  await flush()
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.abandon').length, 0)
  h.intercept = action => {
    if (action === 'financeUpdates.abandon') { h.summary = { ...nextView(h), update: { ...h.summary.update, status: 'abandoned' } }; return h.summary }
  }
  summary.resolve(h.summary)
  await Promise.all([pending, abandoning])
  assert.equal(page.data.phase, 'idle')
  const count = h.calls.length
  page.onHide(); await page.onShow(); await h.loginOptions.afterLogin()
  assert.equal(h.calls.length, count)
  assert.equal(page.data.phase, 'idle')
  assert.equal(page.data.update, null)
  assert.equal(page.data.evidenceSheet, null)
  page.onUnload()
})

test('重新开始后旧初次摘要和登录回调迟到，不恢复旧批次或旧原文', async () => {
  const { h, page, summary, pending } = await initialRestore()
  page.startAnother()
  const count = h.calls.length, patches = h.patches.length
  summary.resolve(h.summary); await pending
  await h.loginOptions.afterLogin()
  assert.equal(h.patches.length, patches)
  page.onHide(); await page.onShow()
  assert.equal(h.calls.length, count)
  assert.equal(page.data.phase, 'idle')
  assert.equal(page.data.evidenceSheet, null)
  page.onUnload()
})

test('放弃成功后更早一轮恢复摘要才返回，不恢复旧批次或原文', async () => {
  const { h, page, summary, pending } = await initialRestore()
  const oldView = clone(h.summary), current = deferred()
  page.onHide()
  h.intercept = action => action === 'financeUpdates.summary' ? current.promise : undefined
  const returning = page.onShow(); await flush()
  const abandoning = page.abandonRestoringUpdate(); await flush()
  h.intercept = action => {
    if (action === 'financeUpdates.abandon') { h.summary = { ...h.summary, update: { ...h.summary.update, status: 'abandoned' } }; return h.summary }
  }
  current.resolve(h.summary); await Promise.all([returning, abandoning])
  assert.equal(page.data.phase, 'idle')
  const calls = h.calls.length, before = clone(page.data)
  summary.resolve(oldView); await pending; await h.loginOptions.afterLogin()
  assert.equal(h.calls.length, calls)
  assert.deepEqual(clone(page.data), before)
  page.onUnload()
})

test('放弃失败保留批次恢复信息，再试沿同一放弃请求号', async () => {
  const { h, page, summary, pending } = await initialRestore()
  const abandoning = page.abandonRestoringUpdate()
  await flush()
  h.intercept = action => {
    if (action === 'financeUpdates.abandon') throw Object.assign(new Error('合成网络未确认'), { code: 'CLOUD_CALL_FAILED' })
  }
  summary.resolve(h.summary); await Promise.all([pending, abandoning])
  assert.notEqual(page.data.phase, 'idle')
  assert.equal(page.data.restoreUpdateId, 'synthetic-update')
  assert.equal(page.data.abandoningRestore, false)
  assert.match(page.data.errorMessage, /合成网络未确认|已保留/)
  const first = h.calls.find(call => call.action === 'financeUpdates.abandon').input
  h.intercept = action => action === 'financeUpdates.abandon' ? { ...h.summary, update: { ...h.summary.update, status: 'abandoned' } } : undefined
  await page.abandonRestoringUpdate()
  assert.deepEqual(h.calls.filter(call => call.action === 'financeUpdates.abandon').map(call => call.input), [first, first])
  assert.equal(page.data.phase, 'idle')
  page.onUnload()
})

test('普通隐藏返回保留初次恢复，旧摘要不能盖过本轮恢复', async () => {
  const { h, page, summary, pending } = await initialRestore()
  page.onHide()
  h.intercept = action => action === 'financeUpdates.organize' ? h.summary : undefined
  await page.onShow()
  const before = clone(page.data), calls = h.calls.length
  summary.resolve(h.summary); await pending
  assert.deepEqual(clone(page.data), before)
  assert.equal(h.calls.length, calls)
  assert.equal(page.data.phase, 'review')
  assert.ok(page.data.evidenceSheet)
  page.onUnload()
})

test('重新开始只终止页面恢复，不删除未确认 postFlight', async () => {
  const h = setup(), page = h.page, session = page._draftSession, receipt = deferred()
  h.intercept = action => action === 'financeUpdates.post' ? receipt.promise : undefined
  const pending = page.postUpdate(); await flush()
  const original = clone(session.state.postFlight.payload)
  page.startAnother()
  const patches = h.patches.length
  receipt.resolve(postedView(h)); await pending
  assert.equal(h.patches.length, patches)
  assert.ok([...h.storage.values()].some(value => value && value.postFlight && value.postFlight.payload.requestId === original.requestId))
  assert.equal(page.data.phase, 'idle')
  page.onUnload()
})

