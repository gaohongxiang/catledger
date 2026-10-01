const { publicError } = require('./presentation')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const { errorText, direction } = require('./presentation')
const api = require('../../services/catledger-import')
const readCache = require('../../services/read-cache')
const inlineEvidence = require('./inline-evidence')
const observer = require('../../services/read-observer')

function evidenceCurrent(page, token) {
  return Boolean(token && page._viewActive && page._evidenceReadToken === token &&
    page._viewSession === token.session && token.session.active && token.session.summary.viewVersion === token.version &&
    readCache.getSession() === token.scope && page.data.evidenceSheet && page.data.evidenceSheet.eventId === token.eventId)
}

function bankChannelCandidate(issue) {
  return issue.issueType === 'same_event' && (issue.primaryReasonCode === 'bank_channel_same_event_candidate' ||
    (issue.reasonCodes || []).includes('bank_channel_same_event_candidate'))
}

function additionalRepaymentOptions(catalog, rows) {
  const selected = new Set(rows.map(function (row) { return row.accountId }))
  return [{ name: '补充还款账户', isPlaceholder: true }].concat(catalog.filter(function (account) {
        return !selected.has(account.accountId)
      })).concat([{ name: '新建负债账户', isCreate: true }])
}

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

function editorPreview(event) {
  if (!event || !event.primaryEvidence) return event
  let shortened = false
  const primaryEvidence = Object.fromEntries(Object.entries(event.primaryEvidence).map(([key, value]) => {
        if (typeof value === 'string' && value.length > 160) { shortened = true; return [key, value.slice(0, 160) + '…'] }
        return [key, value]
      }))
  return Object.assign({}, event, { primaryEvidence, detailRequired: event.detailRequired || shortened })
}

function issueCurrent(page, token) {
  return Boolean(token && page._viewActive && !page.data.issueStale && page._issueEvidenceToken === token &&
    page._viewSession === token.session && token.session.active && token.session.summary.viewVersion === token.version &&
    readCache.getSession() === token.scope && page.data.currentIssue && page.data.currentIssue.issueId === token.issueId)
}

function markIssue(page, token, phase, ok = true) {
  if (!issueCurrent(page, token)) return
  observer.record('interactive', { page: 'pages/import-workbench/index', phase, ok, elapsedMs: Date.now() - token.startedAt })
}

function directoryKinds(issue) {
  if (issue.issueType === 'category_assignment') return ['categories']
  if (['account_mapping', 'transfer_accounts'].includes(issue.issueType)) return ['accounts', 'accountDrafts']
  if (['shared_fields', 'field_conflict'].includes(issue.issueType)) return ['accounts', 'accountDrafts', 'categories']
  return []
}

function cancelIssueReads(page) {
  page.closeInlineEvidence('issue')
  for (const key of ['_memberPager', '_relationPager', '_historicalPager']) {
    if (page[key]) page[key].cancel()
    page[key] = null
  }
  page._issueEvidenceToken = null
}

function initializeIssueEditor(details, token) {
  const issueId = token.issueId
    const eventMembers = details.members.filter(function (member) { return member.event })
    const relationMembers = details.members.filter(function (member) { return member.relation })
    const firstEvent = eventMembers[0] && eventMembers[0].event
    const primaryEvent = bankChannelCandidate(details.issue) && eventMembers.map(member => member.event).find(row =>
      ['expense', 'refund'].includes(row.economicNature) && ['wechat', 'alipay'].includes(row.primaryEvidence && row.primaryEvidence.sourceType)) || firstEvent
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
    const paymentDefaults = model.paymentResolutionDefaults(firstEvent, selectableAccounts)
    this.setData({
        busy: false,
        update: details.update,
        currentIssue: currentIssue,
        issueSourceExpanded: true,
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
          primaryEventId: primaryEvent && primaryEvent.eventId || '',
          targetEventId: selectedRefundTargetId,
          newAccountName: summaryIssue && summaryIssue.accountContext && summaryIssue.accountContext.recognized
          ? Array.from(summaryIssue.accountContext.label.trim()).slice(0, 32).join('')
          : '',
          accountTypeIndex: currentIssue.repaymentOwnershipRequired ? 3 : 2,
          repaymentOwner: firstEvent && firstEvent.repaymentOwnership && firstEvent.repaymentOwnership.owner || '',
          repaymentOtherTreatment: firstEvent && firstEvent.repaymentOwnership && firstEvent.repaymentOwnership.treatment || ''
        }
      })
    this.restoreReviewDraft(issueId, token.savedForm)
    this.refreshIssueFieldsDraft()
    if (currentIssue.paymentNeedsReview) this.refreshPaymentDraft()
  token.initialized = true
  this.setData({ issueDetailsReady: true })
}

