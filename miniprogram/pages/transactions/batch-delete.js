const api = require('../../services/catledger-api')
const pendingWrites = require('../../services/pending-ledger-write')
const pageReadSession = require('../../services/page-read-session')

function selectable(row) {
  return row.origin === 'manual' && row.editable && ['income', 'expense', 'transfer', 'refund'].indexOf(row.type) >= 0
}
module.exports = {
  canSelect: selectable,
  resetSelection: function () {
    this.setData({ selectedCount: 0, transactions: this.data.transactions.map(row => Object.assign({}, row, { selected: false })) })
  },
  toggleSelection: function () {
    if (this.data.deleting || this.data.deleteRetryCount) return
    this.resetSelection()
    this.setData({ selectionMode: !this.data.selectionMode })
  },
  selectTransaction: function (index) {
    if (this.data.deleting || this.data.deleteRetryCount) return
    const row = this.data.transactions[index]
    if (!row || !selectable(row)) return
    if (!row.selected && this.data.selectedCount >= 100) return wx.showToast({ title: '一次最多选择 100 笔', icon: 'none' })
    const patch = { selectedCount: this.data.selectedCount + (row.selected ? -1 : 1) }
    patch['transactions[' + index + '].selected'] = !row.selected
    this.setData(patch)
  },
  selectLoaded: function () {
    if (this.data.deleting || this.data.deleteRetryCount) return
    const rows = this.data.transactions, eligible = rows.filter(selectable)
    const clear = this.data.selectedCount === Math.min(eligible.length, 100)
    let count = 0
    this.setData({ transactions: rows.map(row => {
      const selected = !clear && selectable(row) && count < 100
      if (selected) count++
      return Object.assign({}, row, { selected })
    }), selectedCount: clear ? 0 : Math.min(eligible.length, 100) })
    if (!clear && eligible.length > 100) wx.showToast({ title: '已选择前 100 笔', icon: 'none' })
  },
  recoverBatchDelete: async function () {
    const isCurrent = pageReadSession.capture(this)
    const packet = pendingWrites.pending()
    if (!packet || packet.target !== 'api' || packet.action !== 'transactions.deleteMany') return
    this._batchRequest = packet.payload
    try {
      await pendingWrites.verify()
      if (!isCurrent()) return
      this._batchRequest = null
      this.setData({ deleteRetryCount: 0 })
      await this.loadTransactions(false, { force: true })
    } catch (error) {
      if (isCurrent()) this.setData({ deleteRetryCount: packet.payload.items.length,
        errorMessage: error.code === 'OPERATION_UNCONFIRMED' ? '上次删除未收到结果，可点击“继续删除”确认。' : error.message })
    }
  },
  deleteSelected: async function () {
    if (this.data.deleting || this.data.loading) return
    const isCurrent = pageReadSession.capture(this)
    const request = this.data.deleteRetryCount ? this._batchRequest : {
      items: this.data.transactions.filter(row => row.selected && selectable(row))
        .map(row => ({ transactionId: row.transactionId, version: row.version })).sort((a, b) => a.transactionId.localeCompare(b.transactionId))
    }
    if (!request || !request.items.length) return
    this.setData({ deleting: true, errorMessage: '' })
    try {
      const choice = await new Promise((resolve, reject) => wx.showModal({ title: '删除 ' + request.items.length + ' 笔账目？',
        content: '将删除选中的手动账目，并重新计算余额和统计。删除后无法恢复。', confirmText: '确认删除', confirmColor: '#a95132', success: resolve, fail: reject }))
      if (!choice.confirm || !isCurrent()) return
      await api.callApi('catalog.get')
      if (!isCurrent()) return
      const result = await pendingWrites.send('api', 'transactions.deleteMany', request, { exact: true })
      if (!isCurrent()) return
      this._batchRequest = null
      this.setData({ selectionMode: false, selectedCount: 0, deleteRetryCount: 0 })
      getApp().globalData.ledgerRevision = (getApp().globalData.ledgerRevision || 0) + 1
      wx.showToast({ title: '已删除 ' + result.result.deletedCount + ' 笔', icon: 'success' })
      await this.loadTransactions(false, { force: true })
    } catch (error) {
      if (!isCurrent()) return
      let packet
      try { packet = pendingWrites.pending() } catch (_) {}
      if (packet && packet.action === 'transactions.deleteMany') {
        this._batchRequest = packet.payload
        this.setData({ deleteRetryCount: packet.payload.items.length })
      } else { this._batchRequest = null; this.setData({ deleteRetryCount: 0 }) }
      this.setData({ errorMessage: error.code === 'REFUNDED_TRANSACTION_LOCKED' ? '选中的消费还有退款，请把对应退款一起选中后删除。'
        : error.code === 'CONFLICT' ? '部分账目已被修改，请刷新后重新选择。此次未删除任何账目。' : error.message || '删除未完成，请重试' })
    } finally { if (isCurrent()) this.setData({ deleting: false }) }
  },
  openImportHistory: function () { if (!this.data.deleting) wx.navigateTo({ url: '/pages/import-history/index' }) }
}
