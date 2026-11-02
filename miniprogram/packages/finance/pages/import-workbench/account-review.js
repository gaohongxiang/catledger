const { publicError } = require('./presentation')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const { errorText, direction } = require('./presentation')
const readCache = require('../../../../services/read-cache')
const accountTypes = require('../../domain/import-review/account-type-policy')
const draftPolicy = require('../../domain/import-review/account-draft-policy')
const displayGroups = require('./account-display-groups')
const accountPending = require('./account-pending')

function currentAccountRecords(page, token) {
  return token && page._viewActive && page._viewEpoch === token.epoch && page._accountEvidenceToken === token &&
    readCache.getSession() === token.scope && getApp().hasLoginApproval() && getApp().globalData.uid === token.owner &&
    page.data.update && page.data.update.updateId === token.updateId &&
    page.data.accountRecordsSheet && page.data.accountRecordsSheet.issueId === token.issueId
}

function currentIssueDirectory(page) {
  if (page.data.directorySheet && page.data.directorySheet.editorDirectory) {
    const token = page._editorDirectoryToken
    return Boolean(token && token.editor === page._reviewEditToken && page.isReviewEditorCurrent() && token.revision === (token.editor.editVersion || 0))
  }
  if (!page.data.directorySheet || !page.data.directorySheet.issueDirectory) return true
  const token = page._issueDirectoryToken, issue = page.data.currentIssue
  return Boolean(token && page._viewActive && page._viewSession === token.session && token.session.active &&
    readCache.getSession() === token.scope && getApp().hasLoginApproval() && getApp().globalData.uid === token.owner &&
    token.session.summary.viewVersion === token.version && !page.data.issueStale && issue &&
    issue.issueId === token.issueId && issue.version === token.issueVersion && page._issueEvidenceToken === token.issueToken)
}

// 账户和分类都是有限目录，一次读满协议上限；分页只是超过上限时的兜底。
const DIRECTORY_PAGE_SIZE = 100
const ACCOUNT_DIRECTORY_KINDS = ['accounts', 'accountDrafts']
// 账户目录一次读完；分类、贷款等可能较多的目录仍按小页读取。
const optionPageSize = kind => ACCOUNT_DIRECTORY_KINDS.includes(kind) ? DIRECTORY_PAGE_SIZE : 12
const ACCOUNT_TYPE_OPTIONS = Object.freeze([
    { value: 'cash', label: '现金' },
    { value: 'bank', label: '银行卡' },
    { value: 'wallet', label: '平台钱包' },
    { value: 'credit', label: '信用卡 / 消费信贷' },
    { value: 'other_asset', label: '其他资产' },
    { value: 'other_liability', label: '其他负债' }
  ])

function directorySelection(data, target) {
  if (target === 'categoryEdit') return (data.categoryEditSheet || {}).selectedId || ''
  const entry = target === 'category' ? (data.issueCategories || [])[data.issueDraft.categoryIndex]
    : target === 'account' ? (data.accountChoices || [])[data.issueDraft.accountIndex] : null
  return entry && (entry.accountId || entry.categoryId) || ''
}

function directoryRows(sheet, items) {
  return items.map(item => {
    const wrongType = sheet.allowedTypes ? !sheet.allowedTypes.includes(item.type)
      : sheet.liabilityOnly && !['credit', 'other_liability'].includes(item.type)
    const wrongCurrency = sheet.currency && item.currency && sheet.currency !== item.currency
    const unavailable = Boolean(item.archived || item.archivedAt || item.disabledAt || item.unavailable)
    const type = ACCOUNT_TYPE_OPTIONS.find(option => option.value === item.type)
    return { ...item, directorySelected: (sheet.kind === 'loans' ? item.loanId : item.accountId || item.categoryId) === sheet.selectedId,
      directoryDisabled: wrongType || wrongCurrency || unavailable,
      directoryMeta: unavailable ? (sheet.kind === 'categories' ? '分类不可用' : '账户不可用') : wrongCurrency ? '账户币种与本笔不同'
        : wrongType ? '账户类型不适用于当前资金端' : type ? type.label : '' }
  }).sort((a, b) => Number(a.directoryDisabled) - Number(b.directoryDisabled))
}

function suggestedAccountTypeIndex(label, sourceType, fundsSide, economicNature, context = {}) {
  const value = accountTypes.rules({ label, sourceType, fundsSide, ...context }, { event: { economicNature } })
  return ACCOUNT_TYPE_OPTIONS.findIndex(option => option.value === value.defaultAccountType)
}

function issueAccountContext(issue) {
  const context = issue.accountContext || {}, subject = issue.subject || {}
  const event = { ...subject, fieldSources: { accountOwnership: subject.accountOwnership,
    fundsProjection: subject.fundsProjection, installment: subject.installment, disbursement: subject.disbursement } }
  return { ...context, ...accountTypes.rules(context, { event }), currency: context.currency || subject.currency || 'CNY' }
}

function validAccountName(value) {
  const length = Array.from(String(value || '').normalize('NFKC').trim()).length
  return length >= 1 && length <= 32
}

// 只有随事项下发的三类结构能证明“这笔的钱关系还没定完”：组合支付、多账户
// 付款、还款分配。选了账本外之后，事件仍要在整理页补齐这些关系。其余复杂
// 情形（同笔配对、还款渠道等）页面读不到，不能靠猜，照旧留给服务端提示。
function ownershipRecheckNote(subject) {
  if (!subject) return ''
  return subject.paymentResolution || (subject.paymentAccounts || []).length ||
    (subject.repaymentAllocations || []).length
    ? '已记录归属，资金关系还要在整理页补齐。' : ''
}

function confirmSuggestedBatch(count, creates, ignores) {
  return new Promise(function (resolve) {
    const extras = [
      creates ? '新建 ' + creates + ' 个账户' : '',
      ignores ? '不计入 ' + ignores + ' 项' : ''
    ].filter(Boolean)
    wx.showModal({
      title: '确认账户',
      content: '将确认 ' + count + ' 项账户' + (extras.length ? '，其中' + extras.join('、') : '') + '。',
      confirmText: '确认',
      cancelText: '取消',
      success: function (result) { resolve(Boolean(result.confirm)) },
      fail: function () { resolve(false) }
    })
  })
}

// 拆开时记下每个成员当时的选择，之后任一成员被改过或确认过就不再允许合回去。
function choiceSignature(draft) {
  return [draft.mode, draft.accountId || '', draft.name || '', draft.typeIndex]
}

