const pendingWrites = require('../../../../services/pending-ledger-write')
const readCache = require('../../../../services/read-cache')
const api = require('../../../../services/catledger-import')
const { publicError } = require('./presentation')

const ACTION = 'imports.renameFile'
const EDITABLE_STATES = new Set(['queued', 'failed', 'ready', 'duplicate', 'mapping'])
function currentOwner() { const app = getApp(); return app.hasLoginApproval() ? app.globalData.uid || '' : '' }
function activePage(page) {
  return page._viewActive && currentOwner() && page._viewOwner === currentOwner() && page._viewScope === readCache.getSession()
}
function pendingRename() {
  if (!currentOwner()) return null
  const packet = pendingWrites.pending()
  return packet && packet.target === 'import' && packet.action === ACTION ? packet : null
}
function recoveryFor(page) {
  const recovery = page._fileRenameRecovery
  return recovery && recovery.owner === currentOwner() && recovery.scope === readCache.getSession() ? recovery : null
}
function splitName(name) {
  const dot = String(name || '').lastIndexOf('.')
  return dot < 0 ? { base: name || '', suffix: '' } : { base: name.slice(0, dot), suffix: name.slice(dot) }
}
function importPatch(file, server) {
  const patch = {
    importId: server && server.importId || file.importId,
    importVersion: server && server.version || file.importVersion
  }
  if (server && typeof server.fileName === 'string') {
    patch.originalName = server.fileName
    patch.displayName = server.displayName || ''
    patch.name = patch.displayName || server.fileName
  }
  return patch
}
function applyImport(page, server) {
  page.setData({ files: page.data.files.map(file => file.importId === server.importId
    ? Object.assign({}, file, importPatch(file, server)) : file),
    sources: page.data.sources.map(source => source.importId === server.importId
      ? Object.assign({}, source, { fileName: server.displayName || server.fileName, originalFileName: server.fileName }) : source) })
}
function sourceFile(page, sourceId) {
  if (!page.data.update || page.data.update.status !== 'review') return null
  const source = page.data.sources.find(item => item.sourceId === sourceId)
  return source && source.importId ? { sourceId, clientId: '', importId: source.importId,
    name: source.fileName, originalName: source.originalFileName || source.fileName, state: 'ready' } : null
}
function fileForEdit(page, edit) {
  return edit.sourceId ? sourceFile(page, edit.sourceId) : page.data.files.find(item => item.clientId === edit.clientId)
}
function fileForImport(page, importId) {
  const source = page.data.sources.find(item => item.importId === importId)
  return source && sourceFile(page, source.sourceId) || page.data.files.find(item => item.importId === importId)
}
function tokenFor(page, clientId, importId, sourceId = '') {
  return page._fileRenameToken = { clientId, importId, sourceId,
    updateId: sourceId && page.data.update ? page.data.update.updateId : '',
    epoch: page._viewEpoch, owner: currentOwner(), scope: readCache.getSession() }
}
function activeToken(page, token) {
  return page._fileRenameToken === token && activePage(page) && page._viewEpoch === token.epoch &&
    currentOwner() === token.owner && readCache.getSession() === token.scope &&
    (!token.updateId || page.data.update && page.data.update.updateId === token.updateId)
}
function canApply(page, token) {
  return activeToken(page, token) && page.data.fileNameEdit &&
    page.data.fileNameEdit.clientId === token.clientId && page.data.fileNameEdit.importId === token.importId &&
    page.data.fileNameEdit.sourceId === token.sourceId
}
function beginEdit(page, file, packet) {
  const originalName = file.originalName || file.name
  const suffix = splitName(originalName).suffix
  const value = packet ? packet.payload.displayName : file.name
  const token = tokenFor(page, file.clientId || '', file.importId || '', file.sourceId || '')
  page.setData({ fileAttentionSheet: null, errorMessage: '', fileNameEdit: {
    clientId: file.clientId || '', sourceId: file.sourceId || '', importId: file.importId || '', originalName, suffix,
    value: splitName(value).base, version: packet ? packet.payload.version : file.importVersion,
    pending: Boolean(packet), saving: false, loading: false, dirty: false, error: ''
  } })
  return token
}
async function readSourceFile(page, token) {
  if (!canApply(page, token) || page.data.fileNameEdit.loading) return false
  page.setData({ 'fileNameEdit.loading': true, 'fileNameEdit.error': '' })
  try {
    const result = await page.request('imports.getFile', { importId: token.importId, includeOptions: false, pageSize: 1 })
    if (!canApply(page, token)) return false
    const server = result.import
    if (!server || server.importId !== token.importId || !Number.isSafeInteger(server.version)) throw new Error('INVALID_RESPONSE')
    applyImport(page, server)
    const patch = { 'fileNameEdit.version': server.version, 'fileNameEdit.originalName': server.fileName,
      'fileNameEdit.suffix': splitName(server.fileName).suffix }
    if (!page.data.fileNameEdit.dirty) patch['fileNameEdit.value'] = splitName(server.displayName || server.fileName).base
    page.setData(patch)
    return true
  } catch (error) {
    if (canApply(page, token)) page.setData({ 'fileNameEdit.error': publicError(error, '账单信息未能读取，请点确认重试') })
    return false
  } finally {
    if (canApply(page, token)) page.setData({ 'fileNameEdit.loading': false })
  }
}
async function refreshSources(page, recovery, active) {
  if (!recovery.updateId || !page.data.update || page.data.update.updateId !== recovery.updateId) return
  const view = await api.readSummary(recovery.updateId)
  if (!active()) return
  if (!view.update || view.update.updateId !== recovery.updateId || !view.workbench) throw new Error('INVALID_RESPONSE')
  page._pendingBackgroundView = null
  await page.applyUpdateView(view, false, false, false, true)
}
function validName(edit) {
  const normalized = String(edit.value || '').normalize('NFKC')
  const base = normalized.trim()
  const name = (base + edit.suffix).normalize('NFKC').trim()
  if (/[\u0000-\u001f\u007f-\u009f/\\]/u.test(normalized)) return { error: '名称不能包含斜杠或控制字符' }
  if (!base || /^[. ]+$/.test(base)) return { error: '请输入账单名称' }
  if ([...name].length > 255) return { error: '名称含格式后缀不能超过 255 个字' }
  return { name }
}

