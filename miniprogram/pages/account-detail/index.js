const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')
const { decorateAccount } = require('../accounts/model')
const { present: presentLoan } = require('../loans/model')
const readCache = require('../../services/read-cache')

Page({
  data: {
    accountId: '',
    account: null,
    loading: false,
    saving: false,
    errorMessage: '',
    accountLoans: [], accountLoansLoading: false, accountLoansLoaded: false, accountLoansError: '', accountLoansMore: false, accountPendingCount: 0,
    formOpen: false,
    formMode: 'rename',
    formTitle: '修改账户名称',
    name: '',
    balanceYuan: '0.00'
  },

  onLoad: function (query) {
    themeService.bindPage(this)
    this.setData({ accountId: String(query && query.accountId || '') })
  },

  onShow: function () {
    themeService.bindPage(this)
    loginGuard.run(this, this.loadAccount.bind(this))
  },

  onUnload: function () { pageReadSession.end(this) },

  loadAccount: function (options) {
    const isCurrent = pageReadSession.begin(this, ['account', 'loading', 'errorMessage', 'accountLoans', 'accountLoansLoading', 'accountLoansLoaded', 'accountLoansError', 'accountLoansMore', 'accountPendingCount', 'formOpen', 'name', 'balanceYuan'], ['_readLoad', '_accountLoansToken'])
    if (this._readLoad) return this._readLoad
    const self = this
    const force = Boolean(options && options.force)
    this.setData({ loading: force || !api.isFresh('accounts.list'), errorMessage: '' })
    this._readLoad = api.callApi('accounts.list', {}, { force: force })
      .then(function (result) {
        if (!isCurrent()) return
        const account = (result.accounts || []).map(decorateAccount).find(function (item) { return item.accountId === self.data.accountId }) || null
        self.setData(Object.assign({ account: account, errorMessage: account ? '' : '账户不存在或已删除' }, account ? {} :
          { accountLoans: [], accountLoansLoaded: false, accountLoansMore: false, accountPendingCount: 0 }))
        if (account) return self.loadAccountLoans()
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '账户加载失败' })
      })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false })
        self._readLoad = null
      })
    return this._readLoad
  },

  recoverMutation: async function (error, fallback, isCurrent) {
    if (!isCurrent()) return
    if (this._readLoad) await this._readLoad
    if (!isCurrent()) return
    await this.loadAccount({ force: true })
    if (!isCurrent()) return
    this.setData({ errorMessage: error.message || fallback })
  },

  loadAccountLoans: function () {
    const account = this.data.account
    const token = this._accountLoansToken = {}
    if (!account || account.nature !== 'liability') return Promise.resolve()
    const current = pageReadSession.capture(this), accountId = account.accountId
    this.setData({ accountLoansLoading: true, accountLoansError: '' })
    const valid = () => current() && this._accountLoansToken === token && this.data.account && this.data.account.accountId === accountId
    return api.callApi('loans.list', { accountId, pageSize: 3, cursor: null }).then(result => {
      if (!valid()) return
      if (!Array.isArray(result.items) || result.items.some(loan => loan.accountId !== accountId)) throw new Error('贷款所属账户不一致，请重试')
      this.setData({ accountLoans: result.items.map(presentLoan), accountLoansLoaded: true,
        accountLoansMore: Boolean(result.nextCursor), accountPendingCount: Number(result.pendingRepaymentCount || 0) })
    }).catch(error => { if (valid()) this.setData({ accountLoansError: error.message || '贷款暂未读取，请重试' }) })
      .finally(() => { if (valid()) this.setData({ accountLoansLoading: false }) })
  },

  openAccountTransactions: function () {
    const account = this.data.account
    if (!account || !pageReadSession.isCurrent(this)) return
    getApp().globalData.transactionsAccountFilter = { accountId: account.accountId, name: account.name, session: readCache.getSession() }
    wx.switchTab({ url: '/pages/transactions/index' })
  },

  openAccountLoans: function () {
    const account = this.data.account
    if (account && account.nature === 'liability' && pageReadSession.isCurrent(this)) wx.navigateTo({ url: '/pages/loans/index?accountId=' + encodeURIComponent(account.accountId) })
  },

  openAccountLoan: function (event) {
    const account = this.data.account
    const loan = this.data.accountLoans.find(item => item.loanId === event.currentTarget.dataset.id)
    if (account && loan && loan.accountId === account.accountId && pageReadSession.isCurrent(this)) wx.navigateTo({ url: '/pages/loan-detail/index?loanId=' + encodeURIComponent(loan.loanId) })
  },

  createAccountLoan: function () {
    const account = this.data.account
    if (account && account.nature === 'liability' && !account.archived && pageReadSession.isCurrent(this)) wx.navigateTo({ url: '/pages/loan-form/index?accountId=' + encodeURIComponent(account.accountId) })
  },

  openRename: function () {
    const account = this.data.account
    if (!account || account.archived) return
    this.setData({ formOpen: true, formMode: 'rename', formTitle: '修改账户名称', name: account.name, balanceYuan: money.minorToYuan(account.displayBalanceMinor), errorMessage: '' })
  },

  openCorrection: function () {
    const account = this.data.account
    if (!account || account.archived) return
    this.setData({ formOpen: true, formMode: 'correct', formTitle: '校正账户余额', name: account.name, balanceYuan: money.minorToYuan(account.displayBalanceMinor), errorMessage: '' })
  },

  closeForm: function () {
    if (!this.data.saving) this.setData({ formOpen: false, errorMessage: '' })
  },

  stopBubble: function () {},
  bindName: function (event) { this.setData({ name: event.detail.value }) },
  bindBalance: function (event) { this.setData({ balanceYuan: event.detail.value }) },

  saveForm: function () {
    if (this.data.saving || !this.data.account) return
    let action
    let data
    try {
      if (this.data.formMode === 'rename') {
        action = 'accounts.update'
        data = { requestId: api.createRequestId(), accountId: this.data.account.accountId, version: this.data.account.version, name: this.data.name }
      } else {
        action = 'accounts.correctBalance'
        data = { requestId: api.createRequestId(), accountId: this.data.account.accountId, displayBalanceMinor: money.yuanToMinor(this.data.balanceYuan, { allowZero: true }), occurredLocalAt: time.today() + 'T' + time.currentClock() + ':00', timezoneOffsetMinutes: new Date().getTimezoneOffset() }
      }
    } catch (error) { this.setData({ errorMessage: error.message }); return }

    const self = this
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, errorMessage: '' })
    return api.callApi(action, data).then(function () {
      if (!isCurrent()) return
      wx.showToast({ title: '已保存', icon: 'success' })
      self.setData({ formOpen: false })
      self.loadAccount()
    }).catch(function (error) { return self.recoverMutation(error, '保存失败', isCurrent) })
      .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  },

  archive: function () {
    const account = this.data.account
    const self = this
    const isCurrent = pageReadSession.capture(this)
    if (!account || account.archived) return
    wx.showModal({
      title: '停用“' + account.name + '”？',
      content: '历史账目和余额仍会保留，但这个账户不能再用于新交易。',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (!result.confirm || !isCurrent()) return
        api.callApi('accounts.archive', { requestId: api.createRequestId(), accountId: account.accountId, version: account.version })
          .then(function () { if (!isCurrent()) return; wx.showToast({ title: '已停用', icon: 'success' }); self.loadAccount() })
          .catch(function (error) { return self.recoverMutation(error, '停用失败', isCurrent) })
      }
    })
  }
})
