const pageReadSession = require('../../services/page-read-session')
const money = require('../../utils/money')
const time = require('../../utils/time')
const viewModel = require('../../utils/view-model')
const profilePresentation = require('../../utils/profile-presentation')
const observer = require('../../services/read-observer')
const { addMinor } = require('../../utils/minor-arithmetic')
const composition = require('./net-worth-composition')
const draftSessions = require('../../services/import-draft-session')
const tabRouter = require('../../shell/router')

const HOME_RECENT_LIMIT = 3
const dashboardQuery = month => ({ month, summaryScope: 'all' })
const emptyShares = () => ({ items: [], bar: [], empty: true, totalMinor: '0' })

// 净资产是账面最后一笔交易之后的结果；卡片上写「最后一笔 M月D日」，说清这个数字停在哪天，
// 不写「数据截至」——那句话读起来像导入时间，账单滞后一个月时会被当成没同步。
function asOfLabel(transactions) {
  const first = Array.isArray(transactions) && transactions.length > 0 ? transactions[0] : null
  const value = String((first && first.occurredLocalAt) || '')
  const matched = /^\d{4}-(\d{2})-(\d{2})/.exec(value)
  return matched ? Number(matched[1]) + '月' + Number(matched[2]) + '日' : ''
}

// 提醒行只在真有事时出现：本机草稿没有待核对／待分类、本月也没有未结清期次时，整行不占位。
// 待核对与待分类取工作台自己写下的进度——核对决定在入账前只在本机，服务端数字不是用户看到的那个。
// 只有数字上色：整句上色在藏蓝、香芋两套浅色主题上掉到 4.06:1，低于小字门槛。
// 文字仍然是同一句话，拆段只为让数字单独取语义色。
function draftAlertParts(progress) {
  if (!progress) return []
  const parts = []
  if (progress.pending > 0) parts.push({ text: '待核对 ' }, { text: String(progress.pending), figure: true }, { text: ' 笔' })
  if (progress.categories > 0) {
    if (parts.length) parts.push({ text: ' · ' })
    parts.push({ text: '待分类 ' }, { text: String(progress.categories), figure: true }, { text: ' 笔' })
  }
  return parts
}

function dueAlertParts(result) {
  const periods = Number(result && result.periodCount)
  const dueMinor = String((result && result.dueMinor) || '0')
  if (!Number.isFinite(periods) || periods <= 0 || dueMinor === '0') return []
  const parts = [{ text: '本月待还 ' }, { text: money.formatMinor(dueMinor), figure: true }]
  if (periods > 1) parts.push({ text: ' · ' + periods + ' 期' })
  return parts
}

const alertText = parts => (parts || []).map(part => part.text).join('')

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

