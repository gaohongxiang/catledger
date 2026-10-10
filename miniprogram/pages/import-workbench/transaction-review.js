const { readDetail } = require('./detail-reader')
const { publicError } = require('./presentation')
const model = require('./model')
const presentation = require('./presentation')
const { errorText, direction } = require('./presentation')
const api = require('../../services/catledger-import')
const readCache = require('../../services/read-cache')
const inlineEvidence = require('./inline-evidence')
const observer = require('../../services/read-observer')

function evidenceCurrent(page, token) {
  return Boolean(token && page._viewActive && page._evidenceReadToken === token &&
    page._viewSession === token.session && token.session.active && token.session.summary.viewVersion === token.version &&
    readCache.getSession() === token.scope && page.data.evidenceSheet && page.data.evidenceSheet.eventId === token.eventId)
}

function bankChannelCandidate(issue) {
  return issue.issueType === 'same_event' && (issue.primaryReasonCode === 'bank_channel_same_event_candidate' ||
    (issue.reasonCodes || []).includes('bank_channel_same_event_candidate'))
}

function editorPreview(event) {
  if (!event || !event.primaryEvidence) return event
  let shortened = false
  const primaryEvidence = Object.fromEntries(Object.entries(event.primaryEvidence).map(([key, value]) => {
        if (typeof value === 'string' && value.length > 160) { shortened = true; return [key, value.slice(0, 160) + '…'] }
        return [key, value]
      }))
  return Object.assign({}, event, { primaryEvidence, detailRequired: event.detailRequired || shortened })
}

function issueCurrent(page, token) {
  return Boolean(token && page._viewActive && !page.data.issueStale && page._issueEvidenceToken === token &&
    page._viewSession === token.session && token.session.active && token.session.summary.viewVersion === token.version &&
    readCache.getSession() === token.scope && page.data.currentIssue && page.data.currentIssue.issueId === token.issueId)
}

function markIssue(page, token, phase, ok = true) {
  if (!issueCurrent(page, token)) return
  observer.record('interactive', { page: 'pages/import-workbench/index', phase, ok, elapsedMs: Date.now() - token.startedAt })
}

function directoryKinds(issue) {
  if (issue.issueType === 'category_assignment') return ['categories']
  if (issue.issueType === 'account_mapping') return ['accounts', 'accountDrafts']
  return []
}

function issueSubject(details, fallback) {
  const summary = details.issue.subject || fallback || null
  const eventId = summary && summary.eventId
  // 问题摘要不含完整来源方向；优先使用同一事件的详情，不能让摘要盖住它。
  const candidates = [details.subject].concat(details.members.map(member => member.event))
  const event = candidates.find(row => row && (!eventId || row.eventId === eventId))
  return event ? Object.assign({}, summary, event) : summary
}

async function readIssueFacts(page, token) {
  if (!issueCurrent(page, token) || token.factsReading) return
  const row = page.data.currentIssue.subject || page.data.issueEvents[0]
  if (!row || !row.eventId) return
  token.factsReading = true
  page.setData({ issueFactsLoading: true, issueFactsError: '' })
  try {
    const detail = await readDetail(token.session, row.eventId, () => issueCurrent(page, token))
    if (!detail || !issueCurrent(page, token)) return
    page.setData({ issueFacts: { eventId: row.eventId, sourceDirection: detail.sourceDirection || null,
      detailFacts: detail.detailFacts || null }, issueFactsLoading: false })
    if (token.initialized) page.refreshIssueFieldsDraft()
  } catch (error) {
    if (issueCurrent(page, token)) page.setData({ issueFactsLoading: false, issueFactsError: publicError(error, '记账信息未能完整读取') })
  } finally { token.factsReading = false }
}

function cancelIssueReads(page) {
  page.closeInlineEvidence('issue')
  for (const key of ['_memberPager', '_relationPager', '_historicalPager']) {
    if (page[key]) page[key].cancel()
    page[key] = null
  }
  page._issueEvidenceToken = null
}

