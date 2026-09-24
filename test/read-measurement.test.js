// 复用真实客户端、observer 和页面替身；只报告计数，不采集账单值。
const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')
const { mutationTags, READ_POLICIES } = require('../miniprogram/services/read-policy')
const { stableKey } = require('../miniprogram/services/read-cache')
const tick = () => new Promise(resolve => setImmediate(resolve))

test('MINI-1915 缓存冷/热/并发/前台/写屏障/失败/换用户计数', async t => {
  const h = runtime(), observer = h.load('services/read-observer'), home = h.page('index')
  const viewModel = h.load('utils/money')
  let derives = 0
  for (const [key, fn] of Object.entries(viewModel)) if (typeof fn === 'function') viewModel[key] = (...args) => { derives++; return fn(...args) }
  observer.attach(home)
  const key = stableKey('dashboard.get', { month: h.load('utils/time').currentMonth() })
  const state = () => {
    const snapshot = h.cache.snapshot(key)
    return { token: h.cache.token(key), fresh: snapshot ? snapshot.fresh : false, revision: snapshot ? snapshot.value.dataRevision : null }
  }
  async function sample(name, operation, requests) {
    observer.enable(true)
    const count = h.calls.length, derived = derives, before = state()
    await operation()
    const events = observer.snapshot()
    const result = { name, requests: h.calls.length - count, responseBytes: events.filter(e => e.event === 'request').reduce((n, e) => n + (e.bytes || 0), 0),
      setData: events.filter(e => e.event === 'setData').length, setDataBytes: events.filter(e => e.event === 'setData').reduce((n, e) => n + e.bytes, 0),
      derives: derives - derived, snapshots: events.filter(e => e.event === 'snapshot').length, callbacks: events.filter(e => e.event === 'fresh').length, before, after: state() }
    assert.equal(result.requests, requests, name)
    t.diagnostic(JSON.stringify(result))
  }
  await sample('cold-home', () => home.loadDashboard(), 1)
  await sample('hot-home', () => home.loadDashboard(), 0)
  await sample('tab-return', async () => { await h.api.callApi('accounts.list'); await home.loadDashboard() }, 0)
  await sample('same-key-concurrent', async () => {
    let release
    h.intercept = action => action === 'statistics.get' ? new Promise(resolve => { release = resolve }) : undefined
    const a = h.api.callApi('statistics.get'), b = h.api.callApi('statistics.get')
    await tick(); release(); await Promise.all([a, b]); h.intercept = null
  }, 1)
  await sample('foreground-unchanged', async () => { await Promise.all([h.api.revalidateForeground(), h.api.revalidateForeground()]); await home.loadDashboard() }, 1)
  t.diagnostic(JSON.stringify({ mutation: 'transactions.create', affectedTags: mutationTags('transactions.create') }))
  await sample('write-return', async () => {
    await h.api.callApi('transactions.create', { requestId: 'synthetic-write' })
    assert.equal(h.cache.token(key), null)
    await home.loadDashboard()
  }, 2)
  await sample('failed-write-return', async () => {
    h.respond = action => action === 'transactions.create' ? { ok: false, error: { code: 'CONFLICT', message: '合成拒绝' } } : undefined
    await assert.rejects(h.api.callApi('transactions.create', { requestId: 'synthetic-failed' }), { code: 'CONFLICT' })
    assert.equal(h.cache.token(key), null)
    h.respond = null; await home.loadDashboard()
  }, 2)
  await sample('timeout-same-request', async () => {
    const requestId = 'synthetic-original-request'
    h.intercept = action => { if (action === 'transactions.create') throw { errMsg: 'request:fail timeout' } }
    await assert.rejects(h.api.callApi('transactions.create', { requestId }))
    h.intercept = null
    await h.api.callApi('transactions.create', { requestId })
    assert.ok(h.calls.filter(c => c.data.requestId === requestId).every(c => c.data.requestId === requestId))
    await home.loadDashboard()
  }, 3)
  await sample('late-read-after-write', async () => {
    let release, attempts = 0
    h.respond = action => {
      if (action === 'statistics.get' && ++attempts === 1) return new Promise(resolve => { release = () => resolve({ ok: true, data: { readVersion: 1, uid: h.uid, dataRevision: '1', unchanged: false, summary: {}, cashFlowTrend: [] } }) })
    }
    const old = h.api.callApi('statistics.get', {}, { force: true })
    await tick(); await h.api.callApi('transactions.create', { requestId: 'synthetic-late-write' })
    release(); const result = await old
    assert.equal(result.dataRevision, h.revision); assert.equal(attempts, 2); h.respond = null
  }, 3)
  await sample('user-change-rejects-old-read', async () => {
    let release
    h.intercept = action => action === 'statistics.get' ? new Promise(resolve => { release = resolve }) : undefined
    const old = h.api.callApi('statistics.get', {}, { force: true })
    await tick(); h.cache.reset(); h.uid = '2234567890'; h.app.globalData.uid = h.uid
    release(); await assert.rejects(old, { code: 'SESSION_CHANGED' }); h.intercept = null
    await home.loadDashboard()
  }, 2)
  const cache = h.cache
  cache.bindScope('synthetic-other-environment', h.uid)
  assert.equal(cache.snapshot(key), null)
  assert.ok(READ_POLICIES['dashboard.get'].tags.length)
  await cache.settleStorage()
  observer.enable(false)
})

