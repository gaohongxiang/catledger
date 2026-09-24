const importApi = require('../../services/catledger-import')
const cloudUpload = require('../../services/cloud-upload-policy')
const loginGuard = require('../../services/login-guard')
const model = require('./model')
const bankMapping = require('./bank-mapping')
const { publicError, ERROR_MESSAGES } = require('./presentation')

const MAX_FILES = 5
const MAX_FILE_BYTES = 5 * 1024 * 1024
const FILE_PIPELINE_CONCURRENCY = MAX_FILES

module.exports = {
  MAX_FILES,
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
      extension: ['csv', 'xls', 'xlsx'],
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
      const pending = this.data.files.find(file => file.state === 'mapping')
      if (pending) await this.openBankMapping({ currentTarget: { dataset: { id: pending.clientId } } })
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
        self.setFileProgress(file.clientId, progress)
      },
      onRetry: function (failure, retry) {
        self.setFileState(file.clientId, {
          progress: 0,
          stateText: '重试中 ' + retry.attempt + '/' + retry.maxAttempts
        })
      }
    })
  },

  setFileProgress: function (clientId, progress) {
    if (!this._fileProgressPending) {
      this._fileProgressPending = new Map()
      this._fileProgressTimers = new Map()
    }
    if (typeof setTimeout !== 'function') {
      this.setFileState(clientId, { progress: progress })
      return
    }
    this._fileProgressPending.set(clientId, progress)
    if (this._fileProgressTimers.has(clientId)) return
    const self = this
    this._fileProgressTimers.set(clientId, setTimeout(function () {
      self._fileProgressTimers.delete(clientId)
      const pending = self._fileProgressPending.get(clientId)
      self._fileProgressPending.delete(clientId)
      if (pending === undefined) return
      if (!self.data.files.some(function (item) { return item.clientId === clientId })) return
      self.setFileState(clientId, { progress: pending })
    }, 100))
  },

  clearFileProgressThrottle: function (clientId) {
    if (!this._fileProgressTimers) return
    for (const [id, timer] of this._fileProgressTimers) {
      if (clientId && id !== clientId) continue
      clearTimeout(timer)
      this._fileProgressTimers.delete(id)
      if (this._fileProgressPending) this._fileProgressPending.delete(id)
    }
  },

  parsePreparedFile: async function (clientId, fileID, options) {
    const file = this.data.files.find(function (item) { return item.clientId === clientId })
    if (!file) return
    this.setFileState(clientId, { state: 'parsing', stateText: model.fileStateText('parsing'), errorMessage: '', errorCode: '' })
    try {
      const result = await this.request('imports.parseFile', Object.assign({
        requestId: importApi.createRequestId(),
        importId: file.importId,
        fileID: fileID,
        timezoneOffsetMinutes: new Date().getTimezoneOffset()
      }, options || (file.bankMapping ? { bankMapping: file.bankMapping } : {})))
      if (result.mappingRequired && result.bankPreview) {
        if (!this._bankPreviews) this._bankPreviews = new Map()
        this._bankPreviews.set(clientId, result.bankPreview)
        this.setFileState(clientId, { state: 'mapping', stateText: model.fileStateText('mapping'),
          hasBankMapping: true, importVersion: result.import.version, errorMessage: '' })
        if (this.data.bankMappingSheet && this.data.bankMappingSheet.clientId === clientId) {
          this.setData({ bankMappingSheet: bankMapping.view(clientId, file.name, result.bankPreview) })
        }
      } else if (result.duplicateImportId) {
        this.setFileState(clientId, {
          state: 'duplicate', stateText: model.fileStateText('duplicate'),
          importVersion: result.import && result.import.version || file.importVersion,
          errorMessage: '这份账单已经正式入账，不会再次创建交易'
        })
      } else if (result.import && result.import.state === 'failed') {
        this.setFileState(clientId, {
          state: 'failed', stateText: model.fileStateText('failed'),
          importVersion: result.import.version,
          errorCode: result.import.errorCode,
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
        if (this._bankPreviews) this._bankPreviews.delete(clientId)
      }
    } catch (error) {
      this.setFileState(clientId, {
        state: 'failed', stateText: model.fileStateText('failed'),
        errorCode: error.code || '',
        errorMessage: publicError(error, '解析失败，请重试')
      })
    }
  },

  openBankMapping: async function (event) {
    if (this.data.busy) return
    const id = event.currentTarget.dataset.id
    let file = this.data.files.find(item => item.clientId === id)
    if (!file) return
    let preview = this._bankPreviews && this._bankPreviews.get(id)
    if (!preview && file.fileID) {
      this.setData({ busy: true })
      await this.parsePreparedFile(id, file.fileID, {})
      this.syncUploadSummary()
      this.setData({ busy: false })
      file = this.data.files.find(item => item.clientId === id)
      preview = this._bankPreviews && this._bankPreviews.get(id)
    }
    if (preview) this.setData({ fileAttentionSheet: null, bankMappingSheet: bankMapping.view(id, file.name, preview, file.bankMapping) })
    else this.showFileFailure(file)
  },

  showFileFailure: function (file) {
    this.setData({ fileAttentionSheet: { clientId: file.clientId, name: file.name,
      reason: file.errorMessage || '未能读取账单预览，请重新读取这份文件。',
      hasBankMapping: Boolean(file.hasBankMapping && this._bankPreviews && this._bankPreviews.has(file.clientId)) } })
  },

  openFileAttention: function (event) {
    if (this.data.busy) return
    const data = event.currentTarget.dataset
    const file = this.data.files.find(item => data.id ? item.clientId === data.id : item.state === data.state)
    if (!file) return
    if (file.state === 'mapping') return this.openBankMapping({ currentTarget: { dataset: { id: file.clientId } } })
    this.showFileFailure(file)
  },

  tapFileRow: function (event) {
    const file = this.data.files.find(item => item.clientId === event.currentTarget.dataset.id)
    if (!file || (file.state !== 'mapping' && file.state !== 'failed')) return
    this.openFileAttention(event)
  },

  closeFileAttention: function () { if (!this.data.busy) this.setData({ fileAttentionSheet: null }) },

  retryFileAttention: async function () {
    if (this.data.busy || !this.data.fileAttentionSheet) return
    const sheet = this.data.fileAttentionSheet
    const event = { currentTarget: { dataset: { id: sheet.clientId } } }
    if (sheet.hasBankMapping) return this.openBankMapping(event)
    this.setData({ fileAttentionSheet: null })
    await this.retryFile(event)
    const file = this.data.files.find(item => item.clientId === sheet.clientId)
    if (file && file.state === 'failed') this.showFileFailure(file)
  },

  closeBankMapping: function () { if (!this.data.busy) this.setData({ bankMappingSheet: null }) },

  changeBankMapping: function (event) {
    if (this.data.busy || !this.data.bankMappingSheet) return
    const sheet = this.data.bankMappingSheet
    const key = event.currentTarget.dataset.key, value = Number(event.detail.value)
    const draft = Object.assign({}, sheet.draft, { columns: Object.assign({}, sheet.draft.columns) })
    if (key === 'amountMode') draft.amountMode = sheet.amountModes[value].value
    else if (key === 'statementKind') draft.statementKind = sheet.statementOptions[value].value
    else if (key === 'positiveDirection' || key === 'debitDirection') draft[key] = sheet.directionOptions[value].value
    else if (value === 0) delete draft.columns[key]
    else draft.columns[key] = value - 1
    const next = bankMapping.view(sheet.clientId, sheet.name, sheet.preview, draft)
    next.advanced = sheet.advanced
    this.setData({ bankMappingSheet: next })
  },

  toggleBankColumns: function () { this.setData({ 'bankMappingSheet.advanced': !this.data.bankMappingSheet.advanced }) },

  inputBankHeader: function (event) { this.setData({ 'bankMappingSheet.headerRowInput': event.detail.value }) },

  refreshBankPreview: async function (event) {
    if (this.data.busy || !this.data.bankMappingSheet) return
    const sheet = this.data.bankMappingSheet
    const changingSheet = event && event.currentTarget.dataset.key === 'sheet'
    const preview = changingSheet ? { sheetIndex: Number(event.detail.value) }
      : { sheetIndex: sheet.preview.sheetIndex, headerRow: Number(sheet.headerRowInput) }
    if (!changingSheet && (!Number.isInteger(preview.headerRow) || preview.headerRow < 1 || preview.headerRow > 120)) {
      this.setData({ 'bankMappingSheet.error': '表头行请输入 1 到 120' }); return
    }
    const file = this.data.files.find(item => item.clientId === sheet.clientId)
    if (!file) return
    this.setData({ busy: true })
    await this.parsePreparedFile(file.clientId, file.fileID, { bankPreview: preview })
    this.syncUploadSummary()
    const updated = this.data.files.find(item => item.clientId === file.clientId)
    this.setData({ busy: false, 'bankMappingSheet.error': updated.errorMessage || '' })
  },

  confirmBankMapping: async function () {
    if (this.data.busy || !this.data.bankMappingSheet) return
    const sheet = this.data.bankMappingSheet, result = bankMapping.payload(sheet)
    if (result.error) { this.setData({ 'bankMappingSheet.error': result.error }); return }
    const file = this.data.files.find(item => item.clientId === sheet.clientId)
    if (!file) return
    this.setFileState(file.clientId, { bankMapping: result.value })
    this.setData({ busy: true })
    await this.parsePreparedFile(file.clientId, file.fileID, { bankMapping: result.value })
    this.syncUploadSummary()
    const updated = this.data.files.find(item => item.clientId === file.clientId)
    this.setData({ busy: false, phase: 'files_ready', bankMappingSheet: updated.state === 'ready' || updated.state === 'duplicate'
      ? null : Object.assign({}, sheet, { error: updated.errorMessage || '未完成解析，请检查列选择后重试' }) })
  },

  setFileState: function (clientId, patch) {
    if (patch.state || patch.fileID || patch.progress === 100) this.clearFileProgressThrottle(clientId)
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
    if (this.data.files.find(item => item.clientId === clientId && item.state === 'mapping')) await this.openBankMapping(event)
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
      if (this._bankPreviews) this._bankPreviews.delete(clientId)
      this.clearFileProgressThrottle(clientId)
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
  }
}
