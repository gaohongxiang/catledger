const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createReadCache, stableKey } = require('../miniprogram/services/read-cache')
const root = path.join(__dirname, '..', 'miniprogram')
const flush = () => new Promise(resolve => setImmediate(resolve))
function runtime() {
  let now = 0, balance = '10000'
  const cache = Object.assign(createReadCache({ now: () => now }), { stableKey })
  const modules = new Map(), calls = [], pages = new Map()
  const app = { globalData: { cloudAvailable: true, categories: [], profile: {} }, approved: true,
    hasLoginApproval() { return this.approved } }
  const categories = [{ id: 'category-a', kind: 'expense', name: '合成分类' }]
  const accounts = () => [{ accountId: 'account-a', name: '合成账户', type: 'bank', nature: 'asset', archived: false, displayBalanceMinor: balance, bookBalanceMinor: balance }]
  const summary = { incomeMinor: '0', expenseMinor: '100', netIncomeMinor: '-100' }
  const transaction = id => ({ transactionId: id, type: 'expense', amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', sourceAccount: accounts()[0] })
  const h = { app, calls, cache, now(value) { now = value }, intercept: null,
    categories, accounts: null, navigation: [], modals: [], uid: '1234567890', clipboard: [], toasts: [], clipboardFails: false }
  const wx = { nextTick: cb => cb(), showModal(options) { h.modals.push(options) }, showToast(options) { h.toasts.push(options.title) },
    setClipboardData(options) { h.clipboard.push(options.data); if (h.clipboardFails) options.fail(); else options.success() }, navigateBack() { h.navigation.push('back') }, navigateTo(options) { h.navigation.push(options.url) }, redirectTo() {}, stopPullDownRefresh() {},
    cloud: { callFunction: async ({ name, data: envelope }) => {
      const { action, data } = envelope
      calls.push({ name, action, data })
      if (h.intercept) await h.intercept(action, data)
      let result
      if (action === 'catalog.get') result = { categories: h.categories, accounts: h.accounts || accounts(), uid: h.uid }
      else if (action === 'bootstrap') result = { categories, uid: h.uid }
      else if (action === 'categories.list') result = { categories }
      else if (action === 'accounts.list') result = { accounts: h.accounts || accounts() }
      else if (action === 'dashboard.get') result = { accounts: accounts(), summary, netWorthMinor: balance, cashFlowTrend: [{ month: data.month, incomeMinor: '0', expenseMinor: '100' }], recentTransactions: [] }
      else if (action === 'transactions.list') result = { transactions: [transaction(data.search || (data.accountId ? data.accountId : data.cursor ? 'row-2' : 'row-1'))], nextCursor: data.cursor ? null : 'page-2', summary }
      else if (action === 'transactions.refundable') result = { transactions: [] }
      else if (action === 'statistics.get') result = { month: data.month, summary, cashFlowTrend: [{ month: data.trendEndMonth || data.month, incomeMinor: '0', expenseMinor: '100' }] }
      else { balance = '10100'; result = { saved: true } }
      return { result: { ok: true, data: result } }
    } }
  }
  function load(filename) {
    if (filename.endsWith('/services/read-cache.js')) return cache
    if (filename.includes('/theme/')) return { bindPage() {}, bindTabBar() {}, currentTokens: () => ({ accent: '#000' }) }
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, getApp: () => app, wx, console, setTimeout, clearTimeout,
      Page: definition => { module.exports = definition }, Component: definition => { module.exports = definition },
      require: name => load(path.resolve(path.dirname(filename), name + (path.extname(name) ? '' : '.js')))
    }, { filename })
    return module.exports
  }
  h.api = load(path.join(root, 'services/catledger-api.js'))
  h.importApi = load(path.join(root, 'services/catledger-import.js'))
  h.page = name => {
    if (pages.has(name)) return pages.get(name)
    const definition = load(path.join(root, 'pages', name, 'index.js'))
    const loading = []
    const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), getTabBar: () => null,
      setData(patch) { if (Object.hasOwn(patch, 'loading')) loading.push(patch.loading); Object.assign(this.data, patch) }, loading }
    pages.set(name, page)
    return page
  }
  h.component = () => {
    const definition = load(path.join(root, 'custom-tab-bar/index.js'))
    return { ...definition.methods, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) { Object.assign(this.data, patch) } }
  }
  return h
}

