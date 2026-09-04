const api = require('../../services/catledger-api')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')
const { buildAccountsView } = require('./model')

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
    saving: false,
    errorMessage: '',
    assets: [],
    liabilities: [],
    archivedAccounts: [],
    assetCorrectionCount: 0,
    archivedExpanded: false,
    totals: { netWorthText: '¥0.00', assetsText: '¥0.00', liabilitiesText: '¥0.00' },
    accountDetail: null,
    formOpen: false,
    formMode: 'create',
    formTitle: '创建账户',
    selectedAccount: null,
    typeOptions: TYPE_OPTIONS,
    typeIndex: 0,
    name: '',
    balanceYuan: '0.00'
  },

  onShow: function () {
    themeService.bindPage(this)
    loginGuard.run(this, this.loadAccounts.bind(this))
  },

  onHide: function () { this.setTabBarHidden(false) },

  setTabBarHidden: function (hidden) {
    if (this.getTabBar()) this.getTabBar().setData({ hidden: hidden })
  },

  loadAccounts: function () {
    if (this.data.loading) return
    const self = this
    this.setData({ loading: true, errorMessage: '' })
    api.callApi('accounts.list')
      .then(function (result) {
        self.setData(buildAccountsView(result.accounts))
      })
      .catch(function (error) { self.setData({ errorMessage: error.message || '账户加载失败' }) })
      .finally(function () { self.setData({ loading: false }) })
  },

  openCreate: function () {
    this.setTabBarHidden(true)
    this.setData({ formOpen: true, formMode: 'create', formTitle: '创建账户', selectedAccount: null, accountDetail: null, typeIndex: 0, name: '', balanceYuan: '0.00', errorMessage: '' })
  },

  openAccountDetail: function (event) {
    const account = this.findAccount(event.currentTarget.dataset.id)
    if (!account) return
    this.setTabBarHidden(true)
    this.setData({ accountDetail: account })
  },

  closeAccountDetail: function () {
    if (!this.data.saving) {
      this.setTabBarHidden(false)
      this.setData({ accountDetail: null, errorMessage: '' })
    }
  },

  toggleArchived: function () { this.setData({ archivedExpanded: !this.data.archivedExpanded }) },

  openRename: function (event) {
    const account = this.findAccount(event.currentTarget.dataset.id)
    if (!account) return
    this.setData({ formOpen: true, formMode: 'rename', formTitle: '修改账户名称', selectedAccount: account, accountDetail: null, name: account.name, balanceYuan: money.minorToYuan(account.displayBalanceMinor), errorMessage: '' })
  },

  openCorrection: function (event) {
    const account = this.findAccount(event.currentTarget.dataset.id)
    if (!account) return
    this.setData({ formOpen: true, formMode: 'correct', formTitle: '校正账户余额', selectedAccount: account, accountDetail: null, name: account.name, balanceYuan: money.minorToYuan(account.displayBalanceMinor), errorMessage: '' })
  },

  findAccount: function (accountId) {
    return this.data.assets.concat(this.data.liabilities, this.data.archivedAccounts).find(function (account) { return account.accountId === accountId })
  },

  closeForm: function () {
    if (!this.data.saving) { this.setTabBarHidden(false); this.setData({ formOpen: false, errorMessage: '' }) }
  },

  stopBubble: function () {},
  changeType: function (event) { this.setData({ typeIndex: Number(event.detail.value) }) },
  bindName: function (event) { this.setData({ name: event.detail.value }) },
  bindBalance: function (event) { this.setData({ balanceYuan: event.detail.value }) },

  saveForm: function () {
    if (this.data.saving) return
    let action
    let data
    try {
      if (this.data.formMode === 'create') {
        action = 'accounts.create'
        data = { requestId: api.createRequestId(), type: TYPE_OPTIONS[this.data.typeIndex].value, name: this.data.name, currency: 'CNY', openingDisplayBalanceMinor: money.yuanToMinor(this.data.balanceYuan, { allowZero: true }), occurredLocalAt: time.today() + 'T' + time.currentClock() + ':00', timezoneOffsetMinutes: new Date().getTimezoneOffset() }
      } else if (this.data.formMode === 'rename') {
        action = 'accounts.update'
        data = { requestId: api.createRequestId(), accountId: this.data.selectedAccount.accountId, version: this.data.selectedAccount.version, name: this.data.name }
      } else {
        action = 'accounts.correctBalance'
        data = { requestId: api.createRequestId(), accountId: this.data.selectedAccount.accountId, displayBalanceMinor: money.yuanToMinor(this.data.balanceYuan, { allowZero: true }), occurredLocalAt: time.today() + 'T' + time.currentClock() + ':00', timezoneOffsetMinutes: new Date().getTimezoneOffset() }
      }
    } catch (error) { this.setData({ errorMessage: error.message }); return }

    const self = this
    this.setData({ saving: true, errorMessage: '' })
    api.callApi(action, data).then(function () {
      wx.showToast({ title: '已保存', icon: 'success' })
      self.setTabBarHidden(false)
      self.setData({ formOpen: false })
      self.loadAccounts()
    }).catch(function (error) { self.setData({ errorMessage: error.message || '保存失败' }) })
      .finally(function () { self.setData({ saving: false }) })
  },

  archive: function (event) {
    const account = this.findAccount(event.currentTarget.dataset.id)
    const self = this
    if (!account || account.archived) return
    wx.showModal({
      title: '停用“' + account.name + '”？',
      content: '历史账目和余额仍会保留，但这个账户不能再用于新交易。',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (!result.confirm) return
        api.callApi('accounts.archive', { requestId: api.createRequestId(), accountId: account.accountId, version: account.version })
          .then(function () { wx.showToast({ title: '已停用', icon: 'success' }); self.setTabBarHidden(false); self.setData({ accountDetail: null }); self.loadAccounts() })
          .catch(function (error) { self.setData({ errorMessage: error.message || '停用失败' }) })
      }
    })
  }
})
