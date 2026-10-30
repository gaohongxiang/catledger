const localReview = require('../../services/import-local-manager')
const localResume = require('../../services/import-local-resume')
const { publicError, errorText } = require('./presentation')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const draftSessions = require('../../../../services/import-draft-session')
const api = require('../../../../services/catledger-import')
const ledgerApi = require('../../../../services/catledger-api')
const viewSession = require('../../services/import-view-session')
const loginGuard = require('../../../../services/login-guard')
const importPerformance = require('../../services/import-performance')
const readCache = require('../../../../services/read-cache')
const pendingWrites = require('../../../../services/pending-ledger-write')
const reviewLayout = require('./review-layout')

const bytes = value => unescape(encodeURIComponent(JSON.stringify(value))).length
const downloadProgress = progress => {
  const total = Number(progress && progress.total), completed = Number(progress && progress.completed)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(completed)) return ''
  const percent = Math.max(0, Math.min(100, Math.round(completed / total * 100)))
  // Do not surface implementation progress once it is complete (or before it starts).
  return percent > 0 && percent < 100 ? percent + '%' : ''
}
const commandActions = new Set(['financeUpdates.prepare', 'financeUpdates.organize', 'financeUpdates.post', 'financeUpdates.abandon', 'financeUpdates.setRepayment', 'financeUpdates.setCategory', 'financeUpdates.setReview',
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
    chunks.forEach((chunk, index) => send(chunk, index === chunks.length - 1 ? function () {
      if (callback) callback.call(page)
      if (Object.keys(patch).some(key => !['issueBodyLayout', 'directoryBodyLayout'].includes(key))) reviewLayout.schedule(page)
    } : undefined))
  }
}

function compactMapping(mapping) { const { choiceOptions, evidencePreview, ...visible } = presentation.accountMapping(mapping); return Object.assign(visible, { evidencePreview: Boolean(evidencePreview) }) }

function createViewSession(page, view) {
  const session = viewSession.create(api.callImport, view, { onStale() {
    if (!page._viewActive || page._viewSession !== session) return
    if (page.data.currentIssue) page.setData({ issueStale: true, issueCanSubmit: false, issueDetailsLoading: false })
    if (page.data.categoryEditSheet) page.invalidateCategoryEdit()
    if (page.data.reviewEditSheet) page.invalidateReviewEdit()
    if (page.data.duplicateEditSheet) page.invalidateDuplicateEdit()
    if (page.data.reviewDetailSheet) page.setData({ 'reviewDetailSheet.stale': true, 'reviewDetailSheet.loading': false })
    if (page.data.pairingSheet && page.invalidatePairingReview) page.invalidatePairingReview({ viewVersion: '' })
  } })
  return session
}

function currentOwner() { const app = getApp(); return app.hasLoginApproval() ? app.globalData.uid || '' : '' }
function serverAgeMs(update) {
  const value = Number(update && update.ageMs)
  if (Number.isFinite(value)) return value
  const time = Date.parse(update && update.updatedAt)
  return Number.isFinite(time) ? Math.max(0, Date.now() - time) : null
}
const RESUME_STEPS = { 1: '选择账单', 2: '确认账户', 3: '整理账目', 4: '确认入账' }

function resumeSummary(resume) {
  const progress = resume && resume.progress
  if (!progress) return ''
  const parts = ['第 ' + progress.step + ' 步 · ' + (RESUME_STEPS[progress.step] || '整理账目')]
  if (progress.pending) parts.push(progress.pending + ' 笔待核对')
  if (progress.categories) parts.push(progress.categories + ' 笔待分类')
  if (!progress.pending && !progress.categories) parts.push('核对与分类都已完成')
  return parts.join(' · ')
}