function initializeIssueEditor(details, token) {
  const events = details.members.filter(member => member.event).map(member => member.event)
  const summary = this.businessData().issues.find(issue => issue.issueId === token.issueId)
  const subject = issueSubject(details, summary && summary.subject)
  const currentIssue = model.issueView({ ...details.issue, subject,
    accountContext: details.issue.accountContext || summary && summary.accountContext })
  const accounts = details.accounts.concat((details.accountDrafts || []).map(account => ({ ...account, isDraft: true, name: account.name + '（本批新建）' })))
  const accountChoices = [{ accountId: '', name: '新建账户', isCreate: true }].concat(accounts)
  const categories = [{ categoryId: '', name: '请选择分类', isPlaceholder: true }].concat(model.categoriesForNature(details.categories, subject && subject.economicNature))
  this.setData({ busy: false, update: details.update, currentIssue, issueSourceExpanded: true,
    currentMembers: details.members, issueEvents: events.map(model.eventView), accounts,
    accountDrafts: details.accountDrafts || [], accountChoices, categories: details.categories,
    issueCategories: categories, issueFieldsReason: '',
    issueScopeCount: Number(details.issue.subjectCount || details.issue.memberCount || events.length),
    issueDraft: { accountIndex: Math.max(0, accountChoices.findIndex(account => subject && account.accountId === subject.ledgerAccountId)),
      categoryIndex: Math.max(0, categories.findIndex(category => subject && category.categoryId === subject.categoryId)),
      newAccountName: currentIssue.accountContext && currentIssue.accountContext.recognized ? Array.from(currentIssue.accountContext.label.trim()).slice(0, 32).join('') : '',
      accountTypeIndex: 2, primaryEventId: subject && subject.eventId || '', categoryChanged: false }
  })
  this.restoreReviewDraft(token.issueId, token.savedForm)
  this.refreshIssueFieldsDraft()
  token.initialized = true
  this.setData({ issueDetailsReady: true })
}

async function completeIssueEditor(page, token) {
  if (!issueCurrent(page, token) || !token.details || token.initialized || token.preparing) return
  token.preparing = true
  const details = token.details
  try {
    let directory = { accounts: [], categories: [], accountDrafts: [] }
    if (details.accounts && details.categories && details.accountDrafts) directory = details
    else {
      const saved = token.savedForm || ((page._draftSession && page._draftSession.state.entries.find(item => item.issueId === token.issueId)) || {}).form || {}
      const pins = [saved.accountId, saved.categoryId]
      directory = Object.assign(directory, await page.loadDirectories(details.subject ? [details.subject] : details.members.filter(row => row.event).map(row => row.event), pins, directoryKinds(details.issue)))
    }
    if (!issueCurrent(page, token)) return
    initializeIssueEditor.call(page, Object.assign({}, details, directory, { members: details.members.concat(token.relationMembers || []) }), token)
    page.setData({ issueDetailsLoading: false, issueDetailsError: '' })
    page.updateIssueReadiness()
  } catch (error) {
    if (issueCurrent(page, token)) page.setData({ issueDetailsLoading: false, issueDetailsError: publicError(error, '可选账户或分类读取失败，请重试'), issueCanSubmit: false })
  } finally { token.preparing = false }
}

