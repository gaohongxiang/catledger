const cache = require('../../services/read-cache')
const api = require('../../services/catledger-import')
const { previewFields } = require('./inline-evidence')
const { errorText } = require('./presentation')
const { eventView } = require('./model')
const { fieldsFor, principalOf } = require('./detail-fields')
const { readDetail } = require('./detail-reader')
const editorModel = require('./review-editor-model')

function current(page, token) {
  const sheet = page.data.reviewDetailSheet
  return Boolean(token && sheet && !sheet.stale && page._reviewDetailToken === token && page._viewActive &&
    page._viewSession === token.session && token.session.active && token.session.summary.viewVersion === token.version &&
    cache.getSession() === token.scope && getApp().hasLoginApproval())
}

async function readSource(page, token, index) {
  if (!current(page, token)) return
  const source = token.sources[index]
  if (!source || !current(page, token) || token.reading.has(index)) return
  token.reading.add(index)
  const path = 'reviewDetailSheet.sources[' + index + ']'
  page.setData({ [path + '.loading']: true, [path + '.error']: '' })
  try {
    let text = '', cursor = null
    for (let part = 0; part < 4; part++) {
      const result = await token.session.read('economicEvents.detail', {
        eventId: token.eventId, evidenceId: source.evidenceId, cursor
      }, () => current(page, token))
      if (!current(page, token)) return
      text += result.part
      cursor = result.nextCursor
      if (!cursor) break
    }
    const fields = previewFields(text, !cursor)
    page.setData({ [path + '.fields']: fields, [path + '.incomplete']: Boolean(cursor) || !fields.length,
      [path + '.loading']: false })
  } catch (error) {
    if (current(page, token)) page.setData({ [path + '.loading']: false, [path + '.error']: errorText(error) })
  } finally { token.reading.delete(index) }
}

async function readFields(page, token) {
  try {
    const row = await readDetail(token.session, token.eventId, () => current(page, token))
    if (!row || !current(page, token)) return
    token.row = row
    const draft = editorModel.create(row)
    const editor = editorModel.derive(row, draft, { accounts: row.detailFacts?.accounts || [], categories: row.detailFacts?.categories || [] })
    page.setData({ 'reviewDetailSheet.draft': draft, 'reviewDetailSheet.editor': editor,
      'reviewDetailSheet.originalRefund': row.detailFacts?.refund || null, 'reviewDetailSheet.loanName': row.detailFacts?.loan?.name || '',
      'reviewDetailSheet.fields': fieldsFor(row), 'reviewDetailSheet.fieldsLoading': false,
      'reviewDetailSheet.fieldsError': '', 'reviewDetailSheet.installmentNote': eventView(row).installmentNote || '',
      'reviewDetailSheet.reviewEditable': page.data.update.status === 'review' && ['ready','needs_action'].includes(row.status) && Boolean(row.editorFacts?.version === 1 && !row.editorFacts.readonly) })
  } catch (error) {
    if (current(page, token)) page.setData({ 'reviewDetailSheet.fieldsLoading': false, 'reviewDetailSheet.fieldsError': errorText(error) })
  }
}

async function readSources(page, token) {
  if (!current(page, token) || token.sourcesReading) return
  token.sourcesReading = true
  page.setData({ 'reviewDetailSheet.loading': true, 'reviewDetailSheet.error': '' })
  try {
    const limit = token.sources.length + 8
    do {
      const response = await token.session.read('economicEvents.evidence', {
        eventId: token.eventId, pageSize: limit - token.sources.length, cursor: token.sourceCursor || null
      }, () => current(page, token))
      if (!current(page, token)) return
      const start = token.sources.length
      for (const source of response.items) {
        const index = token.sources.length
        token.sources.push(source)
        page.setData({ ['reviewDetailSheet.sources[' + index + ']']: { ...source, fields: [], loading: true, error: '',
          sourceLabel: { bank: '银行卡账单', wechat: '微信账单', alipay: '支付宝账单' }[source.sourceType] || '原始账单' } })
      }
      token.sourceCursor = response.nextCursor
      page.setData({ 'reviewDetailSheet.sourceCount': response.total, 'reviewDetailSheet.moreSources': Boolean(response.nextCursor) })
      let next = start
      await Promise.all([0, 1].map(async () => {
        while (current(page, token) && next < token.sources.length) await readSource(page, token, next++)
      }))
      if (!current(page, token)) return
    } while (token.sourceCursor && token.sources.length < limit)
    page.setData({ 'reviewDetailSheet.loading': false })
  } catch (error) {
    if (current(page, token)) page.setData({ 'reviewDetailSheet.loading': false, 'reviewDetailSheet.error': errorText(error) })
  } finally { token.sourcesReading = false }
}

