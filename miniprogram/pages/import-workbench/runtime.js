const loginGuard = require('../../services/login-guard')
const themeService = require('../../theme/service')
const draftSessions = require('../../services/import-draft-session')
const api = require('../../services/catledger-import')

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

module.exports = {
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
    loginGuard.run(this, updateId ? async () => {
      await this.loadUpdate(updateId, true)
      const eventId = options && options.evidenceEventId
      if (eventId) {
        await this.openEvidence({ currentTarget: { dataset: { id: eventId } } })
      }
    } : function () {})
    },
onShow(initialData) {
      if (!getApp().hasLoginApproval()) {
        this.cancelPagedReads()
        if (this._viewSession) this._viewSession.close()
        if (this._unsubscribeDraft) this._unsubscribeDraft()
        this._viewSession = null; this._businessData = null; this._draftSession = null
        this.setData(JSON.parse(JSON.stringify(initialData)))
        return
      }
      const returning = this._viewActive === false
      this._viewActive = true
      themeService.bindPage(this)
    const revision = getApp().globalData.ledgerRevision || 0
    if (this._ledgerRevision != null && this._ledgerRevision !== revision && this.data.update) {
      if (this._draftSession) this._draftSession.flush().catch(function () {})
      else this.loadUpdate(this.data.update.updateId)
    }
    this._ledgerRevision = revision
      if (returning && this.data.update) return this.loadUpdate(this.data.update.updateId)
    },
onHide() {
      this._viewActive = false; this._viewEpoch++
      this.cancelPagedReads()
      this.setData({ currentIssue: null, currentMembers: [], issueEvents: [], issueRelations: [], issueVisibleEvents: [],
        evidenceSheet: null, accountRecordsSheet: null, finalDetailSheet: null, accountChoiceSheet: null, directorySheet: null, busy: false })
      this.finishInputEditing()
    },
onUnload() {
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
    }
}
