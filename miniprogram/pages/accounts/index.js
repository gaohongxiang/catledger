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

Page(themeService.page({
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
    dragging: false,    // 是否正在拖动排序（显示全屏遮罩层，拦截页面滚动）
    dragGroup: '',      // '' | 'asset' | 'liability'
    dragId: '',
    dragItem: {},       // 拖动行的数据，供浮层展示
    dragFloatTop: 0,    // 浮层 top（px）
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


  onShow: function () {
    const app = getApp()
    const dirty = Boolean(app && app.globalData && app.globalData.accountsDirty)
    if (dirty && app.globalData) app.globalData.accountsDirty = false
    loginGuard.run(this, () => this.loadAccounts(dirty ? { force: true } : undefined))
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
        self.setData(Object.assign({ hasLoaded: true, billingSupported: result.liabilitySettingsVersion === 1 }, buildAccountsView(result.accounts, result.totals)))
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
    // 拖动排序刚结束时的 tap 是长按拖动余波，忽略，避免误进详情。
    if (Date.now() - (this._dragEndedAt || 0) < 300) return
    const accountId = event.currentTarget.dataset.id
    if (!accountId) return
    wx.navigateTo({ url: '/pages/account-detail/index?accountId=' + encodeURIComponent(accountId) })
  },

  openAllLoans: function () {
    return loginGuard.run(this, () => wx.navigateTo({ url: '/packages/loans/pages/loans/index' }))
  },

  toggleArchived: function () { this.setData({ archivedExpanded: !this.data.archivedExpanded }) },

  // —— 账户手动拖动排序（资产/负债各自独立，长按进入拖动）——
  // 策略：长按记录起始位置与行高；touchmove 按手指 Y 位移算当前落点，实时交换数组让其他行让位；
  // touchend 若顺序变化则提交 accounts.reorder（提交该组新的 accountId 顺序）。
  onDragStart: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const id = event.currentTarget.dataset.id
    const group = event.currentTarget.dataset.group
    if (!id || Number.isNaN(index) || !group) return
    if (this.data.formOpen) return
    const touch = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0])
    const clientY = touch ? touch.clientY : 0
    const listKey = group === 'asset' ? 'assets' : 'liabilities'
    const list = this.data[listKey] || []
    const item = list.find(function (a) { return a.accountId === id })
    if (!item) return
    // 行高按 min-height 116rpx 换算 px（同步，避免异步 query 竞态）。
    let rowHeight = 58
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (info && info.windowWidth) rowHeight = 116 / 750 * info.windowWidth
    } catch (e) { /* 保底 58 */ }
    this._drag = {
      group: group,
      id: id,
      fromIndex: index,
      startY: clientY,
      rowHeight: rowHeight,
      moved: false
    }
    this.setData({
      dragging: true,
      dragGroup: group,
      dragId: id,
      dragItem: item,
      dragFloatTop: clientY - rowHeight / 2
    })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  onDragMove: function (event) {
    const drag = this._drag
    if (!drag) return
    const touch = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0])
    if (!touch) return
    const offset = touch.clientY - drag.startY
    drag.moved = drag.moved || Math.abs(offset) > 3
    drag.lastOffset = offset
    this.setData({ dragFloatTop: touch.clientY - drag.rowHeight / 2 })
  },

  onDragEnd: function () {
    const drag = this._drag
    if (!drag) return
    this._drag = null
    this._dragEndedAt = Date.now()
    const listKey = drag.group === 'asset' ? 'assets' : 'liabilities'
    if (!drag.moved) { this.setData({ dragging: false, dragGroup: '', dragId: '' }); return }
    const list = this.data[listKey].slice()
    let target = drag.fromIndex + Math.round((drag.lastOffset || 0) / drag.rowHeight)
    if (target < 0) target = 0
    if (target > list.length - 1) target = list.length - 1
    this.setData({ dragging: false, dragGroup: '', dragId: '' })
    if (target === drag.fromIndex) return
    const fromPos = list.findIndex(function (a) { return a.accountId === drag.id })
    if (fromPos < 0) return
    const moved = list.splice(fromPos, 1)[0]
    list.splice(target, 0, moved)
    const setDataObj = {}
    setDataObj[listKey] = list
    this.setData(setDataObj)
    this.saveOrder(list.map(function (a) { return a.accountId }))
  },

  // 提交新的账户顺序（同一组内的 accountId 数组）。失败则重载恢复服务端顺序。
  saveOrder: function (ids) {
    const self = this
    api.callApi('accounts.reorder', { accountIds: ids, requestId: api.createRequestId() })
      .then(function () { if (wx.showToast) wx.showToast({ title: '已排序', icon: 'none' }) })
      .catch(function (error) {
        wx.showToast({ title: (error && error.message) || '排序保存失败', icon: 'none' })
        self.loadAccounts({ force: true })
      })
  },

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
}))
