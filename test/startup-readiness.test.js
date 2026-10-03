const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')
const tick = () => new Promise(resolve => setImmediate(resolve))
const ok = data => ({ ok: true, data })
const due = (overrides = {}) => ok({ count: 0, cutoff: '2026-10-01', recheckAfterMs: 30000, ...overrides })

test('首页同作用域快照在费用查询返回前交付，正式 dashboard 等同步后只读一次', async () => {
  const h = runtime(), page = h.page('index'); page.onLoad()
  await h.api.callApi('dashboard.get', { month: page.data.month, summaryScope: 'all' })
  h.cache.invalidate(['transactions'])
  let release
  h.respond = action => action === 'loans.dueCharges' ? new Promise(resolve => { release = resolve }) : undefined
  h.calls.length = 0
  const work = page.loadDashboard()
  assert.equal(page.data.hasDashboard, true)
  assert.equal(page.data.dashboardFresh, false)
  assert.match(page.data.dashboardStatus, /上次结果/)
  await tick()
  assert.deepEqual(h.calls.map(call => call.action), ['loans.dueCharges'])
  release(due()); await work
  assert.deepEqual(h.calls.map(call => call.action), ['loans.dueCharges', 'dashboard.get'])
  assert.equal(page.data.dashboardFresh, true)
  assert.equal(page.data.dashboardStatus, '')
})

test('无快照与未确认身份不会借旧数据显示余额，关闭后的迟到数据不回填', async () => {
  const h = runtime(), page = h.page('index'); page.onLoad()
  let release
  h.respond = action => action === 'loans.dueCharges' ? new Promise(resolve => { release = resolve }) : undefined
  const work = page.loadDashboard(); await tick()
  assert.equal(page.data.hasDashboard, false)
  assert.equal(page.data.netWorthText, '—')
  assert.equal(h.calls.some(call => call.action === 'dashboard.get'), false)
  page.onHide(); release(due()); await work
  assert.equal(page.data.hasDashboard, false)
  h.app.approved = false
  await page.loadDashboard()
  assert.equal(h.api.displaySnapshot('dashboard.get', { month: page.data.month, summaryScope: 'all' }), null)
})

test('费用失败仍可展示已知账本但明确未完成，下一次重试不得复用失败', async () => {
  const h = runtime(), page = h.page('index'); page.onLoad()
  h.respond = action => action === 'loans.dueCharges' ? { ok: false, error: { code: 'VALIDATION_ERROR', message: '合成费用失败' } } : undefined
  await page.loadDashboard()
  assert.equal(page.data.hasDashboard, true)
  assert.equal(page.data.dashboardFresh, false)
  assert.match(page.data.chargeSyncMessage, /未完成/)
  assert.match(page.data.dashboardStatus, /不是最新余额/)
  h.respond = action => action === 'loans.dueCharges' ? due() : undefined
  await page.loadDashboard()
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2)
  assert.equal(page.data.dashboardFresh, true)
})

test('首页、明细和统计连续进入共用已完成检查，显式首页刷新仍重新检查', async () => {
  const h = runtime()
  h.respond = action => action === 'loans.dueCharges' ? due() : undefined
  const page = h.page('index'); page.onLoad(); await page.loadDashboard()
  await h.page('transactions').prepareAndLoad()
  h.page('statistics').onLoad(); await h.page('statistics').loadStatistics()
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 1)
  await page.loadDashboard({ force: true })
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2)
})

test('已完成检查最多复用30秒，业务日边界按服务端较短时长且手机回拨使其失效', async () => {
  const h = runtime(), sync = h.load('services/loan-charge-sync')
  h.now(100)
  h.respond = action => action === 'loans.dueCharges' ? due({ recheckAfterMs: 2000 }) : undefined
  await sync.run(); h.now(2099); assert.equal((await sync.run()).reused, true)
  h.now(2100); await sync.run()
  assert.equal(h.calls.length, 2)
  h.now(1000); await sync.run()
  assert.equal(h.calls.length, 3, '回拨时间不能延长复用窗口')
  h.respond = action => action === 'loans.dueCharges' ? due({ cutoff: '2026-10-02', recheckAfterMs: 1000000 }) : undefined
  h.now(4000); await sync.run(); h.now(34000); await sync.run()
  assert.equal(h.calls.length, 5, '服务端异常过长时长仍被本地上限限制')
})

test('旧服务端没有可复用时长时仍执行检查，不把一次成功永久缓存', async () => {
  const h = runtime(), sync = h.load('services/loan-charge-sync')
  h.respond = action => action === 'loans.dueCharges' ? ok({ count: 0, cutoff: '2026-10-01' }) : undefined
  await sync.run(); await sync.run()
  assert.equal(h.calls.length, 2)
})

