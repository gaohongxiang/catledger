const app = getApp()
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const themeService = require('../../theme/service')

Page({
  data: {
    loggedIn: false,
    loading: false,
    hasLoaded: false,
    errorMessage: '',
    accountCount: 0,
    assetCount: 0,
    liabilityCount: 0,
    expenseCategoryCount: 0,
    incomeCategoryCount: 0,
    structureCount: 0,
    accountSummaryText: '登录后创建和管理账户',
    categorySummaryText: '登录后管理收支分类'
  },

  onLoad: function () { themeService.bindPage(this) },

  onShow: function () {
    themeService.bindPage(this)
    if (this.getTabBar()) {
      this.getTabBar().setData({ selected: 2, hidden: false })
    }
    const loggedIn = app.hasLoginApproval()
    this.setData({ loggedIn: loggedIn })
    if (loggedIn) {
      this.loadLedger()
      return
    }
    this.setData({ loading: false, hasLoaded: false, errorMessage: '', accountSummaryText: '登录后创建和管理账户', categorySummaryText: '登录后管理收支分类' })
  },

  onPullDownRefresh: function () {
    if (!app.hasLoginApproval()) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadLedger({ force: true }).finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  loadLedger: function (options) {
    const isCurrent = pageReadSession.begin(this, ['loading', 'hasLoaded', 'errorMessage', 'accountCount', 'assetCount', 'liabilityCount', 'expenseCategoryCount', 'incomeCategoryCount', 'structureCount', 'accountSummaryText', 'categorySummaryText'], ['_ledgerLoad'])
    if (!app.hasLoginApproval() || this._ledgerLoad) {
      return this._ledgerLoad || Promise.resolve()
    }
    const self = this
    const force = Boolean(options && options.force)
    this.setData({ loading: force || !api.isFresh('catalog.get'), errorMessage: '' })

    this._ledgerLoad = api.callApi('catalog.get', {}, { force: force })
      .then(function (result) {
        if (!isCurrent()) return
        const categories = Array.isArray(result.categories) ? result.categories : []
        const accounts = Array.isArray(result.accounts) ? result.accounts : []
        const activeAccounts = accounts.filter(function (account) { return !account.archived })
        const expenseCategoryCount = categories.filter(function (category) { return category.kind === 'expense' }).length
        const incomeCategoryCount = categories.filter(function (category) { return category.kind === 'income' }).length
        self.setData({
          hasLoaded: true,
          accountCount: activeAccounts.length,
          assetCount: activeAccounts.filter(function (account) { return account.nature === 'asset' }).length,
          liabilityCount: activeAccounts.filter(function (account) { return account.nature === 'liability' }).length,
          expenseCategoryCount: expenseCategoryCount,
          incomeCategoryCount: incomeCategoryCount,
          structureCount: activeAccounts.length + expenseCategoryCount + incomeCategoryCount,
          accountSummaryText: activeAccounts.filter(function (account) { return account.nature === 'asset' }).length +
            ' 个资产账户 · ' + activeAccounts.filter(function (account) { return account.nature === 'liability' }).length + ' 个负债账户',
          categorySummaryText: expenseCategoryCount + ' 个支出分类 · ' + incomeCategoryCount + ' 个收入分类'
        })
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '账本结构加载失败' })
      })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false })
        self._ledgerLoad = null
      })
    return this._ledgerLoad
  },

  openAccounts: function () {
    if (!app.hasLoginApproval()) {
      this.promptWechatLogin(this.openAccounts.bind(this))
      return
    }
    wx.navigateTo({ url: '/pages/accounts/index' })
  },

  openCategories: function () {
    if (!app.hasLoginApproval()) {
      this.promptWechatLogin(this.openCategories.bind(this))
      return
    }
    wx.navigateTo({ url: '/pages/categories/index' })
  },

  promptWechatLogin: function (afterLogin) {
    const tabBar = this.getTabBar()
    if (tabBar && typeof tabBar.requestLogin === 'function') {
      tabBar.requestLogin({
        afterLogin: typeof afterLogin === 'function'
          ? afterLogin
          : this.onWechatLoginSuccess.bind(this)
      })
    }
  },

  onWechatLoginSuccess: function () {
    this.setData({ loggedIn: true })
    this.loadLedger()
  }
})
