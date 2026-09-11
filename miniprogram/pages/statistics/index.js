const app = getApp()
const { buildStatisticsView } = require('./model')
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')

function prepareCategories(rows, ring) {
  return (rows || []).map(function (row) {
    const positive = Number(row.amountMinor) > 0
    const percentage = positive && Number(ring.totalMinor) > 0 ? Number(row.amountMinor) / Number(ring.totalMinor) * 100 : 0
    const legend = ring.legend.find(item => item.name === row.name) || ring.legend[ring.legend.length - 1]
    return Object.assign({}, row, {
      color: positive && legend ? legend.color : '#958b82',
      amountText: money.formatMinor(row.amountMinor),
      shareText: Number(row.amountMinor) < 0 ? '退款抵减' : (percentage % 1 === 0 ? percentage.toFixed(0) : percentage.toFixed(1)) + '%',
      barWidth: Math.max(0, Math.min(100, percentage)) + '%'
    })
  })
}

function prepareTrend(rows) {
  return (rows || []).map(function (row) {
    return Object.assign({}, row, {
      monthText: String(Number(row.month.slice(5))),
      monthLabel: time.monthLabel(row.month),
      incomeText: money.formatMinor(row.incomeMinor),
      expenseText: money.formatMinor(row.expenseMinor)
    })
  })
}

function prepareDaily(rows) {
  return (rows || []).map(function (row) {
    return Object.assign({}, row, {
      dayText: String(Number(row.date.slice(8))),
      incomeText: money.formatMinor(row.incomeMinor),
      expenseText: money.formatMinor(row.expenseMinor)
    })
  })
}

function prepareCategoryGroups(groups) {
  return (groups || []).map(function (group) {
    return Object.assign({}, group, {
      kindLabel: group.kind === 'income' ? '收入' : '支出',
      amountText: money.formatMinor(group.amountMinor)
    })
  })
}

