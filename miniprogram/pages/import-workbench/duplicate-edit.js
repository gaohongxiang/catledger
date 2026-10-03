const api = require('../../services/catledger-import')
const cache = require('../../services/read-cache')
const pending = require('../../services/pending-ledger-write')
const { errorText } = require('./presentation')
const { formatMinor } = require('../../utils/money')
const ACTION = 'financeUpdates.reviseDuplicate'
const display = row => ({ ...row, amountText: formatMinor(row.amountMinor),
  sourceLabel: { bank: '银行卡账单', wechat: '微信账单', alipay: '支付宝账单' }[row.sourceType] || '原始账单' })
function patchSheet(page, values) {
  if (page.data.duplicateEditSheet) page.setData({ duplicateEditSheet: { ...page.data.duplicateEditSheet, ...values } })
}
function current(page, token) {
  return Boolean(token && page._viewActive && page._duplicateEditToken === token && page.data.duplicateEditSheet &&
    page._viewEpoch === token.epoch && page._viewSession === token.session && cache.getSession() === token.scope && getApp().hasLoginApproval())
}
function editable(page, token) {
  return current(page, token) && token.session.active && token.session.summary.viewVersion === token.version && !page.data.duplicateEditSheet.stale
}
function packetFor(page, eventId) {
  const packet = pending.pending()
  return packet && packet.target === 'import' && packet.action === ACTION && packet.payload.updateId === page.data.update.updateId &&
    (!eventId || packet.payload.eventId === eventId) ? packet : null
}
module.exports = {
  pendingDuplicateEdit() { return packetFor(this) },
  async openDuplicateEdit(event) {
    const eventId = event.currentTarget.dataset.id
    if (!eventId || !this._viewActive || !this._viewSession || !this._viewSession.active || this.data.busy ||
      this.data.duplicateEditSheet && this.data.duplicateEditSheet.saving || this.data.update.status !== 'review') return
    const token = this._duplicateEditToken = { session: this._viewSession, scope: cache.getSession(), epoch: this._viewEpoch,
      version: this._viewSession.summary.viewVersion, eventId, updateVersion: this.data.update.version }
    const packet = packetFor(this, eventId)
    token.payload = packet && packet.payload
    this.setData({ duplicateEditSheet: { eventId, records: [], count: 0, loading: true, saving: false, saved: false,
      pending: Boolean(packet), stale: false, canSave: Boolean(packet), reason: '', error: '' } })
    try {
      const view = await token.session.read('economicEvents.duplicateReview', { eventId }, () => current(this, token))
      if (!current(this, token)) return
      token.eventVersion = view.eventVersion
      token.view = view
      patchSheet(this, { 'records': (view.kind === 'distinct' && view.pairs.length ? view.pairs[0].records : view.records).map(display),
        'kind': view.kind, 'pairIndex':0,
        'count': view.count, 'reason': view.reason,
        'canSave': Boolean(packet) || view.canSplit || view.canMerge || view.canReopen, 'loading': false })
    } catch (error) { if (current(this, token)) patchSheet(this, { 'loading': false, 'error': errorText(error) }) }
  },
  async changeDuplicatePair(event) {
    const token=this._duplicateEditToken, sheet=this.data.duplicateEditSheet
    if(!editable(this,token) || sheet.pending || sheet.saving || sheet.loading || !token.view || token.view.kind!=='distinct') return
    const index=sheet.pairIndex+Number(event.currentTarget.dataset.direction)
    if(!Number.isInteger(index) || index<0 || index>=token.view.count) return
    patchSheet(this, { 'loading':true, 'canSave':false, 'error':'' })
    try {
      const view=await token.session.read('economicEvents.duplicateReview',{ eventId:token.eventId,pairIndex:index },()=>current(this,token))
      if(!editable(this,token)) return
      token.view=view
      patchSheet(this, { 'pairIndex':index, 'records':view.pairs[0].records.map(display),
        'loading':false, 'canSave':view.canMerge })
    }catch(error){if(current(this,token))patchSheet(this, { 'loading':false,'error':errorText(error) })}
  },
  closeDuplicateEdit() {
    if (this.data.duplicateEditSheet && this.data.duplicateEditSheet.saving) return
    this._duplicateEditToken = null
    this.setData({ duplicateEditSheet: null })
    this.applyPendingBackgroundView()
  },
  invalidateDuplicateEdit() {
    if (this.data.duplicateEditSheet) patchSheet(this, { 'stale': true,
      'loading': false,
      'canSave': this.data.duplicateEditSheet.pending, 'error': '记录已更新，请重新打开核对' })
  },
  async refreshDuplicateEdit() {
    const token = this._duplicateEditToken
    if (!current(this, token) || this.data.duplicateEditSheet.saving) return
    if (!token.receipt) return this.openDuplicateEdit({ currentTarget: { dataset: { id: token.eventId } } })
    patchSheet(this, { 'saving': true })
    try {
      const summary = await api.readSummary(token.receipt.update.updateId)
      if (!current(this, token)) return
      this._duplicateEditToken = null; this._pendingBackgroundView = null
      this.setData({ duplicateEditSheet: null })
      await this.applyUpdateView(summary, false, false, false, true)
      wx.showToast({ title: token.decision === 'same' ? '已合并为一笔' : token.decision === 'reopen' ? '已返回待核对' : '已恢复为独立记录', icon: 'none' })
    } catch (_) { if (current(this, token)) patchSheet(this, { 'saving': false, 'error': '判断已修改，列表暂未刷新，请重试刷新' }) }
  },
  async saveDuplicateEdit() {
    const token = this._duplicateEditToken, sheet = this.data.duplicateEditSheet
    if (!current(this, token) || sheet.saving || sheet.loading || sheet.saved || !sheet.canSave || !sheet.pending && !editable(this, token)) return
    const chosen = token.view && token.view.kind==='distinct' && token.view.pairs[0]
    const payload = token.payload || { updateId: this.data.update.updateId, updateVersion: token.updateVersion,
      eventId: token.eventId, eventVersion: token.eventVersion, decision: chosen ? 'same' : token.view.kind==='historical' ? 'reopen' : 'distinct',
      ...(chosen ? { pairKey:chosen.pairKey, otherEventId:chosen.otherEventId, otherEventVersion:chosen.otherEventVersion } : {}) }
    token.decision = payload.decision
    patchSheet(this, { 'saving': true, 'error': '' })
    try {
      if (!sheet.pending && this._draftSession) await this._draftSession.flush()
      if (!current(this, token) || !sheet.pending && !editable(this, token)) return
      const result = await pending.send('import', ACTION, payload, { exact: true,
        canSend: () => current(this, token) && (sheet.pending || editable(this, token)) })
      if (!current(this, token)) return
      token.receipt = result.result
      patchSheet(this, { 'saved': true, 'pending': false, 'canSave': false, 'saving': false })
      return this.refreshDuplicateEdit()
    } catch (error) {
      if (!current(this, token)) return
      const packet = packetFor(this, token.eventId), stale = ['CONFLICT', 'STALE_VIEW', 'NOT_FOUND'].includes(error.code)
      token.payload = packet && packet.payload
      patchSheet(this, { 'pending': Boolean(packet), 'stale': stale || sheet.stale,
        'canSave': Boolean(packet) || !stale && sheet.canSave,
        'error': packet ? '保存结果待确认，重试会继续上次修改' : stale ? '记录已更新，请重新打开核对' : errorText(error) })
    } finally { if (current(this, token) && !token.receipt) patchSheet(this, { 'saving': false }) }
  }
}