function keepUntilText(at) {
  const value = Number(at)
  if (!Number.isFinite(value)) return ''
  const date = new Date(value), now = new Date(), pad = number => String(number).padStart(2, '0')
  const sameDay = date.toDateString() === now.toDateString()
  return (sameDay ? '' : (date.getMonth() + 1) + '月' + date.getDate() + '日 ') + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function resumeNotice(resume, extra) {
  const state = resume.state
  const source = resume.source || 'local'
  const continueLabel = state === 'semantic' ? '重新整理并继续'
    : state === 'server_changed' ? '重新下载并继续'
      : state === 'post_pending' ? '继续核实入账结果' : state === 'recovery_failed' ? '联网核实并恢复'
        : state === 'idle' ? '继续上次导入' : '继续查看'
  const abandonLabel = state === 'recovery_failed' || state === 'post_pending' ? '核实并重新开始'
    : state === 'reparse' ? '放弃并重新选择' : state === 'idle' ? '放弃，重新选账单' : '放弃并重新开始'
  return Object.assign({
    source,
    state,
    updateId: resume.updateId,
    lastActiveAt: resume.lastActiveAt || null,
    activity: resume.activity || null,
    canContinue: resume.canContinue !== false,
    canAbandon: resume.canAbandon !== false,
    continueLabel,
    abandonLabel,
    originalMissing: Boolean(resume.originalMissing),
    title: resume.title || (source === 'server' ? '上次导入还没完成' : '上次导入还没完成'),
    summary: resumeSummary(resume),
    message: resume.message || (state === 'idle' && resume.keepUntil
      ? '本机草稿保留到 ' + keepUntilText(resume.keepUntil) + '，之后需要重新上传账单。继续查看不会重新上传，也不会入账。'
      : resume.keepUntil ? '本机草稿保留到 ' + keepUntilText(resume.keepUntil) + '，之后需要重新上传账单。' : '')
  }, extra || {})
}
function pendingPrepare() {
  if (!currentOwner()) return null
  const packet = pendingWrites.pending()
  return packet && packet.target === 'import' && packet.action === 'financeUpdates.prepare' ? packet : null
}

async function resumeInitialLoad(page) {
  const initial = page._pendingInitialLoad
  if (!initial || !initial.visible || initial.attempt || !getApp().hasLoginApproval()) return
  page._viewActive = true
  if (!page._viewOwner) {
    page._viewOwner = currentOwner()
    page._viewScope = readCache.getSession()
    page.syncFileRenamePending()
  }
  const attempt = initial.attempt = {}
  let loaded
  if (!initial.updateId && pendingPrepare()) loaded = await page.createFinanceUpdate({ recoveryOnly: true })
  else {
    if (!initial.updateId && initial.restoreLast) initial.updateId = draftSessions.lastUpdateId()
    if (!initial.updateId) { page._pendingInitialLoad = null; return }
    loaded = await page.loadUpdate(initial.updateId, true)
  }
  if (page._pendingInitialLoad !== initial || initial.attempt !== attempt || !initial.visible) return
  initial.attempt = null
  if (!loaded) return
  page._pendingInitialLoad = null
  if (initial.eventId) await page.openEvidence({ currentTarget: { dataset: { id: initial.eventId } } })
}

module.exports = {
  applyPendingBackgroundView() {
    if (this._pendingBackgroundView && !this.data.fileNameEdit && !this.data.fileRenamePending && !this.data.currentIssue && !this.data.duplicateEditSheet && !this.data.reviewDetailSheet && !this.data.reviewEditSheet && !this.data.accountChoiceSheet && !this.data.accountRecordsSheet && !this.data.pairingSheet) {
      const view = this._pendingBackgroundView; this._pendingBackgroundView = null; this.applyUpdateView(view, true)
    }
    // 配对入口卡片可能因隐藏或过期被清空，且本次视图应用未触发整页重读；按当前资格兜底重拉一次。
    if (!this.data.pairingEntry && this.loadPairingEntry) this.loadPairingEntry()
  },
  onLoad(options) {
    require('../../../../services/read-observer').attach(this)
    boundedSetData(this)
    this._viewEpoch = 0
    this._pageEpoch = 0
    this._viewActive = true
    this._viewOwner = currentOwner()
    this._viewScope = readCache.getSession()
    this.setData({ pageLoading: false, pageError: '', directoryPage: null })
    this._requestIds = {}
    this._abandonedUpdateId = null
    this._accountConfirmed = new Map()
    this._accountScrollTarget = null
    this._sourceFiles = new Map()
    this._accountUiDrafts = new Map()
    this.syncFileRenamePending()
    const updateId = options && options.fresh !== '1' && options.updateId || null
    this._pendingInitialLoad = { updateId, restoreLast: !(options && options.fresh === '1'), eventId: options && options.evidenceEventId, visible: true, attempt: null }
    loginGuard.run(this, () => resumeInitialLoad(this))
  },
  onPageScroll(event) {
    const top = Number(event && event.scrollTop)
    if (Number.isFinite(top) && top >= 0) this._pageScrollTop = top
  },

  restoreAccountScroll() {
    const target = this._accountScrollTarget
    if (!Number.isFinite(target)) return
    const run = () => {
      if (this._viewActive && this.data.currentStep === 2 && typeof wx !== 'undefined' && typeof wx.pageScrollTo === 'function') {
        wx.pageScrollTo({ scrollTop: target, duration: 0 })
      }
    }
    if (typeof setTimeout === 'function') {
      setTimeout(run, 0); setTimeout(run, 80)
      setTimeout(() => { if (this._accountScrollTarget === target) this._accountScrollTarget = null }, 240)
    } else run()
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
    const owner = currentOwner(), scope = readCache.getSession()
    if (this._viewOwner && (this._viewOwner !== owner || this._viewScope !== scope)) {
      this._viewEpoch++; this.cancelPagedReads()
      if (this._viewSession) this._viewSession.close()
      if (this._unsubscribeDraft) this._unsubscribeDraft()
      this._unsubscribeDraft = null; this._viewSession = null; this._businessData = null; this._draftSession = null
      this._prepareRestore = false
      this._pendingInitialLoad = { updateId: null, restoreLast: true, visible: true, attempt: null }
      this.setData(JSON.parse(JSON.stringify(initialData)))
    }
    this._viewOwner = owner; this._viewScope = scope
    this._viewActive = true
    if (this._draftSession && this._draftSession.touch) this._draftSession.touch()
    this.syncFileRenamePending()
    this.restoreFileNameEdit()
    const revision = getApp().globalData.ledgerRevision || 0
    if (returning && this._prepareRestore && !this.data.update && !this._pendingInitialLoad) {
      this._pendingInitialLoad = { updateId: null, restoreLast: true, visible: true, attempt: null }
    }
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
    this.cancelBankPreview()
    if (this._pendingInitialLoad) {
      this._pendingInitialLoad.visible = false
      this._pendingInitialLoad.attempt = null
    }
    this._viewActive = false; this._viewEpoch++
    this.cancelPagedReads()
    this.setData({ currentIssue: null, currentMembers: [], issueEvents: [], issueRelations: [], issueVisibleEvents: [],
        evidenceSheet: null, categoryEditSheet: null, duplicateEditSheet: null, reviewDetailSheet: null, reviewEditSheet: null, accountRecordsSheet: null, finalDetailSheet: null, accountChoiceSheet: null, directorySheet: null,
        bankMappingSheet: null, fileNameEdit: this.data.fileNameEdit && !this.data.fileNameEdit.saving ? this.data.fileNameEdit : null,
        busy: false, accountStepBusy: false, accountStepProgressText: '' })
    this.finishInputEditing()
  },
  onUnload() {
    this.cancelBankPreview()
    this._pendingInitialLoad = null
    this._viewActive = false; this._viewEpoch++
    this.cancelPagedReads()
    if (this._viewSession) this._viewSession.close()
    this._viewSession = null; this._businessData = null; this._draftSession = null
    this._evidenceReadToken = null
    this._categoryEditToken = null
    this._duplicateEditToken = null
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
    this.cancelExcludedGroup()
    this._fileRenameToken = null
    this._reviewDetailToken = null
    this._reviewEditToken = null
    if (this.cancelPairingEntry) this.cancelPairingEntry()
    if (this.cancelPairingReview) this.cancelPairingReview()
    this.closeInlineEvidence('issue')
    this.closeInlineEvidence('account')
    for (const key of ['_mainPager', '_memberPager', '_relationPager', '_historicalPager', '_accountPager', '_evidencePager', '_detailPager', '_finalPager', '_directoryPager', '_optionPager']) {
      if (this[key]) this[key].cancel()
      this[key] = null
    }
    this._issueEvidenceToken = null; this._accountEvidenceToken = null; this._evidenceReadToken = null
    this._issueEvidenceRecords = []; this._accountRecordList = []; this._finalDetail = null
  },
  async request(action, data, canRead) {
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
      if (canRead && !canRead()) return receipt
      try { return await api.readSummary(receipt.update.updateId) }
      catch (error) { return Object.assign({}, receipt, { refreshRequired: true }) }
    }
    if (action === 'reviewIssues.get') return this.readIssue(data.issueId)
    return api.callImport(action, data)
  },
  businessData: function () {
    return this._businessData || this.data
  },

  createFinanceUpdate: async function (settings) {
    if (!this._viewActive || !getApp().hasLoginApproval() || this.data.busy) return
    if (this.blockFileNameEdit()) return
    if (this.blockPendingFileRename()) return
    if (this.data.update && this.data.update.updateId) {
      if (this.data.refreshRequired) await this.retryPagedView()
      else await this.loadUpdate(this.data.update.updateId)
      return
    }
    const packet = pendingPrepare()
    const batchIds = packet ? packet.payload.batchIds : this.data.files.filter(file => file.state === 'ready' && file.batchId).map(file => file.batchId)
    if (batchIds.length === 0) {
      this.setData({ errorMessage: '至少需要一个解析成功的账单文件' })
      return
    }
    this._abandonedUpdateId = null
    const operation = this._prepareOperation = { epoch: this._viewEpoch, scope: readCache.getSession(), owner: currentOwner() }
    const perf = this._importPerf || importPerformance.create()
    this._importPerf = perf
    perf.mark('organize_start')
    this.setData({ prepareFailed: false })
    const active = () => this._viewActive && getApp().hasLoginApproval() && operation.owner === currentOwner() &&
      readCache.getSession() === operation.scope && this._viewEpoch === operation.epoch && this._prepareOperation === operation
    this._prepareRestore = true
    this.setData({ phase: 'organizing', busy: true, errorMessage: '', preparePending: Boolean(packet),
      currentStep: 2, unlockedStep: 2, preparingAccount: true, prepareProgress: '' })
    let receipt
    try {
      const result = settings && settings.recoveryOnly ? await pendingWrites.verify()
        : await pendingWrites.send('import', 'financeUpdates.prepare', { batchIds }, { exact: true, canSend: active })
      receipt = result.result
      if (!active()) return
      if (receipt.update && receipt.update.counts) perf.mark('organized', { events: receipt.update.counts.finalEvents, issues: receipt.update.counts.needsActionEvents })
      else perf.mark('organized')
      // 写回执与后续读取分开：即使摘要失败，也已有可恢复的原批次。
      this.setData({ update: receipt.update, preparePending: false, resumeNotice: null })
      let view = await api.readSummary(receipt.update.updateId)
      if (!active()) return
      view = await this.refreshAccountGroups(view, active)
      if (!active()) return
      view = await localReview.prepare(view, progress => { if (active()) this.setData({ prepareProgress: downloadProgress(progress) }) }, undefined, (stage, detail) => { if (active()) perf.mark(stage, detail) })
      if (!active()) return
      perf.mark('review_ready', { events: view.update && view.update.counts && view.update.counts.finalEvents })
      importPerformance.record(perf); this._importPerf = null
      this.applyUpdateView(view, false, false, false, false, 2)
      // 服务端已整理成功、但本机没拿到完整核对结果：这不是“待刷新”这么轻，要给能重试的入口。
      if (!view.workbench) this.setData({ errorMessage: '账单已读取，但核对结果没有完整下载。请点「重新下载核对结果」重试，不会重复整理。',
        refreshRequired: true, prepareFailed: true, currentStep: 1, unlockedStep: 1, preparingAccount: false })
      this._prepareRestore = false
      // 只有完整拿到核对结果才清掉失败态；缺 workbench 时保留重试入口。
      if (view.workbench) this.setData({ prepareFailed: false, refreshRequired: false })
      return true
    } catch (error) {
      if (!active()) return
      perf.mark('prepare_failed')
      importPerformance.record(perf); this._importPerf = null
      if (error.confirmedResult && error.confirmedResult.action === 'financeUpdates.prepare') receipt = error.confirmedResult.result
      if (receipt) {
        this.setData({ currentStep: 1, unlockedStep: 1, preparingAccount: false, prepareProgress: '' })
        this.applyUpdateView(receipt)
        this.setData({ errorMessage: '整理已完成，但核对结果还没有完整下载。请点「重新下载核对结果」重试：不会重复整理，也不会改变正式账目。',
          preparePending: false, refreshRequired: true, prepareFailed: true })
        this._prepareRestore = false
        return true
      }
      const pending = Boolean(pendingPrepare())
      this.setData({ phase: this.data.files.length ? 'files_ready' : 'idle', preparePending: pending,
        currentStep: 1, unlockedStep: 1, preparingAccount: false, prepareProgress: '', prepareFailed: !pending,
        errorMessage: pending ? '上次整理结果待确认，请继续整理上次账单' : publicError(error, '跨来源整理失败') })
      return false
    } finally { if (active()) this.setData({ busy: false }) }
  },

  // 整理已完成但本机没有完整草稿时的恢复：先尝试本机草稿，再按原版本重新下载快照。
  // 不计为新一次整理，也不改变正式账目。
  retryPrepareDownload: async function () {
    const update = this.data.update
    if (!update || !update.updateId || this.data.busy) return
    this.setData({ refreshRequired: false, prepareFailed: false, errorMessage: '' })
    const loaded = await this.loadUpdate(update.updateId)
    if (loaded === false && this.data.phase === 'error') {
      this.setData({ prepareFailed: true, refreshRequired: true })
    }
  },

  refreshAccountGroups: async function (view, canRead) {
    if (view.update.reviewMode === 'local_v3' || view.update.status !== 'review' || view.freshness && view.freshness.requiresAccountGroupRefresh === false) return view
    return this.request('reviewIssues.refreshAccountGroups', { requestId: api.createRequestId(),
        updateId: view.update.updateId, version: view.update.version }, canRead)
  },

  loadUpdate: async function (updateId, restoreToFirstStep, resumeOptions) {
    const options = resumeOptions || {}
    const load = { updateId: updateId, cancelled: false, pending: null }
    this._updateLoad = load
    const epoch = this._viewEpoch
    const scope = readCache.getSession(), owner = currentOwner()
    const active = () => this._viewActive !== false && getApp().hasLoginApproval() && scope === readCache.getSession() && owner === currentOwner() &&
      this._viewEpoch === epoch && this._updateLoad === load && !load.cancelled
    this._abandonedUpdateId = null
    this.setData({ phase: 'loading', busy: true, errorMessage: '', resumeNotice: null,
      restoreUpdateId: restoreToFirstStep ? updateId : '', abandoningRestore: false, preparingAccount: false })
    const perf = importPerformance.create()
    this._importPerf = perf
    perf.mark('restore_start')
    try {
      let adoptRecords = options.adoptRecords || null
      let local = null
      if (!options.skipLocal) {
        local = await localReview.ensureResume(updateId, options.forceLocal ? { force: true } : undefined)
        if (!active()) return
        if (local && local.resume && typeof local.resume === 'object') {
          perf.mark('restore_blocked')
          importPerformance.record(perf); this._importPerf = null
          this.showResumeNotice(local.resume, updateId, restoreToFirstStep)
          return false
        }
        if (local) {
          perf.mark('restore_local'); importPerformance.record(perf); this._importPerf = null
          this.setData({ restoreUpdateId: '', resumeNotice: null })
          this.applyUpdateView(local.view, false, restoreToFirstStep)
          return true
        }
      } else if (!adoptRecords) adoptRecords = localReview.localDecisions(updateId)
      load.pending = this.request('financeUpdates.summary', { updateId: updateId })
      let view = await load.pending
      if (!active()) return
      const serverState = localResume.serverActivityState(serverAgeMs(view.update))
      if (!options.manualServer && ['draft', 'failed', 'review'].includes(view.update.status) && serverState.state !== 'fresh') {
        perf.mark('server_restore_blocked')
        importPerformance.record(perf); this._importPerf = null
        this.showResumeNotice({
          source: 'server', state: serverState.state === 'expired' ? 'expired' : 'idle',
          updateId, canContinue: serverState.continueAllowed,
          title: serverState.state === 'expired' ? '上次导入已超过 48 小时' : '上次导入已超过 24 小时',
          message: serverState.state === 'expired'
            ? '云端临时整理数据已到期，不能继续。请放弃上次导入后重新选择账单。'
            : '云端草稿仍保留但不会自动继续。继续查看会重新下载并核对；超过 48 小时将清理临时整理数据。'
        }, updateId, restoreToFirstStep)
        return false
      }
      const migration = await localReview.settleLegacy(view)
      view = migration.view
      if (!active()) return
      if (view.update.status === 'review' && (view.update.reviewMode !== 'local_v3' || view.update.requiresReorganization)) {
        load.pending = this.request('financeUpdates.organize', {
          requestId: api.createRequestId(), updateId: updateId, version: view.update.version
          }, active)
        view = await load.pending
        if (!active()) return
      }
      load.pending = this.refreshAccountGroups(view, active)
      view = await load.pending
      if (!active()) return
      view = await localReview.prepare(view, progress => { if (active()) this.setData({ prepareProgress: downloadProgress(progress) }) }, migration,
        (stage, detail) => { if (active()) perf.mark(stage, detail) },
        { skipLocalRestore: Boolean(options.skipLocal), force: Boolean(options.forceReorganize), adoptRecords, alive:active })
      if (!active()) return
      perf.mark('review_ready', { events: view.update && view.update.counts && view.update.counts.finalEvents })
      importPerformance.record(perf); this._importPerf = null
      this.setData({ restoreUpdateId: '', resumeNotice: null })
      this.applyUpdateView(view, false, restoreToFirstStep)
      return true
    } catch (error) {
      if (!active()) return
      perf.mark('load_failed')
      importPerformance.record(perf); this._importPerf = null
      if (error.code === 'NOT_FOUND') {
        try { localReview.assertCanAbandon(updateId) } catch (localError) {
          this.setData({ phase:'error',busy:false,errorMessage:publicError(localError,'本机提交记录仍保留，请重试恢复') })
          return false
        }
        localReview.clearLocal(updateId, { keepAbandon: false })
        try { draftSessions.forgetLast() } catch (_) {}
        this.setData({ phase: 'idle', busy: false, errorMessage: '', restoreUpdateId: '', resumeNotice: null,
          update: null, files: [], uploadSummary: { total: 0, queued: 0, ready: 0, failed: 0, mapping: 0, duplicate: 0, attention: 0 } })
        return false
      }
      this.setData({ phase: 'error', busy: false, errorMessage: publicError(error, '整理结果加载失败') })
    }
  },

  showResumeNotice(resume, updateId, restoreToFirstStep) {
    const notice = resumeNotice(resume)
    this._pendingBackgroundView = null
    this.setData({ phase: 'resume', busy: false, resumeNotice: notice, restoreUpdateId: updateId,
      abandoningRestore: false, preparingAccount: false, prepareProgress: '', update: null,
      currentIssue: null, currentMembers: [], issueEvents: [], issueRelations: [], issueVisibleEvents: [],
      evidenceSheet: null, categoryEditSheet: null, duplicateEditSheet: null, reviewDetailSheet: null,
      reviewEditSheet: null, accountRecordsSheet: null, finalDetailSheet: null, accountChoiceSheet: null,
      directorySheet: null, pairingSheet: null })
    this._restoreToFirstStep = restoreToFirstStep
  },

  async continueBlockedResume() {
    const notice = this.data.resumeNotice
    if (!notice || this.data.busy) return
    const updateId = notice.updateId || this.data.restoreUpdateId
    if (!updateId) return
    if (notice.state === 'recovery_failed') return this.recoverDamagedDraft(false)
    if (notice.state === 'post_pending') {
      const loaded = await this.loadUpdate(updateId, true, { forceLocal: true })
      if (loaded && this._draftSession && this._draftSession.state.postFlight) await this.postUpdate()
      return
    }
    if (notice.state === 'expired' || notice.state === 'reparse') return
    if (notice.state === 'semantic' || notice.state === 'server_changed') {
      let adoptRecords = null
      try { adoptRecords = localReview.localDecisions(updateId) }
      catch (error) { this.setData({ busy: false, errorMessage: publicError(error, '本机草稿无法读取，原文件已保留，请重试恢复') }); return }
      if (adoptRecords && adoptRecords.postFlight) {
        this.showResumeNotice({ source:'local', state:'post_pending', canContinue:true, canAbandon:true,
          title:'上次入账结果待核实', message:'本机仍有未核实的入账请求。可继续核实原请求，也可联网核实后重新开始；结果确定前会保留原文件和选择。' },updateId,true)
        return
      }
      localReview.detach(updateId)
      await this.loadUpdate(updateId, true, { skipLocal: true, forceReorganize: true, adoptRecords })
      return
    }
    if (notice.source === 'server') {
      await this.loadUpdate(updateId, true, { manualServer: true })
      return
    }
    await this.loadUpdate(updateId, true, { forceLocal: true })
  },

  async recoverDamagedDraft(restart) {
    const updateId=this.data.restoreUpdateId
    if (!updateId || this.data.busy) return
    const epoch=this._viewEpoch,scope=readCache.getSession(),owner=currentOwner()
    const active=()=>this._viewActive!==false&&this._viewEpoch===epoch&&scope===readCache.getSession()&&owner===currentOwner()
    if(this._unsubscribeDraft)this._unsubscribeDraft()
    this._unsubscribeDraft=null;this._draftSession=null
    this.setData({busy:true,errorMessage:'',abandoningRestore:Boolean(restart)})
    try {
      const result=await localReview.recoverDamaged(updateId,{restart,alive:active})
      if(!active())return
      if(result.restart){draftSessions.clearUpdate(updateId);this.startAnother();return}
      this.setData({restoreUpdateId:'',resumeNotice:null})
      this.applyUpdateView(result.view,false,true)
      if(result.rebuilt)this.setData({errorMessage:'已从云端恢复草稿，请重新核对本机尚未同步的选择'})
    } catch(error) {
      if(!active())return
      const message=error.code==='LOCAL_RESTART_REQUIRED'?error.message
        :error.code==='NOT_FOUND'?'云端暂时找不到这次导入，尚不能确认入账结果。原文件已保留，请稍后再核实'
          :error.code==='DRAFT_STORAGE_FAILED'?'云端核实已进行，但本机仍无法保存。请释放存储空间后重试，原文件已保留'
            :error.code==='SNAPSHOT_INCOMPLETE'?'云端草稿无法完整恢复，原文件已保留。请点“核实并重新开始”后重新选择账单'
              :error.code==='CONFLICT'?'服务端草稿刚发生变化，本次恢复已停止。请再核实一次，原文件已保留'
            :'本次核实未完成，原文件已保留。请检查网络后重试，也可稍后回来继续核实'
      this.setData({phase:'resume',errorMessage:message})
    } finally {if(active())this.setData({busy:false,abandoningRestore:false})}
  },

  abandonRestoringUpdate: async function () {
    const updateId = this.data.restoreUpdateId
    if (!updateId || this.data.abandoningRestore) return
    if(['recovery_failed','post_pending'].includes(this.data.resumeNotice?.state))return this.recoverDamagedDraft(true)
    if(this.data.resumeNotice && this.data.resumeNotice.canAbandon === false) return
    // 放弃是破坏性操作：先确认，并写清会丢什么、不会影响什么。
    if (this.data.resumeNotice && this.data.resumeNotice.state === 'idle') {
      const answer = await new Promise(resolve => wx.showModal({ title: '放弃上次导入？',
        content: '本机草稿和已保存的账户、分类、退款选择都会删除，账单需要重新上传。已经入账的记录不受影响。',
        confirmText: '放弃', confirmColor: '#a03c2c', success: resolve, fail: () => resolve({ confirm: false }) }))
      if (!answer.confirm) return
    }
    const load = this._updateLoad
    if (load) load.cancelled = true
    this.setData({ abandoningRestore: true, busy: true, errorMessage: '' })
    try {
      localReview.assertCanAbandon(updateId)
      await draftSessions.pauseUpdate(updateId)
      // 已发送的整理事务必须落定；取消后不再发起下一段恢复。
      if (load && load.pending) await load.pending.catch(function () {})
      localReview.assertCanAbandon(updateId)
      let view
      try { view = await this.request('financeUpdates.summary', { updateId: updateId }) }
      catch (error) {
        if (error.code !== 'NOT_FOUND') throw error
        localReview.clearLocal(updateId, { keepAbandon: false })
        draftSessions.clearUpdate(updateId)
        this._abandonedUpdateId = updateId
        this.startAnother()
        return
      }
      if (view.update.status === 'posted') {
        this.setData({ restoreUpdateId: '', abandoningRestore: false })
        localReview.clearLocal(updateId, { keepAbandon: false })
        this.applyUpdateView(view)
        return
      }
      if (view.update.status !== 'abandoned') {
        if (!this._restoreAbandonRequest || this._restoreAbandonRequest.updateId !== updateId || this._restoreAbandonRequest.version !== view.update.version) {
          this._restoreAbandonRequest = { requestId: api.createRequestId(), updateId: updateId, version: view.update.version }
        }
        await this.request('financeUpdates.abandon', this._restoreAbandonRequest)
      }
      localReview.clearLocal(updateId, { keepAbandon: false })
      draftSessions.clearUpdate(updateId)
      this._abandonedUpdateId = updateId
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
      const checked = session.isLocal ? session.view : await this.request('financeUpdates.organize', { requestId: api.createRequestId(),
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
    if (this.blockFileNameEdit()) return
    if (this.blockPendingFileRename()) return
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
    if (this.blockFileNameEdit()) return
    this._pendingInitialLoad = null
    this._prepareRestore = false
    this._pendingBackgroundView = null
    this._editingInput = ''
    if (this._accountDraftTimer) { clearTimeout(this._accountDraftTimer); this._accountDraftTimer = null }
    this._viewEpoch++
    this.cancelPagedReads(); if (this._viewSession) this._viewSession.close(); this._viewSession = null
    this._businessData = null
    this._reviewProjection = null
    this._reviewPage = 0
    this._evidenceReadToken = null
    if (this._updateLoad) this._updateLoad.cancelled = true
    this._restoreAbandonRequest = null
    if (this._unsubscribeDraft) this._unsubscribeDraft()
    if (this._draftSession) {
      if (this._draftSession.state.flight || this._draftSession.state.postFlight) this._draftSession.pause()
      else this._draftSession.clear()
    }
    this._draftSession = null
    this._unsubscribeDraft = null
    this._postingRequestId = null
    if (draftSessions.forgetLast) draftSessions.forgetLast()
    this._sourceFiles.clear()
    if (this._bankPreviews) this._bankPreviews.clear()
    this._duplicateLoadToken = null
    this.setData({
        phase: 'idle', currentStep: 1, unlockedStep: 1, busy: false, restoreUpdateId: '', resumeNotice: null, abandoningRestore: false, abandoningUpdate: false, preparePending: false,
        preparingAccount: false, prepareProgress: '',
        files: [], bankMappingSheet: null, fileAttentionSheet: null, fileNameEdit: null, update: null, sources: [], events: [], issues: [], fundsFlowGroups: [], finalDetailSheet: null, finalDetailParent: null,
        recordSummary: { totalCount: 0, activeCount: 0, excludedCount: 0, duplicateCount: 0 },
        reviewedEvents: [], categoryWaitingEvents: [], noCategoryEvents: [],
        accountIssues: [], reviewIssues: [], reviewGroups: [], verificationIssues: [], categoryIssues: [], categoryCards: [], categoryQuery: '', reviewQuery: '', categoryEventCount: 0, categorizedEvents: [], categorizedEventCount: 0, activeCategoryStatus: 'pending', categoryStatusTabs: model.organizerRecordState([], [], []).categoryStatusTabs, activeReviewTab: 'review', activeReviewStatus: 'pending', excludedReviewGroups: [], duplicateReviewEvents: [], openIssueCount: 0,
        duplicateReviewCandidates: [], duplicateReviewLoading: false, duplicateReviewLoaded: false, duplicateReviewError: '',
        coverage: {
          dataRows: 0, recognizedRows: 0, unrecognizedRows: 0,
          selectedEvents: 0, readySelectedEvents: 0, pendingSelectedEvents: 0, excludedEvents: 0,
          statementFullyRecognized: false, selectedEventsReadyToPost: false
        },
        reviewStatusTabs: model.reviewStatusTabs(),
        accountMappings: [], accountMappingsIncluded: [], accountMappingsExcluded: [], accountStepSummary: { total: 0, ready: 0, confirmed: 0, invalid: 0, create: 0, inline: 0, transfer: 0, open: 0, dirty: 0, pending: 0 },
        accountStepBusy: false, accountStepError: '', accountStepProgressText: '',
        accounts: [], accountDrafts: [], accountMappingDrafts: [], accountChoices: [{ accountId: '', name: '新建账户' }],
        accountChoiceSheet: null, accountChoiceQuery: '', accountChoiceResults: [], categories: [], issueCategories: [],
        uploadSummary: { total: 0, queued: 0, ready: 0, failed: 0, mapping: 0, duplicate: 0, attention: 0 },
        posting: null, errorMessage: '', currentIssue: null, currentMembers: [],
        issueEvents: [], issueRelations: [], evidenceSheet: null, categoryEditSheet: null, duplicateEditSheet: null, reviewDetailSheet: null, reviewEditSheet: null
      })
    this._accountUiDrafts.clear()
    if (this._accountConfirmed) this._accountConfirmed.clear()
    this.syncFileRenamePending()
  },

  applyUpdateView: function (view, background, restoreToFirstStep, quiet, keepStep, forceStep) {
    if (!this._viewActive) return
    if (view.update && view.update.status === 'abandoned' && view.update.updateId === this._abandonedUpdateId) return
    if (!view.workbench) {
      // 操作事实先显示；明细读取失败不抹掉已保存/已入账结果。
      this.setData({ update: view.update, posting: view.posting || this.data.posting,
          phase: {posted:'done',abandoned:'abandoned',undone:'undone'}[view.update.status] || 'review', currentStep: view.update.status === 'review' ? this.data.currentStep : 4, busy: false,
          preparingAccount: false, prepareProgress: '', errorMessage: view.update.status === 'posted' ? '已入账，明细待刷新' : view.update.status === 'abandoned' ? '' : '操作已保存，明细待刷新', refreshRequired: true })
      return
    }
    if (background && (this._editingInput || this.data.fileNameEdit || this.data.fileRenamePending || this.data.currentIssue || this.data.evidenceSheet || this.data.reviewDetailSheet || this.data.reviewEditSheet || this.data.categoryEditSheet || this.data.duplicateEditSheet || this.data.accountChoiceSheet || this.data.accountRecordsSheet || this.data.pairingSheet)) {
      this._pendingBackgroundView = view
      if (this._viewSession && this._viewSession.summary.viewVersion !== view.viewVersion) {
        if (this.data.currentIssue) this.setData({ issueStale: true, issueCanSubmit: false })
        if (this.data.categoryEditSheet) this.invalidateCategoryEdit()
        if (this.data.reviewEditSheet) this.invalidateReviewEdit()
        if (this.data.duplicateEditSheet) this.invalidateDuplicateEdit()
        if (this.data.reviewDetailSheet) this.setData({ 'reviewDetailSheet.stale': true, 'reviewDetailSheet.loading': false })
        if (this.data.accountRecordsSheet) this.setData({ 'accountRecordsSheet.loading': false, 'accountRecordsSheet.error': '账户记录已更新，请重新读取' })
        if (this.data.pairingSheet && this.invalidatePairingReview) this.invalidatePairingReview(view)
      }
      return
    }
    const same = this._viewSession && this._viewSession.summary.update.updateId === view.update.updateId
    const changed = !same || this._viewSession.summary.viewVersion !== view.viewVersion
    if (this.data.fileNameEdit && this.data.fileNameEdit.sourceId && (!same || view.update.status !== 'review')) {
      this._fileRenameToken = null
      this.setData({ fileNameEdit: null })
    }
    if (!same) { if (this._viewSession) this._viewSession.close(); this._viewSession = createViewSession(this, view) }
    else this._viewSession.accept(view)
    if (changed) { this._mainPager = null; this._businessData = null }
    const workbench = view.workbench
    const open = view.coverage.openBlockingIssues
    const workflow = view.update.status !== 'review' ? 4 : workbench.accountStepSummary.pending ? 2 : workbench.reviewStatusTabs[0].count ? 3 : 4
    const current = this.data.currentStep
    const step = view.update.status !== 'review' ? 4 : restoreToFirstStep ? 1
    : forceStep || (background || (same && (keepStep || (current >= 1 && current <= workflow))) ? current : workflow)
    const mappings = workbench.accountMappings || this.data.accountMappings || []
    const excluded = mappings.filter(function (mapping) { return mapping.choiceValue === 'ignore' })
    const excludedIds = new Set(excluded.map(function (mapping) { return mapping.issueId }))
    const patch = Object.assign({}, workbench, { reviewStatusTabs: model.reviewStatusTabs(workbench.reviewStatusTabs), update: view.update, sources: view.sources.map(source => ({ sourceId: source.sourceId,
              importId: source.importId || '', fileName: source.fileName, originalFileName: source.originalFileName || source.fileName,
              sourceType: source.sourceType, summary: source.summary })), coverage: view.coverage, posting: view.posting,
        phase: { posted: 'done', undone: 'undone', abandoned: 'abandoned' }[view.update.status] || 'review',
        currentStep: step, unlockedStep: workflow, openIssueCount: open, busy: false, errorMessage: '', refreshRequired: false,
        preparingAccount: false, prepareProgress: '', resumeNotice: null,
        accountMappingsIncluded: mappings.filter(function (mapping) { return !excludedIds.has(mapping.issueId) }),
        accountMappingsExcluded: excluded })
    if (step !== 4) { patch.finalSummary = {}; patch.fundsFlowGroups = [] }
    setChangedData(this, patch)
    // 首页「待核对」读这里：与本页签的待办数同源，入账或放弃时随草稿一起清掉。
    if (view.update.status === 'review') {
      const countOf = (tabs, value) => Number(((tabs || []).find(tab => tab.value === value) || {}).count || 0)
      draftSessions.rememberProgress(view.update.updateId, {
        pending: countOf(patch.reviewStatusTabs, 'pending'),
        categories: countOf(patch.categoryStatusTabs, 'pending')
      })
    }
    // 配对入口随每次摘要应用更新；旧服务端缺少计数字段时才复用版本分页缓存。
    if (this.loadPairingEntry) this.loadPairingEntry()
    // 入账后只按本批来源找待补分期，其他批次的待补记录不在这里冒充本批成果。
    if (view.update.status === 'posted' && view.sources.some(source=>source.sourceType==='bank')) {
      const key=view.update.updateId+':'+view.viewVersion
      if(this._installmentPendingKey!==key){
        this._installmentPendingKey=key;this.setData({pendingInstallments:0,pendingInstallmentsMore:false,pendingInstallmentNames:''})
        ledgerApi.callApi('loans.installmentSources',{updateId:view.update.updateId,pageSize:20},{force:true}).then(result=>{
          if(!this._viewActive || this._installmentPendingKey!==key)return
          // 已入账卡直接点名本次待补的计划，用户不必先跳到另一个列表再猜是哪一笔。
          const names=[...new Set(result.items.map(item=>String(item.planLabel||item.referenceLabel||'').trim()).filter(Boolean))]
          // 只有本批来源；一页够点名，超过一页只标“以上”，不在这里继续翻页。
          this.setData({pendingInstallments:result.items.length,pendingInstallmentsMore:Boolean(result.nextCursor),
            pendingInstallmentNames:names.slice(0,2).join('、')})
        }).catch(()=>{})
      }
    } else {this._installmentPendingKey=null;this.setData({pendingInstallments:0,pendingInstallmentsMore:false,pendingInstallmentNames:''})}
    if (view.update.status === 'review') {
      if (!this._draftSession || this._draftSession.view.update.updateId !== view.update.updateId) {
        if (this._unsubscribeDraft) this._unsubscribeDraft()
        const session = this._draftSession = draftSessions.open(view)
        const scope = readCache.getSession()
        this._accountUiDrafts = new Map(Object.entries(session.state.drafts))
        this._unsubscribeDraft = session.subscribe(() => {
            if (!this._viewActive || this._draftSession !== session || readCache.getSession() !== scope) return
            setChangedData(this, { draftSync: session.status })
            if (this._viewSession.summary.viewVersion !== session.view.viewVersion) this.applyUpdateView(session.view, true, false, true)
          })
      } else this._draftSession.accept(view)
      if (changed) this._accountUiDrafts = new Map(Object.entries(this._draftSession.state.drafts))
      setChangedData(this, { draftSync: this._draftSession.status, prepareProgress: '' })
      this._draftSession.schedule()
    }
    if (changed || this._loadedStep !== step) {
      const target = Number.isFinite(this._accountScrollTarget) ? this._accountScrollTarget : this._pageScrollTop
      const preserveScroll = background && step === 2 && this._loadedStep === 2 && Number.isFinite(target)
      const task = this.loadActivePage(true, undefined, background && step === 2 ? true : quiet)
      if (!preserveScroll) return task
      return task.then(() => {
        if (this._viewActive && this.data.currentStep === 2 && typeof wx !== 'undefined' && typeof wx.pageScrollTo === 'function') {
          wx.pageScrollTo({ scrollTop: target, duration: 0 })
        }
      })
    }
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
    const expandedExcluded = this.data.excludedReviewGroups.find(group => group.expanded)
    this.cancelExcludedGroup()
    const step = this.data.currentStep
    this.loadPairingEntry()
    const epoch = ++this._pageEpoch, viewEpoch = this._viewEpoch, scope = readCache.getSession()
    const active = () => this._viewActive && epoch === this._pageEpoch && viewEpoch === this._viewEpoch && readCache.getSession() === scope
    this._loadedStep = step
    if (![2, 3].includes(step)) { setChangedData(this, Object.assign({}, this.stepPatch(step), { pageLoading: false, pageError: '' })); return }
    let action = 'reviewIssues.list', filter = {}, kind = 'accountMappings'
    if (step === 2) filter = { group: 'accounts' }
    else if (this.data.activeReviewTab === 'category') {
      const status = this.data.activeCategoryStatus
      if (status === 'pending') { action = 'economicEvents.list'; filter = { view: 'category_pending', query: this.data.categoryQuery }; kind = 'categoryCards' }
      else { action = 'economicEvents.list'; filter = { view: 'category_' + status, query: this.data.categoryQuery }; kind = status === 'none' ? 'noCategoryEvents' : 'categorizedEvents' }
    } else if (this.data.activeReviewStatus === 'pending') { action = 'economicEvents.list'; filter = { view: 'review_pending', query: this.data.reviewQuery }; kind = 'reviewGroups' }
    else { action = 'economicEvents.list'; const status = this.data.activeReviewStatus
      filter = Object.assign(status === 'completed' ? { view: 'review_completed' } : status === 'excluded' ? { view: 'excluded_groups' } : { status }, { query: this.data.reviewQuery })
      kind = { completed: 'reviewedEvents', excluded: 'excludedReviewGroups', duplicate: 'duplicateReviewEvents' }[status]
    }
    if (reset || !this._mainPager) this._mainPager = this._viewSession.pager(action,
      step === 3 ? Object.assign({}, filter, { pageSize: presentation.PAGE_SIZE }) : filter, { fillPage: step === 3 })
    const pager = this._mainPager
    if (!quiet) this.setData({ pageLoading: true, pageError: '' })
    try {
      const response = await pager.load(direction)
      if (!active() || pager !== this._mainPager) return
      const directory = step === 2 ? await this.loadDirectories(response.items.map(issue => issue.subject).filter(Boolean)) : { accounts: this.data.accounts, categories: this.data.categories, accountDrafts: this.data.accountDrafts }
      if (!active()) return
      const events = action === 'economicEvents.list' && kind !== 'excludedReviewGroups' ? response.items : []
      const issues = action === 'reviewIssues.list' ? response.items :
        Array.from(new Map(events.filter(event => event.pendingIssue).map(event => [event.pendingIssue.issueId,
          Object.assign({}, event.pendingIssue, { subject: event })])).values())
      this._businessData = Object.assign({}, directory, { issues, events, accountIssues: step === 2 ? issues.map(model.issueView) : [], accountMappingDrafts: [] })
      const patch = presentation.emptyLists()
      patch.reviewPage = Object.assign({}, response.page, { unit: kind === 'excludedReviewGroups' ? '组' : step === 3 ? '笔' : '项' })
      if (step === 2) {
        const visible = new Set(issues.map(issue => issue.issueId))
        for (const [id, draft] of this._accountUiDrafts) if (!visible.has(id) && !draft.dirty && !draft.localConfirmed) this._accountUiDrafts.delete(id)
        Object.assign(patch, directory)
        const state = this.mappingState()
        const mappings = state.mappings.map(compactMapping)
        const excluded = mappings.filter(function (mapping) { return mapping.choiceValue === 'ignore' })
        const excludedIds = new Set(excluded.map(function (mapping) { return mapping.issueId }))
        patch.accountMappings = mappings
        patch.accountMappingsIncluded = mappings.filter(function (mapping) { return !excludedIds.has(mapping.issueId) })
        patch.accountMappingsExcluded = excluded
        patch.accountStepSummary = state.summary
      } else if (kind === 'reviewGroups') {
        // 组级笔数（本期还有几笔利息没定归属）放组标题，卡头只写状态，避免每张卡重复一遍。
        const cards = presentation.splitInstallmentCards(events.map(event => presentation.pendingCard(event, false)))
        patch.reviewGroups = events.length ? [{ key: 'pending-events',
          installmentNote: presentation.installmentPendingNote(cards),
          issues: presentation.linkGroupRows(cards) }] : []
      }
      else if (kind === 'categoryCards') patch.categoryCards = presentation.linkGroupRows(events.map(event => presentation.pendingCard(event, true)))
      else if (kind === 'excludedReviewGroups') {
        patch.excludedReviewGroups = response.items.map(group => ({ groupId: group.groupId, key: group.groupId,
          label: group.label, note: group.note, count: group.count, expanded: false, events: [], loading: false, error: '', page: null }))
      }
      else { const categoryNames = model.categoryNames(this.data.categories)
        if (kind === 'reviewedEvents') {
          // 已核对：同账户＋同期次的分期本金／利息／手续费合并成一张卡，跨页不完整时不给合计。
          patch.reviewedEvents = presentation.buildReviewedCards(events, {
            pageEdges: { hasPrevious: response.page.hasPrevious, hasNext: response.page.hasNext } })
        } else {
          patch[kind] = events.map(event => presentation.listRecord(Object.assign({}, event, { duplicateCount: Number(event.duplicateEvidenceCount || 0) + (model.isHistoricalDuplicate(event) ? 1 : 0),
              categoryName: event.categoryName || categoryNames.get(event.categoryId) || '',
              auditNote: model.isHistoricalDuplicate(event) ? '已与历史账目对应，本次不重复入账。' : '已保留一笔，点开对照主记录与重复来源。' })))
        } }
      if (!quiet) patch.pageLoading = false
      patch.duplicateReviewLoaded = true
      setChangedData(this, patch)
      if (kind === 'excludedReviewGroups' && expandedExcluded && !direction &&
        patch.excludedReviewGroups.some(group => group.key === expandedExcluded.key)) {
        await this.toggleExcludedGroup({ currentTarget: { dataset: { key: expandedExcluded.key } } })
      }
    } catch (error) {
      if (active()) this.setData({ pageLoading: false, pageError: errorText(error) })
    }
  },

  changeReviewPage: function (event) {
    return this.loadActivePage(false, event.currentTarget.dataset.direction === 'first' ? 'first' : Number(event.currentTarget.dataset.direction))
  },

  retryPagedView: async function () {
    if (!this._viewActive || !this.data.update) return
    // A server summary alone cannot reopen a v3 draft after an interrupted
    // download. Complete and validate its files before creating any edit view.
    if (this.data.update.status === 'review' && this.data.update.reviewMode === 'local_v3' && !this._draftSession?.isLocal) return this.loadUpdate(this.data.update.updateId)
    const operation = this._refreshOperation = { epoch: this._viewEpoch, pageEpoch: ++this._pageEpoch,
      scope: readCache.getSession(), updateId: this.data.update.updateId }
    const active = () => this._viewActive && this._refreshOperation === operation && this._viewEpoch === operation.epoch &&
      this._pageEpoch === operation.pageEpoch && readCache.getSession() === operation.scope &&
      this.data.update && this.data.update.updateId === operation.updateId
    this.setData({ pageLoading: true, pageError: '' })
    try {
      const summary = await api.readSummary(operation.updateId)
      if (!active()) return
      this._mainPager = null
      const pending = this.applyUpdateView(summary, true) || this.loadActivePage(true)
      operation.pageEpoch = this._pageEpoch
      await pending
    } catch (error) { if (active()) this.setData({ pageError: errorText(error) }) }
    finally { if (active()) this.setData({ pageLoading: false }) }
  }
}