function createHomePage(dependencies) {
  const { app, api, themeService, wx } = dependencies
  return {
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
      identityPending: false,
      netWorthText: '—',
      incomeText: '—',
      expenseText: '—',
      assetsText: '—',
      liabilitiesText: '—',
      assetShares: emptyShares(),
      liabilityShares: emptyShares(),
      asOfText: '',
      alertImportText: '',
      alertDueText: '',
      alertImportParts: [],
      alertDueParts: [],
      trendReady: false,
      trendSparse: false,
      cashFlowTrend: [],
      accounts: [],
      recentTransactions: []
    },

    onLoad: function () {
      observer.attach(this)
      const month = time.currentMonth()
      const loggedIn = app.hasLoginApproval()
      this.setData({
        cloudAvailable: app.globalData.cloudAvailable,
        loggedIn: loggedIn,
        identityPending: !loggedIn && Boolean(app.globalData.identityConfirming),
        greeting: greetingText(loggedIn, app.globalData.profile),
        displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, app.globalData.profile),
        month: month,
        todayLabel: time.todayLabel()
      }, () => {
        if (!this._readClosed) observer.record('startup', { phase: 'shell', page: this.route, ms: Math.max(0, Date.now() - (app._startupStartedAt || Date.now())) })
      })
    },

    onShow: function () {
      if (this.getTabBar()) {
        this.getTabBar().setData({ selected: 0 })
      }
      const loggedIn = app.hasLoginApproval()
      this.setData({
        loggedIn: loggedIn,
        identityPending: !loggedIn && Boolean(app.globalData.identityConfirming),
        greeting: greetingText(loggedIn, app.globalData.profile),
        todayLabel: time.todayLabel(),
        displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, app.globalData.profile)
      })
      if (app.globalData.cloudAvailable && loggedIn) {
        this.loadDashboard()
        this.loadAlerts()
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
        assetsText: '—',
        liabilitiesText: '—',
        assetShares: emptyShares(),
        liabilityShares: emptyShares(),
        asOfText: '',
        alertImportText: '',
        alertDueText: '',
        alertImportParts: [],
        alertDueParts: [],
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
      this.loadAlerts()
    },

    // 两条提醒互不牵连：待核对读本机草稿（不联网，读不到就是没有），待还独立读取、
    // 独立失败，任何一条出问题都不影响另一条，也不影响净值卡。
    loadAlerts: function () {
      if (!app.hasLoginApproval()) return Promise.resolve()
      const self = this
      const isCurrent = pageReadSession.capture(this)
      const ticket = {}
      this._alertsTicket = ticket
      const apply = function (key, value) {
        if (!isCurrent() || self._alertsTicket !== ticket) return
        self.setData({ [key]: value })
      }
      const importParts = draftAlertParts(draftSessions.savedProgress())
      apply('alertImportParts', importParts)
      apply('alertImportText', alertText(importParts))
      return api.callApi('loans.dueThisMonth', { month: time.currentMonth() }).then(function (result) {
        const dueParts = dueAlertParts(result)
        apply('alertDueParts', dueParts)
        apply('alertDueText', alertText(dueParts))
      }, function () {
        apply('alertDueParts', [])
        apply('alertDueText', '')
      })
    },

    fetchDashboard: function (month, options) {
      const query = dashboardQuery(month)
      return api.callApi('dashboard.get', query, options).catch(function (error) {
        if (!error || error.code !== 'INITIALIZATION_REQUIRED') throw error
        return api.bootstrap({ force: true }).then(function (result) {
          app.globalData.categories = Array.isArray(result.categories) ? result.categories : []
          return api.callApi('dashboard.get', query, options)
        })
      })
    },

    onHide: function(){pageReadSession.end(this)},
    onUnload: function(){pageReadSession.end(this)},
    loadDashboard: function (options) {
      const month = time.currentMonth()
      const query = dashboardQuery(month)
      const snapshot = api.displaySnapshot('dashboard.get', query)
      const isCurrent = pageReadSession.begin(this, ['loading', 'hasDashboard', 'errorMessage', 'netWorthText', 'incomeText', 'expenseText', 'assetsText', 'liabilitiesText', 'assetShares', 'liabilityShares', 'asOfText', 'alertImportText', 'alertDueText', 'alertImportParts', 'alertDueParts', 'trendReady', 'trendSparse', 'cashFlowTrend', 'accounts', 'recentTransactions', 'dashboardStatus', 'dashboardFresh', 'chargeSyncMessage', 'chargeSyncComplete'], ['_dashboardLoad'])
      if (this._dashboardLoad || !app.hasLoginApproval()) {
        return this._dashboardLoad || Promise.resolve()
      }
      const self = this
      const readTicket = {}
      this._dashboardReadTicket = readTicket
      const startedAt = Date.now()
      const force = Boolean(options && (options.force || options.currentTarget))
      this.setData({ loading: force || !api.isFresh('dashboard.get', query), errorMessage: '', month: month, dashboardFresh: false,
        dashboardStatus: this.data.hasDashboard || snapshot ? '显示上次结果，正在检查费用并更新' : '正在检查费用并读取账本' })

      const applyDashboard = function (dashboard, state) {
          if (!isCurrent()) return
          const cashFlowTrend = Array.isArray(dashboard.cashFlowTrend) ? dashboard.cashFlowTrend : []
          let assetsMinor = '0', liabilitiesMinor = '0'
          ;(Array.isArray(dashboard.accounts) ? dashboard.accounts : []).forEach(function (account) {
            if (account.nature === 'liability') liabilitiesMinor = addMinor(liabilitiesMinor, account.bookBalanceMinor || '0')
            else assetsMinor = addMinor(assetsMinor, account.bookBalanceMinor || '0')
          })
          // 本月收支不再上首屏：导入滞后一个月，本月结构性为 0，摆在净资产旁边会读成「这个月没花钱」。
          const shares = composition.composition(dashboard.accounts)
          self.setData({
            netWorthText: money.formatMinor(dashboard.netWorthMinor),
            incomeText: money.formatMinor(dashboard.summary.incomeMinor),
            expenseText: money.formatMinor(dashboard.summary.expenseMinor),
            assetsText: money.formatMinor(assetsMinor),
            liabilitiesText: liabilitiesMinor === '0' ? '—' : money.formatMinor(liabilitiesMinor.charAt(0) === '-' ? liabilitiesMinor.slice(1) : liabilitiesMinor),
            assetShares: shares.assets,
            liabilityShares: shares.liabilities,
            asOfText: asOfLabel(dashboard.recentTransactions),
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
          self.setData({ errorMessage: self.data.hasDashboard ? '更新未成功，当前显示上次结果' : '首页暂未读取', dashboardFresh: false, dashboardStatus: self.data.hasDashboard ? '更新未完成，当前显示上次结果' : '' })
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
      tabRouter.openTab('transactions')
    },

    createTransaction: function () {
      wx.navigateTo({ url: '/pages/transaction-editor/index' })
    },

    openImport: function () {
      wx.navigateTo({ url: '/packages/finance/pages/import-workbench/index' })
    },

    openLoans: function () {
      if (!app.hasLoginApproval()) {
        this.promptWechatLogin(this.openLoans.bind(this))
        return
      }
      wx.navigateTo({ url: '/packages/finance/pages/loans/index' })
    },

    openStatistics: function () {
      if (!app.hasLoginApproval()) {
        this.promptWechatLogin(this.openStatistics.bind(this))
        return
      }
      tabRouter.openTab('statistics')
    }
  }
}

module.exports = { createHomePage }
