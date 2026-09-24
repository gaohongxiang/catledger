const transactionReview = require('./transaction-review')
const accountReview = require('./account-review')
const uploadFlow = require('./upload-flow')
const { publicError } = require('./presentation')
const runtime = require('./runtime')
const { setChangedData } = require('../../services/view-patch')
const importApi = require('../../services/catledger-import')

const model = require('./model')
const presentation = require('./presentation')
const { buildFinalDetail } = require('./final-detail')
const draftSessions = require('../../services/import-draft-session')














const initialData = {
    restoreUpdateId: '',
    abandoningRestore: false,
    phase: 'idle',
    maxFiles: uploadFlow.MAX_FILES,
    currentStep: 1,
    reviewPage: { index: 0, pages: 1, count: 0 },
    unlockedStep: 1,
    busy: false,
    files: [],
    bankMappingSheet: null,
    fileAttentionSheet: null,
    historicalCandidates: [],
    historicalPage: null,
    historicalSelection: '',
    historicalLoading: false,
    historicalError: '',
    uploadSummary: { total: 0, queued: 0, ready: 0, failed: 0, mapping: 0, duplicate: 0, attention: 0 },
    pendingInstallments: false,
    update: null,
    sources: [],
    events: [],
    issues: [],
    accountIssues: [],
    accountMappings: [],
    draftSync: { pending: 0, syncing: false, error: '', conflicts: 0 },
    accountStepSummary: { total: 0, ready: 0, confirmed: 0, invalid: 0, create: 0, inline: 0, transfer: 0, open: 0, dirty: 0, pending: 0 },
    accountStepBusy: false,
    accountStepError: '',
    accountStepProgressText: '',
    reviewIssues: [],
    reviewGroups: [],
    verificationIssues: [],
    categoryIssues: [],
    categoryCards: [],
    categoryQuery: '',
    categoryEventCount: 0,
    categorizedEvents: [],
    categorizedEventCount: 0,
    recordSummary: { totalCount: 0, activeCount: 0, excludedCount: 0, duplicateCount: 0 },
    reviewedEvents: [],
    categoryWaitingEvents: [],
    noCategoryEvents: [],
    activeCategoryStatus: 'pending',
    categoryStatusTabs: model.organizerRecordState([], [], []).categoryStatusTabs,
    activeReviewTab: 'review',
    issueSourceExpanded: false,
    issueFieldsReason: '',
    paymentValidationHint: '',
    duplicateReviewCandidates: [],
    duplicateReviewLoading: false,
    duplicateReviewLoaded: false,
    duplicateReviewError: '',

    reviewStatusTabs: [
      { value: 'pending', label: '待核对', count: 0 },
      { value: 'completed', label: '已核对', count: 0 },
      { value: 'excluded', label: '已排除', count: 0 },
      { value: 'duplicate', label: '重复', count: 0 }
    ],
    activeReviewStatus: 'pending',
    excludedReviewGroups: [],
    duplicateReviewEvents: [],
    openIssueCount: 0,
    coverage: {
      dataRows: 0,
      recognizedRows: 0,
      unrecognizedRows: 0,
      selectedEvents: 0,
      readySelectedEvents: 0,
      pendingSelectedEvents: 0,
      excludedEvents: 0,
      statementFullyRecognized: false,
      selectedEventsReadyToPost: false
    },
    accounts: [],
    accountDrafts: [],
    accountMappingDrafts: [],
    accountChoices: [{ accountId: '', name: '新建账户' }],
    counterpartyAccountChoices: [{ accountId: '', name: '请选择转入账户', isPlaceholder: true }],
    accountChoiceSheet: null,
    accountChoiceQuery: '',
    accountChoiceResults: [],
    choiceLoading: false,
    accountTypeOptions: accountReview.ACCOUNT_TYPE_OPTIONS,
    categories: [],
    issueCategories: [],
    posting: null,
    fundsFlowGroups: [],
    finalDetailSheet: null,
    finalDetailScrollTop: 0,
    finalDetailParent: null,
    finalSummary: {
      expenseCount: 0, incomeCount: 0, refundCount: 0,
      expenseText: '¥0.00', incomeText: '¥0.00', refundText: '¥0.00', transferCount: 0,
      categoryCoverageText: '无需分类', categoryComplete: true, newAccountCount: 0, affectedAccountCount: 0
    },
    errorMessage: '',
    paymentRows: [], paymentNatureOptions: ['请选择交易性质', '本次消费支出', '偿还既有欠款'], paymentNatureIndex: 0,
    paymentTargetIndex: 0, paymentEvidenceNote: '', paymentCanSave: false, paymentDifferenceText: '',
    bankSuggestion: null,
    bankBatchCandidates: [],
    bankBatchRecords: [],
    bankBatchExpanded: false,
    bankBatchLoading: false,
    bankBatchSelectedCount: 0,
    currentIssue: null,
    issueFieldsCanSave: false,
    currentMembers: [],
    issueEvents: [],
    issueVisibleEvents: [],
    issueEvidenceLoading: false,
    issueEvidenceHasMore: false,
    issueEvidenceTotal: 0,
    issueRelations: [],
    repaymentAllocationChoices: [],
    repaymentAccountOptions: [],
    repaymentAdditionalOptions: [],
    repaymentAdditionalIndex: 0,
    repaymentAllocationStatusText: '',
    repaymentAllocationCanSave: false,
    evidenceSheet: null,
    accountRecordsSheet: null,
    issueDraft: {
      accountIndex: 0,
      counterpartyAccountIndex: 0,
      categoryIndex: 0,
      natureIndex: 0,
      primaryEventId: '',
      targetEventId: '',
      newAccountName: '',
      accountTypeIndex: 2
    },
    natureOptions: transactionReview.NATURE_OPTIONS,
    themeClass: '',
    themeStyle: ''
  }

