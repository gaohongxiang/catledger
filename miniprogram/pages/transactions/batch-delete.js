const api = require('../../services/catledger-api')
const pendingWrites = require('../../services/pending-ledger-write')
const pageReadSession = require('../../services/page-read-session')
const deleteFeedback = require('./delete-feedback')

async function refreshDeletedList(page, isCurrent) {
  try { await page.loadTransactions(false, { force: true }) }
  catch (_) { if (isCurrent()) page.setData({ errorMessage: deleteFeedback.refreshMessage }) }
  if (isCurrent() && page.data.errorMessage) page.setData({ errorMessage: deleteFeedback.refreshMessage })
}

function selectable(row) {
  return ['manual', 'import'].indexOf(row.origin) >= 0 && ['income', 'expense', 'transfer', 'refund'].indexOf(row.type) >= 0
}
// 分段更新勾选标记，避免整份列表一次 setData 超出原生传输大小。
function selectRange(page, start, selected) {
  let count = 0
  for (let offset = start; offset < page.data.transactions.length; offset += 100) {
    const patch = {}
    page.data.transactions.slice(offset, offset + 100).forEach((row, index) => {
      const value = selected && selectable(row)
      if (value) count++
      if (Boolean(row.selected) !== value) patch['transactions[' + (offset + index) + '].selected'] = value
    })
    if (Object.keys(patch).length) page.setData(patch)
  }
  return count
}
module.exports = {
  canSelect: selectable,
  resetSelection: function () {
    this._selectionEpoch = (this._selectionEpoch || 0) + 1
    selectRange(this, 0, false)
    this.setData({ selectedCount: 0, allSelected: false, selectingAll: false })
  },
  toggleSelection: function () {
    if (this.data.deleting || this.data.selectingAll || this.data.loading || this.data.deleteRetryCount) return
    this.resetSelection()
    this.setData({ selectionMode: !this.data.selectionMode })
  },
  selectTransaction: function (index) {
    if (this.data.deleting || this.data.selectingAll || this.data.deleteRetryCount) return
    const row = this.data.transactions[index]
    if (!row || !selectable(row)) return
    const count = this.data.selectedCount + (row.selected ? -1 : 1)
    const patch = { selectedCount: count, allSelected: count > 0 && !this.data.nextCursor && count === this.data.transactions.filter(selectable).length }
    patch['transactions[' + index + '].selected'] = !row.selected
    this.setData(patch)
  },
  selectAll: async function () {
    if (this.data.deleting || this.data.selectingAll || this.data.loading || this.data.loadingMore || this.data.deleteRetryCount) return
    if (this.data.allSelected) return this.resetSelection()
    const isCurrent = pageReadSession.capture(this), epoch = this._selectionEpoch
    const current = () => isCurrent() && this._selectionEpoch === epoch
    this.setData({ selectingAll: true, errorMessage: '' })
    try {
      let count = selectRange(this, 0, true)
      this.setData({ selectedCount: count, allSelected: count > 0 && !this.data.nextCursor })
      while (current() && this.data.nextCursor) {
        const cursor = this.data.nextCursor
        const start = this.data.transactions.length
        await this.loadTransactions(true)
        if (!current()) return
        count += selectRange(this, start, true)
        this.setData({ selectedCount: count, allSelected: count > 0 && !this.data.nextCursor })
        if (cursor === this.data.nextCursor) break
      }
    } finally { if (current()) this.setData({ selectingAll: false }) }
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
      this.resetSelection()
      this.setData({ deleteRetryCount: 0 })
    } catch (error) {
      if (isCurrent()) this.setData({ deleteRetryCount: packet.payload.items.length,
        errorMessage: error.code === 'OPERATION_UNCONFIRMED' ? '上次删除未收到结果，可点击“继续删除”确认。' : deleteFeedback.failureMessage(error) })
      return
    }
    deleteFeedback.markDeleted(getApp())
    await refreshDeletedList(this, isCurrent)
  },
  deleteSelected: async function () {
    if (this.data.deleting || this.data.selectingAll || this.data.loading) return
    const isCurrent = pageReadSession.capture(this)
    const request = this.data.deleteRetryCount ? this._batchRequest : {
      items: this.data.transactions.filter(row => row.selected && selectable(row))
        .map(row => ({ transactionId: row.transactionId, version: row.version })).sort((a, b) => a.transactionId.localeCompare(b.transactionId))
    }
    if (!request || !request.items.length) return
    const retry = Boolean(this.data.deleteRetryCount)
    let deleted = false
    this.setData({ deleting: true, errorMessage: '' })
    try {
      if (!retry) {
        const choice = await new Promise((resolve, reject) => wx.showModal({ title: '删除 ' + request.items.length + ' 笔账目？',
          content: deleteFeedback.confirmation, confirmText: '确认删除', confirmColor: '#a95132', success: resolve, fail: reject }))
        if (!choice.confirm || !isCurrent()) return
      }
      await api.callApi('catalog.get')
      if (!isCurrent()) return
      const result = await pendingWrites.send('api', 'transactions.deleteMany', request, { exact: true })
      if (!isCurrent()) return
      this._batchRequest = null
      this.resetSelection()
      this.setData({ selectionMode: false, selectedCount: 0, deleteRetryCount: 0 })
      deleted = true
      deleteFeedback.markDeleted(getApp())
      getApp().globalData.ledgerRevision = (getApp().globalData.ledgerRevision || 0) + 1
      wx.showToast({ title: '已删除 ' + result.result.deletedCount + ' 笔', icon: 'success' })
    } catch (error) {
      if (!isCurrent()) return
      let packet
      try { packet = pendingWrites.pending() } catch (_) {}
      if (packet && packet.action === 'transactions.deleteMany') {
        this._batchRequest = packet.payload
        this.setData({ deleteRetryCount: packet.payload.items.length })
      } else { this._batchRequest = null; this.setData({ deleteRetryCount: 0 }) }
      this.setData({ errorMessage: deleteFeedback.failureMessage(error) })
    } finally { if (isCurrent()) this.setData({ deleting: false }) }
    if (deleted && isCurrent()) await refreshDeletedList(this, isCurrent)
  }
}
