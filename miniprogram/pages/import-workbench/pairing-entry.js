const readCache = require('../../services/read-cache')
const { setChangedData } = require('../../services/view-patch')
const { SUGGESTED_PAGE_SIZE } = require('./pairing-review')

const owner = () => { const app = getApp(); return app.hasLoginApproval() ? app.globalData.uid || '' : '' }
function eligible(page) {
  const sources = (page.data.sources || []).map(source => source.sourceType)
  return Boolean(owner()) && page._viewActive && page._viewSession && page.data.update && page.data.update.status === 'review' &&
    page.data.currentStep === 3 && page.data.activeReviewTab === 'review' && page.data.activeReviewStatus === 'pending' &&
    sources.includes('bank') && sources.some(type => type === 'wechat' || type === 'alipay')
}
function current(page, token) {
  return eligible(page) && page._pairingEntryToken === token && page._viewSession === token.session &&
    page._viewEpoch === token.epoch && owner() === token.owner && readCache.getSession() === token.scope &&
    token.session.summary.viewVersion === token.version
}

module.exports = {
  cancelPairingEntry() {
    this._pairingEntryToken = null
    setChangedData(this, { pairingEntry: null })
  },
  loadPairingEntry() {
    if (!eligible(this)) { this.cancelPairingEntry(); return }
    const workbench = this._viewSession.summary.workbench || {}
    if (Object.prototype.hasOwnProperty.call(workbench, 'pairingSuggestedCount')) {
      // 摘要每次应用都读取，包括同版本新增字段；同时废弃旧服务端在途的入口读取。
      this._pairingEntryToken = null
      const total = workbench.pairingSuggestedCount
      const valid = Number.isSafeInteger(total) && total >= 0
      setChangedData(this, { pairingEntry: { total: valid ? total : null, loading: false, error: !valid } })
      return
    }
    if (this._pairingEntryToken && current(this, this._pairingEntryToken)) return this._pairingEntryToken.promise
    const session = this._viewSession
    const token = this._pairingEntryToken = { session, version: session.summary.viewVersion, epoch: this._viewEpoch,
      owner: owner(), scope: readCache.getSession() }
    setChangedData(this, { pairingEntry: { total: null, loading: true, error: false } })
    // 旧服务端兼容：与建议弹层首页共用有界缓存和在途请求，不读取原文或自行推算总数。
    token.promise = session.read('reviewIssues.pairings', { mode: 'suggested', pageSize: SUGGESTED_PAGE_SIZE }).then(result => {
      if (!current(this, token) || !session.active) return
      if (!Number.isSafeInteger(result.total) || result.total < 0) throw new Error('配对组数尚未核实')
      setChangedData(this, { pairingEntry: { total: result.total, loading: false, error: false } })
    }).catch(() => {
      if (current(this, token)) setChangedData(this, { pairingEntry: { total: null, loading: false, error: true } })
    })
    return token.promise
  },
  async openPairingEntry() {
    if (!eligible(this) || this.data.busy) return
    const epoch = this._viewEpoch, scope = readCache.getSession(), uid = owner(), updateId = this.data.update.updateId
    if (!this._viewSession.active) {
      this.cancelPairingEntry()
      await this.retryPagedView()
    }
    if (!eligible(this) || this._viewEpoch !== epoch || readCache.getSession() !== scope || owner() !== uid ||
        this.data.update.updateId !== updateId || !this._viewSession.active) return
    if (this.data.pairingEntry && this.data.pairingEntry.error) this._pairingEntryToken = null
    this.loadPairingEntry()
    return this.openPairingReview()
  }
}
