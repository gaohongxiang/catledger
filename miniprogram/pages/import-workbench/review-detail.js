const cache = require('../../services/read-cache')
const api = require('../../services/catledger-import')
const { previewFields } = require('./inline-evidence')
const { errorText } = require('./presentation')

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

module.exports = {
  async openReviewDetails(event) {
    const eventId = event.currentTarget.dataset.id, session = this._viewSession
    if (!eventId || !this._viewActive || !session || !session.active || this.data.busy) return
    const row = (this.businessData().events || []).find(item => item.eventId === eventId)
    const duplicate = (this.data.duplicateReviewEvents || []).some(item => item.eventId === eventId)
    const token = this._reviewDetailToken = { session, eventId, version: session.summary.viewVersion,
      scope: cache.getSession(), sources: [], reading: new Set() }
    this.setData({ reviewDetailSheet: { eventId, sources: [], sourceCount: 0, loading: true, error: '', stale: false,
      canEdit: this.data.update.status === 'review' && Boolean(duplicate || row && (row.pairingDecision ||
        Number(row.evidenceCount) > 1 || Number(row.duplicateEvidenceCount) > 0)),
      repaymentEditable: this.data.update.status === 'review' && Boolean(row && ['repayment', 'internal_transfer'].includes(row.economicNature)) } })
    try {
      let cursor = null
      do {
        const response = await session.read('economicEvents.evidence', { eventId, pageSize: 40, cursor }, () => current(this, token))
        if (!current(this, token)) return
        const start = token.sources.length
        for (const source of response.items) {
          const index = token.sources.length
          token.sources.push(source)
          this.setData({ ['reviewDetailSheet.sources[' + index + ']']: { ...source, fields: [], loading: true, error: '',
            sourceLabel: { bank: '银行卡账单', wechat: '微信账单', alipay: '支付宝账单' }[source.sourceType] || '原始账单' } })
        }
        this.setData({ 'reviewDetailSheet.sourceCount': response.total })
        let next = start
        await Promise.all([0, 1].map(async () => {
          while (current(this, token) && next < token.sources.length) await readSource(this, token, next++)
        }))
        if (!current(this, token)) return
        cursor = response.nextCursor
      } while (cursor)
      this.setData({ 'reviewDetailSheet.loading': false })
    } catch (error) {
      if (current(this, token)) this.setData({ 'reviewDetailSheet.loading': false, 'reviewDetailSheet.error': errorText(error) })
    }
  },
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
    if (this.data.duplicateEditSheet && this.data.duplicateEditSheet.saving) return
    this._reviewDetailToken = null
    this.setData({ reviewDetailSheet: null })
    this.applyPendingBackgroundView()
  }
}
