const app = getApp()
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const themeService = require('../../theme/service')
const categoryModel = require('./model')

Page({
  data: {
    loading: false,
    hasLoaded: false, saving: false, errorMessage: '', selectedKind: 'expense',
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
  onShow: function () {
    themeService.bindPage(this)
    if (this.data.hasLoaded && (!pageReadSession.isCurrent(this) || !api.isFresh('categories.list'))) {
      loginGuard.run(this, this.loadCategories.bind(this))
    }
  },
  onUnload: function () { pageReadSession.end(this) },
  onPullDownRefresh: function () {
    const promise = app.hasLoginApproval() ? this.loadCategories({ force: true }) : Promise.resolve()
    promise.finally(function () { wx.stopPullDownRefresh() })
  },

  applyCategories: function (rows) {
    rows = rows.slice().sort((a, b) => a.kind.localeCompare(b.kind) || Number(a.archived) - Number(b.archived) || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    const expense = categoryModel.prepare(rows, 'expense', false)
    const income = categoryModel.prepare(rows, 'income', false)
    app.globalData.categories = rows.filter(function (item) { return !item.archived })
    this.setData({
      hasLoaded: true,
      allCategories: rows,
      expenseCategories: expense,
      incomeCategories: income,
      visibleCategories: this.data.selectedKind === 'expense' ? expense : income,
      archivedCategories: categoryModel.prepare(rows, this.data.selectedKind, true)
    })
  },

  loadCategories: function (options) {
    const isCurrent = pageReadSession.begin(this, ['loading', 'hasLoaded', 'saving', 'errorMessage', 'allCategories', 'expenseCategories', 'incomeCategories', 'visibleCategories', 'archivedCategories', 'formOpen', 'categoryDetail', 'selectedCategory', 'categoryName'], ['_readLoad'])
    if (this._readLoad) return this._readLoad
    const self = this
    const force = Boolean(options && options.force)
    this.setData({ loading: force || !api.isFresh('categories.list'), errorMessage: '' })
    this._readLoad = api.callApi('categories.list', {}, { force: force })
      .then(function (result) {
        if (!isCurrent()) return
        self.applyCategories(Array.isArray(result.categories) ? result.categories : []) })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData({ errorMessage: error.message || '分类加载失败' }) })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false }); self._readLoad = null })
    return this._readLoad
  },

  applyMutation: function (result) {
    const changed = result && (Array.isArray(result.categories) ? result.categories : [result])
    if (!changed || !changed.length || changed.some(row => !row.id || !Number.isInteger(row.version) || !row.kind || !row.name)) {
      return this.loadCategories({ force: true })
    }
    const rows = this.data.allCategories.slice()
    for (const category of changed) {
      const index = rows.findIndex(row => row.id === category.id)
      if (index >= 0 && rows[index].version > category.version) return this.loadCategories({ force: true })
      if (index < 0) rows.push(category)
      else rows[index] = category
    }
    this.applyCategories(rows)
    return Promise.resolve()
  },

  recoverMutation: function (error, fallback, isCurrent) {
    if (!isCurrent()) return Promise.resolve()
    this.applyCategories(this.data.allCategories)
    return this.loadCategories({ force: true }).then(() => {
      if (!isCurrent()) return
      const selected = this.data.selectedCategory
      this.setData({ selectedCategory: selected ? this.findCategory(selected.id) || null : null,
        errorMessage: error.message || fallback })
    })
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
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, errorMessage: '' })
    return api.callApi(isCreate ? 'categories.create' : 'categories.update', data)
      .then(function (result) { if (!isCurrent()) return; wx.showToast({ title: '已保存', icon: 'success' }); self.setData({ formOpen: false }); return self.applyMutation(result) })
      .catch(function (error) { return self.recoverMutation(error, '保存失败', isCurrent) })
      .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  },

  setArchived: function (event) {
    const category = this.findCategory(event.currentTarget.dataset.id)
    if (!category) return
    const isCurrent = pageReadSession.capture(this)
    if (!isCurrent() || this.data.saving) return
    const restoring = category.archived
    const self = this
    wx.showModal({
      title: (restoring ? '恢复“' : '停用“') + category.name + '”？',
      content: restoring ? '恢复后可继续用于导入和手动记账。' : '历史账目仍会保留，新账不再使用这个分类。',
      confirmText: restoring ? '恢复' : '停用',
      confirmColor: restoring ? themeService.currentTokens().accent : themeService.currentTokens().danger,
      success: function (result) {
        if (!result.confirm || !isCurrent() || self.data.saving) return
        self.setData({ saving: true })
        api.callApi(restoring ? 'categories.restore' : 'categories.archive', {
          requestId: api.createRequestId(), categoryId: category.id, version: category.version
        }).then(function (value) { if (!isCurrent()) return; self.setData({ categoryDetail: null }); return self.applyMutation(value) })
          .catch(function (error) { return self.recoverMutation(error, '操作失败', isCurrent) })
          .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
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
      rowHeight: system.windowWidth * 116 / 750
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
    const isCurrent = pageReadSession.capture(this)
    const prepared = categoryModel.reorder(this.data.visibleCategories, drag.index, drag.target)
    const self = this
    this.setData({ visibleCategories: prepared, saving: true, errorMessage: '', categoryDetail: null })
    return api.callApi('categories.reorder', {
      requestId: api.createRequestId(), kind: this.data.selectedKind,
      items: prepared.map(function (item) { return { categoryId: item.id, version: item.version } })
    }).then(function (result) { if (isCurrent()) return self.applyMutation(result) })
      .catch(function (error) { return self.recoverMutation(error, '排序失败', isCurrent) })
      .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  }
})
