const app = getApp()
const api = require('../../services/catledger-api')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')

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

Page({
  data: {
    mode: 'create',
    transactionId: '',
    version: 0,
    typeOptions: TYPE_OPTIONS,
    typeIndex: 0,
    accounts: [],
    categories: [],
    refundableTransactions: [],
    originalIndex: 0,
    sourceIndex: 0,
    destinationIndex: 0,
    categoryIndex: 0,
    amountYuan: '',
    date: time.today(),
    clock: time.currentClock(),
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    note: '',
    saving: false,
    errorMessage: ''
  },

  onLoad: function (options) {
    themeService.bindPage(this)
    this.setData({ mode: options && options.mode === 'edit' ? 'edit' : 'create' })
    loginGuard.run(this, this.prepareForm.bind(this))
  },

  onShow: function () {
    themeService.bindPage(this)
  },

  prepareForm: function () {
    const self = this
    const bootstrapPromise = app.globalData.categories.length > 0
      ? Promise.resolve()
      : api.bootstrap().then(function (result) {
          app.globalData.categories = Array.isArray(result.categories) ? result.categories : []
        })
    Promise.all([bootstrapPromise, api.callApi('accounts.list'), api.callApi('transactions.refundable', { limit: 60 })])
      .then(function (results) {
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
        const refundables = (results[2].transactions || []).map(function (transaction) {
          const category = transaction.category && transaction.category.name ? transaction.category.name : '支出'
          const note = transaction.note ? ' · ' + transaction.note : ''
          return Object.assign({}, transaction, {
            pickerLabel: String(transaction.occurredLocalAt || '').slice(0, 10) + ' · ' + category + note + ' · 可退' + money.formatMinor(transaction.refundableMinor)
          })
        })
        const editing = self.data.mode === 'edit' && app.globalData.editingTransaction
          ? app.globalData.editingTransaction
          : null
        if (editing && editing.type === 'refund' && editing.originalTransaction &&
            !refundables.some(function (item) { return item.transactionId === editing.originalTransaction.transactionId })) {
          refundables.unshift({
            transactionId: editing.originalTransaction.transactionId,
            pickerLabel: String(editing.originalTransaction.occurredLocalAt || '').slice(0, 10) + ' · 原支出 · 当前退款'
          })
        }
        self.setData({ accounts: accounts, refundableTransactions: refundables })
        if (self.data.mode === 'edit' && app.globalData.editingTransaction) {
          self.fillEditingTransaction(app.globalData.editingTransaction, accounts, refundables)
        } else {
          self.refreshCategories('expense', null)
        }
      })
      .catch(function (error) {
        self.setData({ errorMessage: error.message || '表单准备失败' })
      })
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
      wx.showModal({
        title: '关联账户已停用',
        content: '这笔历史账可以查看，但不能再修改。',
        showCancel: false,
        success: function () { wx.navigateBack() }
      })
      return
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
    if (this.data.saving || this.data.accounts.length === 0) {
      return
    }
    let data
    try {
      data = this.buildRequest()
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
    api.callApi(this.data.mode === 'edit' ? 'transactions.update' : 'transactions.create', data)
      .then(function () {
        app.globalData.editingTransaction = null
        wx.showToast({ title: self.data.mode === 'edit' ? '已更新' : '已记账', icon: 'success' })
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