Page(require('./paged').enhance({
data: initialData,

businessData: function () { return this._businessData || this.data },

mappingState: accountReview.mappingState,

refreshAccountMappings: accountReview.refreshAccountMappings,

onLoad: runtime.onLoad,

onHide: runtime.onHide,

onUnload: runtime.onUnload,

onShow() { return runtime.onShow.call(this, initialData) },

chooseFiles: uploadFlow.chooseFiles,

openFilePicker: uploadFlow.openFilePicker,

readLocalFile: uploadFlow.readLocalFile,

isDuplicateLocalFile: uploadFlow.isDuplicateLocalFile,

startUpload: uploadFlow.startUpload,

uploadAndParseFile: uploadFlow.uploadAndParseFile,

uploadObject: uploadFlow.uploadObject,

setFileProgress: uploadFlow.setFileProgress,

clearFileProgressThrottle: uploadFlow.clearFileProgressThrottle,

parsePreparedFile: uploadFlow.parsePreparedFile,

openBankMapping: uploadFlow.openBankMapping,

showFileFailure: uploadFlow.showFileFailure,

openFileAttention: uploadFlow.openFileAttention,

tapFileRow: uploadFlow.tapFileRow,

closeFileAttention: uploadFlow.closeFileAttention,

retryFileAttention: uploadFlow.retryFileAttention,

closeBankMapping: uploadFlow.closeBankMapping,

changeBankMapping: uploadFlow.changeBankMapping,

toggleBankColumns: uploadFlow.toggleBankColumns,

inputBankHeader: uploadFlow.inputBankHeader,

refreshBankPreview: uploadFlow.refreshBankPreview,

confirmBankMapping: uploadFlow.confirmBankMapping,

setFileState: uploadFlow.setFileState,

syncUploadSummary: uploadFlow.syncUploadSummary,

retryFile: uploadFlow.retryFile,

removeFile: uploadFlow.removeFile,

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
        requestId: importApi.createRequestId(), batchIds: batchIds
      })
      view = await this.refreshAccountGroups(view)
      this.applyUpdateView(view)
    } catch (error) {
      this.setData({ phase: 'files_ready', busy: false, errorMessage: publicError(error, '跨来源整理失败') })
    }
  },

refreshAccountGroups: async function (view) {
    if (view.update.status !== 'review' || view.freshness && view.freshness.requiresAccountGroupRefresh === false) return view
    return this.request('reviewIssues.refreshAccountGroups', { requestId: importApi.createRequestId(),
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
          requestId: importApi.createRequestId(), updateId: updateId, version: view.update.version
        })
        view = await load.pending
        if (!active()) return
      }
      load.pending = this.refreshAccountGroups(view)
      view = await load.pending
      if (!active()) return
      this.setData({ restoreUpdateId: '' })
      this.applyUpdateView(view, false, restoreToFirstStep)
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
          this._restoreAbandonRequest = { requestId: importApi.createRequestId(), updateId: updateId, version: view.update.version }
        }
        await this.request('financeUpdates.abandon', this._restoreAbandonRequest)
      }
      draftSessions.clearUpdate(updateId)
      this.startAnother()
    } catch (error) {
      this.setData({ busy: false, abandoningRestore: false, errorMessage: publicError(error, '放弃失败，上次导入已保留，请重试') })
    }
  },

