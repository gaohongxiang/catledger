const importApi = require('../../services/catledger-import')
const cloudUpload = require('../../services/cloud-upload-policy')
const loginGuard = require('../../services/login-guard')
const themeService = require('../../theme/service')
const model = require('./model')

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
  if (/信用|花呗|白条|贷/.test(value)) return 3
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

Page({
  data: {
    phase: 'idle',
    maxFiles: MAX_FILES,
    currentStep: 1,
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
    accountStepSummary: { total: 0, ready: 0, confirmed: 0, invalid: 0, create: 0, inline: 0, transfer: 0, open: 0, dirty: 0 },
    accountStepBusy: false,
    accountStepError: '',
    accountStepProgressText: '',
    reviewIssues: [],
    reviewGroups: [],
    reviewStatusTabs: [
      { value: 'pending', label: '待整理', count: 0 },
      { value: 'excluded', label: '已排除', count: 0 },
      { value: 'duplicate', label: '重复记录', count: 0 }
    ],
    activeReviewStatus: 'pending',
    excludedReviewGroups: [],
    duplicateReviewEvents: [],
    openIssueCount: 0,
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
    finalSummary: {
      expenseText: '¥0.00', incomeText: '¥0.00', refundText: '¥0.00', transferCount: 0,
      categoryCoverageText: '无需分类', categoryComplete: true, newAccountCount: 0, affectedAccountCount: 0
    },
    errorMessage: '',
    currentIssue: null,
    currentMembers: [],
    issueEvents: [],
    issueRelations: [],
    repaymentAllocationChoices: [],
    repaymentAllocationStatusText: '',
    repaymentAllocationCanSave: false,
    evidenceSheet: null,
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

  onLoad: function (options) {
    themeService.bindPage(this)
    this._requestIds = {}
    this._sourceFiles = new Map()
    this._accountUiDrafts = new Map()
    const updateId = options && options.updateId
    loginGuard.run(this, updateId ? this.loadUpdate.bind(this, updateId) : function () {})
  },

  onShow: function () {
    themeService.bindPage(this)
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
      const prepared = await importApi.callImport('imports.prepareMany', {
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
      const result = await importApi.callImport('imports.parseFile', {
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
        await importApi.callImport('imports.discardFile', {
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
      const view = await importApi.callImport('financeUpdates.prepare', {
        requestId: importApi.createRequestId(), batchIds: batchIds
      })
      this.applyUpdateView(view)
    } catch (error) {
      this.setData({ phase: 'files_ready', busy: false, errorMessage: publicError(error, '跨来源整理失败') })
    }
  },

  loadUpdate: async function (updateId) {
    this.setData({ phase: 'loading', busy: true, errorMessage: '' })
    try {
      let view = await importApi.callImport('financeUpdates.get', { updateId: updateId })
      if (view.update.status === 'review' && view.update.requiresReorganization) {
        view = await importApi.callImport('financeUpdates.organize', {
          requestId: importApi.createRequestId(), updateId: updateId, version: view.update.version
        })
      }
      this.applyUpdateView(view)
    } catch (error) {
      this.setData({ phase: 'error', busy: false, errorMessage: publicError(error, '整理结果加载失败') })
    }
  },

  applyUpdateView: function (view) {
    const issues = (view.issues || []).map(model.issueView)
    const openIssues = issues.filter(function (issue) { return issue.status === 'open' && issue.blocking })
    const issueGroups = model.partitionOpenIssues(openIssues)
    const workflow = model.workflowPosition(view.update.status, issueGroups)
    const events = (view.events || []).map(model.eventView)
    const accountIssues = issues.filter(function (issue) {
      return issue.issueType === 'account_mapping' && ['open', 'resolved'].includes(issue.status)
    })
    const accountState = this.buildAccountMappingState(
      accountIssues,
      view.accounts || [],
      view.accountDrafts || [],
      view.accountMappingDrafts || []
    )
    const reviewGroups = model.reviewIssueGroups(issueGroups.review)
    const reviewIssues = model.reviewIssueRows(issueGroups.review)
    const updateCounts = view.update.counts || {}
    const excludedReviewEvents = events.filter(function (event) {
      return event.status === 'excluded'
    })
    const expandedExcludedKeys = (this.data.excludedReviewGroups || []).filter(function (group) {
      return group.expanded
    }).map(function (group) { return group.key })
    const excludedReviewGroups = model.excludedEventGroups(excludedReviewEvents, expandedExcludedKeys)
    const duplicateReviewEvents = events.filter(function (event) {
      return Number(event.evidenceCount || 0) > 1
    }).map(function (event) {
      return Object.assign({}, event, {
        duplicateCount: Math.max(1, Number(event.evidenceCount || 0) - 1),
        auditNote: '相同证据已合并为一笔经济事件，不会重复入账。'
      })
    })
    const activeReviewStatus = ['pending', 'excluded', 'duplicate'].includes(this.data.activeReviewStatus)
      ? this.data.activeReviewStatus
      : 'pending'
    this.setData({
      phase: view.update.status === 'posted'
        ? 'done'
        : view.update.status === 'undone' ? 'undone' : view.update.status === 'abandoned' ? 'abandoned' : 'review',
      currentStep: workflow.currentStep,
      unlockedStep: workflow.unlockedStep,
      busy: false,
      update: view.update,
      sources: view.sources || [],
      events: events,
      issues: issues,
      accountIssues: accountIssues,
      accountMappings: accountState.mappings,
      accountStepSummary: accountState.summary,
      accountStepBusy: false,
      accountStepError: '',
      accountStepProgressText: '',
      reviewIssues: reviewIssues,
      reviewGroups: reviewGroups,
      reviewStatusTabs: [
        { value: 'pending', label: '待整理', count: reviewIssues.length },
        { value: 'excluded', label: '已排除', count: Number(updateCounts.excludedEvents || excludedReviewEvents.length) },
        { value: 'duplicate', label: '重复记录', count: Number(updateCounts.duplicateEvidence || 0) }
      ],
      activeReviewStatus: activeReviewStatus,
      excludedReviewGroups: excludedReviewGroups,
      duplicateReviewEvents: duplicateReviewEvents,
      openIssueCount: openIssues.length,
      accounts: view.accounts || this.data.accounts,
      accountDrafts: view.accountDrafts || this.data.accountDrafts,
      accountMappingDrafts: view.accountMappingDrafts || [],
      categories: view.categories || this.data.categories,
      finalSummary: model.finalSummary(events, view.accountDrafts || this.data.accountDrafts),
      posting: view.posting || null,
      errorMessage: '',
      accountChoiceSheet: null,
      accountChoiceQuery: '',
      accountChoiceResults: [],
      currentIssue: null,
      currentMembers: [],
      evidenceSheet: null
    })
  },

  viewTransactions: function () {
    wx.switchTab({ url: '/pages/transactions/index' })
  },

  viewStatistics: function () {
    wx.navigateTo({ url: '/pages/statistics/index' })
  },

  completeCategories: function () {
    wx.navigateTo({ url: '/pages/statistics/index?completeCategories=1' })
  },

  correctBalances: function () {
    wx.navigateTo({ url: '/pages/accounts/index' })
  },

  switchReviewStatus: function (event) {
    const status = String(event.currentTarget.dataset.status || '')
    if (!['pending', 'excluded', 'duplicate'].includes(status) || status === this.data.activeReviewStatus) return
    this.setData({ activeReviewStatus: status })
  },

  toggleExcludedGroup: function (event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (!key) return
    this.setData({
      excludedReviewGroups: (this.data.excludedReviewGroups || []).map(function (group) {
        return group.key === key ? Object.assign({}, group, { expanded: !group.expanded }) : group
      })
    })
  },

  buildAccountMappingState: function (issues, accounts, accountDrafts, accountMappingDrafts) {
    const self = this
    const summary = { total: issues.length, ready: 0, confirmed: 0, invalid: 0, create: 0, inline: 0, transfer: 0, open: 0, dirty: 0 }
    const mappings = issues.map(function (issue) {
      if (issue.issueType !== 'account_mapping') {
        summary.transfer += 1
        return Object.assign({}, issue, { inline: false })
      }
      summary.inline += 1
      if (issue.status === 'open') summary.open += 1
      else summary.confirmed += 1
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
        const resolvedMode = mappingDraft && mappingDraft.mappingAction === 'ignore'
          ? 'ignore_future'
          : resolvedAccountId ? 'account' : issue.status === 'resolved' ? 'ignore' : ''
        const suggestedName = issue.accountContext && issue.accountContext.recognized
          ? issue.accountContext.label
          : ''
        const suggestedAccount = defaultIgnored ? null : model.suggestExistingAccount(issue.accountContext, accounts)
        draft = {
          mode: resolvedMode || (suggestedAccount ? 'account' : 'create'),
          accountId: resolvedAccountId || (suggestedAccount ? suggestedAccount.accountId : ''),
          recommendedAccountId: suggestedAccount ? suggestedAccount.accountId : '',
          name: suggestedName,
          typeIndex: suggestedAccountTypeIndex(issue.accountContext && issue.accountContext.label),
          dirty: false
        }
        self._accountUiDrafts.set(issue.issueId, draft)
      }
      const choiceValue = draft.mode === 'account' ? 'account:' + draft.accountId : draft.mode
      let choiceIndex = choices.findIndex(function (choice) { return choice.value === choiceValue })
      if (choiceIndex < 0) {
        draft.mode = 'create'
        draft.accountId = ''
        draft.recommendedAccountId = ''
        choiceIndex = 0
      }
      const ready = draft.mode === 'create' ? validAccountName(draft.name) : true
      if (ready) summary.ready += 1
      else summary.invalid += 1
      if (draft.mode === 'create') summary.create += 1
      if (draft.dirty) summary.dirty += 1
      return Object.assign({}, issue, {
        inline: true,
        choiceOptions: choices,
        choiceIndex: choiceIndex,
        choiceValue: choices[choiceIndex].value,
        choiceName: choices[choiceIndex].name,
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

  refreshAccountMappings: function () {
    const state = this.buildAccountMappingState(
      this.data.accountIssues,
      this.data.accounts,
      this.data.accountDrafts,
      this.data.accountMappingDrafts
    )
    this.setData({ accountMappings: state.mappings, accountStepSummary: state.summary })
    return state
  },

  openAccountChoice: function (event) {
    if (this.data.accountStepBusy) return
    const issueId = event.currentTarget.dataset.id
    const mapping = this.data.accountMappings.find(function (item) { return item.issueId === issueId })
    const draft = issueId && this._accountUiDrafts.get(issueId)
    if (!mapping || !draft) return
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

  bindAccountChoiceSearch: function (event) {
    const sheet = this.data.accountChoiceSheet
    if (!sheet) return
    const query = event.detail.value
    const options = model.accountSelectorOptions(this.data.accounts, this.data.accountDrafts)
    this.setData({
      accountChoiceQuery: query,
      accountChoiceResults: model.filterAccountSelectorOptions(
        options,
        query,
        sheet.recommendedAccount && sheet.recommendedAccount.accountId
      )
    })
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
    this.setData({
      accountStepError: '',
      accountChoiceSheet: null,
      accountChoiceQuery: '',
      accountChoiceResults: []
    })
    this.refreshAccountMappings()
  },

  preventTouchMove: function () {},

  bindAccountDraftName: function (event) {
    const draft = this._accountUiDrafts.get(event.currentTarget.dataset.id)
    if (!draft || this.data.accountStepBusy) return
    draft.name = event.detail.value
    draft.dirty = true
    this.setData({ accountStepError: '' })
    this.refreshAccountMappings()
  },

  changeAccountDraftType: function (event) {
    const draft = this._accountUiDrafts.get(event.currentTarget.dataset.id)
    if (!draft || this.data.accountStepBusy) return
    draft.typeIndex = Number(event.detail.value)
    draft.dirty = true
    this.setData({ accountStepError: '' })
    this.refreshAccountMappings()
  },

  completeAccountMapping: async function () {
    if (this.data.accountStepBusy || !this.data.update) return
    const state = this.refreshAccountMappings()
    if (state.summary.invalid > 0) {
      this.setData({ accountStepError: '请补全账户名称，或改选已有账户 / 本次不计入账本' })
      return
    }
    const pending = state.mappings.filter(function (mapping) {
      const draft = this._accountUiDrafts.get(mapping.issueId)
      return mapping.inline && (mapping.status === 'open' || draft && draft.dirty)
    }, this)
    if (!pending.length) {
      wx.showToast({ title: '账户归属没有变化', icon: 'none' })
      return
    }
    this.setData({ accountStepBusy: true, busy: true, accountStepError: '' })
    try {
      const decisions = pending.map(function (mapping) {
        const draft = this._accountUiDrafts.get(mapping.issueId)
        const decision = {
          issueId: mapping.issueId,
          operation: mapping.status === 'resolved' ? 'revise' : 'resolve'
        }
        if (draft.mode === 'ignore' || draft.mode === 'ignore_future') {
          decision.decision = 'exclude_events'
          if (draft.mode === 'ignore_future') decision.paymentRuleAction = 'ignore'
        } else {
          decision.decision = 'apply_fields'
          if (draft.mode === 'account') {
            decision.fields = { mappingAccountId: draft.accountId }
          } else {
            const type = ACCOUNT_TYPE_OPTIONS[draft.typeIndex]
            const name = String(draft.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
            if (!type || !validAccountName(name)) throw new Error('账户信息不完整')
            decision.fields = { mappingAccountDraft: { name: name, type: type.value, currency: 'CNY' } }
          }
        }
        return decision
      }, this)
      this.setData({ accountStepProgressText: '正在保存账户归属…' })
      const view = await importApi.callImport('reviewIssues.resolveAccountMappings', {
        requestId: importApi.createRequestId(),
        updateId: this.data.update.updateId,
        decisions: decisions
      })
      for (const mapping of pending) {
        this._accountUiDrafts.delete(mapping.issueId)
      }
      this.applyUpdateView(view)
    } catch (error) {
      const message = publicError(error, '账户归属保存失败，请重试')
      await this.loadUpdate(this.data.update.updateId)
      this.setData({ busy: false, accountStepBusy: false, accountStepProgressText: '', accountStepError: message })
    }
  },

  goToStep: function (event) {
    if (this.data.busy) return
    const step = Number(event.currentTarget.dataset.step)
    if (!Number.isInteger(step) || step < 1 || step > this.data.unlockedStep) return
    this.setData({ currentStep: step, errorMessage: '', accountChoiceSheet: null })
  },

  openIssue: async function (event) {
    if (this.data.busy) return
    const issueId = event.currentTarget.dataset.id
    this.setData({ busy: true, errorMessage: '' })
    try {
      const details = await importApi.callImport('reviewIssues.get', { issueId: issueId })
      const eventMembers = details.members.filter(function (member) { return member.event })
      const relationMembers = details.members.filter(function (member) { return member.relation })
      const firstEvent = eventMembers[0] && eventMembers[0].event
      const summaryIssue = this.data.issues.find(function (issue) { return issue.issueId === issueId })
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
      const accountChoices = isTransferIssue
        ? [{ accountId: '', name: '请选择账户', isPlaceholder: true }]
          .concat(selectableAccounts)
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
      const repaymentAllocationChoices = currentIssue.aggregateRepayment
        ? model.repaymentAllocationOptions(details.accounts, draftChoices, currentIssue.fundsProjection).map(function (account) {
            const amountMinor = existingAllocations.get(account.accountId)
            return Object.assign({}, account, { amountInput: amountMinor ? minorToYuanInput(amountMinor) : '' })
          })
        : []
      const repaymentStatus = allocationStatus(repaymentAllocationChoices, firstEvent && firstEvent.amountMinor || '0')
      this.setData({
        busy: false,
        update: details.update,
        currentIssue: currentIssue,
        currentMembers: details.members,
        issueEvents: eventMembers.map(function (member) { return model.eventView(member.event) }),
        issueRelations: relationChoices,
        repaymentAllocationChoices: repaymentAllocationChoices,
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
          accountTypeIndex: 2
        }
      })
    } catch (error) {
      this.setData({ busy: false, errorMessage: publicError(error, '问题详情加载失败') })
    }
  },

  closeIssue: function () {
    if (!this.data.busy) {
      this.setData({ currentIssue: null, currentMembers: [], evidenceSheet: null })
    }
  },

  openEvidence: async function (event) {
    const eventId = event.currentTarget.dataset.id
    if (!eventId || this.data.busy) return
    this.setData({ busy: true, errorMessage: '' })
    try {
      const result = await importApi.callImport('economicEvents.evidence', { eventId: eventId })
      const roleLabels = { primary: '主记录', supporting: '关联记录', duplicate: '重复记录', discarded: '已舍弃证据' }
      const evidence = (result.evidence || []).map(function (item) {
        return Object.assign({}, item, {
          roleLabel: roleLabels[item.evidenceRole] || '原始交易',
          fields: model.evidenceFields(item.rawFields)
        })
      })
      this.setData({ busy: false, evidenceSheet: { eventId: eventId, evidence: evidence } })
    } catch (error) {
      this.setData({ busy: false, errorMessage: publicError(error, '原始交易加载失败') })
    }
  },

  closeEvidence: function () {
    if (!this.data.busy) this.setData({ evidenceSheet: null })
  },

  changeIssueAccount: function (event) {
    this.setData({ 'issueDraft.accountIndex': Number(event.detail.value) })
  },

  changeRepaymentAllocation: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const choices = this.data.repaymentAllocationChoices.map(function (item, itemIndex) {
      return itemIndex === index ? Object.assign({}, item, { amountInput: event.detail.value }) : item
    })
    const firstEvent = this.data.issueEvents[0]
    const status = allocationStatus(choices, firstEvent && firstEvent.amountMinor || '0')
    this.setData({
      repaymentAllocationChoices: choices,
      repaymentAllocationStatusText: status.text,
      repaymentAllocationCanSave: status.state.valid,
      errorMessage: ''
    })
  },

  fillRepaymentAllocation: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const firstEvent = this.data.issueEvents[0]
    const choices = this.data.repaymentAllocationChoices.map(function (item, itemIndex) {
      return Object.assign({}, item, {
        amountInput: itemIndex === index ? minorToYuanInput(firstEvent && firstEvent.amountMinor || '0') : ''
      })
    })
    const status = allocationStatus(choices, firstEvent && firstEvent.amountMinor || '0')
    this.setData({
      repaymentAllocationChoices: choices,
      repaymentAllocationStatusText: status.text,
      repaymentAllocationCanSave: status.state.valid,
      errorMessage: ''
    })
  },

  changeCounterpartyAccount: function (event) {
    this.setData({ 'issueDraft.counterpartyAccountIndex': Number(event.detail.value) })
  },

  changeDraftAccountName: function (event) {
    this.setData({ 'issueDraft.newAccountName': event.detail.value })
  },

  changeDraftAccountType: function (event) {
    this.setData({ 'issueDraft.accountTypeIndex': Number(event.detail.value) })
  },

  changeIssueCategory: function (event) {
    const categoryIndex = Number(event.detail.value)
    const category = this.data.issueCategories[categoryIndex]
    this.setData({
      'issueDraft.categoryIndex': categoryIndex,
      issueCategoryCanSave: Boolean(category && category.categoryId)
    })
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
  },

  selectPrimaryEvent: function (event) {
    this.setData({ 'issueDraft.primaryEventId': event.currentTarget.dataset.id })
  },

  openIssueEvent: function (event) {
    if (this.data.currentIssue && this.data.currentIssue.issueType === 'same_event') {
      this.selectPrimaryEvent(event)
      return
    }
    this.openEvidence(event)
  },

  selectTargetRelation: function (event) {
    this.setData({ 'issueDraft.targetEventId': event.currentTarget.dataset.id })
  },

  resolveWithFields: function () {
    const issue = this.data.currentIssue
    if (!issue) return
    const accountChoice = this.data.accountChoices[this.data.issueDraft.accountIndex]
    const counterparty = this.data.counterpartyAccountChoices[this.data.issueDraft.counterpartyAccountIndex]
    const category = this.data.issueCategories[this.data.issueDraft.categoryIndex]
    const nature = NATURE_OPTIONS[this.data.issueDraft.natureIndex]
    const fields = {}
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
    const projectedMissingSide = issue.issueType === 'transfer_accounts' && issue.missingFundsSide && issue.missingFundsSide !== 'both'
      ? issue.missingFundsSide
      : ''
    if (accountChoice && accountChoice.isPlaceholder) {
      this.setData({ errorMessage: '请选择需要确认的账户' })
      return
    } else if (accountChoice && accountChoice.accountId) {
      fields[projectedMissingSide === 'to' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId'] = accountChoice.accountId
    } else if (accountChoice && accountChoice.isCreate) {
      const accountType = ACCOUNT_TYPE_OPTIONS[this.data.issueDraft.accountTypeIndex]
      const name = String(this.data.issueDraft.newAccountName || '').trim()
      if (!name || !accountType) {
        this.setData({ errorMessage: '请填写新账户名称并选择类型' })
        return
      }
      fields[projectedMissingSide === 'to' ? 'counterpartyLedgerAccountDraft' : 'ledgerAccountDraft'] = {
        name: name, type: accountType.value, currency: 'CNY'
      }
    }
    if (issue.issueType === 'transfer_accounts' && !projectedMissingSide) {
      if (!counterparty || counterparty.isPlaceholder || !counterparty.accountId ||
          (fields.ledgerAccountId && fields.ledgerAccountId === counterparty.accountId)) {
        this.setData({ errorMessage: '请选择两个不同的转出和转入账户' })
        return
      }
      fields.counterpartyLedgerAccountId = counterparty.accountId
    }
    if (category && ['category_assignment', 'shared_fields', 'field_conflict'].includes(issue.issueType)) fields.categoryId = category.categoryId
    if (nature && ['shared_fields', 'field_conflict'].includes(issue.issueType)) {
      fields.economicNature = nature.value
      fields.flowDirection = nature.value === 'income' || nature.value === 'refund'
        ? 'inflow'
        : ['internal_transfer', 'repayment', 'borrow'].includes(nature.value) ? 'neutral' : 'outflow'
    }
    if (['category_assignment', 'shared_fields', 'field_conflict'].includes(issue.issueType) &&
        this.data.issueCategories.length && !fields.categoryId) {
      this.setData({ errorMessage: '请选择交易分类' })
      return
    }
    if (!fields.categoryId && !fields.ledgerAccountId && !fields.ledgerAccountDraft &&
        !fields.counterpartyLedgerAccountId && !fields.counterpartyLedgerAccountDraft) {
      this.setData({ errorMessage: '请选择需要确认的账户' })
      return
    }
    this.resolveIssue('apply_fields', { fields: fields })
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

  excludeIssueEvents: function () {
    this.resolveIssue('exclude_events', { eventIds: this.data.issueEvents.map(function (event) { return event.eventId }) })
  },

  confirmInstallment: function () {
    this.resolveIssue('confirm_installment_principal', { installmentCandidateId: this.data.issueDraft.primaryEventId })
  },

  resolveIssue: async function (decision, extra) {
    const issue = this.data.currentIssue
    if (!issue || this.data.busy) return
    this.setData({ busy: true, errorMessage: '' })
    try {
      await importApi.callImport('reviewIssues.resolve', Object.assign({
        requestId: importApi.createRequestId(),
        updateId: this.data.update.updateId,
        issueId: issue.issueId,
        updateVersion: this.data.update.version,
        issueVersion: issue.version,
        decision: decision
      }, extra || {}))
      await this.loadUpdate(this.data.update.updateId)
    } catch (error) {
      this.setData({ busy: false, errorMessage: publicError(error, '问题处理失败') })
    }
  },

  postUpdate: async function () {
    if (this.data.busy || !this.data.update || this.data.openIssueCount > 0) return
    this.setData({ busy: true, errorMessage: '' })
    try {
      const view = await importApi.callImport('financeUpdates.post', {
        requestId: importApi.createRequestId(),
        updateId: this.data.update.updateId,
        version: this.data.update.version,
        mode: 'all_ready'
      })
      this.applyUpdateView(view)
    } catch (error) {
      this.setData({ busy: false, errorMessage: publicError(error, '整批入账失败，所有交易均未写入') })
    }
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
      await importApi.callImport('financeUpdates.abandon', {
        requestId: importApi.createRequestId(),
        updateId: this.data.update.updateId,
        version: this.data.update.version
      })
      this.startAnother()
      wx.showToast({ title: '本批账单已放弃', icon: 'none' })
    } catch (error) {
      this.setData({ busy: false, errorMessage: publicError(error, '放弃失败，请重试') })
    }
  },

  startAnother: function () {
    this._sourceFiles.clear()
    this.setData({
      phase: 'idle', currentStep: 1, unlockedStep: 1,
      files: [], update: null, sources: [], events: [], issues: [],
      accountIssues: [], reviewIssues: [], reviewGroups: [], activeReviewStatus: 'pending', excludedReviewGroups: [], duplicateReviewEvents: [], openIssueCount: 0,
      reviewStatusTabs: [
        { value: 'pending', label: '待整理', count: 0 },
        { value: 'excluded', label: '已排除', count: 0 },
        { value: 'duplicate', label: '重复记录', count: 0 }
      ],
      accountMappings: [], accountStepSummary: { total: 0, ready: 0, confirmed: 0, invalid: 0, create: 0, inline: 0, transfer: 0, open: 0, dirty: 0 },
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
})
