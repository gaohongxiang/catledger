const api = require('../../services/catledger-import')
const cache = require('../../services/read-cache')
const pending = require('../../services/pending-ledger-write')
const { record, errorText } = require('./presentation')
const { NATURE_OPTIONS } = require('./transaction-review')
const detail = require('./detail-fields')
const { readDetail } = require('./detail-reader')
const ACTION = 'financeUpdates.setReview'
const hasDestination = nature => ['internal_transfer', 'repayment', 'borrow'].includes(nature)
function current(page, token) {
  return Boolean(token && page._viewActive && page._reviewEditToken === token && page.data.reviewEditSheet &&
    page._viewEpoch === token.epoch && page._viewSession === token.session && cache.getSession() === token.scope && getApp().hasLoginApproval())
}
function editable(page, token) {
  const sheet = page.data.reviewEditSheet
  return current(page, token) && token.session.active && token.session.summary.viewVersion === token.version &&
    !sheet.stale && !sheet.loading && !sheet.saving && !sheet.pending && !sheet.saved
}
function packetFor(page, eventId) {
  const packet = pending.pending()
  return packet && packet.target === 'import' && packet.action === ACTION && page.data.update &&
    packet.payload.updateId === page.data.update.updateId && (!eventId || packet.payload.eventId === eventId) ? packet : null
}
function fieldsFor(page) {
  const sheet = page.data.reviewEditSheet, row = page._reviewEditToken.row
  return Object.fromEntries(['economicNature', 'ledgerAccountId', 'counterpartyLedgerAccountId']
    .filter(key => (sheet[key] || null) !== (row[key] || null)).map(key => [key, sheet[key] || null]))
}
function refreshDraft(page) {
  const sheet = page.data.reviewEditSheet
  const row = { ...page._reviewEditToken.row, economicNature: sheet.economicNature, ledgerAccountId: sheet.ledgerAccountId, counterpartyLedgerAccountId: sheet.counterpartyLedgerAccountId }
  const categoryKind = nature => nature === 'income' ? 'income' : ['expense', 'fee'].includes(nature) ? 'expense' : ''
  if (categoryKind(row.economicNature) !== categoryKind(page._reviewEditToken.row.economicNature)) { row.categoryId = null; row.categoryName = '' }
  const labels = detail.accountLabels(row), destination = hasDestination(sheet.economicNature)
  const valid = Boolean(sheet.ledgerAccountId && (!destination || sheet.counterpartyLedgerAccountId && sheet.counterpartyLedgerAccountId !== sheet.ledgerAccountId))
  page.setData({ 'reviewEditSheet.hasDestination': destination,
    'reviewEditSheet.accountLabel': labels.from, 'reviewEditSheet.destinationLabel': labels.to,
    'reviewEditSheet.fields': detail.fieldsFor(row, {}, { omit: ['nature', 'account', 'counterparty'] }),
    'reviewEditSheet.canSave': valid && Object.keys(fieldsFor(page)).length > 0, 'reviewEditSheet.error': '' })
}