test('MINI-1915 冷启动持久快照的展示、刷新成功和失败计数', async t => {
  const seed = runtime()
  await seed.page('index').loadDashboard()
  await seed.cache.settleStorage()
  for (const succeeds of [true, false]) {
    const h = runtime(new Map(seed.storage)), home = h.page('index'), observer = h.load('services/read-observer')
    const money = h.load('utils/money')
    let derives = 0, release
    for (const [name, fn] of Object.entries(money)) if (typeof fn === 'function') money[name] = (...args) => { derives++; return fn(...args) }
    h.intercept = action => action === 'dashboard.get' ? new Promise(resolve => { release = resolve }) : undefined
    if (!succeeds) h.respond = action => action === 'dashboard.get' ? { ok: false, error: { code: 'CONFLICT', message: '合成拒绝' } } : undefined
    observer.attach(home); observer.enable(true)
    const key = stableKey('dashboard.get', { month: h.load('utils/time').currentMonth() })
    const metrics = () => {
      const events = observer.snapshot()
      return { requests: h.calls.length, responseBytes: events.filter(e => e.event === 'request').reduce((sum, e) => sum + (e.bytes || 0), 0),
        setData: events.filter(e => e.event === 'setData').length, setDataBytes: events.filter(e => e.event === 'setData').reduce((sum, e) => sum + e.bytes, 0),
        derives, snapshots: events.filter(e => e.event === 'snapshot').length, callbacks: events.filter(e => e.event === 'fresh').length,
        fresh: h.cache.snapshot(key).fresh, hasDashboard: home.data.hasDashboard, loading: home.data.loading, error: Boolean(home.data.errorMessage) }
    }
    const loading = home.loadDashboard()
    await tick()
    const beforeResponse = metrics()
    assert.equal(beforeResponse.requests, 1)
    assert.equal(beforeResponse.hasDashboard, true, '新页面在网络返回前展示持久快照')
    assert.equal(beforeResponse.loading, true)
    assert.equal(beforeResponse.error, false)
    assert.equal(beforeResponse.fresh, false, '展示快照不能冒充已确认的新鲜读取')
    assert.equal(beforeResponse.snapshots, 1)
    assert.equal(observer.snapshot().find(e => e.event === 'snapshot').source, 'storage')
    release(); await loading
    const afterResponse = metrics()
    assert.equal(afterResponse.requests, 1)
    assert.equal(afterResponse.hasDashboard, true)
    assert.equal(afterResponse.loading, false)
    assert.equal(afterResponse.error, !succeeds)
    assert.equal(afterResponse.fresh, succeeds)
    assert.equal(afterResponse.callbacks, succeeds ? 1 : 0)
    t.diagnostic(JSON.stringify({ name: succeeds ? 'storage-snapshot-refresh' : 'storage-snapshot-failed-refresh', beforeResponse, afterResponse }))
    await h.cache.settleStorage()
    observer.enable(false)
  }
})
