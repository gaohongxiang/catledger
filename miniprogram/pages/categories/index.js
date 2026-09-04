const app = getApp()
const api = require('../../services/catledger-api')
const loginGuard = require('../../services/login-guard')
const themeService = require('../../theme/service')
const categoryModel = require('./model')

Page({
  data: {
    loading: false, saving: false, errorMessage: '', selectedKind: 'expense',
    allCategories: [], expenseCategories: [], incomeCategories: [],
    visibleCategories: [], archivedCategories: [], formOpen: false,
    archivedExpanded: false, categoryDetail: null,
    draggingCategoryId: '', dragStyle: '',
    formMode: 'create', formTitle: '新建支出分类', categoryName: '', selectedCategory: null
  },

  onLoad: function () {
    themeService.bindPage(this)
    loginGuard.run(this, this.loadCategories.bind(this))
  },
  onShow: function () { themeService.bindPage(this) },
  onPullDownRefresh: function () {
    const promise = app.hasLoginApproval() ? this.loadCategories() : Promise.resolve()
    promise.finally(function () { wx.stopPullDownRefresh() })
  },

  applyCategories: function (rows) {
    const expense = categoryModel.prepare(rows, 'expense', false)
    const income = categoryModel.prepare(rows, 'income', false)
    app.globalData.categories = rows.filter(function (item) { return !item.archived })
    this.setData({
      allCategories: rows,
      expenseCategories: expense,
      incomeCategories: income,
      visibleCategories: this.data.selectedKind === 'expense' ? expense : income,
      archivedCategories: categoryModel.prepare(rows, this.data.selectedKind, true)
    })
  },

  loadCategories: function () {
    if (this.data.loading) return Promise.resolve()
    const self = this
    this.setData({ loading: true, errorMessage: '' })
    return api.callApi('categories.list')
      .then(function (result) { self.applyCategories(Array.isArray(result.categories) ? result.categories : []) })
      .catch(function (error) { self.setData({ errorMessage: error.message || '分类加载失败' }) })
      .finally(function () { self.setData({ loading: false }) })
  },

  selectKind: function (event) {
    const kind = event.currentTarget.dataset.kind
    if (kind !== 'expense' && kind !== 'income') return
    const self = this
    this.setData({ selectedKind: kind, archivedExpanded: false, categoryDetail: null }, function () {
      self.applyCategories(self.data.allCategories)
    })
  },
  findCategory: function (id) {
    return this.data.allCategories.find(function (item) { return item.id === id })
  },
  findPreparedCategory: function (id) {
    return this.data.visibleCategories.concat(this.data.archivedCategories).find(function (item) { return item.id === id })
  },
  openCategoryDetail: function (event) {
    const category = this.findPreparedCategory(event.currentTarget.dataset.id)
    if (category) this.setData({ categoryDetail: category, errorMessage: '' })
  },
  closeCategoryDetail: function () {
    if (!this.data.saving) this.setData({ categoryDetail: null, errorMessage: '' })
  },
  toggleArchived: function () { this.setData({ archivedExpanded: !this.data.archivedExpanded }) },
  openCreate: function () {
    this.setData({
      formOpen: true, formMode: 'create', selectedCategory: null, categoryDetail: null, categoryName: '', errorMessage: '',
      formTitle: this.data.selectedKind === 'expense' ? '新建支出分类' : '新建收入分类'
    })
  },
  openEdit: function (event) {
    const category = this.findCategory(event.currentTarget.dataset.id)
    if (!category || category.archived) return
    this.setData({ formOpen: true, formMode: 'edit', formTitle: '修改分类名称', categoryName: category.name, selectedCategory: category, categoryDetail: null, errorMessage: '' })
  },
  closeForm: function () { if (!this.data.saving) this.setData({ formOpen: false, errorMessage: '' }) },
  stopBubble: function () {},
  bindCategoryName: function (event) { this.setData({ categoryName: event.detail.value }) },

  saveForm: function () {
    if (this.data.saving) return
    const isCreate = this.data.formMode === 'create'
    const data = { requestId: api.createRequestId(), name: this.data.categoryName }
    if (isCreate) data.kind = this.data.selectedKind
    else Object.assign(data, { categoryId: this.data.selectedCategory.id, version: this.data.selectedCategory.version })
    const self = this
    this.setData({ saving: true, errorMessage: '' })
    api.callApi(isCreate ? 'categories.create' : 'categories.update', data)
      .then(function () { wx.showToast({ title: '已保存', icon: 'success' }); self.setData({ formOpen: false }); return self.loadCategories() })
      .catch(function (error) { self.setData({ errorMessage: error.message || '保存失败' }) })
      .finally(function () { self.setData({ saving: false }) })
  },

  setArchived: function (event) {
    const category = this.findCategory(event.currentTarget.dataset.id)
    if (!category) return
    const restoring = category.archived
    const self = this
    wx.showModal({
      title: (restoring ? '恢复“' : '停用“') + category.name + '”？',
      content: restoring ? '恢复后可继续用于导入和手动记账。' : '历史账目仍会保留，新账不再使用这个分类。',
      confirmText: restoring ? '恢复' : '停用',
      confirmColor: restoring ? themeService.currentTokens().accent : themeService.currentTokens().danger,
      success: function (result) {
        if (!result.confirm) return
        api.callApi(restoring ? 'categories.restore' : 'categories.archive', {
          requestId: api.createRequestId(), categoryId: category.id, version: category.version
        }).then(function () { self.setData({ categoryDetail: null }); return self.loadCategories() })
          .catch(function (error) { self.setData({ errorMessage: error.message || '操作失败' }) })
      }
    })
  },

  startCategoryDrag: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const touch = event.touches && event.touches[0]
    if (!touch || !Number.isInteger(index) || this.data.saving) return
    const system = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.categoryDrag = {
      id: event.currentTarget.dataset.id,
      index: index,
      target: index,
      startY: touch.clientY,
      rowHeight: system.windowWidth * 104 / 750
    }
    this.setData({ draggingCategoryId: this.categoryDrag.id, dragStyle: 'transform: translateY(0px); z-index: 3;' })
  },
  moveCategoryDrag: function (event) {
    const drag = this.categoryDrag
    const touch = event.touches && event.touches[0]
    if (!drag || !touch) return
    const position = categoryModel.resolveDrag(drag.index, drag.startY, touch.clientY, drag.rowHeight, this.data.visibleCategories.length)
    drag.target = position.target
    this.setData({ dragStyle: 'transform: translateY(' + position.offset + 'px); z-index: 3;' })
  },
  cancelCategoryDrag: function () {
    this.categoryDrag = null
    this.setData({ draggingCategoryId: '', dragStyle: '' })
  },
  endCategoryDrag: function () {
    const drag = this.categoryDrag
    this.categoryDrag = null
    this.setData({ draggingCategoryId: '', dragStyle: '' })
    if (!drag || drag.target === drag.index || this.data.saving) return
    const prepared = categoryModel.reorder(this.data.visibleCategories, drag.index, drag.target)
    const self = this
    this.setData({ visibleCategories: prepared, saving: true, errorMessage: '', categoryDetail: null })
    api.callApi('categories.reorder', {
      requestId: api.createRequestId(), kind: this.data.selectedKind,
      items: prepared.map(function (item) { return { categoryId: item.id, version: item.version } })
    }).then(function () { return self.loadCategories() })
      .catch(function (error) {
        self.applyCategories(self.data.allCategories)
        self.setData({ errorMessage: error.message || '排序失败' })
      })
      .finally(function () { self.setData({ saving: false }) })
  }
})
