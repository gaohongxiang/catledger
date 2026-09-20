const readCache = require('../../services/read-cache')
const batchDelete = require('./batch-delete')
const app = getApp()
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const money = require('../../utils/money')
const time = require('../../utils/time')
const viewModel = require('../../utils/view-model')
const themeService = require('../../theme/service')

Page(Object.assign({
  data: {
    loggedIn: false,
    importFilter: null,
    selectionMode: false, selectedCount: 0, allSelected: false, selectingAll: false, deleting: false, deleteRetryCount: 0,
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
    appliedSearch: '',
    searchOpen: false,
    incomeText: '¥0.00',
    expenseText: '¥0.00',
    netText: '¥0.00',
    netClass: 'amount-neutral',
    transactions: [],
    nextCursor: null,
    accountFilterIndex: 0,
    categoryFilterIndex: 0,
    sourceFilterIndex: 0,
    sourceFilters: [{ value: '', name: '全部来源' }, { value: 'manual', name: '记一笔' }, { value: 'import', name: '账单导入' }],
    accountFilters: [{ accountId: '', name: '全部账户' }],
    categoryFilters: [{ categoryId: '', name: '全部分类' }, { categoryId: '__uncategorized__', name: '未分类', uncategorized: true }]
  },

  onLoad: function () {
    themeService.bindPage(this)
    this.setData({ monthLabel: time.monthLabel(this.data.month) })
  },

  onShow: function () {
    if (this._readSession !== undefined && !pageReadSession.isCurrent(this)) this.setData({ importFilter: null })
    const incoming = app.globalData.transactionsImportFilter
    app.globalData.transactionsImportFilter = null
    if (incoming && incoming.session === readCache.getSession() && app.hasLoginApproval()) {
      this.setData({ importFilter: incoming, accountFilterIndex: 0, categoryFilterIndex: 0, sourceFilterIndex: 0, search: '', appliedSearch: '', searchOpen: false, selectedDate: '', selectedDateLabel: '', transactions: [], nextCursor: null, hasLoaded: false })
    }
    this.resetSelection()
    this.setData({ selectionMode: false, deleteRetryCount: 0 })
    this._batchRequest = null
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
    if (this.data.deleting || this.data.selectingAll) { wx.stopPullDownRefresh(); return }
    if (!app.hasLoginApproval()) {
      wx.stopPullDownRefresh()
      return
    }
    this.prepareAndLoad({ force: true }).finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom: function () {
    if (!this.data.selectingAll && app.hasLoginApproval() && this.data.nextCursor) {
      this.loadTransactions(true)
    }
  },

  onUnload: function () { pageReadSession.end(this) },

  prepareAndLoad: function (options) {
    if (this.data.deleting || this.data.selectingAll) return Promise.resolve()
    const isCurrent = pageReadSession.begin(this, ['loading', 'loadingMore', 'hasLoaded', 'catalogError', 'errorMessage', 'transactions', 'nextCursor', 'incomeText', 'expenseText', 'netText', 'netClass', 'accountFilters', 'categoryFilters', 'accountFilterIndex', 'categoryFilterIndex', 'sourceFilterIndex', 'search', 'appliedSearch', 'selectionMode', 'selectedCount', 'allSelected', 'selectingAll', 'deleting', 'deleteRetryCount'], ['_prepareLoad', '_transactionsLoad', '_listCacheToken', '_transactionsKey', '_transactionsGeneration', '_listQueryKey', '_listRevision'])
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
      self.recoverBatchDelete().catch(function (error) { if (isCurrent()) self.setData({ errorMessage: error.message }) })
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
      search: this.data.appliedSearch
    }
    if (this.data.importFilter) {
      delete data.month
      data.importUpdateId = this.data.importFilter.updateId
    }
    if (this.data.selectedDate && !this.data.importFilter) {
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
    const source = this.data.sourceFilters[this.data.sourceFilterIndex]
    if (source && source.value) data.source = source.value
    if (cursor) {
      data.cursor = cursor
    }
    return data
  },

  loadTransactions: function (append, options) {
    const isCurrent = pageReadSession.begin(this, ['loading', 'loadingMore', 'hasLoaded', 'catalogError', 'errorMessage', 'transactions', 'nextCursor', 'incomeText', 'expenseText', 'netText', 'netClass', 'accountFilters', 'categoryFilters', 'accountFilterIndex', 'categoryFilterIndex', 'sourceFilterIndex', 'search', 'appliedSearch', 'selectionMode', 'selectedCount', 'allSelected', 'selectingAll', 'deleting', 'deleteRetryCount'], ['_prepareLoad', '_transactionsLoad', '_listCacheToken', '_transactionsKey', '_transactionsGeneration', '_listQueryKey', '_listRevision'])
    if (!app.hasLoginApproval()) return Promise.resolve()
    if (!append) this.resetSelection()
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
    const applyTransactions = function (result, snapshot) {
        if (!isLatest()) return
        if (snapshot && self.data.hasLoaded && self._listQueryKey === queryKey) { self.setData({ errorMessage: '正在更新，当前显示上次结果' }); return }
        if (!append && !snapshot && options && options.reuse && !force && self.data.hasLoaded &&
            self._listQueryKey === queryKey && api.cacheToken('transactions.list', data) === self._listCacheToken) { self.setData({ errorMessage: '' }); return }
        if (!snapshot && append && (api.cacheToken('transactions.list', self.requestData(null)) !== baseToken || result.dataRevision !== self._listRevision)) {
          self._transactionsLoad = null
          return self.loadTransactions(false, { force: true })
        }
        if (!append && !snapshot) { self._listCacheToken = api.cacheToken('transactions.list', data); self._listQueryKey = queryKey; self._listRevision = result.dataRevision }
        const rows = result.transactions.map(viewModel.transactionView).map(row => Object.assign({}, row, { deletable: batchDelete.canSelect(row) }))
        const patch = { hasLoaded: true, nextCursor: result.nextCursor, errorMessage: snapshot ? '正在更新，当前显示上次结果' : '' }
        if (append) rows.forEach((row, index) => { patch['transactions[' + (self.data.transactions.length + index) + ']'] = row })
        else {
          patch.transactions = rows
          patch.incomeText = money.formatMinor(result.summary.incomeMinor)
          patch.expenseText = money.formatMinor(result.summary.expenseMinor)
          patch.netText = money.formatMinor(result.summary.netIncomeMinor)
          patch.netClass = String(result.summary.netIncomeMinor).charAt(0) === '-' ? 'amount-expense'
            : String(result.summary.netIncomeMinor) === '0' ? 'amount-neutral' : 'amount-income'
        }
        self.setData(patch)
    }
    this._transactionsLoad = api.callApi('transactions.list', data, { force, onSnapshot: append ? null : result => applyTransactions(result, true) })
      .then(result => applyTransactions(result, false))
      .catch(function (error) {
        if (!isLatest()) return
        if (append && error.code === 'READ_SNAPSHOT_CHANGED') {
          self._transactionsLoad = null
          return self.loadTransactions(false, { force: true })
        }
        self.setData({ errorMessage: self.data.hasLoaded ? '更新未成功，当前显示上次结果' : error.message || '明细加载失败' })
      })
      .finally(function () {
        if (!isLatest()) return
        self.setData({ loading: false, loadingMore: false })
        self._transactionsLoad = null
      })
    return this._transactionsLoad
  },

  clearImportFilter: function () {
    if (this.data.deleting || this.data.selectingAll) return
    this.setData({ importFilter: null, sourceFilterIndex: 0, hasLoaded: false, transactions: [], nextCursor: null })
    return this.loadTransactions(false)
  },

  previousMonth: function () {
    this.changeMonth(-1)
  },

  nextMonth: function () {
    this.changeMonth(1)
  },

  changeMonth: function (delta) {
    if (this.data.deleting || this.data.selectingAll) return
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
    if (this.data.deleting || this.data.selectingAll) return
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
    if (this.data.deleting || this.data.selectingAll) return
    this.setData({ selectedDate: '', selectedDateLabel: '', nextCursor: null, hasLoaded: false, transactions: [] })
    return this.loadTransactions(false)
  },

  bindSearch: function (event) {
    if (this.data.deleting || this.data.selectingAll) return
    this.setData({ search: event.detail.value })
  },

  toggleSearch: function () {
    if (this.data.deleting || this.data.selectingAll) return
    this.setData({ searchOpen: !this.data.searchOpen })
  },

  applySearch: function () {
    if (this.data.deleting || this.data.selectingAll) return
    this.setData({ appliedSearch: this.data.search.trim() })
    return this.loadTransactions(false)
  },

  clearSearch: function () {
    if (this.data.deleting || this.data.selectingAll) return
    const hadSearch = Boolean(this.data.appliedSearch)
    this.setData({ search: '', appliedSearch: '' })
    if (hadSearch) {
      return this.loadTransactions(false)
    }
  },

  changeAccountFilter: function (event) {
    if (this.data.deleting || this.data.selectingAll) return
    this.setData({ accountFilterIndex: Number(event.detail.value), hasLoaded: false, transactions: [] })
    return this.loadTransactions(false)
  },

  changeCategoryFilter: function (event) {
    if (this.data.deleting || this.data.selectingAll) return
    this.setData({ categoryFilterIndex: Number(event.detail.value), hasLoaded: false, transactions: [] })
    return this.loadTransactions(false)
  },

  changeSourceFilter: function (event) {
    if (this.data.deleting || this.data.selectingAll) return
    this.setData({ sourceFilterIndex: Number(event.detail.value) })
    return this.loadTransactions(false)
  },

  editTransaction: function (event) {
    if (this.data.deleting || this.data.selectingAll) return
    if (this.data.selectionMode) return this.selectTransaction(Number(event.currentTarget.dataset.index))
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
}, batchDelete))
