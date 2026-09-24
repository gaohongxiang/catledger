const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const { present } = require('./model')
Page({
  data: { scoped: false, scopeAccount: null, pendingInstallmentCount: 0, pendingRepaymentCount: 0, items: [], loading: false, hasLoaded: false, errorMessage: '', nextCursor: null, canPrevious: false },
  onLoad(query) { this._accountId = query && query.accountId || ''; this.setData({ scoped: Boolean(this._accountId) }); theme.bindPage(this); this._previous = []; this._cursor = null },
  onShow() {
    theme.bindPage(this)
    return loginGuard.run(this, () => {
      if (this.data.hasLoaded && !api.isFresh('loans.list', this.loanQuery())) { this._cursor = null; this._previous = [] }
      return this.loadLoans()
    })
  },
  onUnload() { pageReadSession.end(this) },
  onPullDownRefresh() { return this.firstPage().finally(() => wx.stopPullDownRefresh()) },
  loanQuery() { return Object.assign({ pageSize: 20, cursor: this._cursor || null }, this._accountId ? { accountId: this._accountId } : {}) },
  loadLoans(force) {
    const current = pageReadSession.begin(this, Object.keys(this.data), ['_load','_cursor','_previous'])
    if (this._load) return this._load
    this.setData({ loading: true, errorMessage: '' })
    this._load = (async () => {
      if (this._accountId) {
        const catalog = await api.callApi('catalog.get', {}, { force: Boolean(force) })
        if (!current()) return
        const account = catalog.accounts.find(item => item.accountId === this._accountId && ['credit', 'other_liability'].includes(item.type))
        if (!account) { this.setData({ scopeAccount: null, items: [], hasLoaded: false, pendingRepaymentCount: 0, nextCursor: null }); throw new Error('此负债账户不可用，请返回账户管理') }
        this.setData({ scopeAccount: account })
      }
      if (!current()) return
      const [result, sources] = await Promise.all([api.callApi('loans.list', this.loanQuery(), { force: Boolean(force) }), api.callApi('loans.installmentSources', { ...(this._accountId ? { accountId: this._accountId } : {}), pageSize: 20 }, { force: Boolean(force) })])
      if (!current()) return
      if (this._accountId && result.items.some(item => item.accountId !== this._accountId)) throw new Error('贷款所属账户不一致，请重试')
      this.setData({ pendingInstallmentCount: sources.items.length, pendingRepaymentCount: Number(result.pendingRepaymentCount || 0), items: result.items.map(present), nextCursor: result.nextCursor, hasLoaded: true, canPrevious: Boolean(this._previous && this._previous.length) })
    })().catch(error => { if (current()) this.setData({ errorMessage: error.message || '贷款暂未加载，请重试' }) })
      .finally(() => { if (current()) { this._load = null; this.setData({ loading: false }) } })
    return this._load
  },
  firstPage() { if (this.data.loading) return this._load || Promise.resolve(); this._cursor = null; this._previous = []; return this.loadLoans(true) },
  nextPage() { if (this.data.loading || !this.data.nextCursor) return; this._previous = (this._previous || []).concat([this._cursor || null]).slice(-5); this._cursor = this.data.nextCursor; return this.loadLoans() },
  previousPage() { if (this.data.loading || !this._previous || !this._previous.length) return; this._cursor = this._previous.pop(); return this.loadLoans() },
  openLoan(event) { if (this.data.items.some(item => item.loanId === event.currentTarget.dataset.id)) wx.navigateTo({ url: '/pages/loan-detail/index?loanId=' + encodeURIComponent(event.currentTarget.dataset.id) }) },
  openUnassigned() { return loginGuard.run(this, () => wx.navigateTo({ url: '/pages/loan-link/index' + (this._accountId ? '?accountId=' + encodeURIComponent(this._accountId) : '') })) },
  openInstallmentSources() { wx.navigateTo({ url: '/pages/installment-sources/index' + (this._accountId ? '?accountId=' + encodeURIComponent(this._accountId) : '') }) },
  createLoan() {
    if (this.data.loading || (this._accountId && (!this.data.scopeAccount || this.data.scopeAccount.archived))) return
    return loginGuard.run(this, () => wx.navigateTo({ url: '/pages/loan-form/index' + (this._accountId ? '?accountId=' + encodeURIComponent(this._accountId) : '') }))
  }
})
