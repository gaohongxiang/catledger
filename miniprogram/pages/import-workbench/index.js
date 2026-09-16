const { setChangedData } = require('../../services/view-patch')
const importApi = require('../../services/catledger-import')
const cloudUpload = require('../../services/cloud-upload-policy')
const loginGuard = require('../../services/login-guard')
const themeService = require('../../theme/service')
const model = require('./model')
const presentation = require('./presentation')
const { buildFinalDetail } = require('./final-detail')
const draftSessions = require('../../services/import-draft-session')

function additionalRepaymentOptions(catalog, rows) {
  const selected = new Set(rows.map(function (row) { return row.accountId }))
  return [{ name: '补充还款账户', isPlaceholder: true }].concat(catalog.filter(function (account) {
    return !selected.has(account.accountId)
  })).concat([{ name: '新建负债账户', isCreate: true }])
}

const MAX_FILES = 5
const MAX_FILE_BYTES = 5 * 1024 * 1024
const FILE_PIPELINE_CONCURRENCY = MAX_FILES
const NATURE_OPTIONS = Object.freeze([
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'refund', label: '退款' },
  { value: 'internal_transfer', label: '内部转账' },
  { value: 'repayment', label: '还款' },
  { value: 'borrow', label: '借款' },
  { value: 'fee', label: '手续费' },
  { value: 'balance_adjustment', label: '余额调整' },
  { value: 'unknown', label: '暂不确定' }
])
const ACCOUNT_TYPE_OPTIONS = Object.freeze([
  { value: 'cash', label: '现金' },
  { value: 'bank', label: '银行卡' },
  { value: 'wallet', label: '平台钱包' },
  { value: 'credit', label: '信用卡 / 消费信贷' },
  { value: 'other_asset', label: '其他资产' },
  { value: 'other_liability', label: '其他负债' }
])

const ERROR_MESSAGES = Object.freeze({
  CONFLICT: '整理状态已经变化，请刷新后重试',
  CSV_COLUMN_LIMIT_EXCEEDED: '账单列结构异常，请重新从支付平台导出',
  CSV_RECORD_LIMIT_EXCEEDED: '单个账单超过 5000 条，请缩短导出时间范围',
  FILE_ENCODING_INVALID: '文件编码无法识别，请重新导出',
  FILE_FORMAT_UNSUPPORTED: '仅支持支付宝或微信的 CSV、XLSX 账单',
  FILE_SIZE_INVALID: '每个文件需大于 0 且不超过 5 MB',
  IDENTITY_CONFLICT: '来源记录身份冲突，需要在问题卡片中确认',
  INITIALIZATION_REQUIRED: '账本还没有初始化，请重新登录后再试',
  UNRESOLVED_IMPORT: '仍有阻塞问题，暂时不能整批入账',
  UNSUPPORTED_ACTION: '导入服务版本过旧，请更新云函数后重试'
})

function publicError(error, fallback) {
  return ERROR_MESSAGES[error && error.code] || error && error.message || fallback
}

function suggestedAccountTypeIndex(label) {
  const value = String(label || '')
  if (/信用|花呗|白条|贷|先采后付/.test(value)) return 3
  if (/银行|储蓄|借记|卡/.test(value)) return 1
  if (/现金/.test(value)) return 0
  if (/余额宝|基金|理财/.test(value)) return 4
  return 2
}

function validAccountName(value) {
  const length = Array.from(String(value || '').normalize('NFKC').trim()).length
  return length >= 1 && length <= 32
}

function minorToYuanInput(value) {
  const minor = String(value || '0').padStart(3, '0')
  const fraction = minor.slice(-2).replace(/0$/u, '')
  return minor.slice(0, -2).replace(/^0+(?=\d)/u, '') + (fraction ? '.' + fraction : '')
}

function allocationStatus(options, totalAmountMinor) {
  const state = model.buildRepaymentAllocationDraft(options, totalAmountMinor)
  const remaining = String(state.remainingMinor || '0')
  return {
    state: state,
    text: state.valid
      ? '已分配完成'
      : remaining.startsWith('-')
        ? '超出 ' + model.amountText(remaining.slice(1))
        : '还差 ' + model.amountText(remaining)
  }
}

