const { publicError, errorText } = require('./presentation')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const draftSessions = require('../../services/import-draft-session')
const api = require('../../services/catledger-import')
const ledgerApi = require('../../services/catledger-api')
const viewSession = require('../../services/import-view-session')
const loginGuard = require('../../services/login-guard')
const themeService = require('../../theme/service')

const bytes = value => unescape(encodeURIComponent(JSON.stringify(value))).length
const commandActions = new Set(['financeUpdates.prepare', 'financeUpdates.organize', 'financeUpdates.post', 'financeUpdates.abandon', 'financeUpdates.setRepayment',
    'reviewIssues.refreshAccountGroups', 'reviewIssues.resolveAccountMappings', 'reviewIssues.resolve'])

function boundedSetData(page) {
  const send = page.setData.bind(page)
  page.setData = function (patch, callback) {
    let part = {}, size = 2
    const chunks = []
    for (const key of Object.keys(patch)) {
      const entry = { [key]: patch[key] }, next = bytes(entry)
      if (next > 64 * 1024) throw new Error('当前展示项超过预算，请通过详情分页查看')
      if (size + next > 60 * 1024) { chunks.push(part); part = {}; size = 2 }
      part[key] = patch[key]; size += next
    }
    if (Object.keys(part).length) chunks.push(part)
    chunks.forEach((chunk, index) => send(chunk, index === chunks.length - 1 ? callback : undefined))
  }
}

function compactMapping(mapping) { const { choiceOptions, evidencePreview, ...visible } = presentation.accountMapping(mapping); return Object.assign(visible, { evidencePreview: Boolean(evidencePreview) }) }

async function resumeInitialLoad(page) {
  const initial = page._pendingInitialLoad
  if (!initial || !initial.visible || initial.attempt || !getApp().hasLoginApproval()) return
  page._viewActive = true
  if (!initial.updateId) { page._pendingInitialLoad = null; return }
  const attempt = initial.attempt = {}
  const loaded = await page.loadUpdate(initial.updateId, true)
  if (page._pendingInitialLoad !== initial || initial.attempt !== attempt || !initial.visible) return
  initial.attempt = null
  if (!loaded) return
  page._pendingInitialLoad = null
  if (initial.eventId) await page.openEvidence({ currentTarget: { dataset: { id: initial.eventId } } })
}

