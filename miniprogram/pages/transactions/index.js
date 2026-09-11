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
    catalogError: '',
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
    const isCurrent = pageReadSession.begin(this, ['loading', 'loadingMore', 'hasLoaded', 'catalogError', 'errorMessage', 'transactions', 'nextCursor', 'incomeText', 'expenseText', 'netText', 'netClass', 'accountFilters', 'categoryFilters', 'accountFilterIndex', 'categoryFilterIndex'], ['_prepareLoad', '_transactionsLoad', '_listCacheToken', '_transactionsKey', '_transactionsGeneration', '_listQueryKey'])
    if (!app.hasLoginApproval()) return Promise.resolve()
    if (this._prepareLoad) return this._prepareLoad
    const self = this
    const force = Boolean(options && options.force)
    // 两个读模型独立完成；目录失败只影响筛选项，不清空已成功的列表。
    const catalog = api.callApi('catalog.get', {}, { force }).then(function (result) {
      if (!isCurrent()) return
      const selectedAccount = self.data.accountFilters[self.data.accountFilterIndex]
      const selectedCategory = self.data.categoryFilters[self.data.categoryFilterIndex]
      const requested = self.requestData(null)
      const accountFilters = [{ accountId: '', name: '全部账户' }].concat((result.accounts || []).filter(account => !account.archived))
      const categoryFilters = [{ categoryId: '', name: '全部分类' }, { categoryId: '__uncategorized__', name: '未分类', uncategorized: true }]
        .concat((result.categories || []).map(category => Object.assign({}, category, { categoryId: category.id })))
      self.setData({ accountFilters, categoryFilters,
        accountFilterIndex: Math.max(0, accountFilters.findIndex(item => selectedAccount && item.accountId === selectedAccount.accountId)),
        categoryFilterIndex: Math.max(0, categoryFilters.findIndex(item => selectedCategory && item.categoryId === selectedCategory.categoryId)) })
      const current = self.requestData(null)
      if (requested.accountId !== current.accountId || requested.categoryId !== current.categoryId || requested.uncategorized !== current.uncategorized) {
        return self.loadTransactions(false)
      }
    }).catch(function () {
      if (isCurrent()) self.setData({ catalogError: '筛选项暂未同步，下拉可重试' })
    })
    this.setData({ catalogError: '' })
    this._prepareLoad = Promise.all([catalog, this.loadTransactions(false, { force, reuse: true })])
      .finally(function () { if (isCurrent()) self._prepareLoad = null })
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
    const isCurrent = pageReadSession.begin(this, ['loading', 'loadingMore', 'hasLoaded', 'catalogError', 'errorMessage', 'transactions', 'nextCursor', 'incomeText', 'expenseText', 'netText', 'netClass', 'accountFilters', 'categoryFilters', 'accountFilterIndex', 'categoryFilterIndex'], ['_prepareLoad', '_transactionsLoad', '_listCacheToken', '_transactionsKey', '_transactionsGeneration', '_listQueryKey'])
    if (!app.hasLoginApproval()) return Promise.resolve()
    const data = this.requestData(append ? this.data.nextCursor : null)
    const requestKey = JSON.stringify(data)
    if (this._transactionsLoad && this._transactionsKey === requestKey) return this._transactionsLoad
    if (append && this._transactionsLoad) return this._transactionsLoad
    const queryKey = JSON.stringify(this.requestData(null))
    const baseToken = api.cacheToken('transactions.list', this.requestData(null))
    if (append && (!baseToken || baseToken !== this._listCacheToken)) return this.loadTransactions(false, { force: true })
    if (options && options.reuse && !options.force && !this._transactionsLoad && this.data.hasLoaded && baseToken && baseToken === this._listCacheToken) return Promise.resolve()
    const generation = (this._transactionsGeneration || 0) + 1
    this._transactionsGeneration = generation
    this._transactionsKey = requestKey
    const isLatest = () => isCurrent() && this._transactionsGeneration === generation
    const self = this
    const force = Boolean(options && options.force)
    if (!append && queryKey !== this._listQueryKey) this.setData({ hasLoaded: false, transactions: [], nextCursor: null })
    const needsNetwork = force || !api.isFresh('transactions.list', data)
    this.setData(append ? { loadingMore: needsNetwork } : { loading: needsNetwork, errorMessage: '' })
    this._transactionsLoad = api.callApi('transactions.list', data, { force: force })
      .then(function (result) {
        if (!isLatest()) return
        if (append && api.cacheToken('transactions.list', self.requestData(null)) !== baseToken) {
          self._transactionsLoad = null
          return self.loadTransactions(false, { force: true })
        }
        if (!append) { self._listCacheToken = api.cacheToken('transactions.list', data); self._listQueryKey = queryKey }
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
        if (!isLatest()) return
        self.setData({ errorMessage: error.message || '明细加载失败' })
      })
      .finally(function () {
        if (!isLatest()) return
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
    const month = time.shiftMonth(this.data.month, delta)
    this.setData({
      month: month,
      monthLabel: time.monthLabel(month),
      pickerDate: month + '-01',
      selectedDate: '',
      selectedDateLabel: '',
      nextCursor: null, hasLoaded: false, transactions: []
    })
    return this.loadTransactions(false)
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
      nextCursor: null, hasLoaded: false, transactions: []
    })
    return this.loadTransactions(false)
  },

  clearDate: function () {
    this.setData({ selectedDate: '', selectedDateLabel: '', nextCursor: null, hasLoaded: false, transactions: [] })
    return this.loadTransactions(false)
  },

  bindSearch: function (event) {
    this.setData({ search: event.detail.value })
  },

  applySearch: function () {
    return this.loadTransactions(false)
  },

  toggleSearch: function () {
    this.setData({ searchOpen: !this.data.searchOpen })
  },

  cancelSearch: function () {
    const hadSearch = this.data.search.trim().length > 0
    this.setData({ search: '', searchOpen: false })
    if (hadSearch) {
      return this.loadTransactions(false)
    }
  },

  changeAccountFilter: function (event) {
    this.setData({ accountFilterIndex: Number(event.detail.value), hasLoaded: false, transactions: [] })
    return this.loadTransactions(false)
  },

  changeCategoryFilter: function (event) {
    this.setData({ categoryFilterIndex: Number(event.detail.value), hasLoaded: false, transactions: [] })
    return this.loadTransactions(false)
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