Page({
  data: {
    loggedIn: false,
    categoryKind: '',
    charts: null,
    selectedCumulative: null,
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    month: time.currentMonth(),
    monthLabel: '',
    loading: false,
    hasLoaded: false,
    errorMessage: '',
    incomeText: '¥0.00',
    expenseText: '¥0.00',
    netText: '¥0.00',
    cashFlowTrend: [],
    daily: [],
    selectedTrend: null,
    selectedDay: null,
    expenseCategories: [],
    incomeCategories: [],
    metrics: {},
    uncategorized: { transactionCount: 0, amountText: '¥0.00' },
    categorySheetOpen: false,
    categorySheetLoading: false,
    categorySaving: false,
    categoryGroups: [],
    categoryOptions: [],
    selectedCategoryGroup: null,
    selectedCategoryId: ''
  },

  onLoad: function (options) {
    themeService.bindPage(this)
    this.openCompletionAfterLoad = Boolean(options && options.completeCategories === '1')
    this.setData({ monthLabel: time.monthLabel(this.data.month) })
  },

  onShow: function () {
    this.setData({ loggedIn: app.hasLoginApproval() })
    themeService.bindPage(this)
    this.beginReadSession()
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) tabBar.setData({ selected: 2, hidden: false })
    if (!app.hasLoginApproval()) {
      this.openCompletionAfterLoad = false
      return
    }
    if (app.globalData.openStatisticsCompletion) {
      if (this._statisticsLoad) return this._statisticsLoad.then(this.onShow.bind(this))
      const month = time.currentMonth()
      if (this.data.month !== month) this.setData({ month: month, monthLabel: time.monthLabel(month), hasLoaded: false, categoryKind: '' })
      app.globalData.openStatisticsCompletion = false
      this.openCompletionAfterLoad = true
    }
    if (this._statisticsResult && pageReadSession.isCurrent(this)) {
      const tokens = themeService.currentTokens()
      const key = [tokens.income, tokens.expense, tokens.accent].join('|')
      if (key !== this._chartTheme) {
        this._chartTheme = key
        const charts = buildStatisticsView(this._statisticsResult, tokens)
        this.setData({ charts: charts, expenseCategories: prepareCategories(this._statisticsResult.expenseCategories, charts.expenseRing), incomeCategories: prepareCategories(this._statisticsResult.incomeCategories, charts.incomeRing) })
      }
    }
    if (!this.data.hasLoaded || this.openCompletionAfterLoad || this._trendMonth !== time.currentMonth() || !api.isFresh('statistics.get', { month: this.data.month })) {
      loginGuard.run(this, this.loadStatistics.bind(this))
    }
  },

  onHide: function () { this.setData({ categorySheetOpen: false }); this.setTabHidden(false) },

  onPullDownRefresh: function () {
    if (!app.hasLoginApproval()) { wx.stopPullDownRefresh(); return }
    this.loadStatistics({ force: true }).finally(function () { wx.stopPullDownRefresh() })
  },

  beginReadSession: function () {
    return pageReadSession.begin(this, ['categoryKind', 'charts', 'selectedCumulative', 'loading', 'hasLoaded', 'errorMessage', 'incomeText', 'expenseText', 'netText', 'cashFlowTrend', 'daily', 'selectedTrend', 'selectedDay', 'expenseCategories', 'incomeCategories', 'metrics', 'uncategorized', 'categorySheetOpen', 'categorySheetLoading', 'categorySaving', 'selectedCategoryId', 'categoryGroups', 'categoryOptions', 'selectedCategoryGroup'], ['_statisticsLoad', '_statisticsResult', 'allCategoryOptions'])
  },

  promptLogin: function () { loginGuard.run(this, this.loadStatistics.bind(this)) },

  loadStatistics: function (options) {
    const isCurrent = this.beginReadSession()
    this.setData({ loggedIn: app.hasLoginApproval() })
    if (!app.hasLoginApproval()) return Promise.resolve()
    if (this._statisticsLoad) return this._statisticsLoad
    const self = this
    const force = Boolean(options && options.force)
    this.setData({ loading: force || !api.isFresh('statistics.get', { month: this.data.month }), errorMessage: '' })
    const trendMonth = time.currentMonth()
    const selectedTrendMonth = this.data.selectedTrend && this.data.selectedTrend.month
    this._statisticsLoad = Promise.all([
      api.callApi('statistics.get', { month: this.data.month }, { force: force }),
      this.data.month === trendMonth ? Promise.resolve(null) : api.callApi('dashboard.get', { month: trendMonth }, { force: force })
    ])
      .then(function (results) {
        const result = Object.assign({}, results[0], results[1] ? { cashFlowTrend: results[1].cashFlowTrend } : {})
        if (!isCurrent()) return
        self._trendMonth = trendMonth
        self._statisticsResult = result
        const tokens = themeService.currentTokens()
        self._chartTheme = [tokens.income, tokens.expense, tokens.accent].join('|')
        const charts = buildStatisticsView(result, tokens)
        const trend = prepareTrend(result.cashFlowTrend)
        const metrics = result.metrics || {}
        const uncategorized = result.uncategorized || {}
        self.setData({
          charts: charts,
          selectedCumulative: null,
          hasLoaded: true,
          selectedTrend: trend.find(row => row.month === selectedTrendMonth) || trend[trend.length - 1] || null, selectedDay: null,
          incomeText: money.formatMinor(result.summary.incomeMinor),
          expenseText: money.formatMinor(result.summary.expenseMinor),
          netText: money.formatMinor(result.summary.netIncomeMinor),
          cashFlowTrend: trend,
          daily: prepareDaily(result.daily),
          metrics: {
            transactionCount: metrics.transactionCount || 0,
            activeDayCount: metrics.activeDayCount || 0,
            averageDailyExpenseText: money.formatMinor(metrics.averageDailyExpenseMinor || '0'),
            largestExpenseText: money.formatMinor(metrics.largestExpenseMinor || '0')
          },
          uncategorized: {
            transactionCount: uncategorized.transactionCount || 0,
            amountText: money.formatMinor(uncategorized.amountMinor || '0')
          },
          expenseCategories: prepareCategories(result.expenseCategories, charts.expenseRing),
          incomeCategories: prepareCategories(result.incomeCategories, charts.incomeRing)
        })
        if (self.openCompletionAfterLoad) {
          self.openCompletionAfterLoad = false
          self.openCategoryCompletion()
        }
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '统计加载失败' }) })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false }); self._statisticsLoad = null })
    return this._statisticsLoad
  },

  selectCategoryKind: function (event) {
    const kind = event.currentTarget.dataset.kind
    if (kind === 'expense' || kind === 'income') this.setData({ categoryKind: this.data.categoryKind === kind ? '' : kind })
  },

  chooseMonth: function (event) {
    if (this.data.loading || this.data.categorySaving) return
    const month = event.detail.value
    this.setData({ month: month, monthLabel: time.monthLabel(month), hasLoaded: false, categoryKind: '' })
    return this.loadStatistics()
  },

  previousMonth: function () { return this.chooseMonth({ detail: { value: time.shiftMonth(this.data.month, -1) } }) },
  nextMonth: function () { return this.chooseMonth({ detail: { value: time.shiftMonth(this.data.month, 1) } }) },

  selectTrend: function (event) {
    const row = this.data.cashFlowTrend[Number(event.currentTarget.dataset.index)]
    if (row) this.setData({ selectedTrend: row })
  },

  selectDay: function (event) {
    const row = this.data.daily[Number(event.currentTarget.dataset.index)]
    if (row) this.setData({ selectedDay: row })
  },

  openUnclassifiedCategory: function (event) {
    if (event.currentTarget.dataset.unclassified) return this.openCategoryCompletion()
  },

  setTabHidden: function (hidden) {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) tabBar.setData({ hidden: hidden })
  },

  openCategoryCompletion: function () {
    if (this.data.categorySheetLoading) return
    const self = this
    const isCurrent = this.beginReadSession()
    this.setTabHidden(true)
    this.setData({
      categorySheetOpen: true,
      categorySheetLoading: true,
      selectedCategoryGroup: null,
      selectedCategoryId: '',
      errorMessage: ''
    })
    api.callApi('categories.unclassified', { month: this.data.month })
      .then(function (result) {
        if (!isCurrent()) return
        self.allCategoryOptions = result.categories || []
        self.setData({ categoryGroups: prepareCategoryGroups(result.groups) })
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '待分类账目加载失败', categorySheetOpen: false })
        self.setTabHidden(false)
      })
      .finally(function () { if (isCurrent()) self.setData({ categorySheetLoading: false }) })
  },

  closeCategoryCompletion: function () {
    if (!this.data.categorySaving) { this.setData({ categorySheetOpen: false }); this.setTabHidden(false) }
  },

  preventTouchMove: function () {},

  selectCategoryGroup: function (event) {
    const key = event.currentTarget.dataset.key
    const group = this.data.categoryGroups.find(function (item) { return item.groupKey === key })
    if (!group) return
    this.setData({
      selectedCategoryGroup: group,
      selectedCategoryId: '',
      categoryOptions: (this.allCategoryOptions || []).filter(function (category) { return category.kind === group.kind })
    })
  },

  returnToCategoryGroups: function () {
    if (!this.data.categorySaving) this.setData({ selectedCategoryGroup: null, selectedCategoryId: '' })
  },

  selectCompletionCategory: function (event) {
    this.setData({ selectedCategoryId: event.currentTarget.dataset.id })
  },

  saveCategoryCompletion: function () {
    const group = this.data.selectedCategoryGroup
    if (!group || !this.data.selectedCategoryId || this.data.categorySaving) return
    const self = this
    this.setData({ categorySaving: true })
    api.callApi('categories.assignTransactions', {
      requestId: api.createRequestId(),
      categoryId: this.data.selectedCategoryId,
      items: group.members
    }).then(function () {
      wx.showToast({ title: '分类已补全', icon: 'success' })
      self.setData({ categorySheetOpen: false })
      self.setTabHidden(false)
      return self.loadStatistics()
    }).catch(function (error) {
      self.setData({ errorMessage: error.message || '分类保存失败' })
    }).finally(function () { self.setData({ categorySaving: false }) })
  }
})
