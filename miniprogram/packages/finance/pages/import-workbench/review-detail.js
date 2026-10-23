const cache = require('../../../../services/read-cache')
const api = require('../../../../services/catledger-import')
const { previewFields } = require('./inline-evidence')
const { errorText, sourceCaption, canChangeJudgment } = require('./presentation')
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

// 已核对列表可能把同账户＋同期次的分期行合并成一张卡，真实事件 id 落在卡片的 rows 里。
function reviewedEventIds(reviewedEvents) {
  const ids = new Set()
  ;(reviewedEvents || []).forEach(function (item) {
    if (item.eventId) ids.add(item.eventId)
    ;(item.rows || []).forEach(function (row) { if (row.eventId) ids.add(row.eventId) })
  })
  return ids
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
      'reviewDetailSheet.canEdit': page.data.update.status === 'review' && Boolean(page.data.reviewDetailSheet.canEdit || editor.repaymentChannel),
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
        // 标题与账单文件合成一行；长名省略中间，扩展名和行号始终可见。
        page.setData({ ['reviewDetailSheet.sources[' + index + ']']: { ...source, fields: [], loading: true, error: '',
          sourceCaption: sourceCaption('原始交易 ' + (index + 1), source.fileName, source.rowNumber, 34) } })
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
    // 同步预构建只读 editor，让详情打开瞬间即渲染与待核对一致的富布局，避免读取完成前回退到纯键值列表。
    let draft0 = null, editor0 = null
    if (row) {
      try {
        draft0 = editorModel.create(row)
        editor0 = editorModel.derive(row, draft0, { accounts: (this.data.accounts || []).concat(this.data.accountDrafts || []), categories: this.data.categories || [] })
      } catch (_) { draft0 = null; editor0 = null }
    }
    this.setData({ reviewDetailSheet: { eventId, sources: [], sourceCount: 0, loading: true, error: '', stale: false,
      draft: draft0, editor: editor0,
      fields: row ? fieldsFor(row, { accounts: (this.data.accounts || []).concat(this.data.accountDrafts || []), categories: this.data.categories || [] }) : [],
      fieldsLoading: true, fieldsError: '', installmentNote: row && eventView(row).installmentNote || '',
      reviewEditable: !(row && row.installment && row.installment.component === 'principal') && this.data.update.status === 'review' && reviewedEventIds(this.data.reviewedEvents).has(eventId),
      // “由多来源合成”不能只看证据条数：同笔合并后主事件常只剩一条来源，
      // 真实来源数记在 mergeOrigins/rowIds 里，必须一起算进来才给修改同笔判断的入口。
      canEdit: this.data.update.status === 'review' && canChangeJudgment(row, duplicate),
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
