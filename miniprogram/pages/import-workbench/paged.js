const { errorText, direction } = require('./presentation')
const api = require('../../services/catledger-import')
const ledgerApi = require('../../services/catledger-api')
const viewSession = require('../../services/import-view-session')
const drafts = require('../../services/import-draft-session')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const inlineEvidence = require('./inline-evidence')
const { buildFinalDetail, TITLES: FINAL_DETAIL_TITLES } = require('./final-detail')






function enhance(definition) {
  const original = Object.assign({}, definition)
  const result = Object.assign({}, definition, {
applyUpdateView(view, background, restoreToFirstStep, quiet) {
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
          const session = this._draftSession = drafts.open(view)
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
stepPatch(step) {
      if ([2, 3].includes(step)) return {}
      const patch = presentation.emptyLists()
      if (step === 4 && this._viewSession) Object.assign(patch, { finalSummary: this._viewSession.summary.workbench.finalSummary,
        fundsFlowGroups: this._viewSession.summary.workbench.fundsFlowGroups })
      return patch
    },
setStep(patch) { setChangedData(this, Object.assign({}, this.stepPatch(patch.currentStep), patch)); return this.loadActivePage(true) },
renderReview(reset) { return this.loadActivePage(reset) },
loadDuplicateRecords() { return this.loadActivePage(true) },
async loadActivePage(reset, direction, quiet) {
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
changeReviewPage(event) { return this.loadActivePage(false, event.currentTarget.dataset.direction === 'first' ? 'first' : Number(event.currentTarget.dataset.direction)) },
async retryPagedView() {
      const epoch = this._viewEpoch
      this.setData({ pageLoading: true })
      try { const summary = await api.readSummary(this.data.update.updateId); if (this._viewActive && epoch === this._viewEpoch) { this._mainPager = null; this.applyUpdateView(summary, true); await this.loadActivePage(true) } }
      catch (error) { if (this._viewActive && epoch === this._viewEpoch) this.setData({ pageError: errorText(error) }) }
      finally { if (this._viewActive && epoch === this._viewEpoch) this.setData({ pageLoading: false }) }
    },
async openFinalDetail(event) {
      const kind = event.currentTarget.dataset.kind
      const accountId = event.currentTarget.dataset.id
      const filter = { status: 'ready' }
      let action = 'economicEvents.list'
      if (['new_accounts', 'affected_accounts'].includes(kind)) { action = 'financeUpdates.options'; filter.kind = kind; delete filter.status }
      else if (kind === 'account') filter.accountId = accountId
      else if (['categorized', 'uncategorized', 'no_category'].includes(kind)) filter.view = { categorized: 'category_completed', uncategorized: 'category_pending', no_category: 'category_none' }[kind]
      else if (kind === 'expense') filter.view = 'expense'
      else if (kind !== 'all') filter.economicNature = kind
      this._finalKind = { kind, accountId }
      this._finalPager = this._viewSession.pager(action, filter)
      const title = kind === 'account'
        ? ((this.businessData().accounts || []).concat(this.businessData().accountDrafts || [])
          .find(account => account.accountId === accountId) || {}).name || FINAL_DETAIL_TITLES.account
        : FINAL_DETAIL_TITLES[kind]
      this.setData({ finalDetailSheet: { kind, title: title || FINAL_DETAIL_TITLES.all, count: 0, records: [], accounts: [], loading: true }, finalDetailParent: null })
      return this.changeFinalPage(event)
    },
async changeFinalPage(event) {
      const pager = this._finalPager, target = this._finalKind
      try {
        const response = await pager.load(direction(event))
        if (pager !== this._finalPager || !this.data.finalDetailSheet) return
        let sheet
        if (['new_accounts', 'affected_accounts'].includes(target.kind)) sheet = { kind: target.kind, title: target.kind === 'new_accounts' ? '新建账户' : '受影响账户', mode: 'accounts', accounts: response.items, records: [] }
        else sheet = buildFinalDetail(target.kind, Object.assign({}, this.businessData(), { events: response.items }), target.accountId)
        this._finalDetail = null
        this.setData({ finalDetailSheet: Object.assign({}, sheet, { count: response.total, records: (sheet.records || []).map(presentation.record), page: response.page, loading: false }), finalDetailScrollTop: 0 })
      } catch (error) { if (pager === this._finalPager) this.setData({ 'finalDetailSheet.loading': false, errorMessage: errorText(error) }) }
    },
openFinalAccount(event) { return this.openFinalDetail({ currentTarget: { dataset: { kind: 'account', id: event.currentTarget.dataset.id } } }) },
async postUpdate() {
      if (this.data.busy || !this._draftSession) return
      const session = this._draftSession
      const operation = this._postOperation = { epoch: this._viewEpoch }
      const active = () => this._viewActive && this._viewEpoch === operation.epoch && this._postOperation === operation
      this.setData({ busy: true, errorMessage: '' })
      try {
        if (!session.state.postFlight) {
          await session.flush()
          if (!active()) return
          this.applyUpdateView(session.view, true)
          if (!session.view.coverage.selectedEventsReadyToPost) { this.setData({ errorMessage: '请完成剩余核对后再入账' }); return }
        }
        this.setData({ busy: true })
        const receipt = await session.post()
        if (!active()) return
        if (this._unsubscribeDraft) this._unsubscribeDraft()
        session.clear(); drafts.forgetLast(); this._draftSession = null
        this.applyUpdateView(receipt)
        try {
          const summary = await api.readSummary(receipt.update.updateId)
          if (active()) this.applyUpdateView(summary)
        } catch (error) { /* 已入账状态保留，用户可独立刷新。 */ }
      } catch (error) {
        if (active() && error.code === 'HISTORY_REVIEW_REQUIRED') {
          await this.loadUpdate(session.view.update.updateId, false)
          if (active() && this.data.phase !== 'error') this.setStep({ currentStep: 3, errorMessage: errorText(error) })
        } else if (active()) this.setData({ errorMessage: errorText(error) })
      }
      finally { if (active()) this.setData({ busy: false }) }
    }
})
  for (const [method, keys] of Object.entries({ closeFinalDetail: ['_finalPager'] })) {
    result[method] = function () {
      if (this.data.busy && ['closeIssue', 'closeAccountRecords'].includes(method)) return
      if (method === 'closeIssue') this.closeInlineEvidence('issue')
      if (method === 'closeAccountRecords') this.closeInlineEvidence('account')
      keys.forEach(key => { if (this[key]) this[key].cancel(); this[key] = null })
      original[method].call(this)
      if (this._pendingBackgroundView && !this.data.currentIssue && !this.data.accountChoiceSheet) {
        const view = this._pendingBackgroundView; this._pendingBackgroundView = null; this.applyUpdateView(view, true)
      }
    }
  }
  result.startAnother = function () { this.cancelPagedReads(); if (this._viewSession) this._viewSession.close(); this._viewSession = null; return original.startAnother.call(this) }
  return result
}


function compactMapping(mapping) { const { choiceOptions, evidencePreview, ...visible } = presentation.accountMapping(mapping); return Object.assign(visible, { evidencePreview: Boolean(evidencePreview) }) }
module.exports = { enhance }
