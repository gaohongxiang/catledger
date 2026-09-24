const { publicError } = require('./presentation')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const { errorText, direction } = require('./presentation')
const api = require('../../services/catledger-import')
const inlineEvidence = require('./inline-evidence')

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

async function showIssueEditor(event) {
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
  } catch (error) {
    if (this._issueEvidenceToken !== token) return
    this.setData({ busy: false, errorMessage: publicError(error, '问题详情加载失败') })
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

  closeReviewSheet: function () {
    if (this.data.evidenceSheet) this.closeEvidence()
    else this.closeIssue()
  },

  openIssue: async function (event) {
    await showIssueEditor.call(this, event)
    if (!this.data.currentIssue || !this._viewActive) return
    const issueId = this.data.currentIssue.issueId
    this.setData({ historicalCandidates: [], historicalPage: null, historicalSelection: '', historicalLoading: false, historicalError: '' })
    this._memberPager = this._viewSession.pager('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 })
    this._relationPager = this._viewSession.pager('reviewIssues.members', { issueId, memberKind: 'relation', pageSize: 8 })
    const reads = [this.changeIssueMembers({ currentTarget: { dataset: {} } }), this.changeIssueRelations({ currentTarget: { dataset: {} } })]
    if (this.data.currentIssue && this.data.currentIssue.historicalDuplicate) {
      this._historicalPager = this._viewSession.pager('reviewIssues.members', { issueId, memberKind: 'transaction', pageSize: 8 })
      reads.push(this.changeHistoricalPage({ currentTarget: { dataset: {} } }))
    }
    await Promise.all(reads)
    if (!this._viewActive || !this.data.currentIssue || this.data.currentIssue.issueId !== issueId) return
    if (this.data.currentIssue && this.data.currentIssue.primaryReasonCode === 'loan_repayment_required') {
      const row = this.data.issueEvents[0]
      if (row) this.editLoanRepayment({ currentTarget:{ dataset:{ id:row.eventId } } })
    }
  },

  closeIssue: function () {
    if (this.data.busy) return
    this.closeInlineEvidence('issue')
    for (const key of ["_memberPager","_relationPager","_historicalPager"]) { if (this[key]) this[key].cancel(); this[key] = null }
    if (!this.data.busy) {
      this.finishInputEditing()
      this._issueEvidenceToken = null
      this._issueEvidenceRecords = []
      this.setData({ currentIssue: null, currentMembers: [], evidenceSheet: null, issueVisibleEvents: [] })
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
    if (this.data.currentIssue && this.data.currentIssue.historicalDuplicate &&
      (this.data.historicalLoading || this.data.historicalError || !this.data.historicalCandidates.length)) return
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

  readIssue: async function (issueId) {
    const session = this._viewSession
    const [details, relations] = await Promise.all([
        session.read('reviewIssues.get', { issueId, memberKind: 'event', pageSize: 8 }),
        session.read('reviewIssues.members', { issueId, memberKind: 'relation', pageSize: 8 })
      ])
    const entry = this._draftSession && this._draftSession.state.entries.find(item => item.issueId === issueId)
    const form = entry && entry.form || {}
    const directory = await this.loadDirectories(details.subject ? [details.subject] : [], [form.accountId, form.counterpartyAccountId, form.categoryId, form.paymentTargetId]
      .concat((form.paymentRows || []).map(row => row.accountId), (form.repaymentAllocationChoices || []).filter(row => !row.isNew).map(row => row.accountId)))
    // 主体单独返回，候选分页不会把被处理对象挤出首页。
    const members = details.subject ? [{ objectId: details.subject.eventId, objectType: 'event', event: editorPreview(details.subject) }] : details.members.slice(0, 1)
    const candidates = relations.items.map(member => member.relation ? Object.assign({}, member, { relation: Object.assign({}, member.relation,
            { targetEvent: editorPreview(member.relation.targetEvent) }) }) : member)
    return Object.assign({}, details, directory, { members: members.concat(candidates), relationPage: relations })
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
    if (!pager || !this.data.currentIssue) return
    const issueId = this.data.currentIssue.issueId
    this.setData({ historicalLoading: true, historicalSelection: '', historicalError: '' })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._historicalPager || !this.data.currentIssue || this.data.currentIssue.issueId !== issueId) return
      const candidates = response.items.map(member => {
          const row = member.transaction || { transactionId: member.objectId }
          return Object.assign({}, row, { stale: !member.transaction || Boolean(row.deletedAt) || row.version !== member.objectVersion,
              amountText: model.amountText(row.amountMinor), accountText: [row.sourceAccountName, row.destinationAccountName].filter(Boolean).join(' → ') })
        })
      this.setData({ historicalCandidates: candidates, historicalPage: response.page })
    } catch (error) { if (pager === this._historicalPager) this.setData({ historicalError: errorText(error) }) }
    finally { if (pager === this._historicalPager) this.setData({ historicalLoading: false }) }
  },

  selectHistoricalTransaction: function (event) {
    if (this.data.busy || this.data.historicalLoading) return
    const row = this.data.historicalCandidates.find(item => item.transactionId === event.currentTarget.dataset.id && !item.stale)
    if (row) this.setData({ historicalSelection: row.transactionId })
  },

  linkHistoricalTransaction: function () {
    if (!this.data.currentIssue || !this.data.currentIssue.historicalDuplicate || !this.data.historicalSelection || this.data.historicalLoading) return
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
    if (!pager || !this.data.currentIssue) return
    const issueId = this.data.currentIssue.issueId
    this.closeInlineEvidence('issue')
    this.setData({ issueVisibleEvents: [], issueEvidenceLoading: true })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._memberPager || !this.data.currentIssue || this.data.currentIssue.issueId !== issueId) return
      this._issueEvidenceRecords = response.items.filter(member => member.event).map(member => Object.assign({}, presentation.record(member.event), { evidence: [], evidenceLoading: true }))
      this.setData({ issueVisibleEvents: this._issueEvidenceRecords, issueEvidenceTotal: response.total, issueEvidenceLoading: false,
          issueEvidenceHasMore: false, memberPage: response.page })
      await this.loadInlineEvidence('issue', this._issueEvidenceRecords)
    } catch (error) { if (pager === this._memberPager) this.setData({ issueEvidenceLoading: false, errorMessage: errorText(error) }) }
  },

  changeIssueRelations: async function (event) {
    const pager = this._relationPager
    if (!pager || !this.data.currentIssue) return
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._relationPager || !this.data.currentIssue) return
      this.setData({ issueRelations: response.items.filter(member => member.relation).map(member => model.relationChoiceView(editorPreview(member.relation.targetEvent), member.relation)), relationPage: response.page })
    } catch (error) { if (pager === this._relationPager) this.setData({ errorMessage: errorText(error) }) }
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
        this.setData({ [path + '[' + index + ']']: records[index] })
      })
    this[key] = reader
    return reader.loadAll()
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
    this._evidencePager = this._viewSession.pager('economicEvents.evidence', { eventId, pageSize: 8 })
    const row = (this.businessData().events || []).find(e=>e.eventId === eventId)
    this._repaymentEditable = Boolean(row && ['repayment','internal_transfer'].includes(row.economicNature) && this.data.update.status === 'review')
    this.setData({ evidenceSheet: { eventId,repaymentEditable:this._repaymentEditable,evidence: [], loading: true, part: '' } })
    const pager = this._evidencePager
    await this.changeEvidencePage(event)
    const evidenceId = event.currentTarget.dataset.evidenceId
    if (evidenceId && pager === this._evidencePager && this.data.evidenceSheet) {
      await this.openEvidencePart({ currentTarget: { dataset: { id: evidenceId } } })
    }
    if (!row && this.data.update.status === 'review') {
      try {
        const detail = await api.readPage('economicEvents.list',{ updateId:this.data.update.updateId,eventId,pageSize:1 })
        if (pager !== this._evidencePager || !this.data.evidenceSheet) return
        this._repaymentEditable = Boolean(detail.items[0] && ['repayment','internal_transfer'].includes(detail.items[0].economicNature))
        this.setData({ 'evidenceSheet.repaymentEditable':this._repaymentEditable })
      } catch(error) { if (pager === this._evidencePager) this.setData({ errorMessage:errorText(error) }) }
    }
  },

  changeEvidencePage: async function (event) {
    const pager = this._evidencePager
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._evidencePager || !this.data.evidenceSheet) return
      this._detailPager = null
      this.setData({ evidenceSheet: { eventId: this.data.evidenceSheet.eventId,repaymentEditable:this._repaymentEditable,evidence: response.items, page: response.page, loading: false, part: '' } })
    } catch (error) { if (pager === this._evidencePager) this.setData({ 'evidenceSheet.loading': false, errorMessage: errorText(error) }) }
  },

  openEvidencePart: async function (event) {
    this._detailPager = this._viewSession.pager('economicEvents.detail', { eventId: this.data.evidenceSheet.eventId, evidenceId: event.currentTarget.dataset.id })
    return this.changeEvidencePart(event)
  },

  changeEvidencePart: async function (event) {
    const pager = this._detailPager
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._detailPager || !this.data.evidenceSheet) return
      this.setData({ 'evidenceSheet.part': response.part, 'evidenceSheet.partPage': response.page,
          'evidenceSheet.partFields': presentation.evidencePartFields(response.part, response.page) })
    } catch (error) { if (pager === this._detailPager) this.setData({ errorMessage: errorText(error) }) }
  }
}