async function visit(h, name) {
  const page = h.page(name)
  page.onShow()
  const method = { index: 'loadDashboard', transactions: 'prepareAndLoad', ledger: 'loadLedger', profile: 'loadProfile' }[name]
  await page[method]()
  return page
}

test('首页、明细、账本、我的首次一轮仅3次请求，后续切页0请求且无加载闪烁', async () => {
  const h = runtime()
  for (const name of ['index', 'transactions', 'ledger', 'profile']) await visit(h, name)
  assert.deepEqual(h.calls.map(call => call.action).sort(), ['catalog.get', 'dashboard.get', 'transactions.list'])
  h.calls.length = 0
  for (const name of ['index', 'transactions', 'ledger', 'profile']) h.page(name).loading.length = 0
  for (const name of ['index', 'transactions', 'ledger', 'profile']) await visit(h, name)
  assert.equal(h.calls.length, 0)
  for (const name of ['index', 'transactions', 'ledger', 'profile']) assert.equal(h.page(name).loading.includes(true), false, name)
})

test('返回明细保留后续分页，显式刷新读取服务器并更新分页基线', async () => {
  const h = runtime()
  const page = await visit(h, 'transactions')
  await page.loadTransactions(true)
  assert.equal(page.data.transactions.length, 2)
  h.calls.length = 0
  await visit(h, 'transactions')
  assert.equal(h.calls.length, 0)
  assert.equal(page.data.transactions.length, 2)
  await page.prepareAndLoad({ force: true })
  assert.equal(h.calls.length, 2)
  assert.equal(page.data.transactions.length, 1)
})

test('正式交易和导入入账均刷新相关缓存，普通草稿读取不干扰账本缓存', async () => {
  const h = runtime()
  await visit(h, 'index')
  await h.api.bootstrap()
  await h.api.callApi('transactions.create', { requestId: 'synthetic-request' })
  assert.equal(h.api.isFresh('accounts.list'), false)
  assert.equal(h.api.isFresh('bootstrap'), true)
  await visit(h, 'index')
  assert.equal(h.page('index').data.netWorthText, '¥101.00')
  await h.importApi.callImport('financeUpdates.get', { updateId: 'synthetic' })
  assert.equal(h.api.isFresh('dashboard.get', { month: h.page('index').data.month }), true)
  await h.importApi.callImport('financeUpdates.post', { updateId: 'synthetic' })
  assert.equal(h.api.isFresh('dashboard.get', { month: h.page('index').data.month }), false)
})

test('缓存失效会重新读取；已有页面内容保留，失败不会改成零', async () => {
  const h = runtime()
  const page = await visit(h, 'index')
  h.cache.invalidate(['accounts'])
  let reject
  h.intercept = action => action === 'dashboard.get' ? new Promise((resolve, fail) => { reject = fail }) : undefined
  const pending = page.loadDashboard()
  await flush()
  assert.equal(page.data.hasDashboard, true)
  assert.equal(page.data.netWorthText, '¥100.00')
  reject(new Error('synthetic failure'))
  await pending
  assert.equal(page.data.netWorthText, '¥100.00')
  assert.ok(page.data.errorMessage)
})

test('普通记账不请求退款候选，切到退款才读取且反复切换不重复请求', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  await page.prepareForm()
  assert.equal(page.data.formReady, true)
  assert.equal(h.calls.some(call => call.action === 'transactions.refundable'), false)
  await page.changeType({ currentTarget: { dataset: { index: 3 } } })
  await page.changeType({ currentTarget: { dataset: { index: 0 } } })
  await page.changeType({ currentTarget: { dataset: { index: 3 } } })
  assert.equal(h.calls.filter(call => call.action === 'transactions.refundable').length, 1)
})

test('退出后旧个人页请求不能恢复已连接状态或数量', async () => {
  const h = runtime(), page = h.page('profile')
  let resolve
  h.intercept = action => action === 'catalog.get' ? new Promise(done => { resolve = done }) : undefined
  const pending = page.loadProfile()
  await flush()
  h.cache.reset(); h.app.approved = false
  page.onShow()
  resolve()
  await pending
  assert.equal(page.data.connected, false)
  assert.equal(page.data.accountCount, 0)
})

