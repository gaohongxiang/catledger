const api = require('../../services/catledger-api')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')

function prepareCategories(rows) {
  return rows.map(function (row) {
    const percentage = row.shareBasisPoints / 100
    return Object.assign({}, row, {
      amountText: money.formatMinor(row.amountMinor),
      shareText: (percentage % 1 === 0 ? percentage.toFixed(0) : percentage.toFixed(1)) + '%',
      barWidth: Math.max(3, percentage) + '%'
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
    daily: [],
    expenseCategories: [],
    incomeCategories: []
  },

  onLoad: function () {
    themeService.bindPage(this)
    this.setData({ monthLabel: time.monthLabel(this.data.month) })
    loginGuard.run(this, this.loadStatistics.bind(this))
  },

  onShow: function () {
    themeService.bindPage(this)
  },

  onPullDownRefresh: function () {
    this.loadStatistics().finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  loadStatistics: function () {
    if (this.data.loading) {
      return Promise.resolve()
    }
    const self = this
    this.setData({ loading: true, errorMessage: '' })
    return api.callApi('statistics.get', { month: this.data.month })
      .then(function (result) {
        self.setData({
          incomeText: money.formatMinor(result.summary.incomeMinor),
          expenseText: money.formatMinor(result.summary.expenseMinor),
          netText: money.formatMinor(result.summary.netIncomeMinor),
          daily: result.daily.map(function (row) {
            return Object.assign({}, row, {
              dayText: String(Number(row.date.slice(8))),
              expenseText: money.formatMinor(row.expenseMinor),
              barHeight: row.expenseHeightPermille === 0 ? 4 : Math.max(10, Math.round(row.expenseHeightPermille * 0.12))
            })
          }),
          expenseCategories: prepareCategories(result.expenseCategories),
          incomeCategories: prepareCategories(result.incomeCategories)
        })
      })
      .catch(function (error) {
        self.setData({ errorMessage: error.message || '统计加载失败' })
      })
      .finally(function () {
        self.setData({ loading: false })
      })
  },

  previousMonth: function () {
    this.changeMonth(-1)
  },

  nextMonth: function () {
    this.changeMonth(1)
  },

  changeMonth: function (delta) {
    const month = time.shiftMonth(this.data.month, delta)
    this.setData({ month: month, monthLabel: time.monthLabel(month) })
    this.loadStatistics()
  }
})