module.exports = {
  pendingReviewEdit() { return packetFor(this) },
  async openReviewEdit(event) {
    const eventId = event.currentTarget.dataset.id
    if (!eventId || !this._viewActive || !this._viewSession || !this._viewSession.active || this.data.busy ||
      this.data.reviewEditSheet && this.data.reviewEditSheet.saving || this.data.update.status !== 'review') return
    const token = this._reviewEditToken = { session: this._viewSession, scope: cache.getSession(), epoch: this._viewEpoch,
      version: this._viewSession.summary.viewVersion, eventId, updateVersion: this.data.update.version }
    this.setData({ reviewEditSheet: { eventId, record: null, loading: true, saving: false, pending: false,
      saved: false, stale: false, canSave: false, error: '' } })
    try {
      let row = (this.businessData().events || []).find(item => item.eventId === eventId)
      if (!row) row = (await token.session.read('economicEvents.list', { eventId, pageSize: 1 }, () => current(this, token))).items[0]
      if (!current(this, token)) return
      const verified = this._reviewDetailToken && this._reviewDetailToken.eventId === eventId && this._reviewDetailToken.version === token.version && this._reviewDetailToken.row
      if (verified) row = verified
      else if (row && row.detailRequired) row = await readDetail(token.session, eventId, () => current(this, token))
      if (!current(this, token)) return
      if (!row || !['ready', 'needs_action'].includes(row.status)) throw Error('交易已变化，请返回刷新列表')
      const packet = packetFor(this, eventId)
      token.row = row; token.payload = packet && packet.payload
      const values = { ...row, ...(packet && packet.payload.fields || {}) }
      this.setData({ reviewEditSheet: { ...this.data.reviewEditSheet, record: record(row),
        economicNature: values.economicNature, natureIndex: Math.max(0, NATURE_OPTIONS.findIndex(item => item.value === values.economicNature)),
        ledgerAccountId: values.ledgerAccountId || '', counterpartyLedgerAccountId: values.counterpartyLedgerAccountId || '',
        accountName: '', counterpartyName: '', pending: Boolean(packet), loading: false } })
      refreshDraft(this)
      if (packet) this.setData({ 'reviewEditSheet.canSave': true })
      await Promise.all([['ledgerAccountId', 'accountName'], ['counterpartyLedgerAccountId', 'counterpartyName']].map(async ([key, name]) => {
        const id = values[key]
        if (!id) return
        const local = [].concat(this.data.accounts || [], this.data.accountDrafts || []).find(item => item.accountId === id)
        let account = local
        for (const kind of account ? [] : ['accounts', 'accountDrafts']) {
          const result = await token.session.read('financeUpdates.options', { kind, id, pageSize: 1 }, () => current(this, token))
          if (!current(this, token)) return
          if (result.items[0]) { account = result.items[0]; break }
        }
        if (current(this, token) && this.data.reviewEditSheet[key] === id) this.setData({ ['reviewEditSheet.' + name]: account && account.name || '账户不可用' })
      }))
    } catch (error) { if (current(this, token)) this.setData({ 'reviewEditSheet.loading': false, 'reviewEditSheet.error': errorText(error) }) }
  },
  changeReviewedNature(event) {
    if (!editable(this, this._reviewEditToken)) return
    const index = Number(event.detail.value), nature = NATURE_OPTIONS[index]
    if (!nature) return
    this.setData({ 'reviewEditSheet.natureIndex': index, 'reviewEditSheet.economicNature': nature.value,
      ...(!hasDestination(nature.value) ? { 'reviewEditSheet.counterpartyLedgerAccountId': '', 'reviewEditSheet.counterpartyName': '' } : {}) })
    refreshDraft(this)
  },
  selectReviewedAccount(item, target) {
    if (!editable(this, this._reviewEditToken) || !item.accountId) return false
    const counterparty = target === 'reviewCounterparty'
    this.setData({ ['reviewEditSheet.' + (counterparty ? 'counterpartyLedgerAccountId' : 'ledgerAccountId')]: item.accountId,
      ['reviewEditSheet.' + (counterparty ? 'counterpartyName' : 'accountName')]: item.name })
    refreshDraft(this)
    return true
  },
  invalidateReviewEdit() {
    if (this.data.reviewEditSheet) this.setData({ 'reviewEditSheet.stale': true, 'reviewEditSheet.loading': false,
      'reviewEditSheet.canSave': this.data.reviewEditSheet.pending, 'reviewEditSheet.error': '记录已更新，请重新读取后修改' })
  },
  closeReviewEdit() {
    if (this.data.reviewEditSheet && this.data.reviewEditSheet.saving) return
    this._reviewEditToken = null
    if (this.data.directorySheet && ['reviewAccount', 'reviewCounterparty'].includes(this.data.directorySheet.target)) this.closeDirectory()
    this.setData({ reviewEditSheet: null })
    this.applyPendingBackgroundView()
  },
  async refreshReviewEdit() {
    const token = this._reviewEditToken
    if (!current(this, token) || this.data.reviewEditSheet.saving) return
    if (!token.receipt) { this.closeReviewEdit(); this.closeReviewDetails(); return this.retryPagedView() }
    this.setData({ 'reviewEditSheet.saving': true })
    try {
      const summary = await api.readSummary(token.receipt.update.updateId)
      if (!current(this, token)) return
      this._reviewEditToken = null; this._reviewDetailToken = null; this._pendingBackgroundView = null
      this.setData({ reviewEditSheet: null, reviewDetailSheet: null })
      await this.applyUpdateView(summary, false, false, false, true)
      wx.showToast({ title: '核对结果已修改', icon: 'none' })
    } catch (_) { if (current(this, token)) this.setData({ 'reviewEditSheet.saving': false, 'reviewEditSheet.error': '修改已保存，列表暂未刷新，请重试刷新' }) }
  },
  async saveReviewEdit() {
    const token = this._reviewEditToken, sheet = this.data.reviewEditSheet
    if (!current(this, token) || sheet.saving || sheet.loading || sheet.saved || !sheet.canSave || !sheet.pending && !editable(this, token)) return
    const payload = token.payload || { updateId: this.data.update.updateId, updateVersion: token.updateVersion,
      eventId: token.eventId, eventVersion: token.row.version, fields: fieldsFor(this) }
    this.setData({ 'reviewEditSheet.saving': true, 'reviewEditSheet.error': '' })
    try {
      if (!sheet.pending && this._draftSession) await this._draftSession.flush()
      if (!current(this, token) || !sheet.pending && (sheet.stale || !token.session.active || token.session.summary.viewVersion !== token.version)) return
      const result = await pending.send('import', ACTION, payload, { exact: true,
        canSend: () => current(this, token) && (sheet.pending || !this.data.reviewEditSheet.stale && token.session.active && token.session.summary.viewVersion === token.version) })
      if (!current(this, token)) return
      token.receipt = result.result
      this.setData({ 'reviewEditSheet.saved': true, 'reviewEditSheet.pending': false, 'reviewEditSheet.canSave': false, 'reviewEditSheet.saving': false })
      return this.refreshReviewEdit()
    } catch (error) {
      if (!current(this, token)) return
      const packet = packetFor(this, token.eventId), stale = ['CONFLICT', 'STALE_VIEW', 'NOT_FOUND'].includes(error.code)
      token.payload = packet && packet.payload
      this.setData({ 'reviewEditSheet.pending': Boolean(packet), 'reviewEditSheet.stale': stale || sheet.stale,
        'reviewEditSheet.canSave': Boolean(packet) || !stale && sheet.canSave,
        'reviewEditSheet.error': packet ? '保存结果待确认，重试会继续上次修改' : stale ? '记录已更新，请重新读取后修改' : errorText(error) })
    } finally { if (current(this, token) && !token.receipt) this.setData({ 'reviewEditSheet.saving': false }) }
  }
}