function selectionKey(page, mappings) {
  const originals = new Map((page.businessData().accountIssues || []).map(issue => [issue.issueId, issue]))
  return readCache.stableKey('account-confirmations', mappings.map(mapping => ({
    id: mapping.issueId, members: (mapping.groupIssueIds || [mapping.issueId]).map(id => [id, originals.get(id)?.version]),
    revision: page._accountUiDrafts.get(mapping.issueId)?.revision || 0, decision: page.accountMappingDecision(mapping)
  })))
}

function freezeSelection(page, mappings) {
  const view = page._viewSession, version = view?.summary.viewVersion, session = page._draftSession
  const epoch = page._viewEpoch, scope = readCache.getSession(), owner = getApp().globalData.uid
  const updateId = page.data.update.updateId, ids = mappings.map(mapping => mapping.issueId), key = selectionKey(page, mappings)
  return () => {
    if (!page._viewActive || page._viewEpoch !== epoch || readCache.getSession() !== scope || !getApp().hasLoginApproval() ||
        getApp().globalData.uid !== owner || page._draftSession !== session || page.data.update?.updateId !== updateId ||
        page._viewSession !== view || view && (!view.active || view.summary.viewVersion !== version) ||
        page._pendingBackgroundView && page._pendingBackgroundView.viewVersion !== version) return false
    const current = page.mappingState().mappings, selected = ids.map(id => current.find(mapping => mapping.issueId === id))
    return selected.every(mapping => mapping?.canConfirm) && selectionKey(page, selected) === key
  }
}

function currentAccountOperation(page) {
  const session = page._draftSession, epoch = page._viewEpoch, scope = readCache.getSession()
  const owner = getApp().globalData.uid, updateId = page.data.update?.updateId
  return () => page._viewActive && page._viewEpoch === epoch && page._draftSession === session &&
    readCache.getSession() === scope && getApp().hasLoginApproval() && getApp().globalData.uid === owner &&
    page.data.update?.updateId === updateId
}

async function finishAccountSelectionRead(page) {
  const current = currentAccountOperation(page)
  while (page._accountSelectionRefresh) {
    await page._accountSelectionRefresh
    if (!current()) return false
  }
  return current()
}

function syncGroupInput(page, issueId) {
  const group = (page.businessData().accountDisplayGroups || []).find(group => group.groupId === issueId)
  if (!group) return
  for (const id of displayGroups.syncInput(group, page._accountUiDrafts)) if (page._accountConfirmed) page._accountConfirmed.delete(id)
}

async function confirmDisplayMappings(page, mappings, current) {
  const session = page._draftSession, drafts = JSON.parse(JSON.stringify(Object.fromEntries(page._accountUiDrafts)))
  const groups = mappings.map(mapping => {
    const draft = drafts[mapping.issueId], issueIds = mapping.groupIssueIds || [mapping.issueId]
    // UI 输入和原事项决定同次落盘；失败时不能留下“已确认”的界面草稿。
    draft.localConfirmed = true; draft.dirty = false; draft.conflict = ''
    for (const id of issueIds) drafts[id] = { ...drafts[id], name: draft.name, typeIndex: draft.typeIndex }
    return { issueIds, decision: page.accountMappingDecision(mapping) }
  })
  displayGroups.clearCoveredDrafts(drafts, new Set(groups.flatMap(group => group.issueIds)),
    new Set(mappings.filter(mapping => mapping.groupId).map(mapping => mapping.groupId)))
  session.confirmAccountGroups({ groups, drafts })
  if (!current()) return
  page._accountUiDrafts = new Map(Object.entries(JSON.parse(JSON.stringify(session.state.drafts))))
  for (const mapping of mappings) for (const id of (mapping.groupIssueIds || []).concat(mapping.issueId)) {
    const draft = page._accountUiDrafts.get(id)
    if (draft && page._accountConfirmed) page._accountConfirmed.set(id, { revision: draft.revision || 0 })
  }
  page._editingInput = ''
  await page.applyUpdateView(session.view)
  if (!current()) return
  await page.loadActivePage(true)
}

