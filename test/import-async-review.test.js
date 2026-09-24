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
const posts = h => h.calls.filter(call => call.action === 'financeUpdates.post')

for (const ready of [true, false]) test('真实草稿 flush 返回新版本，入账条件' + (ready ? '仍满足只 post 一次' : '失效时提示继续核对'), async () => {
  const h = setup(), page = h.page
  h.summary = nextView(h)
  h.summary.coverage.selectedEventsReadyToPost = ready
  h.intercept = action => {
    if (action === 'financeUpdates.post') { h.summary = postedView(h); return h.summary }
  }
  await page.postUpdate()
  assert.equal(posts(h).length, ready ? 1 : 0)
  assert.equal(page.data.busy, false)
  if (ready) {
    assert.equal(posts(h)[0].input.version, 2)
    assert.equal(page.data.phase, 'done')
  } else {
    assert.match(page.data.errorMessage, /继续核对|剩余核对/)
    assert.equal(page.data.phase, 'review')
  }
  page.onUnload()
})

for (const leave of ['onHide', 'onUnload', 'session', 'batch']) test('flush 等待期间 ' + leave + ' 后不发送旧 post 或回填', async () => {
  const h = setup(), page = h.page, summary = deferred()
  h.intercept = action => action === 'financeUpdates.summary' ? summary.promise : undefined
  const pending = page.postUpdate()
  await flush()
  if (leave === 'session') h.cache.reset()
  else if (leave === 'batch') { page.startAnother(); page.applyUpdateView({ ...nextView(h), update: { ...h.summary.update, updateId: 'synthetic-other' } }) }
  else page[leave]()
  const patches = h.patches.length
  summary.resolve(nextView(h)); await pending
  assert.equal(posts(h).length, 0)
  assert.equal(h.patches.length, patches)
  page.onUnload()
})

for (const leave of ['onHide', 'onUnload', 'session', 'batch']) test('post 已发送后 ' + leave + ' 保留落盘请求，旧回执不覆盖新状态', async () => {
  const h = setup(), page = h.page, session = page._draftSession, receipt = deferred()
  h.intercept = action => action === 'financeUpdates.post' ? receipt.promise : undefined
  const pending = page.postUpdate()
  await flush()
  assert.equal(posts(h).length, 1)
  const original = clone(session.state.postFlight.payload)
  if (leave === 'session') h.cache.reset()
  else if (leave === 'batch') { page.startAnother(); page.applyUpdateView({ ...nextView(h), update: { ...h.summary.update, updateId: 'synthetic-other' } }) }
  else page[leave]()
  page.setData({ busy: true, errorMessage: '合成新操作状态' })
  const patches = h.patches.length
  receipt.resolve(postedView(h)); await pending
  assert.equal(h.patches.length, patches)
  assert.deepEqual(clone(session.state.postFlight.payload), original)
  assert.ok([...h.storage.values()].some(value => value && value.postFlight && value.postFlight.payload.requestId === original.requestId))
  if (leave === 'onHide' || leave === 'onUnload') {
    h.intercept = action => action === 'financeUpdates.post' ? postedView(h) : undefined
    await session.post()
    assert.deepEqual(posts(h).map(call => call.input), [original, original])
  }
  page.onUnload()
})

test('第 4 步刷新成功正常结束加载', async () => {
  const h = setup(), page = h.page
  h.summary = nextView(h)
  await page.retryPagedView()
  assert.equal(page.data.pageLoading, false)
  assert.equal(page.data.update.version, 2)
  page.onUnload()
})

test('第 4 步刷新失败显示错误且可再次重试', async () => {
  const h = setup(), page = h.page
  h.intercept = action => { if (action === 'financeUpdates.summary') throw new Error('合成摘要失败') }
  await page.retryPagedView()
  assert.equal(page.data.pageLoading, false)
  assert.match(page.data.pageError, /合成摘要失败/)
  h.intercept = null; h.summary = nextView(h, 3)
  await page.retryPagedView()
  assert.equal(page.data.pageLoading, false)
  assert.equal(page.data.pageError, '')
  assert.equal(page.data.update.version, 3)
  page.onUnload()
})

