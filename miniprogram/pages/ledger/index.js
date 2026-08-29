const app = getApp()
const api = require('../../services/catledger-api')
const themeService = require('../../theme/service')

Page({
  data: {
    loggedIn: false,
    loading: false,
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
    this.setData({ loading: false, errorMessage: '' })
  },

  onPullDownRefresh: function () {
    if (!app.hasLoginApproval()) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadLedger().finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  loadLedger: function () {
    if (!app.hasLoginApproval() || this.data.loading) {
      return Promise.resolve()
    }
    const self = this
    this.setData({ loading: true, errorMessage: '' })

    return Promise.all([api.bootstrap(), api.callApi('accounts.list')])
      .then(function (results) {
        const categories = Array.isArray(results[0].categories) ? results[0].categories : []
        const accounts = Array.isArray(results[1].accounts) ? results[1].accounts : []
        const activeAccounts = accounts.filter(function (account) { return !account.archived })
        const expenseCategoryCount = categories.filter(function (category) { return category.kind === 'expense' }).length
        const incomeCategoryCount = categories.filter(function (category) { return category.kind === 'income' }).length
        app.globalData.categories = categories
        self.setData({
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
        self.setData({ errorMessage: error.message || '账本结构加载失败' })
      })
      .finally(function () {
        self.setData({ loading: false })
      })
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