test('新登录会话在等待服务器期间清除旧页面数据，旧请求不会结束新请求加载态', async () => {
  const h = runtime(), page = await visit(h, 'profile')
  let completeOld, completeNew, order = 0
  h.intercept = action => action === 'catalog.get' ? new Promise(resolve => { if (++order === 1) completeOld = resolve; else completeNew = resolve }) : undefined
  const old = page.loadProfile({ force: true })
  await flush()
  h.cache.reset()
  h.uid = '00000000-0000-4000-8000-000000000002'
  const fresh = page.loadProfile()
  assert.equal(page.data.uid, '')
  await flush()
  assert.equal(page.data.uid, '')
  assert.equal(page.data.hasLoaded, false)
  assert.equal(page.data.accountCount, 0)
  assert.equal(page.data.loading, true)
  completeOld()
  await old
  assert.equal(page.data.loading, true)
  completeNew()
  await fresh
  assert.equal(page.data.accountCount, 1)
  assert.equal(page.data.loading, false)
})

test('缓存也经过登录门禁，账户更名只刷新引用账户的页面，不重查纯统计', async () => {
  const h = runtime()
  await h.api.callApi('accounts.list')
  await h.api.callApi('statistics.get', { month: '2026-09' })
  await h.api.callApi('accounts.update', { accountId: 'account-a' })
  assert.equal(h.api.isFresh('accounts.list'), false)
  assert.equal(h.api.isFresh('statistics.get', { month: '2026-09' }), true)
  h.app.approved = false
  const count = h.calls.length
  await assert.rejects(h.api.callApi('statistics.get', { month: '2026-09' }), { code: 'LOGIN_REQUIRED' })
  assert.equal(h.calls.length, count)
})

test('加载下一页期间发生写入时重读首屏，不把旧分页与新结果拼接', async () => {
  const h = runtime(), page = await visit(h, 'transactions')
  let release, blocked = false
  h.intercept = action => {
    if (action === 'transactions.list' && !blocked) {
      blocked = true
      return new Promise(resolve => { release = resolve })
    }
  }
  const appending = page.loadTransactions(true)
  await flush()
  await h.api.callApi('transactions.create', { requestId: 'synthetic' })
  release()
  await appending
  assert.equal(page.data.transactions.length, 1)
  assert.equal(page.data.transactions[0].transactionId, 'row-1')
  assert.equal(page.data.nextCursor, 'page-2')
})

 test('统计历史月使用显式当前趋势终点，单次请求并保留选中月份', async () => {
  const h = runtime()
  const page = h.page('statistics')
  const currentMonth = page.data.month
  await page.loadStatistics()
  assert.equal(page.data.cashFlowTrend[0].month, currentMonth)
  h.calls.length = 0
  await page.chooseMonth({ detail: { value: '2025-01' } })
  assert.equal(page.data.month, '2025-01')
  assert.equal(page.data.cashFlowTrend[0].month, currentMonth)
  assert.equal(page.data.selectedTrend.month, currentMonth)
  assert.deepEqual(h.calls.map(call => call.action), ['statistics.get'])
  assert.equal(h.calls[0].data.trendEndMonth, currentMonth)
  await page.chooseMonth({ detail: { value: '2025-02' } })
  assert.equal(page.data.cashFlowTrend[0].month, currentMonth)
  assert.equal(page.data.selectedTrend.month, currentMonth)
})

 test('统计作为Tab重复进入复用数据，退出登录后不残留统计或发起读取', async () => {
  const h = runtime(), page = h.page('statistics')
  let selected
  page.getTabBar = () => ({ setData: data => { selected = data.selected } })
  page.onLoad()
  page.onShow()
  await page.loadStatistics()
  const count = h.calls.length
  page.onHide()
  page.onShow()
  assert.equal(selected, 2)
  assert.equal(h.calls.length, count)
  h.app.approved = false
  h.cache.reset()
  page.onShow()
  assert.equal(page.data.hasLoaded, false)
  assert.equal(page.data.charts, null)
  assert.equal(page.data.cashFlowTrend.length, 0)
  assert.equal(h.calls.length, count)
})

 test('导入补全入口切统计Tab后恢复当月并只消费一次打开意图', async () => {
  const h = runtime(), page = h.page('statistics')
  const current = page.data.month
  await page.chooseMonth({ detail: { value: '2025-01' } })
  let opened = 0
  page.openCategoryCompletion = () => { opened += 1 }
  h.app.globalData.openStatisticsCompletion = true
  page.onShow()
  await page.loadStatistics()
  assert.equal(page.data.month, current)
  assert.equal(opened, 1)
  assert.equal(h.app.globalData.openStatisticsCompletion, false)
  page.onShow()
  assert.equal(opened, 1)
})