for (const newerFails of [false, true]) for (const olderFails of [false, true]) {
  test('旧刷新' + (olderFails ? '失败' : '成功') + '晚于新刷新' + (newerFails ? '失败' : '成功') + '不覆盖新状态', async () => {
    const h = setup(), page = h.page, older = deferred(), newer = deferred()
    h.intercept = action => action === 'financeUpdates.summary' ? older.promise : undefined
    const first = page.retryPagedView(); await flush()
    h.intercept = action => action === 'financeUpdates.summary' ? newer.promise : undefined
    const second = page.retryPagedView(); await flush()
    if (newerFails) newer.reject(new Error('合成新刷新失败'))
    else newer.resolve(nextView(h, 3))
    await second
    assert.equal(page.data.pageLoading, false)
    const expected = clone(page.data)
    if (olderFails) older.reject(new Error('合成旧刷新失败'))
    else older.resolve(nextView(h, 2))
    await first
    assert.deepEqual(clone(page.data), expected)
    page.onUnload()
  })
}

test('旧刷新结束时新刷新仍等待，不提前清除加载状态', async () => {
  const h = setup(), page = h.page, older = deferred(), newer = deferred()
  h.intercept = action => action === 'financeUpdates.summary' ? older.promise : undefined
  const first = page.retryPagedView(); await flush()
  h.intercept = action => action === 'financeUpdates.summary' ? newer.promise : undefined
  const second = page.retryPagedView(); await flush()
  older.reject(new Error('合成旧刷新失败')); await first
  assert.equal(page.data.pageLoading, true)
  assert.equal(page.data.pageError, '')
  newer.resolve(nextView(h, 3)); await second
  assert.equal(page.data.pageLoading, false)
  page.onUnload()
})

for (const step of [2, 3]) for (const changed of [false, true]) test('第 ' + step + ' 步刷新' + (changed ? '新' : '同') + '版本只有一次分页启动且不漏读', async () => {
  const h = setup(), page = h.page
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: step })
  if (changed) h.summary = nextView(h)
  let starts = 0
  const load = page.loadActivePage
  page.loadActivePage = function (...args) { starts++; return load.apply(this, args) }
  await page.retryPagedView()
  assert.equal(starts, 1)
  assert.equal(page.data.pageLoading, false)
  assert.equal(page.data.pageError, '')
  if (step === 3) {
    assert.equal(page.data.reviewedEvents.length, 40)
    await page.changeReviewPage({ currentTarget: { dataset: { direction: 1 } } })
    assert.equal(page.data.reviewPage.index, 1)
    assert.equal(page.data.reviewedEvents[0].eventId, 'synthetic-event-40')
  } else assert.equal(page.data.accounts[0].accountId, 'synthetic-account')
  page.onUnload()
})

for (const leave of ['onHide', 'onUnload', 'step']) test('摘要刷新等待期间 ' + leave + ' 后旧结果不回填或清新加载态', async () => {
  const h = setup(), page = h.page, summary = deferred(), list = deferred()
  h.intercept = action => action === 'financeUpdates.summary' ? summary.promise : undefined
  const pending = page.retryPagedView(); await flush()
  let next
  if (leave === 'step') {
    page.data.activeReviewStatus = 'completed'
    h.intercept = action => action === 'economicEvents.list' ? list.promise : undefined
    next = page.setStep({ currentStep: 3 }); await flush()
  } else page[leave]()
  const before = clone(page.data)
  summary.resolve(nextView(h)); await pending
  assert.deepEqual(clone(page.data), before)
  if (next) {
    list.resolve({ protocolVersion: 2, viewVersion: 'v1', items: h.events.slice(0, 40), total: 81, nextCursor: '40' })
    await next
    assert.equal(page.data.pageLoading, false)
    assert.equal(page.data.reviewedEvents.length, 40)
  }
  page.onUnload()
})
