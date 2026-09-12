const app = getApp()
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')
const { needsEditingTransaction } = require('./model')
const { buildReadonlyDetail } = require('./readonly-detail')

const TYPE_OPTIONS = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'transfer', label: '转账' },
  { value: 'refund', label: '退款' }
]

function findIndex(items, key, value) {
  return items.findIndex(function (item) { return item[key] === value })
}

function refundableViews(transactions, editing) {
  const rows = (transactions || []).map(function (transaction) {
    const category = transaction.category && transaction.category.name ? transaction.category.name : '支出'
    const note = transaction.note ? ' · ' + transaction.note : ''
    return Object.assign({}, transaction, {
      pickerLabel: String(transaction.occurredLocalAt || '').slice(0, 10) + ' · ' + category + note + ' · 可退' + money.formatMinor(transaction.refundableMinor)
    })
  })
  if (editing && editing.type === 'refund' && editing.originalTransaction &&
      !rows.some(item => item.transactionId === editing.originalTransaction.transactionId)) {
    rows.unshift({ transactionId: editing.originalTransaction.transactionId,
      pickerLabel: String(editing.originalTransaction.occurredLocalAt || '').slice(0, 10) + ' · 原支出 · 当前退款' })
  }
  return rows
}

Page({
  data: {
    mode: 'create',
    readonlyDetail: false,
    detail: null,
    categoryDirty: false,
    transactionId: '',
    version: 0,
    typeOptions: TYPE_OPTIONS,
    typeIndex: 0,
    accounts: [],
    hasAccounts: false,
    categories: [],
    refundableTransactions: [],
    refundablesReady: false,
    refundablesLoading: false,
    originalIndex: -1,
    sourceIndex: -1,
    destinationIndex: -1,
    categoryIndex: -1,
    sourceAccountId: '',
    destinationAccountId: '',
    selectedCategoryId: '',
    originalTransactionId: '',
    catalogReady: false,
    catalogError: '',
    editingBlocked: false,
    amountYuan: '',
    date: time.today(),
    clock: time.currentClock(),
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    note: '',
    preparing: false,
    formReady: false,
    saving: false,
    errorMessage: ''
  },

  onLoad: function (options) {
    themeService.bindPage(this)
    const requestedMode = options && options.mode
    const mode = ['edit', 'import', 'view', 'link-refund'].includes(requestedMode) ? requestedMode : 'create'
    this.setData({ mode: mode, readonlyDetail: mode === 'import' || mode === 'view' })
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: mode === 'create' ? '记一笔' : '编辑账单' })
    loginGuard.run(this, this.prepareForm.bind(this))
  },

  onShow: function () {
    themeService.bindPage(this)
    if (!pageReadSession.isCurrent(this) || !this.data.catalogReady ||
        this._catalogToken !== api.cacheToken('catalog.get')) {
      loginGuard.run(this, this.prepareForm.bind(this))
    }
  },

  onUnload: function () { pageReadSession.end(this) },

  beginRead: function () {
    return pageReadSession.begin(this,
      Object.keys(this.data).filter(key => !['mode', 'readonlyDetail'].includes(key) && !key.startsWith('theme')),
      ['_initialized', '_catalogLoad', '_catalogToken', '_catalogApplied', '_refundablesLoad',
        '_categoryRequest', '_saveRequest', '_deleteRequest', '_detailTransaction', '_editingTransaction', '_catalogCategories'])
  },

  prepareForm: function (options) {
    const isCurrent = this.beginRead()
    if (!isCurrent() || !app.hasLoginApproval()) return Promise.resolve()
    if (!this._initialized) {
      const editing = needsEditingTransaction(this.data.mode) ? app.globalData.editingTransaction : null
      if (needsEditingTransaction(this.data.mode) && (!editing || !editing.transactionId)) {
        this.setData({ errorMessage: '当前交易已失效，请返回后重试' })
        return Promise.resolve()
      }
      this._editingTransaction = editing
      this._initialized = true
      if (this.data.readonlyDetail) {
        this._detailTransaction = editing
        const detail = buildReadonlyDetail(editing, [], this.data.mode === 'import' && ['income', 'expense'].includes(editing.type))
        this.setData({ detail, transactionId: editing.transactionId, version: editing.version,
          selectedCategoryId: editing.category && editing.category.categoryId || null })
      } else if (editing) {
        this.fillEditingTransaction(editing)
      }
      // 本地字段不等待目录；已有交易也先展示，再准备可编辑的分类。
      this.setData({ formReady: true })
    }
    if (this.data.readonlyDetail && !this.data.detail.canEditCategory) return Promise.resolve()
    const self = this
    const needsRefund = !this.data.readonlyDetail && TYPE_OPTIONS[this.data.typeIndex].value === 'refund'
    const refundLoad = needsRefund ? this.loadRefundables() : Promise.resolve()
    if (this._catalogLoad) return Promise.all([this._catalogLoad, refundLoad])
    const force = Boolean(options && options.force)
    const cached = !force && api.peek('catalog.get')
    if (cached) {
      this.applyCatalog(cached)
      this._catalogToken = api.cacheToken('catalog.get')
      return refundLoad
    }
    this.setData({ preparing: true, catalogReady: false, catalogError: '' })
    this._catalogLoad = api.callApi('catalog.get', {}, { force })
      .then(function (result) {
        if (!isCurrent()) return
        self.applyCatalog(result)
        self._catalogToken = api.cacheToken('catalog.get')
      }).catch(function (error) {
        if (isCurrent()) self.setData({ catalogError: error.message || '账户和分类读取失败，请重试' })
      }).finally(function () {
        if (!isCurrent()) return
        self.setData({ preparing: false })
        self._catalogLoad = null
      })
    return Promise.all([this._catalogLoad, refundLoad])
  },

  applyCatalog: function (result) {
    this._catalogCategories = result.categories || []
    if (this.data.readonlyDetail) {
      const detail = buildReadonlyDetail(this._detailTransaction, this._catalogCategories, true)
      this.setData({ detail, categories: detail.categories,
        categoryIndex: findIndex(detail.categories, 'id', this.data.selectedCategoryId), catalogReady: true, catalogError: '' })
      return
    }
    const accounts = (result.accounts || []).filter(account => !account.archived)
    const first = !this._catalogApplied && this.data.mode === 'create'
    const sourceId = this.data.sourceAccountId || (first && accounts[0] ? accounts[0].accountId : '')
    const destinationId = this.data.destinationAccountId || (first && accounts[0] ? accounts[0].accountId : '')
    const editing = this._editingTransaction
    const editingBlocked = Boolean(editing && [editing.sourceAccount, editing.destinationAccount].filter(Boolean)
      .some(account => !accounts.some(row => row.accountId === account.accountId)))
    this.setData({ accounts, hasAccounts: accounts.length > 0, sourceAccountId: sourceId, destinationAccountId: destinationId,
      sourceIndex: findIndex(accounts, 'accountId', sourceId), destinationIndex: findIndex(accounts, 'accountId', destinationId),
      catalogReady: true, catalogError: '', editingBlocked,
      errorMessage: editingBlocked ? '关联账户已停用，请返回查看原交易。' : this.data.errorMessage })
    this.refreshCategories(TYPE_OPTIONS[this.data.typeIndex].value, first && !this.data.selectedCategoryId)
    this._catalogApplied = true
  },

  openAccounts: function () {
    if (pageReadSession.isCurrent(this)) wx.navigateTo({ url: '/pages/accounts/index' })
  },

  changeDetailCategory: function (event) {
    if (this.data.saving || !this.data.catalogReady || !this.data.detail || !this.data.detail.canEditCategory) return
    const index = Number(event.detail.value)
    const category = this.data.categories[index]
    if (!category) return
    this._categoryRequest = null
    const previousId = this._detailTransaction.category && this._detailTransaction.category.categoryId || null
    this.setData({ categoryIndex: index, selectedCategoryId: category.id, categoryDirty: category.id !== previousId, errorMessage: '' })
  },

  saveDetailCategory: function () {
    if (!pageReadSession.isCurrent(this) || this.data.saving || !this.data.catalogReady || !this.data.categoryDirty || !this.data.detail || !this.data.detail.canEditCategory) return Promise.resolve()
    const category = this.data.categories[this.data.categoryIndex]
    if (!category) return Promise.resolve()
    if (!this._categoryRequest) this._categoryRequest = { requestId: api.createRequestId(),
      transactionId: this.data.transactionId, version: this.data.version, categoryId: category.id }
    const self = this
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, errorMessage: '' })
    return api.callApi('transactions.setCategory', this._categoryRequest).then(function () {
      if (!isCurrent()) return
      app.globalData.editingTransaction = null
      wx.showToast({ title: '分类已保存', icon: 'success' })
      wx.navigateBack()
    }).catch(function (error) {
      if (isCurrent()) self.setData({ errorMessage: error.message || '分类保存失败，请重试' })
    }).finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  },

  loadRefundables: function () {
    const isCurrent = pageReadSession.capture(this)
    if (!isCurrent()) return Promise.resolve()
    if (this.data.refundablesReady) return Promise.resolve()
    if (this._refundablesLoad) return this._refundablesLoad
    const self = this
    this.setData({ refundablesLoading: true, errorMessage: '' })
    this._refundablesLoad = api.callApi('transactions.refundable', { limit: 60 })
      .then(function (result) {
        if (!isCurrent()) return
        const rows = refundableViews(result.transactions, self._editingTransaction)
        self.setData({ refundableTransactions: rows, refundablesReady: true,
          originalIndex: findIndex(rows, 'transactionId', self.data.originalTransactionId) })
      }).catch(function (error) {
        if (!isCurrent()) return
        if (TYPE_OPTIONS[self.data.typeIndex].value === 'refund') self.setData({ errorMessage: error.message || '原支出读取失败，请重试' })
      }).finally(function () {
        if (!isCurrent()) return
        self.setData({ refundablesLoading: false }); self._refundablesLoad = null })
    return this._refundablesLoad
  },

  refreshCategories: function (type, chooseDefault) {
    const categories = (this._catalogCategories || []).filter(category => category.kind === type)
    const id = chooseDefault && categories[0] ? categories[0].id : this.data.selectedCategoryId
    this.setData({ categories, selectedCategoryId: id, categoryIndex: findIndex(categories, 'id', id) })
  },

  fillEditingTransaction: function (transaction) {
    const local = String(transaction.occurredLocalAt || '')
    this.setData({
      transactionId: transaction.transactionId, version: transaction.version,
      typeIndex: findIndex(TYPE_OPTIONS, 'value', transaction.type),
      sourceAccountId: transaction.sourceAccount && transaction.sourceAccount.accountId || '',
      destinationAccountId: transaction.destinationAccount && transaction.destinationAccount.accountId || '',
      originalTransactionId: transaction.originalTransaction && transaction.originalTransaction.transactionId || '',
      selectedCategoryId: transaction.category && transaction.category.categoryId || '',
      amountYuan: money.minorToYuan(transaction.amountMinor), date: local.slice(0, 10), clock: local.slice(11, 16),
      timezoneOffsetMinutes: transaction.timezoneOffsetMinutes, note: transaction.note || ''
    })
  },

  changeType: function (event) {
    if (this.data.saving) {
      return
    }
    const typeIndex = Number(event.currentTarget.dataset.index)
    const type = TYPE_OPTIONS[typeIndex].value
    this.setData({ typeIndex: typeIndex, selectedCategoryId: '', errorMessage: '' })
    this.refreshCategories(type, true)
    if (type === 'refund') return this.loadRefundables()
  },

  bindAmount: function (event) { this.setData({ amountYuan: event.detail.value }) },
  bindNote: function (event) { this.setData({ note: event.detail.value }) },
  changeDate: function (event) { this.setData({ date: event.detail.value }) },
  changeClock: function (event) { this.setData({ clock: event.detail.value }) },
  changeSource: function (event) { this.selectOption('sourceIndex', 'sourceAccountId', this.data.accounts, 'accountId', event) },
  changeDestination: function (event) { this.selectOption('destinationIndex', 'destinationAccountId', this.data.accounts, 'accountId', event) },
  changeCategory: function (event) { this.selectOption('categoryIndex', 'selectedCategoryId', this.data.categories, 'id', event) },
  changeOriginal: function (event) { this.selectOption('originalIndex', 'originalTransactionId', this.data.refundableTransactions, 'transactionId', event) },

  selectOption: function (indexKey, idKey, rows, idField, event) {
    const index = Number(event.detail.value)
    if (!this.data.saving && rows[index]) this.setData({ [indexKey]: index, [idKey]: rows[index][idField] })
  },

  retryRequest: function (field, action, data) {
    const key = JSON.stringify([action, data])
    if (!this[field] || this[field].key !== key) this[field] = { key, data: Object.assign({ requestId: api.createRequestId() }, data) }
    return this[field].data
  },

  buildRequest: function () {
    const type = TYPE_OPTIONS[this.data.typeIndex].value
    const data = {
      type: type,
      amountMinor: money.yuanToMinor(this.data.amountYuan),
      occurredLocalAt: this.data.date + 'T' + this.data.clock + ':00',
      timezoneOffsetMinutes: this.data.timezoneOffsetMinutes,
      note: this.data.note
    }
    if (type === 'expense') {
      data.sourceAccountId = this.data.sourceAccountId
      data.categoryId = (this.data.categories[this.data.categoryIndex] || {}).id
    } else if (type === 'income') {
      data.destinationAccountId = this.data.destinationAccountId
      data.categoryId = (this.data.categories[this.data.categoryIndex] || {}).id
    } else if (type === 'transfer') {
      data.sourceAccountId = this.data.sourceAccountId
      data.destinationAccountId = this.data.destinationAccountId
    } else {
      const original = this.data.refundableTransactions[this.data.originalIndex]
      if (!original) throw new Error('请选择原支出')
      data.destinationAccountId = this.data.destinationAccountId
      data.originalTransactionId = original.transactionId
    }
    if (this.data.mode === 'edit') {
      data.transactionId = this.data.transactionId
      data.version = this.data.version
    }
    return data
  },

  save: function () {
    if (!pageReadSession.isCurrent(this) || this.data.saving || !this.data.catalogReady || this.data.editingBlocked || this.data.accounts.length === 0 ||
        (TYPE_OPTIONS[this.data.typeIndex].value === 'refund' && !this.data.refundablesReady)) {
      return
    }
    let data
    try {
      if (this.data.mode === 'link-refund') {
        const original = this.data.refundableTransactions[this.data.originalIndex]
        if (!original) throw new Error('请选择原支出')
        data = {
          transactionId: this.data.transactionId,
          version: this.data.version,
          originalTransactionId: original.transactionId
        }
      } else {
        const type = TYPE_OPTIONS[this.data.typeIndex].value
        if (['expense', 'transfer'].includes(type) && this.data.sourceIndex < 0) throw new Error('请选择付款账户')
        if (type !== 'expense' && this.data.destinationIndex < 0) throw new Error('请选择收款账户')
        data = this.buildRequest()
      }
      if (data.type === 'transfer' && data.sourceAccountId === data.destinationAccountId) {
        throw new Error('转出和转入账户不能相同')
      }
      if ((data.type === 'expense' || data.type === 'income') && !data.categoryId) {
        throw new Error('请选择分类')
      }
    } catch (error) {
      this.setData({ errorMessage: error.message })
      return
    }

    const self = this
    this.setData({ saving: true, errorMessage: '' })
    const action = this.data.mode === 'link-refund'
      ? 'transactions.linkRefund'
      : (this.data.mode === 'edit' ? 'transactions.update' : 'transactions.create')
    const isCurrent = pageReadSession.capture(this)
    return api.callApi(action, this.retryRequest('_saveRequest', action, data))
      .then(function () {
        if (!isCurrent()) return
        app.globalData.editingTransaction = null
        wx.showToast({
          title: self.data.mode === 'link-refund' ? '已关联' : (self.data.mode === 'edit' ? '已更新' : '已记账'),
          icon: 'success'
        })
        wx.navigateBack()
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '保存失败，请稍后重试' })
      })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ saving: false })
      })
  },

  remove: function () {
    const self = this
    const isCurrent = pageReadSession.capture(this)
    if (!isCurrent()) return
    wx.showModal({
      title: '删除这笔账？',
      content: '删除后会从余额和统计中排除，但会保留必要的审计记录。',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (!isCurrent() || !result.confirm || self.data.saving) {
          return
        }
        self.setData({ saving: true, errorMessage: '' })
        api.callApi('transactions.delete', self.retryRequest('_deleteRequest', 'transactions.delete', {
          transactionId: self.data.transactionId,
          version: self.data.version
        })).then(function () {
          if (!isCurrent()) return
          app.globalData.editingTransaction = null
          wx.showToast({ title: '已删除', icon: 'success' })
          wx.navigateBack()
        }).catch(function (error) {
          if (!isCurrent()) return
          self.setData({ errorMessage: error.message || '删除失败' })
        }).finally(function () {
          if (!isCurrent()) return
          self.setData({ saving: false })
        })
      }
    })
  }
})
