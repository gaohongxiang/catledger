const catalogApi = require('../../services/catledger-api')
const api = require('../../services/catledger-import')
const pendingWrites = require('../../services/pending-ledger-write')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const money = require('../../utils/money')
const model = require('./model')
const indexOf = function (rows, key, value) { return rows.findIndex(function (row) { return row[key] === value }) }
Page({
  data: { busy: false, errorMessage: '', update: null, events: [], accounts: [], categories: [],
    eventIndex: 0, draft: null, preview: null, previewKind: '', completed: false, themeClass: '', themeStyle: '',
    showPostedRecords: false, visiblePostedRecords: 20, eventCount: 0, hasMoreEvents: false },
  onLoad: function (options) {
    theme.bindPage(this)
    this._updateId = options && options.updateId
    this._eventId = options && options.eventId
    loginGuard.run(this, this.load.bind(this))
  },
  onShow: function () { theme.bindPage(this) },
  onUnload: function () { pageReadSession.end(this) },
  viewOriginalRecord: function (event) {
    if (this.data.busy) return
    const selected = this.data.events[this.data.eventIndex]
    const eventId = event.currentTarget.dataset.id || selected && selected.eventId
    if (!eventId || !this._updateId) return
    wx.navigateTo({ url: '/pages/import-workbench/index?updateId=' + this._updateId + '&evidenceEventId=' + eventId })
  },
  togglePostedRecords: function () { this.setData({ showPostedRecords: !this.data.showPostedRecords }) },
  showMorePostedRecords: async function () {
    if (this.data.busy) return
    if (this.data.visiblePostedRecords < this.data.events.length) {
      this.setData({ visiblePostedRecords: this.data.visiblePostedRecords + 20 }); return
    }
    if (!this._eventCursor) return
    this.setData({ busy: true, errorMessage: '' })
    try {
      const page = await api.readPage('economicEvents.list', { updateId: this._updateId, view: 'posted', pageSize: 40,
        cursor: this._eventCursor, viewVersion: this._viewVersion })
      this.acceptEvents(page)
      this.selectEvent({ detail: { value: 0 } })
    } catch (error) { this.setData({ errorMessage: error.message }) }
    finally { this.setData({ busy: false }) }
  },
  acceptEvents: function (page) {
    this._eventCursor = page.nextCursor
    this._viewVersion = page.viewVersion
    this.setData({ events: page.items.map(function (row) {
      const evidence = row.primaryEvidence || {}
      return Object.assign({}, row, { label: String(row.localAt || '').slice(0, 10) + ' · ' + (evidence.item || evidence.counterparty || '账单记录') + ' · ' + money.formatMinor(row.amountMinor) })
    }), eventCount: page.total, hasMoreEvents: Boolean(page.nextCursor), visiblePostedRecords: 20 })
  },
  load: async function () {
    const isCurrent = pageReadSession.begin(this, ['update', 'events', 'accounts', 'categories', 'draft', 'preview'], [])
    if (!this._updateId) return this.setData({ errorMessage: '请从已入账账单打开维护页' })
    this.setData({ busy: true, errorMessage: '' })
    try {
      let recoveryError = ''
      try {
        const recovered = await pendingWrites.verify()
        if (recovered && isCurrent()) wx.showToast({ title: '上次操作已完成', icon: 'success' })
      } catch (error) { recoveryError = '上次操作尚待核实；再次确认将恢复原请求' }
      const values = await Promise.all([
        api.readSummary(this._updateId), catalogApi.callApi('catalog.get'),
        api.readPage('economicEvents.list', { updateId: this._updateId, view: 'posted', pageSize: 40 })
      ])
      const view = values[0], catalog = values[1], page = values[2]
      if (view.viewVersion !== page.viewVersion) throw new Error('账目已更新，请刷新后重试')
      if (this._eventId && !page.items.some(row => row.eventId === this._eventId)) {
        const selected = await api.readPage('economicEvents.list', { updateId: this._updateId, view: 'posted', eventId: this._eventId, pageSize: 1, viewVersion: view.viewVersion })
        page.items = selected.items.concat(page.items)
      }
      if (!isCurrent()) return
      this._categories = catalog.categories
      this.setData({ update: view.update, accounts: catalog.accounts.filter(function (row) { return !row.archived }),
        completed: view.update.status === 'undone', preview: null })
      this.acceptEvents(page)
      const selected = this._eventId ? indexOf(this.data.events, 'eventId', this._eventId) : this.data.eventIndex
      this.selectEvent({ detail: { value: Math.min(Math.max(0, selected), Math.max(0, this.data.events.length - 1)) } })
      if (recoveryError) this.setData({ errorMessage: recoveryError })
    } catch (error) { if (isCurrent()) this.setData({ errorMessage: error.message }) }
    finally { if (isCurrent()) this.setData({ busy: false }) }
  },
  selectEvent: function (event) {
    const index = Number(event.detail.value)
    const row = this.data.events[index]
    if (!row) return
    this._eventId = row.eventId
    const aggregate = row.economicNature === 'repayment' && row.fundsProjection && row.fundsProjection.to && row.fundsProjection.to.referenceKind === 'aggregate'
    const categories = (this._categories || []).filter(function (category) { return category.kind === (row.economicNature === 'income' ? 'income' : 'expense') })
    categories.unshift({ categoryId: null, name: '未分类' })
    const allocations = aggregate ? (row.fundsProjection.to.candidates || []).map(function (candidate) {
      const saved = (row.repaymentAllocations || []).find(function (item) { return item.accountId === candidate.accountId })
      const account = this.data.accounts.find(function (item) { return item.accountId === candidate.accountId })
      return { accountId: candidate.accountId, name: account && account.name || '还款账户', amountYuan: saved ? money.minorToYuan(saved.amountMinor) : '' }
    }, this) : []
    this._fields = null
    this._request = null
    this.setData({ eventIndex: index, categories: categories, preview: null, errorMessage: '', draft: {
      amountYuan: money.minorToYuan(row.amountMinor), aggregate: Boolean(aggregate), allocations: allocations,
      hasCategory: ['income', 'expense', 'fee'].indexOf(row.economicNature) >= 0,
      dual: !aggregate && ['internal_transfer', 'repayment', 'borrow'].indexOf(row.economicNature) >= 0,
      accountIndex: indexOf(this.data.accounts, 'accountId', row.ledgerAccountId),
      otherIndex: indexOf(this.data.accounts, 'accountId', row.counterpartyLedgerAccountId),
      categoryIndex: Math.max(0, indexOf(categories, 'categoryId', row.categoryId))
    } })
  },
  changeField: function (event) {
    if (this.data.busy) return
    const key = event.currentTarget.dataset.field
    if (['amountYuan', 'accountIndex', 'otherIndex', 'categoryIndex'].indexOf(key) < 0) return
    const patch = { preview: null }
    patch['draft.' + key] = key === 'amountYuan' ? event.detail.value : Number(event.detail.value)
    this._request = null
    this.setData(patch)
  },
  changeAllocation: function (event) {
    if (this.data.busy) return
    const index = Number(event.currentTarget.dataset.index)
    if (!this.data.draft.allocations[index]) return
    const patch = { preview: null }
    patch['draft.allocations[' + index + '].amountYuan'] = event.detail.value
    this._request = null
    this.setData(patch)
  },
  previewCorrection: function () { return this.previewImpact('correct') },
  previewUndo: function () { return this.previewImpact('undo') },
  previewImpact: async function (kind) {
    if (this.data.busy) return
    this.setData({ busy: true, errorMessage: '', preview: null })
    try {
      let impact
      if (kind === 'correct') {
        this._fields = model.fieldsForDraft(this.data.draft, this.data.accounts, this.data.categories)
        impact = await api.callImport('economicEvents.correctionImpact', { eventId: this.data.events[this.data.eventIndex].eventId, fields: this._fields })
      } else impact = await api.callImport('financeUpdates.undoImpact', { updateId: this._updateId })
      this._request = null
      this.setData({ previewKind: kind, preview: model.impactView(impact, this.data.accounts) })
    } catch (error) { this.setData({ errorMessage: error.message }) }
    finally { this.setData({ busy: false }) }
  },
  confirm: async function () {
    const isCurrent = pageReadSession.capture(this)
    if (!isCurrent()) return
    const preview = this.data.preview
    const correct = this.data.previewKind === 'correct'
    if (this.data.busy || !preview || !(correct ? preview.canCorrect : preview.canUndo)) return
    // 同一预览的重试保留 requestId，避免响应丢失时重复写入。
    if (!this._request) this._request = correct ? {
      requestId: api.createRequestId(), updateId: this._updateId, eventId: preview.eventId,
      updateVersion: preview.updateVersion, eventVersion: preview.eventVersion, fields: this._fields, previewToken: preview.previewToken
    } : { requestId: api.createRequestId(), updateId: this._updateId, version: preview.update.version, previewToken: preview.previewToken }
    this.setData({ busy: true, errorMessage: '' })
    try {
      const result = await pendingWrites.send('import', correct ? 'economicEvents.correct' : 'financeUpdates.undo', this._request)
      if (!isCurrent()) return
      getApp().globalData.ledgerRevision = (getApp().globalData.ledgerRevision || 0) + 1
      wx.showToast({ title: result.action === 'economicEvents.correct' ? '账单已更正' : '上次操作已完成', icon: 'success' })
      await this.load()
    } catch (error) { if (isCurrent()) this.setData({ errorMessage: error.message }) }
    finally { if (isCurrent()) this.setData({ busy: false }) }
  },
  refresh: function () { if (!this.data.busy) return this.load() }
})