test('个人页完整显示并复制同一10位 uid，复制失败可重试，旧会话不能复制', async () => {
  const h = runtime(), page = await visit(h, 'profile')
  assert.equal(page.data.uid, h.uid)
  assert.equal(h.app.globalData.uid, h.uid)
  assert.match(page.data.displayUid, /^[1-9][0-9]{9}$/)
  assert.equal(page.data.displayUid, h.uid)
  page.copyId()
  assert.deepEqual(h.clipboard, [h.uid])
  assert.equal(h.toasts.at(-1), 'ID 已复制')
  h.clipboardFails = true
  page.copyId()
  assert.equal(h.toasts.at(-1), '复制失败，请重试')
  h.cache.reset()
  page.copyId()
  assert.equal(h.clipboard.length, 2)
  h.app.approved = false
  page.onShow()
  assert.equal(page.data.uid, '')
  assert.equal(page.data.displayUid, '')
})

test('退出后未完成的目录请求不得回填 ID；旧后端缺字段时隐藏 ID', async () => {
  const h = runtime(), page = h.page('profile')
  let resolve
  h.intercept = action => action === 'catalog.get' ? new Promise(done => { resolve = done }) : undefined
  const pending = page.loadProfile()
  await flush()
  h.cache.reset(); h.app.approved = false; h.app.globalData.uid = ''
  page.onShow()
  resolve()
  await pending
  assert.equal(page.data.uid, '')
  assert.equal(h.app.globalData.uid, '')
  h.intercept = null; h.app.approved = true; h.uid = undefined
  await page.loadProfile()
  assert.equal(page.data.uid, '')
  page.copyId()
  assert.deepEqual(h.clipboard, [])
  h.uid = '00000000-0000-4000-8000-000000000002'
  await page.retryProfile()
  assert.equal(page.data.uid, h.uid, '缺字段重试必须跳过旧缓存读取真实 ID')
})

test('登录后直接复用已确认 uid，不多发 bootstrap', async () => {
  const h = runtime(), page = h.page('profile')
  h.app.globalData.uid = h.uid
  await page.loadProfile({ identityConfirmed: true })
  assert.equal(page.data.uid, h.uid)
  assert.equal(h.calls.some(call => call.action === 'bootstrap'), false)
})

test('慢目录和失败期间金额、备注、类型可编辑，重试不覆盖草稿', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  let fail
  h.intercept = action => action === 'catalog.get' ? new Promise((resolve, reject) => { fail = reject }) : undefined
  const pending = page.prepareForm()
  assert.equal(page.data.formReady, true)
  assert.equal(page.data.catalogReady, false)
  page.bindAmount({ detail: { value: '23.45' } })
  page.bindNote({ detail: { value: '合成草稿' } })
  page.changeType({ currentTarget: { dataset: { index: 1 } } })
  await page.save()
  await flush()
  assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
  fail(new Error('合成目录失败'))
  await pending
  assert.equal(page.data.formReady, true)
  assert.ok(page.data.catalogError)
  h.intercept = null
  h.categories.push({ id: 'income-a', kind: 'income', name: '合成收入' })
  await page.prepareForm()
  assert.equal(page.data.amountYuan, '23.45')
  assert.equal(page.data.note, '合成草稿')
  assert.equal(page.data.typeIndex, 1)
  assert.equal(page.data.categories[page.data.categoryIndex].id, 'income-a')
})

test('新鲜目录同步回填；重排按ID保留，已选账户和分类消失后必须重新选择', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  h.accounts = [{ accountId: 'account-a' }, { accountId: 'account-b' }]
  h.categories.push({ id: 'category-b', kind: 'expense', name: '合成分类B' })
  await h.api.callApi('catalog.get')
  const pending = page.prepareForm()
  assert.equal(page.data.catalogReady, true)
  await pending
  page.bindAmount({ detail: { value: '1' } })
  page.changeSource({ detail: { value: 1 } })
  page.changeCategory({ detail: { value: 1 } })
  h.accounts.reverse(); h.categories.reverse()
  await page.prepareForm({ force: true })
  assert.equal(page.data.sourceIndex, 0)
  assert.equal(page.data.categoryIndex, 0)
  h.accounts.shift(); h.categories.shift()
  await page.prepareForm({ force: true })
  assert.equal(page.data.sourceIndex, -1)
  assert.equal(page.data.categoryIndex, -1)
  await page.save()
  assert.equal(h.calls.some(call => call.action === 'transactions.create'), false)
  assert.match(page.data.errorMessage, /请选择/)
})