async function completeIssueEditor(page, token) {
  if (!issueCurrent(page, token) || !token.details || token.initialized || token.preparing) return
  token.preparing = true
  const details = token.details
  try {
    let directory = { accounts: [], categories: [], accountDrafts: [] }
    if (details.accounts && details.categories && details.accountDrafts) directory = details
    else {
      const saved = token.savedForm || ((page._draftSession && page._draftSession.state.entries.find(item => item.issueId === token.issueId)) || {}).form || {}
      const pins = [saved.accountId, saved.counterpartyAccountId, saved.categoryId, saved.paymentTargetId]
        .concat((saved.paymentRows || []).map(row => row.accountId), (saved.repaymentAllocationChoices || []).filter(row => !row.isNew).map(row => row.accountId))
      directory = Object.assign(directory, await page.loadDirectories(details.subject ? [details.subject] : details.members.filter(row => row.event).map(row => row.event), pins, directoryKinds(details.issue)))
    }
    if (!issueCurrent(page, token)) return
    initializeIssueEditor.call(page, Object.assign({}, details, directory, { members: details.members.concat(token.relationMembers || []) }), token)
    page.setData({ issueDetailsLoading: false, issueDetailsError: '' })
    page.updateIssueReadiness()
  } catch (error) {
    if (issueCurrent(page, token)) page.setData({ issueDetailsLoading: false, issueDetailsError: publicError(error, '可选账户或分类读取失败，请重试'), issueCanSubmit: false })
  } finally { token.preparing = false }
}

async function showIssueEditor(event, savedForm) {
  if (this.data.busy || !this._viewActive || !this._viewSession || !this._viewSession.active) return
  const issueId = event.currentTarget.dataset.id
  cancelIssueReads(this)
  if (this._pendingBackgroundView) {
    const pending = this._pendingBackgroundView
    this._pendingBackgroundView = null
    this.applyUpdateView(pending, false)
  }
  const summary = this.businessData().issues.find(issue => issue.issueId === issueId) || { issueId, issueType: '', label: '核对记录' }
  if (bankChannelCandidate(summary) && this.openAmbiguousPairingReview) {
    this.setData({ currentIssue: null })
    return this.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId } } })
  }
  const token = this._issueEvidenceToken = { issueId, session: this._viewSession, version: this._viewSession.summary.viewVersion,
    scope: readCache.getSession(), startedAt: Date.now(), savedForm }
  this.setData({ currentIssue: model.issueView(summary), currentMembers: [], issueEvents: [], issueVisibleEvents: [], issueRelations: [],
    issueDetailsLoading: true, issueDetailsReady: false, issueDetailsError: '', issueCanSubmit: false, issueStale: false,
    issueMembersError: '', issueRelationsError: '', issueRelationsLoading: false, issueSourceExpanded: true,
    issueEvidenceLoading: true, issueEvidenceTotal: Number(summary.memberCount || 0), memberPage: null, relationPage: null,
    historicalCandidates: [], historicalPage: null, historicalSelection: '', historicalLoading: false, historicalError: '',
    errorMessage: '' }, () => markIssue(this, token, 'review_feedback'))
  try {
    const details = await this.request('reviewIssues.get', { issueId })
    if (!issueCurrent(this, token)) return
    if (bankChannelCandidate(details.issue) && this.openAmbiguousPairingReview) {
      cancelIssueReads(this); this.setData({ currentIssue: null })
      return this.openAmbiguousPairingReview({ currentTarget: { dataset: { issueId } } })
    }
    token.details = details
    const currentIssue = model.issueView(Object.assign({}, details.issue, { subject: details.issue.subject || details.subject || summary.subject }))
    const members = details.members.filter(row => row.event)
    this.setData({ currentIssue, issueEvents: members.map(row => model.eventView(row.event)),
      issueVisibleEvents: members.map(row => Object.assign({}, presentation.record(row.event), { evidenceLoading: true, evidence: [] })) },
    () => markIssue(this, token, 'review_content'))
    this._memberPager = token.session.pager('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 })
    const reads = [this.changeIssueMembers({ currentTarget: { dataset: {} } }), completeIssueEditor(this, token)]
    if (currentIssue.issueType === 'refund_relation') {
      this._relationPager = token.session.pager('reviewIssues.members', { issueId, memberKind: 'relation', pageSize: 8 })
      reads.push(this.changeIssueRelations({ currentTarget: { dataset: {} } }))
    } else token.relationsReady = true
    if (currentIssue.historicalDuplicate) {
      this._historicalPager = token.session.pager('reviewIssues.members', { issueId, memberKind: 'transaction', pageSize: 8 })
      reads.push(this.changeHistoricalPage({ currentTarget: { dataset: {} } }))
    } else token.historyReady = true
    this.updateIssueReadiness()
    await Promise.all(reads)
    if (!issueCurrent(this, token)) return
    if (currentIssue.primaryReasonCode === 'loan_repayment_required' && this.data.issueCanSubmit) {
      const row = this.data.issueEvents[0]
      if (row) this.editLoanRepayment({ currentTarget: { dataset: { id: row.eventId } } })
    }
  } catch (error) {
    if (issueCurrent(this, token)) this.setData({ issueDetailsLoading: false, issueDetailsError: publicError(error, '问题详情加载失败，请重试'), issueCanSubmit: false })
  }
}

