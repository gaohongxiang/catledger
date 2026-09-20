const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const { present } = require('./model')
Page({
  data: { pendingRepaymentCount:0,items: [], loading: false, hasLoaded: false, errorMessage: '', nextCursor: null, canPrevious: false },
  onLoad() { theme.bindPage(this); this._previous = []; this._cursor = null },
  onShow() { theme.bindPage(this); return loginGuard.run(this, () => this.loadLoans()) },
  onUnload() { pageReadSession.end(this) },
  onPullDownRefresh() { return this.firstPage().finally(() => wx.stopPullDownRefresh()) },
  loadLoans(force) {
    const current = pageReadSession.begin(this, ['pendingRepaymentCount','items','loading','hasLoaded','errorMessage','nextCursor','canPrevious'], ['_load','_cursor','_previous'])
    if (this._load) return this._load
    this.setData({ loading: true, errorMessage: '' })
    this._load = api.callApi('loans.list', { pageSize: 20, cursor: this._cursor || null }, { force: Boolean(force) })
      .then(result => { if (current()) this.setData({ pendingRepaymentCount:Number(result.pendingRepaymentCount || 0),items: result.items.map(present), nextCursor: result.nextCursor, hasLoaded: true, canPrevious: Boolean(this._previous && this._previous.length) }) })
      .catch(error => { if (current()) this.setData({ errorMessage: error.message || '贷款暂未加载，请重试' }) })
      .finally(() => { if (current()) { this._load = null; this.setData({ loading: false }) } })
    return this._load
  },
  firstPage() { if (this.data.loading) return this._load; this._cursor = null; this._previous = []; return this.loadLoans(true) },
  nextPage() { if (this.data.loading || !this.data.nextCursor) return; this._previous = (this._previous || []).concat([this._cursor || null]).slice(-5); this._cursor = this.data.nextCursor; return this.loadLoans() },
  previousPage() { if (this.data.loading || !this._previous || !this._previous.length) return; this._cursor = this._previous.pop(); return this.loadLoans() },
  openLoan(event) { wx.navigateTo({ url: '/pages/loan-detail/index?loanId=' + encodeURIComponent(event.currentTarget.dataset.id) }) },
  openUnassigned() { return loginGuard.run(this, () => wx.navigateTo({ url: '/pages/loan-link/index' })) },
  createLoan() { return loginGuard.run(this, () => wx.navigateTo({ url: '/pages/loan-form/index' })) }
})
