const { publicError } = require('./presentation')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const { errorText, direction } = require('./presentation')
const readCache = require('../../services/read-cache')

function currentAccountRecords(page, token) {
  return token && page._viewActive && page._viewEpoch === token.epoch && page._accountEvidenceToken === token &&
    readCache.getSession() === token.scope && getApp().hasLoginApproval() && getApp().globalData.uid === token.owner &&
    page.data.update && page.data.update.updateId === token.updateId &&
    page.data.accountRecordsSheet && page.data.accountRecordsSheet.issueId === token.issueId
}

function currentIssueDirectory(page) {
  if (!page.data.directorySheet || !page.data.directorySheet.issueDirectory) return true
  const token = page._issueDirectoryToken, issue = page.data.currentIssue
  return Boolean(token && page._viewActive && page._viewSession === token.session && token.session.active &&
    readCache.getSession() === token.scope && getApp().hasLoginApproval() && getApp().globalData.uid === token.owner &&
    token.session.summary.viewVersion === token.version && !page.data.issueStale && issue &&
    issue.issueId === token.issueId && issue.version === token.issueVersion && page._issueEvidenceToken === token.issueToken)
}

const ACCOUNT_TYPE_OPTIONS = Object.freeze([
    { value: 'cash', label: '现金' },
    { value: 'bank', label: '银行卡' },
    { value: 'wallet', label: '平台钱包' },
    { value: 'credit', label: '信用卡 / 消费信贷' },
    { value: 'other_asset', label: '其他资产' },
    { value: 'other_liability', label: '其他负债' }
  ])