Page(require('./paged').enhance({
  data: {
    restoreUpdateId: '',
    abandoningRestore: false,
    phase: 'idle',
    maxFiles: MAX_FILES,
    currentStep: 1,
    reviewPage: { index: 0, pages: 1, count: 0 },
    unlockedStep: 1,
    steps: [
      { value: 1, label: '解析' },
      { value: 2, label: '账户' },
      { value: 3, label: '整理' },
      { value: 4, label: '入账' }
    ],
    busy: false,
    files: [],
    uploadSummary: { total: 0, queued: 0, ready: 0, failed: 0, attention: 0 },
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
    accountTypeOptions: ACCOUNT_TYPE_OPTIONS,
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
    natureOptions: NATURE_OPTIONS,
    themeClass: '',
    themeStyle: ''
  },

  businessData: function () { return this._businessData || this.data },
  mappingState: function () {
    const data = this.businessData()
    return this.buildAccountMappingState(data.accountIssues || [], data.accounts || [], data.accountDrafts || [], [])
  },
  refreshAccountMappings: function () {
    const state = this.mappingState()
    setChangedData(this, { accountMappings: state.mappings.map(function (mapping) {
      const visible = presentation.accountMapping(mapping)
      delete visible.choiceOptions
      visible.evidencePreview = Boolean(visible.evidencePreview)
      return visible
    }) })
    return state
  },
  loadRecordEvidence: async function (records, isCurrent, onRecord) {
    records.forEach(function (record, index) {
      if (isCurrent()) onRecord(index, Object.assign({}, record, { evidenceState: 'ready', detailRequired: true }))
    })
  },
  onLoad: function (options) {
    themeService.bindPage(this)
    this._requestIds = {}
    this._sourceFiles = new Map()
    this._accountUiDrafts = new Map()
    const updateId = options && options.fresh === '1' ? null : options && options.updateId || draftSessions.lastUpdateId()
    loginGuard.run(this, updateId ? async () => {
      await this.loadUpdate(updateId, true)
      const eventId = options && options.evidenceEventId
      if (eventId) {
        await this.openEvidence({ currentTarget: { dataset: { id: eventId } } })
      }
    } : function () {})
  },

  onHide: function () {
    this.finishInputEditing()
    this._returnToFirstStep = Boolean(this.data.update && ['draft', 'failed', 'review'].includes(this.data.update.status))
  },

  onUnload: function () {
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
  },

  onShow: function () {
    themeService.bindPage(this)
    if (this._returnToFirstStep) {
      this._returnToFirstStep = false
      if (this.data.update && ['draft', 'failed', 'review'].includes(this.data.update.status)) {
        this.setStep({ currentStep: 1, currentIssue: null, accountChoiceSheet: null, evidenceSheet: null, accountRecordsSheet: null })
      }
    }
    const revision = getApp().globalData.ledgerRevision || 0
    if (this._ledgerRevision != null && this._ledgerRevision !== revision && this.data.update) {
      if (this._draftSession) this._draftSession.flush().catch(function () {})
      else this.loadUpdate(this.data.update.updateId)
    }
    this._ledgerRevision = revision
  },

  chooseFiles: function () {
    loginGuard.run(this, this.openFilePicker.bind(this))
  },

  openFilePicker: function () {
    const self = this
    const remaining = MAX_FILES - this.data.files.length
    if (remaining <= 0) return
    wx.chooseMessageFile({
      count: remaining,
      type: 'file',
      extension: ['csv', 'xlsx'],
      success: async function (result) {
        const selected = result.tempFiles || []
        if (selected.length === 0) return
        const invalid = selected.find(function (file) {
          return !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES
        })
        if (invalid) {
          self.setData({ errorMessage: invalid.name + ' 超过 5 MB 或文件为空' })
          return
        }
        const accepted = []
        let duplicateCount = 0
        for (const file of selected) {
          if (await self.isDuplicateLocalFile(file, accepted)) {
            duplicateCount += 1
            continue
          }
          accepted.push(file)
        }
        const files = accepted.map(function (file, index) {
          const clientId = Date.now() + '-' + index
          self._sourceFiles.set(clientId, file)
          return {
            clientId: clientId,
            name: file.name,
            size: file.size,
            sizeText: model.formatFileSize(file.size),
            state: 'queued',
            stateText: model.fileStateText('queued'),
            progress: 0,
            errorMessage: '',
            importId: '',
            importVersion: 0,
            batchId: '',
            fileID: ''
          }
        })
        const mergedFiles = self.data.files.concat(files)
        self.setData({
          phase: 'selected', currentStep: 1, unlockedStep: 1,
          files: mergedFiles, errorMessage: '',
          uploadSummary: model.uploadSummary(mergedFiles)
        })
        if (duplicateCount > 0) {
          wx.showToast({ title: '同一账单只保留一份', icon: 'none' })
        }
      },
      fail: function (error) {
        if (!error || String(error.errMsg || '').indexOf('cancel') < 0) {
          self.setData({ errorMessage: '未能读取账单文件，请重试' })
        }
      }
    })
  },

  readLocalFile: function (filePath) {
    return new Promise(function (resolve, reject) {
      wx.getFileSystemManager().readFile({ filePath: filePath, success: function (result) { resolve(result.data) }, fail: reject })
    })
  },

  isDuplicateLocalFile: async function (candidate, accepted) {
    const sources = this.data.files.map(function (file) { return this._sourceFiles.get(file.clientId) }, this)
      .concat(accepted)
    for (const source of sources) {
      if (!source || !model.sameFileMetadata(source, candidate)) continue
      if (source.path && candidate.path && source.path === candidate.path) return true
      try {
        const contents = await Promise.all([
          this.readLocalFile(source.path),
          this.readLocalFile(candidate.path)
        ])
        if (model.sameFileContent(contents[0], contents[1])) return true
      } catch (error) {
        // 无法读取时保守保留，由服务端内容摘要执行最终去重。
      }
    }
    return false
  },

  startUpload: async function () {
    const queuedFiles = this.data.files.filter(function (file) { return file.state === 'queued' })
    if (this.data.busy || queuedFiles.length === 0 || this.data.files.length > MAX_FILES) return
    this.setData({ phase: 'uploading', busy: true, errorMessage: '' })
    const requestId = importApi.createRequestId()
    this._requestIds.prepareMany = requestId
    try {
      const prepared = await this.request('imports.prepareMany', {
        requestId: requestId,
        files: queuedFiles.map(function (file) { return { fileName: file.name, size: file.size } })
      })
      const preparedByClientId = new Map(queuedFiles.map(function (file, index) {
        return [file.clientId, prepared.files[index]]
      }))
      const files = this.data.files.map(function (file) {
        const server = preparedByClientId.get(file.clientId)
        if (!server) return file
        return Object.assign({}, file, {
          state: 'preparing', stateText: model.fileStateText('preparing'),
          importId: server.importId, importVersion: server.version,
          cloudPath: server.cloudPath
        })
      })
      this.setData({ files: files })
      const preparedFiles = files.filter(function (file) {
        return preparedByClientId.has(file.clientId)
      })
      await model.runWithConcurrency(
        preparedFiles,
        FILE_PIPELINE_CONCURRENCY,
        this.uploadAndParseFile.bind(this)
      )
      this.syncUploadSummary()
      this.setData({ phase: this.data.files.length ? 'files_ready' : 'idle', busy: false })
    } catch (error) {
      this.setData({ phase: 'selected', busy: false, errorMessage: publicError(error, '多文件上传准备失败') })
    }
  },

  uploadAndParseFile: async function (file) {
    const source = this._sourceFiles.get(file.clientId)
    if (!source || !source.path) {
      this.setFileState(file.clientId, {
        state: 'failed', stateText: '文件已失效', progress: 0,
        errorMessage: '本地临时文件已失效，请删除后重新添加'
      })
      return
    }
    this.setFileState(file.clientId, { state: 'uploading', stateText: model.fileStateText('uploading'), errorMessage: '' })
    try {
      const result = await this.uploadObject(file, source.path)
      this.setFileState(file.clientId, { fileID: result.fileID, progress: 100 })
      await this.parsePreparedFile(file.clientId, result.fileID)
    } catch (error) {
      this.setFileState(file.clientId, {
        state: 'failed', stateText: '上传失败',
        progress: 0,
        errorMessage: publicError(error, '上传失败，请重试')
      })
    }
  },

  uploadObject: function (file, filePath) {
    const self = this
    return cloudUpload.uploadWithRetry({
      cloudPath: file.cloudPath,
      filePath: filePath,
      onProgress: function (progress) {
        self.setFileState(file.clientId, { progress: progress })
      },
      onRetry: function (failure, retry) {
        self.setFileState(file.clientId, {
          progress: 0,
          stateText: '重试中 ' + retry.attempt + '/' + retry.maxAttempts
        })
      }
    })
  },

  parsePreparedFile: async function (clientId, fileID) {
    const file = this.data.files.find(function (item) { return item.clientId === clientId })
    if (!file) return
    this.setFileState(clientId, { state: 'parsing', stateText: model.fileStateText('parsing'), errorMessage: '' })
    try {
      const result = await this.request('imports.parseFile', {
        requestId: importApi.createRequestId(),
        importId: file.importId,
        fileID: fileID,
        timezoneOffsetMinutes: new Date().getTimezoneOffset()
      })
      if (result.duplicateImportId) {
        this.setFileState(clientId, {
          state: 'duplicate', stateText: model.fileStateText('duplicate'),
          importVersion: result.import && result.import.version || file.importVersion,
          errorMessage: '这份账单已经正式入账，不会再次创建交易'
        })
      } else if (result.import && result.import.state === 'failed') {
        this.setFileState(clientId, {
          state: 'failed', stateText: model.fileStateText('failed'),
          importVersion: result.import.version,
          errorMessage: ERROR_MESSAGES[result.import.errorCode] || '解析失败，请重试'
        })
      } else if (!result.batch || !result.batch.batchId) {
        this.setFileState(clientId, {
          state: 'failed', stateText: model.fileStateText('failed'),
          importVersion: result.import && result.import.version || file.importVersion,
          errorMessage: ERROR_MESSAGES.UNSUPPORTED_ACTION
        })
      } else {
        this.setFileState(clientId, {
          state: 'ready', stateText: model.fileStateText('ready'),
          importId: result.import && result.import.importId || file.importId,
          importVersion: result.import.version,
          batchId: result.batch && result.batch.batchId || '',
          sourceType: result.batch && result.batch.sourceType || '',
          summary: result.batch && result.batch.summary || null,
          errorMessage: ''
        })
      }
    } catch (error) {
      this.setFileState(clientId, {
        state: 'failed', stateText: model.fileStateText('failed'),
        errorMessage: publicError(error, '解析失败，请重试')
      })
    }
  },

  setFileState: function (clientId, patch) {
    this.setData({ files: model.updateFile(this.data.files, clientId, patch) })
  },

  syncUploadSummary: function () {
    this.setData({ uploadSummary: model.uploadSummary(this.data.files) })
  },

  retryFile: async function (event) {
    if (this.data.busy) return
    const clientId = event.currentTarget.dataset.id
    const file = this.data.files.find(function (item) { return item.clientId === clientId })
    if (!file) return
    this.setData({ phase: 'uploading', busy: true, errorMessage: '' })
    if (file.fileID) await this.parsePreparedFile(clientId, file.fileID)
    else await this.uploadAndParseFile(file)
    this.syncUploadSummary()
    this.setData({ phase: 'files_ready', busy: false })
  },

  removeFile: async function (event) {
    if (this.data.busy) return
    const clientId = event.currentTarget.dataset.id
    const file = this.data.files.find(function (item) { return item.clientId === clientId })
    if (!file) return
    this.setData({ busy: true })
    try {
      if (file.importId) {
        await this.request('imports.discardFile', {
          requestId: importApi.createRequestId(),
          importId: file.importId,
          version: file.importVersion || 1
        })
      }
      this._sourceFiles.delete(clientId)
      const remainingFiles = this.data.files.filter(function (item) { return item.clientId !== clientId })
      this.setData({
        files: remainingFiles,
        phase: remainingFiles.length ? this.data.phase : 'idle'
      })
      this.syncUploadSummary()
    } catch (error) {
      this.setData({ errorMessage: publicError(error, '移除文件失败') })
    }
    this.setData({ busy: false })
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
    const active = () => this._updateLoad === load && !load.cancelled
    this.setData({ phase: 'loading', busy: true, errorMessage: '', restoreUpdateId: restoreToFirstStep ? updateId : '', abandoningRestore: false })
    try {
      load.pending = this.request('financeUpdates.summary', { updateId: updateId })
      let view = await load.pending
      if (!active()) return
      if (view.update.status === 'review' && view.update.requiresReorganization) {
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

  toggleIssueSource: function () {
    this.setData({ issueSourceExpanded: !this.data.issueSourceExpanded })
  },

  switchReviewTab: function (event) {
    const tab = event.currentTarget.dataset.tab
    if (!['review', 'category'].includes(tab)) return
    this.setData({ activeReviewTab: tab })
    this.renderReview(true)
    if (tab === 'review' && this.data.activeReviewStatus === 'duplicate') this.loadDuplicateRecords()
  },

  switchCategoryStatus: function (event) {
    const status = event.currentTarget.dataset.status
    if (!['pending', 'completed', 'none'].includes(status)) return
    this.setData({ activeCategoryStatus: status })
    this.renderReview(true)
  },

  searchCategoryIssues: function (event) {
    const query = event.detail.value
    this.setData({ categoryQuery: query })
    this._reviewProjection = null
    this.renderReview(true)
  },

  reviewBeforeCategory: function (event) {
    this.setData({ activeReviewTab: 'review', activeReviewStatus: 'pending' })
    this.renderReview(true)
    if (event.currentTarget.dataset.id) this.openIssue(event)
  },

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

  switchReviewStatus: function (event) {
    const status = String(event.currentTarget.dataset.status || '')
    if (!['pending', 'completed', 'excluded', 'duplicate'].includes(status) || status === this.data.activeReviewStatus) return
    this.setData({ activeReviewStatus: status })
    this.renderReview(true)
    if (status === 'duplicate') this.loadDuplicateRecords()
  },

  toggleExcludedGroup: function (event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (!key) return
    this.setData({
      excludedReviewGroups: (this.data.excludedReviewGroups || []).map(function (group) {
        return group.key === key ? Object.assign({}, group, { expanded: !group.expanded }) : group
      })
    })
    this.renderReview(false)
  },

  buildAccountMappingState: function (issues, accounts, accountDrafts, accountMappingDrafts) {
    const self = this
    const summary = { total: issues.length, ready: 0, confirmed: 0, invalid: 0, create: 0, inline: 0, transfer: 0, open: 0, dirty: 0, pending: 0 }
    const mappings = issues.map(function (issue) {
      if (issue.issueType !== 'account_mapping') {
        summary.transfer += 1
        return Object.assign({}, issue, { inline: false })
      }
      summary.inline += 1
      if (issue.status === 'open') summary.open += 1
      const choices = model.accountChoiceOptions(
        accounts,
        accountDrafts,
        Boolean(issue.accountContext && issue.accountContext.recognized)
      )
      let draft = self._accountUiDrafts.get(issue.issueId)
      if (!draft) {
        const defaultIgnored = Boolean(issue.accountContext && issue.accountContext.defaultIgnored)
        const mappingDraft = (accountMappingDrafts || []).find(function (item) {
          return issue.subject && item.eventId === issue.subject.eventId && issue.accountContext &&
            item.sourceType === issue.accountContext.sourceType &&
            item.paymentMethodKey === issue.accountContext.paymentMethodKey
        })
        const resolvedAccountId = issue.status === 'resolved' && issue.accountContext && issue.accountContext.accountId
        const resolvedMode = defaultIgnored
          ? 'ignore_future'
          : mappingDraft && mappingDraft.mappingAction === 'ignore'
          ? 'ignore_future'
          : resolvedAccountId ? 'account' : issue.status === 'resolved' ? 'ignore' : ''
        const suggestedName = issue.accountContext && issue.accountContext.recognized
          ? issue.accountContext.label
          : ''
        const suggestedAccount = defaultIgnored ? null : model.suggestExistingAccount(issue.accountContext, accounts)
        draft = {
          mode: resolvedMode || (suggestedAccount ? 'account' : suggestedName ? 'create' : 'pending'),
          accountId: resolvedAccountId || (suggestedAccount ? suggestedAccount.accountId : ''),
          recommendedAccountId: suggestedAccount ? suggestedAccount.accountId : '',
          name: suggestedName,
          typeIndex: suggestedAccountTypeIndex(issue.accountContext && issue.accountContext.label),
          dirty: false,
          localConfirmed: false,
          revision: 0
        }
        self._accountUiDrafts.set(issue.issueId, draft)
      }
      const choiceValue = draft.mode === 'account' ? 'account:' + draft.accountId : draft.mode
      let choiceIndex = choices.findIndex(function (choice) { return choice.value === choiceValue })
      if (choiceIndex < 0 && draft.accountId) {
        choices.push({ value: 'account:' + draft.accountId, name: draft.accountName || '已选择账户（可重新选择）' }); choiceIndex = choices.length - 1
      }
      if (choiceIndex < 0) {
        draft.mode = 'pending'
        draft.localConfirmed = false
    draft.revision = (draft.revision || 0) + 1
        draft.accountId = ''
        draft.recommendedAccountId = ''
        choiceIndex = 0
      }
      const ready = draft.mode === 'create' ? validAccountName(draft.name) && Boolean(ACCOUNT_TYPE_OPTIONS[draft.typeIndex]) : draft.mode !== 'pending'
      if (ready) summary.ready += 1
      else summary.invalid += 1
      if (draft.mode === 'create') summary.create += 1
      if (draft.dirty) summary.dirty += 1
      const needsConfirmation = !ready || ((issue.status === 'open' || draft.dirty) && !draft.localConfirmed)
      if (needsConfirmation) summary.pending += 1
      else summary.confirmed += 1
      return Object.assign({}, issue, {
        inline: true,
        needsConfirmation: needsConfirmation,
        canConfirm: ready,
        dirty: draft.dirty,
        summaryText: draft.mode === 'ignore' || draft.mode === 'ignore_future'
          ? choices[choiceIndex].name
          : '记入：' + (draft.mode === 'create' ? String(draft.name || '').trim() + '（' + (ACCOUNT_TYPE_OPTIONS[draft.typeIndex] || {}).label + '）' : choices[choiceIndex].name) + ' · 已确认',
        evidencePreview: issue.subject ? model.accountEvidenceView(issue.subject) : null,
        choiceOptions: choices,
        choiceIndex: choiceIndex,
        choiceValue: choices[choiceIndex].value,
        choiceName: issue.paymentNeedsReview && issue.status === 'open' ? '确认付款账户' : choices[choiceIndex].name,
        suggestedExisting: Boolean(draft.recommendedAccountId && draft.mode === 'account' &&
          draft.accountId === draft.recommendedAccountId),
        recommendedAccountId: draft.recommendedAccountId,
        allowFutureIgnore: Boolean(issue.accountContext && issue.accountContext.recognized),
        draftName: draft.name,
        draftNameValid: validAccountName(draft.name),
        draftTypeIndex: draft.typeIndex
      })
    })
    return { mappings: mappings, summary: summary }
  },

  openAccountChoice: function (event) {
    if (this.data.accountStepBusy) return
    const issueId = event.currentTarget.dataset.id
    if (this._draftSession && this._draftSession.state.flight && this._draftSession.state.flight.ids.includes(issueId)) {
      wx.showToast({ title: '此项正在同步，其他项可继续处理', icon: 'none' }); return
    }
    const mapping = this.data.accountMappings.find(function (item) { return item.issueId === issueId })
    const draft = issueId && this._accountUiDrafts.get(issueId)
    if (!mapping || !draft) return
    if (mapping.paymentNeedsReview && mapping.status === 'open') return this.openIssue(event)
    const options = model.accountSelectorOptions(this.data.accounts, this.data.accountDrafts)
    const recommendedAccount = mapping.recommendedAccountId
      ? options.find(function (option) { return option.accountId === mapping.recommendedAccountId }) || null
      : null
    const selectedValue = draft.mode === 'account' ? 'account:' + draft.accountId : draft.mode
    this.setData({
      accountChoiceSheet: {
        issueId: issueId,
        label: mapping.label,
        allowFutureIgnore: mapping.allowFutureIgnore,
        defaultIgnored: Boolean(mapping.accountContext && mapping.accountContext.defaultIgnored),
        selectedValue: selectedValue,
        recommendedAccount: recommendedAccount
      },
      accountChoiceQuery: '',
      accountChoiceResults: model.filterAccountSelectorOptions(
        options,
        '',
        recommendedAccount && recommendedAccount.accountId
      )
    })
  },

  closeAccountChoice: function () {
    this.setData({ accountChoiceSheet: null, accountChoiceQuery: '', accountChoiceResults: [] })
  },

  selectAccountChoice: function (event) {
    if (this.data.accountStepBusy) return
    const sheet = this.data.accountChoiceSheet
    const value = String(event.currentTarget.dataset.value || '')
    const draft = sheet && this._accountUiDrafts.get(sheet.issueId)
    if (!sheet || !draft || !value) return
    if (value === 'ignore_future' && !sheet.allowFutureIgnore) return
    if (value.indexOf('account:') === 0) {
      draft.mode = 'account'
      draft.accountId = value.slice('account:'.length)
      draft.recommendedAccountId = sheet.recommendedAccount &&
        sheet.recommendedAccount.accountId === draft.accountId ? draft.accountId : ''
    } else if (['create', 'ignore', 'ignore_future'].includes(value)) {
      draft.mode = value
      draft.accountId = ''
      draft.recommendedAccountId = ''
    } else {
      return
    }
    draft.dirty = true
    draft.localConfirmed = false
    draft.revision = (draft.revision || 0) + 1
    this.setData({
      accountStepError: '',
      accountChoiceSheet: null,
      accountChoiceQuery: '',
      accountChoiceResults: []
    })
    this.persistAccountDrafts()
    this.refreshAccountMappings()
  },

  preventTouchMove: function () {},

  loadAccountRecordEvidence: async function (records, token) {
    const isCurrent = () => this._accountEvidenceToken === token
    await this.loadRecordEvidence(records, isCurrent, () => {
      const count = this.data.accountRecordsSheet.records.length
      this.setData({ 'accountRecordsSheet.records': this._accountRecordList.slice(0, count) })
    })
    if (isCurrent()) this.setData({ 'accountRecordsSheet.sourcesLoading': false })
  },

  loadIssueRecordEvidence: async function (records, token) {
    const isCurrent = () => this._issueEvidenceToken === token && Boolean(this.data.currentIssue)
    await this.loadRecordEvidence(records, isCurrent, () => {
      this.setData({ issueVisibleEvents: this._issueEvidenceRecords.slice(0, this.data.issueVisibleEvents.length) })
    })
    if (isCurrent()) this.setData({ issueEvidenceLoading: false })
  },

  showMoreIssueRecords: function () {
    if (this.data.issueEvidenceLoading || !this.data.currentIssue) return
    const previousCount = this.data.issueVisibleEvents.length
    const records = this._issueEvidenceRecords.slice(0, previousCount + 20)
    this.setData({ issueVisibleEvents: records, issueEvidenceLoading: true,
      issueEvidenceHasMore: records.length < this._issueEvidenceRecords.length })
    return this.loadIssueRecordEvidence(records.slice(previousCount), this._issueEvidenceToken)
  },

  retryIssueRecordEvidence: function (event) {
    if (this.data.issueEvidenceLoading || !this.data.currentIssue) return
    const record = this._issueEvidenceRecords.find(function (item) { return item.eventId === event.currentTarget.dataset.id })
    if (!record) return
    record.evidenceLoading = true
    record.evidenceError = ''
    this.setData({ issueEvidenceLoading: true,
      issueVisibleEvents: this._issueEvidenceRecords.slice(0, this.data.issueVisibleEvents.length) })
    return this.loadIssueRecordEvidence([record], this._issueEvidenceToken)
  },

  retryAccountRecordEvidence: function (event) {
    const sheet = this.data.accountRecordsSheet
    if (!sheet || sheet.sourcesLoading) return
    const record = this._accountRecordList.find(function (item) { return item.eventId === event.currentTarget.dataset.id })
    if (!record) return
    record.evidenceLoading = true
    record.evidenceError = ''
    this.setData({ 'accountRecordsSheet.sourcesLoading': true,
      'accountRecordsSheet.records': this._accountRecordList.slice(0, sheet.records.length) })
    return this.loadAccountRecordEvidence([record], this._accountEvidenceToken)
  },

  showMoreAccountRecords: function () {
    const sheet = this.data.accountRecordsSheet
    if (!sheet || this.data.busy || sheet.sourcesLoading) return
    const previousCount = sheet.records.length
    const records = (this._accountRecordList || []).slice(0, previousCount + 20)
    this.setData({ 'accountRecordsSheet.records': records, 'accountRecordsSheet.sourcesLoading': true,
      'accountRecordsSheet.hasMore': records.length < this._accountRecordList.length })
    return this.loadAccountRecordEvidence(records.slice(previousCount), this._accountEvidenceToken)
  },

  closeAccountRecords: function () {
    if (this.data.busy) return
    this._accountEvidenceToken = null
    this._accountRecordList = []
    this.setData({ accountRecordsSheet: null })
  },

  closeReviewSheet: function () {
    if (this.data.evidenceSheet) this.closeEvidence()
    else this.closeIssue()
  },

  bindAccountDraftName: function (event) {
    const draft = this._accountUiDrafts.get(event.currentTarget.dataset.id)
    if (!draft || this.data.accountStepBusy) return
    draft.name = event.detail.value
    draft.dirty = true
    draft.localConfirmed = false
    draft.revision = (draft.revision || 0) + 1
    this.setData({ accountStepError: '' })
    this.persistAccountDrafts()
    this.refreshAccountMappings()
  },

  changeAccountDraftType: function (event) {
    const draft = this._accountUiDrafts.get(event.currentTarget.dataset.id)
    if (!draft || this.data.accountStepBusy) return
    draft.typeIndex = Number(event.detail.value)
    draft.dirty = true
    draft.localConfirmed = false
    draft.revision = (draft.revision || 0) + 1
    this.setData({ accountStepError: '' })
    this.persistAccountDrafts()
    this.refreshAccountMappings()
  },

  completeAccountMapping: function (event) {
    if (this.data.busy || this.data.accountStepBusy || !this.data.update) return
    const issueId = event && event.currentTarget && event.currentTarget.dataset.id
    const mapping = this.refreshAccountMappings().mappings.find(function (item) { return item.issueId === issueId })
    if (!mapping || !mapping.inline || !mapping.canConfirm) {
      this.setData({ accountStepError: '请选择账户归属；选择新建时，请补全账户名称' })
      return
    }
    const draft = this._accountUiDrafts.get(issueId)
    draft.localConfirmed = true
    if (this._draftSession) {
      try {
        this._draftSession.enqueue([{ kind: 'account', issueId: issueId, issueVersion: mapping.version, revision: draft.revision || 0,
          decision: this.accountMappingDecision(mapping) }], Object.fromEntries(this._accountUiDrafts))
      } catch (error) {
        draft.localConfirmed = false
        this.setData({ accountStepError: publicError(error, '本机草稿未保存，请重试') })
        this.refreshAccountMappings()
        return
      }
    }
    this.setData({ accountStepError: '' })
    this.refreshAccountMappings()
  },

  persistAccountDrafts: function () {
    if (!this._draftSession) return
    try { this._draftSession.saveDrafts(Object.fromEntries(this._accountUiDrafts), this.data.currentStep) }
    catch (error) {
      this._accountUiDrafts = new Map(Object.entries(JSON.parse(JSON.stringify(this._draftSession.state.drafts))))
      this.setData({ accountStepError: publicError(error, '本机草稿未保存，请检查存储空间后重试') })
    }
  },

  accountMappingDecision: function (mapping) {
    const draft = this._accountUiDrafts.get(mapping.issueId)
    const decision = { issueId: mapping.issueId, issueVersion: mapping.version, operation: mapping.status === 'resolved' ? 'revise' : 'resolve' }
    if (draft.mode === 'ignore' || draft.mode === 'ignore_future') {
      decision.decision = 'exclude_events'
      if (draft.mode === 'ignore_future') decision.paymentRuleAction = 'ignore'
    } else {
      decision.decision = 'apply_fields'
      decision.fields = draft.mode === 'account' ? { mappingAccountId: draft.accountId } : {
        mappingAccountDraft: { name: String(draft.name || '').normalize('NFKC').trim().replace(/\s+/g, ' '),
          type: ACCOUNT_TYPE_OPTIONS[draft.typeIndex].value, currency: 'CNY' }
      }
    }
    return decision
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
      this.applyUpdateView(session.view, true)
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

  openIssue: async function (event) {
    if (this.data.busy) return
    const issueId = event.currentTarget.dataset.id
    const token = {}
    this._issueEvidenceToken = token
    this.setData({ busy: true, errorMessage: '' })
    try {
      const details = await this.request('reviewIssues.get', { issueId: issueId })
      if (this._issueEvidenceToken !== token) return
      const eventMembers = details.members.filter(function (member) { return member.event })
      const relationMembers = details.members.filter(function (member) { return member.relation })
      const firstEvent = eventMembers[0] && eventMembers[0].event
      const summaryIssue = this.businessData().issues.find(function (issue) { return issue.issueId === issueId })
      const draftChoices = (details.accountDrafts || []).map(function (account) {
        return Object.assign({}, account, { name: account.name + '（本批新建）', isDraft: true })
      })
      const selectableAccounts = details.accounts.concat(draftChoices)
      const isTransferIssue = details.issue.issueType === 'transfer_accounts'
      const issueAccountContext = details.issue.accountContext || summaryIssue && summaryIssue.accountContext || null
      const suggestedTransferAccount = firstEvent && firstEvent.fundsProjection
        ? model.suggestExistingAccount(issueAccountContext, selectableAccounts)
        : null
      const projectedMissingTo = Boolean(firstEvent && firstEvent.fundsProjection &&
        firstEvent.ledgerAccountId && !firstEvent.counterpartyLedgerAccountId)
      const selectorAccountId = (projectedMissingTo
        ? firstEvent.counterpartyLedgerAccountId
        : firstEvent && firstEvent.ledgerAccountId) || (!isTransferIssue && suggestedTransferAccount && suggestedTransferAccount.accountId)
      const ownershipTarget = Boolean(isTransferIssue && firstEvent && firstEvent.repaymentOwnershipRequired)
      const accountChoices = isTransferIssue
        ? [{ accountId: '', name: '请选择账户', isPlaceholder: true }]
          .concat(ownershipTarget ? selectableAccounts.filter(function (account) { return ['credit', 'other_liability'].includes(account.type) }) : selectableAccounts)
          .concat([{ accountId: '', name: '新建账户', isCreate: true }])
        : [{ accountId: '', name: '新建账户', isCreate: true }].concat(selectableAccounts)
      const existingAccountIndex = accountChoices.findIndex(function (account) {
        return selectorAccountId && account.accountId === selectorAccountId
      })
      const accountIndex = existingAccountIndex < 0 ? 0 : existingAccountIndex
      const counterpartyAccountChoices = [{ accountId: '', name: '请选择转入账户', isPlaceholder: true }].concat(selectableAccounts)
      const counterpartyAccountIndex = Math.max(0, counterpartyAccountChoices.findIndex(function (account) {
        return firstEvent && firstEvent.counterpartyLedgerAccountId && account.accountId === firstEvent.counterpartyLedgerAccountId
      }))
      const natureIndex = Math.max(0, NATURE_OPTIONS.findIndex(function (nature) {
        return firstEvent && nature.value === firstEvent.economicNature
      }))
      const selectedNature = NATURE_OPTIONS[natureIndex] && NATURE_OPTIONS[natureIndex].value
      const compatibleCategories = model.categoriesForNature(details.categories, selectedNature)
      const issueCategories = [{ categoryId: '', name: '请选择分类', isPlaceholder: true }].concat(compatibleCategories)
      const compatibleCategoryIndex = Math.max(0, issueCategories.findIndex(function (category) {
        return firstEvent && category.categoryId === firstEvent.categoryId
      }))
      const relationChoices = relationMembers.map(function (member) {
        return model.relationChoiceView(member.relation.targetEvent, member.relation)
      })
      const selectedRefundTargetId = relationChoices.length === 1 ? relationChoices[0].targetEventId : ''
      const currentIssue = model.issueView(Object.assign({}, details.issue, {
        accountContext: issueAccountContext,
        subject: details.issue.subject || summaryIssue && summaryIssue.subject || firstEvent || null
      }))
      const bankSuggestion = isTransferIssue
        ? model.bankAccountSuggestion(eventMembers.map(function (member) { return member.event }), selectableAccounts)
        : null
      const bankBatchCandidates = bankSuggestion && !currentIssue.repaymentOwnershipRequired ? this.businessData().issues.filter(function (issue) {
        if (issue.issueId === issueId || issue.issueType !== 'transfer_accounts' || issue.status !== 'open') return false
        const suggestion = model.bankAccountSuggestion(issue.subjects || (issue.subject ? [issue.subject] : []), selectableAccounts)
        return suggestion && suggestion.key === bankSuggestion.key
      }).map(function (issue) { return { issueId: issue.issueId } }) : []
      const accountNames = new Map(selectableAccounts.map(function (account) { return [account.accountId, account.name] }))
      if (currentIssue.fundsProjection && firstEvent) {
        currentIssue.fundsRoute = {
          fromName: accountNames.get(firstEvent.ledgerAccountId) || currentIssue.fundsProjection.from.label,
          toName: accountNames.get(firstEvent.counterpartyLedgerAccountId) || currentIssue.fundsProjection.to.label,
          fromKnown: Boolean(firstEvent.ledgerAccountId),
          toKnown: Boolean(firstEvent.counterpartyLedgerAccountId)
        }
        currentIssue.suggestedExisting = Boolean(suggestedTransferAccount)
      }
      const existingAllocations = new Map((firstEvent && firstEvent.repaymentAllocations || []).map(function (item) {
        return [item.accountId, item.amountMinor]
      }))
      const repaymentAccountOptions = currentIssue.aggregateRepayment
        ? model.repaymentAllocationOptions(details.accounts, draftChoices, currentIssue.fundsProjection, firstEvent) : []
      const repaymentAllocationChoices = repaymentAccountOptions.filter(function (account) {
        return account.recommended || existingAllocations.has(account.accountId)
      }).map(function (account) {
        const amountMinor = existingAllocations.get(account.accountId)
        return Object.assign({}, account, { amountInput: amountMinor ? minorToYuanInput(amountMinor) : '' })
      })
      existingAllocations.forEach(function (amount, accountId) {
        if (!repaymentAllocationChoices.some(function (row) { return row.accountId === accountId })) {
          repaymentAllocationChoices.push({ accountId: accountId, name: '原账户已不可用', unavailable: true, amountInput: minorToYuanInput(amount) })
        }
      })
      const repaymentStatus = allocationStatus(repaymentAllocationChoices, firstEvent && firstEvent.amountMinor || '0')
      const evidenceEvents = eventMembers.map(function (member) { return { event: member.event, role: '待处理记录' } })
      const evidenceIds = new Set(evidenceEvents.map(function (item) { return item.event.eventId }))
      relationMembers.forEach(function (member) {
        const target = member.relation.targetEvent
        if (target && target.eventId && !evidenceIds.has(target.eventId)) {
          evidenceIds.add(target.eventId)
          evidenceEvents.push({ event: target, role: '候选原消费' })
        }
      })
      this._issueEvidenceRecords = evidenceEvents.map(function (item) {
        return Object.assign({}, model.eventView(item.event), { recordRole: item.role,
          evidenceLoading: true, evidenceError: '', evidence: [] })
      })
      const paymentDefaults = model.paymentResolutionDefaults(firstEvent, selectableAccounts)
      this.setData({
        busy: false,
        issueVisibleEvents: this._issueEvidenceRecords.slice(0, 20),
        issueEvidenceTotal: this._issueEvidenceRecords.length,
        issueEvidenceLoading: true,
        issueEvidenceHasMore: this._issueEvidenceRecords.length > 20,
        update: details.update,
        currentIssue: currentIssue,
        issueSourceExpanded: false,
        issueFieldsReason: '',
        paymentValidationHint: '',
        paymentRows: paymentDefaults.rows,
        paymentAccountChoices: [{ accountId: '', name: '请选择资金账户' }].concat(selectableAccounts),
        paymentTargetChoices: [{ accountId: '', name: '请选择被还款账户' }].concat(selectableAccounts.filter(function (a) { return ['credit', 'other_liability'].includes(a.type) })),
        paymentNatureIndex: paymentDefaults.natureIndex, paymentTargetIndex: Math.max(0, [{ accountId: '' }].concat(selectableAccounts.filter(function (a) { return ['credit', 'other_liability'].includes(a.type) })).findIndex(function (a) { return a.accountId === (firstEvent && firstEvent.counterpartyLedgerAccountId) })), paymentEvidenceNote: '', paymentCanSave: false,
        paymentDifferenceText: '请逐项填写实际支付金额；合计须等于 ' + model.amountText(firstEvent && firstEvent.amountMinor),
        bankSuggestion: bankSuggestion,
        bankBatchCandidates: bankBatchCandidates,
        bankBatchExpanded: false,
        bankBatchLoading: false,
        bankBatchRecords: [],
        bankBatchSelectedCount: 0,
        currentMembers: details.members,
        issueEvents: eventMembers.map(function (member) { return model.eventView(member.event) }),
        issueRelations: relationChoices,
        repaymentAllocationChoices: repaymentAllocationChoices,
        repaymentAccountOptions: repaymentAccountOptions,
        repaymentAdditionalOptions: additionalRepaymentOptions(repaymentAccountOptions, repaymentAllocationChoices),
        repaymentAdditionalIndex: 0,
        repaymentAllocationStatusText: currentIssue.aggregateRepayment ? repaymentStatus.text : '',
        repaymentAllocationCanSave: currentIssue.aggregateRepayment ? repaymentStatus.state.valid : true,
        accounts: selectableAccounts,
        accountDrafts: details.accountDrafts || [],
        accountChoices: accountChoices,
        counterpartyAccountChoices: counterpartyAccountChoices,
        categories: details.categories,
        issueCategories: issueCategories,
        issueCategoryCanSave: Boolean(issueCategories[compatibleCategoryIndex] && issueCategories[compatibleCategoryIndex].categoryId),
        issueDraft: {
          accountIndex: accountIndex,
          counterpartyAccountIndex: counterpartyAccountIndex,
          categoryIndex: compatibleCategoryIndex,
          natureIndex: natureIndex,
          primaryEventId: firstEvent && firstEvent.eventId || '',
          targetEventId: selectedRefundTargetId,
          newAccountName: summaryIssue && summaryIssue.accountContext && summaryIssue.accountContext.recognized
            ? Array.from(summaryIssue.accountContext.label.trim()).slice(0, 32).join('')
            : '',
          accountTypeIndex: currentIssue.repaymentOwnershipRequired ? 3 : 2,
          repaymentOwner: firstEvent && firstEvent.repaymentOwnership && firstEvent.repaymentOwnership.owner || '',
          repaymentOtherTreatment: firstEvent && firstEvent.repaymentOwnership && firstEvent.repaymentOwnership.treatment || ''
        }
      })
      this.restoreReviewDraft(issueId)
      this.refreshIssueFieldsDraft()
      if (currentIssue.paymentNeedsReview) this.refreshPaymentDraft()
      await this.loadIssueRecordEvidence(this._issueEvidenceRecords.slice(0, 20), token)
    } catch (error) {
      if (this._issueEvidenceToken !== token) return
      this.setData({ busy: false, errorMessage: publicError(error, '问题详情加载失败') })
    }
  },

  closeIssue: function () {
    if (!this.data.busy) {
      this.finishInputEditing()
      this._issueEvidenceToken = null
      this._issueEvidenceRecords = []
      this.setData({ currentIssue: null, currentMembers: [], evidenceSheet: null, issueVisibleEvents: [] })
    }
  },

  backFinalDetail: function () {
    if (this.data.finalDetailParent) this.setData({ finalDetailSheet: this.prepareFinalDetail(this.data.finalDetailParent), finalDetailParent: null })
    else this.closeFinalDetail()
  },

  prepareFinalDetail: function (kind, accountId, index) {
    this._finalDetail = buildFinalDetail(kind, this.businessData(), accountId)
    return presentation.detailWindow(this._finalDetail, index)
  },

  closeFinalDetail: function () { this._finalDetail = null; this.setData({ finalDetailSheet: null, finalDetailParent: null }) },

  closeEvidence: function () {
    this._evidenceReadToken = null
    this.setData({ busy: false, evidenceSheet: null })
  },

  beginInputEditing: function (event) {
    this._editingInput = event.currentTarget.dataset.inputKey
  },

  finishInputEditing: function () {
    this._editingInput = ''
    const pending = this._pendingBackgroundView
    this._pendingBackgroundView = null
    if (pending && this.data.update && pending.update.updateId === this.data.update.updateId) this.applyUpdateView(pending, true)
  },

  refreshIssueFieldsDraft: function () {
    const state = model.buildIssueFieldsDraft(this.data)
    setChangedData(this, { issueFieldsCanSave: state.valid, issueFieldsReason: state.valid ? '' : state.reason })
    return state
  },

  changeRepaymentOwner: function (event) {
    if (this.data.busy) return
    const owner = event.currentTarget.dataset.owner
    if (!['self', 'other'].includes(owner) || owner === this.data.issueDraft.repaymentOwner) return
    this.setData({ 'issueDraft.repaymentOwner': owner, 'issueDraft.repaymentOtherTreatment': '',
      'issueDraft.accountIndex': 0, 'issueDraft.newAccountName': '', 'issueDraft.accountTypeIndex': 3,
      bankBatchSelectedCount: 0, bankBatchExpanded: false, bankBatchRecords: [] })
    this.refreshIssueFieldsDraft()
  },

  changeRepaymentOtherTreatment: function (event) {
    if (this.data.busy || this.data.issueDraft.repaymentOwner !== 'other') return
    const treatment = event.currentTarget.dataset.treatment
    if (!['expense', 'pending'].includes(treatment)) return
    this.setData({ 'issueDraft.repaymentOtherTreatment': treatment })
    this.refreshIssueFieldsDraft()
  },

  changeIssueAccount: function (event) {
    this.setData({ 'issueDraft.accountIndex': Number(event.detail.value), bankBatchSelectedCount: 0,
      bankBatchRecords: (this.data.bankBatchRecords || []).map(function (item) { return Object.assign({}, item, { selected: false }) }) })
    this.refreshIssueFieldsDraft()
  },

  refreshPaymentDraft: function () {
    if (this.data.currentIssue && this.data.currentIssue.paymentAccountsOnly) {
      const rows = this.data.paymentRows
      const valid = rows.length >= 2 && rows.every(function (row) { return Boolean(row.accountId) }) && new Set(rows.map(function (row) { return row.accountId })).size === rows.length
      this.setData({ paymentCanSave: valid, paymentValidationHint: valid ? '' : '请选择至少两个不同的付款账户' })
      return { valid: valid, accounts: rows.map(function (row) { return { componentIndex: row.componentIndex, accountId: row.accountId } }) }
    }
    const nature = ['', 'expense', 'repayment'][this.data.paymentNatureIndex]
    const target = (this.data.paymentTargetChoices || [])[this.data.paymentTargetIndex]
    const state = model.buildPaymentResolutionDraft(this.data.paymentRows, nature, target && target.accountId,
      this.data.paymentEvidenceNote, this.data.issueEvents[0] && this.data.issueEvents[0].amountMinor)
    // 提示只解释已有校验结果，不能反过来决定是否可保存。
    const hint = state.valid ? ''
      : !String(this.data.paymentEvidenceNote || '').trim() && state.remainingMinor === '0'
        ? '金额已分配，请补全交易性质、账户及核对说明'
        : '请核对付款账户、分配金额、交易性质及必填说明'
    this.setData({ paymentCanSave: state.valid, paymentValidationHint: hint,
      paymentDifferenceText: state.remainingMinor === '0' ? '已分配完成' :
        (String(state.remainingMinor).startsWith('-') ? '超出 ' : '还差 ') + model.amountText(String(state.remainingMinor).replace('-', '')) })
    return state
  },
  changePaymentRow: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const field = event.currentTarget.dataset.field
    if (this.data.busy) return
    const rows = field === 'amount' ? model.updatePaymentAmounts(this.data.paymentRows, index, event.detail.value,
      this.data.issueEvents[0] && this.data.issueEvents[0].amountMinor) : this.data.paymentRows.map(function (row, i) {
      if (i !== index) return row
      if (field === 'account') {
        const accountIndex = Number(event.detail.value)
        const account = this.data.paymentAccountChoices[accountIndex]
        return Object.assign({}, row, { accountIndex: accountIndex, accountId: account && account.accountId || '' })
      }
      return Object.assign({}, row, { amountInput: event.detail.value })
    }.bind(this))
    setChangedData(this, { paymentRows: rows }); this.refreshPaymentDraft()
  },
  fillPaymentAmount: function (event) {
    if (this.data.busy) return
    this.setData({ paymentRows: model.updatePaymentAmounts(this.data.paymentRows, Number(event.currentTarget.dataset.index), '',
      this.data.issueEvents[0] && this.data.issueEvents[0].amountMinor, true) })
    this.refreshPaymentDraft()
  },
  changePaymentNature: function (event) { this.setData({ paymentNatureIndex: Number(event.detail.value) }); this.refreshPaymentDraft() },
  changePaymentTarget: function (event) { this.setData({ paymentTargetIndex: Number(event.detail.value) }); this.refreshPaymentDraft() },
  changePaymentNote: function (event) { this.setData({ paymentEvidenceNote: event.detail.value }); this.refreshPaymentDraft() },

  selectBankSuggestion: function (event) {
    if (this.data.busy) return
    const accountIndex = this.data.accountChoices.findIndex(function (account) {
      return account.accountId === event.currentTarget.dataset.id
    })
    if (accountIndex > 0) this.changeIssueAccount({ detail: { value: accountIndex } })
  },

  toggleBankBatch: function (event) {
    if (this.data.busy || this.data.bankBatchLoading) return
    const account = (this.data.accountChoices || [])[this.data.issueDraft.accountIndex]
    if (!account || !account.accountId) {
      this.setData({ errorMessage: '请先选择要应用的账户' })
      return
    }
    const rows = this.data.bankBatchRecords.map(function (row) {
      if (row.issueId !== event.currentTarget.dataset.id || !row.readable) return row
      if (!account || !row.candidateIds.includes(account.accountId)) return row
      return Object.assign({}, row, { selected: !row.selected })
    })
    this.setData({ bankBatchRecords: rows, bankBatchSelectedCount: rows.filter(function (row) { return row.selected }).length })
  },

  resolveBankBatch: async function (fields) {
    if (!this._draftSession) return
    const issue = this.data.currentIssue
    const side = this.data.bankSuggestion.side === 'to' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId'
    const entries = [this.reviewDraftEntry(issue, 'apply_fields', { fields: fields })]
    for (const row of this.data.bankBatchRecords.filter(function (item) { return item.selected })) {
      const source = this.businessData().issues.find(function (item) { return item.issueId === row.issueId })
      if (!source || source.version !== row.version) { this.setData({ errorMessage: '部分交易已变化，请重新选择' }); return }
      const selected = {}; selected[side] = fields[side]
      entries.push(this.reviewDraftEntry(source, 'apply_fields', { fields: selected }))
    }
    try { this._draftSession.enqueue(entries); this.closeIssue() }
    catch (error) { this.setData({ errorMessage: publicError(error, '选择未保存，请重试') }) }
  },

  refreshRepaymentChoices: function (choices) {
    const firstEvent = this.data.issueEvents[0]
    const status = allocationStatus(choices, firstEvent && firstEvent.amountMinor || '0')
    setChangedData(this, {
      repaymentAllocationChoices: choices,
      repaymentAdditionalOptions: additionalRepaymentOptions(this.data.repaymentAccountOptions, choices),
      repaymentAdditionalIndex: 0,
      repaymentAllocationStatusText: status.text,
      repaymentAllocationCanSave: status.state.valid,
      errorMessage: ''
    })
  },

  addRepaymentAccount: function (event) {
    if (this.data.busy || this.data.repaymentAllocationChoices.length >= 20) return
    const option = this.data.repaymentAdditionalOptions[Number(event.detail.value)]
    if (!option || option.isPlaceholder) return
    const row = option.isCreate ? { accountId: 'new-' + Date.now(), name: '', isNew: true, amountInput: '' } : option
    this.refreshRepaymentChoices(this.data.repaymentAllocationChoices.concat([row]))
  },

  removeRepaymentAccount: function (event) {
    if (this.data.busy) return
    const index = Number(event.currentTarget.dataset.index)
    this.refreshRepaymentChoices(this.data.repaymentAllocationChoices.filter(function (_, itemIndex) { return itemIndex !== index }))
  },

  changeRepaymentAccountName: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    this.refreshRepaymentChoices(this.data.repaymentAllocationChoices.map(function (item, itemIndex) {
      return itemIndex === index ? Object.assign({}, item, { name: event.detail.value }) : item
    }))
  },

  changeRepaymentAllocation: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    this.refreshRepaymentChoices(this.data.repaymentAllocationChoices.map(function (item, itemIndex) {
      return itemIndex === index ? Object.assign({}, item, { amountInput: event.detail.value }) : item
    }))
  },

  fillRepaymentAllocation: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const firstEvent = this.data.issueEvents[0]
    this.refreshRepaymentChoices(this.data.repaymentAllocationChoices.map(function (item, itemIndex) {
      return Object.assign({}, item, { amountInput: itemIndex === index ? minorToYuanInput(firstEvent && firstEvent.amountMinor || '0') : '' })
    }))
  },

  changeCounterpartyAccount: function (event) {
    this.setData({ 'issueDraft.counterpartyAccountIndex': Number(event.detail.value) })
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
      issueCategoryCanSave: Boolean(category && category.categoryId)
    })
    this.refreshIssueFieldsDraft()
  },

  changeIssueNature: function (event) {
    const natureIndex = Number(event.detail.value)
    const nature = NATURE_OPTIONS[natureIndex] && NATURE_OPTIONS[natureIndex].value
    this.setData({
      'issueDraft.natureIndex': natureIndex,
      'issueDraft.categoryIndex': 0,
      issueCategoryCanSave: false,
      issueCategories: [{ categoryId: '', name: '请选择分类', isPlaceholder: true }]
        .concat(model.categoriesForNature(this.data.categories, nature))
    })
    this.refreshIssueFieldsDraft()
  },

  selectPrimaryEvent: function (event) {
    this.setData({ 'issueDraft.primaryEventId': event.currentTarget.dataset.id })
  },


  selectTargetRelation: function (event) {
    this.setData({ 'issueDraft.targetEventId': event.currentTarget.dataset.id })
  },

  resolveWithFields: function () {
    const issue = this.data.currentIssue
    if (!issue || this.data.busy || this.data.bankBatchLoading) return
    if (issue.paymentNeedsReview) {
      const state = this.refreshPaymentDraft()
      if (!state.valid) return
      return this.resolveIssue('apply_fields', { fields: issue.paymentAccountsOnly ? { paymentAccounts: state.accounts } : { paymentResolution: state.resolution } })
    }
    if (issue.aggregateRepayment) {
      const firstEvent = this.data.issueEvents[0]
      const allocation = model.buildRepaymentAllocationDraft(
        this.data.repaymentAllocationChoices,
        firstEvent && firstEvent.amountMinor
      )
      if (!allocation.valid) {
        this.setData({ errorMessage: allocation.reason || '请完成还款分配' })
        return
      }
      this.resolveIssue('apply_fields', { fields: { repaymentAllocations: allocation.allocations } })
      return
    }
    const state = this.refreshIssueFieldsDraft()
    if (!state.valid) {
      this.setData({ errorMessage: state.reason })
      return
    }
    const fields = state.fields
    if (!issue.repaymentOwnershipRequired && this.data.bankBatchSelectedCount > 0 && this.data.bankSuggestion) {
      return this.resolveBankBatch(fields)
    }
    return this.resolveIssue('apply_fields', { fields: fields })
  },

  confirmDistinct: function () {
    this.resolveIssue('confirm_distinct', {})
  },

  confirmSame: function () {
    this.resolveIssue('confirm_same', { primaryEventId: this.data.issueDraft.primaryEventId })
  },

  linkRefund: function () {
    if (!this.data.issueDraft.targetEventId) {
      this.setData({ errorMessage: '请选择这笔退款对应的原消费' })
      return
    }
    this.resolveIssue('link_refund', { targetEventId: this.data.issueDraft.targetEventId })
  },

  markRefundPending: function () {
    this.resolveIssue('mark_refund_pending', {})
  },

  confirmInstallment: function () {
    this.resolveIssue('confirm_installment_principal', { installmentCandidateId: this.data.issueDraft.primaryEventId })
  },

  reviewDraftEntry: function (issue, decision, extra) {
    const data = this.data
    const form = { issueDraft: data.issueDraft, paymentRows: data.paymentRows, paymentNatureIndex: data.paymentNatureIndex,
      paymentEvidenceNote: data.paymentEvidenceNote, repaymentAllocationChoices: data.repaymentAllocationChoices,
      accountId: ((data.accountChoices || [])[data.issueDraft.accountIndex] || {}).accountId,
      counterpartyAccountId: ((data.counterpartyAccountChoices || [])[data.issueDraft.counterpartyAccountIndex] || {}).accountId,
      categoryId: ((data.issueCategories || [])[data.issueDraft.categoryIndex] || {}).categoryId,
      paymentTargetId: ((data.paymentTargetChoices || [])[data.paymentTargetIndex] || {}).accountId }
    return { kind: 'review', issueId: issue.issueId, issueVersion: issue.version, issueType: issue.issueType,
      subjectIds: issue.subjectEventIds || (this.data.issueEvents || []).map(function (event) { return event.eventId }),
      decision: Object.assign({ decision: decision }, extra || {}), form: form }
  },

  restoreReviewDraft: function (issueId) {
    if (!this._draftSession) return
    const entry = this._draftSession.state.entries.concat(this._draftSession.state.conflictedChoices || []).find(function (item) { return item.issueId === issueId })
    if (!entry || !entry.form) return
    const form = entry.form
    const indexOf = function (options, key, value) { return Math.max(0, (options || []).findIndex(function (item) { return value && item[key] === value })) }
    this.setData({ issueDraft: Object.assign({}, form.issueDraft, {
      accountIndex: indexOf(this.data.accountChoices, 'accountId', form.accountId),
      counterpartyAccountIndex: indexOf(this.data.counterpartyAccountChoices, 'accountId', form.counterpartyAccountId),
      categoryIndex: indexOf(this.data.issueCategories, 'categoryId', form.categoryId) }),
      paymentRows: form.paymentRows || [], paymentNatureIndex: form.paymentNatureIndex || 0,
      paymentTargetIndex: indexOf(this.data.paymentTargetChoices, 'accountId', form.paymentTargetId),
      paymentEvidenceNote: form.paymentEvidenceNote || '', repaymentAllocationChoices: form.repaymentAllocationChoices || [] })
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
    if (!issue || this.data.busy) return
    try {
      this._draftSession.enqueue([this.reviewDraftEntry(issue, decision, extra)])
      this.closeIssue()
    } catch (error) { this.setData({ errorMessage: publicError(error, '选择未保存，请重试') }) }
  },

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
    this._duplicateLoadToken = null
    this.setData({
      phase: 'idle', currentStep: 1, unlockedStep: 1, busy: false, restoreUpdateId: '', abandoningRestore: false,
      files: [], update: null, sources: [], events: [], issues: [], fundsFlowGroups: [], finalDetailSheet: null, finalDetailParent: null,
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
      uploadSummary: { total: 0, queued: 0, ready: 0, failed: 0, attention: 0 },
      posting: null, errorMessage: '', currentIssue: null, currentMembers: [],
      issueEvents: [], issueRelations: [], evidenceSheet: null,
      repaymentAllocationChoices: [], repaymentAllocationStatusText: '', repaymentAllocationCanSave: false
    })
    this._accountUiDrafts.clear()
  }
}))
