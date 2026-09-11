const app = getApp()
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const money = require('../../utils/money')
const time = require('../../utils/time')
const viewModel = require('../../utils/view-model')
const profilePresentation = require('../../utils/profile-presentation')
const themeService = require('../../theme/service')

const HOME_RECENT_LIMIT = 3

const ACCOUNT_ICONS = {
  cash: 'account-cash.svg',
  bank: 'account-bank.svg',
  wallet: 'account-wallet.svg',
  credit: 'account-credit.svg',
  other_asset: 'account-other.svg',
  other_liability: 'account-other.svg'
}

Page({
  data: {
    cloudAvailable: false,
    loggedIn: false,
    displayAvatarUrl: profilePresentation.DEFAULT_AVATAR_URL,
    loading: false,
    hasDashboard: false,
    errorMessage: '',
    month: '',
    monthLabel: '',
    netWorthText: '—',
    incomeText: '—',
    expenseText: '—',
    netIncomeText: '—',
    trendReady: false,
    cashFlowTrend: [],
    accounts: [],
    recentTransactions: []
  },

  onLoad: function () {
    themeService.bindPage(this)
    const month = time.currentMonth()
    const loggedIn = app.hasLoginApproval()
    this.setData({
      cloudAvailable: app.globalData.cloudAvailable,
      loggedIn: loggedIn,
      displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, app.globalData.profile),
      month: month,
      monthLabel: time.monthLabel(month)
    })
  },

  onShow: function () {
    themeService.bindPage(this)
    if (this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    const loggedIn = app.hasLoginApproval()
    this.setData({
      loggedIn: loggedIn,
      displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, app.globalData.profile)
    })
    if (app.globalData.cloudAvailable && loggedIn) {
      this.loadDashboard()
      return
    }
    this.setData({
      loading: false,
      hasDashboard: false,
      errorMessage: '',
      netWorthText: '—',
      incomeText: '—',
      expenseText: '—',
      netIncomeText: '—',
      trendReady: false,
      cashFlowTrend: [],
      accounts: [],
      recentTransactions: []
    })
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
    this.setData({
      loggedIn: true,
      displayAvatarUrl: profilePresentation.displayAvatarUrl(true, app.globalData.profile)
    })
    this.loadDashboard()
  },

  fetchDashboard: function (month, options) {
    return api.callApi('dashboard.get', { month: month }, options).catch(function (error) {
      if (!error || error.code !== 'INITIALIZATION_REQUIRED') throw error
      return api.bootstrap({ force: true }).then(function (result) {
        app.globalData.categories = Array.isArray(result.categories) ? result.categories : []
        return api.callApi('dashboard.get', { month: month }, options)
      })
    })
  },

  loadDashboard: function (options) {
    const isCurrent = pageReadSession.begin(this, ['loading', 'hasDashboard', 'errorMessage', 'netWorthText', 'incomeText', 'expenseText', 'netIncomeText', 'trendReady', 'cashFlowTrend', 'accounts', 'recentTransactions'], ['_dashboardLoad'])
    if (this._dashboardLoad || !app.hasLoginApproval()) {
      return this._dashboardLoad || Promise.resolve()
    }
    const month = time.currentMonth()
    const self = this
    const force = Boolean(options && (options.force || options.currentTarget))
    this.setData({ loading: force || !api.isFresh('dashboard.get', { month: month }), errorMessage: '', month: month, monthLabel: time.monthLabel(month) })

    this._dashboardLoad = this.fetchDashboard(month, { force: force })
      .then(function (dashboard) {
        if (!isCurrent()) return
        const cashFlowTrend = Array.isArray(dashboard.cashFlowTrend) ? dashboard.cashFlowTrend : []
        self.setData({
          netWorthText: money.formatMinor(dashboard.netWorthMinor),
          incomeText: money.formatMinor(dashboard.summary.incomeMinor),
          expenseText: money.formatMinor(dashboard.summary.expenseMinor),
          netIncomeText: money.formatMinor(dashboard.summary.netIncomeMinor),
          hasDashboard: true,
          trendReady: Array.isArray(dashboard.cashFlowTrend),
          cashFlowTrend: cashFlowTrend.map(function (row) {
            return Object.assign({}, row, {
              monthText: String(Number(row.month.slice(5))),
              showMonth: true,
              incomeHeight: row.incomeHeightPermille === 0 ? 0 : Math.max(5, Math.round(row.incomeHeightPermille * 0.1)),
              expenseHeight: row.expenseHeightPermille === 0 ? 0 : Math.max(5, Math.round(row.expenseHeightPermille * 0.1))
            })
          }),
          accounts: dashboard.accounts.filter(function (account) {
            return !account.archived
          }).slice(0, 3).map(function (account) {
            return Object.assign({}, account, {
              balanceText: money.formatMinor(account.displayBalanceMinor),
              directionText: account.balanceDirection === 'liability' ? '待还' : '余额',
              iconPath: ACCOUNT_ICONS[account.type] || ACCOUNT_ICONS.other_asset
            })
          }),
          recentTransactions: dashboard.recentTransactions
            .slice(0, HOME_RECENT_LIMIT)
            .map(viewModel.transactionView)
        })
      })
      .catch(function () {
        if (!isCurrent()) return
        self.setData({ errorMessage: '账本暂时没连接上' })
      })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false })
        self._dashboardLoad = null
      })
    return this._dashboardLoad
  },

  editTransaction: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const transaction = this.data.recentTransactions[index]
    if (!transaction) {
      return
    }
    app.globalData.editingTransaction = transaction
    const imported = transaction.origin === 'import' || Boolean(transaction.importContext)
    wx.navigateTo({ url: '/pages/transaction-editor/index?mode=' + (imported ? 'import' : (transaction.editable ? 'edit' : 'view')) })
  },

  openAccounts: function () {
    if (!app.hasLoginApproval()) {
      this.promptWechatLogin(this.openAccounts.bind(this))
      return
    }
    wx.navigateTo({ url: '/pages/accounts/index' })
  },

  openTransactions: function () {
    wx.switchTab({ url: '/pages/transactions/index' })
  },

  openStatistics: function () {
    if (!app.hasLoginApproval()) {
      this.promptWechatLogin(this.openStatistics.bind(this))
      return
    }
    wx.switchTab({ url: '/pages/statistics/index' })
  }
})