function directorySelection(data, target) {
  if (target === 'reviewAccount' || target === 'reviewCounterparty') {
    return (data.reviewEditSheet || {})[target === 'reviewAccount' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId'] || ''
  }
  if (target === 'categoryEdit') return (data.categoryEditSheet || {}).selectedId || ''
  const entry = target === 'category' ? (data.issueCategories || [])[data.issueDraft.categoryIndex]
    : target === 'paymentTarget' ? (data.paymentTargetChoices || [])[data.paymentTargetIndex]
      : target === 'counterparty' ? (data.counterpartyAccountChoices || [])[data.issueDraft.counterpartyAccountIndex]
        : target === 'account' ? (data.accountChoices || [])[data.issueDraft.accountIndex] : null
  return entry && (entry.accountId || entry.categoryId) || ''
}

function directoryRows(sheet, items) {
  return items.map(item => {
    const wrongType = sheet.liabilityOnly && !['credit', 'other_liability'].includes(item.type)
    const unavailable = Boolean(item.archived || item.archivedAt || item.unavailable)
    const type = ACCOUNT_TYPE_OPTIONS.find(option => option.value === item.type)
    return { ...item, directorySelected: (item.accountId || item.categoryId) === sheet.selectedId,
      directoryDisabled: wrongType || unavailable,
      directoryMeta: unavailable ? (sheet.kind === 'categories' ? '分类不可用' : '账户不可用') : wrongType ? '不能作为还款账户' : type ? type.label : '' }
  }).sort((a, b) => Number(a.directoryDisabled) - Number(b.directoryDisabled))
}

function suggestedAccountTypeIndex(label, sourceType) {
  const value = String(label || '')
  if (/信用|花呗|白条|贷|先采后付/.test(value)) return 3
  if (/银行|储蓄|借记|卡/.test(value)) return 1
  if (/现金/.test(value)) return 0
  if (/余额宝|基金|理财/.test(value)) return 4
  if (sourceType === 'bank') return 1
  return 2
}

function validAccountName(value) {
  const length = Array.from(String(value || '').normalize('NFKC').trim()).length
  return length >= 1 && length <= 32
}

async function recoverAccountConfirmation(page, issueId) {
  const session = page._draftSession, view = page._viewSession
  const issue = (page.businessData().accountIssues || []).find(item => item.issueId === issueId)
  const draft = page._accountUiDrafts.get(issueId)
  if (!session || !issue || !draft || (!session.status.syncing && session.view.viewVersion === view.summary.viewVersion)) {
    page.setData({ accountStepError: '整理结果已变化，选择已保留，请刷新本页后核验' })
    return false
  }
  const epoch = page._viewEpoch, scope = readCache.getSession(), owner = getApp().globalData.uid, revision = draft.revision || 0
  const decision = readCache.stableKey('account', page.accountMappingDecision(issue))
  const current = () => page._viewActive && page._viewEpoch === epoch && readCache.getSession() === scope &&
    getApp().hasLoginApproval() && getApp().globalData.uid === owner && page._draftSession === session && page.data.update &&
    page.data.update.updateId === session.state.updateId
  page.setData({ accountStepBusy: true, accountStepError: '', accountStepProgressText: '正在核验账户选择…' })
  try {
    // 等待原写入及其摘要，不另建请求；刷新前先保存下一项的未提交选择。
    session.saveDrafts(Object.fromEntries(page._accountUiDrafts), page.data.currentStep)
    if (session.status.syncing) await session.flush()
    if (!current()) return false
    if (session.status.conflicts || session.status.error || (session.view.viewVersion === view.summary.viewVersion && !view.active)) {
      page.setData({ accountStepError: session.status.error || '账户结果尚未核实，选择已保留，请重试同步' })
      return false
    }
    const pending = page._pendingBackgroundView
    const summary = pending && pending.viewVersion !== session.view.viewVersion
      ? await require('../../services/catledger-import').readSummary(session.state.updateId) : session.view
    if (!current()) return false
    page._editingInput = ''
    page._pendingBackgroundView = null
    await page.applyUpdateView(summary)
    if (!current()) return false
    if (page.data.update.status !== 'review' || session.view.update.status !== 'review') {
      page.setData({ accountStepError: '当前导入已结束，请查看最新结果' })
      return false
    }
    // 订阅可能已开始刷新，同版本分页会复用在途读取；必须等到账户页核验完成。
    await page.loadActivePage(true)
    if (!current()) return false
    const checkedView = page._viewSession, checkedVersion = checkedView.summary.viewVersion
    const unchanged = mapping => {
      const choice = page._accountUiDrafts.get(issueId)
      return current() && page._viewSession === checkedView && checkedView.active && checkedView.summary.viewVersion === checkedVersion &&
        (!page._pendingBackgroundView || page._pendingBackgroundView.viewVersion === checkedVersion) &&
        page.data.update.status === 'review' && !page.data.pageError && mapping && mapping.version === issue.version && choice &&
        (choice.revision || 0) === revision && readCache.stableKey('account', page.accountMappingDecision(mapping)) === decision
    }
    const mapping = page.mappingState().mappings.find(item => item.issueId === issueId)
    const choice = page._accountUiDrafts.get(issueId)
    if (!unchanged(mapping)) {
      page.setData({ accountStepError: '账户对应记录已变化，选择已保留，请核对后再次确认' })
      return false
    }
    if (choice.mode === 'account') {
      const data = page.businessData()
      let available = data.accounts.concat(data.accountDrafts).some(account => account.accountId === choice.accountId)
      if (!available) {
        const pinned = await page.loadDirectories([], [choice.accountId], ['accounts', 'accountDrafts'])
        if (!current()) return false
        available = pinned.accounts.concat(pinned.accountDrafts).some(account => account.accountId === choice.accountId)
      }
      if (!available) {
        page.setData({ accountStepError: '所选账户已不可用，原选择已保留，请重新选择后确认' })
        return false
      }
    }
    // 目录补查与调用方 await 都可能让出执行；入队前还要核对同一冻结决定。
    return { current, unchanged }
  } catch (error) {
    if (current()) page.setData({ accountStepError: publicError(error, '账户核验未完成，选择已保留，请重试') })
    return false
  } finally {
    if (current()) page.setData({ accountStepBusy: false, accountStepProgressText: '' })
  }
}

function showAccountChoice(event) {
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
}

function applyAccountChoice(event) {
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
}

module.exports = {
  ACCOUNT_TYPE_OPTIONS,
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
            typeIndex: suggestedAccountTypeIndex(issue.accountContext && issue.accountContext.label, issue.accountContext && issue.accountContext.sourceType),
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

  openAccountChoice: async function (event) {
    showAccountChoice.call(this, event)
    if (!this.data.accountChoiceSheet) return
    this.setData({ choiceKind: 'accounts' })
    this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind: 'accounts', pageSize: 12 })
    return this.changeChoicePage(event)
  },

  closeAccountChoice: function () {
    if (this._directoryPager) this._directoryPager.cancel()
    this._directoryPager = null
    this.setData({ accountChoiceSheet: null, accountChoiceQuery: '', accountChoiceResults: [], choiceLoading: false })
    this.applyPendingBackgroundView()
  },

  selectAccountChoice: function (event) {
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
    return applyAccountChoice.call(this, event)
  },

  closeAccountRecords: function () {
    if (this.data.busy) return
    this.closeInlineEvidence('account')
    if (this._accountPager) this._accountPager.cancel()
    this._accountPager = null
    if (this.data.busy) return
    this._accountEvidenceToken = null
    this._accountRecordList = []
    this.setData({ accountRecordsSheet: null })
    this.applyPendingBackgroundView()
  },

  bindAccountDraftName: function (event) {
    const draft = this._accountUiDrafts.get(event.currentTarget.dataset.id)
    if (!draft || this.data.accountStepBusy) return
    draft.name = event.detail.value
    draft.dirty = true
    draft.localConfirmed = false
    draft.revision = (draft.revision || 0) + 1
    this.setData({ accountStepError: '' })
    this.scheduleAccountDraftSync()
  },

  scheduleAccountDraftSync: function () {
    if (typeof setTimeout !== 'function') {
      this.persistAccountDrafts()
      this.refreshAccountMappings()
      return
    }
    if (this._accountDraftTimer) clearTimeout(this._accountDraftTimer)
    const self = this
    this._accountDraftTimer = setTimeout(function () {
        self._accountDraftTimer = null
        self.persistAccountDrafts()
        self.refreshAccountMappings()
      }, 300)
  },

  flushAccountDraftSync: function () {
    if (!this._accountDraftTimer) return
    clearTimeout(this._accountDraftTimer)
    this._accountDraftTimer = null
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

  completeAccountMapping: async function (event) {
    if (this.data.busy || this.data.accountStepBusy || !this.data.update) return
    this.flushAccountDraftSync()
    const issueId = event && event.currentTarget && event.currentTarget.dataset.id
    let recovered
    if (this._viewSession && !this._viewSession.active) {
      recovered = await recoverAccountConfirmation(this, issueId)
      if (!recovered || !recovered.current()) return
    }
    const mapping = this.refreshAccountMappings().mappings.find(function (item) { return item.issueId === issueId })
    if (recovered && !recovered.unchanged(mapping)) {
      this.setData({ accountStepError: '账户对应记录已变化，选择已保留，请核对后再次确认' })
      return
    }
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

  loadDirectories: async function (events = [], extraIds = [], kinds = ['accounts', 'categories', 'accountDrafts']) {
    const session = this._viewSession
    const pairs = await Promise.all(kinds.map(async kind => {
          const response = await session.read('financeUpdates.options', { kind, pageSize: 8 })
          const key = kind === 'categories' ? 'categoryId' : 'accountId'
          const pins = [...new Set((kind === 'categories' ? events.map(event => event.categoryId).filter(Boolean) : events.flatMap(event => model.eventAccountIds(event)
                  .concat((event.fundsProjection && event.fundsProjection.to && event.fundsProjection.to.candidates || []).map(row => row.accountId))))
              .concat(extraIds.filter(Boolean)))]
          .filter(id => !response.items.some(item => item[key] === id))
          const extra = pins.length ? (await session.read('financeUpdates.options', { kind, ids: pins, pageSize: 100 })).items : []
          return [kind, response.items.concat(extra)]
        }))
    return Object.fromEntries(pairs)
  },

  bindAccountChoiceSearch: function (event) {
    if (!this.data.accountChoiceSheet) return
    const query = String(event.detail.value || '').slice(0, 80)
    this.setData({ accountChoiceQuery: query })
    this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind: this.data.choiceKind, query, pageSize: 12 })
    // bindinput 必须同步结束，不能把异步目录读取返回给原生输入框。
    this.changeChoicePage(event)
  },

  changeChoiceKind: function (event) {
    const kind = event.currentTarget.dataset.kind
    if (!['accounts', 'accountDrafts'].includes(kind)) return
    this.setData({ choiceKind: kind, accountChoiceQuery: '' })
    this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind, pageSize: 12 })
    return this.changeChoicePage(event)
  },

  changeChoicePage: async function (event) {
    const pager = this._directoryPager
    const session = this._viewSession, scope = readCache.getSession(), version = session && session.summary.viewVersion
    const active = () => this._viewActive && this._viewSession === session && readCache.getSession() === scope &&
      session.summary.viewVersion === version && pager === this._directoryPager && this.data.accountChoiceSheet
    if (!pager || !active()) return
    this.setData({ choiceLoading: true, choiceError: '' })
    try {
      const response = await pager.load(direction(event))
      if (!active()) return
      this._choiceRows = response.items
      this.setData({ accountChoiceResults: model.accountSelectorOptions(this.data.choiceKind === 'accounts' ? response.items : [], this.data.choiceKind === 'accountDrafts' ? response.items : []), choicePage: response.page, choiceLoading: false })
    } catch (error) { if (active()) this.setData({ choiceLoading: false, choiceError: errorText(error) }) }
  },

  openDirectory: async function (event) {
    const target = event.currentTarget.dataset.target
    const issue = this.data.currentIssue
    const issueDirectory = Boolean(issue && ['account', 'counterparty', 'payment', 'paymentTarget', 'repayment', 'category'].includes(target))
    if (issueDirectory && (!this._viewActive || !this._viewSession || !this._viewSession.active || !getApp().hasLoginApproval() ||
      this.data.busy || this.data.issueStale || !this.data.issueDetailsReady)) return
    if (['reviewAccount', 'reviewCounterparty'].includes(target)) {
      const sheet = this.data.reviewEditSheet
      if (!sheet || sheet.loading || sheet.saving || sheet.pending || sheet.stale || sheet.saved) return
    }
    const editor = target === 'categoryEdit' && this.data.categoryEditSheet
    if (target === 'categoryEdit' && (!editor || editor.loading || editor.saving || editor.stale || editor.pending || editor.saved)) return
    const kind = ['category', 'categoryEdit'].includes(target) ? 'categories' : 'accounts'
    const categoryKind = editor ? editor.kind : undefined
    const reviewed = this.data.reviewEditSheet
    let issueOptions = ['reviewAccount', 'reviewCounterparty'].includes(target)
      ? { title: '选择' + (target === 'reviewAccount' ? reviewed.accountLabel : reviewed.destinationLabel) } : {}
    this._issueDirectoryToken = null
    if (issueDirectory) {
      const accountField = ['account', 'counterparty'].includes(target)
      const choices = this.data[target === 'counterparty' ? 'counterpartyAccountChoices' : 'accountChoices'] || []
      const selected = choices[this.data.issueDraft[target === 'counterparty' ? 'counterpartyAccountIndex' : 'accountIndex']]
      const labels = this.data.issueDetail || {}
      const routeLabel = issue.fundsRoute && !issue.aggregateRepayment && !labels.generic
        ? (target === 'counterparty' || issue.missingFundsSide === 'to' ? labels.fundsToLabel : labels.fundsFromLabel) : ''
      issueOptions = { issueDirectory: true,
        title: accountField ? '选择' + (routeLabel || (target === 'counterparty' ? labels.destinationLabel || '转入账户' : labels.selectorLabel || '资金账户'))
          : { repayment: '补充还入账户', payment: '补充付款账户', paymentTarget: '选择还入账户', category: '选择分类' }[target],
        canCreate: accountField ? choices.some(row => row.isCreate) : target === 'repayment' && this.data.repaymentAllocationChoices.length < 20,
        canClear: accountField && choices.some(row => row.isPlaceholder) && Boolean(selected && !selected.isPlaceholder) }
      this._issueDirectoryToken = { issueId: issue.issueId, issueVersion: issue.version, issueToken: this._issueEvidenceToken,
        session: this._viewSession, version: this._viewSession.summary.viewVersion, scope: readCache.getSession(), owner: getApp().globalData.uid }
    }
    if (this._optionPager) this._optionPager.cancel()
    const liabilityOnly = ['paymentTarget', 'repayment'].includes(target) || Boolean(issue && issue.repaymentOwnershipRequired && target === 'account')
    this.setData({ directorySheet: { target, kind, ...issueOptions, ...(categoryKind ? { categoryKind } : {}),
      liabilityOnly, selectedId: directorySelection(this.data, target), query: '', items: [], loading: true } })
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind, ...(categoryKind ? { categoryKind } : {}), pageSize: 12 })
    return this.changeDirectoryPage(event)
  },

  searchDirectory: function (event) {
    if (!this.data.directorySheet || !currentIssueDirectory(this)) return
    const query = String(event.detail.value || '').slice(0, 80)
    this.setData({ 'directorySheet.query': query })
    const categoryKind = this.data.directorySheet.categoryKind
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind: this.data.directorySheet.kind,
      ...(categoryKind ? { categoryKind } : {}), query, pageSize: 12 })
    this.changeDirectoryPage(event)
  },

  changeDirectoryKind: function (event) {
    const kind = event.currentTarget.dataset.kind
    if (!this.data.directorySheet || !currentIssueDirectory(this) || this.data.directorySheet.kind === 'categories' || !['accounts', 'accountDrafts'].includes(kind)) return
    this.setData({ 'directorySheet.kind': kind, 'directorySheet.query': '' })
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind, pageSize: 12 })
    return this.changeDirectoryPage(event)
  },

  changeDirectoryPage: async function (event) {
    const pager = this._optionPager
    const session = this._viewSession, scope = readCache.getSession(), version = session && session.summary.viewVersion
    const active = () => this._viewActive && this._viewSession === session && readCache.getSession() === scope &&
      session.summary.viewVersion === version && pager === this._optionPager && this.data.directorySheet && currentIssueDirectory(this)
    if (!pager || !active()) return
    this.setData({ 'directorySheet.loading': true, 'directorySheet.error': '' })
    try {
      const response = await pager.load(direction(event))
      if (!active()) return
      this.setData({ 'directorySheet.items': directoryRows(this.data.directorySheet, response.items), 'directorySheet.page': response.page, 'directorySheet.loading': false })
    } catch (error) { if (active()) this.setData({ 'directorySheet.loading': false, 'directorySheet.error': errorText(error) }) }
  },

  selectDirectory: function (event) {
    const sheet = this.data.directorySheet
    if (sheet && sheet.issueDirectory && (!currentIssueDirectory(this) || this.data.busy)) return
    if (sheet && !event.currentTarget.dataset.choice && (sheet.items[Number(event.currentTarget.dataset.index)] || {}).directoryDisabled) return
    if (sheet && sheet.issueDirectory && ['account', 'counterparty'].includes(sheet.target)) {
      const property = sheet.target === 'counterparty' ? 'counterpartyAccountChoices' : 'accountChoices'
      const change = sheet.target === 'counterparty' ? 'changeCounterpartyAccount' : 'changeIssueAccount'
      const choice = event.currentTarget.dataset.choice
      if (choice === 'clear' || choice === 'create') {
        const index = this.data[property].findIndex(row => choice === 'clear' ? row.isPlaceholder : row.isCreate)
        if (index < 0 || choice === 'create' && !sheet.canCreate) return
        this[change]({ detail: { value: index } }); this.closeDirectory()
        return
      }
      if (sheet.loading || sheet.error) return
      const item = sheet.items[Number(event.currentTarget.dataset.index)]
      if (!item) return
      const selected = sheet.kind === 'accountDrafts' ? Object.assign({}, item, { isDraft: true, name: item.name + '（本批新建）' }) : item
      const choices = this.data[property].filter(row => row.isPlaceholder).concat(selected,
        this.data[property].filter(row => row.isCreate))
      this.setData({ [property]: choices, accounts: this.data.accounts.filter(row => row.accountId !== item.accountId).slice(0, 11).concat(selected) })
      this[change]({ detail: { value: choices.findIndex(row => row.accountId === item.accountId) } })
      this.closeDirectory()
      return
    }
    if (sheet && sheet.issueDirectory && sheet.target === 'repayment' && event.currentTarget.dataset.choice === 'create') {
      if (!sheet.canCreate) return
      const index = this.data.repaymentAdditionalOptions.findIndex(row => row.isCreate)
      if (index < 0) return
      this.addRepaymentAccount({ detail: { value: index } }); this.closeDirectory()
      return
    }
    if (sheet && sheet.issueDirectory && (sheet.loading || sheet.error)) return
    if (sheet && ['reviewAccount', 'reviewCounterparty'].includes(sheet.target)) {
      const item = sheet.items[Number(event.currentTarget.dataset.index)]
      if (item && this.selectReviewedAccount(item, sheet.target)) this.closeDirectory()
      return
    }
    if (sheet && sheet.target === 'categoryEdit') {
      const item = sheet.items[Number(event.currentTarget.dataset.index)]
      if (item && this.selectEditedCategory(item)) this.closeDirectory()
      return
    }
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

  closeDirectory: function () {
    if (this._optionPager) this._optionPager.cancel(); this._optionPager = null; this._issueDirectoryToken = null; this.setData({ directorySheet: null })
  },

  openAccountRecords: async function (event) {
    const issueId = event.currentTarget.dataset.id
    if (!this._viewActive || !this._viewSession || !getApp().hasLoginApproval() || this.data.busy) return
    const mapping = this.data.accountMappings.find(item => item.issueId === issueId)
    if (!mapping) return
    this.closeInlineEvidence('account')
    if (this._accountPager) this._accountPager.cancel()
    this._accountPager = null
    const token = this._accountEvidenceToken = { session: this._viewSession, version: this._viewSession.summary.viewVersion,
      scope: readCache.getSession(), issueId, epoch: this._viewEpoch, owner: getApp().globalData.uid,
      updateId: this.data.update.updateId }
    this.setData({ accountRecordsSheet: { issueId, label: mapping.label, records: [], loading: true } })
    try {
      if (!this._viewSession.active || (this._pendingBackgroundView && this._pendingBackgroundView.viewVersion !== token.version)) {
        // 查看记录只恢复只读摘要；先保留账户输入，不触发重新整理或再次保存。
        if (this._draftSession) this._draftSession.saveDrafts(Object.fromEntries(this._accountUiDrafts), this.data.currentStep)
        const pending = this._pendingBackgroundView
        const summary = await require('../../services/catledger-import').readSummary(token.updateId)
        if (!currentAccountRecords(this, token)) return
        if (this._pendingBackgroundView && this._pendingBackgroundView.viewVersion !== summary.viewVersion &&
            (this._pendingBackgroundView !== pending || this._pendingBackgroundView.update.version > summary.update.version)) {
          throw new Error('账户记录仍在更新，请重新读取')
        }
        this._pendingBackgroundView = null
        await this.applyUpdateView(summary)
        if (!currentAccountRecords(this, token)) return
        if (!this._viewSession.active) throw new Error('账户记录仍在更新，请重新读取')
        token.session = this._viewSession; token.version = this._viewSession.summary.viewVersion
      }
      if (this._pendingBackgroundView && this._pendingBackgroundView.viewVersion !== token.version) throw new Error('账户记录仍在更新，请重新读取')
      this._accountPager = this._viewSession.pager('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 })
      return this.changeAccountMembers(event)
    } catch (error) {
      if (currentAccountRecords(this, token)) this.setData({ 'accountRecordsSheet.loading': false, 'accountRecordsSheet.error': errorText(error) })
    }
  },

  changeAccountMembers: async function (event) {
    const pager = this._accountPager
    const token = this._accountEvidenceToken
    if (!currentAccountRecords(this, token)) return
    if (!pager || !token.session.active || token.session.summary.viewVersion !== token.version ||
        (this._pendingBackgroundView && this._pendingBackgroundView.viewVersion !== token.version)) {
      return this.openAccountRecords({ currentTarget: { dataset: { id: token.issueId } } })
    }
    const active = () => currentAccountRecords(this, token) && pager === this._accountPager &&
      this._viewSession === token.session && token.session.summary.viewVersion === token.version &&
      (!this._pendingBackgroundView || this._pendingBackgroundView.viewVersion === token.version)
    if (!pager || !active()) return
    this.closeInlineEvidence('account')
    this.setData({ 'accountRecordsSheet.records': [], 'accountRecordsSheet.loading': true, 'accountRecordsSheet.error': '' })
    try {
      const response = await pager.load(direction(event))
      if (!active()) return
      const list = model.accountRecordList(response.items)
      this._accountRecordList = list.records.map(presentation.record)
      this.setData({ accountRecordsSheet: Object.assign({}, this.data.accountRecordsSheet, { records: this._accountRecordList, dateRange: '当前页 ' + list.dateRange,
              count: response.total, loading: false, hasMore: false, page: response.page }) })
      await this.loadInlineEvidence('account', this._accountRecordList)
    } catch (error) { if (active()) this.setData({ 'accountRecordsSheet.loading': false, 'accountRecordsSheet.error': errorText(error) }) }
  }
}
