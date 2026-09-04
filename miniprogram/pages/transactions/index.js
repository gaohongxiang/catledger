const app = getApp()
const api = require('../../services/catledger-api')
const money = require('../../utils/money')
const time = require('../../utils/time')
const viewModel = require('../../utils/view-model')
const themeService = require('../../theme/service')

Page({
  data: {
    loggedIn: false,
    month: time.currentMonth(),
    monthLabel: '',
    pickerDate: time.today(),
    selectedDate: '',
    selectedDateLabel: '',
    loading: false,
    loadingMore: false,
    errorMessage: '',
    search: '',
    incomeText: '¥0.00',
    expenseText: '¥0.00',
    netText: '¥0.00',
    netClass: 'amount-neutral',
    searchOpen: false,
    transactions: [],
    nextCursor: null,
    accountFilterIndex: 0,
    categoryFilterIndex: 0,
    accountFilters: [{ accountId: '', name: '全部账户' }],
    categoryFilters: [{ categoryId: '', name: '全部分类' }]
  },

  onLoad: function () {
    themeService.bindPage(this)
    this.setData({ monthLabel: time.monthLabel(this.data.month) })
  },

  onShow: function () {
    themeService.bindPage(this)
    if (this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    const loggedIn = app.hasLoginApproval()
    this.setData({ loggedIn: loggedIn })
    if (loggedIn) {
      this.prepareAndLoad()
      return
    }
    this.setData({
      loading: false,
      loadingMore: false,
      errorMessage: '',
      transactions: [],
      nextCursor: null
    })
  },

  onPullDownRefresh: function () {
    if (!app.hasLoginApproval()) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadTransactions(false).finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom: function () {
    if (app.hasLoginApproval() && this.data.nextCursor) {
      this.loadTransactions(true)
    }
  },

  prepareAndLoad: function () {
    if (!app.hasLoginApproval()) {
      return Promise.resolve()
    }
    const self = this
    const bootstrapPromise = app.globalData.categories.length > 0
      ? Promise.resolve()
      : api.bootstrap().then(function (result) {
          app.globalData.categories = Array.isArray(result.categories) ? result.categories : []
        })

    Promise.all([bootstrapPromise, api.callApi('accounts.list')])
      .then(function (results) {
        const accounts = results[1].accounts.filter(function (account) { return !account.archived })
        const categories = app.globalData.categories.map(function (category) {
          return Object.assign({}, category, { categoryId: category.id })
        })
        self.setData({
          accountFilters: [{ accountId: '', name: '全部账户' }].concat(accounts),
          categoryFilters: [{ categoryId: '', name: '全部分类' }].concat(categories)
        })
        return self.loadTransactions(false)
      })
      .catch(function (error) {
        self.setData({ errorMessage: error.message || '明细加载失败' })
      })
  },

  requestData: function (cursor) {
    const account = this.data.accountFilters[this.data.accountFilterIndex]
    const category = this.data.categoryFilters[this.data.categoryFilterIndex]
    const data = {
      month: this.data.month,
      pageSize: 30,
      search: this.data.search.trim()
    }
    if (this.data.selectedDate) {
      data.date = this.data.selectedDate
    }
    if (account && account.accountId) {
      data.accountId = account.accountId
    }
    if (category && category.categoryId) {
      data.categoryId = category.categoryId
    }
    if (cursor) {
      data.cursor = cursor
    }
    return data
  },

  loadTransactions: function (append) {
    if (!app.hasLoginApproval() || this.data.loading || this.data.loadingMore) {
      return Promise.resolve()
    }
    const self = this
    this.setData(append ? { loadingMore: true } : { loading: true, errorMessage: '' })
    return api.callApi('transactions.list', this.requestData(append ? this.data.nextCursor : null))
      .then(function (result) {
        const rows = result.transactions.map(viewModel.transactionView)
        self.setData({
          transactions: append ? self.data.transactions.concat(rows) : rows,
          nextCursor: result.nextCursor,
          incomeText: money.formatMinor(result.summary.incomeMinor),
          expenseText: money.formatMinor(result.summary.expenseMinor),
          netText: money.formatMinor(result.summary.netIncomeMinor),
          netClass: String(result.summary.netIncomeMinor).charAt(0) === '-'
            ? 'amount-expense'
            : String(result.summary.netIncomeMinor) === '0'
              ? 'amount-neutral'
              : 'amount-income'
        })
      })
      .catch(function (error) {
        self.setData({ errorMessage: error.message || '明细加载失败' })
      })
      .finally(function () {
        self.setData({ loading: false, loadingMore: false })
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
    this.setData({
      month: month,
      monthLabel: time.monthLabel(month),
      pickerDate: month + '-01',
      selectedDate: '',
      selectedDateLabel: '',
      nextCursor: null
    })
    this.loadTransactions(false)
  },

  changeDate: function (event) {
    const date = event.detail.value
    const month = date.slice(0, 7)
    const parts = date.split('-')
    this.setData({
      month: month,
      monthLabel: time.monthLabel(month),
      pickerDate: date,
      selectedDate: date,
      selectedDateLabel: parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日',
      nextCursor: null
    })
    this.loadTransactions(false)
  },

  clearDate: function () {
    this.setData({ selectedDate: '', selectedDateLabel: '', nextCursor: null })
    this.loadTransactions(false)
  },

  bindSearch: function (event) {
    this.setData({ search: event.detail.value })
  },

  applySearch: function () {
    this.loadTransactions(false)
  },

  toggleSearch: function () {
    this.setData({ searchOpen: !this.data.searchOpen })
  },

  cancelSearch: function () {
    const hadSearch = this.data.search.trim().length > 0
    this.setData({ search: '', searchOpen: false })
    if (hadSearch) {
      this.loadTransactions(false)
    }
  },

  changeAccountFilter: function (event) {
    this.setData({ accountFilterIndex: Number(event.detail.value) })
    this.loadTransactions(false)
  },

  changeCategoryFilter: function (event) {
    this.setData({ categoryFilterIndex: Number(event.detail.value) })
    this.loadTransactions(false)
  },

  editTransaction: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const transaction = this.data.transactions[index]
    if (!transaction || !transaction.editable) {
      return
    }
    app.globalData.editingTransaction = transaction
    wx.navigateTo({
      url: transaction.canLinkRefund
        ? '/pages/transaction-editor/index?mode=link-refund'
        : '/pages/transaction-editor/index?mode=edit'
    })
  },

  promptWechatLogin: function () {
    const tabBar = this.getTabBar()
    if (tabBar && typeof tabBar.requestLogin === 'function') {
      tabBar.requestLogin({ afterLogin: this.onWechatLoginSuccess.bind(this) })
    }
  },

  onWechatLoginSuccess: function () {
    this.setData({ loggedIn: true })
    this.prepareAndLoad()
  }
})
