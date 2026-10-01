const app = getApp()
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const money = require('../../utils/money')
const time = require('../../utils/time')
const viewModel = require('../../utils/view-model')
const profilePresentation = require('../../utils/profile-presentation')
const themeService = require('../../theme/service')
const observer = require('../../services/read-observer')

const HOME_RECENT_LIMIT = 3

function greetingText(loggedIn, profile) {
  if (!loggedIn) return '你好'
  const hour = new Date().getHours()
  const period = hour >= 6 && hour < 11 ? '早上好' : (hour >= 11 && hour < 18 ? '下午好' : '晚上好')
  const nickname = profile && profile.nickname ? String(profile.nickname).trim().slice(0, 24) : ''
  return nickname ? period + '，' + nickname : period
}

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
    greeting: '你好',
    todayLabel: '',
    displayAvatarUrl: profilePresentation.DEFAULT_AVATAR_URL,
    loading: false,
    hasDashboard: false,
    dashboardStatus: '',
    dashboardFresh: false,
    chargeSyncMessage: '',
    chargeSyncComplete: false,
    errorMessage: '',
    month: '',
    monthLabel: '',
    netWorthText: '—',
    incomeText: '—',
    expenseText: '—',
    netIncomeText: '—',
    trendReady: false,
    trendSparse: false,
    cashFlowTrend: [],
    accounts: [],
    recentTransactions: []
  },

  onLoad: function () {
    observer.attach(this)
    themeService.bindPage(this)
    const month = time.currentMonth()
    const loggedIn = app.hasLoginApproval()
    this.setData({
      cloudAvailable: app.globalData.cloudAvailable,
      loggedIn: loggedIn,
      greeting: greetingText(loggedIn, app.globalData.profile),
      displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, app.globalData.profile),
      month: month,
      monthLabel: time.monthLabel(month),
      todayLabel: time.todayLabel()
    }, () => {
      if (!this._readClosed) observer.record('startup', { phase: 'shell', page: this.route, ms: Math.max(0, Date.now() - (app._startupStartedAt || Date.now())) })
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
      greeting: greetingText(loggedIn, app.globalData.profile),
      todayLabel: time.todayLabel(),
      displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, app.globalData.profile)
    })
    if (app.globalData.cloudAvailable && loggedIn) {
      this.loadDashboard()
      return
    }
    this.setData({
      loading: false,
      hasDashboard: false,
      dashboardStatus: '',
      dashboardFresh: false,
      chargeSyncMessage: '',
      chargeSyncComplete: false,
      errorMessage: '',
      netWorthText: '—',
      incomeText: '—',
      expenseText: '—',
      netIncomeText: '—',
      trendReady: false,
      trendSparse: false,
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
      greeting: greetingText(true, app.globalData.profile),
      todayLabel: time.todayLabel(),
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

  onHide: function(){pageReadSession.end(this)},
  onUnload: function(){pageReadSession.end(this)},
  loadDashboard: function (options) {
    const month = time.currentMonth()
    const snapshot = api.displaySnapshot('dashboard.get', { month })
    const isCurrent = pageReadSession.begin(this, ['loading', 'hasDashboard', 'errorMessage', 'netWorthText', 'incomeText', 'expenseText', 'netIncomeText', 'trendReady', 'trendSparse', 'cashFlowTrend', 'accounts', 'recentTransactions', 'dashboardStatus', 'dashboardFresh', 'chargeSyncMessage', 'chargeSyncComplete'], ['_dashboardLoad'])
    if (this._dashboardLoad || !app.hasLoginApproval()) {
      return this._dashboardLoad || Promise.resolve()
    }
    const self = this
    const readTicket = {}
    this._dashboardReadTicket = readTicket
    const startedAt = Date.now()
    const force = Boolean(options && (options.force || options.currentTarget))
    this.setData({ loading: force || !api.isFresh('dashboard.get', { month: month }), errorMessage: '', month: month, monthLabel: time.monthLabel(month), dashboardFresh: false,
      dashboardStatus: this.data.hasDashboard || snapshot ? '显示上次结果，正在检查费用并更新' : '正在检查费用并读取账本' })

    const applyDashboard = function (dashboard, state) {
        if (!isCurrent()) return
        const cashFlowTrend = Array.isArray(dashboard.cashFlowTrend) ? dashboard.cashFlowTrend : []
        self.setData({
          netWorthText: money.formatMinor(dashboard.netWorthMinor),
          incomeText: money.formatMinor(dashboard.summary.incomeMinor),
          expenseText: money.formatMinor(dashboard.summary.expenseMinor),
          netIncomeText: money.formatMinor(dashboard.summary.netIncomeMinor),
          hasDashboard: true,
          dashboardFresh: Boolean(state && state.complete),
          dashboardStatus: !state ? '显示上次结果，正在检查费用并更新' : state.complete ? '' : '费用同步未完成，当前结果还不是最新余额',
          errorMessage: '',
          trendReady: Array.isArray(dashboard.cashFlowTrend),
          trendSparse: cashFlowTrend.filter(function (row) {
            return row.incomeHeightPermille > 0 || row.expenseHeightPermille > 0
          }).length < 2,
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
        }, function () {
          if (!isCurrent() || self._dashboardReadTicket !== readTicket) return
          observer.record('interactive', { page: self.route, action: 'dashboard.get', phase: !state ? 'home_snapshot' : state.complete ? 'home_latest' : 'home_incomplete',
            elapsedMs: Date.now() - startedAt, ms: Math.max(0, Date.now() - (app._identityConfirmedAt || startedAt)), source: !state && snapshot ? snapshot.source : undefined })
        })
    }
    // 同身份快照只作展示，先交付，再按写屏障顺序完成费用同步和正式读取。
    if (snapshot) {
      applyDashboard(snapshot.value)
      observer.record('snapshot', { action: 'dashboard.get', source: snapshot.source, ms: Math.max(0, Date.now() - startedAt) })
    }
    const chargeSync = require('../../services/loan-charge-sync')
    this._dashboardLoad = (async () => {
      let sync = await chargeSync.beforePage(this,isCurrent,{force})
      for (let round=0;round<2;round++) {
        if (!isCurrent()) return
        const dashboard = await this.fetchDashboard(month,{force:force&&round===0})
        if (!isCurrent()) return
        const verified = sync.complete && chargeSync.isVerified(sync) && sync.dataRevision === dashboard.dataRevision
        if (!sync.complete || verified) { applyDashboard(dashboard,sync); return }
        // 正式读取发现外部新版本或跨日，只重新核对一次；连续变化保留画面并明确待更新。
        applyDashboard(dashboard)
        if (round===0) sync = await chargeSync.beforePage(this,isCurrent,{force:true})
        else this.setData({dashboardFresh:false,chargeSyncComplete:false,dashboardStatus:'账本仍在更新，当前结果待核实',chargeSyncMessage:'费用核对后账本再次变化，请重试'})
      }
    })()
      .catch(function () {
        if (!isCurrent()) return
        self.setData({ errorMessage: self.data.hasDashboard ? '更新未成功，当前显示上次结果' : '账本暂时没连接上', dashboardFresh: false, dashboardStatus: self.data.hasDashboard ? '更新未完成，当前显示上次结果' : '' })
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

  createTransaction: function () {
    wx.navigateTo({ url: '/pages/transaction-editor/index' })
  },

  openImport: function () {
    wx.navigateTo({ url: '/pages/import-workbench/index' })
  },

  openStatistics: function () {
    if (!app.hasLoginApproval()) {
      this.promptWechatLogin(this.openStatistics.bind(this))
      return
    }
    wx.switchTab({ url: '/pages/statistics/index' })
  }
})
