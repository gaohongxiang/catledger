const api = require('../../services/catledger-api')
const session = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const { candidateView, contextView, choiceView } = require('./model')
Page({
  data: { transactionId: '', context: null, items: [], loans: [], accounts: [], accountIndex: 0, month: '',
    loading: false, hasLoaded: false, errorMessage: '', nextCursor: null, canPrevious: false },
  onLoad(query) { this._transactionId = query && query.transactionId || ''; this.setData({ transactionId: this._transactionId }); theme.bindPage(this) },
  onShow() { theme.bindPage(this); return loginGuard.run(this, () => this.firstPage()) },
  onUnload() { session.end(this) },
  onPullDownRefresh() { return this.firstPage().finally(() => wx.stopPullDownRefresh()) },
  async load() {
    const current = session.begin(this, Object.keys(this.data), ['_cursor','_previous','_query'])
    const token = this._query = {}, month = this.data.month
    const selected = this.data.accounts[this.data.accountIndex], accountId = selected && selected.accountId || null
    const cursor = this._cursor || null
    this.setData({ loading: true, errorMessage: '' })
    const valid = () => current() && this._query === token
    try {
      if (this._transactionId) {
        const context = contextView(await api.callApi('loans.transaction', { transactionId: this._transactionId }, { force: true }))
        if (!valid()) return
        this.setData({ context, loans: [], nextCursor: null, hasLoaded: true })
        if (context.state !== 'candidate' || context.targetAccount.inactive) return
        const result = await api.callApi('loans.list', { accountId: context.targetAccount.accountId, pageSize: 20, cursor }, { force: true })
        if (!valid()) return
        this.setData({ loans: result.items.map(l => choiceView(l,context.transaction.occurredLocalAt.slice(0,10))), nextCursor: result.nextCursor })
      } else {
        const [result,catalog] = await Promise.all([
          api.callApi('loans.unassigned', { month: month || null, accountId, pageSize: 20, cursor }, { force: true }), api.callApi('catalog.get')])
        if (!valid()) return
        if (result.month !== (month || null) || result.accountId !== accountId || !Array.isArray(result.items)) throw new Error('还款筛选结果不完整，请重试')
        const accounts = [{ accountId: null, name: '全部借款账户' }].concat(catalog.accounts.filter(a => a.type === 'other_liability'))
        this.setData({ accounts, accountIndex: Math.max(0,accounts.findIndex(a => a.accountId === accountId)), items: result.items.map(candidateView),
          nextCursor: result.nextCursor, hasLoaded: true })
      }
      if (valid()) this.setData({ canPrevious: Boolean(this._previous && this._previous.length) })
    } catch (error) { if (valid()) this.setData({ errorMessage: error.message || '还款暂未读取，请重试' }) }
    finally { if (valid()) this.setData({ loading: false }) }
  },
  firstPage() { this._cursor = null; this._previous = []; this.setData({ nextCursor: null, canPrevious: false }); return this.load() },
  nextPage() { if (this.data.loading || !this.data.nextCursor) return; this._previous = (this._previous || []).concat([this._cursor || null]).slice(-5); this._cursor = this.data.nextCursor; return this.load() },
  previousPage() { if (this.data.loading || !this._previous || !this._previous.length) return; this._cursor = this._previous.pop(); return this.load() },
  changeMonth(event) { this.setData({ month: event.detail.value, items: [], hasLoaded: false }); return this.firstPage() },
  clearMonth() { this.setData({ month: '', items: [], hasLoaded: false }); return this.firstPage() },
  changeAccount(event) { this.setData({ accountIndex: Number(event.detail.value), items: [], hasLoaded: false }); return this.firstPage() },
  selectTransaction(event) { if (!this.data.loading) wx.navigateTo({ url: '/pages/loan-link/index?transactionId=' + encodeURIComponent(event.currentTarget.dataset.id) }) },
  selectLoan(event) {
    if (this.data.loading || this.data.errorMessage || !this.data.context || this.data.context.state !== 'candidate') return
    const loan = this.data.loans.find(l => l.loanId === event.currentTarget.dataset.id)
    if (!loan) return
    const target = loan.canLink ? 'repayment-entry' : 'loan-detail'
    wx.navigateTo({ url: '/pages/' + target + '/index?loanId=' + encodeURIComponent(loan.loanId) + (loan.canLink ? '&paymentId=' + encodeURIComponent(this.data.context.payment.paymentId) : '&sourceTransactionId=' + encodeURIComponent(this._transactionId)) })
  },
  createLoan() {
    if (this.data.loading || this.data.errorMessage || !this.data.context || this.data.context.state !== 'candidate' || this.data.context.targetAccount.inactive) return
    wx.navigateTo({ url: '/pages/loan-form/index?sourceTransactionId=' + encodeURIComponent(this._transactionId) + '&accountId=' + encodeURIComponent(this.data.context.targetAccount.accountId) + '&baselineDate=' + encodeURIComponent(this.data.context.transaction.occurredLocalAt.slice(0,10)) })
  },
  managePending() { if (this.data.context && this.data.context.payment) wx.navigateTo({ url:'/pages/repayment-entry/index?paymentId=' + encodeURIComponent(this.data.context.payment.paymentId) }) },
  openPayment() { if (this.data.context && this.data.context.linked) wx.navigateTo({ url: '/pages/loan-payment/index?paymentId=' + encodeURIComponent(this.data.context.payment.paymentId) }) }
})