module.exports = {
  importPatch,
  syncFileRenamePending() {
    const pending = Boolean(pendingRename() || recoveryFor(this))
    if (this.data.fileRenamePending !== pending) this.setData({ fileRenamePending: pending })
    return pending
  },
  blockPendingFileRename() {
    if (!this.syncFileRenamePending()) return false
    this.setData({ errorMessage: '请先确认上次改名结果，再继续处理账单' })
    return true
  },
  blockFileNameEdit() {
    if (!this.data.fileNameEdit) return false
    this.setData({ 'fileNameEdit.error': this.data.fileNameEdit.pending
      ? '请先确认上次改名结果，或点 × 收起编辑' : '请先保存或取消账单名称修改' })
    return true
  },
  restoreFileNameEdit() {
    const edit = this.data.fileNameEdit
    if (!edit || !activePage(this)) return
    const file = fileForEdit(this, edit)
    if (file && (file.importId || '') === edit.importId) {
      const token = tokenFor(this, edit.clientId, edit.importId, edit.sourceId)
      if (edit.sourceId && !edit.pending && !Number.isSafeInteger(edit.version)) {
        this.setData({ 'fileNameEdit.loading': false })
        return readSourceFile(this, token)
      }
    }
    else this.setData({ fileNameEdit: null })
  },
  openFileRename(event) {
    if (!activePage(this) || this.data.busy) return
    const data = event.currentTarget.dataset
    if (this.data.fileNameEdit) {
      if (this.data.fileNameEdit.clientId !== (data.id || '') || this.data.fileNameEdit.sourceId !== (data.sourceId || '')) this.blockFileNameEdit()
      return
    }
    const file = data.sourceId ? sourceFile(this, data.sourceId) : this.data.files.find(item => item.clientId === data.id)
    if (!file || !EDITABLE_STATES.has(file.state)) return
    if (file.sourceId && this._draftSession && (this._draftSession.status.pending || this._draftSession.status.syncing)) {
      this.setData({ errorMessage: '请先完成当前核对结果的同步，再修改账单名称' }); return
    }
    const packet = pendingRename(), recovery = recoveryFor(this)
    if (packet || recovery) {
      if (file.importId !== (packet ? packet.payload.importId : recovery.importId)) return this.blockPendingFileRename()
      if (!packet) return this.resumeFileRename()
    } else if (pendingWrites.pending()) {
      this.setData({ errorMessage: '上次操作尚未确认，请先完成后再改名' }); return
    }
    this.cancelBankPreview()
    this.setData({ bankMappingSheet: null })
    const token = beginEdit(this, file, packet)
    if (file.sourceId && !packet) return readSourceFile(this, token)
  },
  closeFileRename() {
    if (this.data.fileNameEdit && this.data.fileNameEdit.saving) return
    this._fileRenameToken = null
    this.setData({ fileNameEdit: null })
    this.syncFileRenamePending()
    this.applyPendingBackgroundView()
  },
  inputFileRename(event) {
    const edit = this.data.fileNameEdit
    if (!edit || edit.saving || edit.pending || !activePage(this)) return
    this.setData({ 'fileNameEdit.value': event.detail.value, 'fileNameEdit.dirty': true, 'fileNameEdit.error': '' })
  },
  async resumeFileRename() {
    if (!activePage(this) || this.data.busy) return
    if (this.data.fileNameEdit) return this.data.fileNameEdit.pending ? this.saveFileRename() : this.blockFileNameEdit()
    const packet = pendingRename(), recovery = recoveryFor(this)
    if (!packet && !recovery) { this.syncFileRenamePending(); return }
    const importId = packet ? packet.payload.importId : recovery.importId
    const file = fileForImport(this, importId)
    if (packet && file && this.data.currentStep === 1) { beginEdit(this, file, packet); return }
    const token = tokenFor(this, file && file.clientId || '', importId, file && file.sourceId || '')
    this.setData({ busy: true, errorMessage: '' })
    const active = () => activeToken(this, token)
    try {
      // 重启后没有本机文件行；用户点继续确认时直接恢复原请求，不构造可上传的假文件。
      const result = packet ? (await pendingWrites.send('import', ACTION, packet.payload, { exact: true, canSend: active })).result
        : await this.request('imports.getFile', { importId, includeOptions: false, pageSize: 1 })
      if (!active()) return
      if (!result.import || result.import.importId !== importId || packet && result.action !== ACTION) throw new Error('INVALID_RESPONSE')
      applyImport(this, result.import)
      const pendingRefresh = this._fileRenameRecovery = { importId, owner: token.owner, scope: token.scope,
        updateId: token.updateId || recovery && recovery.updateId || '', saved: true }
      await refreshSources(this, pendingRefresh, active)
      if (!active()) return
      this._fileRenameRecovery = null
      this.syncFileRenamePending()
    } catch (error) {
      if (active()) {
        if (packet && !pendingRename() && !(this._fileRenameRecovery && this._fileRenameRecovery.saved)) this._fileRenameRecovery = null
        this.setData({ errorMessage: error.code === 'CONFLICT'
          ? '上次改名未保存，账单已更新，请重新选择该账单后修改名称' : publicError(error, '上次改名结果暂时无法确认，请重试') })
        this.syncFileRenamePending()
      }
    } finally {
      if (active()) this.setData({ busy: false })
    }
  },
  async saveFileRename() {
    const edit = this.data.fileNameEdit, token = this._fileRenameToken
    if (!edit || !token || edit.saving || edit.loading || this.data.busy || !canApply(this, token)) return
    const packet = pendingRename()
    if (edit.importId && !packet && !Number.isSafeInteger(edit.version)) {
      if (await readSourceFile(this, token)) return this.saveFileRename()
      return
    }
    const value = validName(edit)
    if (!packet && value.error) { this.setData({ 'fileNameEdit.error': value.error }); return }
    if (packet && packet.payload.importId !== edit.importId) { this.blockPendingFileRename(); return }
    const file = fileForEdit(this, edit)
    if (!edit.importId) {
      if (!file || !EDITABLE_STATES.has(file.state)) return
      this.setFileState(file.clientId, { originalName: edit.originalName, name: value.name,
        displayName: value.name === edit.originalName ? '' : value.name })
      this.closeFileRename()
      return
    }
    const payload = packet ? packet.payload : { importId: edit.importId, version: edit.version, displayName: value.name }
    const recovery = this._fileRenameRecovery = { importId: edit.importId, owner: token.owner, scope: token.scope, updateId: token.updateId }
    this.setData({ busy: true, 'fileNameEdit.saving': true, 'fileNameEdit.error': '' })
    try {
      const response = await pendingWrites.send('import', ACTION, payload, { exact: true, canSend: () => canApply(this, token) })
      if (!canApply(this, token)) return
      const result = response.result
      if (!result || result.action !== ACTION || !result.import || result.import.importId !== edit.importId) throw new Error('INVALID_RESPONSE')
      applyImport(this, result.import)
      recovery.saved = true
      this.setData({ fileNameEdit: null })
      await refreshSources(this, recovery, () => activeToken(this, token))
      if (!activeToken(this, token)) return
      if (this._fileRenameRecovery === recovery) this._fileRenameRecovery = null
      this._fileRenameToken = null
      this.setData({ fileNameEdit: null, busy: false, errorMessage: '' })
      this.syncFileRenamePending()
    } catch (error) {
      if (recovery.saved) {
        if (activeToken(this, token)) {
          this.setData({ busy: false, errorMessage: '名称已保存，来源列表暂未刷新，请继续确认' })
          this.syncFileRenamePending()
        }
        return
      }
      if (!canApply(this, token)) return
      const pending = Boolean(pendingRename())
      if (!pending && this._fileRenameRecovery === recovery) this._fileRenameRecovery = null
      this.setData({ 'fileNameEdit.pending': pending, 'fileNameEdit.error': pending
        ? '改名结果待确认，请继续确认上次结果' : publicError(error, '改名未保存，请重试') })
      if (error.code === 'CONFLICT') {
        try {
          const latest = await this.request('imports.getFile', { importId: edit.importId, includeOptions: false, pageSize: 1 })
          if (!canApply(this, token)) return
          if (!latest.import || latest.import.importId !== edit.importId) throw new Error('INVALID_RESPONSE')
          applyImport(this, latest.import)
          this.setData({ 'fileNameEdit.version': latest.import.version,
            'fileNameEdit.error': '账单已更新，已保留输入，请再次保存' })
        } catch (_) {
          if (canApply(this, token)) this.setData({ 'fileNameEdit.error': '账单已更新，暂未读取到最新状态，请重试' })
        }
      }
      if (canApply(this, token)) this.syncFileRenamePending()
    } finally {
      if (canApply(this, token)) this.setData({ busy: false, 'fileNameEdit.saving': false })
    }
  }
}