module.exports = {
  async openReviewDetails(event) {
    const eventId = event.currentTarget.dataset.id, session = this._viewSession
    if (!eventId || !this._viewActive || !session || !session.active || this.data.busy) return
    const row = (this.businessData().events || []).find(item => item.eventId === eventId)
    const duplicate = (this.data.duplicateReviewEvents || []).some(item => item.eventId === eventId)
    const token = this._reviewDetailToken = { session, eventId, version: session.summary.viewVersion,
      scope: cache.getSession(), sources: [], reading: new Set() }
    this.setData({ reviewDetailSheet: { eventId, sources: [], sourceCount: 0, loading: true, error: '', stale: false,
      fields: row ? fieldsFor(row, { accounts: (this.data.accounts || []).concat(this.data.accountDrafts || []), categories: this.data.categories || [] }) : [],
      fieldsLoading: true, fieldsError: '', installmentNote: row && eventView(row).installmentNote || '',
      reviewEditable: !(row && row.installment && row.installment.component === 'principal') && this.data.update.status === 'review' && (this.data.reviewedEvents || []).some(item => item.eventId === eventId),
      canEdit: this.data.update.status === 'review' && Boolean(duplicate || row && (row.pairingDecision ||
        Number(row.evidenceCount) > 1 || Number(row.duplicateEvidenceCount) > 0)),
      repaymentEditable: this.data.update.status === 'review' && Boolean(row && !row.installment && ['repayment', 'internal_transfer'].includes(row.economicNature)) } })
    const fieldsRead = readFields(this, token)
    await Promise.all([fieldsRead, readSources(this, token)])
  },
  loadReviewSources() { return readSources(this, this._reviewDetailToken) },
  async refreshReviewDetails() {
    const sheet = this.data.reviewDetailSheet, token = this._reviewDetailToken
    if (!sheet || !token || !this._viewActive) return
    const eventId = sheet.eventId
    if (sheet.stale || !token.session.active) {
      const active = () => this._reviewDetailToken === token && this._viewActive && cache.getSession() === token.scope
      this.setData({ 'reviewDetailSheet.loading': true, 'reviewDetailSheet.error': '' })
      try {
        const summary = await api.readSummary(this.data.update.updateId)
        if (!active()) return
        this._reviewDetailToken = null
        this.setData({ reviewDetailSheet: null })
        await this.applyUpdateView(summary, false, false, false, true)
        if (!this._viewActive || cache.getSession() !== token.scope || this._reviewDetailToken) return
        return this.openReviewDetails({ currentTarget: { dataset: { id: eventId } } })
      } catch (error) {
        if (active()) this.setData({ 'reviewDetailSheet.loading': false, 'reviewDetailSheet.error': errorText(error) })
        return
      }
    }
    this.closeReviewDetails()
    return this.openReviewDetails({ currentTarget: { dataset: { id: eventId } } })
  },
  retryReviewSource(event) {
    return readSource(this, this._reviewDetailToken, Number(event.currentTarget.dataset.index))
  },
  openReviewJudgment() {
    const sheet = this.data.reviewDetailSheet
    if (!sheet || !sheet.canEdit || sheet.loading || sheet.error || !current(this, this._reviewDetailToken)) return
    return this.openDuplicateEdit({ currentTarget: { dataset: { id: sheet.eventId } } })
  },
  reviewDetailSourcePager(eventId, evidenceId) {
    const token = this._reviewDetailToken
    if (!current(this, token) || token.eventId !== eventId) return null
    const source = token.sources.find(item => item.evidenceId === evidenceId)
    if (!source) return null
    return { cancel() {}, async load() { return { items: [source], page: { index: 0, count: 1, start: 1, end: 1, hasPrevious: false, hasNext: false } } } }
  },
  async openReviewSource(event) {
    const data = event.currentTarget.dataset
    if (!this.reviewDetailSourcePager(data.id, data.evidenceId)) return
    this.setData({ 'reviewDetailSheet.hidden': true })
    return this.openEvidence(event)
  },
  closeReviewDetails() {
    if (this.data.reviewEditSheet && this.data.reviewEditSheet.saving) return
    if (this.data.duplicateEditSheet && this.data.duplicateEditSheet.saving) return
    this._reviewDetailToken = null
    this.setData({ reviewDetailSheet: null })
    this.applyPendingBackgroundView()
  }
}
