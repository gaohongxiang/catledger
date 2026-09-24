const { publicError } = require('./presentation')
const { setChangedData } = require('../../services/view-patch')
const model = require('./model')
const presentation = require('./presentation')
const { errorText, direction } = require('./presentation')

const ACCOUNT_TYPE_OPTIONS = Object.freeze([
    { value: 'cash', label: '现金' },
    { value: 'bank', label: '银行卡' },
    { value: 'wallet', label: '平台钱包' },
    { value: 'credit', label: '信用卡 / 消费信贷' },
    { value: 'other_asset', label: '其他资产' },
    { value: 'other_liability', label: '其他负债' }
  ])

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

  completeAccountMapping: function (event) {
    if (this.data.busy || this.data.accountStepBusy || !this.data.update) return
    this.flushAccountDraftSync()
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

  loadDirectories: async function (events = [], extraIds = []) {
    const pairs = await Promise.all(['accounts', 'categories', 'accountDrafts'].map(async kind => {
          const response = await this._viewSession.read('financeUpdates.options', { kind, pageSize: 8 })
          const key = kind === 'categories' ? 'categoryId' : 'accountId'
          const pins = [...new Set((kind === 'categories' ? events.map(event => event.categoryId).filter(Boolean) : events.flatMap(event => model.eventAccountIds(event)
                  .concat((event.fundsProjection && event.fundsProjection.to && event.fundsProjection.to.candidates || []).map(row => row.accountId))))
              .concat(extraIds.filter(Boolean)))]
          .filter(id => !response.items.some(item => item[key] === id))
          const extra = pins.length ? (await this._viewSession.read('financeUpdates.options', { kind, ids: pins, pageSize: 100 })).items : []
          return [kind, response.items.concat(extra)]
        }))
    return Object.fromEntries(pairs)
  },

  bindAccountChoiceSearch: async function (event) {
    if (!this.data.accountChoiceSheet) return
    this.setData({ accountChoiceQuery: event.detail.value })
    this._directoryPager = this._viewSession.pager('financeUpdates.options', { kind: this.data.choiceKind, query: String(event.detail.value).slice(0, 80), pageSize: 12 })
    return this.changeChoicePage(event)
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
    this.setData({ choiceLoading: true })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._directoryPager || !this.data.accountChoiceSheet) return
      this._choiceRows = response.items
      this.setData({ accountChoiceResults: model.accountSelectorOptions(this.data.choiceKind === 'accounts' ? response.items : [], this.data.choiceKind === 'accountDrafts' ? response.items : []), choicePage: response.page, choiceLoading: false })
    } catch (error) { if (pager === this._directoryPager) this.setData({ choiceLoading: false, errorMessage: errorText(error) }) }
  },

  openDirectory: async function (event) {
    const target = event.currentTarget.dataset.target
    const kind = target === 'category' ? 'categories' : 'accounts'
    this.setData({ directorySheet: { target, kind, query: '', items: [], loading: true } })
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind, pageSize: 12 })
    return this.changeDirectoryPage(event)
  },

  searchDirectory: async function (event) {
    if (!this.data.directorySheet) return
    const query = String(event.detail.value).slice(0, 80)
    this.setData({ 'directorySheet.query': query })
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind: this.data.directorySheet.kind, query, pageSize: 12 })
    return this.changeDirectoryPage(event)
  },

  changeDirectoryKind: function (event) {
    const kind = event.currentTarget.dataset.kind
    if (!this.data.directorySheet || this.data.directorySheet.target === 'category' || !['accounts', 'accountDrafts'].includes(kind)) return
    this.setData({ 'directorySheet.kind': kind, 'directorySheet.query': '' })
    this._optionPager = this._viewSession.pager('financeUpdates.options', { kind, pageSize: 12 })
    return this.changeDirectoryPage(event)
  },

  changeDirectoryPage: async function (event) {
    const pager = this._optionPager
    this.setData({ 'directorySheet.loading': true })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._optionPager || !this.data.directorySheet) return
      this.setData({ 'directorySheet.items': response.items, 'directorySheet.page': response.page, 'directorySheet.loading': false })
    } catch (error) { if (pager === this._optionPager) this.setData({ 'directorySheet.loading': false, errorMessage: errorText(error) }) }
  },

  selectDirectory: function (event) {
    const sheet = this.data.directorySheet
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
    if (this._optionPager) this._optionPager.cancel(); this._optionPager = null; this.setData({ directorySheet: null })
  },

  openAccountRecords: async function (event) {
    const issueId = event.currentTarget.dataset.id
    const mapping = this.data.accountMappings.find(item => item.issueId === issueId)
    if (!mapping) return
    this._accountPager = this._viewSession.pager('reviewIssues.members', { issueId, memberKind: 'event', pageSize: 8 })
    this.setData({ accountRecordsSheet: { issueId, label: mapping.label, records: [], loading: true } })
    return this.changeAccountMembers(event)
  },

  changeAccountMembers: async function (event) {
    const pager = this._accountPager
    if (!pager || !this.data.accountRecordsSheet) return
    this.closeInlineEvidence('account')
    this.setData({ 'accountRecordsSheet.records': [], 'accountRecordsSheet.loading': true })
    try {
      const response = await pager.load(direction(event))
      if (pager !== this._accountPager || !this.data.accountRecordsSheet) return
      const list = model.accountRecordList(response.items)
      this._accountRecordList = list.records.map(presentation.record)
      this.setData({ accountRecordsSheet: Object.assign({}, this.data.accountRecordsSheet, { records: this._accountRecordList, dateRange: '当前页 ' + list.dateRange,
              count: response.total, loading: false, hasMore: false, page: response.page }) })
      await this.loadInlineEvidence('account', this._accountRecordList)
    } catch (error) { if (pager === this._accountPager) this.setData({ 'accountRecordsSheet.loading': false, 'accountRecordsSheet.error': errorText(error) }) }
  }
}