test('贷款/分类相关写入使检查失效，写屏障期间不从完成缓存旁路', async () => {
  const h = runtime(), sync = h.load('services/loan-charge-sync')
  h.respond = action => action === 'loans.dueCharges' ? due() : undefined
  await sync.run()
  let release
  h.intercept = action => action === 'loans.update' ? new Promise(resolve => { release = resolve }) : undefined
  const saving = h.api.callApi('loans.update', { requestId: 'synthetic-loan-change' }); await tick()
  const checking = sync.run(); await tick()
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 1)
  release(); await saving; await checking
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2)
  await h.api.callApi('categories.archive', { requestId: 'synthetic-category-change' })
  await sync.run()
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 3)
})

test('后台统一校验中等待，跨设备 revision 更新后重新核对费用且不显示旧用户结果', async () => {
  const h = runtime(), sync = h.load('services/loan-charge-sync')
  let release
  h.respond = action => action === 'loans.dueCharges' ? due() : undefined
  await sync.run()
  h.intercept = action => action === 'reads.validate' ? new Promise(resolve => { release = resolve }) : undefined
  h.revision = '2'
  const validation = h.api.revalidateForeground(), checking = sync.run(); await tick()
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 1)
  release(); await validation; await checking
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2)
  h.cache.reset(); h.uid = h.app.globalData.uid = '1234567891'; h.intercept = null
  await sync.run()
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 3)
})

test('观察新版本即使没有本地写入或后台切换也使已完成检查失效', async () => {
  const h = runtime(), sync = h.load('services/loan-charge-sync')
  h.respond = action => action === 'loans.dueCharges' ? due() : undefined
  await sync.run(); h.revision = '2'
  await h.api.callApi('catalog.get', {}, { force: true }); await sync.run()
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2)
})

test('费用响应与协调器接收之间观察到新版本时，旧检查不能绑定新版本复用', async () => {
  const h = runtime(), callApi = h.api.callApi
  h.respond = action => action === 'loans.dueCharges' ? due() : undefined
  h.api.callApi = async function (action, data, options) {
    const result = await callApi(action, data, options)
    if (action === 'loans.dueCharges' && h.revision === '1') {
      h.revision = '2'
      await callApi('catalog.get', {}, { force: true })
    }
    return result
  }
  const sync = h.load('services/loan-charge-sync'), first = await sync.run()
  assert.equal(sync.isVerified(first), false)
  assert.notEqual((await sync.run()).reused, true)
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2)
})

test('费用范围读取等待分类恢复完成，不能在分类写事务前将缺项标成已完成', async () => {
  const h = runtime(), sync = h.load('services/loan-charge-sync')
  h.respond = action => action === 'loans.dueCharges' ? due() : undefined
  await sync.run()
  let release
  h.intercept = action => action === 'categories.restore' ? new Promise(resolve => { release = resolve }) : undefined
  const restoring = h.api.callApi('categories.restore', { requestId: 'synthetic-restore-category' })
  await tick()
  const checking = sync.run(); await tick()
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 1)
  release(); await restoring; await checking
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2)
})

test('导入草稿改变费用排除事实时等待写入并重查费用，账本和分类目录缓存保留', async () => {
  const actions = ['financeUpdates.prepare', 'financeUpdates.organize', 'financeUpdates.abandon', 'financeUpdates.setRepayment',
    'reviewIssues.resolve', 'reviewIssues.resolveAccountMappings', 'reviewIssues.refreshAccountGroups', 'reviewIssues.resolvePairings']
  for (const action of actions) {
    const h = runtime(), sync = h.load('services/loan-charge-sync')
    h.respond = next => next === 'loans.dueCharges' ? due() : next === 'loans.list' ? ok({ loans: [] }) : next === action ? ok({ saved: true }) : undefined
    const reads = [['dashboard.get', { month: '2026-10' }], ['catalog.get', {}], ['categories.list', {}]]
    for (const [read, data] of reads) await h.api.callApi(read, data)
    await h.api.callApi('loans.list', {})
    const tokens = reads.map(([read, data]) => h.api.cacheToken(read, data))
    await sync.run()
    let release
    h.intercept = next => next === action ? new Promise(resolve => { release = resolve }) : undefined
    const saving = h.importApi.callImport(action, { requestId: 'synthetic-draft-write' }); await tick()
    const checking = sync.run(); await tick()
    assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 1, action)
    assert.equal(h.api.cacheToken('loans.list', {}), null, action)
    reads.forEach(([read, data], index) => assert.equal(h.api.cacheToken(read, data), tokens[index], action + ' ' + read))
    release(); await saving; await checking
    assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2, action)
    reads.forEach(([read, data], index) => assert.equal(h.api.cacheToken(read, data), tokens[index], action + ' ' + read))
  }
})

