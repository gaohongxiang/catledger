const api = require('../../services/catledger-import')
const catalogApi = require('../../services/catledger-api')
const readCache = require('../../services/read-cache')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const sessionFields = ['items', 'nextCursor', 'busy', 'loaded', 'errorMessage']
function beginSession(page) { return pageReadSession.begin(page, sessionFields, []) }

function historyView(row) {
  const date = new Date(String(row.createdAt).replace(' ', 'T') + 'Z')
  const pad = value => String(value).padStart(2, '0')
  return Object.assign({}, row, { title: row.files[0] || '账单导入',
    timeText: Number.isNaN(date.getTime()) ? '' : date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) })
}
Page({
  data: { items: [], nextCursor: null, busy: false, loaded: false, errorMessage: '' },
  onLoad: function () { theme.bindPage(this); loginGuard.run(this, this.load.bind(this)) },
  onShow: function () {
    theme.bindPage(this)
    if (this._readSession !== undefined) {
      if (!pageReadSession.isCurrent(this)) beginSession(this)
      loginGuard.run(this, this.refresh.bind(this))
    }
  },
  onUnload: function () { pageReadSession.end(this) },
  onPullDownRefresh: function () { this.refresh().finally(() => wx.stopPullDownRefresh()) },
  onReachBottom: function () { if (!this.data.busy && this.data.nextCursor) return this.load(true) },
  refresh: function () { return this.data.busy ? Promise.resolve() : this.load() },
  load: async function (append) {
    const isCurrent = beginSession(this)
    if (!getApp().hasLoginApproval()) return
    this.setData({ busy: true, errorMessage: '' })
    try {
      await catalogApi.callApi('catalog.get')
      if (!isCurrent()) return
      const result = await api.callImport('financeUpdates.list', { pageSize: 20, ...(append ? { cursor: this.data.nextCursor } : {}) })
      if (!isCurrent()) return
      this.setData({ items: (append ? this.data.items : []).concat(result.items.map(historyView)), nextCursor: result.nextCursor, loaded: true })
    } catch (error) { if (isCurrent()) this.setData({ errorMessage: error.message || '导入记录加载失败' }) }
    finally { if (isCurrent()) this.setData({ busy: false }) }
  },
  viewTransactions: function (event) {
    if (this.data.busy || !pageReadSession.isCurrent(this)) return
    const selected = this.data.items.find(row => row.updateId === event.currentTarget.dataset.id)
    if (!selected) return
    getApp().globalData.transactionsImportFilter = { updateId: selected.updateId, title: selected.title, session: readCache.getSession() }
    wx.switchTab({ url: '/pages/transactions/index' })
  },
  importAgain: function () { if (!this.data.busy) wx.redirectTo({ url: '/pages/import-workbench/index?fresh=1' }) }
})