async function refreshChangedDisplayGroup(page) {
  const session = page._draftSession, epoch = page._viewEpoch, scope = readCache.getSession(), owner = getApp().globalData.uid
  const current = () => page._viewActive && page._viewEpoch === epoch && page._draftSession === session &&
    readCache.getSession() === scope && getApp().hasLoginApproval() && getApp().globalData.uid === owner
  page.setData({ accountStepBusy: true, accountStepError: '' })
  try {
    session.saveDrafts(Object.fromEntries(page._accountUiDrafts), page.data.currentStep)
    await page.applyUpdateView(session.view)
    if (!current()) return
    await page.loadActivePage(true)
    if (!current()) return
    page.setData({ accountStepError: '账户对应记录已变化，选择已保留，请核对后再次确认' })
  } catch (error) { if (current()) page.setData({ accountStepError: publicError(error, '账户核验未完成，选择已保留，请重试') }) }
  finally { if (current()) page.setData({ accountStepBusy: false }) }
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
      ? await require('../../../../services/catledger-import').readSummary(session.state.updateId) : session.view
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
  const context = issueAccountContext(mapping)
  const options = model.accountSelectorOptions(this.data.accounts, this.data.accountDrafts, context)
  const recommendedAccount = mapping.recommendedAccountId
  ? options.find(function (option) { return option.accountId === mapping.recommendedAccountId }) || null
  : null
  const selectedValue = draft.mode === 'account' ? 'account:' + draft.accountId : draft.mode
  this.setData({
      accountChoiceSheet: {
        issueId: issueId,
        label: mapping.label,
        canExternal: mapping.canExternal,
        accountContext: context,
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
  const previousSelection = displayGroups.readSignature(this._accountUiDrafts)
  if (value.indexOf('account:') === 0) {
    const id = value.slice('account:'.length)
    const account = (this._choiceRows || []).concat(this.data.accounts || [], this.data.accountDrafts || []).find(row => row.accountId === id)
    if (!accountTypes.compatible(sheet.accountContext || {}, account)) return
    draft.mode = 'account'
    draft.accountId = id
    draft.explicitAccountSelection = true
    draft.accountFacts = { accountId: id, type: account.type, currency: account.currency }
    draft.recommendedAccountId = sheet.recommendedAccount &&
    sheet.recommendedAccount.accountId === draft.accountId ? draft.accountId : ''
  } else if (['create', 'ignore'].includes(value) || value === 'external' && sheet.canExternal) {
    if (value === 'create' && draft.mode !== 'create') { delete draft.createdAccountId; delete draft.creatorIssueId }
    draft.mode = value
    draft.accountId = ''
    draft.explicitAccountSelection = false
    draft.recommendedAccountId = ''
  } else {
    return
  }
  draft.conflict = ''
  draft.dirty = true
  draft.localConfirmed = false
  draft.revision = (draft.revision || 0) + 1
  if (this._accountConfirmed) this._accountConfirmed.delete(sheet.issueId)
  syncGroupInput(this, sheet.issueId)
  this.setData({
      accountStepError: '',
      accountChoiceSheet: null,
      accountChoiceQuery: '',
      accountChoiceResults: []
    })
  const saved = this.persistAccountDrafts()
  this.refreshAccountMappings()
  if (saved !== false && this._draftSession?.isLocal && previousSelection !== displayGroups.readSignature(this._accountUiDrafts)) {
    return this.refreshAccountSelectionGroups()
  }
}

module.exports = {
  ACCOUNT_TYPE_OPTIONS,
  suggestedAccountTypeIndex,
  refreshAccountSelectionGroups: function () {
    if (!this._draftSession?.isLocal || !this._draftSession.accountConfirmationDetails || !this._viewActive || this.data.currentStep !== 2) return
    if (this._editingInput) { this._pendingAccountGroupRefresh = true; return }
    const current = currentAccountOperation(this)
    const refresh = this.loadActivePage(true, undefined, true)
    const pending = Promise.resolve(refresh).finally(() => {
      if (this._accountSelectionRefresh === pending) this._accountSelectionRefresh = null
    })
    this._accountSelectionRefresh = pending
    return pending.then(() => current())
  },
  mappingState: function () {
    const data = this.businessData()
    return this.buildAccountMappingState(data.accountIssues || [], data.accounts || [], data.accountDrafts || [], [], data.accountDisplayGroups || [])
  },

  refreshAccountMappings: function () {
    const state = this.mappingState()
    const mappings = state.mappings.map(function (mapping) {
      const visible = displayGroups.compact(presentation.accountMapping(mapping))
      delete visible.choiceOptions
      visible.evidencePreview = Boolean(visible.evidencePreview)
      return visible
    })
    const isExcluded = mapping => mapping.choiceValue === 'ignore'
    // Keep an unconfirmed exclusion in the actionable list; only a confirmed
    // exclusion moves to the compact "本次不计入" section.
    const excluded = mappings.filter(function (mapping) { return isExcluded(mapping) && !mapping.needsConfirmation })
    const excludedIds = new Set(excluded.map(function (mapping) { return mapping.issueId }))
    setChangedData(this, { accountMappings: mappings,
      accountMappingsIncluded: mappings.filter(function (mapping) { return !excludedIds.has(mapping.issueId) }),
      accountMappingsExcluded: excluded, accountStepSummary: state.summary })
    return state
  },

  buildAccountMappingState: function (issues, accounts, accountDrafts, accountMappingDrafts, accountDisplayGroups = []) {
    const self = this
    const summary = { total: issues.length, ready: 0, confirmed: 0, invalid: 0, create: 0, inline: 0, transfer: 0, open: 0, dirty: 0, pending: 0, suggested: 0, suggestedCreate: 0 }
    const mappings = issues.map(function (issue) {
        if (issue.issueType !== 'account_mapping') {
          summary.transfer += 1
          return Object.assign({}, issue, { inline: false })
        }
        summary.inline += 1
        if (issue.status === 'open') summary.open += 1
        // 是否允许账本外由服务端／本机按全部成员统一判定；页面不再复制业务规则，
        // 保存时仍由服务端复核。旧快照缺少该字段时保守地不开放外部选择。
        const canExternal = Boolean(issue.subject && issue.accountContext?.canExternal === true)
        const accountContext = issueAccountContext(issue)
        const typeOptions = ACCOUNT_TYPE_OPTIONS.filter(option => accountContext.allowedAccountTypes.includes(option.value))
        const choices = model.accountChoiceOptions(accounts, accountDrafts, { canExternal, context: accountContext })
        const mappingDraft = (accountMappingDrafts || []).find(function (item) {
          return issue.subject && item.eventId === issue.subject.eventId && issue.accountContext &&
            item.sourceType === issue.accountContext.sourceType &&
            item.paymentMethodKey === (issue.accountContext.bindingKey || issue.accountContext.paymentMethodKey)
        })
        const resolvedAccountId = issue.status === 'resolved' && issue.accountContext && issue.accountContext.accountId
        const resolvedExternal = issue.status === 'resolved' && canExternal && Boolean(
          mappingDraft && mappingDraft.mappingAction === 'external' || issue.accountContext && issue.accountContext.mappingAction === 'external')
        // “已解决但没拿到账户”不是排除决定。只有本批映射或整组明确排除记录
        // 才能显示本次不计入；旧快照的矛盾状态须留在待确认。
        const resolvedExclusion = issue.status === 'resolved' && Boolean(
          mappingDraft && mappingDraft.mappingAction === 'ignore' ||
          (issue.reasonCodes || []).some(code => ['account_mapping_excluded', 'source_account_ignored_default'].includes(code)))
        const missingResolution = issue.status === 'resolved' && !resolvedAccountId && !resolvedExclusion && !resolvedExternal
        let draft = self._accountUiDrafts.get(issue.issueId)
        if (missingResolution && draft && !draft.dirty && !draft.localConfirmed) draft = null
        // 完整本批可能已推荐到目录后页的账户。联合读取补齐目录后，只更新未触碰的默认值。
        const selectedGroup = accountDisplayGroups.find(group => group.groupReason === 'selected_account' && group.issueIds.includes(issue.issueId))
        if (selectedGroup && issue.status === 'open' && draft && !draft.dirty && !draft.localConfirmed && !draft.explicitAccountSelection) {
          const suggested = model.suggestExistingAccount(accountContext, accounts)
          if (suggested?.accountId === selectedGroup.selectedAccountId &&
              (draft.mode !== 'account' || draft.accountId !== suggested.accountId)) draft = null
        }
        if (!draft) {
          const resolvedMode = resolvedExclusion ? 'ignore' : resolvedExternal ? 'external' : resolvedAccountId ? 'account' : ''
          const suggestedName = issue.accountContext && issue.accountContext.recognized
          ? issue.accountContext.label
          : ''
          const suggestedAccount = model.suggestExistingAccount(accountContext, accounts)
          draft = {
            mode: resolvedMode || (suggestedAccount ? 'account' : suggestedName ? 'create' : 'pending'),
            accountId: resolvedAccountId || (suggestedAccount ? suggestedAccount.accountId : ''),
            accountFacts: accounts.concat(accountDrafts).find(account => account.accountId === resolvedAccountId) || suggestedAccount || null,
            recommendedAccountId: suggestedAccount ? suggestedAccount.accountId : '',
            name: suggestedName,
            typeIndex: suggestedAccountTypeIndex(issue.accountContext && issue.accountContext.label, issue.accountContext && issue.accountContext.sourceType,
              issue.accountContext && issue.accountContext.fundsSide, issue.subject && issue.subject.economicNature, accountContext),
            dirty: false,
            localConfirmed: false,
            revision: 0
          }
          self._accountUiDrafts.set(issue.issueId, draft)
        }
        const confirmed = self._accountConfirmed && self._accountConfirmed.get(issue.issueId)
        if (confirmed && confirmed.revision === (draft.revision || 0)) { draft.localConfirmed = true; draft.dirty = false }
        if (draft.mode === 'create' && draft.localConfirmed && resolvedAccountId &&
            accountDrafts.some(row => row.accountId === resolvedAccountId)) draft.createdAccountId = resolvedAccountId
        if (!draft.dirty && !draft.localConfirmed && !accountContext.allowedAccountTypes.includes(ACCOUNT_TYPE_OPTIONS[draft.typeIndex]?.value)) {
          draft.typeIndex = ACCOUNT_TYPE_OPTIONS.findIndex(option => option.value === accountContext.defaultAccountType)
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
        const nameValid = validAccountName(draft.name)
        const nameConflict = draft.mode === 'create' && nameValid && accounts.concat(accountDrafts).some(account =>
          account.accountId !== draft.createdAccountId && draftPolicy.normalizeName(account.name).normalizedName === draftPolicy.normalizeName(draft.name).normalizedName)
        const typeValid = accountContext.allowedAccountTypes.includes(ACCOUNT_TYPE_OPTIONS[draft.typeIndex]?.value)
        const selectedAccount = accounts.concat(accountDrafts).find(account => account.accountId === draft.accountId) ||
          (draft.accountFacts?.accountId === draft.accountId ? draft.accountFacts : null)
        const ready = draft.mode === 'create' ? nameValid && typeValid && !nameConflict
          : draft.mode === 'account' ? accountTypes.compatible(accountContext, selectedAccount) : draft.mode !== 'pending'
        if (ready) summary.ready += 1
        else summary.invalid += 1
        if (draft.mode === 'create') summary.create += 1
        if (draft.dirty) summary.dirty += 1
        const needsConfirmation = !ready || ((issue.status === 'open' || missingResolution || draft.dirty) && !draft.localConfirmed)
        if (needsConfirmation) summary.pending += 1
        else summary.confirmed += 1
        // 一键确认只覆盖页面已经给出建议且用户未改动的项；待选择和已修改项仍逐项确认。
        if (needsConfirmation && ready && !draft.dirty && !['pending', 'ignore', 'external'].includes(draft.mode)) {
          summary.suggested += 1
          if (draft.mode === 'create') summary.suggestedCreate += 1
        }
        const choiceName = issue.paymentNeedsReview && issue.status === 'open' ? '确认付款账户' : choices[choiceIndex].name
        return Object.assign({}, issue, {
            inline: true,
            accountContext,
            canExternal,
            needsConfirmation: needsConfirmation,
            canConfirm: ready,
            dirty: draft.dirty,
            // 选中的就是标题那个账户且用户没改过时，不再渲染一遍下拉框；改过就放回选择器。
            choiceMatchesTitle: !draft.dirty && displayGroups.titleMatchesChoice(issue.label, draft.mode === 'create' ? draft.name : choiceName),
            summaryText: ['ignore', 'external'].includes(draft.mode)
            ? choices[choiceIndex].name
            : '记入：' + (draft.mode === 'create' ? String(draft.name || '').trim() + '（' + (ACCOUNT_TYPE_OPTIONS[draft.typeIndex] || {}).label + '）' : choices[choiceIndex].name) + ' · 已确认',
            evidencePreview: issue.subject ? model.accountEvidenceView(issue.subject) : null,
            choiceOptions: choices,
            choiceIndex: choiceIndex,
            choiceValue: choices[choiceIndex].value,
            choiceName: choiceName,
            // 来源是账单侧的事实；服务端没下发账户上下文时这里是空的。
            // 不能拿 label 兜底（那是问题类型名），否则卡片会写成「来源：确认账户归属」。
            sourceLabel: String(accountContext.label || '').trim(),
            // 真没有来源名时，至少把交易对方带出来，否则两张卡长得一模一样。
            sourceHint: String((issue.subject && issue.subject.primaryEvidence &&
              (issue.subject.primaryEvidence.counterparty || issue.subject.primaryEvidence.item)) || '').trim(),
            suggestedExisting: Boolean(draft.recommendedAccountId && draft.mode === 'account' &&
              draft.accountId === draft.recommendedAccountId),
            recommendedAccountId: draft.recommendedAccountId,
            draftName: draft.name,
            draftNameValid: nameValid,
            draftTypeIndex: draft.typeIndex,
            typeOptions,
            // 只剩一种合法类型时不再给一个点了没反应的下拉。
            typeLocked: typeOptions.length <= 1,
            draftTypeOptionIndex: Math.max(0, typeOptions.findIndex(option => option.value === ACCOUNT_TYPE_OPTIONS[draft.typeIndex]?.value)),
            draftTypeLabel: ACCOUNT_TYPE_OPTIONS[draft.typeIndex]?.label || '请选择类型',
            ownershipNote: choiceValue === 'external' ? ownershipRecheckNote(issue.subject) : '',
            validationText: nameConflict ? draftPolicy.NAME_CONFLICT : draft.mode === 'create' && !typeValid ? '账户类型与来源或资金角色不符，请重新选择'
              : draft.mode === 'account' && !ready ? '所选账户类型或币种不符，请重新选择' : ''
          })
      })
    const visible = displayGroups.fold({ mappings, groups: accountDisplayGroups, drafts: self._accountUiDrafts,
      accounts, accountDrafts, typeOptions: ACCOUNT_TYPE_OPTIONS, ownershipNote: ownershipRecheckNote })
    // 已拆开的联合卡把恢复入口挂在原锚点卡上；成员被改过或确认过就不再提供。
    const rawById = new Map(mappings.map(mapping => [mapping.issueId, mapping]))
    for (const [jointId, joint] of self._accountUiDrafts) {
      if (!joint.separated || !Array.isArray(joint.separatedMembers)) continue
      const anchor = visible.find(mapping => mapping.issueId === joint.anchorIssueId)
      if (!anchor) continue
      anchor.restoreGroupId = jointId
      anchor.restoreBlocked = !joint.separatedMembers.every(id => {
        const row = rawById.get(id), draft = self._accountUiDrafts.get(id)
        return row && row.inline && row.status !== 'resolved' && draft && !draft.localConfirmed &&
          JSON.stringify(choiceSignature(draft)) === JSON.stringify((joint.separatedSnapshot || {})[id])
      })
    }
    // 旧版本拆开的卡没有留下联合草稿：同一显示账户名下的成员仍按同一张卡处理，同样允许合回。
    const legacy = new Map()
    for (const mapping of mappings) {
      const draft = self._accountUiDrafts.get(mapping.issueId)
      if (!mapping.inline || !draft || !draft.confirmationSeparate) continue
      const context = mapping.accountContext || {}
      const key = (context.label || '') + '|' + (context.currency || '')
      if (!legacy.has(key)) legacy.set(key, [])
      legacy.get(key).push(mapping)
    }
    for (const [key, members] of legacy) {
      if (members.length < 2) continue
      const anchor = visible.find(mapping => mapping.issueId === members[0].issueId)
      if (!anchor || anchor.restoreGroupId) continue
      anchor.restoreGroupId = 'legacy:' + key
      anchor.restoreBlocked = !members.every(member => member.status !== 'resolved' && !member.dirty)
    }
    // 批量确认前检查整个可见账户目录，不能先新建一项再把后面的同名创建悄悄复用。
    for (const key of ['ready', 'invalid', 'pending', 'confirmed', 'suggested', 'suggestedCreate',
      'batchable', 'batchableCreate', 'batchableIgnore', 'unselected', 'displayConfirmed', 'displayPending',
      'plannedCreate']) summary[key] = 0
    for (const mapping of mappings) if (mapping.inline) {
      if (mapping.canConfirm) summary.ready++; else { summary.invalid++; mapping.needsConfirmation = true }
      if (mapping.needsConfirmation) summary.pending++; else summary.confirmed++
    }
    summary.displayTotal = visible.length
    for (const mapping of visible) if (mapping.inline) {
      if (!mapping.needsConfirmation) summary.displayConfirmed++; else summary.displayPending++
      // 只要已经选好且可确认，就都可以交给底部一次确认；改选、新建、不计入不再逼用户逐项点。
      if (mapping.needsConfirmation && mapping.canConfirm) {
        summary.batchable++
        if (mapping.choiceValue === 'create') summary.batchableCreate++
        if (mapping.choiceValue === 'ignore') summary.batchableIgnore++
      }
      if (mapping.needsConfirmation && !mapping.canConfirm) summary.unselected++
      if (mapping.needsConfirmation && mapping.canConfirm && !mapping.dirty && !['pending', 'ignore', 'external'].includes(mapping.choiceValue)) {
        summary.suggested++
        if (mapping.choiceValue === 'create') summary.suggestedCreate++
      }
    }
    // 底部按钮要说清这批发下去会不会建账户。新建是入账后的副作用，
    // 跟这一项有没有确认过无关，所以按「可确认的新建项」算，不看 needsConfirmation。
    for (const mapping of visible) if (mapping.inline && mapping.canConfirm && mapping.choiceValue === 'create') {
      summary.plannedCreate++
    }
    const notes = []
    if (summary.plannedCreate > 0) notes.push('本批将新建 ' + summary.plannedCreate + ' 个账户')
    if (summary.batchableIgnore > 0) notes.push(summary.batchableIgnore + ' 项不计入')
    summary.batchNote = notes.join(' · ')
    const visiblePending = summary.pending
    summary.pending = accountPending.count(self, summary.pending)
    summary.pendingOutside = summary.pending > visiblePending
    return { mappings: visible, rawMappings: mappings, summary }
  },

  openAccountChoice: async function (event) {
    showAccountChoice.call(this, event)
    if (!this.data.accountChoiceSheet) return
    this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind: 'accounts', pageSize: DIRECTORY_PAGE_SIZE })
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
      const isDraft = (data.accountDrafts || []).some(row => row.accountId === id)
      // 选中项可能来自搜索或分页；只补进目录，不截断其它账户，
      // 否则后面的卡片会丢失可选账户和按名称推荐。
      if (!isDraft && !(data.accounts || []).some(row => row.accountId === id)) {
        data.accounts = (data.accounts || []).concat(selected)
        this.setData({ accounts: data.accounts })
      }
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
    syncGroupInput(this, event.currentTarget.dataset.id)
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
    const issueId = event.currentTarget.dataset.id
    const draft = this._accountUiDrafts.get(issueId)
    if (!draft || this.data.accountStepBusy) return
    const mapping = this.mappingState().mappings.find(item => item.issueId === issueId)
    const selected = mapping?.typeOptions[Number(event.detail.value)]
    if (!selected) return
    draft.typeIndex = ACCOUNT_TYPE_OPTIONS.findIndex(option => option.value === selected.value)
    draft.dirty = true
    draft.localConfirmed = false
    draft.revision = (draft.revision || 0) + 1
    syncGroupInput(this, issueId)
    this.setData({ accountStepError: '' })
    this.persistAccountDrafts()
    this.refreshAccountMappings()
  },

  completeAccountMapping: async function (event) {
    const requestedId = event && event.currentTarget && event.currentTarget.dataset.id
    const requestedMembers = this.mappingState().mappings.find(item => item.issueId === requestedId)?.groupIssueIds || [requestedId]
    if (this._accountSelectionRefresh && !await finishAccountSelectionRead(this)) return
    if (this.data.busy || this.data.accountStepBusy || !this.data.update) return
    this._accountScrollTarget = this._pageScrollTop
    this.flushAccountDraftSync()
    const issueId = requestedId
    const currentMapping = this.mappingState().mappings.find(item => item.issueId === issueId)
    const currentMembers = currentMapping?.groupIssueIds || (currentMapping ? [currentMapping.issueId] : [])
    if (requestedId && (requestedMembers.length !== currentMembers.length || requestedMembers.some(id => !currentMembers.includes(id)))) {
      this.setData({ accountStepError: '账户对应记录已变化，选择已保留，请核对后再次确认' })
      return
    }
    let recovered
    if (this._viewSession && !this._viewSession.active) {
      if (this.mappingState().mappings.some(item => item.issueId === issueId && item.groupId)) return refreshChangedDisplayGroup(this)
      recovered = await recoverAccountConfirmation(this, issueId)
      if (!recovered || !recovered.current()) return
    }
    const mapping = this.refreshAccountMappings().mappings.find(function (item) { return item.issueId === issueId })
    if (recovered && !recovered.unchanged(mapping)) {
      this.setData({ accountStepError: '账户对应记录已变化，选择已保留，请核对后再次确认' })
      return
    }
    if (!mapping || !mapping.inline || !mapping.canConfirm) {
      this.setData({ accountStepError: mapping?.validationText || '请选择账户归属；选择新建时，请补全账户名称' })
      return
    }
    if (this._draftSession?.confirmAccountGroups) {
      const current = currentAccountOperation(this)
      if (!current()) return
      this.setData({ accountStepBusy: true, accountStepError: '' })
      try { await confirmDisplayMappings(this, [mapping], current) }
      catch (error) { if (current()) this.setData({ accountStepError: publicError(error, '本机草稿未保存，请重试') }) }
      finally { if (current()) { this.setData({ accountStepBusy: false }); this.refreshAccountMappings(); this.restoreAccountScroll() } }
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
    if (this._accountConfirmed) this._accountConfirmed.set(issueId, { revision: draft.revision || 0 })
    this.setData({ accountStepError: '' })
    this.refreshAccountMappings()
    this.restoreAccountScroll()
  },

  // 首次导入的旧映射只作建议，确认一次后才可复用；批量确认仍是一次明确的人工决定。
  confirmAllAccountMappings: async function () {
    if (this._accountSelectionRefresh && !await finishAccountSelectionRead(this)) return
    if (this.data.busy || this.data.accountStepBusy || !this.data.update) return
    this._accountScrollTarget = this._pageScrollTop
    this.flushAccountDraftSync()
    const collect = () => this.refreshAccountMappings().mappings.filter(function (item) {
      return item.inline && item.needsConfirmation && item.canConfirm
    })
    let targets = collect()
    if (!targets.length) return
    if (this._viewSession && !this._viewSession.active) {
      if (targets.some(item => item.groupId)) return refreshChangedDisplayGroup(this)
      const recovered = await recoverAccountConfirmation(this, targets[0].issueId)
      if (!recovered || !recovered.current()) return
      targets = collect()
      if (!targets.length) return
    }
    // 一键确认可能同时建出几个正式账户／排除几组记录，按实际待确认项再问一次。
    const creates = targets.filter(item => item.choiceValue === 'create').length
    const ignores = targets.filter(item => item.choiceValue === 'ignore').length
    const unchanged = freezeSelection(this, targets)
    if (!await confirmSuggestedBatch(targets.length, creates, ignores)) return
    if (!unchanged()) { this.setData({ accountStepError: '账户选择或对应记录已变化，请核对后再次确认' }); return }
    const current = currentAccountOperation(this)
    this.setData({ accountStepBusy: true, accountStepError: '', accountStepProgressText: '正在确认 ' + targets.length + ' 项账户…' })
    try {
      if (this._draftSession?.confirmAccountGroups) {
        await confirmDisplayMappings(this, targets, current)
        if (current()) this.setData({ accountStepError: '' })
        return
      }
      // 草稿会话一次最多接收 8 项未保存决定；超过时分段入队并等待上一段保存。
      for (let start = 0; start < targets.length; start += 8) {
        const chunk = targets.slice(start, start + 8)
        const changes = chunk.map(mapping => {
          const draft = this._accountUiDrafts.get(mapping.issueId)
          return { kind: 'account', issueId: mapping.issueId, issueVersion: mapping.version, revision: draft.revision || 0,
            decision: this.accountMappingDecision(mapping) }
        })
        if (this._draftSession) this._draftSession.enqueue(changes, Object.fromEntries(this._accountUiDrafts))
        for (const mapping of chunk) {
          const draft = this._accountUiDrafts.get(mapping.issueId)
          draft.localConfirmed = true
          if (this._accountConfirmed) this._accountConfirmed.set(mapping.issueId, { revision: draft.revision || 0 })
        }
        if (start + 8 < targets.length && this._draftSession) await this._draftSession.flush()
      }
      this.setData({ accountStepError: '' })
    } catch (error) {
      if (current()) this.setData({ accountStepError: publicError(error, '本机草稿未保存，请重试') })
    } finally {
      if (current()) {
        this.setData({ accountStepBusy: false, accountStepProgressText: '' })
        this.refreshAccountMappings()
        this.restoreAccountScroll()
      }
    }
  },

  separateAccountGroup: async function (event) {
    if (this._accountSelectionRefresh && !await finishAccountSelectionRead(this)) return
    if (this.data.busy || this.data.accountStepBusy) return
    this.flushAccountDraftSync()
    const mapping = this.mappingState().mappings.find(row => row.issueId === event.currentTarget.dataset.id)
    if (!mapping?.groupId) return
    const current = currentAccountOperation(this)
    if (!current()) return
    const previous = JSON.parse(JSON.stringify(Object.fromEntries(this._accountUiDrafts)))
    const joint = this._accountUiDrafts.get(mapping.groupId)
    const snapshot = {}
    for (const id of mapping.groupIssueIds) {
      const draft = this._accountUiDrafts.get(id)
      // 联合卡里新输入的内容拆开后仍可核对；原先各自不同的草稿不相互覆盖。
      if (joint.dirty && joint.revision > 0 && (joint.mode !== 'create' || !joint.createdAccountId || joint.creatorIssueId === id)) {
        for (const key of ['mode', 'accountId', 'accountFacts', 'accountName', 'name', 'typeIndex', 'explicitAccountSelection']) draft[key] = joint[key]
        draft.dirty = true; draft.localConfirmed = false; draft.revision = (draft.revision || 0) + 1
        if (this._accountConfirmed) this._accountConfirmed.delete(id)
      }
      draft.confirmationSeparate = true
      snapshot[id] = choiceSignature(draft)
    }
    // 保留联合草稿并标记已拆分：成员都没再改动时可以合回去，避免一次误点不可逆。
    joint.separated = true
    joint.separatedMembers = mapping.groupIssueIds.slice()
    joint.separatedSnapshot = snapshot
    joint.anchorIssueId = mapping.groupAnchorIssueId || mapping.groupIssueIds[0]
    if (this._accountConfirmed) this._accountConfirmed.delete(mapping.groupId)
    this.setData({ accountStepBusy: true, accountStepError: '' })
    try {
      if (this._draftSession) this._draftSession.saveDrafts(Object.fromEntries(this._accountUiDrafts), this.data.currentStep)
      await this.loadActivePage(true)
    } catch (error) {
      if (!current()) return
      this._accountUiDrafts = new Map(Object.entries(this._draftSession?.state.drafts || previous))
      this.setData({ accountStepError: publicError(error, '分别确认的选择未保存，请重试') })
    } finally { if (current()) { this.setData({ accountStepBusy: false }); this.refreshAccountMappings() } }
  },

  // 拆开只是这批的本地偏好；成员都还没动过时允许合回同一张卡。
  restoreAccountGroup: async function (event) {
    if (this._accountSelectionRefresh && !await finishAccountSelectionRead(this)) return
    if (this.data.busy || this.data.accountStepBusy) return
    this.flushAccountDraftSync()
    const target = String(event.currentTarget.dataset.id || '')
    const rows = (this.mappingState().rawMappings || [])
    const blockedText = '已有一张卡被修改或确认，不能再合并回去。'
    let members, joint = null
    if (target.indexOf('legacy:') === 0) {
      // 旧版本拆开的卡没有联合草稿，按同一显示账户名找回同组成员。
      const key = target.slice('legacy:'.length)
      members = rows.filter(mapping => {
        const draft = this._accountUiDrafts.get(mapping.issueId)
        if (!mapping.inline || !draft || !draft.confirmationSeparate) return false
        const context = mapping.accountContext || {}
        return (context.label || '') + '|' + (context.currency || '') === key
      })
      if (members.length < 2) return
      if (!members.every(member => member.status !== 'resolved' && !member.dirty)) {
        this.setData({ accountStepError: blockedText }); return
      }
    } else {
      joint = this._accountUiDrafts.get(target)
      if (!joint || !joint.separated || !Array.isArray(joint.separatedMembers)) return
      const byId = new Map(rows.map(row => [row.issueId, row]))
      const blocked = !joint.separatedMembers.every(id => {
        const row = byId.get(id), draft = this._accountUiDrafts.get(id)
        return row && row.inline && row.status !== 'resolved' && draft && !draft.localConfirmed &&
          JSON.stringify(choiceSignature(draft)) === JSON.stringify(joint.separatedSnapshot[id])
      })
      if (blocked) { this.setData({ accountStepError: blockedText }); return }
      members = joint.separatedMembers.map(id => ({ issueId: id }))
    }
    const current = currentAccountOperation(this)
    if (!current()) return
    const previous = JSON.parse(JSON.stringify(Object.fromEntries(this._accountUiDrafts)))
    for (const member of members) {
      const draft = this._accountUiDrafts.get(member.issueId)
      if (draft) delete draft.confirmationSeparate
    }
    if (joint) {
      delete joint.separated
      delete joint.separatedMembers
      delete joint.separatedSnapshot
    }
    this.setData({ accountStepBusy: true, accountStepError: '' })
    try {
      if (this._draftSession) this._draftSession.saveDrafts(Object.fromEntries(this._accountUiDrafts), this.data.currentStep)
      await this.loadActivePage(true)
    } catch (error) {
      if (!current()) return
      this._accountUiDrafts = new Map(Object.entries(this._draftSession?.state.drafts || previous))
      this.setData({ accountStepError: publicError(error, '恢复合并未保存，请重试') })
    } finally { if (current()) { this.setData({ accountStepBusy: false }); this.refreshAccountMappings() } }
  },

  persistAccountDrafts: function () {
    if (!this._draftSession) return true
    try { this._draftSession.saveDrafts(Object.fromEntries(this._accountUiDrafts), this.data.currentStep); return true }
    catch (error) {
      this._accountUiDrafts = new Map(Object.entries(JSON.parse(JSON.stringify(this._draftSession.state.drafts))))
      this.setData({ accountStepError: publicError(error, '本机草稿未保存，请检查存储空间后重试') })
      return false
    }
  },

  accountMappingDecision: function (mapping) {
    const draft = this._accountUiDrafts.get(mapping.issueId)
    const decision = { issueId: mapping.issueId, issueVersion: mapping.version, operation: mapping.status === 'resolved' ? 'revise' : 'resolve' }
    if (draft.mode === 'ignore') {
      decision.decision = 'exclude_events'
    } else if (draft.mode === 'external' && mapping.canExternal) {
      decision.decision = 'apply_fields'
      decision.paymentRuleAction = 'external'
      decision.fields = {}
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
          const response = await session.read('financeUpdates.options', { kind, pageSize: DIRECTORY_PAGE_SIZE })
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
    this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind: 'accounts', query, pageSize: DIRECTORY_PAGE_SIZE })
    // bindinput 必须同步结束，不能把异步目录读取返回给原生输入框。
    this.changeChoicePage(event)
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
      // 本批新建账户直接并入同一列表，用后缀区分；不再切换目录。
      const search = model.normalizePaymentAccountName(this.data.accountChoiceQuery)
      const drafts = (this.data.accountDrafts || []).filter(account =>
        !search || model.normalizePaymentAccountName(account.name).includes(search))
      const context = this.data.accountChoiceSheet.accountContext
      this._choiceRows = response.items.concat(drafts).filter(account => accountTypes.compatible(context || {}, account))
      this.setData({ accountChoiceResults: model.accountSelectorOptions(response.items, drafts, context), choicePage: response.page, choiceLoading: false })
    } catch (error) { if (active()) this.setData({ choiceLoading: false, choiceError: errorText(error) }) }
  },

  openDirectory: async function (event) {
    const target = event.currentTarget.dataset.target
    const editorDirectory = ['reviewAccount', 'reviewCounterparty'].includes(target) || /^editor/.test(target)
    const editorOptions = editorDirectory ? this.reviewEditorDirectory(target) : null
    if (editorDirectory && !editorOptions) return
    const issue = this.data.currentIssue
    const issueDirectory = Boolean(issue && ['account', 'category'].includes(target))
    if (issueDirectory && (!this._viewActive || !this._viewSession || !this._viewSession.active || !getApp().hasLoginApproval() ||
      this.data.busy || this.data.issueStale || !this.data.issueDetailsReady)) return
    const editor = target === 'categoryEdit' && this.data.categoryEditSheet
    if (target === 'categoryEdit' && (!editor || editor.loading || editor.saving || editor.stale || editor.pending || editor.saved)) return
    const kind = editorOptions ? editorOptions.kind : ['category', 'categoryEdit'].includes(target) ? 'categories' : 'accounts'
    const categoryKind = editorOptions ? editorOptions.categoryKind : editor ? editor.kind : undefined
    let issueOptions = editorOptions ? { ...editorOptions, editorDirectory: true } : {}
    this._editorDirectoryToken = editorDirectory ? { editor: this._reviewEditToken, revision: this._reviewEditToken.editVersion || 0 } : null
    this._issueDirectoryToken = null
    if (issueDirectory) {
      const choices = this.data.accountChoices || []
      const selected = choices[this.data.issueDraft.accountIndex]
      issueOptions = { issueDirectory: true, title: target === 'account' ? '选择账本账户' : '选择分类',
        canCreate: target === 'account' && choices.some(row => row.isCreate),
        canClear: target === 'account' && choices.some(row => row.isPlaceholder) && Boolean(selected && !selected.isPlaceholder) }
      this._issueDirectoryToken = { issueId: issue.issueId, issueVersion: issue.version, issueToken: this._issueEvidenceToken,
        session: this._viewSession, version: this._viewSession.summary.viewVersion, scope: readCache.getSession(), owner: getApp().globalData.uid }
    }
    if (this._optionPager) this._optionPager.cancel()
    const liabilityOnly = false
    this.setData({ directorySheet: { target, kind, ...issueOptions, ...(categoryKind ? { categoryKind } : {}),
      liabilityOnly, selectedId: editorOptions ? editorOptions.selectedId : directorySelection(this.data, target), query: '', items: [], loading: true } })
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind, ...(categoryKind ? { categoryKind } : {}), pageSize: optionPageSize(kind) })
    return this.changeDirectoryPage(event)
  },

  searchDirectory: function (event) {
    if (!this.data.directorySheet || !currentIssueDirectory(this)) return
    const query = String(event.detail.value || '').slice(0, 80)
    this.setData({ 'directorySheet.query': query })
    const categoryKind = this.data.directorySheet.categoryKind
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind: this.data.directorySheet.kind,
      ...(categoryKind ? { categoryKind } : {}), query, pageSize: optionPageSize(this.data.directorySheet.kind) })
    this.changeDirectoryPage(event)
  },

  changeDirectoryKind: function (event) {
    const kind = event.currentTarget.dataset.kind
    if (!this.data.directorySheet || !currentIssueDirectory(this) || !['accounts', 'accountDrafts'].includes(this.data.directorySheet.kind) || !['accounts', 'accountDrafts'].includes(kind)) return
    this.setData({ 'directorySheet.kind': kind, 'directorySheet.query': '' })
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind, pageSize: optionPageSize(kind) })
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
    if (sheet && sheet.editorDirectory) {
      if (!currentIssueDirectory(this) || sheet.loading || sheet.error) return
      const item = sheet.items[Number(event.currentTarget.dataset.index)]
      if (item && !item.directoryDisabled && this.selectEditorDirectory(item, sheet.target)) this.closeDirectory()
      return
    }
    if (sheet && sheet.issueDirectory && (!currentIssueDirectory(this) || this.data.busy)) return
    if (sheet && !event.currentTarget.dataset.choice && (sheet.items[Number(event.currentTarget.dataset.index)] || {}).directoryDisabled) return
    if (sheet && sheet.issueDirectory && sheet.target === 'account') {
      const property = 'accountChoices'
      const change = 'changeIssueAccount'
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
      // 目录保持完整：截断会让后续卡片选不到其它账户，也匹配不到推荐。
      const accounts = this.data.accounts.some(row => row.accountId === item.accountId) ? this.data.accounts : this.data.accounts.concat(selected)
      this.setData({ [property]: choices, accounts })
      this[change]({ detail: { value: choices.findIndex(row => row.accountId === item.accountId) } })
      this.closeDirectory()
      return
    }
    if (sheet && sheet.issueDirectory && (sheet.loading || sheet.error)) return
    if (sheet && sheet.target === 'categoryEdit') {
      const item = sheet.items[Number(event.currentTarget.dataset.index)]
      if (item && this.selectEditedCategory(item)) this.closeDirectory()
      return
    }
    if (!sheet || !this.data.currentIssue) return
    const item = sheet.items[Number(event.currentTarget.dataset.index)]
    if (!item) return
    if (sheet.target === 'category') {
      const nature = (this.data.currentIssue.subject || this.data.issueEvents[0] || {}).economicNature
      const kind = nature === 'income' ? 'income' : ['expense', 'fee'].includes(nature) ? 'expense' : ''
      if (item.kind !== kind) { this.setData({ errorMessage: '请选择与当前收支性质一致的分类' }); return }
      const options = [this.data.issueCategories[0], item]
      const categories = this.data.categories.some(row => row.categoryId === item.categoryId) ? this.data.categories : this.data.categories.concat(item)
      this.setData({ issueCategories: options, categories, 'issueDraft.categoryIndex': 1, issueCategoryCanSave: true })
    }
    this.closeDirectory(); this.refreshIssueFieldsDraft()
  },

  closeDirectory: function () {
    if (this._optionPager) this._optionPager.cancel()
    this._optionPager = null; this._issueDirectoryToken = null; this._editorDirectoryToken = null
    this.setData({ directorySheet: null })
  },

  openAccountRecords: async function (event) {
    if (this._accountSelectionRefresh && !await finishAccountSelectionRead(this)) return
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
        const summary = await require('../../../../services/catledger-import').readSummary(token.updateId)
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
      this._accountPager = this._viewSession.pager('reviewIssues.members', {
        ...(mapping.groupId ? { accountConfirmationGroupId: mapping.groupId,
          ...(this.businessData().accountConfirmationOptions || displayGroups.readOptions(this._accountUiDrafts)),
          accountConfirmationVersion: this.businessData().accountConfirmationVersion } : { issueId }), memberKind: 'event', pageSize: 8 })
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
