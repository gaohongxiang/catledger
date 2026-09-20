const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createReadCache, stableKey } = require('../../miniprogram/services/read-cache')
const root = path.join(__dirname, '..', '..', 'miniprogram')
function runtime(savedStorage) {
  let now = 0, balance = '10000'
  const modules = new Map(), calls = [], pages = new Map(), storage = savedStorage || new Map()
  const cache = Object.assign(createReadCache({ now: () => now, storage: { get: k => storage.get(k), set: (k,v) => storage.set(k,v), remove: k => storage.delete(k) } }), { stableKey })
  const { READ_POLICIES } = require('../../miniprogram/services/read-policy')
  const app = { globalData: { cloudAvailable: true, categories: [], profile: {}, uid: '1234567890' }, approved: true,
    hasLoginApproval() { return this.approved } }
  const categories = [{ id: 'category-a', kind: 'expense', name: '合成分类' }]
  const accounts = () => [{ accountId: 'account-a', name: '合成账户', type: 'bank', nature: 'asset', archived: false, displayBalanceMinor: balance, bookBalanceMinor: balance }]
  const summary = { incomeMinor: '0', expenseMinor: '100', netIncomeMinor: '-100' }
  const transaction = id => ({ transactionId: id, type: 'expense', amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', sourceAccount: accounts()[0] })
  const h = { app, calls, cache, storage, now(value) { now = value }, intercept: null,
    revision: '1', categories, accounts: null, navigation: [], modals: [], uid: '1234567890', clipboard: [], toasts: [], clipboardFails: false }
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key), nextTick: cb => cb(), showModal(options) { h.modals.push(options) }, showToast(options) { h.toasts.push(options.title) },
    setClipboardData(options) { h.clipboard.push(options.data); if (h.clipboardFails) options.fail(); else options.success() }, navigateBack() { h.navigation.push('back') },
    navigateTo(options) {
      h.navigation.push(options.url)
      h.lastNavigation = options
      if (h.deferNavigation) return
      if (h.failNavigation && options.fail) options.fail()
      if (options.complete) options.complete()
    }, switchTab(options) { h.navigation.push(options.url) }, redirectTo(options) { h.navigation.push(options.url) }, pageScrollTo() {}, stopPullDownRefresh() {},
    cloud: { callFunction: async ({ name, data: envelope }) => {
      const { action, data } = envelope
      calls.push({ name, action, data, ...(envelope.knownRevision === undefined ? {} : { knownRevision: envelope.knownRevision }) })
      const wrap = response => {
        if (h.rawResponse || !READ_POLICIES[action] || !response.ok) return response
        const meta = { uid: h.uid, readVersion: 1, dataRevision: h.revision, unchanged: false }
        return { ...response, data: { ...meta, ...response.data } }
      }
      if (h.intercept) await h.intercept(action, data)
      if (h.respond) {
        const response = await h.respond(action, data)
        if (response !== undefined) return { result: wrap(response) }
      }
      let result
      if (action === 'transactions.commandResult') return { result: { ok: false, error: { code: 'OPERATION_UNCONFIRMED', message: '未确认' } } }
      if (action !== 'bootstrap' && READ_POLICIES[action] && envelope.knownRevision === h.revision) return { result: { ok: true, data: { readVersion: 1, uid: h.uid, dataRevision: h.revision, unchanged: true } } }
      if (action === 'reads.validate') result = {}
      else if (action === 'catalog.get') result = { categories: h.categories, accounts: h.accounts || accounts(), uid: h.uid }
      else if (action === 'bootstrap') result = { categories, uid: h.uid }
      else if (action === 'profile.get') result = { nickname: '测试用户' }
      else if (action === 'categories.list') result = { categories }
      else if (action === 'accounts.list') result = { accounts: h.accounts || accounts() }
      else if (action === 'dashboard.get') result = { accounts: accounts(), summary, netWorthMinor: balance, cashFlowTrend: [{ month: data.month, incomeMinor: '0', expenseMinor: '100' }], recentTransactions: [] }
      else if (action === 'transactions.list') result = { source: data.source || null, transactions: [transaction(data.search || (data.accountId ? data.accountId : data.cursor ? 'row-2' : 'row-1'))], nextCursor: data.cursor ? null : 'page-2', summary }
      else if (action === 'transactions.refundable') result = { transactions: [] }
      else if (action === 'statistics.get') result = { month: data.month, summary, cashFlowTrend: [{ month: data.trendEndMonth || data.month, incomeMinor: '0', expenseMinor: '100' }] }
      else { balance = '10100'; h.revision = String(Number(h.revision) + 1); result = { saved: true } }
      return { result: wrap({ ok: true, data: result }) }
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
  h.load = name => load(path.join(root, name + ".js"))
  h.wx = wx
  h.api = load(path.join(root, 'services/catledger-api.js'))
  h.importApi = load(path.join(root, 'services/catledger-import.js'))
  h.page = name => {
    if (pages.has(name)) return pages.get(name)
    const definition = load(path.join(root, 'pages', name, 'index.js'))
    const loading = []
    const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), route: "pages/" + name + "/index", getTabBar: () => null,
      setData(patch, callback) { if (Object.hasOwn(patch, 'loading')) loading.push(patch.loading)
        for (const [key, value] of Object.entries(patch)) {
          const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.data
          for (const k of keys.slice(0, -1)) target = target[k] || (target[k] = {})
          target[keys.at(-1)] = value
        }
        if (callback) callback()
      }, loading }
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

module.exports = { runtime }