test('无账户时进入账户页，新增后返回刷新目录而保留金额备注', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  h.accounts = []
  await page.prepareForm()
  assert.equal(page.data.hasAccounts, false)
  page.bindAmount({ detail: { value: '42' } }); page.bindNote({ detail: { value: '稍后继续' } })
  page.openAccounts()
  assert.deepEqual(h.navigation, ['/pages/accounts/index'])
  h.accounts = [{ accountId: 'new-account', name: '合成账户' }]
  await h.api.callApi('accounts.create', { requestId: 'synthetic' })
  page.onShow()
  await page.prepareForm()
  assert.equal(page.data.accounts[0].accountId, 'new-account')
  assert.equal(page.data.hasAccounts, true)
  assert.equal(page.data.amountYuan, '42')
  assert.equal(page.data.note, '稍后继续')
})

test('只读导入详情在分类目录晚到前显示，刷新保留尚未保存的分类ID', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  h.app.globalData.editingTransaction = { transactionId: 'synthetic-detail', version: 1, type: 'expense', amountMinor: '456', occurredLocalAt: '2026-09-01T12:00:00', note: '合成说明' }
  page.setData({ mode: 'import', readonlyDetail: true })
  let release
  h.intercept = action => action === 'catalog.get' ? new Promise(resolve => { release = resolve }) : undefined
  const pending = page.prepareForm()
  assert.equal(page.data.formReady, true)
  assert.equal(page.data.detail.amountText, '¥4.56')
  assert.equal(page.data.catalogReady, false)
  await flush(); release(); await pending
  page.changeDetailCategory({ detail: { value: 1 } })
  h.intercept = null
  h.categories.unshift({ id: 'new-first', kind: 'expense', name: '合成新项' })
  await page.prepareForm({ force: true })
  assert.equal(page.data.categories[page.data.categoryIndex].id, 'category-a')
  assert.equal(page.data.categoryDirty, true)
})

test('同一保存内容失败重试使用同一请求号，服务端成功后立即返回', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  await page.prepareForm(); page.bindAmount({ detail: { value: '1' } })
  h.intercept = action => { if (action === 'transactions.create') throw new Error('合成失败') }
  await page.save(); await page.save()
  const writes = h.calls.filter(call => call.action === 'transactions.create')
  assert.equal(writes.length, 2)
  assert.equal(writes[0].data.requestId, writes[1].data.requestId)
  page.bindNote({ detail: { value: '修改草稿' } })
  await page.save()
  assert.notEqual(h.calls.at(-1).data.requestId, writes[0].data.requestId)
  h.intercept = null
  await page.save()
  assert.deepEqual(h.navigation, ['back'])
})

test('页面卸载或会话变更后，旧目录与保存响应不回填也不导航', async () => {
  for (const boundary of ['unload', 'session']) {
    for (const action of ['catalog.get', 'transactions.create', 'transactions.setCategory']) {
      const h = runtime(), page = h.page('transaction-editor')
      if (action === 'transactions.setCategory') {
        h.app.globalData.editingTransaction = { transactionId: 'synthetic-detail', version: 1, type: 'expense', amountMinor: '100' }
        page.setData({ mode: 'import', readonlyDetail: true })
      }
      if (action !== 'catalog.get') {
        await page.prepareForm()
        page.bindAmount({ detail: { value: '1' } })
        if (action === 'transactions.setCategory') page.changeDetailCategory({ detail: { value: 1 } })
      }
      let release
      h.intercept = candidate => candidate === action ? new Promise(resolve => { release = resolve }) : undefined
      const pending = action === 'catalog.get' ? page.prepareForm() : action === 'transactions.create' ? page.save() : page.saveDetailCategory()
      await flush()
      if (boundary === 'unload') page.onUnload()
      else { h.cache.reset(); h.app.approved = false }
      const before = JSON.stringify(page.data)
      release(); await pending
      assert.equal(JSON.stringify(page.data), before, boundary + '/' + action)
      assert.deepEqual(h.navigation, [])
    }
  }
})

test('删除确认和删除回包都遵守页面生命周期，成功删除直接返回', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  await page.prepareForm()
  page.remove()
  page.onUnload()
  h.modals[0].success({ confirm: true })
  assert.equal(h.calls.some(call => call.action === 'transactions.delete'), false)
  for (const unload of [true, false]) {
    const h = runtime(), page = h.page('transaction-editor')
    await page.prepareForm()
    let release
    h.intercept = action => action === 'transactions.delete' ? new Promise(resolve => { release = resolve }) : undefined
    page.remove(); h.modals[0].success({ confirm: true })
    await flush()
    if (unload) page.onUnload()
    release(); await flush(); await flush()
    assert.deepEqual(h.navigation, unload ? [] : ['back'])
  }
})