module.exports = {
  applyPendingBackgroundView() {
    if (this._pendingBackgroundView && !this.data.currentIssue && !this.data.accountChoiceSheet) {
      const view = this._pendingBackgroundView; this._pendingBackgroundView = null; this.applyUpdateView(view, true)
    }
  },
  onLoad(options) {
    boundedSetData(this)
    this._viewEpoch = 0
    this._viewActive = true
    this.setData({ pageLoading: false, pageError: '', directoryPage: null })
    themeService.bindPage(this)
    this._requestIds = {}
    this._sourceFiles = new Map()
    this._accountUiDrafts = new Map()
    const updateId = options && options.fresh === '1' ? null : options && options.updateId || draftSessions.lastUpdateId()
    this._pendingInitialLoad = { updateId, eventId: options && options.evidenceEventId, visible: true, attempt: null }
    loginGuard.run(this, () => resumeInitialLoad(this))
  },
  onShow(initialData) {
    if (this._pendingInitialLoad) this._pendingInitialLoad.visible = true
    if (!getApp().hasLoginApproval()) {
      this._viewActive = false; this._viewEpoch++
      this.cancelPagedReads()
      if (this._viewSession) this._viewSession.close()
      if (this._unsubscribeDraft) this._unsubscribeDraft()
      this._unsubscribeDraft = null
      this._viewSession = null; this._businessData = null; this._draftSession = null
      this.setData(JSON.parse(JSON.stringify(initialData)))
      return
    }
    const returning = this._viewActive === false
    this._viewActive = true
    themeService.bindPage(this)
    const revision = getApp().globalData.ledgerRevision || 0
    if (this._pendingInitialLoad) {
      this._ledgerRevision = revision
      return resumeInitialLoad(this)
    }
    if (this._ledgerRevision != null && this._ledgerRevision !== revision && this.data.update) {
      if (this._draftSession) this._draftSession.flush().catch(function () {})
      else this.loadUpdate(this.data.update.updateId)
    }
    this._ledgerRevision = revision
    if (returning && this.data.update) return this.loadUpdate(this.data.update.updateId)
  },
  onHide() {
    if (this._pendingInitialLoad) {
      this._pendingInitialLoad.visible = false
      this._pendingInitialLoad.attempt = null
    }
    this._viewActive = false; this._viewEpoch++
    this.cancelPagedReads()
    this.setData({ currentIssue: null, currentMembers: [], issueEvents: [], issueRelations: [], issueVisibleEvents: [],
        evidenceSheet: null, accountRecordsSheet: null, finalDetailSheet: null, accountChoiceSheet: null, directorySheet: null, busy: false })
    this.finishInputEditing()
  },
  onUnload() {
    this._pendingInitialLoad = null
    this._viewActive = false; this._viewEpoch++
    this.cancelPagedReads()
    if (this._viewSession) this._viewSession.close()
    this._viewSession = null; this._businessData = null; this._draftSession = null
    this._evidenceReadToken = null
    this._editingInput = ''
    this._pendingBackgroundView = null
    if (this._updateLoad) this._updateLoad.cancelled = true
    if (this._unsubscribeDraft) this._unsubscribeDraft()
    this._unsubscribeDraft = null
    this._duplicateLoadToken = null
    this._issueEvidenceToken = null
    this._issueEvidenceRecords = []
    this._accountEvidenceToken = null
    this._accountRecordList = []
    this.clearFileProgressThrottle()
    if (this._accountDraftTimer) {
      clearTimeout(this._accountDraftTimer)
      this._accountDraftTimer = null
      this.persistAccountDrafts()
    }
  },
  cancelPagedReads() {
    this.closeInlineEvidence('issue')
    this.closeInlineEvidence('account')
    for (const key of ['_mainPager', '_memberPager', '_relationPager', '_historicalPager', '_accountPager', '_evidencePager', '_detailPager', '_finalPager', '_directoryPager', '_optionPager']) {
      if (this[key]) this[key].cancel()
      this[key] = null
    }
    this._issueEvidenceToken = null; this._accountEvidenceToken = null; this._evidenceReadToken = null
    this._issueEvidenceRecords = []; this._accountRecordList = []; this._finalDetail = null
  },
  async request(action, data) {
    if (action === 'financeUpdates.summary') return api.readSummary(data.updateId)
    if (commandActions.has(action)) {
      const input = Object.assign({}, data)
      if (action === 'reviewIssues.resolveAccountMappings') {
        input.updateVersion = this.data.update.version
        input.decisions = input.decisions.map(decision => Object.assign({}, decision, { issueVersion: decision.issueVersion ||
              (this.businessData().issues.find(issue => issue.issueId === decision.issueId) || {}).version }))
      }
      const receipt = await api.command(action, input)
      if (action === 'financeUpdates.post' || action === 'financeUpdates.abandon') return receipt
      try { return await api.readSummary(receipt.update.updateId) }
      catch (error) { return Object.assign({}, receipt, { refreshRequired: true }) }
    }
    if (action === 'reviewIssues.get') return this.readIssue(data.issueId)
    return api.callImport(action, data)
  },
  businessData: function () {
    return this._businessData || this.data
  },

  createFinanceUpdate: async function () {
    if (this.data.busy) return
    if (this.data.update && this.data.update.updateId) {
      await this.loadUpdate(this.data.update.updateId)
      return
    }
    const batchIds = this.data.files.filter(function (file) { return file.state === 'ready' && file.batchId })
    .map(function (file) { return file.batchId })
    if (batchIds.length === 0) {
      this.setData({ errorMessage: '至少需要一个解析成功的账单文件' })
      return
    }
    this.setData({ phase: 'organizing', busy: true, errorMessage: '' })
    try {
      let view = await this.request('financeUpdates.prepare', {
          requestId: api.createRequestId(), batchIds: batchIds
        })
      view = await this.refreshAccountGroups(view)
      this.applyUpdateView(view)
    } catch (error) {
      this.setData({ phase: 'files_ready', busy: false, errorMessage: publicError(error, '跨来源整理失败') })
    }
  },

  refreshAccountGroups: async function (view) {
    if (view.update.status !== 'review' || view.freshness && view.freshness.requiresAccountGroupRefresh === false) return view
    return this.request('reviewIssues.refreshAccountGroups', { requestId: api.createRequestId(),
        updateId: view.update.updateId, version: view.update.version })
  },

  loadUpdate: async function (updateId, restoreToFirstStep) {
    const load = { updateId: updateId, cancelled: false, pending: null }
    this._updateLoad = load
    const epoch = this._viewEpoch
    const active = () => this._viewActive !== false && this._viewEpoch === epoch && this._updateLoad === load && !load.cancelled
    this.setData({ phase: 'loading', busy: true, errorMessage: '', restoreUpdateId: restoreToFirstStep ? updateId : '', abandoningRestore: false })
    try {
      load.pending = this.request('financeUpdates.summary', { updateId: updateId })
      let view = await load.pending
      if (!active()) return
      if (view.update.status === 'review') {
        load.pending = this.request('financeUpdates.organize', {
            requestId: api.createRequestId(), updateId: updateId, version: view.update.version
          })
        view = await load.pending
        if (!active()) return
      }
      load.pending = this.refreshAccountGroups(view)
      view = await load.pending
      if (!active()) return
      this.setData({ restoreUpdateId: '' })
      this.applyUpdateView(view, false, restoreToFirstStep)
      return true
    } catch (error) {
      if (!active()) return
      this.setData({ phase: 'error', busy: false, errorMessage: publicError(error, '整理结果加载失败') })
    }
  },

  abandonRestoringUpdate: async function () {
    const updateId = this.data.restoreUpdateId
    if (!updateId || this.data.abandoningRestore) return
    const load = this._updateLoad
    if (load) load.cancelled = true
    this.setData({ abandoningRestore: true, busy: true, errorMessage: '' })
    try {
      await draftSessions.pauseUpdate(updateId)
      // 已发送的整理事务必须落定；取消后不再发起下一段恢复。
      if (load && load.pending) await load.pending.catch(function () {})
      const view = await this.request('financeUpdates.summary', { updateId: updateId })
      if (view.update.status === 'posted') {
        this.setData({ restoreUpdateId: '', abandoningRestore: false })
        this.applyUpdateView(view)
        return
      }
      if (view.update.status !== 'abandoned') {
        if (!this._restoreAbandonRequest || this._restoreAbandonRequest.updateId !== updateId || this._restoreAbandonRequest.version !== view.update.version) {
          this._restoreAbandonRequest = { requestId: api.createRequestId(), updateId: updateId, version: view.update.version }
        }
        await this.request('financeUpdates.abandon', this._restoreAbandonRequest)
      }
      draftSessions.clearUpdate(updateId)
      this.startAnother()
    } catch (error) {
      this.setData({ busy: false, abandoningRestore: false, errorMessage: publicError(error, '放弃失败，上次导入已保留，请重试') })
    }
  },

  preventTouchMove: function () {

  },

  retryDraftSync: async function () {
    if (!this._draftSession || this.data.busy) return
    try { await this._draftSession.retry() } catch (error) { this.setData({ errorMessage: publicError(error, '同步未完成，选择已保留') }) }
  },

  finishDraftStep: async function (step) {
    if (this.data.busy || !this._draftSession) return
    if (this.data.accountStepSummary.pending > 0 || (step === 4 && this.data.reviewStatusTabs[0].count > 0)) return
    this.setData({ busy: true, errorMessage: '' })
    try {
      const session = this._draftSession
      await session.flush()
      const checked = await this.request('financeUpdates.organize', { requestId: api.createRequestId(),
          updateId: session.view.update.updateId, version: session.view.update.version })
      this.applyUpdateView(checked, true)
      if (this.data.accountStepSummary.pending > 0 || (step === 4 && (this.data.openIssueCount || !this.data.coverage.selectedEventsReadyToPost))) {
        this.setStep({ currentStep: this.data.accountStepSummary.pending ? 2 : 3,
            errorMessage: '整理结果已更新，请完成剩余核对后继续' })
        return
      }
      this.setStep({ currentStep: step })
      this.persistAccountDrafts()
    } catch (error) { this.setData({ errorMessage: publicError(error, '自动保存未完成，选择已保留，请重试') }) }
    finally { this.setData({ busy: false }) }
  },

  goToStep: async function (event) {
    if (this.data.busy || this.data.accountStepBusy) return
    const step = Number(event.currentTarget.dataset.step)
    if (!Number.isInteger(step) || step < 1 || step > this.data.unlockedStep) return
    if (step > 2) return this.finishDraftStep(step)
    this.setStep({ currentStep: step, errorMessage: '', accountChoiceSheet: null })
    this.persistAccountDrafts()
  },

  beginInputEditing: function (event) {
    this._editingInput = event.currentTarget.dataset.inputKey
  },

  finishInputEditing: function () {
    this._editingInput = ''
    this.flushAccountDraftSync()
    const pending = this._pendingBackgroundView
    this._pendingBackgroundView = null
    if (pending && this.data.update && pending.update.updateId === this.data.update.updateId) this.applyUpdateView(pending, true)
  },

  startAnother: function () {
    this.cancelPagedReads(); if (this._viewSession) this._viewSession.close(); this._viewSession = null
    this._businessData = null
    this._reviewProjection = null
    this._reviewPage = 0
    this._evidenceReadToken = null
    if (this._updateLoad) this._updateLoad.cancelled = true
    this._restoreAbandonRequest = null
    if (this._unsubscribeDraft) this._unsubscribeDraft()
    if (this._draftSession) this._draftSession.clear()
    this._draftSession = null
    this._unsubscribeDraft = null
    this._postingRequestId = null
    if (draftSessions.forgetLast) draftSessions.forgetLast()
    this._sourceFiles.clear()
    if (this._bankPreviews) this._bankPreviews.clear()
    this._duplicateLoadToken = null
    this.setData({
        phase: 'idle', currentStep: 1, unlockedStep: 1, busy: false, restoreUpdateId: '', abandoningRestore: false,
        files: [], bankMappingSheet: null, fileAttentionSheet: null, update: null, sources: [], events: [], issues: [], fundsFlowGroups: [], finalDetailSheet: null, finalDetailParent: null,
        recordSummary: { totalCount: 0, activeCount: 0, excludedCount: 0, duplicateCount: 0 },
        reviewedEvents: [], categoryWaitingEvents: [], noCategoryEvents: [],
        accountIssues: [], reviewIssues: [], reviewGroups: [], verificationIssues: [], categoryIssues: [], categoryCards: [], categoryQuery: '', categoryEventCount: 0, categorizedEvents: [], categorizedEventCount: 0, activeCategoryStatus: 'pending', categoryStatusTabs: model.organizerRecordState([], [], []).categoryStatusTabs, activeReviewTab: 'review', activeReviewStatus: 'pending', excludedReviewGroups: [], duplicateReviewEvents: [], openIssueCount: 0,
        duplicateReviewCandidates: [], duplicateReviewLoading: false, duplicateReviewLoaded: false, duplicateReviewError: '',
        coverage: {
          dataRows: 0, recognizedRows: 0, unrecognizedRows: 0,
          selectedEvents: 0, readySelectedEvents: 0, pendingSelectedEvents: 0, excludedEvents: 0,
          statementFullyRecognized: false, selectedEventsReadyToPost: false
        },
        reviewStatusTabs: [
          { value: 'pending', label: '待核对', count: 0 },
          { value: 'completed', label: '已核对', count: 0 },
          { value: 'excluded', label: '已排除', count: 0 },
          { value: 'duplicate', label: '重复', count: 0 }
        ],
        accountMappings: [], accountStepSummary: { total: 0, ready: 0, confirmed: 0, invalid: 0, create: 0, inline: 0, transfer: 0, open: 0, dirty: 0, pending: 0 },
        accountStepBusy: false, accountStepError: '', accountStepProgressText: '',
        accounts: [], accountDrafts: [], accountMappingDrafts: [], accountChoices: [{ accountId: '', name: '新建账户' }],
        accountChoiceSheet: null, accountChoiceQuery: '', accountChoiceResults: [], categories: [], issueCategories: [],
        uploadSummary: { total: 0, queued: 0, ready: 0, failed: 0, mapping: 0, duplicate: 0, attention: 0 },
        posting: null, errorMessage: '', currentIssue: null, currentMembers: [],
        issueEvents: [], issueRelations: [], evidenceSheet: null,
        repaymentAllocationChoices: [], repaymentAllocationStatusText: '', repaymentAllocationCanSave: false
      })
    this._accountUiDrafts.clear()
  },

  applyUpdateView: function (view, background, restoreToFirstStep, quiet) {
    if (!this._viewActive) return
    if (!view.workbench) {
      // 操作事实先显示；明细读取失败不抹掉已保存/已入账结果。
      this.setData({ update: view.update, posting: view.posting || this.data.posting,
          phase: view.update.status === 'posted' ? 'done' : 'review', busy: false,
          errorMessage: view.update.status === 'posted' ? '已入账，明细待刷新' : '操作已保存，明细待刷新', refreshRequired: true })
      return
    }
    if (background && (this._editingInput || this.data.currentIssue || this.data.accountChoiceSheet)) { this._pendingBackgroundView = view; return }
    const same = this._viewSession && this._viewSession.summary.update.updateId === view.update.updateId
    const changed = !same || this._viewSession.summary.viewVersion !== view.viewVersion
    if (!same) { if (this._viewSession) this._viewSession.close(); this._viewSession = viewSession.create(api.callImport, view) }
    else this._viewSession.accept(view)
    if (changed) { this._mainPager = null; this._businessData = null }
    const workbench = view.workbench
    const open = view.coverage.openBlockingIssues
    const workflow = view.update.status !== 'review' ? 4 : workbench.accountStepSummary.pending ? 2 : workbench.reviewStatusTabs[0].count ? 3 : 4
    const current = this.data.currentStep
    const step = view.update.status !== 'review' ? 4 : restoreToFirstStep ? 1
    : background || (same && current >= 1 && current <= workflow) ? current : workflow
    const patch = Object.assign({}, workbench, { update: view.update, sources: view.sources.map(source => ({ sourceId: source.sourceId,
              fileName: source.fileName, sourceType: source.sourceType, summary: source.summary })), coverage: view.coverage, posting: view.posting,
        phase: { posted: 'done', undone: 'undone', abandoned: 'abandoned' }[view.update.status] || 'review',
        currentStep: step, unlockedStep: workflow, openIssueCount: open, busy: false, errorMessage: '', refreshRequired: false })
    if (step !== 4) { patch.finalSummary = {}; patch.fundsFlowGroups = [] }
    setChangedData(this, patch)
    if (view.update.status === 'posted' && view.sources.some(source=>source.sourceType==='bank')) {
      const key=view.update.updateId+':'+view.viewVersion
      if(this._installmentPendingKey!==key){
        this._installmentPendingKey=key;this.setData({pendingInstallments:false})
        ledgerApi.callApi('loans.installmentSources',{pageSize:1},{force:true}).then(result=>{if(this._viewActive && this._installmentPendingKey===key)this.setData({pendingInstallments:result.items.length>0})}).catch(()=>{})
      }
    } else {this._installmentPendingKey=null;this.setData({pendingInstallments:false})}
    if (view.update.status === 'review') {
      if (!this._draftSession || this._draftSession.view.update.updateId !== view.update.updateId) {
        if (this._unsubscribeDraft) this._unsubscribeDraft()
        const session = this._draftSession = draftSessions.open(view)
        this._accountUiDrafts = new Map(Object.entries(session.state.drafts))
        this._unsubscribeDraft = session.subscribe(() => {
            if (!this._viewActive || this._draftSession !== session) return
            setChangedData(this, { draftSync: session.status })
            if (this._viewSession.summary.viewVersion !== session.view.viewVersion) this.applyUpdateView(session.view, true, false, true)
          })
      } else this._draftSession.accept(view)
      if (changed) this._accountUiDrafts = new Map(Object.entries(this._draftSession.state.drafts))
      this._draftSession.schedule()
    }
    if (changed || this._loadedStep !== step) this.loadActivePage(true, undefined, quiet)
  },

  stepPatch: function (step) {
    if ([2, 3].includes(step)) return {}
    const patch = presentation.emptyLists()
    if (step === 4 && this._viewSession) Object.assign(patch, { finalSummary: this._viewSession.summary.workbench.finalSummary,
        fundsFlowGroups: this._viewSession.summary.workbench.fundsFlowGroups })
    return patch
  },

  setStep: function (patch) {
    setChangedData(this, Object.assign({}, this.stepPatch(patch.currentStep), patch)); return this.loadActivePage(true)
  },

  renderReview: function (reset) {
    return this.loadActivePage(reset)
  },

  loadDuplicateRecords: function () {
    return this.loadActivePage(true)
  },

  loadActivePage: async function (reset, direction, quiet) {
    if (!this._viewSession || !this._viewActive) return
    const step = this.data.currentStep
    const epoch = ++this._viewEpoch
    this._loadedStep = step
    if (![2, 3].includes(step)) { setChangedData(this, this.stepPatch(step)); return }
    let action = 'reviewIssues.list', filter = {}, kind = 'accountMappings'
    if (step === 2) filter = { group: 'accounts' }
    else if (this.data.activeReviewTab === 'category') {
      const status = this.data.activeCategoryStatus
      if (status === 'pending') { filter = { group: 'category', status: 'open', query: this.data.categoryQuery }; kind = 'categoryCards' }
      else { action = 'economicEvents.list'; filter = { view: 'category_' + status, query: this.data.categoryQuery }; kind = status === 'none' ? 'noCategoryEvents' : 'categorizedEvents' }
    } else if (this.data.activeReviewStatus === 'pending') { filter = { group: 'review', status: 'open' }; kind = 'reviewGroups' }
    else { action = 'economicEvents.list'; const status = this.data.activeReviewStatus
      filter = status === 'completed' ? { view: 'review_completed' } : { status }
      kind = { completed: 'reviewedEvents', excluded: 'excludedReviewGroups', duplicate: 'duplicateReviewEvents' }[status]
    }
    if (reset || !this._mainPager) this._mainPager = this._viewSession.pager(action, filter)
    const pager = this._mainPager
    if (!quiet) this.setData({ pageLoading: true, pageError: '' })
    try {
      const response = await pager.load(direction)
      if (!this._viewActive || epoch !== this._viewEpoch || pager !== this._mainPager) return
      const directory = step === 2 ? await this.loadDirectories(response.items.map(issue => issue.subject).filter(Boolean)) : { accounts: this.data.accounts, categories: this.data.categories, accountDrafts: this.data.accountDrafts }
      if (!this._viewActive || epoch !== this._viewEpoch) return
      const issues = action === 'reviewIssues.list' ? response.items : []
      const events = action === 'economicEvents.list' ? response.items : []
      this._businessData = Object.assign({}, directory, { issues, events, accountIssues: step === 2 ? issues.map(model.issueView) : [], accountMappingDrafts: [] })
      const patch = presentation.emptyLists()
      patch.reviewPage = response.page
      if (step === 2) {
        const visible = new Set(issues.map(issue => issue.issueId))
        for (const [id, draft] of this._accountUiDrafts) if (!visible.has(id) && !draft.dirty && !draft.localConfirmed) this._accountUiDrafts.delete(id)
        Object.assign(patch, directory)
        patch.accountMappings = this.mappingState().mappings.map(compactMapping)
      } else if (kind === 'reviewGroups') patch.reviewGroups = model.reviewIssueGroups(issues).map(group => ({ issueType: group.issueType, issues: group.issues.map(presentation.card) }))
      else if (kind === 'categoryCards') patch.categoryCards = model.categoryIssueCards(issues, '').map(presentation.card)
      else if (kind === 'excludedReviewGroups') patch.excludedReviewGroups = model.excludedEventGroups(events, []).map(group => Object.assign({}, group, { events: [] }))
      else patch[kind] = events.map(event => presentation.record(Object.assign({}, event, { duplicateCount: Number(event.duplicateEvidenceCount || 0) + (model.isHistoricalDuplicate(event) ? 1 : 0),
              auditNote: model.isHistoricalDuplicate(event) ? '已与历史账目对应，本次不重复入账。' : '已保留一笔，点开对照主记录与重复来源。' })))
      if (!quiet) patch.pageLoading = false
      patch.duplicateReviewLoaded = true
      setChangedData(this, patch)
    } catch (error) {
      if (this._viewActive && epoch === this._viewEpoch) this.setData({ pageLoading: false, pageError: errorText(error) })
    }
  },

  changeReviewPage: function (event) {
    return this.loadActivePage(false, event.currentTarget.dataset.direction === 'first' ? 'first' : Number(event.currentTarget.dataset.direction))
  },

  retryPagedView: async function () {
    const epoch = this._viewEpoch
    this.setData({ pageLoading: true })
    try { const summary = await api.readSummary(this.data.update.updateId); if (this._viewActive && epoch === this._viewEpoch) { this._mainPager = null; this.applyUpdateView(summary, true); await this.loadActivePage(true) } }
    catch (error) { if (this._viewActive && epoch === this._viewEpoch) this.setData({ pageError: errorText(error) }) }
    finally { if (this._viewActive && epoch === this._viewEpoch) this.setData({ pageLoading: false }) }
  }
}