async function showIssueEditor(event, savedForm) {
  if (this.data.busy || !this._viewActive || !this._viewSession || !this._viewSession.active) return
  const issueId = event.currentTarget.dataset.id
  cancelIssueReads(this)
  if (this._pendingBackgroundView) {
    const pending = this._pendingBackgroundView
    this._pendingBackgroundView = null
    // 挂起视图本就为避免打断用户而延迟；延迟到开弹层时应用仍保持当前步骤，不能按 workflow 把用户降级。
    this.applyUpdateView(pending, false, false, false, true)
  }
  const summary = this.businessData().issues.find(issue => issue.issueId === issueId) || { issueId, issueType: '', label: '核对记录' }
  if (bankChannelCandidate(summary) && this.openAmbiguousPairingReview) {
    this.setData({ currentIssue: null })
    return this.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId } } })
  }
  const token = this._issueEvidenceToken = { issueId, session: this._viewSession, version: this._viewSession.summary.viewVersion,
    scope: readCache.getSession(), startedAt: Date.now(), savedForm }
  this.setData({ currentIssue: model.issueView(summary), currentMembers: [], issueEvents: [], issueVisibleEvents: [], issueRelations: [],
    issueFacts: null, issueFactsLoading: false, issueFactsError: '', issueDetail: null,
    issueDetailsLoading: true, issueDetailsReady: false, issueDetailsError: '', issueCanSubmit: false, issueStale: false,
    issueMembersError: '', issueRelationsError: '', issueRelationsLoading: false, issueSourceExpanded: true,
    issueEvidenceLoading: true, issueEvidenceTotal: Number(summary.memberCount || 0), memberPage: null, relationPage: null,
    historicalCandidates: [], historicalPage: null, historicalSelection: '', historicalLoading: false, historicalError: '',
    errorMessage: '' }, () => markIssue(this, token, 'review_feedback'))
  try {
    const details = await this.request('reviewIssues.get', { issueId })
    if (!issueCurrent(this, token)) return
    if (bankChannelCandidate(details.issue) && this.openAmbiguousPairingReview) {
      cancelIssueReads(this); this.setData({ currentIssue: null })
      return this.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId } } })
    }
    token.details = details
    const currentIssue = model.issueView(Object.assign({}, details.issue, { subject: issueSubject(details, summary.subject) }))
    const members = details.members.filter(row => row.event)
    this.setData({ currentIssue, issueEvents: members.map(row => model.eventView(row.event)),
      issueVisibleEvents: members.map(row => Object.assign({}, presentation.record(row.event), { evidenceLoading: true, evidence: [] })) },
    () => markIssue(this, token, 'review_content'))
    // 与目录和原文并行补充当前笔只读事实，失败不会重读已成功的目录或覆盖输入。
    token.factsPromise = readIssueFacts(this, token)
    this._memberPager = token.session.pager('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 })
    const reads = [this.changeIssueMembers({ currentTarget: { dataset: {} } }), completeIssueEditor(this, token)]
    if (currentIssue.issueType === 'refund_relation') {
      this._relationPager = token.session.pager('reviewIssues.members', { issueId, memberKind: 'relation', pageSize: 8 })
      reads.push(this.changeIssueRelations({ currentTarget: { dataset: {} } }))
    } else token.relationsReady = true
    if (currentIssue.historicalDuplicate) {
      this._historicalPager = token.session.pager('reviewIssues.members', { issueId, memberKind: 'transaction', pageSize: 8 })
      reads.push(this.changeHistoricalPage({ currentTarget: { dataset: {} } }))
    } else token.historyReady = true
    this.updateIssueReadiness()
    await Promise.all(reads)
    if (!issueCurrent(this, token)) return
  } catch (error) {
    if (issueCurrent(this, token)) this.setData({ issueDetailsLoading: false, issueDetailsError: publicError(error, '问题详情加载失败，请重试'), issueCanSubmit: false })
  }
}

