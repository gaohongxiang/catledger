const { publicError } = require('./presentation')
const presentation = require('./presentation')
const { errorText, direction } = require('./presentation')
const api = require('../../services/catledger-import')
const drafts = require('../../services/import-draft-session')
const readCache = require('../../services/read-cache')
const { buildFinalDetail, TITLES: FINAL_DETAIL_TITLES } = require('./final-detail')

module.exports = {
  viewTransactions: function () {
    wx.switchTab({ url: '/pages/transactions/index' })
  },

  viewStatistics: function () {
    wx.switchTab({ url: '/pages/statistics/index' })
  },

  completeCategories: function () {
    getApp().globalData.openStatisticsCompletion = true
    wx.switchTab({ url: '/pages/statistics/index', fail: function () { getApp().globalData.openStatisticsCompletion = false } })
  },

  correctBalances: function () {
    wx.navigateTo({ url: '/pages/accounts/index' })
  },

  openInstallmentSources: function () {
    wx.navigateTo({ url: '/pages/installment-sources/index' })
  },

  backFinalDetail: function () {
    if (this.data.finalDetailParent) this.setData({ finalDetailSheet: this.prepareFinalDetail(this.data.finalDetailParent), finalDetailParent: null })
    else this.closeFinalDetail()
  },

  prepareFinalDetail: function (kind, accountId, index) {
    this._finalDetail = buildFinalDetail(kind, this.businessData(), accountId)
    return presentation.detailWindow(this._finalDetail, index)
  },

  closeFinalDetail: function () {
    if (this._finalPager) this._finalPager.cancel()
    this._finalPager = null
    this._finalDetail = null; this.setData({ finalDetailSheet: null, finalDetailParent: null })
    this.applyPendingBackgroundView()
  },

  abandonUpdate: function () {
    const self = this
    if (this.data.busy || !this.data.update || !['draft', 'failed', 'review'].includes(this.data.update.status)) return
    wx.showModal({
        title: '放弃本批账单？',
        content: '本批的账户选择和整理结果会被放弃。正式账户、余额、交易和统计都不会改变。',
        confirmText: '确认放弃',
        confirmColor: '#b54738',
        success: function (result) {
          if (!result.confirm) return
          self.performAbandonUpdate()
        }
      })
  },

  performAbandonUpdate: async function () {
    if (this.data.busy || !this.data.update) return
    this.setData({ busy: true, errorMessage: '', currentIssue: null })
    try {
      if (this._draftSession) {
        await this._draftSession.pause()
        const fresh = await this.request('financeUpdates.summary', { updateId: this.data.update.updateId })
        this.setData({ update: fresh.update })
      }
      await this.request('financeUpdates.abandon', {
          requestId: api.createRequestId(),
          updateId: this.data.update.updateId,
          version: this.data.update.version
        })
      this.startAnother()
      wx.showToast({ title: '本批账单已放弃', icon: 'none' })
    } catch (error) {
      if (this._draftSession) this._draftSession.resume()
      this.setData({ busy: false, errorMessage: publicError(error, '放弃失败，请重试') })
    }
  },

  openImportHistory: function () {
    if (!this.data.busy) wx.navigateTo({ url: '/pages/import-history/index' })
  },

  openFinalDetail: async function (event) {
    const kind = event.currentTarget.dataset.kind
    const accountId = event.currentTarget.dataset.id
    const filter = { status: 'ready' }
    let action = 'economicEvents.list'
    if (['new_accounts', 'affected_accounts'].includes(kind)) { action = 'financeUpdates.options'; filter.kind = kind; delete filter.status }
    else if (kind === 'account') filter.accountId = accountId
    else if (['categorized', 'uncategorized', 'no_category'].includes(kind)) filter.view = { categorized: 'category_completed', uncategorized: 'category_pending', no_category: 'category_none' }[kind]
    else if (kind === 'expense') filter.view = 'expense'
    else if (kind !== 'all') filter.economicNature = kind
    this._finalKind = { kind, accountId }
    this._finalPager = this._viewSession.pager(action, filter)
    const title = kind === 'account'
    ? ((this.businessData().accounts || []).concat(this.businessData().accountDrafts || [])
      .find(account => account.accountId === accountId) || {}).name || FINAL_DETAIL_TITLES.account
    : FINAL_DETAIL_TITLES[kind]
    this.setData({ finalDetailSheet: { kind, title: title || FINAL_DETAIL_TITLES.all, count: 0, records: [], accounts: [], loading: true }, finalDetailParent: null })
    return this.changeFinalPage(event)
  },

  changeFinalPage: async function (event) {
    const pager = this._finalPager, target = this._finalKind
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._finalPager || !this.data.finalDetailSheet) return
      let sheet
      if (['new_accounts', 'affected_accounts'].includes(target.kind)) sheet = { kind: target.kind, title: target.kind === 'new_accounts' ? '新建账户' : '受影响账户', mode: 'accounts', accounts: response.items, records: [] }
      else sheet = buildFinalDetail(target.kind, Object.assign({}, this.businessData(), { events: response.items }), target.accountId)
      this._finalDetail = null
      this.setData({ finalDetailSheet: Object.assign({}, sheet, { count: response.total, records: (sheet.records || []).map(presentation.record), page: response.page, loading: false }), finalDetailScrollTop: 0 })
    } catch (error) { if (pager === this._finalPager) this.setData({ 'finalDetailSheet.loading': false, errorMessage: errorText(error) }) }
  },

  openFinalAccount: function (event) {
    return this.openFinalDetail({ currentTarget: { dataset: { kind: 'account', id: event.currentTarget.dataset.id } } })
  },

  postUpdate: async function () {
    if (!this._viewActive || !getApp().hasLoginApproval() || this.data.busy || !this._draftSession) return
    const session = this._draftSession
    const operation = this._postOperation = { epoch: this._viewEpoch, scope: readCache.getSession(), updateId: session.view.update.updateId }
    const active = () => this._viewActive && getApp().hasLoginApproval() && readCache.getSession() === operation.scope &&
      this._viewEpoch === operation.epoch && this._postOperation === operation && this.data.update && this.data.update.updateId === operation.updateId
    this.setData({ busy: true, errorMessage: '' })
    try {
      if (!session.state.postFlight) {
        await session.flush()
        if (!active()) return
        this.applyUpdateView(session.view, true)
        if (!session.view.coverage.selectedEventsReadyToPost) { this.setData({ errorMessage: '请完成剩余核对后再入账' }); return }
      }
      this.setData({ busy: true })
      const receipt = await session.post()
      if (!active()) return
      if (this._unsubscribeDraft) this._unsubscribeDraft()
      session.clear(); drafts.forgetLast(); this._draftSession = null
      this.applyUpdateView(receipt)
      try {
        const summary = await api.readSummary(receipt.update.updateId)
        if (active()) this.applyUpdateView(summary)
      } catch (error) { /* 已入账状态保留，用户可独立刷新。 */ }
    } catch (error) {
      if (active() && error.code === 'HISTORY_REVIEW_REQUIRED') {
        await this.loadUpdate(session.view.update.updateId, false)
        if (active() && this.data.phase !== 'error') this.setStep({ currentStep: 3, errorMessage: errorText(error) })
      } else if (active()) this.setData({ errorMessage: errorText(error) })
    }
    finally { if (active()) this.setData({ busy: false }) }
  }
}
