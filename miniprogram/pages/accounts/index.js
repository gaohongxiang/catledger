const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')
const { buildAccountsView } = require('./model')
const billing = require('../../utils/account-billing')

const TYPE_OPTIONS = [
  { value: 'cash', label: '现金' },
  { value: 'bank', label: '银行卡' },
  { value: 'wallet', label: '平台钱包' },
  { value: 'credit', label: '信用卡/消费信贷' },
  { value: 'other_asset', label: '其他资产' },
  { value: 'other_liability', label: '其他负债' }
]

Page({
  data: {
    loading: false,
    hasLoaded: false,
    saving: false,
    errorMessage: '',
    assets: [],
    liabilities: [],
    archivedAccounts: [],
    assetCorrectionCount: 0,
    archivedExpanded: false,
    totals: { netWorthText: '¥0.00', assetsText: '¥0.00', liabilitiesText: '¥0.00' },
    formOpen: false,
    formMode: 'create',
    formTitle: '创建账户',
    typeOptions: TYPE_OPTIONS,
    typeIndex: 0,
    name: '',
    balanceYuan: '0.00',
    isLiability: false,
    billingSupported: false,
    billingDays: billing.DAY_OPTIONS,
    billingDraft: billing.draft()
  },

  onLoad: function () { themeService.bindPage(this) },

  onShow: function () {
    themeService.bindPage(this)
    loginGuard.run(this, this.loadAccounts.bind(this))
  },

  onUnload: function () { pageReadSession.end(this) },

  onHide: function () { this.setTabBarHidden(false) },

  setTabBarHidden: function (hidden) {
    if (this.getTabBar()) this.getTabBar().setData({ hidden: hidden })
  },

  loadAccounts: function (options) {
    const isCurrent = pageReadSession.begin(this, ['loading', 'hasLoaded', 'saving', 'errorMessage', 'assets', 'liabilities', 'archivedAccounts', 'totals', 'formOpen', 'name', 'balanceYuan', 'isLiability', 'billingSupported', 'billingDraft'], ['_readLoad'])
    if (this._readLoad) return this._readLoad
    const self = this
    const force = Boolean(options && options.force)
    this.setData({ loading: force || !api.isFresh('accounts.list'), errorMessage: '' })
    this._readLoad = api.callApi('accounts.list', {}, { force: force })
      .then(function (result) {
        if (!isCurrent()) return
        self.setData(Object.assign({ hasLoaded: true, billingSupported: result.liabilitySettingsVersion === 1 }, buildAccountsView(result.accounts)))
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '账户加载失败' }) })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false }); self._readLoad = null })
    return this._readLoad
  },

  recoverMutation: async function (error, fallback, isCurrent) {
    if (!isCurrent()) return
    if (this._readLoad) await this._readLoad
    if (!isCurrent()) return
    await this.loadAccounts({ force: true })
    if (!isCurrent()) return
    this.setData({ errorMessage: error.message || fallback })
  },

  openCreate: function () {
    this.setTabBarHidden(true)
    this.setData({ formOpen: true, formMode: 'create', formTitle: '创建账户', typeIndex: 0, name: '', balanceYuan: '0.00', errorMessage: '', isLiability: false, billingDraft: billing.draft() })
  },

  openAccountDetail: function (event) {
    const accountId = event.currentTarget.dataset.id
    if (!accountId) return
    wx.navigateTo({ url: '/pages/account-detail/index?accountId=' + encodeURIComponent(accountId) })
  },

  openAllLoans: function () {
    return loginGuard.run(this, () => wx.navigateTo({ url: '/pages/loans/index' }))
  },

  toggleArchived: function () { this.setData({ archivedExpanded: !this.data.archivedExpanded }) },

  closeForm: function () {
    if (!this.data.saving) { this.setTabBarHidden(false); this.setData({ formOpen: false, errorMessage: '' }) }
  },

  stopBubble: function () {},
  changeType: function (event) {
    if (this.data.saving) return
    const typeIndex = Number(event.detail.value)
    if (!TYPE_OPTIONS[typeIndex]) return
    this.setData({ typeIndex: typeIndex, isLiability: ['credit', 'other_liability'].includes(TYPE_OPTIONS[typeIndex].value), errorMessage: '' })
  },
  changeBillingDay: function (event) {
    if (this.data.saving || !['statementDay', 'repaymentDay'].includes(event.currentTarget.dataset.field)) return
    this.setData({ ['billingDraft.' + event.currentTarget.dataset.field]: Number(event.detail.value), errorMessage: '' })
  },
  bindCreditLimit: function (event) { if (!this.data.saving) this.setData({ 'billingDraft.creditLimitYuan': event.detail.value, errorMessage: '' }) },
  bindName: function (event) { this.setData({ name: event.detail.value }) },
  bindBalance: function (event) { this.setData({ balanceYuan: event.detail.value }) },

  saveForm: function () {
    if (this.data.saving) return
    let action
    let data
    try {
      action = 'accounts.create'
      data = { requestId: api.createRequestId(), type: TYPE_OPTIONS[this.data.typeIndex].value, name: this.data.name, currency: 'CNY', openingDisplayBalanceMinor: money.yuanToMinor(this.data.balanceYuan, { allowZero: true }), occurredLocalAt: time.today() + 'T' + time.currentClock() + ':00', timezoneOffsetMinutes: new Date().getTimezoneOffset() }
      if (this.data.isLiability) {
        const fields = billing.payload(this.data.billingDraft)
        if (!this.data.billingSupported && Object.keys(fields).some(function (key) { return fields[key] !== null })) throw new Error(billing.UNAVAILABLE)
        if (this.data.billingSupported) Object.assign(data, fields)
      }
    } catch (error) { this.setData({ errorMessage: error.message }); return }

    const self = this
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, errorMessage: '' })
    return api.callApi(action, data).then(function (result) {
      if (!isCurrent()) return
      if (Object.prototype.hasOwnProperty.call(data, 'statementDay')) billing.assertSaved(result, data)
      wx.showToast({ title: '已保存', icon: 'success' })
      self.setTabBarHidden(false)
      self.setData({ formOpen: false })
      self.loadAccounts()
    }).catch(function (error) { return self.recoverMutation(error, '保存失败', isCurrent) })
      .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  }
})