toggleIssueSource: transactionReview.toggleIssueSource,

switchReviewTab: transactionReview.switchReviewTab,

switchCategoryStatus: transactionReview.switchCategoryStatus,

searchCategoryIssues: transactionReview.searchCategoryIssues,

reviewBeforeCategory: transactionReview.reviewBeforeCategory,

viewTransactions: function () {
    wx.switchTab({ url: '/pages/transactions/index' })
  },

viewStatistics: function () {
    wx.switchTab({ url: '/pages/statistics/index' })
  },

completeCategories: function () {
    getApp().globalData.openStatisticsCompletion = true
    wx.switchTab({ url: '/pages/statistics/index', fail: function () { getApp().globalData.openStatisticsCompletion = false } })
  },

correctBalances: function () {
    wx.navigateTo({ url: '/pages/accounts/index' })
  },

openInstallmentSources: function () {
    wx.navigateTo({ url: '/pages/installment-sources/index' })
  },

switchReviewStatus: transactionReview.switchReviewStatus,

toggleExcludedGroup: transactionReview.toggleExcludedGroup,

buildAccountMappingState: accountReview.buildAccountMappingState,

openAccountChoice: accountReview.openAccountChoice,

closeAccountChoice: accountReview.closeAccountChoice,

selectAccountChoice: accountReview.selectAccountChoice,

preventTouchMove: function () {},

closeAccountRecords: accountReview.closeAccountRecords,

closeReviewSheet: transactionReview.closeReviewSheet,

bindAccountDraftName: accountReview.bindAccountDraftName,

scheduleAccountDraftSync: accountReview.scheduleAccountDraftSync,

flushAccountDraftSync: accountReview.flushAccountDraftSync,

changeAccountDraftType: accountReview.changeAccountDraftType,

completeAccountMapping: accountReview.completeAccountMapping,

persistAccountDrafts: accountReview.persistAccountDrafts,

