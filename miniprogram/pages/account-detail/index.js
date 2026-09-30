const api = require('../../services/catledger-api')
const pendingWrites = require('../../services/pending-ledger-write')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')
const { decorateAccount } = require('../accounts/model')
const { present: presentLoan } = require('../loans/model')
const billing = require('../../utils/account-billing')

Page({
  data: {
    accountId: '',
    account: null,
    loading: false,
    saving: false,
    errorMessage: '',
    accountStatusMessage: '',
    accountStatusRefresh: false,
    pendingAccountAction: '',
    accountLoans: [], accountLoansLoading: false, accountLoansLoaded: false, accountLoansError: '', accountLoansMore: false, accountPendingCount: 0,
    editingName: false,
    nameDraft: '',
    nameError: '',
    formOpen: false,
    balanceYuan: '0.00',
    billingSupported: false,
    editingBilling: '',
    editingBillingLabel: '',
    billingFieldDraft: '',
    billingFieldError: ''
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
  onHide: function () { pageReadSession.end(this); this._archiveConfirming = false; this.setData({ saving: false }) },

  loadAccount: function (options) {
    const isCurrent = pageReadSession.begin(this, ['account', 'loading', 'saving', 'errorMessage', 'accountStatusMessage', 'accountStatusRefresh', 'pendingAccountAction', 'accountLoans', 'accountLoansLoading', 'accountLoansLoaded', 'accountLoansError', 'accountLoansMore', 'accountPendingCount', 'editingName', 'nameDraft', 'nameError', 'formOpen', 'balanceYuan', 'billingSupported', 'editingBilling', 'billingFieldDraft', 'billingFieldError'], ['_readLoad', '_accountLoansToken'])
    if (this._readLoad) return this._readLoad
    const self = this
    const force = Boolean(options && options.force)
    let completedStatus = options && options.completedStatus || ''
    this.setData({ loading: force || !api.isFresh('accounts.list'), errorMessage: '' })
    this._readLoad = this.recoverAccountStatus(isCurrent).then(function (recoveredStatus) {
      completedStatus = completedStatus || recoveredStatus
      if (isCurrent()) return api.callApi('accounts.list', {}, { force: force || Boolean(completedStatus) })
    }).then(async function (result) {
        if (!isCurrent()) return
        const account = (result.accounts || []).map(decorateAccount).find(function (item) { return item.accountId === self.data.accountId }) || null
        if (self.data.accountStatusRefresh) self.setData({ accountStatusRefresh: false, accountStatusMessage: '' })
        self.setData(Object.assign({ account: account, billingSupported: result.liabilitySettingsVersion === 1, errorMessage: account ? '' : '账户不存在或已删除' }, account ? {} :
          { accountLoans: [], accountLoansLoaded: false, accountLoansMore: false, accountPendingCount: 0 }))
        if (account) await self.loadAccountLoans()
        return true
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData(completedStatus ? { errorMessage: '', accountStatusMessage: completedStatus + '，详情待刷新', accountStatusRefresh: true } : { errorMessage: error.message || '账户加载失败' })
        return false
      })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false })
        self._readLoad = null
      })
    return this._readLoad
  },

  pendingAccountStatus: function () {
    const packet = pendingWrites.pending()
    return packet && packet.target === 'api' && ['accounts.archive', 'accounts.restore'].includes(packet.action) &&
      packet.payload.accountId === this.data.accountId ? packet : null
  },

  recoverAccountStatus: async function (isCurrent) {
    if (!isCurrent()) return ''
    const packet = this.pendingAccountStatus()
    this.setData({ pendingAccountAction: packet ? packet.action : '' })
    if (!packet) return ''
    try {
      await pendingWrites.verify()
      if (!isCurrent()) return ''
      const status = packet.action === 'accounts.restore' ? '已恢复' : '已停用'
      this.setData({ pendingAccountAction: '', accountStatusMessage: status })
      return status
    } catch (error) {
      if (isCurrent()) this.setData({ accountStatusMessage: '上次账户操作结果待核实，请继续原操作', errorMessage: error.code === 'OPERATION_UNCONFIRMED' ? '' : error.message })
      return ''
    }
  },

  changeAccountStatus: async function (action, payload) {
    const account = this.data.account, isCurrent = pageReadSession.capture(this)
    if (!account || this.data.saving || !isCurrent()) return
    this.setData({ saving: true, errorMessage: '', accountStatusMessage: '' })
    try {
      await pendingWrites.send('api', action, payload || { accountId: account.accountId, version: account.version }, { exact: true, canSend: isCurrent })
      if (!isCurrent()) return
      const status = action === 'accounts.restore' ? '已恢复' : '已停用'
      this.setData({ pendingAccountAction: '', accountStatusMessage: status, editingName: false, editingBilling: '', formOpen: false })
      if (this._readLoad) await this._readLoad
      if (!isCurrent()) return
      await this.loadAccount({ force: true, completedStatus: status })
      if (isCurrent()) wx.showToast({ title: status, icon: 'success' })
    } catch (error) {
      if (!isCurrent()) return
      const pending = this.pendingAccountStatus()
      this.setData({ pendingAccountAction: pending ? pending.action : '', errorMessage: error.message || '账户操作失败',
        accountStatusMessage: pending ? '上次账户操作结果待核实，请继续原操作' : '' })
    } finally { if (isCurrent()) this.setData({ saving: false }) }
  },

  retryAccountStatus: function () {
    const packet = this.pendingAccountStatus()
    if (packet) return this.changeAccountStatus(packet.action, packet.payload)
    return this.loadAccount({ force: true })
  },

  restore: function () {
    if (!this.data.account || !this.data.account.archived) return
    if (this.data.accountStatusRefresh) return this.loadAccount({ force: true })
    if (this.pendingAccountStatus()) return this.retryAccountStatus()
    return this.changeAccountStatus('accounts.restore')
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
    wx.navigateTo({ url: '/pages/account-transactions/index?accountId=' + encodeURIComponent(account.accountId) })
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

  startEditName: function () {
    const account = this.data.account
    if (!account || account.archived || this.data.saving) return
    this.setData({ editingName: true, nameDraft: account.name, nameError: '' })
  },

  cancelEditName: function () {
    if (this.data.saving) return
    this.setData({ editingName: false, nameDraft: '', nameError: '' })
  },

  bindNameDraft: function (event) {
    if (this.data.saving) return
    this.setData({ nameDraft: String(event && event.detail && event.detail.value || ''), nameError: '' })
  },

  saveName: function () {
    const account = this.data.account
    if (this.data.saving || !account || account.archived || !this.data.editingName) return
    const name = String(this.data.nameDraft || '').trim()
    if (!name) {
      this.setData({ nameError: '名称不能为空' })
      return
    }
    if (name === account.name) {
      this.cancelEditName()
      return
    }
    const self = this
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, nameError: '' })
    return api.callApi('accounts.update', { requestId: api.createRequestId(), accountId: account.accountId, version: account.version, name: name })
      .then(function () {
        if (!isCurrent()) return
        wx.showToast({ title: '已保存', icon: 'success' })
        self.setData({ editingName: false, nameDraft: '' })
        self.loadAccount()
      })
      .catch(function (error) { return self.recoverName(error, isCurrent) })
      .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  },

  recoverName: async function (error, isCurrent) {
    if (!isCurrent()) return
    if (this._readLoad) await this._readLoad
    if (!isCurrent()) return
    await this.loadAccount({ force: true })
    if (!isCurrent()) return
    this.setData({ nameError: error.message || '保存失败' })
  },

  openCorrection: function () {
    const account = this.data.account
    if (!account || account.archived || account.nature !== 'asset') return
    this.setData({ formOpen: true, balanceYuan: money.minorToYuan(account.displayBalanceMinor), errorMessage: '' })
  },

  closeForm: function () {
    if (!this.data.saving) this.setData({ formOpen: false, errorMessage: '' })
  },

  stopBubble: function () {},
  bindBalance: function (event) { this.setData({ balanceYuan: event.detail.value }) },

  saveCorrection: function () {
    if (this.data.saving || !this.data.account || this.data.account.nature !== 'asset') return
    let data
    try {
      data = { requestId: api.createRequestId(), accountId: this.data.account.accountId, displayBalanceMinor: money.yuanToMinor(this.data.balanceYuan, { allowZero: true }), occurredLocalAt: time.today() + 'T' + time.currentClock() + ':00', timezoneOffsetMinutes: new Date().getTimezoneOffset() }
    } catch (error) { this.setData({ errorMessage: error.message }); return }

    const self = this
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, errorMessage: '' })
    return api.callApi('accounts.correctBalance', data).then(function () {
      if (!isCurrent()) return
      wx.showToast({ title: '已保存', icon: 'success' })
      self.setData({ formOpen: false })
      self.loadAccount()
    }).catch(function (error) { return self.recoverMutation(error, '保存失败', isCurrent) })
      .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  },

  startEditBilling: function (event) {
    const account = this.data.account, field = event.currentTarget.dataset.field
    if (!account || account.archived || account.nature !== 'liability' || this.data.saving || !['statementDay', 'repaymentDay', 'creditLimit'].includes(field)) return
    if (!this.data.billingSupported) { this.setData({ errorMessage: billing.UNAVAILABLE }); return }
    const draft = billing.draft(account)
    const value = field === 'creditLimit' ? draft.creditLimitYuan : (draft[field] ? String(draft[field]) : '')
    this.setData({ editingBilling: field, editingBillingLabel: { statementDay: '账单日', repaymentDay: '还款日', creditLimit: '信用额度' }[field], billingFieldDraft: value, billingFieldError: '', errorMessage: '' })
  },

  cancelEditBilling: function () { if (!this.data.saving) this.setData({ editingBilling: '', billingFieldError: '' }) },

  bindBillingField: function (event) { this.setData({ billingFieldDraft: event.detail.value, billingFieldError: '' }) },

  saveBillingField: function () {
    const account = this.data.account, field = this.data.editingBilling
    if (this.data.saving || !field || !account || account.archived) return
    const draft = billing.draft(account)
    if (field === 'creditLimit') draft.creditLimitYuan = this.data.billingFieldDraft
    else {
      const raw = String(this.data.billingFieldDraft).trim()
      if (raw && !/^\d{1,2}$/.test(raw)) { this.setData({ billingFieldError: '请选择每月 1 至 31 日，或未设置' }); return }
      draft[field] = raw ? Number(raw) : 0
    }
    let fields
    try { fields = billing.payload(draft) } catch (error) { this.setData({ billingFieldError: error.message }); return }
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, billingFieldError: '' })
    return api.callApi('accounts.update', { requestId: api.createRequestId(), accountId: account.accountId, version: account.version, ...fields })
      .then(result => {
        if (!isCurrent()) return
        billing.assertSaved(result, fields)
        this.setData({ editingBilling: '' })
        wx.showToast({ title: '已保存', icon: 'success' })
        return this.loadAccount({ force: true })
      }).catch(error => { if (isCurrent()) this.setData({ billingFieldError: error.message || '保存失败，请重试' }) })
      .finally(() => { if (isCurrent()) this.setData({ saving: false }) })
  },

  archive: function () {
    const account = this.data.account
    const self = this
    const isCurrent = pageReadSession.capture(this)
    if (!account || account.archived || this.data.saving || this._archiveConfirming || !isCurrent()) return
    if (this.data.accountStatusRefresh) return this.loadAccount({ force: true })
    if (this.pendingAccountStatus()) return this.retryAccountStatus()
    const confirmation = this._archiveConfirming = {}
    return new Promise(resolve => wx.showModal({
      title: '停用“' + account.name + '”？',
      content: account.balanceLabel + ' ' + account.balanceText + ' 和历史账目会保留。停用后不能新增交易、转账或记录贷款还款，账户资料也不能修改；已有欠款及贷款本金不会清零。以后可在已停用账户详情点“恢复使用”，恢复时不补息，也不改变自动记费授权。',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (self._archiveConfirming === confirmation) self._archiveConfirming = false
        if (!result.confirm || !isCurrent()) { resolve(); return }
        resolve(self.changeAccountStatus('accounts.archive', { accountId: account.accountId, version: account.version }))
      },
      fail: function () { if (self._archiveConfirming === confirmation) self._archiveConfirming = false; resolve() }
    }))
  }
})