test('导入核对只读不失效已完成费用检查，写入结果未知仍不能复用旧检查', async () => {
  const h = runtime(), sync = h.load('services/loan-charge-sync')
  h.respond = action => action === 'loans.dueCharges' ? due() : ok({ items: [] })
  await sync.run()
  for (const action of ['financeUpdates.summary', 'financeUpdates.list', 'financeUpdates.rows', 'reviewIssues.list', 'reviewIssues.pairings']) {
    await h.importApi.callImport(action, {})
    assert.equal((await sync.run()).reused, true, action)
  }
  h.respond = action => action === 'loans.dueCharges' ? due() : { ok: false, error: { code: 'INTERNAL_ERROR', message: '合成未确认响应' } }
  await assert.rejects(h.importApi.callImport('reviewIssues.resolvePairings', { requestId: 'synthetic-unconfirmed-draft' }))
  assert.notEqual((await sync.run()).reused, true)
  assert.equal(h.calls.filter(call => call.action === 'loans.dueCharges').length, 2)
})

test('费用核对后dashboard发现跨设备新版本，重核费用后才标最新且不重复完整摘要', async () => {
  const h=runtime(),page=h.page('index');page.onLoad()
  let dashboards=0
  h.respond=action=>action==='loans.dueCharges'?due():undefined
  h.intercept=action=>{if(action==='dashboard.get'&&++dashboards===1)h.revision='2'}
  await page.loadDashboard()
  assert.equal(h.calls.filter(call=>call.action==='loans.dueCharges').length,2)
  assert.equal(h.calls.filter(call=>call.action==='dashboard.get').length,1)
  assert.equal(page.data.dashboardFresh,true)
})

test('费用核对期间连续外部变化有界停止，不能以第二个过期检查标最新', async () => {
  const h=runtime(),page=h.page('index');page.onLoad()
  let checks=0
  h.respond=action=>action==='loans.dueCharges'?due():undefined
  h.intercept=action=>{
    if(action==='loans.dueCharges'&&++checks===2)h.revision='3'
    if(action==='dashboard.get')h.revision=String(Number(h.revision)+1)
  }
  await page.loadDashboard()
  assert.equal(h.calls.filter(call=>call.action==='dashboard.get').length,2)
  assert.equal(h.calls.filter(call=>call.action==='loans.dueCharges').length,2)
  assert.equal(page.data.hasDashboard,true);assert.equal(page.data.dashboardFresh,false)
  assert.equal(page.data.chargeSyncComplete,false);assert.match(page.data.chargeSyncMessage,/再次变化/)
})

test('首份快照和最新结果的时间只在 setData 回调记录，日志不收集余额或用户', async () => {
  const h = runtime(), observer = h.load('services/read-observer'), page = h.page('index')
  const callbacks = [], setData = page.setData
  page.setData = function (patch, callback) { setData.call(this, patch); if (callback) callbacks.push(callback) }
  observer.enable(true); page.onLoad()
  h.respond = action => action === 'loans.dueCharges' ? due() : undefined
  await page.loadDashboard()
  assert.equal(observer.snapshot().some(row => row.phase === 'home_latest'), false)
  callbacks.splice(0).forEach(callback => callback.call(page))
  assert.equal(observer.snapshot().some(row => row.phase === 'home_latest'), true)
  assert.equal(JSON.stringify(observer.snapshot()).includes(h.uid), false)
  assert.equal(JSON.stringify(observer.snapshot()).includes('amountMinor'), false)
})

test('离页、换用户或后续读取开始后，迟到 setData 回调不能报告旧首页已可用', async () => {
  for (const next of ['hide', 'account', 'reload']) {
    const h = runtime(), observer = h.load('services/read-observer'), page = h.page('index')
    const callbacks = [], setData = page.setData
    page.setData = function (patch, callback) { setData.call(this, patch); if (callback) callbacks.push(callback) }
    observer.enable(true); page.onLoad()
    h.respond = action => action === 'loans.dueCharges' ? due() : undefined
    await page.loadDashboard()
    const oldCallbacks = callbacks.splice(0)
    if (next === 'hide') page.onHide()
    if (next === 'account') { h.cache.reset(); h.uid = h.app.globalData.uid = '1234567891' }
    if (next === 'reload') await page.loadDashboard({ force: true })
    oldCallbacks.forEach(callback => callback.call(page))
    assert.equal(observer.snapshot().some(row => row.phase === 'home_latest'), false, next)
    if (next === 'reload') {
      callbacks.splice(0).forEach(callback => callback.call(page))
      assert.equal(observer.snapshot().filter(row => row.phase === 'home_latest').length, 1)
    }
  }
})