test('目录失败时交易列表仍成功，个人页已确认的连接及数量不改成零', async () => {
  const h = runtime(), profile = await visit(h, 'profile')
  h.cache.invalidate(['accountDirectory'])
  h.intercept = action => { if (action === 'catalog.get') throw new Error('合成离线') }
  const page = await visit(h, 'transactions')
  assert.equal(page.data.transactions.length, 1)
  assert.equal(page.data.hasLoaded, true)
  assert.ok(page.data.catalogError)
  await profile.loadProfile()
  assert.equal(profile.data.connected, true)
  assert.equal(profile.data.accountCount, 1)
  assert.ok(profile.data.errorMessage)
})

test('中央入口仅登录后低优先级预取目录，失败不阻断导航，退出后取消尚未开始的读取', async () => {
  const h = runtime(), component = h.component()
  h.app.approved = false
  component.openEntry()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(h.calls.length, 0)
  h.app.approved = true
  h.intercept = () => { throw new Error('合成离线') }
  component.openEntry(); component.openEditor()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(h.navigation, ['/pages/transaction-editor/index'])
  assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
  h.calls.length = 0
  component.openEntry(); h.cache.reset(); h.app.approved = false
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(h.calls.length, 0)
})

test('连续搜索最后意图立即发出，旧条件无论成功或失败都不能覆盖新结果', async () => {
  for (const oldFails of [false, true]) {
    const h = runtime(), page = await visit(h, 'transactions')
    const gates = {}
    h.intercept = (action, data) => action === 'transactions.list' && data.search ? new Promise((resolve, reject) => { gates[data.search] = { resolve, reject } }) : undefined
    page.bindSearch({ detail: { value: 'old' } }); const old = page.applySearch()
    page.bindSearch({ detail: { value: 'latest' } }); const latest = page.applySearch()
    await flush()
    assert.ok(gates.old); assert.ok(gates.latest)
    gates.latest.resolve(); await latest
    assert.equal(page.data.transactions[0].transactionId, 'latest')
    if (oldFails) gates.old.reject(new Error('旧搜索失败')); else gates.old.resolve()
    await old
    assert.equal(page.data.transactions[0].transactionId, 'latest')
    assert.equal(page.data.errorMessage, '')
    assert.equal(page.data.loading, false)
  }
})

test('分页等待时改变账户筛选立即加载新首屏，不拼接旧分页也不吞最终筛选', async () => {
  const h = runtime(), page = await visit(h, 'transactions')
  let release
  h.intercept = (action, data) => action === 'transactions.list' && data.cursor ? new Promise(resolve => { release = resolve }) : undefined
  const pending = page.loadTransactions(true)
  await flush()
  await page.changeAccountFilter({ detail: { value: 1 } })
  assert.equal(page.data.transactions[0].transactionId, 'account-a')
  release(); await pending
  assert.equal(page.data.transactions.length, 1)
  assert.equal(page.data.transactions[0].transactionId, 'account-a')
})


test('账户保存冲突回读最新版本并保留名称输入，卸载后不回填', async () => {
  const h = runtime(), page = h.page('accounts')
  h.accounts = [{ accountId: 'account-a', name: '原名称', type: 'bank', nature: 'asset', version: 1, displayBalanceMinor: '0' }]
  await page.loadAccounts()
  page.openRename({ currentTarget: { dataset: { id: 'account-a' } } })
  page.bindName({ detail: { value: '我的输入' } })
  h.intercept = async action => {
    if (action === 'accounts.update') {
      h.accounts = [{ ...h.accounts[0], name: '其他设备已更名', version: 2 }]
      throw new Error('合成版本冲突')
    }
  }
  await page.saveForm()
  assert.equal(page.data.name, '我的输入')
  assert.equal(page.data.selectedAccount.version, 2)
  assert.equal(page.data.assets[0].name, '其他设备已更名')
  assert.match(page.data.errorMessage, /暂时不可用/)
  let release
  h.intercept = action => action === 'accounts.update' ? new Promise(resolve => { release = resolve }) : undefined
  const pending = page.saveForm()
  await flush(); page.onUnload(); release(); await pending
  assert.equal(page.data.formOpen, true)
  assert.equal(h.toasts.length, 0)
})
