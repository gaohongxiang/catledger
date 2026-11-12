const { buildStatisticsView, buildLiabilityView, buildMetricsView, categoryDeltaText } = require('./model')
const pageReadSession = require('../../services/page-read-session')
const readCache = require('../../services/read-cache')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const { bandColorFor } = require('../../utils/category-palette')

function prepareCategories(rows, ring, comparisons) {
  return (rows || []).map(function (row) {
    const positive = Number(row.amountMinor) > 0
    const percentage = positive && Number(ring.totalMinor) > 0 ? Number(row.amountMinor) / Number(ring.totalMinor) * 100 : 0
    const legend = ring.legend.find(item => item.name === row.name) || ring.legend[ring.legend.length - 1]
    const key = row.categoryId == null ? '' : String(row.categoryId)
    const comparison = comparisons ? comparisons[key] : null
    return Object.assign({}, row, {
      children: (row.children || []).map(child => Object.assign({}, child, { amountText: money.formatMinor(child.amountMinor) })),
      color: positive && legend ? legend.color : '#958b82',
      bandColor: bandColorFor(row.name, row.systemKey),
      amountText: money.formatMinor(row.amountMinor),
      shareText: Number(row.amountMinor) < 0 ? '退款抵减' : (percentage % 1 === 0 ? percentage.toFixed(0) : percentage.toFixed(1)) + '%',
      barWidth: Math.max(0, Math.min(100, percentage)) + '%',
      delta: Number(row.amountMinor) < 0 ? null : categoryDeltaText(comparison)
    })
  })
}

