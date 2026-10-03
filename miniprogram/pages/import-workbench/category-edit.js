const api = require('../../services/catledger-import')
const cache = require('../../services/read-cache')
const pending = require('../../services/pending-ledger-write')
const { record, errorText } = require('./presentation')

const ACTION = 'financeUpdates.setCategory'
function current(page, token) {
  return Boolean(token && page._viewActive && page._categoryEditToken === token && page.data.categoryEditSheet &&
    page._viewEpoch === token.epoch && page._viewSession === token.session && cache.getSession() === token.scope &&
    getApp().hasLoginApproval())
}
function editable(page, token) {
  return current(page, token) && token.session.active && token.session.summary.viewVersion === token.version && !page.data.categoryEditSheet.stale
}
function packetFor(page, eventId) {
  const packet = pending.pending()
  return packet && packet.target === 'import' && packet.action === ACTION && page.data.update &&
    packet.payload.updateId === page.data.update.updateId && (!eventId || packet.payload.eventId === eventId) ? packet : null
}
function categoryName(item) { return [item.parentName, item.name].filter(Boolean).join(' / ') }

module.exports = {
  pendingCategoryEdit() { return packetFor(this) },

  async openCategoryEdit(event) {
    const eventId = event.currentTarget.dataset.id
    if (!eventId || !this._viewActive || !this._viewSession || !this._viewSession.active || this.data.busy ||
      this.data.categoryEditSheet && this.data.categoryEditSheet.saving || this.data.update.status !== 'review') return
    const token = this._categoryEditToken = { session: this._viewSession, scope: cache.getSession(), epoch: this._viewEpoch,
      version: this._viewSession.summary.viewVersion, eventId, updateVersion: this.data.update.version }
    this.setData({ categoryEditSheet: { eventId, record: null, selectedId: '', selectedName: '', loading: true,
      saving: false, pending: false, saved: false, stale: false, canSave: false, error: '' } })
    try {
      let row = (this.businessData().events || []).find(item => item.eventId === eventId)
      if (!row) row = (await token.session.read('economicEvents.list', { eventId, pageSize: 1 }, () => current(this, token))).items[0]
      if (!current(this, token)) return
      const packet = packetFor(this, eventId)
      if (!row || !row.categoryId || !['expense', 'income', 'fee'].includes(row.economicNature) ||
        !['ready', 'needs_action'].includes(row.status)) throw new Error('这笔交易已变化，请返回刷新列表')
      token.row = row
      token.payload = packet && packet.payload
      const selectedId = packet ? packet.payload.categoryId : row.categoryId
      const kind = row.economicNature === 'income' ? 'income' : 'expense'
      this.setData({ 'categoryEditSheet.record': record(row), 'categoryEditSheet.kind': kind,
        'categoryEditSheet.selectedId': selectedId, 'categoryEditSheet.selectedName': selectedId === row.categoryId ? row.categoryName : '上次选择',
        'categoryEditSheet.pending': Boolean(packet), 'categoryEditSheet.canSave': Boolean(packet), 'categoryEditSheet.loading': false })
      if (selectedId !== row.categoryId) {
        const options = await token.session.read('financeUpdates.options', { kind: 'categories', categoryKind: kind, id: selectedId, pageSize: 1 }, () => current(this, token))
        if (current(this, token) && options.items[0]) this.setData({ 'categoryEditSheet.selectedName': categoryName(options.items[0]) })
      }
    } catch (error) { if (current(this, token)) this.setData({ 'categoryEditSheet.loading': false, 'categoryEditSheet.error': errorText(error) }) }
  },

  selectEditedCategory(item) {
    const token = this._categoryEditToken, sheet = this.data.categoryEditSheet
    if (!editable(this, token) || sheet.saving || sheet.pending || sheet.saved || item.kind !== sheet.kind) return false
    this.setData({ 'categoryEditSheet.selectedId': item.categoryId, 'categoryEditSheet.selectedName': categoryName(item),
      'categoryEditSheet.canSave': item.categoryId !== token.row.categoryId, 'categoryEditSheet.error': '' })
    return true
  },

  invalidateCategoryEdit() {
    if (this.data.categoryEditSheet) this.setData({ 'categoryEditSheet.stale': true,
      'categoryEditSheet.canSave': this.data.categoryEditSheet.pending, 'categoryEditSheet.error': '账目已更新，请重新核对后修改' })
  },

  closeCategoryEdit() {
    if (this.data.categoryEditSheet && this.data.categoryEditSheet.saving) return
    this._categoryEditToken = null
    if (this.data.directorySheet && this.data.directorySheet.target === 'categoryEdit') this.closeDirectory()
    this.setData({ categoryEditSheet: null })
    this.applyPendingBackgroundView()
  },

  async refreshCategoryEdit() {
    const token = this._categoryEditToken
    if (!current(this, token) || this.data.categoryEditSheet.saving) return
    if (!token.receipt) { this.closeCategoryEdit(); return this.retryPagedView() }
    this.setData({ 'categoryEditSheet.saving': true })
    try {
      const summary = await api.readSummary(token.receipt.update.updateId)
      if (!current(this, token)) return
      this._categoryEditToken = null; this._pendingBackgroundView = null
      this.setData({ categoryEditSheet: null })
      await this.applyUpdateView(summary, false, false, false, true)
    } catch (_) {
      if (current(this, token)) this.setData({ 'categoryEditSheet.error': '分类已保存，列表暂未刷新，请重试刷新', 'categoryEditSheet.saving': false })
    }
  },

  async saveCategoryEdit() {
    const token = this._categoryEditToken, sheet = this.data.categoryEditSheet
    if (!current(this, token) || sheet.saving || sheet.loading || sheet.saved || !sheet.canSave ||
      !sheet.pending && !editable(this, token)) return
    const payload = token.payload || { updateId: this.data.update.updateId, updateVersion: token.updateVersion,
      eventId: token.eventId, eventVersion: token.row.version, categoryId: sheet.selectedId }
    this.setData({ 'categoryEditSheet.saving': true, 'categoryEditSheet.error': '' })
    try {
      if (!sheet.pending && this._draftSession) await this._draftSession.flush()
      if (!current(this, token) || !sheet.pending && !editable(this, token)) return
      const result = await pending.send('import', ACTION, payload, { exact: true,
        canSend: () => current(this, token) && (sheet.pending || editable(this, token)) })
      if (!current(this, token)) return
      token.receipt = result.result
      this.setData({ 'categoryEditSheet.saved': true, 'categoryEditSheet.pending': false,
        'categoryEditSheet.canSave': false, 'categoryEditSheet.saving': false })
      return this.refreshCategoryEdit()
    } catch (error) {
      if (!current(this, token)) return
      const packet = packetFor(this, token.eventId)
      token.payload = packet && packet.payload
      const stale = ['CONFLICT', 'STALE_VIEW', 'NOT_FOUND'].includes(error.code)
      this.setData({ 'categoryEditSheet.pending': Boolean(packet), 'categoryEditSheet.stale': stale || sheet.stale,
        'categoryEditSheet.canSave': Boolean(packet) || !stale && sheet.canSave,
        'categoryEditSheet.error': packet ? '保存结果待确认，重试会继续上次修改' : stale ? '账目已更新，请重新核对后修改' : errorText(error) })
    } finally { if (current(this, token) && !token.receipt) this.setData({ 'categoryEditSheet.saving': false }) }
  }
}