module.exports = {
  toggleIssueSource: function () {
    this.setData({ issueSourceExpanded: !this.data.issueSourceExpanded })
  },

  switchReviewTab: function (event) {
    const tab = event.currentTarget.dataset.tab
    if (!['review', 'category'].includes(tab)) return
    this.setData({ activeReviewTab: tab })
    return this.renderReview(true)
  },

  switchCategoryStatus: function (event) {
    const status = event.currentTarget.dataset.status
    if (!['pending', 'completed', 'none'].includes(status)) return
    this.setData({ activeCategoryStatus: status })
    this.renderReview(true)
  },

  searchCategoryIssues: function (event) {
    const query = String(event.detail.value || '').slice(0, 80)
    this.setData({ categoryQuery: query })
    this._reviewProjection = null
    // bindinput 的返回值会替换原生输入内容，异步读取不能作为返回值。
    this.renderReview(true)
  },

  searchReviewIssues: function (event) {
    this.setData({ reviewQuery: String(event.detail.value || '').slice(0, 80) })
    this.renderReview(true)
  },

  reviewBeforeCategory: function (event) {
    this.setData({ activeReviewTab: 'review', activeReviewStatus: 'pending' })
    this.renderReview(true)
    if (event.currentTarget.dataset.id) this.openIssue(event)
  },

  switchReviewStatus: function (event) {
    const status = String(event.currentTarget.dataset.status || '')
    if (!['pending', 'completed', 'excluded', 'duplicate'].includes(status) || status === this.data.activeReviewStatus) return
    this.setData({ activeReviewStatus: status })
    return this.renderReview(true)
  },

  closeReviewSheet: function () {
    if (this.data.evidenceSheet) this.closeEvidence()
    else this.closeIssue()
  },

  openIssue: function (event) {
    return showIssueEditor.call(this, event)
  },

  openPendingRecord: function (event) {
    const data = event.currentTarget.dataset
    if (!data.id || this.data.busy) return
    if (this.data.currentIssue) this.closeIssue()
    if (data.issueId && this.data.update && this.data.update.status === 'review') {
      return this.openReviewEdit({ currentTarget: { dataset: { id: data.id, focusIssueId: data.issueId || '' } } })
    }
    return this.openReviewDetails({ currentTarget: { dataset: { id: data.id } } })
  },

  updateIssueReadiness: function () {
    const token = this._issueEvidenceToken
    if (!issueCurrent(this, token)) return
    const ready = Boolean(token.initialized && token.membersReady && token.relationsReady && token.historyReady && !this.data.issueStale &&
      !this.data.issueDetailsError && !this.data.issueMembersError && !this.data.issueRelationsError && !this.data.historicalError)
    if (ready !== this.data.issueCanSubmit) this.setData({ issueCanSubmit: ready }, () => { if (ready) markIssue(this, token, 'review_ready') })
  },

  retryIssueFacts: function () { return readIssueFacts(this, this._issueEvidenceToken) },

  retryIssueDetails: async function () {
    const token = this._issueEvidenceToken
    if (!this.data.currentIssue || this.data.busy) return
    if (!token || token.scope !== readCache.getSession() || token.session !== this._viewSession || !this._viewActive) return
    const issueId = this.data.currentIssue.issueId
    if (this.data.issueStale || !issueCurrent(this, token)) {
      const savedForm = this.data.issueDetailsReady ? this.reviewDraftEntry(this.data.currentIssue, '', {}).form : token && token.savedForm
      const session = this._viewSession, scope = readCache.getSession()
      const active = () => this._viewActive && this._issueEvidenceToken === token && this._viewSession === session &&
        readCache.getSession() === scope && this.data.currentIssue && this.data.currentIssue.issueId === issueId
      this.setData({ issueDetailsLoading: true, issueDetailsError: '' })
      try {
        const pending = this._pendingBackgroundView || await api.readSummary(this.data.update.updateId)
        if (!active()) return
        this._pendingBackgroundView = null
        this.applyUpdateView(pending, false, false, false, true)
      } catch (error) {
        if (active()) this.setData({ issueDetailsLoading: false, issueDetailsError: publicError(error, '版本核验失败，请重试') })
        return
      }
      return showIssueEditor.call(this, { currentTarget: { dataset: { id: issueId } } }, savedForm)
    }
    if (!token.details) return showIssueEditor.call(this, { currentTarget: { dataset: { id: issueId } } }, token.savedForm)
    this.setData({ issueDetailsLoading: true, issueDetailsError: '' })
    return completeIssueEditor(this, token)
  },

  closeIssue: function () {
    if (this.data.busy) return
    cancelIssueReads(this)
    if (!this.data.busy) {
      this.finishInputEditing()
      this._issueEvidenceToken = null
      this._issueEvidenceRecords = []
      this.setData({ currentIssue: null, currentMembers: [], evidenceSheet: null, issueVisibleEvents: [], issueCanSubmit: false, issueDetailsReady: false })
    }
    this.applyPendingBackgroundView()
  },

  closeEvidence: function () {
    for (const key of ["_evidencePager","_detailPager"]) { if (this[key]) this[key].cancel(); this[key] = null }
    this._evidenceReadToken = null
    this.setData({ busy: false, evidenceSheet: null })
    if (this.data.reviewDetailSheet) this.setData({ 'reviewDetailSheet.hidden': false })
    if (this.data.reviewEditSheet) this.setData({ 'reviewEditSheet.hidden': false })
    this.applyPendingBackgroundView()
  },

  changeIssueAccount: function (event) {
    this.setData({ 'issueDraft.accountIndex': Number(event.detail.value) })
    this.refreshIssueFieldsDraft()
  },

  changeDraftAccountName: function (event) {
    this.setData({ 'issueDraft.newAccountName': event.detail.value })
    this.refreshIssueFieldsDraft()
  },

  changeDraftAccountType: function (event) {
    this.setData({ 'issueDraft.accountTypeIndex': Number(event.detail.value) })
    this.refreshIssueFieldsDraft()
  },

  changeIssueCategory: function (event) {
    const categoryIndex = Number(event.detail.value)
    const category = (this.data.issueCategories || [])[categoryIndex]
    this.setData({
        'issueDraft.categoryIndex': categoryIndex,
        'issueDraft.categoryChanged': true,
        issueCategoryCanSave: Boolean(category && category.categoryId)
      })
    this.refreshIssueFieldsDraft()
  },

  selectPrimaryEvent: function (event) {
    this.setData({ 'issueDraft.primaryEventId': event.currentTarget.dataset.id })
  },

  resolveWithFields: function () {
    const issue = this.data.currentIssue
    if (!issue || this.data.busy || !['account_mapping', 'category_assignment'].includes(issue.issueType)) return
    const state = this.refreshIssueFieldsDraft()
    if (!state.valid) { this.setData({ errorMessage: state.reason }); return }
    return this.resolveIssue('apply_fields', { fields: state.fields })
  },

  confirmDistinct: function () {
    if (this.data.currentIssue && this.data.currentIssue.historicalDuplicate &&
      (this.data.historicalLoading || this.data.historicalError || !this.data.historicalCandidates.length)) return
    return this.resolveIssue('confirm_distinct', {})
  },

  confirmSame: function () {
    const issue = this.data.currentIssue
    if (!issue || this.data.busy) return
    if (bankChannelCandidate(issue)) {
      const invalid = message => this.setData({ errorMessage: message, issueFieldsReason: message, issueFieldsCanSave: false })
      const events = (this.data.currentMembers || []).filter(member => member.event).map(member => member.event)
      if (Number(issue.candidateCount) > 1 || events.length > 2) {
        invalid('存在多笔候选，请逐笔核对，不能整组确认为同一笔')
        return
      }
      const primary = events.find(row => row.eventId === this.data.issueDraft.primaryEventId)
      if (!primary || !['wechat', 'alipay'].includes(primary.primaryEvidence && primary.primaryEvidence.sourceType) ||
        !['expense', 'refund'].includes(primary.economicNature)) {
        invalid('请选择微信或支付宝中已明确为支出或退款的记录作为主记录')
        return
      }
      if (events.length !== 2 || events.filter(row => row.primaryEvidence && row.primaryEvidence.sourceType === 'bank').length !== 1) {
        invalid('请先核对完整的银行和微信或支付宝两笔记录')
        return
      }
      this.setData({ errorMessage: '' })
      this.refreshIssueFieldsDraft()
    }
    return this.resolveIssue('confirm_same', { primaryEventId: this.data.issueDraft.primaryEventId })
  },

  reviewDraftEntry: function (issue, decision, extra) {
    const data = this.data
    const form = { issueDraft: data.issueDraft, historicalSelection: data.historicalSelection,
      accountId: ((data.accountChoices || [])[data.issueDraft.accountIndex] || {}).accountId,
      categoryId: ((data.issueCategories || [])[data.issueDraft.categoryIndex] || {}).categoryId,
      categoryChanged: Boolean(data.issueDraft.categoryChanged) }
    return { kind: 'review', issueId: issue.issueId, issueVersion: issue.version, issueType: issue.issueType,
      subjectIds: issue.subjectEventIds || (this.data.issueEvents || []).map(function (event) { return event.eventId }),
      decision: Object.assign({ decision: decision }, extra || {}), form: form }
  },

  restoreReviewDraft: function (issueId, savedForm) {
    if (!this._draftSession && !savedForm) return
    const entry = savedForm ? { form: savedForm } : this._draftSession.state.entries.concat(this._draftSession.state.conflictedChoices || []).find(function (item) { return item.issueId === issueId })
    if (!entry || !entry.form) return
    const form = entry.form
    const draft = Object.assign({}, form.issueDraft)
    // 被归档/移除的旧选择保留原 ID 并明确失效，不能悄悄改成首项或新建账户。
    const pins = {}
    const keepChoice = (property, key, value) => {
      if (value && !this.data[property].some(row => row[key] === value)) pins[property] = this.data[property].concat({
        [key]: value, name: '原选择已不可用，请重选', unavailable: true, isPlaceholder: true })
    }
    keepChoice('accountChoices', 'accountId', form.accountId)
    keepChoice('issueCategories', 'categoryId', form.categoryId)
    if (Object.keys(pins).length) this.setData(pins)
    const indexOf = function (options, key, value) { return Math.max(0, (options || []).findIndex(function (item) { return value && item[key] === value })) }
    this.setData({ issueDraft: Object.assign({}, draft, {
            accountIndex: indexOf(this.data.accountChoices, 'accountId', form.accountId),
            categoryIndex: indexOf(this.data.issueCategories, 'categoryId', form.categoryId),
            categoryChanged: Boolean(form.categoryChanged) }),
        historicalSelection: form.historicalSelection || '',
        historicalSelectionVerified: Boolean(form.historicalSelection && this.data.historicalCandidates.some(row => row.transactionId === form.historicalSelection && !row.stale)) })
  },

  recheckDraftConflicts: function () {
    if (!this._draftSession || this.data.busy) return
    this._draftSession.discardConflicts()
    this.setStep({ currentStep: this.data.accountStepSummary.pending ? 2 : 3,
        errorMessage: '已显示最新结果，原选择仍保留，请重新核对有变化的项目' })
  },

  resolveIssue: async function (decision, extra) {
    if (!this._draftSession) return
    const issue = this.data.currentIssue
    if (!issue || this.data.busy || !this.data.issueCanSubmit || !issueCurrent(this, this._issueEvidenceToken)) return
    const token = this._issueEvidenceToken
    const count = this.data.issueScopeCount || 1
    if (count > 1) {
      const choice = await new Promise(resolve => wx.showModal({ title: '确认处理范围',
        content: '此操作将处理当前组的 ' + count + ' 笔记录。单笔修改请从对应记录进入。', confirmText: '确认处理', success: resolve }))
      if (!choice.confirm || !issueCurrent(this, token) || this.data.currentIssue !== issue || this.data.busy) return
    }
    try {
      this._draftSession.enqueue([this.reviewDraftEntry(issue, decision, extra)])
      this.closeIssue()
    } catch (error) { this.setData({ errorMessage: publicError(error, '选择未保存，请重试') }) }
  },

  readIssue: async function (issueId) {
    const session = this._viewSession
    const details = await session.read('reviewIssues.get', { issueId, memberKind: 'event', pageSize: 8 })
    // get 已含首成员页，沿用相同版本及游标缓存，不再发一遍 members。
    session.seed('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 },
      { protocolVersion: details.protocolVersion, viewVersion: details.viewVersion, items: details.members,
        total: details.total, nextCursor: details.nextCursor })
    let members = details.subject ? [{ objectId: details.subject.eventId, objectType: 'event', event: editorPreview(details.subject) }] : details.members.slice(0, 1)
    if (bankChannelCandidate(details.issue)) {
      const seen = new Set()
      members = members.concat(details.members).filter(member => {
        if (!member.event || seen.has(member.event.eventId)) return false
        seen.add(member.event.eventId); return true
      }).slice(0, 8).map(member => Object.assign({}, member, { event: editorPreview(member.event) }))
    }
    return Object.assign({}, details, { members })
  },

  excludeIssueEvents: function () {
    return this.resolveIssue('exclude_events', { selection: { mode: 'all' } })
  },

  selectPrimaryMember: function (event) {
    this.setData({ 'issueDraft.primaryEventId': event.currentTarget.dataset.id })
  },

  changeHistoricalPage: async function (event) {
    const pager = this._historicalPager
    const token = this._issueEvidenceToken
    if (!pager || !issueCurrent(this, token)) return
    const issueId = this.data.currentIssue.issueId
    const previousSelection = this.data.historicalSelection
    const moving = Boolean(direction(event))
    token.historyReady = false
    this.setData({ historicalLoading: true, historicalSelection: moving ? '' : previousSelection, historicalSelectionVerified: false, historicalError: '', issueCanSubmit: false })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._historicalPager || !issueCurrent(this, token)) return
      const candidates = response.items.map(member => {
          const row = member.transaction || { transactionId: member.objectId }
          return Object.assign({}, row, { stale: !member.transaction || Boolean(row.deletedAt) || row.version !== member.objectVersion,
              amountText: model.amountText(row.amountMinor), accountText: [row.sourceAccountName, row.destinationAccountName].filter(Boolean).join(' → ') })
        })
      token.historyReady = true
      const selected = moving ? '' : this.data.historicalSelection || previousSelection
      this.setData({ historicalCandidates: candidates, historicalPage: response.page, historicalSelection: selected,
        historicalSelectionVerified: Boolean(selected && candidates.some(row => row.transactionId === selected && !row.stale)) })
    } catch (error) { if (pager === this._historicalPager && issueCurrent(this, token)) this.setData({ historicalError: errorText(error) }) }
    finally { if (pager === this._historicalPager && issueCurrent(this, token)) { this.setData({ historicalLoading: false }); this.updateIssueReadiness() } }
  },

  selectHistoricalTransaction: function (event) {
    if (this.data.busy || this.data.historicalLoading) return
    const row = this.data.historicalCandidates.find(item => item.transactionId === event.currentTarget.dataset.id && !item.stale)
    if (row) this.setData({ historicalSelection: row.transactionId, historicalSelectionVerified: true })
  },

  linkHistoricalTransaction: function () {
    if (!this.data.currentIssue || !this.data.currentIssue.historicalDuplicate || !this.data.historicalSelection || this.data.historicalLoading || this.data.historicalError ||
      !this.data.historicalCandidates.some(row => row.transactionId === this.data.historicalSelection && !row.stale)) return
    return this.resolveIssue('link_existing_transaction', { transactionId: this.data.historicalSelection })
  },

  refreshHistoricalReview: async function () {
    if (this.data.busy || !this.data.update) return
    const updateId = this.data.update.updateId
    this.closeIssue()
    await this.loadUpdate(updateId, false)
  },

  changeIssueMembers: async function (event) {
    const pager = this._memberPager
    const token = this._issueEvidenceToken
    if (!pager || !issueCurrent(this, token)) return
    this.closeInlineEvidence('issue')
    token.membersReady = false
    this.setData({ issueEvidenceLoading: true, issueMembersError: '', issueCanSubmit: false })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._memberPager || !issueCurrent(this, token)) return
      this._issueEvidenceRecords = response.items.filter(member => member.event).map(member => Object.assign({}, presentation.record(member.event), { evidence: [], evidenceLoading: true }))
      token.membersReady = true
      this.setData({ issueVisibleEvents: this._issueEvidenceRecords, issueEvidenceTotal: response.total, issueEvidenceLoading: false,
          issueEvidenceHasMore: false, memberPage: response.page })
      this.updateIssueReadiness()
      const complete = await this.loadInlineEvidence('issue', this._issueEvidenceRecords)
      if (complete && pager === this._memberPager && issueCurrent(this, token)) markIssue(this, token, 'review_evidence', !this._issueEvidenceRecords.some(row => row.evidenceError))
    } catch (error) { if (pager === this._memberPager && issueCurrent(this, token)) this.setData({ issueEvidenceLoading: false, issueMembersError: errorText(error), issueCanSubmit: false }) }
  },

  changeIssueRelations: async function (event) {
    const pager = this._relationPager
    const token = this._issueEvidenceToken
    if (!pager || !issueCurrent(this, token)) return
    token.relationsReady = false
    this.setData({ issueRelationsLoading: true, issueRelationsError: '', issueCanSubmit: false })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._relationPager || !issueCurrent(this, token)) return
      token.relationsReady = true
      token.relationMembers = response.items.filter(member => member.relation)
      const choices = token.relationMembers.map(member => model.relationChoiceView(editorPreview(member.relation.targetEvent), member.relation))
      const patch = { issueRelations: choices, relationPage: response.page, issueRelationsLoading: false }
      if (token.initialized && !this.data.issueDraft.targetEventId && choices.length === 1 && response.total === 1) patch['issueDraft.targetEventId'] = choices[0].targetEventId
      this.setData(patch); this.updateIssueReadiness()
    } catch (error) { if (pager === this._relationPager && issueCurrent(this, token)) this.setData({ issueRelationsLoading: false, issueRelationsError: errorText(error), issueCanSubmit: false }) }
  },

  closeInlineEvidence: function (scope) {
    const key = scope === 'issue' ? '_issueInlineEvidence' : '_accountInlineEvidence'
    if (this[key]) this[key].close()
    this[key] = null
  },

  loadInlineEvidence: function (scope, records) {
    this.closeInlineEvidence(scope)
    const key = scope === 'issue' ? '_issueInlineEvidence' : '_accountInlineEvidence'
    const path = scope === 'issue' ? 'issueVisibleEvents' : 'accountRecordsSheet.records'
    const session = this._viewSession
    const active = () => this._viewActive && this._viewSession === session && this[key] === reader &&
    Boolean(scope === 'issue' ? this.data.currentIssue : this.data.accountRecordsSheet)
    const reader = inlineEvidence.create(session, records, active, (index, patch) => {
        Object.assign(records[index], patch)
        return new Promise(resolve => this.setData({ [path + '[' + index + ']']: records[index] }, resolve))
      })
    this[key] = reader
    return reader.loadAll().then(() => active())
  },

  changeInlineSource: function (event) {
    const scope = event.currentTarget.dataset.scope
    const reader = scope === 'account' ? this._accountInlineEvidence : this._issueInlineEvidence
    if (reader) return reader.change(event.currentTarget.dataset.id, direction(event))
  },

  retryIssueRecordEvidence: function (event) {
    if (this._issueInlineEvidence) return this._issueInlineEvidence.change(event.currentTarget.dataset.id, 0)
  },

  retryAccountRecordEvidence: function (event) {
    if (this._accountInlineEvidence) return this._accountInlineEvidence.change(event.currentTarget.dataset.id, 0)
  },

  openEvidence: async function (event) {
    const eventId = event.currentTarget.dataset.id
    if (!eventId || !this._viewActive || !this._viewSession || !this._viewSession.active) return
    const evidenceId = event.currentTarget.dataset.evidenceId
    let sourcePager
    if (evidenceId) {
      sourcePager = this.reviewDetailSourcePager(eventId, evidenceId)
      for (const reader of [this._issueInlineEvidence, this._accountInlineEvidence, this._pairingInlineEvidence]) {
        if (reader) sourcePager = sourcePager || reader.sourcePager(eventId, evidenceId)
      }
      if (!sourcePager) return
    }
    for (const key of ['_evidencePager', '_detailPager']) { if (this[key]) this[key].cancel(); this[key] = null }
    const session = this._viewSession
    const token = this._evidenceReadToken = { session, eventId, version: session.summary.viewVersion, scope: readCache.getSession() }
    this._evidencePager = sourcePager || session.pager('economicEvents.evidence', { eventId, pageSize: 1 })
    const row = (this.businessData().events || []).find(e=>e.eventId === eventId)
    this.setData({ evidenceSheet: { eventId, evidence: [], loading: true,
      installmentNote: row && model.eventView(row).installmentNote || '', error: '', part: '', partFields: [], partLoading: false, partError: '' } })
    await this.changeEvidencePage({ currentTarget: { dataset: {} } })
    if (evidenceCurrent(this, token) && !row && this.data.update.status === 'review') {
      try {
        const detail = await session.read('economicEvents.list', { eventId, pageSize: 1 }, () => evidenceCurrent(this, token))
        if (!evidenceCurrent(this, token)) return
        const found = detail.items[0]
        this.setData({
          'evidenceSheet.installmentNote': found && model.eventView(found).installmentNote || '' })
      } catch(error) { if (evidenceCurrent(this, token)) this.setData({ errorMessage:errorText(error) }) }
    }
  },

  changeEvidencePage: async function (event) {
    const pager = this._evidencePager, token = this._evidenceReadToken
    if (!pager || !evidenceCurrent(this, token)) return
    const request = this._evidencePageToken = {}
    const current = () => evidenceCurrent(this, token) && this._evidencePageToken === request && this._evidencePager === pager
    if (this._detailPager) this._detailPager.cancel()
    this._detailPager = null
    this.setData({ 'evidenceSheet.loading': true, 'evidenceSheet.error': '', 'evidenceSheet.evidence': [],
      'evidenceSheet.part': '', 'evidenceSheet.partFields': [], 'evidenceSheet.partPage': null,
      'evidenceSheet.partLoading': false, 'evidenceSheet.partError': '' })
    try {
      const response = await pager.load(direction(event))
      if (!current()) return
      this.setData({ 'evidenceSheet.evidence': response.items, 'evidenceSheet.page': response.page, 'evidenceSheet.loading': false })
      if (response.items[0]) await this.openEvidencePart({ currentTarget: { dataset: { id: response.items[0].evidenceId } } })
    } catch (error) { if (current()) this.setData({ 'evidenceSheet.loading': false, 'evidenceSheet.error': errorText(error) }) }
  },

  openEvidencePart: async function (event) {
    const token = this._evidenceReadToken, evidenceId = event.currentTarget.dataset.id
    if (!evidenceCurrent(this, token) || !this.data.evidenceSheet.evidence.some(source => source.evidenceId === evidenceId)) return
    if (this._detailPager) this._detailPager.cancel()
    this._detailPager = token.session.pager('economicEvents.detail', { eventId: token.eventId, evidenceId })
    return this.changeEvidencePart({ currentTarget: { dataset: {} } })
  },

  changeEvidencePart: async function (event) {
    const pager = this._detailPager, token = this._evidenceReadToken
    if (!pager || !evidenceCurrent(this, token)) return
    const request = this._evidencePartToken = {}
    const current = () => evidenceCurrent(this, token) && this._evidencePartToken === request && this._detailPager === pager
    this.setData({ 'evidenceSheet.partLoading': true, 'evidenceSheet.partError': '', 'evidenceSheet.part': '', 'evidenceSheet.partFields': [] })
    try {
      const response = await pager.load(direction(event))
      if (!current()) return
      this.setData({ 'evidenceSheet.part': response.part, 'evidenceSheet.partPage': response.page,
          'evidenceSheet.partFields': presentation.evidencePartFields(response.part, response.page), 'evidenceSheet.partLoading': false })
    } catch (error) { if (current()) this.setData({ 'evidenceSheet.partLoading': false, 'evidenceSheet.partError': errorText(error) }) }
  }
}
