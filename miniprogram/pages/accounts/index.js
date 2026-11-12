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
    dragGroup: '',      // '' | 'asset' | 'liability'：当前正在拖动的分组
    dragId: '',
    dragOffset: 0,      // 拖动行相对原位的 Y 位移（px），用于跟随手指
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
    if (event.currentTarget.dataset.kind === undefined && this.data.formOpen) return
    const index = Number(event.currentTarget.dataset.index)
    const id = event.currentTarget.dataset.id
    const group = event.currentTarget.dataset.group
    if (!id || Number.isNaN(index)) return
    const touch = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0])
    const startY = touch ? touch.clientY : 0
    const self = this
    wx.createSelectorQuery().in(this).select('.account-row').boundingClientRect(function (rect) {
      const rowHeight = rect && rect.height ? rect.height : 58
      self._drag = {
        group: group,
        id: id,
        fromIndex: index,
        curIndex: index,
        startY: startY,
        rowHeight: rowHeight,
        lastY: startY,
        moved: false,
        original: (self.data[group === 'asset' ? 'assets' : 'liabilities'] || []).map(function (a) { return a.accountId })
      }
      self.setData({ dragGroup: group, dragId: id, dragOffset: 0 })
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
    }).exec()
  },

  onDragMove: function (event) {
    const drag = this._drag
    if (!drag) return
    const touch = (event.touches && event.touches[0]) || (event.changedTouches && event.changedTouches[0])
    if (!touch) return
    const offset = Math.round(touch.clientY - drag.startY)
    const listKey = drag.group === 'asset' ? 'assets' : 'liabilities'
    const list = this.data[listKey].slice()
    // 目标位置 = 起始位 + 位移折算的行数
    let target = drag.fromIndex + Math.round(offset / drag.rowHeight)
    if (target < 0) target = 0
    if (target > list.length - 1) target = list.length - 1
    if (target !== drag.curIndex) {
      const fromPos = list.findIndex(function (a) { return a.accountId === drag.id })
      if (fromPos >= 0) {
        const moved = list.splice(fromPos, 1)[0]
        list.splice(target, 0, moved)
        drag.curIndex = target
        drag.moved = true
        // 拖动行视觉位移补偿（因为数组已重排，行会跳到新位置，需回退补偿让手指下的行不跳）
        const setDataObj = {}
        setDataObj[listKey] = list
        // 位移基数改为相对"当前数组位置"，用剩余 offset 近似，避免抖动
        const residual = offset - (target - drag.fromIndex) * drag.rowHeight
        setDataObj.dragOffset = residual
        this.setData(setDataObj)
        return
      }
    }
    this.setData({ dragOffset: Math.round(offset - (drag.curIndex - drag.fromIndex) * drag.rowHeight) })
  },

  onDragEnd: function () {
    const drag = this._drag
    if (!drag) return
    this._drag = null
    this._dragEndedAt = Date.now()
    this.setData({ dragGroup: '', dragId: '', dragOffset: 0 })
    if (!drag.moved) return
    const listKey = drag.group === 'asset' ? 'assets' : 'liabilities'
    const ids = this.data[listKey].map(function (a) { return a.accountId })
    const changed = ids.length !== drag.original.length || ids.some(function (id, i) { return id !== drag.original[i] })
    if (!changed) return
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
