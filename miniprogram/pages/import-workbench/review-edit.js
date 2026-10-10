const api = require('../../services/catledger-import')
const cache = require('../../services/read-cache')
const pending = require('../../services/pending-ledger-write')
const { record, errorText } = require('./presentation')
const model = require('./review-editor-model')
const { readDetail } = require('./detail-reader')
const { previewFields } = require('./inline-evidence')
const { setChangedData } = require('../../services/view-patch')
const ACTION = 'financeUpdates.setReview'
const TEXT_FIELDS = new Set(['amountInput','date','time','counterparty','note','evidenceNote','principalInput','interestInput','feeInput','periodInput','totalTermsInput'])
function current(page, token) {
  return Boolean(token && page._viewActive && page._reviewEditToken === token && page.data.reviewEditSheet &&
    page._viewEpoch === token.epoch && page._viewSession === token.session && cache.getSession() === token.scope && getApp().hasLoginApproval())
}
function editable(page, token) {
  const sheet = page.data.reviewEditSheet
  return current(page, token) && token.session.active && token.session.summary.viewVersion === token.version && token.draft &&
    token.row.editorFacts?.version === 1 && !token.row.editorFacts.readonly &&
    !sheet.stale && !sheet.loading && !sheet.saving && !sheet.pending && !sheet.saved
}
function packetFor(page, eventId) {
  const packet = pending.pending()
  return packet && packet.target === 'import' && packet.action === ACTION && page.data.update &&
    packet.payload.updateId === page.data.update.updateId && (!eventId || packet.payload.eventId === eventId) ? packet : null
}
function refresh(page) {
  const token = page._reviewEditToken
  const view = token.view = model.derive(token.row, token.draft, { accounts: [...token.accounts.values()], categories: [...token.categories.values()] })
  const labels = view.accountFields
  const { payload, ...visibleEditor } = view
  const { dirty, dormant, acknowledgedChanges, ...visibleDraft } = token.draft
  setChangedData(page, { 'reviewEditSheet.draft': visibleDraft, 'reviewEditSheet.editor': visibleEditor,
    'reviewEditSheet.economicNature': token.draft.economicNature,
    'reviewEditSheet.ledgerAccountId': token.draft.ledgerAccountId, 'reviewEditSheet.counterpartyLedgerAccountId': token.draft.counterpartyLedgerAccountId,
    'reviewEditSheet.accountLabel': labels.find(field => field.key === 'account')?.label || '资金账户',
    'reviewEditSheet.destinationLabel': labels.find(field => field.key === 'counterparty')?.label || '资金账户',
    'reviewEditSheet.accountFields': labels, 'reviewEditSheet.hasDestination': labels.length === 2,
    'reviewEditSheet.canSave': view.canSave, 'reviewEditSheet.error': '' })
}
function update(page, key, value) {
  const token = page._reviewEditToken
  if (!editable(page, token)) return
  const next = model.change(token.row, token.draft, key, value)
  if (next === token.draft) return
  token.draft = next; token.editVersion = (token.editVersion || 0) + 1
  if (['economicNature','amountInput','date','time'].includes(key)) {
    token.refundEpoch = (token.refundEpoch || 0) + 1; token.refundChecked = {}; token.refundOptions = []; token.refundCursor = null
    token.draft.refund = null
    page.setData({ 'reviewEditSheet.refundChoices': [], 'reviewEditSheet.refundLoading': false, 'reviewEditSheet.refundCanPending': false, 'reviewEditSheet.refundTotal': null, 'reviewEditSheet.refundError': '' })
  }
  if (['loanId','loanMode','repaymentMode','owner','economicNature'].includes(key)) {
    token.chargeEpoch = (token.chargeEpoch || 0) + 1
    if (key === 'loanId') { token.charges.clear(); token.chargeCursor = null; token.draft.chargeAllocations = [] }
    page.setData({ 'reviewEditSheet.chargeLoading': false, 'reviewEditSheet.chargeError': '', 'reviewEditSheet.chargeChoices': [], 'reviewEditSheet.chargeMore': false })
  }
  refresh(page)
}
async function evidence(page, token) {
  if (!current(page, token) || token.evidenceReading) return
  token.evidenceReading = true
  try {
    const result = await token.session.read('economicEvents.evidence', { eventId: token.eventId, cursor: token.evidenceCursor || null, pageSize: 8 }, () => current(page, token))
    if (!current(page, token)) return
    const start = token.sourceCount || 0
    token.sourceCount = start + result.items.length; token.evidenceCursor = result.nextCursor
    page.setData({ 'reviewEditSheet.evidenceLoading': false, 'reviewEditSheet.evidenceError': '',
      'reviewEditSheet.moreEvidence': Boolean(result.nextCursor) })
    for (const [offset, source] of result.items.entries()) {
      if (!current(page, token)) return
      const path = 'reviewEditSheet.sources[' + (start + offset) + ']'
      page.setData({ [path]: { ...source, fields: [], loading: true } })
      try {
        let text = '', cursor = null
        for (let part = 0; part < 4; part++) {
          const value = await token.session.read('economicEvents.detail', { eventId: token.eventId, evidenceId: source.evidenceId, cursor }, () => current(page, token))
          if (!current(page, token)) return
          text += value.part; cursor = value.nextCursor
          if (!cursor) break
        }
        page.setData({ [path + '.fields']: previewFields(text, !cursor), [path + '.loading']: false, [path + '.incomplete']: Boolean(cursor) })
      } catch (error) { if (current(page, token)) page.setData({ [path + '.loading']: false, [path + '.error']: errorText(error) }) }
    }
  } catch (error) { if (current(page, token)) page.setData({ 'reviewEditSheet.evidenceLoading': false, 'reviewEditSheet.evidenceError': errorText(error) }) }
  finally { token.evidenceReading = false }
}
module.exports = {
  pendingReviewEdit() { return packetFor(this) },
  async openReviewEdit(event) {
    const eventId = event.currentTarget.dataset.id
    if (!eventId || !this._viewActive || !this._viewSession?.active || this.data.busy ||
      this.data.reviewEditSheet?.saving || this.data.update.status !== 'review') return
    const token = this._reviewEditToken = { session: this._viewSession, scope: cache.getSession(), epoch: this._viewEpoch,
      version: this._viewSession.summary.viewVersion, eventId, updateVersion: this.data.update.version,
      accounts: new Map(), categories: new Map(), charges: new Map(), sourceCount: 0, evidenceSources: [], focusIssueId: event.currentTarget.dataset.focusIssueId || '' }
    this.setData({ reviewEditSheet: { eventId, record: null, loading: true, saving: false, pending: false,
      saved: false, stale: false, canSave: false, error: '', sources: [], evidenceLoading: true, evidenceError: '', moreEvidence: false,
      chargeChoices: [], chargeLoading: false, chargeError: '', chargeMore: false, refundChoices: [], refundKind: 'event', refundLoading: false, refundError: '', refundTotal: null } })
    try {
      const verified = this._reviewDetailToken
      const row = verified?.eventId === eventId && verified.version === token.version && verified.row ||
        await readDetail(token.session, eventId, () => current(this, token))
      if (!current(this, token)) return
      if (!row || !['ready', 'needs_action'].includes(row.status)) throw Error('交易已变化，请返回刷新列表')
      token.row = row
      const packet = packetFor(this, eventId)
      token.payload = packet && packet.payload
      token.draft = model.create(row)
      if (packet) {
        const fields = packet.payload.fields || {}
        for (const key of ['economicNature','ledgerAccountId','counterpartyLedgerAccountId','categoryId','counterparty','note']) if (key in fields) token.draft[key] = fields[key] || ''
        if (fields.amountMinor) token.draft.amountInput = model.yuan(fields.amountMinor)
      }
      for (const item of [].concat(this.data.accounts || [], this.data.accountDrafts || [], row.detailFacts?.accounts || [])) token.accounts.set(item.accountId, item)
      for (const item of [].concat(this.data.categories || [], row.detailFacts?.categories || [])) token.categories.set(item.categoryId, item)
      if (row.categoryId && row.categoryName) token.categories.set(row.categoryId, { categoryId: row.categoryId, name: row.categoryName, kind: model.categoryKind(row.economicNature) })
      this.setData({ 'reviewEditSheet.record': record(row), 'reviewEditSheet.loading': false,
        'reviewEditSheet.pending': Boolean(packet), 'reviewEditSheet.issue': row.pendingIssue || null,
        'reviewEditSheet.attention': row.reviewAttention?.steps || [],
        'reviewEditSheet.originalRefund': row.detailFacts?.refund || null, 'reviewEditSheet.loanName': row.detailFacts?.loan?.name || '',
        'reviewEditSheet.sourceFields': require('./detail-fields').fieldsFor(row, {}, { omit: ['nature','amount','time','party','account','counterparty','category','note'] }) })
      refresh(this)
      if (packet) this.setData({ 'reviewEditSheet.canSave': true })
      token.evidenceRead = evidence(this, token)
    } catch (error) { if (current(this, token)) this.setData({ 'reviewEditSheet.loading': false, 'reviewEditSheet.error': errorText(error) }) }
  },
  changeEditorText(event) {
    const key = event.currentTarget.dataset.field
    if (TEXT_FIELDS.has(key)) update(this, key, String(event.detail.value))
  },
  changeReviewedNature(event) {
    const token = this._reviewEditToken
    if (!editable(this, token)) return
    const option = token.view.natureOptions[Number(event.detail.value)]
    if (!option) return
    this.closeDirectory()
    update(this, 'economicNature', option.value)
    token.refundEpoch = (token.refundEpoch || 0) + 1
    this.setData({ 'reviewEditSheet.refundChoices': [], 'reviewEditSheet.refundTotal': null, 'reviewEditSheet.refundLoading': false })
  },
  changeEditorMode(event) {
    const { field, value } = event.currentTarget.dataset
    const choices = { owner: ['self','other'], otherTreatment: ['expense','pending'], repaymentMode: ['ordinary','loan'],
      composition: ['single','payment','repayment'], loanMode: ['defer','associate'], interestTreatment: ['expense','accrued'], feeTreatment: ['expense','accrued'] }
    if (!choices[field]?.includes(value)) return
    const token = this._reviewEditToken
    if (!editable(this, token) || field === 'owner' && value === 'other' && token.draft.composition === 'repayment') return
    this.closeDirectory(); update(this, field, value)
  },
  changeEditorPart(event) {
    const token = this._reviewEditToken, index = Number(event.currentTarget.dataset.index)
    if (!editable(this, token) || !Number.isInteger(index) || !token.draft.parts[index]) return
    update(this, 'parts', token.draft.parts.map((part, i) => i === index ? { ...part, amountInput: String(event.detail.value) } : part))
  },
  addEditorPart() {
    const token = this._reviewEditToken
    if (!editable(this, token) || token.draft.composition === 'single' || token.draft.parts.length >= 20) return
    update(this, 'parts', token.draft.parts.concat({ accountId: '', amountInput: '' }))
  },
  removeEditorPart(event) {
    const token = this._reviewEditToken, index = Number(event.currentTarget.dataset.index)
    if (!editable(this, token) || !Number.isInteger(index)) return
    update(this, 'parts', token.draft.parts.filter((_, i) => i !== index))
  },
  clearEditorChoice(event) {
    const token = this._reviewEditToken, key = event.currentTarget.dataset.field
    if (!editable(this, token) || !['ledgerAccountId','counterpartyLedgerAccountId','categoryId','interestCategoryId','feeCategoryId','loanId'].includes(key)) return
    update(this, key, '')
    if (key === 'loanId') { update(this, 'loanVersion', 0); this.setData({ 'reviewEditSheet.loanName': '' }) }
  },
  reviewEditorDirectory(target) {
    const token = this._reviewEditToken
    if (!editable(this, token)) return null
    const field = token.view.accountFields.find(field => field.target === target)
    if (field) return { kind: 'accounts', title: '选择' + field.label, selectedId: field.accountId, allowedTypes: field.allowedTypes }
    if (/^editorPart\d+$/.test(target)) return { kind: 'accounts', title: '选择分配账户', selectedId: token.draft.parts[Number(target.slice(10))]?.accountId,
      allowedTypes: token.draft.composition === 'repayment' ? model.DEBTS : token.draft.economicNature === 'repayment' ? model.ASSETS : null }
    const categories = { editorCategory: 'categoryId', editorInterest: 'interestCategoryId', editorFee: 'feeCategoryId' }
    if (categories[target]) return { kind: 'categories', title: '选择分类', selectedId: token.draft[categories[target]],
      categoryKind: target === 'editorCategory' ? token.view.categoryKind : 'expense' }
    if (target === 'editorLoan') return { kind: 'loans', title: '选择贷款计划', selectedId: token.draft.loanId }
    return null
  },
  isReviewEditorCurrent() { return editable(this, this._reviewEditToken) },
  selectReviewedAccount(item, target) { return this.selectEditorDirectory(item, target) },
  selectEditorDirectory(item, target) {
    const token = this._reviewEditToken, options = this.reviewEditorDirectory(target)
    if (!options || !item) return false
    if (options.kind === 'accounts') {
      if (!item.accountId || item.archivedAt || item.unavailable || options.allowedTypes && !options.allowedTypes.includes(item.type)) return false
      token.accounts.set(item.accountId, item)
      if (/^editorPart\d+$/.test(target)) {
        const index = Number(target.slice(10))
        if (!token.draft.parts[index]) return false
        update(this, 'parts', token.draft.parts.map((part, i) => i === index ? { ...part, accountId: item.accountId, label: item.name } : part))
      } else update(this, target === 'reviewAccount' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId', item.accountId)
    } else if (options.kind === 'categories') {
      if (!item.categoryId || item.archivedAt || item.kind !== options.categoryKind) return false
      token.categories.set(item.categoryId, item)
      update(this, { editorCategory: 'categoryId', editorInterest: 'interestCategoryId', editorFee: 'feeCategoryId' }[target], item.categoryId)
    } else {
      if (!item.loanId || !item.version) return false
      if (item.accountId && !token.view.accountFields.some(field => field.label === '还入账户' && field.accountId === item.accountId)) {
        this.setData({ 'reviewEditSheet.error': '该贷款不属于当前还入账户，请先核对资金账户' }); return false
      }
      update(this, 'loanId', item.loanId); update(this, 'loanVersion', Number(item.version)); update(this, 'chargeAllocations', [])
      this.setData({ 'reviewEditSheet.loanName': item.name })
    }
    return true
  },
  async loadEditorRefunds(event) {
    const token = this._reviewEditToken
    if (!editable(this, token) || !token.view.refund || token.view.errors.length || model.minor(token.draft.amountInput) == null || !token.draft.date || !token.draft.time) return
    const kind = event?.currentTarget?.dataset?.kind || this.data.reviewEditSheet.refundKind || 'event'
    const more = event?.currentTarget?.dataset?.more
    const fingerprint = JSON.stringify([token.draft.economicNature, token.draft.amountInput, token.draft.date, token.draft.time])
    const epoch = token.refundEpoch = (token.refundEpoch || 0) + 1
    const active = () => editable(this, token) && token.refundEpoch === epoch && fingerprint === JSON.stringify([
      token.draft.economicNature, token.draft.amountInput, token.draft.date, token.draft.time])
    this.setData({ 'reviewEditSheet.refundKind': kind, 'reviewEditSheet.refundLoading': true, 'reviewEditSheet.refundError': '' })
    try {
      const fields = { amountMinor: model.minor(token.draft.amountInput), occurredLocalAt: token.draft.date + ' ' + token.draft.time,
        timezoneOffsetMinutes: token.row.editorFacts.timezoneOffsetMinutes }
      const result = await token.session.read('economicEvents.refundCandidates', { eventId: token.eventId, kind, fields,
        cursor: more ? token.refundCursor : null, pageSize: 12 }, active)
      if (!active()) return
      token.refundCursor = result.nextCursor
      token.refundOptions = result.items
      token.refundChecked = { ...(token.refundChecked || {}), [kind]: result.total }
      this.setData({ 'reviewEditSheet.refundChoices': result.items.map(item => ({ ...item, amountText: '¥' + model.yuan(item.remainingMinor) })),
        'reviewEditSheet.refundTotal': result.total, 'reviewEditSheet.refundMore': Boolean(result.nextCursor),
        'reviewEditSheet.refundCanPending': token.refundChecked.event === 0 && token.refundChecked.transaction === 0,
        'reviewEditSheet.refundLoading': false })
    } catch (error) { if (active()) this.setData({ 'reviewEditSheet.refundLoading': false, 'reviewEditSheet.refundError': errorText(error) }) }
  },
  selectEditorRefund(event) {
    const token = this._reviewEditToken
    if (!editable(this, token)) return
    if (this.data.reviewEditSheet.refundLoading) return
    const mode = event.currentTarget.dataset.mode
    if (mode === 'pending' && this.data.reviewEditSheet.refundCanPending) update(this, 'refund', { mode: 'pending' })
    else if (mode === 'unlinked') update(this, 'refund', { mode: 'unlinked' })
    else {
      const item = token.refundOptions?.find(row => row.id === event.currentTarget.dataset.id)
      if (item) update(this, 'refund', { mode: 'link', kind: item.kind, id: item.id, version: item.version })
    }
  },
  async loadEditorCharges(event) {
    const token = this._reviewEditToken
    if (!editable(this, token) || !token.view.showLoan || !token.draft.loanId || token.draft.loanMode !== 'associate') return
    const loanId = token.draft.loanId, epoch = token.chargeEpoch = (token.chargeEpoch || 0) + 1
    const active = () => editable(this, token) && token.chargeEpoch === epoch && token.draft.loanId === loanId
    this.setData({ 'reviewEditSheet.chargeLoading': true, 'reviewEditSheet.chargeError': '' })
    try {
      const more = event?.currentTarget?.dataset?.more
      const result = await require('../../services/catledger-api').callApi('loans.chargePlan', { loanId, pageSize: 20, ...(more && token.chargeCursor ? { cursor: token.chargeCursor } : {}) }, { force: true })
      if (!active()) return
      if (Number(result.loanVersion) !== token.draft.loanVersion) throw Error('贷款资料已变更，请重新选择该计划后核验费用')
      const choices = result.items.filter(item => ['planned','recorded','baseline'].includes(item.state))
      for (const item of choices) token.charges.set(item.chargeId, item)
      token.chargeCursor = result.nextCursor
      this.setData({ 'reviewEditSheet.chargeChoices': choices.map(item => ({ chargeId: item.chargeId, component: item.component,
        label: (item.periodNumber ? '第 ' + item.periodNumber + ' 期' : '一次性') + (item.component === 'interest' ? '利息' : '费用'),
        treatment: item.state === 'planned' ? '补记费用' : '已记费用', amount: model.yuan(item.outstandingMinor),
        selected: token.draft.chargeAllocations.some(part => part.chargeId === item.chargeId) })),
        'reviewEditSheet.chargeLoading': false, 'reviewEditSheet.chargeMore': Boolean(result.nextCursor) })
    } catch (error) { if (active()) this.setData({ 'reviewEditSheet.chargeLoading': false, 'reviewEditSheet.chargeError': error.message || errorText(error) }) }
  },
  selectEditorCharge(event) {
    const token = this._reviewEditToken, id = event.currentTarget.dataset.id
    if (!editable(this, token) || this.data.reviewEditSheet.chargeLoading) return
    const item = token.charges.get(id)
    if (!item) return
    const old = token.draft.chargeAllocations, exists = old.some(part => part.chargeId === id)
    if (!exists && old.length >= 80) return
    update(this, 'chargeAllocations', exists ? old.filter(part => part.chargeId !== id)
      : old.concat({ chargeId: id, component: item.component, amountInput: model.yuan(item.outstandingMinor) }))
    this.setData({ 'reviewEditSheet.chargeChoices': this.data.reviewEditSheet.chargeChoices.map(choice => ({ ...choice, selected: token.draft.chargeAllocations.some(part => part.chargeId === choice.chargeId) })) })
  },
  changeEditorChargeAmount(event) {
    const token = this._reviewEditToken, index = Number(event.currentTarget.dataset.index)
    if (!editable(this, token) || !Number.isInteger(index) || !token.draft.chargeAllocations[index]) return
    update(this, 'chargeAllocations', token.draft.chargeAllocations.map((part, i) => i === index ? { ...part, amountInput: String(event.detail.value) } : part))
  },
  removeEditorCharge(event) {
    const token = this._reviewEditToken, index = Number(event.currentTarget.dataset.index)
    if (editable(this, token) && Number.isInteger(index)) update(this, 'chargeAllocations', token.draft.chargeAllocations.filter((_, i) => i !== index))
  },
  async openEditorOriginal(event) {
    const token = this._reviewEditToken
    if (!current(this, token) || this.data.reviewEditSheet.saving) return
    this.setData({ 'reviewEditSheet.hidden': true })
    await this.openEvidence({ currentTarget: { dataset: { id: token.eventId } } })
    if (current(this, token) && !this.data.evidenceSheet) this.setData({ 'reviewEditSheet.hidden': false })
  },
  loadEditorEvidence() { const token = this._reviewEditToken; if (current(this, token)) return evidence(this, token) },
  async openEditorIssue() {
    const token = this._reviewEditToken, issue = this.data.reviewEditSheet?.issue
    if (!current(this, token) || !issue || Object.keys(token.draft.dirty).length) {
      if (current(this, token)) this.setData({ 'reviewEditSheet.error': '请先保存当前修改，再核对关系；关系判断不会自动保存本笔字段' })
      return
    }
    this.closeReviewEdit()
    return this.openIssue({ currentTarget: { dataset: { id: issue.issueId } } })
  },
  invalidateReviewEdit() {
    if (this.data.reviewEditSheet) this.setData({ 'reviewEditSheet.stale': true, 'reviewEditSheet.loading': false,
      ...(!this._reviewEditToken?.sent ? { 'reviewEditSheet.saving': false } : {}),
      'reviewEditSheet.canSave': this.data.reviewEditSheet.pending, 'reviewEditSheet.error': '记录已更新，输入已保留，请重新读取后核验' })
  },
  closeReviewEdit() {
    if (this.data.reviewEditSheet?.saving) return
    this._reviewEditToken = null
    if (this.data.directorySheet?.editorDirectory) this.closeDirectory()
    this.setData({ reviewEditSheet: null }); this.applyPendingBackgroundView()
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
      wx.showToast({ title: '本笔修改已保存', icon: 'none' })
    } catch (_) { if (current(this, token)) this.setData({ 'reviewEditSheet.saving': false, 'reviewEditSheet.error': '修改已保存，列表暂未刷新，请重试刷新' }) }
  },
  async saveReviewEdit() {
    const token = this._reviewEditToken, sheet = this.data.reviewEditSheet
    if (!current(this, token) || sheet.saving || sheet.loading || sheet.saved || !sheet.canSave || !sheet.pending && !editable(this, token)) return
    const editVersion = token.editVersion || 0
    const payload = token.payload || { updateId: this.data.update.updateId, updateVersion: token.updateVersion,
      eventId: token.eventId, eventVersion: token.row.version, ...token.view.payload }
    const requires = []
    if (!sheet.pending && token.row.detailFacts?.refund?.status === 'confirmed' && (token.draft.economicNature !== 'refund' || token.draft.refund)) requires.push('refund')
    if (!sheet.pending && token.row.loanRepayment && payload.decisions?.repayment === null) requires.push('repayment')
    if (!sheet.pending && token.row.editorFacts && payload.composition && (token.row.paymentResolution || token.row.repaymentAllocations?.length) &&
      (payload.composition.kind !== token.row.editorFacts.composition || payload.composition.incomplete)) requires.push('composition')
    if (requires.length && !requires.every(key => payload.acknowledgedChanges.includes(key))) {
      const accepted = await new Promise(resolve => wx.showModal({ title: '确认关系变更', content: '保存将重新核验或解除本笔已保存的资金分配、退款或还款关系，原始账单不会改变。', success: result => resolve(result.confirm), fail: () => resolve(false) }))
      if (!accepted || !editable(this, token) || editVersion !== (token.editVersion || 0)) return
      payload.acknowledgedChanges = [...new Set(payload.acknowledgedChanges.concat(requires))]
    }
    this.setData({ 'reviewEditSheet.saving': true, 'reviewEditSheet.error': '' })
    try {
      if (!sheet.pending && this._draftSession) await this._draftSession.flush()
      if (!current(this, token) || !sheet.pending && (sheet.stale || !token.session.active || token.session.summary.viewVersion !== token.version)) return
      token.sent = true
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
        'reviewEditSheet.error': packet ? '保存结果待确认，重试会继续上次修改' : stale ? '记录已更新，输入已保留，请重新核验' : errorText(error) })
    } finally { if (current(this, token) && !token.receipt) this.setData({ 'reviewEditSheet.saving': false }) }
  }
}
