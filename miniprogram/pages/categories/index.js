const app = getApp()
const api = require('../../services/catledger-api')
const themeService = require('../../theme/service')

function prepareCategories(categories, kind) {
  return categories
    .filter(function (category) { return category.kind === kind })
    .map(function (category, index) {
      const position = index + 1
      return Object.assign({}, category, {
        orderText: position < 10 ? '0' + position : String(position),
        initial: String(category.name || '分').slice(0, 1)
      })
    })
}

Page({
  data: {
    loading: false,
    errorMessage: '',
    selectedKind: 'expense',
    expenseCategories: [],
    incomeCategories: [],
    visibleCategories: []
  },

  onLoad: function () {
    themeService.bindPage(this)
    this.loadCategories()
  },

  onShow: function () {
    themeService.bindPage(this)
  },

  onPullDownRefresh: function () {
    this.loadCategories().finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  loadCategories: function () {
    if (this.data.loading) {
      return Promise.resolve()
    }
    const self = this
    this.setData({ loading: true, errorMessage: '' })

    return api.bootstrap()
      .then(function (result) {
        const categories = Array.isArray(result.categories) ? result.categories : []
        const expenseCategories = prepareCategories(categories, 'expense')
        const incomeCategories = prepareCategories(categories, 'income')
        app.globalData.categories = categories
        self.setData({
          expenseCategories: expenseCategories,
          incomeCategories: incomeCategories,
          visibleCategories: self.data.selectedKind === 'expense' ? expenseCategories : incomeCategories
        })
      })
      .catch(function (error) {
        self.setData({ errorMessage: error.message || '分类加载失败' })
      })
      .finally(function () {
        self.setData({ loading: false })
      })
  },

  selectKind: function (event) {
    const kind = event.currentTarget.dataset.kind
    if (kind !== 'expense' && kind !== 'income') {
      return
    }
    this.setData({
      selectedKind: kind,
      visibleCategories: kind === 'expense' ? this.data.expenseCategories : this.data.incomeCategories
    })
  }
})
