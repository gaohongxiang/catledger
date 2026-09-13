const api = require('../../services/catledger-import')
const viewSession = require('../../services/import-view-session')
const drafts = require('../../services/import-draft-session')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const { buildFinalDetail } = require('./final-detail')
const bytes = value => unescape(encodeURIComponent(JSON.stringify(value))).length
const errorText = error => error.code === 'UNSUPPORTED_ACTION' ? '导入服务版本过旧，请更新云函数后重试'
  : error.code === 'STALE_VIEW' ? '整理结果已变化，请刷新本页' : error.message || '读取未完成，请重试'
const commandActions = new Set(['financeUpdates.prepare', 'financeUpdates.organize', 'financeUpdates.post', 'financeUpdates.abandon',
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

function enhance(definition) {
  const original = Object.assign({}, definition)
  const result = Object.assign({}, definition, {
    onLoad(options) {
      boundedSetData(this)
      this._viewEpoch = 0
      this._viewActive = true
      this.setData({ pagedProtocol: true, pageLoading: false, pageError: '', directoryPage: null })
      return original.onLoad.call(this, options)
    },
    onShow() {
      if (!getApp().hasLoginApproval()) {
        this.cancelPagedReads()
        if (this._viewSession) this._viewSession.close()
        if (this._unsubscribeDraft) this._unsubscribeDraft()
        this._viewSession = null; this._businessData = null; this._draftSession = null
        this.setData(Object.assign({}, JSON.parse(JSON.stringify(original.data)), { pagedProtocol: true }))
        return
      }
      const returning = this._viewActive === false
      this._viewActive = true
      original.onShow.call(this)
      if (returning && this.data.update) return this.loadUpdate(this.data.update.updateId, true)
    },
    onHide() {
      this._viewActive = false; this._viewEpoch++
      this.cancelPagedReads()
      this.setData({ currentIssue: null, currentMembers: [], issueEvents: [], issueRelations: [], issueVisibleEvents: [],
        evidenceSheet: null, accountRecordsSheet: null, finalDetailSheet: null, accountChoiceSheet: null, directorySheet: null, busy: false })
      return original.onHide.call(this)
    },
    onUnload() {
      this._viewActive = false; this._viewEpoch++
      this.cancelPagedReads()
      if (this._viewSession) this._viewSession.close()
      this._viewSession = null; this._businessData = null; this._draftSession = null
      return original.onUnload.call(this)
    },
    cancelPagedReads() {
      for (const key of ['_mainPager', '_memberPager', '_relationPager', '_accountPager', '_evidencePager', '_detailPager', '_finalPager', '_directoryPager', '_optionPager']) {
        if (this[key]) this[key].cancel()
        this[key] = null
      }
      this._issueEvidenceToken = null; this._accountEvidenceToken = null; this._evidenceReadToken = null
      this._issueEvidenceRecords = []; this._accountRecordList = []; this._finalDetail = null
    },
    async request(action, data) {
      if (action === 'financeUpdates.get') return api.readSummary(data.updateId)
      if (commandActions.has(action)) {
        if (action === 'financeUpdates.prepare') {
          const capability = await api.callImport('imports.capabilities', {})
          if (capability.workbenchVersion !== 1) throw Object.assign(new Error('导入服务需更新'), { code: 'UNSUPPORTED_ACTION' })
        }
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
    applyUpdateView(view, background, restoreToFirstStep) {
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
      const step = restoreToFirstStep ? 1 : background || same && [2, 3].includes(this.data.currentStep) ? this.data.currentStep : workflow
      const patch = Object.assign({}, workbench, { update: view.update, sources: view.sources.map(source => ({ sourceId: source.sourceId,
        fileName: source.fileName, sourceType: source.sourceType, summary: source.summary })), coverage: view.coverage, posting: view.posting,
        phase: { posted: 'done', undone: 'undone', abandoned: 'abandoned' }[view.update.status] || 'review',
        currentStep: step, unlockedStep: workflow, openIssueCount: open, busy: false, errorMessage: '', refreshRequired: false })
      if (step !== 4) { patch.finalSummary = {}; patch.fundsFlowGroups = [] }
      setChangedData(this, patch)
      if (view.update.status === 'review') {
        if (!this._draftSession || this._draftSession.view.update.updateId !== view.update.updateId) {
          if (this._unsubscribeDraft) this._unsubscribeDraft()
          const session = this._draftSession = drafts.open(view)
          this._accountUiDrafts = new Map(Object.entries(session.state.drafts))
          this._unsubscribeDraft = session.subscribe(() => {
            if (!this._viewActive || this._draftSession !== session) return
            setChangedData(this, { draftSync: session.status })
            if (this._viewSession.summary.viewVersion !== session.view.viewVersion) this.applyUpdateView(session.view, true)
          })
        } else this._draftSession.accept(view)
        if (changed) this._accountUiDrafts = new Map(Object.entries(this._draftSession.state.drafts))
        this._draftSession.schedule()
      }
      if (changed || this._loadedStep !== step) this.loadActivePage(true)
    },
    businessData() { return this._businessData || { events: [], issues: [], accountIssues: [], accounts: this.data.accounts || [],
      categories: this.data.categories || [], accountDrafts: this.data.accountDrafts || [], accountMappingDrafts: [] } },
    stepPatch(step) {
      const patch = presentation.emptyLists()
      if (step === 4 && this._viewSession) Object.assign(patch, { finalSummary: this._viewSession.summary.workbench.finalSummary,
        fundsFlowGroups: this._viewSession.summary.workbench.fundsFlowGroups })
      return patch
    },
    setStep(patch) { setChangedData(this, Object.assign({}, this.stepPatch(patch.currentStep), patch)); return this.loadActivePage(true) },
    renderReview(reset) { return this.loadActivePage(reset) },
    loadDuplicateRecords() { return this.loadActivePage(true) },
    async loadActivePage(reset, direction) {
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
      this.setData({ pageLoading: true, pageError: '' })
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
        else patch[kind] = events.map(event => presentation.record(Object.assign({}, event, { duplicateCount: event.duplicateEvidenceCount,
          auditNote: '已保留一笔，点开对照主记录与重复来源。' })))
        patch.pageLoading = false; patch.duplicateReviewLoaded = true
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
      catch (error) { if (this._viewActive) this.setData({ pageError: errorText(error) }) }
      finally { if (this._viewActive) this.setData({ pageLoading: false }) }
    },
    async loadDirectories(events = [], extraIds = []) {
      const pairs = await Promise.all(['accounts', 'categories', 'accountDrafts'].map(async kind => {
        const response = await this._viewSession.read('financeUpdates.options', { kind, pageSize: 8 })
        const key = kind === 'categories' ? 'categoryId' : 'accountId'
        const pins = [...new Set((kind === 'categories' ? events.map(event => event.categoryId).filter(Boolean) : events.flatMap(event => model.eventAccountIds(event)
          .concat((event.fundsProjection && event.fundsProjection.to && event.fundsProjection.to.candidates || []).map(row => row.accountId))))
          .concat(extraIds.filter(Boolean)))]
          .filter(id => !response.items.some(item => item[key] === id))
        const extra = pins.length ? (await this._viewSession.read('financeUpdates.options', { kind, ids: pins, pageSize: 100 })).items : []
        return [kind, response.items.concat(extra)]
      }))
      return Object.fromEntries(pairs)
    },
    mappingState() { const data = this.businessData(); return original.buildAccountMappingState.call(this, data.accountIssues, data.accounts, data.accountDrafts, []) },
    refreshAccountMappings() {
      const state = this.mappingState()
      setChangedData(this, { accountMappings: state.mappings.map(compactMapping) })
      return state
    },
    async readIssue(issueId) {
      const session = this._viewSession
      const [details, relations] = await Promise.all([
        session.read('reviewIssues.get', { issueId, memberKind: 'event', pageSize: 8 }),
        session.read('reviewIssues.members', { issueId, memberKind: 'relation', pageSize: 8 })
      ])
      const entry = this._draftSession && this._draftSession.state.entries.find(item => item.issueId === issueId)
      const form = entry && entry.form || {}
      const directory = await this.loadDirectories(details.subject ? [details.subject] : [], [form.accountId, form.counterpartyAccountId, form.categoryId, form.paymentTargetId]
        .concat((form.paymentRows || []).map(row => row.accountId), (form.repaymentAllocationChoices || []).filter(row => !row.isNew).map(row => row.accountId)))
      // 主体单独返回，候选分页不会把被处理对象挤出首页。
      const members = details.subject ? [{ objectId: details.subject.eventId, objectType: 'event', event: editorPreview(details.subject) }] : details.members.slice(0, 1)
      const candidates = relations.items.map(member => member.relation ? Object.assign({}, member, { relation: Object.assign({}, member.relation,
        { targetEvent: editorPreview(member.relation.targetEvent) }) }) : member)
      return Object.assign({}, details, directory, { members: members.concat(candidates), relationPage: relations })
    },
    async openIssue(event) {
      await original.openIssue.call(this, event)
      if (!this.data.currentIssue || !this._viewActive) return
      const issueId = this.data.currentIssue.issueId
      this._memberPager = this._viewSession.pager('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 })
      this._relationPager = this._viewSession.pager('reviewIssues.members', { issueId, memberKind: 'relation', pageSize: 8 })
      await this.changeIssueMembers({ currentTarget: { dataset: {} } })
      await this.changeIssueRelations({ currentTarget: { dataset: {} } })
    },
    excludeIssueEvents() { return this.resolveIssue('exclude_events', { selection: { mode: 'all' } }) },
    selectPrimaryMember(event) { this.setData({ 'issueDraft.primaryEventId': event.currentTarget.dataset.id }) },
    async openAccountChoice(event) {
      original.openAccountChoice.call(this, event)
      if (!this.data.accountChoiceSheet) return
      this.setData({ choiceKind: 'accounts' })
      this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind: 'accounts', pageSize: 12 })
      return this.changeChoicePage(event)
    },
    async bindAccountChoiceSearch(event) {
      if (!this.data.accountChoiceSheet) return
      this.setData({ accountChoiceQuery: event.detail.value })
      this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind: this.data.choiceKind, query: String(event.detail.value).slice(0, 80), pageSize: 12 })
      return this.changeChoicePage(event)
    },
    changeChoiceKind(event) {
      const kind = event.currentTarget.dataset.kind
      if (!['accounts', 'accountDrafts'].includes(kind)) return
      this.setData({ choiceKind: kind, accountChoiceQuery: '' })
      this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind, pageSize: 12 })
      return this.changeChoicePage(event)
    },
    async changeChoicePage(event) {
      const pager = this._directoryPager
      try {
        const response = await pager.load(direction(event))
        if (pager !== this._directoryPager || !this.data.accountChoiceSheet) return
        this._choiceRows = response.items
        this.setData({ accountChoiceResults: model.accountSelectorOptions(this.data.choiceKind === 'accounts' ? response.items : [], this.data.choiceKind === 'accountDrafts' ? response.items : []), choicePage: response.page })
      } catch (error) { if (pager === this._directoryPager) this.setData({ errorMessage: errorText(error) }) }
    },
    selectAccountChoice(event) {
      const id = String(event.currentTarget.dataset.value).replace(/^account:/, '')
      const selected = (this._choiceRows || []).find(row => row.accountId === id)
      if (selected) {
        const data = this.businessData()
        const accounts = data.accounts.filter(row => row.accountId !== id).slice(0, 11).concat(selected)
        data.accounts = accounts
        this.setData({ accounts })
        const draft = this._accountUiDrafts.get(this.data.accountChoiceSheet.issueId)
        if (draft) draft.accountName = selected.name
      }
      return original.selectAccountChoice.call(this, event)
    },
    async openDirectory(event) {
      const target = event.currentTarget.dataset.target
      const kind = target === 'category' ? 'categories' : 'accounts'
      this.setData({ directorySheet: { target, kind, query: '', items: [] } })
      this._optionPager = this._viewSession.pager('financeUpdates.options', { kind, pageSize: 12 })
      return this.changeDirectoryPage(event)
    },
    async searchDirectory(event) {
      if (!this.data.directorySheet) return
      const query = String(event.detail.value).slice(0, 80)
      this.setData({ 'directorySheet.query': query })
      this._optionPager = this._viewSession.pager('financeUpdates.options', { kind: this.data.directorySheet.kind, query, pageSize: 12 })
      return this.changeDirectoryPage(event)
    },
    changeDirectoryKind(event) {
      const kind = event.currentTarget.dataset.kind
      if (!this.data.directorySheet || this.data.directorySheet.target === 'category' || !['accounts', 'accountDrafts'].includes(kind)) return
      this.setData({ 'directorySheet.kind': kind, 'directorySheet.query': '' })
      this._optionPager = this._viewSession.pager('financeUpdates.options', { kind, pageSize: 12 })
      return this.changeDirectoryPage(event)
    },
    async changeDirectoryPage(event) {
      const pager = this._optionPager
      try {
        const response = await pager.load(direction(event))
        if (pager !== this._optionPager || !this.data.directorySheet) return
        this.setData({ 'directorySheet.items': response.items, 'directorySheet.page': response.page })
      } catch (error) { if (pager === this._optionPager) this.setData({ errorMessage: errorText(error) }) }
    },
    selectDirectory(event) {
      const sheet = this.data.directorySheet
      if (!sheet || !this.data.currentIssue) return
      const item = sheet.items[Number(event.currentTarget.dataset.index)]
      if (!item) return
      if (sheet.target === 'category') {
        const nature = this.data.issueDraft.natureIndex
        const kind = nature === 1 ? 'income' : [0, 6].includes(nature) ? 'expense' : ''
        if (item.kind !== kind) { this.setData({ errorMessage: '请选择与当前收支性质一致的分类' }); return }
        const options = [this.data.issueCategories[0], item]
        this.setData({ issueCategories: options, categories: this.data.categories.filter(row => row.categoryId !== item.categoryId).slice(0, 11).concat(item), 'issueDraft.categoryIndex': 1, issueCategoryCanSave: true })
      } else if (['payment', 'paymentTarget', 'repayment'].includes(sheet.target)) {
        if (sheet.target !== 'payment' && !['credit', 'other_liability'].includes(item.type)) { this.setData({ errorMessage: '请选择负债账户' }); return }
        if (sheet.target === 'repayment') {
          if (this.data.repaymentAllocationChoices.length >= 20) { this.setData({ errorMessage: '一次最多分配 20 个账户' }); return }
          if (!this.data.repaymentAllocationChoices.some(row => row.accountId === item.accountId)) this.refreshRepaymentChoices(this.data.repaymentAllocationChoices.concat(Object.assign({}, item, { amountInput: '' })))
        } else {
          const key = sheet.target === 'payment' ? 'paymentAccountChoices' : 'paymentTargetChoices'
          const choices = this.data[key]
          const pinned = new Set(this.data.paymentRows.map(row => row.accountId).filter(Boolean))
          const next = choices.filter(row => !row.accountId || pinned.has(row.accountId) || row.accountId === item.accountId)
          if (!next.some(row => row.accountId === item.accountId)) next.push(item)
          const rows = this.data.paymentRows.map(row => Object.assign({}, row, { accountIndex: Math.max(0, next.findIndex(account => account.accountId === row.accountId)) }))
          this.setData(Object.assign({ [key]: next }, sheet.target === 'payment' ? { paymentRows: rows } : {}))
          if (sheet.target === 'paymentTarget') { this.setData({ paymentTargetIndex: this.data.paymentTargetChoices.findIndex(row => row.accountId === item.accountId) }); this.refreshPaymentDraft() }
        }
      } else {
        const property = sheet.target === 'counterparty' ? 'counterpartyAccountChoices' : 'accountChoices'
        const field = sheet.target === 'counterparty' ? 'counterpartyAccountIndex' : 'accountIndex'
        this.setData({ [property]: [this.data[property][0], item], ['issueDraft.' + field]: 1,
          accounts: this.data.accounts.filter(row => row.accountId !== item.accountId).slice(0, 11).concat(item) })
      }
      this.closeDirectory(); this.refreshIssueFieldsDraft()
    },
    closeDirectory() { if (this._optionPager) this._optionPager.cancel(); this._optionPager = null; this.setData({ directorySheet: null }) },
    expandBankBatch() {
      if (this.data.currentIssue.repaymentOwnershipRequired) return
      if (this.data.bankBatchExpanded) { this.setData({ bankBatchExpanded: false, bankBatchRecords: [], bankBatchSelectedCount: 0 }); return }
      const candidates = new Set(this.data.bankBatchCandidates.map(row => row.issueId))
      const accounts = this.data.accounts
      const rows = this.businessData().issues.filter(issue => candidates.has(issue.issueId)).map(issue => {
        const suggestion = model.bankAccountSuggestion(issue.subject ? [issue.subject] : [], accounts)
        return { issueId: issue.issueId, version: issue.version, count: Number(issue.memberCount), records: issue.subject ? [presentation.record(issue.subject)] : [],
          candidateIds: suggestion ? suggestion.candidates.map(row => row.accountId) : [], selected: false, readable: Boolean(suggestion) }
      })
      this.setData({ bankBatchExpanded: true, bankBatchLoading: false, bankBatchRecords: rows })
    },
    async changeIssueMembers(event) {
      const pager = this._memberPager
      if (!pager || !this.data.currentIssue) return
      const issueId = this.data.currentIssue.issueId
      try {
        const response = await pager.load(direction(event))
        if (pager !== this._memberPager || !this.data.currentIssue || this.data.currentIssue.issueId !== issueId) return
        this._issueEvidenceRecords = response.items.filter(member => member.event).map(member => Object.assign({}, presentation.record(member.event), { evidence: [], evidenceLoading: false }))
        this.setData({ issueVisibleEvents: this._issueEvidenceRecords, issueEvidenceTotal: response.total, issueEvidenceLoading: false,
          issueEvidenceHasMore: false, memberPage: response.page })
      } catch (error) { if (pager === this._memberPager) this.setData({ errorMessage: errorText(error) }) }
    },
    async changeIssueRelations(event) {
      const pager = this._relationPager
      if (!pager || !this.data.currentIssue) return
      try {
        const response = await pager.load(direction(event))
        if (pager !== this._relationPager || !this.data.currentIssue) return
        this.setData({ issueRelations: response.items.filter(member => member.relation).map(member => model.relationChoiceView(editorPreview(member.relation.targetEvent), member.relation)), relationPage: response.page })
      } catch (error) { if (pager === this._relationPager) this.setData({ errorMessage: errorText(error) }) }
    },
    async loadRecordEvidence(records, isCurrent, onRecord) {
      if (!isCurrent()) return
      records.forEach(record => { record.evidenceLoading = false; record.evidence = []; record.evidenceError = '' })
      onRecord()
    },
    async openAccountRecords(event) {
      const issueId = event.currentTarget.dataset.id
      const mapping = this.data.accountMappings.find(item => item.issueId === issueId)
      if (!mapping) return
      this._accountPager = this._viewSession.pager('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 })
      this.setData({ accountRecordsSheet: { issueId, label: mapping.label, records: [], loading: true } })
      return this.changeAccountMembers(event)
    },
    async changeAccountMembers(event) {
      const pager = this._accountPager
      try {
        const response = await pager.load(direction(event))
        if (pager !== this._accountPager || !this.data.accountRecordsSheet) return
        const list = model.accountRecordList(response.items)
        this._accountRecordList = list.records.map(presentation.record)
        this.setData({ accountRecordsSheet: Object.assign({}, this.data.accountRecordsSheet, { records: this._accountRecordList, dateRange: '当前页 ' + list.dateRange,
          count: response.total, loading: false, hasMore: false, page: response.page }) })
      } catch (error) { if (pager === this._accountPager) this.setData({ 'accountRecordsSheet.loading': false, 'accountRecordsSheet.error': errorText(error) }) }
    },
    async openEvidence(event) {
      const eventId = event.currentTarget.dataset.id
      this._evidencePager = this._viewSession.pager('economicEvents.evidence', { eventId, pageSize: 8 })
      this.setData({ evidenceSheet: { eventId, evidence: [], loading: true, part: '' } })
      return this.changeEvidencePage(event)
    },
    async changeEvidencePage(event) {
      const pager = this._evidencePager
      try {
        const response = await pager.load(direction(event))
        if (pager !== this._evidencePager || !this.data.evidenceSheet) return
        this._detailPager = null
        this.setData({ evidenceSheet: { eventId: this.data.evidenceSheet.eventId, evidence: response.items, page: response.page, loading: false, part: '' } })
      } catch (error) { if (pager === this._evidencePager) this.setData({ errorMessage: errorText(error) }) }
    },
    async openEvidencePart(event) {
      this._detailPager = this._viewSession.pager('economicEvents.detail', { eventId: this.data.evidenceSheet.eventId, evidenceId: event.currentTarget.dataset.id })
      return this.changeEvidencePart(event)
    },
    async changeEvidencePart(event) {
      const pager = this._detailPager
      try {
        const response = await pager.load(direction(event))
        if (pager !== this._detailPager || !this.data.evidenceSheet) return
        this.setData({ 'evidenceSheet.part': response.part, 'evidenceSheet.partPage': response.page })
      } catch (error) { if (pager === this._detailPager) this.setData({ errorMessage: errorText(error) }) }
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
      this.setData({ finalDetailSheet: { kind, title: '正在读取明细', count: 0, records: [], accounts: [] }, finalDetailParent: null })
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
        this.setData({ finalDetailSheet: Object.assign({}, sheet, { count: response.total, records: (sheet.records || []).map(presentation.record), page: response.page }), finalDetailScrollTop: 0 })
      } catch (error) { if (pager === this._finalPager) this.setData({ errorMessage: errorText(error) }) }
    },
    openFinalAccount(event) { return this.openFinalDetail({ currentTarget: { dataset: { kind: 'account', id: event.currentTarget.dataset.id } } }) },
    async postUpdate() {
      if (this.data.busy || !this._draftSession) return
      const session = this._draftSession
      this.setData({ busy: true, errorMessage: '' })
      try {
        if (!session.state.postFlight) {
          await session.flush()
          this.applyUpdateView(session.view, true)
          if (!session.view.coverage.selectedEventsReadyToPost) { this.setData({ errorMessage: '请完成剩余核对后再入账' }); return }
        }
        this.setData({ busy: true })
        const receipt = await session.post()
        if (!this._viewActive) return
        if (this._unsubscribeDraft) this._unsubscribeDraft()
        session.clear(); drafts.forgetLast(); this._draftSession = null
        this.applyUpdateView(receipt)
        try { this.applyUpdateView(await api.readSummary(receipt.update.updateId)) } catch (error) { /* 已入账状态保留，用户可独立刷新。 */ }
      } catch (error) { if (this._viewActive) this.setData({ errorMessage: errorText(error) }) }
      finally { if (this._viewActive) this.setData({ busy: false }) }
    }
  })
  for (const [method, keys] of Object.entries({ closeIssue: ['_memberPager', '_relationPager'], closeAccountRecords: ['_accountPager'],
    closeEvidence: ['_evidencePager', '_detailPager'], closeFinalDetail: ['_finalPager'], closeAccountChoice: ['_directoryPager'] })) {
    result[method] = function () {
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
function editorPreview(event) {
  if (!event || !event.primaryEvidence) return event
  let shortened = false
  const primaryEvidence = Object.fromEntries(Object.entries(event.primaryEvidence).map(([key, value]) => {
    if (typeof value === 'string' && value.length > 160) { shortened = true; return [key, value.slice(0, 160) + '…'] }
    return [key, value]
  }))
  return Object.assign({}, event, { primaryEvidence, detailRequired: event.detailRequired || shortened })
}
function direction(event) { const value = event && event.currentTarget.dataset.direction; return value === 'first' ? value : Number(value || 0) }
function compactMapping(mapping) { const { choiceOptions, evidencePreview, ...visible } = presentation.accountMapping(mapping); return Object.assign(visible, { evidencePreview: Boolean(evidencePreview) }) }
module.exports = { enhance, boundedSetData, bytes }
