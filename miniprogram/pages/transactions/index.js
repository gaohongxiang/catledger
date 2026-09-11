const app = getApp()
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
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
    hasLoaded: false,
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
    categoryFilters: [{ categoryId: '', name: '全部分类' }, { categoryId: '__uncategorized__', name: '未分类', uncategorized: true }]
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
      hasLoaded: false,
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
    this.prepareAndLoad({ force: true }).finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom: function () {
    if (app.hasLoginApproval() && this.data.nextCursor) {
      this.loadTransactions(true)
    }
  },

  prepareAndLoad: function (options) {
    const isCurrent = pageReadSession.begin(this, ['loading', 'loadingMore', 'hasLoaded', 'errorMessage', 'transactions', 'nextCursor', 'incomeText', 'expenseText', 'netText', 'netClass', 'accountFilters', 'categoryFilters', 'accountFilterIndex', 'categoryFilterIndex'], ['_prepareLoad', '_transactionsLoad', '_listCacheToken'])
    if (!app.hasLoginApproval()) return Promise.resolve()
    if (this._prepareLoad) return this._prepareLoad
    const self = this
    const force = Boolean(options && options.force)
    const selectedAccount = this.data.accountFilters[this.data.accountFilterIndex]
    const selectedCategory = this.data.categoryFilters[this.data.categoryFilterIndex]
    const requested = this.requestData(null)
    // 筛选项与交易列表并行读取；重复切页复用整个已加载列表，包括后续分页。
    this._prepareLoad = Promise.all([
      api.bootstrap({ force: force }),
      api.callApi('accounts.list', {}, { force: force }),
      this.loadTransactions(false, { force: force, reuse: true })
    ]).then(function (results) {
        if (!isCurrent()) return
      const accounts = results[1].accounts.filter(function (account) { return !account.archived })
      const categories = (results[0].categories || []).map(function (category) {
        return Object.assign({}, category, { categoryId: category.id })
      })
      app.globalData.categories = results[0].categories || []
      const accountFilters = [{ accountId: '', name: '全部账户' }].concat(accounts)
      const categoryFilters = [{ categoryId: '', name: '全部分类' }, { categoryId: '__uncategorized__', name: '未分类', uncategorized: true }].concat(categories)
      self.setData({
        accountFilters: accountFilters,
        categoryFilters: categoryFilters,
        accountFilterIndex: Math.max(0, accountFilters.findIndex(item => selectedAccount && item.accountId === selectedAccount.accountId)),
        categoryFilterIndex: Math.max(0, categoryFilters.findIndex(item => selectedCategory && item.categoryId === selectedCategory.categoryId))
      })
      const current = self.requestData(null)
      if (requested.accountId !== current.accountId || requested.categoryId !== current.categoryId || requested.uncategorized !== current.uncategorized) {
        return self.loadTransactions(false)
      }
    }).catch(function (error) {
        if (!isCurrent()) return
      self.setData({ errorMessage: error.message || '明细加载失败' })
    }).finally(function () {
        if (!isCurrent()) return
        self._prepareLoad = null })
    return this._prepareLoad
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
    if (category && category.uncategorized) {
      data.uncategorized = true
    } else if (category && category.categoryId) {
      data.categoryId = category.categoryId
    }
    if (cursor) {
      data.cursor = cursor
    }
    return data
  },

  loadTransactions: function (append, options) {
    const isCurrent = pageReadSession.begin(this, ['loading', 'loadingMore', 'hasLoaded', 'errorMessage', 'transactions', 'nextCursor', 'incomeText', 'expenseText', 'netText', 'netClass', 'accountFilters', 'categoryFilters', 'accountFilterIndex', 'categoryFilterIndex'], ['_prepareLoad', '_transactionsLoad', '_listCacheToken'])
    if (!app.hasLoginApproval() || this._transactionsLoad) {
      return this._transactionsLoad || Promise.resolve()
    }
    const baseToken = api.cacheToken('transactions.list', this.requestData(null))
    if (append && (!baseToken || baseToken !== this._listCacheToken)) return this.loadTransactions(false, { force: true })
    if (options && options.reuse && !options.force && this.data.hasLoaded && baseToken && baseToken === this._listCacheToken) return Promise.resolve()
    const self = this
    const data = this.requestData(append ? this.data.nextCursor : null)
    const force = Boolean(options && options.force)
    const needsNetwork = force || !api.isFresh('transactions.list', data)
    this.setData(append ? { loadingMore: needsNetwork } : { loading: needsNetwork, errorMessage: '' })
    this._transactionsLoad = api.callApi('transactions.list', data, { force: force })
      .then(function (result) {
        if (!isCurrent()) return
        if (append && api.cacheToken('transactions.list', self.requestData(null)) !== baseToken) {
          self._transactionsLoad = null
          return self.loadTransactions(false, { force: true })
        }
        if (!append) self._listCacheToken = api.cacheToken('transactions.list', data)
        const rows = result.transactions.map(viewModel.transactionView)
        self.setData({
          hasLoaded: true,
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
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '明细加载失败' })
      })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false, loadingMore: false })
        self._transactionsLoad = null
      })
    return this._transactionsLoad
  },

  previousMonth: function () {
    this.changeMonth(-1)
  },

  nextMonth: function () {
    this.changeMonth(1)
  },

  changeMonth: function (delta) {
    if (this.data.loading || this.data.loadingMore) return
    const month = time.shiftMonth(this.data.month, delta)
    this.setData({
      month: month,
      monthLabel: time.monthLabel(month),
      pickerDate: month + '-01',
      selectedDate: '',
      selectedDateLabel: '',
      nextCursor: null, hasLoaded: false, transactions: []
    })
    this.loadTransactions(false)
  },

  changeDate: function (event) {
    if (this.data.loading || this.data.loadingMore) return
    const date = event.detail.value
    const month = date.slice(0, 7)
    const parts = date.split('-')
    this.setData({
      month: month,
      monthLabel: time.monthLabel(month),
      pickerDate: date,
      selectedDate: date,
      selectedDateLabel: parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日',
      nextCursor: null, hasLoaded: false, transactions: []
    })
    this.loadTransactions(false)
  },

  clearDate: function () {
    if (this.data.loading || this.data.loadingMore) return
    this.setData({ selectedDate: '', selectedDateLabel: '', nextCursor: null, hasLoaded: false, transactions: [] })
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
    if (this.data.loading || this.data.loadingMore) return
    this.setData({ accountFilterIndex: Number(event.detail.value), hasLoaded: false, transactions: [] })
    this.loadTransactions(false)
  },

  changeCategoryFilter: function (event) {
    if (this.data.loading || this.data.loadingMore) return
    this.setData({ categoryFilterIndex: Number(event.detail.value), hasLoaded: false, transactions: [] })
    this.loadTransactions(false)
  },

  editTransaction: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const transaction = this.data.transactions[index]
    if (!transaction) return
    app.globalData.editingTransaction = transaction
    const imported = transaction.origin === 'import' || Boolean(transaction.importContext)
    const mode = imported ? 'import' : (transaction.editable ? 'edit' : 'view')
    wx.navigateTo({ url: '/pages/transaction-editor/index?mode=' + mode })
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
