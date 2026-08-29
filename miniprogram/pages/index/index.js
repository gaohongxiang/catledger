const app = getApp()
const api = require('../../services/catledger-api')
const money = require('../../utils/money')
const time = require('../../utils/time')
const viewModel = require('../../utils/view-model')
const themeService = require('../../theme/service')

const ACCOUNT_ICONS = {
  cash: '/assets/icons/account-cash.svg',
  bank: '/assets/icons/account-bank.svg',
  wallet: '/assets/icons/account-wallet.svg',
  credit: '/assets/icons/account-credit.svg',
  other_asset: '/assets/icons/account-other.svg',
  other_liability: '/assets/icons/account-other.svg'
}

Page({
  data: {
    cloudAvailable: false,
    loggedIn: false,
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
    this.setData({
      cloudAvailable: app.globalData.cloudAvailable,
      loggedIn: app.hasLoginApproval(),
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
    this.setData({ loggedIn: loggedIn })
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
    this.setData({ loggedIn: true })
    this.loadDashboard()
  },

  ensureBootstrap: function () {
    if (app.globalData.categories.length > 0) {
      return Promise.resolve()
    }
    return api.bootstrap().then(function (result) {
      app.globalData.categories = Array.isArray(result.categories) ? result.categories : []
    })
  },

  loadDashboard: function () {
    if (this.data.loading || !app.hasLoginApproval()) {
      return
    }
    const month = time.currentMonth()
    const self = this
    this.setData({ loading: true, errorMessage: '', month: month, monthLabel: time.monthLabel(month) })

    this.ensureBootstrap()
      .then(function () {
        return api.callApi('dashboard.get', { month: month })
      })
      .then(function (dashboard) {
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
          recentTransactions: dashboard.recentTransactions.map(viewModel.transactionView)
        })
      })
      .catch(function () {
        self.setData({ errorMessage: '账本暂时没连接上' })
      })
      .finally(function () {
        self.setData({ loading: false })
      })
  },

  editTransaction: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const transaction = this.data.recentTransactions[index]
    if (!transaction || !transaction.editable) {
      return
    }
    app.globalData.editingTransaction = transaction
    wx.navigateTo({ url: '/pages/transaction-editor/index?mode=edit' })
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
    wx.navigateTo({ url: '/pages/statistics/index' })
  }
})
