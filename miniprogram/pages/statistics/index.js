const api = require('../../services/catledger-api')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')

function chartHeight(permille) {
  return permille === 0 ? 3 : Math.max(10, Math.round(permille * 0.12))
}

function prepareCategories(rows) {
  return (rows || []).map(function (row) {
    const percentage = row.shareBasisPoints / 100
    return Object.assign({}, row, {
      amountText: money.formatMinor(row.amountMinor),
      shareText: (percentage % 1 === 0 ? percentage.toFixed(0) : percentage.toFixed(1)) + '%',
      barWidth: Math.max(3, percentage) + '%'
    })
  })
}

function prepareTrend(rows) {
  return (rows || []).map(function (row) {
    return Object.assign({}, row, {
      monthText: String(Number(row.month.slice(5))),
      incomeText: money.formatMinor(row.incomeMinor),
      expenseText: money.formatMinor(row.expenseMinor),
      incomeBarHeight: chartHeight(row.incomeHeightPermille),
      expenseBarHeight: chartHeight(row.expenseHeightPermille)
    })
  })
}

function prepareDaily(rows) {
  return (rows || []).map(function (row) {
    return Object.assign({}, row, {
      dayText: String(Number(row.date.slice(8))),
      incomeText: money.formatMinor(row.incomeMinor),
      expenseText: money.formatMinor(row.expenseMinor),
      incomeBarHeight: chartHeight(row.incomeHeightPermille),
      expenseBarHeight: chartHeight(row.expenseHeightPermille)
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
    month: time.currentMonth(),
    monthLabel: '',
    loading: false,
    errorMessage: '',
    incomeText: '¥0.00',
    expenseText: '¥0.00',
    netText: '¥0.00',
    cashFlowTrend: [],
    daily: [],
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
    loginGuard.run(this, this.loadStatistics.bind(this))
  },

  onShow: function () { themeService.bindPage(this) },

  onPullDownRefresh: function () {
    this.loadStatistics().finally(function () { wx.stopPullDownRefresh() })
  },

  loadStatistics: function () {
    if (this.data.loading) return Promise.resolve()
    const self = this
    this.setData({ loading: true, errorMessage: '' })
    return api.callApi('statistics.get', { month: this.data.month })
      .then(function (result) {
        const metrics = result.metrics || {}
        const uncategorized = result.uncategorized || {}
        self.setData({
          incomeText: money.formatMinor(result.summary.incomeMinor),
          expenseText: money.formatMinor(result.summary.expenseMinor),
          netText: money.formatMinor(result.summary.netIncomeMinor),
          cashFlowTrend: prepareTrend(result.cashFlowTrend),
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
          expenseCategories: prepareCategories(result.expenseCategories),
          incomeCategories: prepareCategories(result.incomeCategories)
        })
        if (self.openCompletionAfterLoad) {
          self.openCompletionAfterLoad = false
          self.openCategoryCompletion()
        }
      })
      .catch(function (error) { self.setData({ errorMessage: error.message || '统计加载失败' }) })
      .finally(function () { self.setData({ loading: false }) })
  },

  previousMonth: function () { this.changeMonth(-1) },
  nextMonth: function () { this.changeMonth(1) },

  changeMonth: function (delta) {
    const month = time.shiftMonth(this.data.month, delta)
    this.setData({ month: month, monthLabel: time.monthLabel(month) })
    this.loadStatistics()
  },

  openCategoryCompletion: function () {
    if (this.data.categorySheetLoading) return
    const self = this
    this.setData({
      categorySheetOpen: true,
      categorySheetLoading: true,
      selectedCategoryGroup: null,
      selectedCategoryId: '',
      errorMessage: ''
    })
    api.callApi('categories.unclassified', { month: this.data.month })
      .then(function (result) {
        self.allCategoryOptions = result.categories || []
        self.setData({ categoryGroups: prepareCategoryGroups(result.groups) })
      })
      .catch(function (error) {
        self.setData({ errorMessage: error.message || '待分类账目加载失败', categorySheetOpen: false })
      })
      .finally(function () { self.setData({ categorySheetLoading: false }) })
  },

  closeCategoryCompletion: function () {
    if (!this.data.categorySaving) this.setData({ categorySheetOpen: false })
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
      return self.loadStatistics()
    }).catch(function (error) {
      self.setData({ errorMessage: error.message || '分类保存失败' })
    }).finally(function () { self.setData({ categorySaving: false }) })
  }
})
