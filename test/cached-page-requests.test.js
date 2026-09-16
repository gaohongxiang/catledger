const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createReadCache, stableKey } = require('../miniprogram/services/read-cache')
const root = path.join(__dirname, '..', 'miniprogram')
const flush = () => new Promise(resolve => setImmediate(resolve))
function runtime(savedStorage) {
  let now = 0, balance = '10000'
  const cache = Object.assign(createReadCache({ now: () => now }), { stableKey })
  const modules = new Map(), calls = [], pages = new Map(), storage = savedStorage || new Map()
  const app = { globalData: { cloudAvailable: true, categories: [], profile: {}, uid: '1234567890' }, approved: true,
    hasLoginApproval() { return this.approved } }
  const categories = [{ id: 'category-a', kind: 'expense', name: '合成分类' }]
  const accounts = () => [{ accountId: 'account-a', name: '合成账户', type: 'bank', nature: 'asset', archived: false, displayBalanceMinor: balance, bookBalanceMinor: balance }]
  const summary = { incomeMinor: '0', expenseMinor: '100', netIncomeMinor: '-100' }
  const transaction = id => ({ transactionId: id, type: 'expense', amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', sourceAccount: accounts()[0] })
  const h = { app, calls, cache, storage, now(value) { now = value }, intercept: null,
    categories, accounts: null, navigation: [], modals: [], uid: '1234567890', clipboard: [], toasts: [], clipboardFails: false }
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key), nextTick: cb => cb(), showModal(options) { h.modals.push(options) }, showToast(options) { h.toasts.push(options.title) },
    setClipboardData(options) { h.clipboard.push(options.data); if (h.clipboardFails) options.fail(); else options.success() }, navigateBack() { h.navigation.push('back') },
    navigateTo(options) {
      h.navigation.push(options.url)
      h.lastNavigation = options
      if (h.deferNavigation) return
      if (h.failNavigation && options.fail) options.fail()
      if (options.complete) options.complete()
    }, redirectTo() {}, stopPullDownRefresh() {},
    cloud: { callFunction: async ({ name, data: envelope }) => {
      const { action, data } = envelope
      calls.push({ name, action, data })
      if (h.intercept) await h.intercept(action, data)
      if (h.respond) {
        const response = await h.respond(action, data)
        if (response !== undefined) return { result: response }
      }
      let result
      if (action === 'transactions.commandResult') return { result: { ok: false, error: { code: 'OPERATION_UNCONFIRMED', message: '未确认' } } }
      if (action === 'catalog.get') result = { categories: h.categories, accounts: h.accounts || accounts(), uid: h.uid }
      else if (action === 'bootstrap') result = { categories, uid: h.uid }
      else if (action === 'categories.list') result = { categories }
      else if (action === 'accounts.list') result = { accounts: h.accounts || accounts() }
      else if (action === 'dashboard.get') result = { accounts: accounts(), summary, netWorthMinor: balance, cashFlowTrend: [{ month: data.month, incomeMinor: '0', expenseMinor: '100' }], recentTransactions: [] }
      else if (action === 'transactions.list') result = { source: data.source || null, transactions: [transaction(data.search || (data.accountId ? data.accountId : data.cursor ? 'row-2' : 'row-1'))], nextCursor: data.cursor ? null : 'page-2', summary }
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
    return { ...definition.methods, data: JSON.parse(JSON.stringify(definition.data)),
      selectComponent: () => ({ show: options => { h.loginOptions = options } }),
      setData(patch) { Object.assign(this.data, patch) } }
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

const unsupportedCatalog = action => action === 'catalog.get'
  ? { ok: false, error: { code: 'UNSUPPORTED_ACTION', message: '当前操作尚未开放' } } : undefined

test('重启后未加载用户编号且没有旧提交：新建、编辑和删除均正常', async t => {
  for (const action of ['transactions.create', 'transactions.update', 'transactions.delete']) {
    await t.test(action, async () => {
      const h = runtime(), page = h.page('transaction-editor')
      h.app.globalData.uid = ''
      if (action !== 'transactions.create') {
        page.data.mode = 'edit'
        h.app.globalData.editingTransaction = { transactionId: 'synthetic-edit', version: 2, type: 'expense',
          amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', timezoneOffsetMinutes: -480,
          sourceAccount: { accountId: 'account-a' }, category: { categoryId: 'category-a' }, note: '' }
      }
      let release
      h.intercept = name => name === 'catalog.get' ? new Promise(resolve => { release = resolve }) : undefined
      const preparing = page.prepareForm()
      await flush()
      assert.equal(page.data.errorMessage, '')
      assert.equal(h.storage.size, 0)
      await page.save()
      assert.equal(page.data.errorMessage, '', '目录尚未就绪不应误报身份或旧操作异常')
      page.bindAmount({ detail: { value: '2.34' } })
      page.bindNote({ detail: { value: '合成当前修改' } })
      release(); await preparing
      assert.equal(h.app.globalData.uid, h.uid)
      assert.equal(page.data.errorMessage, '')
      assert.equal(page.data.amountYuan, '2.34')
      assert.equal(page.data.note, '合成当前修改')
      assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
      if (action === 'transactions.delete') {
        page.remove()
        await h.modals[0].success({ confirm: true })
      } else await page.save()
      const writes = h.calls.filter(call => call.action === action)
      assert.equal(writes.length, 1)
      if (action !== 'transactions.delete') {
        assert.equal(writes[0].data.amountMinor, '234')
        assert.equal(writes[0].data.note, '合成当前修改')
      }
      if (action !== 'transactions.create') assert.equal(writes[0].data.transactionId, 'synthetic-edit')
      assert.equal(h.storage.size, 0)
      assert.equal(h.calls.some(call => call.action === 'transactions.commandResult'), false)
      assert.deepEqual(h.navigation, ['back'])
    })
  }
})

test('缓存目录也能补齐当前用户编号，无需额外初始化请求', async () => {
  const h = runtime()
  await h.api.callApi('catalog.get')
  h.app.globalData.uid = ''
  const page = h.page('transaction-editor')
  await page.prepareForm()
  assert.equal(h.app.globalData.uid, h.uid)
  assert.equal(page.data.errorMessage, '')
  assert.equal(page.data.catalogReady, true)
  assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
})

test('目录尚未返回就确认删除，共用读取并等待当前会话的用户编号', async () => {
  for (const unload of [false, true]) {
    const h = runtime(), page = h.page('transaction-editor')
    h.app.globalData.uid = ''
    page.data.mode = 'edit'
    h.app.globalData.editingTransaction = { transactionId: 'synthetic-delete', version: 1, type: 'expense',
      amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', sourceAccount: { accountId: 'account-a' } }
    let release
    h.intercept = action => action === 'catalog.get' ? new Promise(resolve => { release = resolve }) : undefined
    const preparing = page.prepareForm()
    await flush()
    page.remove()
    const deleting = h.modals[0].success({ confirm: true })
    await flush()
    assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
    if (unload) page.onUnload()
    release(); await Promise.all([preparing, deleting])
    assert.equal(h.calls.filter(call => call.action === 'transactions.delete').length, unload ? 0 : 1)
    assert.equal(page.data.errorMessage, '')
    assert.deepEqual(h.navigation, unload ? [] : ['back'])
  }
})

test('目录失败只提示目录加载失败，不虚构上次操作或确认用户编号', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  h.app.globalData.uid = ''
  h.respond = unsupportedCatalog
  await page.prepareForm()
  assert.equal(h.app.globalData.uid, '')
  assert.equal(page.data.errorMessage, '')
  assert.ok(page.data.catalogError)
  assert.equal(h.storage.size, 0)
  assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
  h.respond = null
  await page.retryCatalog()
  assert.equal(h.app.globalData.uid, h.uid)
  assert.equal(page.data.errorMessage, '')
  assert.equal(page.data.catalogError, '')
})

test('目录版本不匹配只请求当前服务，保留输入并可重试恢复', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  h.respond = unsupportedCatalog
  const pending = page.prepareForm()
  page.bindAmount({ detail: { value: '26.80' } })
  page.bindNote({ detail: { value: '合成草稿' } })
  await pending
  assert.equal(page.data.catalogReady, false)
  assert.equal(page.data.amountYuan, '26.80')
  assert.equal(page.data.note, '合成草稿')
  assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
  assert.equal(h.api.peek('catalog.get'), null)
  await page.save()
  assert.equal(h.calls.some(call => call.action === 'transactions.create'), false)
  h.respond = null
  await page.retryCatalog()
  assert.equal(page.data.catalogReady, true)
  assert.equal(page.data.amountYuan, '26.80')
})

test('统计独立趋势终点不符明确失败且不补读其他月份', async () => {
  const h = runtime()
  h.respond = (action, data) => action === 'statistics.get' ? { ok: true, data: { month: data.month,
    cashFlowTrend: [{ month: data.month, incomeMinor: '1234', expenseMinor: '0' }] } } : undefined
  await assert.rejects(h.api.callApi('statistics.get', { month: '2026-01', trendEndMonth: '2026-09' }), { code: 'INVALID_RESPONSE' })
  assert.deepEqual(h.calls.map(call => call.data.month), ['2026-01'])
})

test('目录权限/参数错误及缺字段响应不缓存，不启动其他读取', async () => {
  for (const code of ['AUTH_REQUIRED', 'INVALID_REQUEST']) {
    const h = runtime()
    h.respond = () => ({ ok: false, error: { code, message: '合成拒绝' } })
    await assert.rejects(h.api.callApi('catalog.get'), error => error.code === code)
    assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
    assert.equal(h.api.peek('catalog.get'), null)
  }
  for (const field of ['uid', 'accounts', 'categories']) {
    const h = runtime()
    h.respond = action => {
      if (action !== 'catalog.get') return undefined
      const data = { uid: h.uid, accounts: h.accounts, categories: h.categories }; delete data[field]
      return { ok: true, data }
    }
    await assert.rejects(h.api.callApi('catalog.get'), { code: 'INVALID_RESPONSE' })
    assert.equal(h.api.peek('catalog.get'), null)
  }
})

test('已有目录刷新失败后，点击重试仍读取服务端，不以旧缓存掩盖错误', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  await page.prepareForm()
  h.respond = () => ({ ok: false, error: { code: 'NOT_FOUND', message: '合成失败' } })
  await page.prepareForm({ force: true })
  assert.equal(page.data.catalogReady, false)
  assert.ok(page.data.catalogError)
  const before = h.calls.length
  await page.retryCatalog()
  assert.equal(h.calls.length, before + 1)
  assert.equal(page.data.catalogReady, false)
  h.respond = null
  await page.retryCatalog()
  assert.equal(page.data.catalogReady, true)
})

test('切换会话后迟到目录结果不回填', async () => {
  const h = runtime()
  h.app.globalData.uid = ''
  let release
  h.respond = () => new Promise(resolve => { release = resolve })
  const pending = h.api.callApi('catalog.get')
  await flush()
  h.cache.reset()
  release({ ok: true, data: { uid: h.uid, accounts: h.accounts, categories: h.categories } })
  await assert.rejects(pending, { code: 'SESSION_CHANGED' })
  assert.equal(h.api.peek('catalog.get'), null)
  assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
  assert.equal(h.app.globalData.uid, '')
})

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
  await h.importApi.callImport('financeUpdates.summary', { updateId: 'synthetic' })
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
  h.uid = '2000000002'
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

test('退出后未完成的目录请求不得回填 ID；缺字段响应不回填 ID', async () => {
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
  h.uid = '2000000002'
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
  assert.equal(h.calls.at(-1).data.requestId, writes[0].data.requestId)
  assert.equal(h.calls.at(-1).data.note, writes[0].data.note)
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

test('手工账目关联停用账户时禁止保存修改，但确认删除仍发送原交易身份', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  h.accounts = [{ accountId: 'archived-account', type: 'bank', name: '合成停用账户', archived: true }]
  h.app.globalData.editingTransaction = { transactionId: 'synthetic-archived-expense', version: 3, type: 'expense',
    sourceAccount: h.accounts[0], amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', timezoneOffsetMinutes: -480 }
  page.setData({ mode: 'edit' })
  await page.prepareForm()
  assert.equal(page.data.editingBlocked, true)
  assert.match(page.data.errorMessage, /仍可删除/)
  await page.save()
  assert.equal(h.calls.some(call => call.action === 'transactions.update'), false)
  page.remove()
  await h.modals[0].success({ confirm: true })
  const deleted = h.calls.filter(call => call.action === 'transactions.delete')
  assert.equal(deleted.length, 1)
  assert.equal(deleted[0].data.transactionId, 'synthetic-archived-expense')
  assert.equal(deleted[0].data.version, 3)
  assert.deepEqual(h.navigation, ['back'])
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

test('中央记账先选择方式，游客登录后继续原选择，菜单不读取目录', async () => {
  for (const [method, route] of [['openEditor', '/pages/transaction-editor/index'], ['chooseBill', '/pages/import-workbench/index']]) {
    const h = runtime(), component = h.component()
    h.app.approved = false
    component.openEntry()
    assert.equal(component.data.entryOpen, true)
    assert.equal(h.loginOptions, undefined)
    assert.deepEqual(h.navigation, [])
    component.closeEntry()
    assert.equal(component.data.entryOpen, false)
    component.openEntry(); component[method]()
    assert.equal(component.data.entryOpen, false)
    assert.equal(h.calls.length, 0)
    assert.deepEqual(h.navigation, [])
    assert.equal(typeof h.loginOptions.afterLogin, 'function')
    // 取消或失败没有成功回调；登录成功继续用户选择的那一路。
    h.app.approved = true
    h.loginOptions.afterLogin()
    assert.deepEqual(h.navigation, [route])
    assert.equal(h.calls.length, 0)
    if (method === 'openEditor') {
      await h.page('transaction-editor').prepareForm()
      assert.deepEqual(h.calls.map(call => call.action), ['catalog.get'])
    }
  }
})

test('两种记账入口共用导航保护，连续切换不会叠页，失败后允许重试', () => {
  for (const method of ['openEditor', 'chooseBill']) {
    const h = runtime(), component = h.component()
    h.deferNavigation = true
    component.openEntry(); component[method](); component.openEditor(); component.chooseBill(); component.openEntry()
    assert.equal(component.data.entryOpen, false)
    assert.equal(h.navigation.length, 1)
    h.lastNavigation.complete()
    h.deferNavigation = false; h.failNavigation = true
    component.openEntry(); component[method]()
    assert.match(h.toasts[0], /重试/)
    h.failNavigation = false
    component.openEntry(); component[method]()
    assert.equal(h.navigation.length, 3)
  }
})

test('进入导入再返回保留完整手记草稿，目录失效按ID刷新且不自动入账', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  h.accounts = [{ accountId: 'account-a', name: '合成账户A' }, { accountId: 'account-b', name: '合成账户B' }]
  await page.prepareForm()
  page.bindAmount({ detail: { value: '28.50' } })
  page.bindNote({ detail: { value: '返回后继续填写' } })
  page.changeSource({ detail: { value: 1 } })
  page.changeDate({ detail: { value: '2026-09-01' } })
  page.changeClock({ detail: { value: '12:34' } })
  const fields = ['amountYuan', 'note', 'date', 'clock', 'typeIndex', 'sourceAccountId', 'selectedCategoryId']
  const draft = () => fields.map(key => page.data[key])
  const before = draft()
  page.openImport()
  assert.deepEqual(h.navigation, ['/pages/import-workbench/index'])
  h.accounts.reverse(); h.cache.invalidate(['accountDirectory'])
  page.onShow(); await page.prepareForm()
  assert.deepEqual(draft(), before)
  assert.equal(page.data.sourceIndex, 0)
  assert.equal(page.data.openingImport, false)
  assert.ok(h.calls.every(call => call.action === 'catalog.get'))
})

test('导入导航失败可重试，重复点击及卸载后的响应不会破坏草稿', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  await page.prepareForm()
  page.bindAmount({ detail: { value: '19.60' } })
  h.failNavigation = true
  page.openImport()
  assert.equal(page.data.amountYuan, '19.60')
  assert.equal(page.data.openingImport, false)
  assert.match(h.toasts[0], /重试/)
  h.failNavigation = false; h.deferNavigation = true
  page.openImport(); page.openImport()
  assert.equal(h.navigation.length, 2)
  page.onUnload()
  const before = JSON.stringify(page.data), toastCount = h.toasts.length
  h.lastNavigation.fail(); h.lastNavigation.complete()
  assert.equal(JSON.stringify(page.data), before)
  assert.equal(h.toasts.length, toastCount)
})

test('已有交易模式、保存中及过期会话不能从记账页进入导入', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  await page.prepareForm()
  for (const mode of ['edit', 'view', 'import', 'link-refund']) {
    page.setData({ mode }); page.openImport()
  }
  page.setData({ mode: 'create', saving: true }); page.openImport()
  page.setData({ saving: false }); h.cache.reset(); page.openImport()
  assert.deepEqual(h.navigation, [])
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

test('明细来源、账户、未分类和搜索组合；输入草稿不带入旧分页，清空保留筛选', async () => {
  const h = runtime(), page = await visit(h, 'transactions')
  await page.changeAccountFilter({ detail: { value: 1 } })
  await page.changeCategoryFilter({ detail: { value: 1 } })
  await page.changeSourceFilter({ detail: { value: 2 } })
  page.bindSearch({ detail: { value: ' 午饭 ' } })
  await page.applySearch()
  let request = h.calls.at(-1).data
  assert.equal(request.source, 'import'); assert.equal(request.search, '午饭')
  assert.equal(request.accountId, 'account-a'); assert.equal(request.uncategorized, true)
  page.bindSearch({ detail: { value: '尚未搜索' } })
  await page.loadTransactions(true)
  request = h.calls.at(-1).data
  assert.equal(request.search, '午饭'); assert.equal(request.cursor, 'page-2')
  await page.clearSearch()
  request = page.requestData(null)
  assert.equal(request.search, ''); assert.equal(request.source, 'import')
  assert.equal(request.accountId, 'account-a'); assert.equal(request.uncategorized, true)
  assert.equal(page.data.search, '')
  await page.changeSourceFilter({ detail: { value: 0 } })
  assert.equal(page.requestData(null).source, undefined)
})

test('云端未确认来源时不缓存或展示全部账目，更新后原条件可重试恢复', async () => {
  for (const returnedSource of [undefined, null, 'manual']) {
    const h = runtime(), page = await visit(h, 'transactions')
    h.respond = action => action === 'transactions.list' ? { ok: true, data: {
      ...(returnedSource === undefined ? {} : { source: returnedSource }),
      transactions: [{ transactionId: 'wrong-all-result', origin: 'system', type: 'balance_adjustment', amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00' }],
      nextCursor: 'wrong-cursor', summary: { incomeMinor: '0', expenseMinor: '100', netIncomeMinor: '-100' }
    } } : undefined
    await page.changeSourceFilter({ detail: { value: 2 } })
    assert.equal(page.data.transactions.length, 0); assert.equal(page.data.nextCursor, null)
    assert.match(page.data.errorMessage, /来源筛选暂不可用/)
    assert.equal(h.api.peek('transactions.list', page.requestData(null)), null)
    assert.equal(page.data.sourceFilterIndex, 2)
    h.respond = null
    await page.prepareAndLoad()
    assert.equal(page.data.transactions.length, 1); assert.equal(page.data.errorMessage, '')
    assert.equal(page.data.sourceFilterIndex, 2)
  }
})

test('来源切换隔离旧分页的成功和失败，重复选择复用缓存，换会话清理搜索', async () => {
  for (const fails of [false, true]) {
    const h = runtime(), page = await visit(h, 'transactions')
    h.respond = (action, data) => action === 'transactions.list' && data.source ? { ok: true, data: { source: data.source,
      transactions: [{ transactionId: data.source, type: 'expense', amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00' }],
      nextCursor: null, summary: { incomeMinor: '0', expenseMinor: '100', netIncomeMinor: '-100' }
    } } : undefined
    let resolve, reject
    h.intercept = (action, data) => action === 'transactions.list' && data.cursor ? new Promise((yes, no) => { resolve = yes; reject = no }) : undefined
    const old = page.loadTransactions(true)
    await flush()
    await page.changeSourceFilter({ detail: { value: 1 } })
    assert.equal(page.data.transactions[0].transactionId, 'manual')
    if (fails) reject(new Error('旧分页失败')); else resolve()
    await old
    assert.equal(page.data.transactions.length, 1); assert.equal(page.data.transactions[0].transactionId, 'manual')
    assert.equal(page.data.errorMessage, ''); assert.equal(page.data.loadingMore, false)
    const count = h.calls.length
    await page.changeSourceFilter({ detail: { value: 1 } })
    assert.equal(h.calls.length, count)
    page.bindSearch({ detail: { value: '午饭' } }); await page.applySearch()
    h.cache.reset(); await page.prepareAndLoad()
    assert.equal(page.data.sourceFilterIndex, 0); assert.equal(page.data.search, ''); assert.equal(page.data.appliedSearch, '')
  }
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

test('已入账维护用当前摘要与分页定位远端记录，下一页替换而不积累全集', async () => {
  const h = runtime(), page = h.page('import-maintenance')
  const events = Array.from({ length: 121 }, (_, n) => ({ eventId: 'event-' + n, version: 1, status: 'posted',
    localAt: '2026-09-01', economicNature: 'expense', amountMinor: '100', ledgerAccountId: 'account-a' }))
  h.respond = (action, data) => {
    if (action === 'financeUpdates.summary') return { ok: true, data: { protocolVersion: 2, viewVersion: 'v1', update: { updateId: 'update', status: 'posted' } } }
    if (action === 'economicEvents.list') {
      const offset = Number(data.cursor || 0)
      return { ok: true, data: { protocolVersion: 2, viewVersion: 'v1', total: data.eventId ? 1 : 121,
        items: data.eventId ? events.filter(e => e.eventId === data.eventId) : events.slice(offset, offset + 40), nextCursor: data.eventId || offset + 40 >= 121 ? null : String(offset + 40) } }
    }
  }
  page._updateId = 'update'; page._eventId = 'event-100'
  await page.load()
  assert.equal(page.data.events.length, 41)
  assert.equal(page.data.events[page.data.eventIndex].eventId, 'event-100')
  assert.equal(page.data.eventCount, 121)
  await page.showMorePostedRecords(); await page.showMorePostedRecords(); await page.showMorePostedRecords()
  assert.equal(page.data.events.length, 40)
  assert.equal(page.data.events[0].eventId, 'event-40')
  assert.equal(page.data.eventCount, 121)
  assert.ok(h.calls.every(c => ['catalog.get', 'financeUpdates.summary', 'economicEvents.list'].includes(c.action)))
})

test('记账响应丢失后修改金额仍先查询原请求，不能新增第二笔', async () => {
  const h = runtime(), page = h.page('transaction-editor')
  await page.prepareForm()
  page.bindAmount({ detail: { value: '1.00' } })
  let packet
  h.respond = (action, data) => {
    if (action === 'transactions.create') { packet = data; return { ok: false, error: { code: 'CLOUD_CALL_FAILED', message: '响应丢失' } } }
    if (action === 'transactions.commandResult') return { ok: true, data: { action: 'transactions.create', receiptId: 'confirmed', result: { saved: true } } }
  }
  await page.save()
  page.bindAmount({ detail: { value: '9.99' } })
  await page.save()
  const writes = h.calls.filter(c => c.action === 'transactions.create')
  assert.ok(packet)
  assert.ok(writes.every(c => c.data.amountMinor === '100'))
  assert.equal(h.calls.filter(c => c.action === 'transactions.commandResult').at(-1).data.requestId, packet.requestId)
  assert.deepEqual(h.navigation, ['back'])
})

test('进程重启后进入记账页只核实持久化原操作，迟到确认只返回一次', async () => {
  const first = runtime(), page = first.page('transaction-editor')
  await page.prepareForm(); page.bindAmount({ detail: { value: '1' } })
  first.intercept = action => { if (action === 'transactions.create') throw new Error('响应丢失') }
  await page.save(); page.onUnload()
  const restarted = runtime(first.storage)
  restarted.app.globalData.uid = ''
  restarted.respond = action => action === 'transactions.commandResult' ? { ok: true, data: {
    action: 'transactions.create', receiptId: 'confirmed', result: { saved: true } } } : undefined
  const restored = restarted.page('transaction-editor')
  await restored.prepareForm(); await flush()
  assert.deepEqual(restarted.navigation, ['back'])
  assert.equal(restarted.calls.filter(c => c.action === 'transactions.create').length, 0)
  assert.equal(restarted.storage.size, 0)
  assert.equal(restarted.app.globalData.uid, restarted.uid)
  assert.deepEqual(restarted.calls.map(c => c.action), ['catalog.get', 'transactions.commandResult'])
})

test('确有旧提交时，核实接口错误保留真实原因而不统一改成操作未确认', async () => {
  const first = runtime(), page = first.page('transaction-editor')
  await page.prepareForm(); page.bindAmount({ detail: { value: '1' } })
  first.intercept = action => { if (action === 'transactions.create') throw new Error('合成响应丢失') }
  await page.save(); page.onUnload()
  const restarted = runtime(first.storage)
  restarted.app.globalData.uid = ''
  restarted.respond = action => action === 'transactions.commandResult'
    ? { ok: false, error: { code: 'UNSUPPORTED_ACTION', message: '合成：当前核实接口不可用' } } : undefined
  const restored = restarted.page('transaction-editor')
  await restored.prepareForm()
  assert.equal(restored.data.errorMessage, '合成：当前核实接口不可用')
  assert.equal(restored.data.catalogError, '')
  assert.equal(restarted.storage.size, 1)
  assert.deepEqual(restarted.navigation, [])
})
