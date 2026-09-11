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
  const index = items.findIndex(function (item) { return item[key] === value })
  return index < 0 ? 0 : index
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
    categories: [],
    refundableTransactions: [],
    refundablesReady: false,
    refundablesLoading: false,
    originalIndex: 0,
    sourceIndex: 0,
    destinationIndex: 0,
    categoryIndex: 0,
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
    if (this.data.formReady && !pageReadSession.isCurrent(this)) loginGuard.run(this, this.prepareForm.bind(this))
  },

  prepareForm: function () {
    const isCurrent = pageReadSession.begin(this, ['detail', 'categoryDirty', 'preparing', 'formReady', 'errorMessage', 'accounts', 'categories', 'refundableTransactions', 'refundablesReady', 'refundablesLoading', 'amountYuan', 'note'], ['_refundablesLoad', '_categoryRequest'])
    if (this.data.preparing || this.data.saving) return Promise.resolve()
    this.setData({ preparing: true, formReady: false, errorMessage: '' })
    const self = this
    if (this.data.readonlyDetail) return this.prepareReadonlyDetail(isCurrent)
    const needsRefund = self.data.mode === 'link-refund' ||
      (self.data.mode === 'edit' && app.globalData.editingTransaction && app.globalData.editingTransaction.type === 'refund')
    const bootstrapPromise = self.data.mode === 'link-refund'
      ? Promise.resolve()
      : api.bootstrap().then(function (result) {
        if (!isCurrent()) return
          app.globalData.categories = Array.isArray(result.categories) ? result.categories : []
        })
    return Promise.all([bootstrapPromise, api.callApi('accounts.list'), needsRefund
      ? api.callApi('transactions.refundable', { limit: 60 }) : Promise.resolve({ transactions: [] })])
      .then(function (results) {
        if (!isCurrent()) return
        const accounts = results[1].accounts.filter(function (account) { return !account.archived })
        if (accounts.length === 0) {
          wx.showModal({
            title: '还没有可用账户',
            content: '请先创建账户，再开始记账。',
            showCancel: false,
            success: function () {
              wx.redirectTo({ url: '/pages/accounts/index' })
            }
          })
          return
        }
        const editing = needsEditingTransaction(self.data.mode) && app.globalData.editingTransaction
          ? app.globalData.editingTransaction
          : null
        if (needsEditingTransaction(self.data.mode) && !editing) {
          self.setData({ errorMessage: '当前交易已失效，请返回后重试' })
          return
        }
        const refundables = refundableViews(results[2].transactions, editing)
        self.setData({ accounts: accounts, refundableTransactions: refundables, refundablesReady: Boolean(needsRefund) })
        if (editing) {
          if (self.fillEditingTransaction(editing, accounts, refundables) === false) return
        } else {
          self.refreshCategories('expense', null)
        }
        self.setData({ formReady: true })
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '表单准备失败' })
      }).finally(function () {
        if (!isCurrent()) return
        self.setData({ preparing: false }) })
  },

  prepareReadonlyDetail: function (isCurrent) {
    const self = this
    const transaction = app.globalData.editingTransaction
    if (!transaction || !transaction.transactionId) {
      this.setData({ preparing: false, errorMessage: '这笔账单已失效，请返回明细重新打开' })
      return Promise.resolve()
    }
    const needsCategory = this.data.mode === 'import' && ['income', 'expense'].includes(transaction.type)
    return (needsCategory ? api.bootstrap() : Promise.resolve({ categories: [] }))
      .then(function (result) {
        if (!isCurrent()) return
        const detail = buildReadonlyDetail(transaction, result.categories || [], needsCategory)
        self._detailTransaction = transaction
        self.setData({ detail: detail, categories: detail.categories, categoryIndex: detail.categoryIndex,
          categoryDirty: false, transactionId: transaction.transactionId, version: transaction.version, formReady: true })
      }).catch(function (error) {
        if (isCurrent()) self.setData({ errorMessage: error.message || '账单读取失败' })
      }).finally(function () { if (isCurrent()) self.setData({ preparing: false }) })
  },

  changeDetailCategory: function (event) {
    if (this.data.saving || !this.data.detail || !this.data.detail.canEditCategory) return
    const index = Number(event.detail.value)
    const category = this.data.categories[index]
    if (!category) return
    this._categoryRequest = null
    const previousId = this._detailTransaction.category && this._detailTransaction.category.categoryId || null
    this.setData({ categoryIndex: index, categoryDirty: category.id !== previousId, errorMessage: '' })
  },

  saveDetailCategory: function () {
    if (this.data.saving || !this.data.categoryDirty || !this.data.detail || !this.data.detail.canEditCategory) return Promise.resolve()
    const category = this.data.categories[this.data.categoryIndex]
    if (!category) return Promise.resolve()
    if (!this._categoryRequest) this._categoryRequest = { requestId: api.createRequestId(),
      transactionId: this.data.transactionId, version: this.data.version, categoryId: category.id }
    const self = this
    this.setData({ saving: true, errorMessage: '' })
    return api.callApi('transactions.setCategory', this._categoryRequest).then(function () {
      if (!pageReadSession.isCurrent(self)) return
      app.globalData.editingTransaction = null
      wx.showToast({ title: '分类已保存', icon: 'success' })
      wx.navigateBack()
    }).catch(function (error) {
      if (pageReadSession.isCurrent(self)) self.setData({ errorMessage: error.message || '分类保存失败，请重试' })
    }).finally(function () { if (pageReadSession.isCurrent(self)) self.setData({ saving: false }) })
  },

  loadRefundables: function () {
    const isCurrent = pageReadSession.begin(this, ['detail', 'categoryDirty', 'preparing', 'formReady', 'errorMessage', 'accounts', 'categories', 'refundableTransactions', 'refundablesReady', 'refundablesLoading', 'amountYuan', 'note'], ['_refundablesLoad', '_categoryRequest'])
    if (this.data.refundablesReady) return Promise.resolve()
    if (this._refundablesLoad) return this._refundablesLoad
    const self = this
    this.setData({ refundablesLoading: true, errorMessage: '' })
    this._refundablesLoad = api.callApi('transactions.refundable', { limit: 60 })
      .then(function (result) {
        if (!isCurrent()) return
        const editing = needsEditingTransaction(self.data.mode) ? app.globalData.editingTransaction : null
        self.setData({ refundableTransactions: refundableViews(result.transactions, editing), refundablesReady: true })
      }).catch(function (error) {
        if (!isCurrent()) return
        if (TYPE_OPTIONS[self.data.typeIndex].value === 'refund') self.setData({ errorMessage: error.message || '原支出读取失败，请重试' })
      }).finally(function () {
        if (!isCurrent()) return
        self.setData({ refundablesLoading: false }); self._refundablesLoad = null })
    return this._refundablesLoad
  },

  refreshCategories: function (type, selectedCategoryId) {
    const categories = app.globalData.categories.filter(function (category) {
      return category.kind === type
    })
    this.setData({
      categories: categories,
      categoryIndex: selectedCategoryId ? findIndex(categories, 'id', selectedCategoryId) : 0
    })
  },

  fillEditingTransaction: function (transaction, accounts, refundables) {
    const relatedAccountIds = [transaction.sourceAccount, transaction.destinationAccount]
      .filter(Boolean)
      .map(function (account) { return account.accountId })
    const activeAccountIds = new Set(accounts.map(function (account) { return account.accountId }))
    if (relatedAccountIds.some(function (accountId) { return !activeAccountIds.has(accountId) })) {
      this.setData({ errorMessage: '关联账户已停用，请返回查看原交易。' })
      wx.showModal({
        title: '关联账户已停用',
        content: '这笔历史账可以查看，但不能再修改。',
        showCancel: false,
        success: function () { wx.navigateBack() }
      })
      return false
    }

    const typeIndex = findIndex(TYPE_OPTIONS, 'value', transaction.type)
    const local = String(transaction.occurredLocalAt || '')
    this.setData({
      transactionId: transaction.transactionId,
      version: transaction.version,
      typeIndex: typeIndex,
      sourceIndex: transaction.sourceAccount
        ? findIndex(accounts, 'accountId', transaction.sourceAccount.accountId)
        : 0,
      destinationIndex: transaction.destinationAccount
        ? findIndex(accounts, 'accountId', transaction.destinationAccount.accountId)
        : 0,
      originalIndex: transaction.originalTransaction
        ? findIndex(refundables, 'transactionId', transaction.originalTransaction.transactionId)
        : 0,
      amountYuan: money.minorToYuan(transaction.amountMinor),
      date: local.slice(0, 10),
      clock: local.slice(11, 16),
      timezoneOffsetMinutes: transaction.timezoneOffsetMinutes,
      note: transaction.note || ''
    })
    this.refreshCategories(transaction.type, transaction.category && transaction.category.categoryId)
  },

  changeType: function (event) {
    if (this.data.saving) {
      return
    }
    const typeIndex = Number(event.currentTarget.dataset.index)
    const type = TYPE_OPTIONS[typeIndex].value
    this.setData({ typeIndex: typeIndex, errorMessage: '' })
    this.refreshCategories(type, null)
    if (type === 'refund') return this.loadRefundables()
  },

  bindAmount: function (event) { this.setData({ amountYuan: event.detail.value }) },
  bindNote: function (event) { this.setData({ note: event.detail.value }) },
  changeDate: function (event) { this.setData({ date: event.detail.value }) },
  changeClock: function (event) { this.setData({ clock: event.detail.value }) },
  changeSource: function (event) { this.setData({ sourceIndex: Number(event.detail.value) }) },
  changeDestination: function (event) { this.setData({ destinationIndex: Number(event.detail.value) }) },
  changeCategory: function (event) { this.setData({ categoryIndex: Number(event.detail.value) }) },
  changeOriginal: function (event) { this.setData({ originalIndex: Number(event.detail.value) }) },

  buildRequest: function () {
    const type = TYPE_OPTIONS[this.data.typeIndex].value
    const data = {
      requestId: api.createRequestId(),
      type: type,
      amountMinor: money.yuanToMinor(this.data.amountYuan),
      occurredLocalAt: this.data.date + 'T' + this.data.clock + ':00',
      timezoneOffsetMinutes: this.data.timezoneOffsetMinutes,
      note: this.data.note
    }
    if (type === 'expense') {
      data.sourceAccountId = this.data.accounts[this.data.sourceIndex].accountId
      data.categoryId = this.data.categories[this.data.categoryIndex].id
    } else if (type === 'income') {
      data.destinationAccountId = this.data.accounts[this.data.destinationIndex].accountId
      data.categoryId = this.data.categories[this.data.categoryIndex].id
    } else if (type === 'transfer') {
      data.sourceAccountId = this.data.accounts[this.data.sourceIndex].accountId
      data.destinationAccountId = this.data.accounts[this.data.destinationIndex].accountId
    } else {
      const original = this.data.refundableTransactions[this.data.originalIndex]
      if (!original) throw new Error('请选择原支出')
      data.destinationAccountId = this.data.accounts[this.data.destinationIndex].accountId
      data.originalTransactionId = original.transactionId
    }
    if (this.data.mode === 'edit') {
      data.transactionId = this.data.transactionId
      data.version = this.data.version
    }
    return data
  },

  save: function () {
    if (this.data.saving || this.data.accounts.length === 0 ||
        (TYPE_OPTIONS[this.data.typeIndex].value === 'refund' && !this.data.refundablesReady)) {
      return
    }
    let data
    try {
      if (this.data.mode === 'link-refund') {
        const original = this.data.refundableTransactions[this.data.originalIndex]
        if (!original) throw new Error('请选择原支出')
        data = {
          requestId: api.createRequestId(),
          transactionId: this.data.transactionId,
          version: this.data.version,
          originalTransactionId: original.transactionId
        }
      } else {
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
    api.callApi(action, data)
      .then(function () {
        app.globalData.editingTransaction = null
        wx.showToast({
          title: self.data.mode === 'link-refund' ? '已关联' : (self.data.mode === 'edit' ? '已更新' : '已记账'),
          icon: 'success'
        })
        setTimeout(function () { wx.navigateBack() }, 350)
      })
      .catch(function (error) {
        self.setData({ errorMessage: error.message || '保存失败，请稍后重试' })
      })
      .finally(function () {
        self.setData({ saving: false })
      })
  },

  remove: function () {
    const self = this
    wx.showModal({
      title: '删除这笔账？',
      content: '删除后会从余额和统计中排除，但会保留必要的审计记录。',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (!result.confirm || self.data.saving) {
          return
        }
        self.setData({ saving: true, errorMessage: '' })
        api.callApi('transactions.delete', {
          requestId: api.createRequestId(),
          transactionId: self.data.transactionId,
          version: self.data.version
        }).then(function () {
          app.globalData.editingTransaction = null
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(function () { wx.navigateBack() }, 350)
        }).catch(function (error) {
          self.setData({ errorMessage: error.message || '删除失败' })
        }).finally(function () {
          self.setData({ saving: false })
        })
      }
    })
  }
})
