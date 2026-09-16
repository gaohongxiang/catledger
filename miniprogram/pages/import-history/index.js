const api = require('../../services/catledger-import')
const catalogApi = require('../../services/catledger-api')
const pendingWrites = require('../../services/pending-ledger-write')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const { impactView } = require('../import-maintenance/model')
const sessionFields = ['items', 'nextCursor', 'busy', 'loaded', 'errorMessage', 'selected', 'preview', 'retryUndo']
function beginSession(page) { return pageReadSession.begin(page, sessionFields, ['_undoRequest', '_accounts']) }

function historyView(row) {
  const date = new Date(String(row.createdAt).replace(' ', 'T') + 'Z')
  const pad = value => String(value).padStart(2, '0')
  return Object.assign({}, row, { title: row.files[0] || '账单导入',
    timeText: Number.isNaN(date.getTime()) ? '' : date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) })
}
Page({
  data: { items: [], nextCursor: null, busy: false, loaded: false, errorMessage: '', selected: null, preview: null, retryUndo: false },
  onLoad: function () { theme.bindPage(this); loginGuard.run(this, this.load.bind(this)) },
  onShow: function () {
    theme.bindPage(this)
    if (this._readSession !== undefined && !pageReadSession.isCurrent(this)) {
      beginSession(this)
      loginGuard.run(this, this.load.bind(this))
    }
  },
  onUnload: function () { pageReadSession.end(this) },
  onPullDownRefresh: function () { this.refresh().finally(() => wx.stopPullDownRefresh()) },
  onReachBottom: function () { if (!this.data.busy && this.data.nextCursor && !this.data.selected) return this.load(true) },
  refresh: function () { return this.data.busy ? Promise.resolve() : this.load() },
  load: async function (append) {
    const isCurrent = beginSession(this)
    if (!getApp().hasLoginApproval()) return
    this.setData({ busy: true, errorMessage: '' })
    try {
      const catalog = await catalogApi.callApi('catalog.get')
      if (!isCurrent()) return
      this._accounts = catalog.accounts
      const result = await api.callImport('financeUpdates.list', { pageSize: 20, ...(append ? { cursor: this.data.nextCursor } : {}) })
      if (!isCurrent()) return
      this.setData({ items: (append ? this.data.items : []).concat(result.items.map(historyView)), nextCursor: result.nextCursor, loaded: true })
      const packet = pendingWrites.pending()
      if (packet && packet.target === 'import' && packet.action === 'financeUpdates.undo') {
        try {
          await pendingWrites.verify()
          if (!isCurrent()) return
          this._undoRequest = null
          this.setData({ retryUndo: false, selected: null, preview: null })
          return await this.load()
        } catch (error) {
          if (!isCurrent()) return
          this._undoRequest = packet.payload
          this.setData({ retryUndo: true, errorMessage: error.code === 'OPERATION_UNCONFIRMED' ? '上次撤销未收到结果，可继续确认所选导入。' : error.message })
        }
      }
    } catch (error) { if (isCurrent()) this.setData({ errorMessage: error.message || '导入记录加载失败' }) }
    finally { if (isCurrent()) this.setData({ busy: false }) }
  },
  previewUndo: function (event) {
    if (this.data.busy) return
    const selected = this.data.items.find(row => row.updateId === event.currentTarget.dataset.id)
    if (!selected || selected.status !== 'posted') return
    return this.showImpact(selected)
  },
  resumeUndo: async function () {
    if (this.data.busy || !this._undoRequest) return
    const isCurrent = pageReadSession.capture(this)
    const id = this._undoRequest.updateId
    let selected = this.data.items.find(row => row.updateId === id)
    if (!selected) {
      this.setData({ busy: true, errorMessage: '' })
      try {
        const summary = await api.readSummary(id)
        if (!isCurrent()) return
        selected = historyView(Object.assign({}, summary.update, { files: summary.sources.map(row => row.fileName) }))
      } catch (error) { if (isCurrent()) this.setData({ errorMessage: error.message }); return }
      finally { if (isCurrent()) this.setData({ busy: false }) }
    }
    if (isCurrent()) return this.showImpact(selected)
  },
  showImpact: async function (selected) {
    const isCurrent = pageReadSession.capture(this)
    this.setData({ busy: true, errorMessage: '', selected, preview: null })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    try {
      const result = await api.callImport('financeUpdates.undoImpact', { updateId: selected.updateId })
      if (isCurrent()) this.setData({ preview: impactView(result, this._accounts || []) })
    } catch (error) { if (isCurrent()) this.setData({ errorMessage: error.message }) }
    finally { if (isCurrent()) this.setData({ busy: false }) }
  },
  backToList: function () { if (!this.data.busy) this.setData({ selected: null, preview: null, errorMessage: '' }) },
  confirmUndo: async function () {
    if (this.data.busy || !this.data.preview || !this.data.preview.canUndo) return
    const isCurrent = pageReadSession.capture(this), preview = this.data.preview
    this.setData({ busy: true, errorMessage: '' })
    try {
      const choice = await new Promise((resolve, reject) => wx.showModal({ title: '撤销这次导入？',
        content: '将删除本次新增的 ' + preview.createdTransactionCount + ' 笔账目，保留复用的 ' + preview.reusedTransactionCount + ' 笔。撤销后可重新选择文件导入。',
        confirmText: '确认撤销', confirmColor: '#a95132', success: resolve, fail: reject }))
      if (!choice.confirm || !isCurrent()) return
      if (!this._undoRequest || this._undoRequest.updateId !== preview.update.updateId) this._undoRequest = { updateId: preview.update.updateId, version: preview.update.version, previewToken: preview.previewToken }
      await pendingWrites.send('import', 'financeUpdates.undo', this._undoRequest, { exact: true })
      if (!isCurrent()) return
      this._undoRequest = null
      this.setData({ selected: null, preview: null, retryUndo: false })
      getApp().globalData.ledgerRevision = (getApp().globalData.ledgerRevision || 0) + 1
      wx.showToast({ title: '本次导入已撤销', icon: 'success' })
      await this.load()
    } catch (error) {
      if (!isCurrent()) return
      const packet = pendingWrites.pending()
      if (packet && packet.action === 'financeUpdates.undo') this._undoRequest = packet.payload
      else this._undoRequest = null
      this.setData({ retryUndo: Boolean(this._undoRequest), errorMessage: error.code === 'CONFLICT' ? '账目已变化，请返回列表重新查看撤销范围。此次未撤销。' : error.message })
    } finally { if (isCurrent()) this.setData({ busy: false }) }
  },
  importAgain: function () { if (!this.data.busy) wx.redirectTo({ url: '/pages/import-workbench/index?fresh=1' }) }
})