module.exports = {
  NATURE_OPTIONS,
  toggleIssueSource: function () {
    this.setData({ issueSourceExpanded: !this.data.issueSourceExpanded })
  },

  switchReviewTab: function (event) {
    const tab = event.currentTarget.dataset.tab
    if (!['review', 'category'].includes(tab)) return
    this.setData({ activeReviewTab: tab })
    return this.renderReview(true)
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

  switchReviewStatus: function (event) {
    const status = String(event.currentTarget.dataset.status || '')
    if (!['pending', 'completed', 'excluded', 'duplicate'].includes(status) || status === this.data.activeReviewStatus) return
    this.setData({ activeReviewStatus: status })
    return this.renderReview(true)
  },

  toggleExcludedGroup: function (event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (!key || !this._viewActive || this.data.activeReviewTab !== 'review' || this.data.activeReviewStatus !== 'excluded') return
    const expanded = this.data.excludedReviewGroups.filter(group => group.key === key ? !group.expanded : group.expanded).map(group => group.key)
    this.setData({ excludedReviewGroups: presentation.excludedGroups(this.businessData().events || [], expanded) })
  },

  closeReviewSheet: function () {
    if (this.data.evidenceSheet) this.closeEvidence()
    else this.closeIssue()
  },

  openIssue: function (event) {
    return showIssueEditor.call(this, event)
  },

  updateIssueReadiness: function () {
    const token = this._issueEvidenceToken
    if (!issueCurrent(this, token)) return
    const ready = Boolean(token.initialized && token.membersReady && token.relationsReady && token.historyReady && !this.data.issueStale &&
      !this.data.issueDetailsError && !this.data.issueMembersError && !this.data.issueRelationsError && !this.data.historicalError)
    if (ready !== this.data.issueCanSubmit) this.setData({ issueCanSubmit: ready }, () => { if (ready) markIssue(this, token, 'review_ready') })
  },

  retryIssueDetails: async function () {
    const token = this._issueEvidenceToken
    if (!this.data.currentIssue || this.data.busy) return
    if (!token || token.scope !== readCache.getSession() || token.session !== this._viewSession || !this._viewActive) return
    const issueId = this.data.currentIssue.issueId
    if (this.data.issueStale || !issueCurrent(this, token)) {
      const savedForm = this.data.issueDetailsReady ? this.reviewDraftEntry(this.data.currentIssue, '', {}).form : token && token.savedForm
      const session = this._viewSession, scope = readCache.getSession()
      const active = () => this._viewActive && this._issueEvidenceToken === token && this._viewSession === session &&
        readCache.getSession() === scope && this.data.currentIssue && this.data.currentIssue.issueId === issueId
      this.setData({ issueDetailsLoading: true, issueDetailsError: '' })
      try {
        const pending = this._pendingBackgroundView || await api.readSummary(this.data.update.updateId)
        if (!active()) return
        this._pendingBackgroundView = null
        this.applyUpdateView(pending, false)
      } catch (error) {
        if (active()) this.setData({ issueDetailsLoading: false, issueDetailsError: publicError(error, '版本核验失败，请重试') })
        return
      }
      return showIssueEditor.call(this, { currentTarget: { dataset: { id: issueId } } }, savedForm)
    }
    if (!token.details) return showIssueEditor.call(this, { currentTarget: { dataset: { id: issueId } } }, token.savedForm)
    this.setData({ issueDetailsLoading: true, issueDetailsError: '' })
    return completeIssueEditor(this, token)
  },

  closeIssue: function () {
    if (this.data.busy) return
    cancelIssueReads(this)
    if (!this.data.busy) {
      this.finishInputEditing()
      this._issueEvidenceToken = null
      this._issueEvidenceRecords = []
      this.setData({ currentIssue: null, currentMembers: [], evidenceSheet: null, issueVisibleEvents: [], issueCanSubmit: false, issueDetailsReady: false })
    }
    this.applyPendingBackgroundView()
  },

  closeEvidence: function () {
    for (const key of ["_evidencePager","_detailPager"]) { if (this[key]) this[key].cancel(); this[key] = null }
    this._evidenceReadToken = null
    this.setData({ busy: false, evidenceSheet: null })
    this.applyPendingBackgroundView()
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
      const valid = rows.length >= 2 && rows.every(function (row) { return Boolean(row.accountId) && !row.unavailable }) && new Set(rows.map(function (row) { return row.accountId })).size === rows.length
      this.setData({ paymentCanSave: valid, paymentValidationHint: valid ? '' : '请选择至少两个不同的付款账户' })
      return { valid: valid, accounts: rows.map(function (row) { return { componentIndex: row.componentIndex, accountId: row.accountId } }) }
    }
    const nature = ['', 'expense', 'repayment'][this.data.paymentNatureIndex]
    const target = (this.data.paymentTargetChoices || [])[this.data.paymentTargetIndex]
    const state = model.buildPaymentResolutionDraft(this.data.paymentRows, nature, target && target.accountId,
      this.data.paymentEvidenceNote, this.data.issueEvents[0] && this.data.issueEvents[0].amountMinor)
    if (nature === 'repayment' && target && target.unavailable) state.valid = false
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
          return Object.assign({}, row, { accountIndex: accountIndex, accountId: account && account.accountId || '', unavailable: Boolean(account && account.unavailable) })
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

  changePaymentNature: function (event) {
    this.setData({ paymentNatureIndex: Number(event.detail.value) }); this.refreshPaymentDraft()
  },

  changePaymentTarget: function (event) {
    this.setData({ paymentTargetIndex: Number(event.detail.value) }); this.refreshPaymentDraft()
  },

  changePaymentNote: function (event) {
    this.setData({ paymentEvidenceNote: event.detail.value }); this.refreshPaymentDraft()
  },

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
    if (!this._draftSession || !this.data.issueCanSubmit || !issueCurrent(this, this._issueEvidenceToken)) return
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
    if (this.data.currentIssue && this.data.currentIssue.historicalDuplicate &&
      (this.data.historicalLoading || this.data.historicalError || !this.data.historicalCandidates.length)) return
    this.resolveIssue('confirm_distinct', {})
  },

  confirmSame: function () {
    const issue = this.data.currentIssue
    if (!issue || this.data.busy) return
    if (bankChannelCandidate(issue)) {
      const invalid = message => this.setData({ errorMessage: message, issueFieldsReason: message, issueFieldsCanSave: false })
      const events = (this.data.currentMembers || []).filter(member => member.event).map(member => member.event)
      if (Number(issue.candidateCount) > 1 || events.length > 2) {
        invalid('存在多笔候选，请逐笔核对，不能整组确认为同一笔')
        return
      }
      const primary = events.find(row => row.eventId === this.data.issueDraft.primaryEventId)
      if (!primary || !['wechat', 'alipay'].includes(primary.primaryEvidence && primary.primaryEvidence.sourceType) ||
        !['expense', 'refund'].includes(primary.economicNature)) {
        invalid('请选择微信或支付宝中已明确为支出或退款的记录作为主记录')
        return
      }
      if (events.length !== 2 || events.filter(row => row.primaryEvidence && row.primaryEvidence.sourceType === 'bank').length !== 1) {
        invalid('请先核对完整的银行和微信或支付宝两笔记录')
        return
      }
      this.setData({ errorMessage: '' })
      this.refreshIssueFieldsDraft()
    }
    this.resolveIssue('confirm_same', { primaryEventId: this.data.issueDraft.primaryEventId })
  },

  linkRefund: function () {
    if (this.data.currentIssue && this.data.currentIssue.evidenceReviewOnly) return
    if (!this.data.issueDraft.targetEventId) {
      this.setData({ errorMessage: '请选择这笔退款对应的原消费' })
      return
    }
    this.resolveIssue('link_refund', { targetEventId: this.data.issueDraft.targetEventId })
  },

  markRefundPending: function () {
    if (this.data.currentIssue && this.data.currentIssue.evidenceReviewOnly) return
    this.resolveIssue('mark_refund_pending', {})
  },

  confirmInstallment: function () {
    this.resolveIssue('confirm_installment_principal', { installmentCandidateId: this.data.issueDraft.primaryEventId })
  },

  reviewDraftEntry: function (issue, decision, extra) {
    const data = this.data
    const form = { issueDraft: data.issueDraft, paymentRows: data.paymentRows, paymentNatureIndex: data.paymentNatureIndex,
      paymentEvidenceNote: data.paymentEvidenceNote, repaymentAllocationChoices: data.repaymentAllocationChoices,
      historicalSelection: data.historicalSelection,
      accountId: ((data.accountChoices || [])[data.issueDraft.accountIndex] || {}).accountId,
      counterpartyAccountId: ((data.counterpartyAccountChoices || [])[data.issueDraft.counterpartyAccountIndex] || {}).accountId,
      categoryId: ((data.issueCategories || [])[data.issueDraft.categoryIndex] || {}).categoryId,
      paymentTargetId: ((data.paymentTargetChoices || [])[data.paymentTargetIndex] || {}).accountId }
    return { kind: 'review', issueId: issue.issueId, issueVersion: issue.version, issueType: issue.issueType,
      subjectIds: issue.subjectEventIds || (this.data.issueEvents || []).map(function (event) { return event.eventId }),
      decision: Object.assign({ decision: decision }, extra || {}), form: form }
  },

  restoreReviewDraft: function (issueId, savedForm) {
    if (!this._draftSession && !savedForm) return
    const entry = savedForm ? { form: savedForm } : this._draftSession.state.entries.concat(this._draftSession.state.conflictedChoices || []).find(function (item) { return item.issueId === issueId })
    if (!entry || !entry.form) return
    const form = entry.form
    // 被归档/移除的旧选择保留原 ID 并明确失效，不能悄悄改成首项或新建账户。
    const pins = {}
    const keepChoice = (property, key, value) => {
      if (value && !this.data[property].some(row => row[key] === value)) pins[property] = this.data[property].concat({
        [key]: value, name: '原选择已不可用，请重选', unavailable: true, isPlaceholder: true })
    }
    keepChoice('accountChoices', 'accountId', form.accountId)
    keepChoice('counterpartyAccountChoices', 'accountId', form.counterpartyAccountId)
    keepChoice('issueCategories', 'categoryId', form.categoryId)
    keepChoice('paymentTargetChoices', 'accountId', form.paymentTargetId)
    const paymentAccounts = this.data.paymentAccountChoices || []
    const paymentRows = (form.paymentRows || []).map(row => Object.assign({}, row, {
      accountIndex: Math.max(0, paymentAccounts.findIndex(account => account.accountId === row.accountId)),
      unavailable: Boolean(row.accountId) && !paymentAccounts.some(account => account.accountId === row.accountId && !account.unavailable)
    }))
    if (Object.keys(pins).length) this.setData(pins)
    const indexOf = function (options, key, value) { return Math.max(0, (options || []).findIndex(function (item) { return value && item[key] === value })) }
    this.setData({ issueDraft: Object.assign({}, form.issueDraft, {
            accountIndex: indexOf(this.data.accountChoices, 'accountId', form.accountId),
            counterpartyAccountIndex: indexOf(this.data.counterpartyAccountChoices, 'accountId', form.counterpartyAccountId),
            categoryIndex: indexOf(this.data.issueCategories, 'categoryId', form.categoryId) }),
        paymentRows, paymentNatureIndex: form.paymentNatureIndex || 0,
        historicalSelection: form.historicalSelection || '',
        historicalSelectionVerified: Boolean(form.historicalSelection && this.data.historicalCandidates.some(row => row.transactionId === form.historicalSelection && !row.stale)),
        paymentTargetIndex: indexOf(this.data.paymentTargetChoices, 'accountId', form.paymentTargetId),
        paymentEvidenceNote: form.paymentEvidenceNote || '', repaymentAllocationChoices: (form.repaymentAllocationChoices || []).map(row => Object.assign({}, row,
          !row.isNew ? { unavailable: !this.data.accounts.some(account => account.accountId === row.accountId && !account.unavailable) } : {})) })
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
    if (!issue || this.data.busy || !this.data.issueCanSubmit || !issueCurrent(this, this._issueEvidenceToken)) return
    try {
      this._draftSession.enqueue([this.reviewDraftEntry(issue, decision, extra)])
      this.closeIssue()
    } catch (error) { this.setData({ errorMessage: publicError(error, '选择未保存，请重试') }) }
  },

  readIssue: async function (issueId) {
    const session = this._viewSession
    const details = await session.read('reviewIssues.get', { issueId, memberKind: 'event', pageSize: 8 })
    // get 已含首成员页，沿用相同版本及游标缓存，不再发一遍 members。
    session.seed('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 },
      { protocolVersion: details.protocolVersion, viewVersion: details.viewVersion, items: details.members,
        total: details.total, nextCursor: details.nextCursor })
    let members = details.subject ? [{ objectId: details.subject.eventId, objectType: 'event', event: editorPreview(details.subject) }] : details.members.slice(0, 1)
    if (bankChannelCandidate(details.issue)) {
      const seen = new Set()
      members = members.concat(details.members).filter(member => {
        if (!member.event || seen.has(member.event.eventId)) return false
        seen.add(member.event.eventId); return true
      }).slice(0, 8).map(member => Object.assign({}, member, { event: editorPreview(member.event) }))
    }
    return Object.assign({}, details, { members })
  },

  excludeIssueEvents: function () {
    return this.resolveIssue('exclude_events', { selection: { mode: 'all' } })
  },

  selectPrimaryMember: function (event) {
    this.setData({ 'issueDraft.primaryEventId': event.currentTarget.dataset.id })
  },

  expandBankBatch: function () {
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

  changeHistoricalPage: async function (event) {
    const pager = this._historicalPager
    const token = this._issueEvidenceToken
    if (!pager || !issueCurrent(this, token)) return
    const issueId = this.data.currentIssue.issueId
    const previousSelection = this.data.historicalSelection
    const moving = Boolean(direction(event))
    token.historyReady = false
    this.setData({ historicalLoading: true, historicalSelection: moving ? '' : previousSelection, historicalSelectionVerified: false, historicalError: '', issueCanSubmit: false })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._historicalPager || !issueCurrent(this, token)) return
      const candidates = response.items.map(member => {
          const row = member.transaction || { transactionId: member.objectId }
          return Object.assign({}, row, { stale: !member.transaction || Boolean(row.deletedAt) || row.version !== member.objectVersion,
              amountText: model.amountText(row.amountMinor), accountText: [row.sourceAccountName, row.destinationAccountName].filter(Boolean).join(' → ') })
        })
      token.historyReady = true
      const selected = moving ? '' : this.data.historicalSelection || previousSelection
      this.setData({ historicalCandidates: candidates, historicalPage: response.page, historicalSelection: selected,
        historicalSelectionVerified: Boolean(selected && candidates.some(row => row.transactionId === selected && !row.stale)) })
    } catch (error) { if (pager === this._historicalPager && issueCurrent(this, token)) this.setData({ historicalError: errorText(error) }) }
    finally { if (pager === this._historicalPager && issueCurrent(this, token)) { this.setData({ historicalLoading: false }); this.updateIssueReadiness() } }
  },

  selectHistoricalTransaction: function (event) {
    if (this.data.busy || this.data.historicalLoading) return
    const row = this.data.historicalCandidates.find(item => item.transactionId === event.currentTarget.dataset.id && !item.stale)
    if (row) this.setData({ historicalSelection: row.transactionId, historicalSelectionVerified: true })
  },

  linkHistoricalTransaction: function () {
    if (!this.data.currentIssue || !this.data.currentIssue.historicalDuplicate || !this.data.historicalSelection || this.data.historicalLoading || this.data.historicalError ||
      !this.data.historicalCandidates.some(row => row.transactionId === this.data.historicalSelection && !row.stale)) return
    return this.resolveIssue('link_existing_transaction', { transactionId: this.data.historicalSelection })
  },

  refreshHistoricalReview: async function () {
    if (this.data.busy || !this.data.update) return
    const updateId = this.data.update.updateId
    this.closeIssue()
    await this.loadUpdate(updateId, false)
  },

  changeIssueMembers: async function (event) {
    const pager = this._memberPager
    const token = this._issueEvidenceToken
    if (!pager || !issueCurrent(this, token)) return
    this.closeInlineEvidence('issue')
    token.membersReady = false
    this.setData({ issueEvidenceLoading: true, issueMembersError: '', issueCanSubmit: false })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._memberPager || !issueCurrent(this, token)) return
      this._issueEvidenceRecords = response.items.filter(member => member.event).map(member => Object.assign({}, presentation.record(member.event), { evidence: [], evidenceLoading: true }))
      token.membersReady = true
      this.setData({ issueVisibleEvents: this._issueEvidenceRecords, issueEvidenceTotal: response.total, issueEvidenceLoading: false,
          issueEvidenceHasMore: false, memberPage: response.page })
      this.updateIssueReadiness()
      const complete = await this.loadInlineEvidence('issue', this._issueEvidenceRecords)
      if (complete && pager === this._memberPager && issueCurrent(this, token)) markIssue(this, token, 'review_evidence', !this._issueEvidenceRecords.some(row => row.evidenceError))
    } catch (error) { if (pager === this._memberPager && issueCurrent(this, token)) this.setData({ issueEvidenceLoading: false, issueMembersError: errorText(error), issueCanSubmit: false }) }
  },

  changeIssueRelations: async function (event) {
    const pager = this._relationPager
    const token = this._issueEvidenceToken
    if (!pager || !issueCurrent(this, token)) return
    token.relationsReady = false
    this.setData({ issueRelationsLoading: true, issueRelationsError: '', issueCanSubmit: false })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._relationPager || !issueCurrent(this, token)) return
      token.relationsReady = true
      token.relationMembers = response.items.filter(member => member.relation)
      const choices = token.relationMembers.map(member => model.relationChoiceView(editorPreview(member.relation.targetEvent), member.relation))
      const patch = { issueRelations: choices, relationPage: response.page, issueRelationsLoading: false }
      if (token.initialized && !this.data.issueDraft.targetEventId && choices.length === 1 && response.total === 1) patch['issueDraft.targetEventId'] = choices[0].targetEventId
      this.setData(patch); this.updateIssueReadiness()
    } catch (error) { if (pager === this._relationPager && issueCurrent(this, token)) this.setData({ issueRelationsLoading: false, issueRelationsError: errorText(error), issueCanSubmit: false }) }
  },

  closeInlineEvidence: function (scope) {
    const key = scope === 'issue' ? '_issueInlineEvidence' : '_accountInlineEvidence'
    if (this[key]) this[key].close()
    this[key] = null
  },

  loadInlineEvidence: function (scope, records) {
    this.closeInlineEvidence(scope)
    const key = scope === 'issue' ? '_issueInlineEvidence' : '_accountInlineEvidence'
    const path = scope === 'issue' ? 'issueVisibleEvents' : 'accountRecordsSheet.records'
    const session = this._viewSession
    const active = () => this._viewActive && this._viewSession === session && this[key] === reader &&
    Boolean(scope === 'issue' ? this.data.currentIssue : this.data.accountRecordsSheet)
    const reader = inlineEvidence.create(session, records, active, (index, patch) => {
        Object.assign(records[index], patch)
        return new Promise(resolve => this.setData({ [path + '[' + index + ']']: records[index] }, resolve))
      })
    this[key] = reader
    return reader.loadAll().then(() => active())
  },

  changeInlineSource: function (event) {
    const scope = event.currentTarget.dataset.scope
    const reader = scope === 'account' ? this._accountInlineEvidence : this._issueInlineEvidence
    if (reader) return reader.change(event.currentTarget.dataset.id, direction(event))
  },

  retryIssueRecordEvidence: function (event) {
    if (this._issueInlineEvidence) return this._issueInlineEvidence.change(event.currentTarget.dataset.id, 0)
  },

  retryAccountRecordEvidence: function (event) {
    if (this._accountInlineEvidence) return this._accountInlineEvidence.change(event.currentTarget.dataset.id, 0)
  },

  editLoanRepayment: function (event) {
    const eventId = event.currentTarget.dataset.id || this.data.evidenceSheet && this.data.evidenceSheet.eventId
    if (eventId && this.data.update && this.data.update.status === 'review') wx.navigateTo({ url:'/pages/repayment-entry/index?updateId=' + encodeURIComponent(this.data.update.updateId) + '&eventId=' + encodeURIComponent(eventId) })
  },

  openEvidence: async function (event) {
    const eventId = event.currentTarget.dataset.id
    if (!eventId || !this._viewActive || !this._viewSession || !this._viewSession.active) return
    const evidenceId = event.currentTarget.dataset.evidenceId
    let sourcePager
    if (evidenceId) {
      for (const reader of [this._issueInlineEvidence, this._accountInlineEvidence, this._pairingInlineEvidence]) {
        if (reader) sourcePager = sourcePager || reader.sourcePager(eventId, evidenceId)
      }
      if (!sourcePager) return
    }
    for (const key of ['_evidencePager', '_detailPager']) { if (this[key]) this[key].cancel(); this[key] = null }
    const session = this._viewSession
    const token = this._evidenceReadToken = { session, eventId, version: session.summary.viewVersion, scope: readCache.getSession() }
    this._evidencePager = sourcePager || session.pager('economicEvents.evidence', { eventId, pageSize: 1 })
    const row = (this.businessData().events || []).find(e=>e.eventId === eventId)
    this._repaymentEditable = Boolean(row && ['repayment','internal_transfer'].includes(row.economicNature) && this.data.update.status === 'review')
    this.setData({ evidenceSheet: { eventId, repaymentEditable: this._repaymentEditable, evidence: [], loading: true,
      error: '', part: '', partFields: [], partLoading: false, partError: '' } })
    await this.changeEvidencePage({ currentTarget: { dataset: {} } })
    if (evidenceCurrent(this, token) && !row && this.data.update.status === 'review') {
      try {
        const detail = await session.read('economicEvents.list', { eventId, pageSize: 1 }, () => evidenceCurrent(this, token))
        if (!evidenceCurrent(this, token)) return
        this._repaymentEditable = Boolean(detail.items[0] && ['repayment','internal_transfer'].includes(detail.items[0].economicNature))
        this.setData({ 'evidenceSheet.repaymentEditable':this._repaymentEditable })
      } catch(error) { if (evidenceCurrent(this, token)) this.setData({ errorMessage:errorText(error) }) }
    }
  },

  changeEvidencePage: async function (event) {
    const pager = this._evidencePager, token = this._evidenceReadToken
    if (!pager || !evidenceCurrent(this, token)) return
    const request = this._evidencePageToken = {}
    const current = () => evidenceCurrent(this, token) && this._evidencePageToken === request && this._evidencePager === pager
    if (this._detailPager) this._detailPager.cancel()
    this._detailPager = null
    this.setData({ 'evidenceSheet.loading': true, 'evidenceSheet.error': '', 'evidenceSheet.evidence': [],
      'evidenceSheet.part': '', 'evidenceSheet.partFields': [], 'evidenceSheet.partPage': null,
      'evidenceSheet.partLoading': false, 'evidenceSheet.partError': '' })
    try {
      const response = await pager.load(direction(event))
      if (!current()) return
      this.setData({ 'evidenceSheet.evidence': response.items, 'evidenceSheet.page': response.page, 'evidenceSheet.loading': false })
      if (response.items[0]) await this.openEvidencePart({ currentTarget: { dataset: { id: response.items[0].evidenceId } } })
    } catch (error) { if (current()) this.setData({ 'evidenceSheet.loading': false, 'evidenceSheet.error': errorText(error) }) }
  },

  openEvidencePart: async function (event) {
    const token = this._evidenceReadToken, evidenceId = event.currentTarget.dataset.id
    if (!evidenceCurrent(this, token) || !this.data.evidenceSheet.evidence.some(source => source.evidenceId === evidenceId)) return
    if (this._detailPager) this._detailPager.cancel()
    this._detailPager = token.session.pager('economicEvents.detail', { eventId: token.eventId, evidenceId })
    return this.changeEvidencePart({ currentTarget: { dataset: {} } })
  },

  changeEvidencePart: async function (event) {
    const pager = this._detailPager, token = this._evidenceReadToken
    if (!pager || !evidenceCurrent(this, token)) return
    const request = this._evidencePartToken = {}
    const current = () => evidenceCurrent(this, token) && this._evidencePartToken === request && this._detailPager === pager
    this.setData({ 'evidenceSheet.partLoading': true, 'evidenceSheet.partError': '', 'evidenceSheet.part': '', 'evidenceSheet.partFields': [] })
    try {
      const response = await pager.load(direction(event))
      if (!current()) return
      this.setData({ 'evidenceSheet.part': response.part, 'evidenceSheet.partPage': response.page,
          'evidenceSheet.partFields': presentation.evidencePartFields(response.part, response.page), 'evidenceSheet.partLoading': false })
    } catch (error) { if (current()) this.setData({ 'evidenceSheet.partLoading': false, 'evidenceSheet.partError': errorText(error) }) }
  }
}