// 把环图图例（name/categoryId/amountText/shareText/color）补上环比 delta，供「图例即排行」直接渲染。
// 收入图例没有 delta（不做收入环比），comparisons 传 null 即可。
function prepareRingLegend(ring, comparisons) {
  if (!ring) return { src: '', totalText: '', hasNegative: false, legend: [] }
  return Object.assign({}, ring, {
    legend: (ring.legend || []).map(function (item) {
      const key = item.categoryId == null ? '' : String(item.categoryId)
      const comparison = comparisons ? comparisons[key] : null
      return Object.assign({}, item, { delta: comparison ? categoryDeltaText(comparison) : null })
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

function monthParts(month) {
  const parts = String(month || '').split('-')
  return { monthYear: parts[0] || '', monthNumber: String(Number(parts[1]) || 0) }
}

// 月份条：以当前所选月为中心，前 5 后 1 共 7 个 chip；跨年时 chip 仍只显示「月」，
// 年份由标题统一标注（当前视图年份）。点击 chip 直接切到该月。
function buildMonthOptions(month) {
  const options = []
  for (let offset = -5; offset <= 1; offset += 1) {
    const value = time.shiftMonth(month, offset)
    options.push({ value: value, year: Number(value.slice(0, 4)), month: Number(value.slice(5)) })
  }
  return options
}

function createStatisticsPage(dependencies) {
  const { app, api, themeService, wx } = dependencies
  return {
    data: {
      loggedIn: false,
      categoryKind: '', compositionKind: 'expense', expandedCategoryId: '', completionCategoryIndex: -1,
      rings: { expense: null, income: null },
      charts: null,
      selectedCumulative: null,
      weekdays: ['一', '二', '三', '四', '五', '六', '日'],
      month: time.currentMonth(),
      monthLabel: '',
      monthYear: '',
      monthNumber: '',
      monthOptions: [],
      netTone: '',
      summaryScopeAll: false,
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
      liabilityView: { hasLiabilities: false, rows: [], interestRows: [] },
      metricsView: {},
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
      this.openCompletionAfterLoad = Boolean(options && options.completeCategories === '1')
      const p = monthParts(this.data.month)
      this.setData({ monthLabel: time.monthLabel(this.data.month), monthYear: p.monthYear, monthNumber: p.monthNumber, monthOptions: buildMonthOptions(this.data.month) })
    },

    onShow: function () {
      this.setData({ loggedIn: app.hasLoginApproval() })
      this.beginReadSession()
      const tabBar = this.getTabBar && this.getTabBar()
      if (tabBar) tabBar.setData({ selected: 2, hidden: false })
      if (!app.hasLoginApproval()) {
        this.openCompletionAfterLoad = false
        return
      }
      if (app.globalData.openStatisticsCompletion) {
        if (this._statisticsLoad) {
          const current = pageReadSession.capture(this)
          return this._statisticsLoad.then(() => { if (current()) return this.onShow() })
        }
        const month = time.currentMonth()
        if (this.data.month !== month) { const p = monthParts(month); this.setData({ month: month, monthLabel: time.monthLabel(month), monthYear: p.monthYear, monthNumber: p.monthNumber, monthOptions: buildMonthOptions(month), hasLoaded: false, categoryKind: '' }) }
        app.globalData.openStatisticsCompletion = false
        this.openCompletionAfterLoad = true
      }
      this.onThemeChange()
      if (!this.data.hasLoaded || this.openCompletionAfterLoad || this._trendMonth !== time.currentMonth() || !api.isFresh('statistics.get', this.statisticsRequest())) {
        loginGuard.run(this, this.loadStatistics.bind(this))
      }
    },

    onThemeChange: function () {
      // 隐藏 tab 也重画已有 SVG；仅同一用户的既有读模型可用于展示。
      if (this._statisticsResult && this._readSession === readCache.getSession()) {
        const tokens = themeService.currentTokens()
        const key = [tokens.income, tokens.expense, tokens.accent, tokens.line, tokens.textMuted].join('|')
        if (key !== this._chartTheme) {
          this._chartTheme = key
          const charts = buildStatisticsView(this._statisticsResult, tokens)
          this.setData({ charts: charts, expenseCategories: prepareCategories(this._statisticsResult.expenseCategories, charts.expenseRing, this._statisticsResult.categoryComparisons && this._statisticsResult.categoryComparisons.expense), incomeCategories: prepareCategories(this._statisticsResult.incomeCategories, charts.incomeRing), rings: { expense: prepareRingLegend(charts.expenseRing, this._statisticsResult.categoryComparisons && this._statisticsResult.categoryComparisons.expense), income: prepareRingLegend(charts.incomeRing, null) }, liabilityView: buildLiabilityView(this._statisticsResult.liabilities, tokens), metricsView: buildMetricsView(this._statisticsResult.metrics, this._statisticsResult.comparisons, this._statisticsResult.month) })
        }
      }
    },

    onHide: function () { pageReadSession.end(this); this.setData({ categorySheetOpen: false }); this.setTabHidden(false) },
    onUnload: function () { pageReadSession.end(this) },

    stopPullDownRefresh: function () { wx.stopPullDownRefresh() },

  onPullDownRefresh: function () {
      if (!app.hasLoginApproval()) { this.stopPullDownRefresh(); return }
      this.loadStatistics({ force: true }).finally(() => { this.stopPullDownRefresh() })
    },

    beginReadSession: function () {
      return pageReadSession.begin(this, ['expandedCategoryId', 'completionCategoryIndex', 'categoryKind', 'compositionKind', 'rings', 'monthYear', 'monthNumber', 'monthOptions', 'netTone', 'summaryScopeAll', 'charts', 'selectedCumulative', 'loading', 'hasLoaded', 'errorMessage', 'incomeText', 'expenseText', 'netText', 'cashFlowTrend', 'daily', 'selectedTrend', 'selectedDay', 'expenseCategories', 'incomeCategories', 'metrics', 'metricsView', 'liabilityView', 'uncategorized', 'categorySheetOpen', 'categorySheetLoading', 'categorySaving', 'selectedCategoryId', 'categoryGroups', 'categoryOptions', 'selectedCategoryGroup'], ['_statisticsLoad', '_statisticsResult', 'allCategoryOptions'])
    },

    promptLogin: function () { loginGuard.run(this, this.loadStatistics.bind(this)) },

    statisticsRequest: function () { return { month: this.data.month, trendEndMonth: time.currentMonth() } },

    loadStatistics: function (options) {
      const isCurrent = this.beginReadSession()
      this.setData({ loggedIn: app.hasLoginApproval() })
      if (!app.hasLoginApproval()) return Promise.resolve()
      if (this._statisticsLoad) return this._statisticsLoad
      const self = this
      const force = Boolean(options && options.force)
      this.setData({ loading: force || !api.isFresh('statistics.get', this.statisticsRequest()), errorMessage: '' })
      const trendMonth = time.currentMonth()
      const selectedTrendMonth = this.data.selectedTrend && this.data.selectedTrend.month
      const applyStatistics = function (result, snapshot) {
          if (!isCurrent()) return
          self._trendMonth = trendMonth
          self._statisticsResult = result
          const tokens = themeService.currentTokens()
          self._chartTheme = [tokens.income, tokens.expense, tokens.accent, tokens.line, tokens.textMuted].join('|')
          const charts = buildStatisticsView(result, tokens)
          const trend = prepareTrend(result.cashFlowTrend)
          const metrics = result.metrics || {}
          const uncategorized = result.uncategorized || {}
          self.setData({
            charts: charts,
            selectedCumulative: null,
            hasLoaded: true,
            errorMessage: snapshot ? '正在更新，当前显示上次结果' : '',
            selectedTrend: trend.find(row => row.month === selectedTrendMonth) || trend[trend.length - 1] || null, selectedDay: null,
            incomeText: money.formatMinor(result.summary.incomeMinor),
            expenseText: money.formatMinor(result.summary.expenseMinor),
            netText: money.formatMinor(result.summary.netIncomeMinor),
            netTone: String(result.summary.netIncomeMinor || '0').charAt(0) === '-' ? 'hero-amount-neg' : '',
            summaryScopeAll: Boolean(result.summaryScope && result.summaryScope === 'all'),
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
            expenseCategories: prepareCategories(result.expenseCategories, charts.expenseRing, result.categoryComparisons && result.categoryComparisons.expense),
            incomeCategories: prepareCategories(result.incomeCategories, charts.incomeRing),
            rings: {
              expense: prepareRingLegend(charts.expenseRing, result.categoryComparisons && result.categoryComparisons.expense),
              income: prepareRingLegend(charts.incomeRing, null)
            },
            liabilityView: buildLiabilityView(result.liabilities, tokens),
            metricsView: buildMetricsView(result.metrics, result.comparisons, result.month)
          })
          if (!snapshot && self.openCompletionAfterLoad) {
            self.openCompletionAfterLoad = false
            self.openCategoryCompletion()
          }
      }
      this._statisticsLoad = require('../../services/loan-charge-sync').beforePage(this,isCurrent,{force}).then(()=>api.callApi('statistics.get',this.statisticsRequest(),{force,onSnapshot:result=>applyStatistics(result,true)}))
        .then(result => applyStatistics(result, false))
        .catch(function (error) {
          if (!isCurrent()) return
          self.setData({ errorMessage: self.data.hasLoaded ? '更新未成功，当前显示上次结果' : error.message || '统计加载失败' }) })
        .finally(() => {
          if (!isCurrent()) return
          self.setData({ loading: false }); self._statisticsLoad = null })
      return this._statisticsLoad
    },

    selectCompositionKind: function (event) {
      const kind = event.currentTarget.dataset.kind
      if (kind === 'expense' || kind === 'income' || kind === 'calendar') {
        // 日历视图不是分类维度：categoryKind 仅用于分类展开，日历时置空。
        this.setData({ compositionKind: kind, categoryKind: (kind === 'calendar' ? '' : kind), expandedCategoryId: '', selectedDay: null })
      }
    },

    chooseMonth: function (event) {
      if (this.data.loading || this.data.categorySaving) return
      const month = event.detail.value
      const p = monthParts(month)
      this.setData({ month: month, monthLabel: time.monthLabel(month), monthYear: p.monthYear, monthNumber: p.monthNumber, monthOptions: buildMonthOptions(month), hasLoaded: false, categoryKind: '' })
      return this.loadStatistics()
    },

    pickMonth: function (event) {
      const value = event.currentTarget.dataset.value
      if (value && value !== this.data.month) return this.chooseMonth({ detail: { value: value } })
    },

    previousMonth: function () { return this.chooseMonth({ detail: { value: time.shiftMonth(this.data.month, -1) } }) },
    nextMonth: function () { return this.chooseMonth({ detail: { value: time.shiftMonth(this.data.month, 1) } }) },

    selectTrend: function (event) {
      const row = this.data.cashFlowTrend[Number(event.currentTarget.dataset.index)]
      if (row) this.setData({ selectedTrend: row })
    },

    selectDay: function (event) {
      // 日历格数据在 charts.calendar（含 netText/hasIncome 等），按 date 取；daily 只有收支额，缺净额。
      const date = event.currentTarget.dataset.date
      const calendar = (this.data.charts && this.data.charts.calendar) || []
      const row = date ? calendar.find(cell => cell.date === date) : null
      if (row && !row.blank) this.setData({ selectedDay: row })
    },

    openUnclassifiedCategory: function (event) {
      if (event.currentTarget.dataset.unclassified) return this.openCategoryCompletion()
      const id = event.currentTarget.dataset.id
      this.setData({ expandedCategoryId: this.data.expandedCategoryId === id ? '' : id })
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
        .finally(() => { if (isCurrent()) self.setData({ categorySheetLoading: false }) })
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
        selectedCategoryId: '', completionCategoryIndex: -1,
        categoryOptions: (this.allCategoryOptions || []).filter(function (category) { return category.kind === group.kind })
      })
    },

    returnToCategoryGroups: function () {
      if (!this.data.categorySaving) this.setData({ selectedCategoryGroup: null, selectedCategoryId: '' })
    },

    selectCompletionCategory: function (event) {
      const index = Number(event.detail.value), row = this.data.categoryOptions[index]
      if (row) this.setData({ selectedCategoryId: row.id, completionCategoryIndex: index })
    },

    saveCategoryCompletion: function () {
      const group = this.data.selectedCategoryGroup
      if (!group || !this.data.selectedCategoryId || this.data.categorySaving) return
      const self = this
      const isCurrent = pageReadSession.capture(this)
      const session = readCache.getSession()
      this.setData({ categorySaving: true })
      return api.callApi('categories.assignTransactions', {
        requestId: api.createRequestId(),
        categoryId: this.data.selectedCategoryId,
        items: group.members
      }).then(function () {
        if (!isCurrent()) return
        wx.showToast({ title: '分类已补全', icon: 'success' })
        self.setData({ categorySheetOpen: false })
        self.setTabHidden(false)
        return self.loadStatistics()
      }).catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '分类保存失败' })
      }).finally(() => {
        // 命令完成可解除同一会话的忙态，但隐藏面板不得因此重新读取或影响共享底栏。
        if (!self._panelDisposed && session === readCache.getSession()) self.setData({ categorySaving: false })
      })
    }
  }
}

module.exports = { createStatisticsPage }