accountMappingDecision: accountReview.accountMappingDecision,

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
      const checked = await this.request('financeUpdates.organize', { requestId: importApi.createRequestId(),
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

openIssue: transactionReview.openIssue,

closeIssue: transactionReview.closeIssue,

backFinalDetail: function () {
    if (this.data.finalDetailParent) this.setData({ finalDetailSheet: this.prepareFinalDetail(this.data.finalDetailParent), finalDetailParent: null })
    else this.closeFinalDetail()
  },

prepareFinalDetail: function (kind, accountId, index) {
    this._finalDetail = buildFinalDetail(kind, this.businessData(), accountId)
    return presentation.detailWindow(this._finalDetail, index)
  },

closeFinalDetail: function () { this._finalDetail = null; this.setData({ finalDetailSheet: null, finalDetailParent: null }) },

closeEvidence: transactionReview.closeEvidence,

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

refreshIssueFieldsDraft: transactionReview.refreshIssueFieldsDraft,

changeRepaymentOwner: transactionReview.changeRepaymentOwner,

changeRepaymentOtherTreatment: transactionReview.changeRepaymentOtherTreatment,

changeIssueAccount: transactionReview.changeIssueAccount,

refreshPaymentDraft: transactionReview.refreshPaymentDraft,

changePaymentRow: transactionReview.changePaymentRow,

fillPaymentAmount: transactionReview.fillPaymentAmount,

changePaymentNature: transactionReview.changePaymentNature,

changePaymentTarget: transactionReview.changePaymentTarget,

changePaymentNote: transactionReview.changePaymentNote,

selectBankSuggestion: transactionReview.selectBankSuggestion,

toggleBankBatch: transactionReview.toggleBankBatch,

resolveBankBatch: transactionReview.resolveBankBatch,

refreshRepaymentChoices: transactionReview.refreshRepaymentChoices,

addRepaymentAccount: transactionReview.addRepaymentAccount,

removeRepaymentAccount: transactionReview.removeRepaymentAccount,

changeRepaymentAccountName: transactionReview.changeRepaymentAccountName,

changeRepaymentAllocation: transactionReview.changeRepaymentAllocation,

fillRepaymentAllocation: transactionReview.fillRepaymentAllocation,

changeCounterpartyAccount: transactionReview.changeCounterpartyAccount,

changeDraftAccountName: transactionReview.changeDraftAccountName,

changeDraftAccountType: transactionReview.changeDraftAccountType,

changeIssueCategory: transactionReview.changeIssueCategory,

changeIssueNature: transactionReview.changeIssueNature,

selectPrimaryEvent: transactionReview.selectPrimaryEvent,

selectTargetRelation: transactionReview.selectTargetRelation,

resolveWithFields: transactionReview.resolveWithFields,

confirmDistinct: transactionReview.confirmDistinct,

confirmSame: transactionReview.confirmSame,

linkRefund: transactionReview.linkRefund,

markRefundPending: transactionReview.markRefundPending,

confirmInstallment: transactionReview.confirmInstallment,

reviewDraftEntry: transactionReview.reviewDraftEntry,

restoreReviewDraft: transactionReview.restoreReviewDraft,

recheckDraftConflicts: transactionReview.recheckDraftConflicts,

resolveIssue: transactionReview.resolveIssue,

abandonUpdate: function () {
    const self = this
    if (this.data.busy || !this.data.update || !['draft', 'failed', 'review'].includes(this.data.update.status)) return
    wx.showModal({
      title: '放弃本批账单？',
      content: '本批的账户选择和整理结果会被放弃。正式账户、余额、交易和统计都不会改变。',
      confirmText: '确认放弃',
      confirmColor: '#b54738',
      success: function (result) {
        if (!result.confirm) return
        self.performAbandonUpdate()
      }
    })
  },

performAbandonUpdate: async function () {
    if (this.data.busy || !this.data.update) return
    this.setData({ busy: true, errorMessage: '', currentIssue: null })
    try {
      if (this._draftSession) {
        await this._draftSession.pause()
        const fresh = await this.request('financeUpdates.summary', { updateId: this.data.update.updateId })
        this.setData({ update: fresh.update })
      }
      await this.request('financeUpdates.abandon', {
        requestId: importApi.createRequestId(),
        updateId: this.data.update.updateId,
        version: this.data.update.version
      })
      this.startAnother()
      wx.showToast({ title: '本批账单已放弃', icon: 'none' })
    } catch (error) {
      if (this._draftSession) this._draftSession.resume()
      this.setData({ busy: false, errorMessage: publicError(error, '放弃失败，请重试') })
    }
  },

openImportHistory: function () { if (!this.data.busy) wx.navigateTo({ url: '/pages/import-history/index' }) },

startAnother: function () {
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

applyPendingBackgroundView: runtime.applyPendingBackgroundView,

cancelPagedReads: runtime.cancelPagedReads,

request: runtime.request
,
loadDirectories: accountReview.loadDirectories,
bindAccountChoiceSearch: accountReview.bindAccountChoiceSearch,
changeChoiceKind: accountReview.changeChoiceKind,
changeChoicePage: accountReview.changeChoicePage,
openDirectory: accountReview.openDirectory,
searchDirectory: accountReview.searchDirectory,
changeDirectoryKind: accountReview.changeDirectoryKind,
changeDirectoryPage: accountReview.changeDirectoryPage,
selectDirectory: accountReview.selectDirectory,
closeDirectory: accountReview.closeDirectory,
openAccountRecords: accountReview.openAccountRecords,
changeAccountMembers: accountReview.changeAccountMembers
,
readIssue: transactionReview.readIssue,
excludeIssueEvents: transactionReview.excludeIssueEvents,
selectPrimaryMember: transactionReview.selectPrimaryMember,
expandBankBatch: transactionReview.expandBankBatch,
changeHistoricalPage: transactionReview.changeHistoricalPage,
selectHistoricalTransaction: transactionReview.selectHistoricalTransaction,
linkHistoricalTransaction: transactionReview.linkHistoricalTransaction,
refreshHistoricalReview: transactionReview.refreshHistoricalReview,
changeIssueMembers: transactionReview.changeIssueMembers,
changeIssueRelations: transactionReview.changeIssueRelations,
closeInlineEvidence: transactionReview.closeInlineEvidence,
loadInlineEvidence: transactionReview.loadInlineEvidence,
changeInlineSource: transactionReview.changeInlineSource,
retryIssueRecordEvidence: transactionReview.retryIssueRecordEvidence,
retryAccountRecordEvidence: transactionReview.retryAccountRecordEvidence,
editLoanRepayment: transactionReview.editLoanRepayment,
openEvidence: transactionReview.openEvidence,
changeEvidencePage: transactionReview.changeEvidencePage,
openEvidencePart: transactionReview.openEvidencePart,
changeEvidencePart: transactionReview.changeEvidencePart
}))
