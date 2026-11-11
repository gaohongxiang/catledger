const api = require('../../services/catledger-api')
const pendingWrites = require('../../services/pending-ledger-write')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const money = require('../../utils/money')
const time = require('../../utils/time')
const themeService = require('../../theme/service')
const { decorateAccount } = require('../accounts/model')
const { present: presentLoan } = require('../../services/loan-present')
const billing = require('../../utils/account-billing')
const installmentSource = require('../../services/installment-source-model')

Page(themeService.page({
  data: {
    accountId: '',
    account: null,
    loading: false,
    saving: false,
    errorMessage: '',
    accountStatusMessage: '',
    accountStatusRefresh: false,
    pendingAccountAction: '',
    removeBlockedByRecords: false,
    removeRecords: [], removeRecordsLoading: false, removeRecordsError: '', removingRecords: false,
    accountLoans: [], accountLoansActive: [], accountLoansDone: [], accountLoansLoading: false, accountLoansLoaded: false, accountLoansError: '', accountLoansMore: false, accountPendingCount: 0, accountLoansTotalInterestText: null, accountLoansTotalFeeText: null, accountLoansTotalCount: 0, accountLoanSort: 'time', debtHintOpen: false,
    accountSources: [], accountSourcesLoading: false, accountSourcesLoaded: false, accountSourcesError: '', accountSourcesMore: false,
    sourceChoosing: null,
    editingName: false,
    nameDraft: '',
    nameError: '',
    formOpen: false,
    balanceYuan: '0.00',
    billingSupported: false,
    editingBilling: '',
    editingBillingLabel: '',
    billingFieldDraft: '',
    billingFieldError: ''
  },

  onLoad: function (query) {
    this.setData({ accountId: String(query && query.accountId || '') })
  },

  onShow: function () {
    loginGuard.run(this, this.loadAccount.bind(this))
  },

  onUnload: function () { pageReadSession.end(this) },
  onHide: function () { pageReadSession.end(this); this._archiveConfirming = false; this.setData({ saving: false }) },

  loadAccount: function (options) {
    const isCurrent = pageReadSession.begin(this, ['account', 'loading', 'saving', 'errorMessage', 'accountStatusMessage', 'accountStatusRefresh', 'pendingAccountAction', 'accountLoans', 'accountLoansActive', 'accountLoansDone', 'accountLoansLoading', 'accountLoansLoaded', 'accountLoansError', 'accountLoansMore', 'accountPendingCount', 'accountLoansTotalInterestText', 'accountLoansTotalFeeText', 'accountLoansTotalCount', 'accountLoanSort', 'debtHintOpen', 'accountSources', 'accountSourcesLoading', 'accountSourcesLoaded', 'accountSourcesError', 'accountSourcesMore', 'editingName', 'nameDraft', 'nameError', 'formOpen', 'balanceYuan', 'billingSupported', 'editingBilling', 'billingFieldDraft', 'billingFieldError'], ['_readLoad', '_accountLoansToken'])
    if (this._readLoad) return this._readLoad
    const self = this
    const force = Boolean(options && options.force)
    let completedStatus = options && options.completedStatus || ''
    this.setData({ loading: force || !api.isFresh('accounts.list'), errorMessage: '' })
    this._readLoad = this.recoverAccountStatus(isCurrent).then(function (recoveredStatus) {
      completedStatus = completedStatus || recoveredStatus
      if (isCurrent()) return api.callApi('accounts.list', {}, { force: force || Boolean(completedStatus) })
    }).then(async function (result) {
        if (!isCurrent()) return
        const decorated = (result.accounts || []).map(decorateAccount).find(function (item) { return item.accountId === self.data.accountId }) || null
        // 详情页把负债欠款称作「总欠款」（口径=最近账单本期应还+各分期未到期剩余本息）。
        const account = decorated && decorated.nature === 'liability' ? Object.assign({}, decorated, { balanceLabel: '总欠款' }) : decorated
        if (self.data.accountStatusRefresh) self.setData({ accountStatusRefresh: false, accountStatusMessage: '' })
        self.setData(Object.assign({ account: account, removeBlockedByRecords: false, billingSupported: result.liabilitySettingsVersion === 1, errorMessage: account ? '' : '账户不存在或已删除' }, account ? {} :
          { accountLoans: [], accountLoansActive: [], accountLoansDone: [], accountLoansLoaded: false, accountLoansMore: false, accountPendingCount: 0, accountLoansTotalInterestText: null, accountLoansTotalFeeText: null, accountLoansTotalCount: 0, accountLoanSort: 'time', debtHintOpen: false }))
        if (account) await Promise.all([self.loadAccountLoans(), self.loadAccountSources()])
        return true
      })
      .catch(function (error) {
        if (!isCurrent()) return
        self.setData(completedStatus ? { errorMessage: '', accountStatusMessage: completedStatus + '，详情待刷新', accountStatusRefresh: true } : { errorMessage: error.message || '账户加载失败' })
        return false
      })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false })
        self._readLoad = null
      })
      .then(function (ok) {
        // 首轮加载完成后（_readLoad 已清空，可安全重入）再尝试自动补偿漏归的分期来源。
        if (ok && isCurrent()) self.reconcileOrphanSources(isCurrent)
        return ok
      })
    return this._readLoad
  },

  pendingAccountStatus: function () {
    const packet = pendingWrites.pending()
    return packet && packet.target === 'api' && ['accounts.archive', 'accounts.restore', 'accounts.remove'].includes(packet.action) &&
      packet.payload.accountId === this.data.accountId ? packet : null
  },

  recoverAccountStatus: async function (isCurrent) {
    if (!isCurrent()) return ''
    const packet = this.pendingAccountStatus()
    this.setData({ pendingAccountAction: packet ? packet.action : '' })
    if (!packet) return ''
    try {
      await pendingWrites.verify()
      if (!isCurrent()) return ''
      const status = packet.action === 'accounts.restore' ? '已恢复' : packet.action === 'accounts.remove' ? '已删除' : '已停用'
      this.setData({ pendingAccountAction: '', accountStatusMessage: status })
      return status
    } catch (error) {
      if (isCurrent()) this.setData({ accountStatusMessage: '上次账户操作结果待核实，请继续原操作', errorMessage: error.code === 'OPERATION_UNCONFIRMED' ? '' : error.message })
      return ''
    }
  },

  changeAccountStatus: async function (action, payload) {
    const account = this.data.account, isCurrent = pageReadSession.capture(this)
    if (!account || this.data.saving || !isCurrent()) return
    this.setData({ saving: true, errorMessage: '', accountStatusMessage: '', removeBlockedByRecords: false, removeRecords: [], removeRecordsError: '' })
    try {
      await pendingWrites.send('api', action, payload || { accountId: account.accountId, version: account.version }, { exact: true, canSend: isCurrent })
      if (!isCurrent()) return
      // 彻底删除后账户已不存在，直接退回列表并提示，不再尝试读取详情。
      if (action === 'accounts.remove') {
        this.setData({ pendingAccountAction: '', saving: false })
        // 标记账户列表需强制刷新，返回后 onShow 立即按最新数据重读，不显示已删账户。
        try { getApp().globalData.accountsDirty = true } catch (_) {}
        wx.showToast({ title: '已删除', icon: 'success' })
        wx.navigateBack()
        return
      }
      const status = action === 'accounts.restore' ? '已恢复' : '已停用'
      this.setData({ pendingAccountAction: '', accountStatusMessage: status, editingName: false, editingBilling: '', formOpen: false })
      if (this._readLoad) await this._readLoad
      if (!isCurrent()) return
      await this.loadAccount({ force: true, completedStatus: status })
      if (isCurrent()) wx.showToast({ title: status, icon: 'success' })
    } catch (error) {
      if (!isCurrent()) return
      const pending = this.pendingAccountStatus()
      // 有流水/关联记录不能直删：给出「查看并删除流水」的引导，而不是干巴巴报错。
      const hasRecords = action === 'accounts.remove' && error && error.code === 'ACCOUNT_HAS_RECORDS'
      this.setData({ pendingAccountAction: pending ? pending.action : '',
        errorMessage: hasRecords ? '' : (error.message || '账户操作失败'),
        accountStatusMessage: pending ? '上次账户操作结果待核实，请继续原操作' : '',
        removeBlockedByRecords: hasRecords })
      if (hasRecords) this.loadRemoveRecords()
    } finally { if (isCurrent()) this.setData({ saving: false }) }
  },

  // 删除账户被流水挡住时，直接在本页内联展示该账户流水，可勾选批量删除，不跳走。
  openAccountTransactions: function () {
    return this.loadRemoveRecords()
  },

  loadRemoveRecords: async function () {
    const account = this.data.account
    if (!account || this.data.removeRecordsLoading) return
    const isCurrent = pageReadSession.capture(this)
    const time = require('../../utils/time')
    this.setData({ removeRecordsLoading: true, removeRecordsError: '' })
    try {
      // transactions.list 必须按月查；从 2020-01 到当前月逐月扫描，小批并发合并该账户全部流水。
      const current = time.currentMonth()
      const months = []
      let m = '2020-01', guard = 0
      while (m && m <= current && guard < 120) { months.push(m); m = time.shiftMonth(m, 1); guard += 1 }
      const items = []
      const fetchMonth = async (month) => {
        let cursor = null
        for (let page = 0; page < 20; page++) {
          const result = await api.callApi('transactions.list', { month, accountId: account.accountId, pageSize: 50, cursor }, { force: true })
          if (!isCurrent()) return
          for (const tx of (result.transactions || [])) items.push(this._removeRow(tx))
          cursor = result.nextCursor
          if (!cursor) break
        }
      }
      for (let i = 0; i < months.length; i += 6) {
        await Promise.all(months.slice(i, i + 6).map(fetchMonth))
        if (!isCurrent()) return
      }
      items.sort((a, b) => (a.dateText < b.dateText ? 1 : a.dateText > b.dateText ? -1 : 0))
      if (isCurrent()) this.setData({ removeRecords: items })
    } catch (error) {
      if (isCurrent()) this.setData({ removeRecordsError: error.message || '流水暂未读取，请重试' })
    } finally { if (isCurrent()) this.setData({ removeRecordsLoading: false }) }
  },

  _removeRow: function (tx) {
    const money = require('../../utils/money')
    const labels = { expense: '支出', income: '收入', transfer: '转账', refund: '退款', balance_adjustment: '余额调整' }
    // 余额调整（期初/校正）与关联退款/贷款的记录通常不能直接删；先展示，删除时按后端规则反馈。
    const selectable = ['manual', 'import'].indexOf(tx.origin) >= 0 && ['income', 'expense', 'transfer', 'refund'].indexOf(tx.type) >= 0
    return {
      transactionId: tx.transactionId, version: tx.version,
      typeLabel: labels[tx.type] || tx.type,
      dateText: String(tx.occurredLocalAt || '').slice(0, 10),
      amountText: money.formatMinor(tx.amountMinor),
      noteText: tx.note || '',
      selectable: selectable, selected: selectable
    }
  },

  toggleRemoveRecord: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const row = this.data.removeRecords[index]
    if (!row || !row.selectable || this.data.removingRecords) return
    this.setData({ ['removeRecords[' + index + '].selected']: !row.selected })
  },

  selectAllRemoveRecords: function (event) {
    const on = event && event.detail ? Boolean(event.detail.value) : true
    const patch = {}
    this.data.removeRecords.forEach((row, index) => { if (row.selectable) patch['removeRecords[' + index + '].selected'] = on })
    this.setData(patch)
  },

  // 删除所选流水，成功后自动重试彻底删除账户。
  deleteRemoveRecords: async function () {
    if (this.data.removingRecords || this.data.saving) return
    const account = this.data.account
    const isCurrent = pageReadSession.capture(this)
    const items = this.data.removeRecords.filter(row => row.selectable && row.selected)
      .map(row => ({ transactionId: row.transactionId, version: row.version }))
      .sort((a, b) => a.transactionId.localeCompare(b.transactionId))
    // 若没有可勾删的真实流水（只剩余额调整，后端会随账户一并清理），直接重试删除账户。
    const tryRemoveAccount = async () => {
      this.setData({ removeBlockedByRecords: false })
      await this.changeAccountStatus('accounts.remove', { accountId: account.accountId, version: account.version })
    }
    if (!items.length) return tryRemoveAccount()
    this.setData({ removingRecords: true, removeRecordsError: '' })
    try {
      const choice = await new Promise((resolve, reject) => wx.showModal({
        title: '删除 ' + items.length + ' 笔流水？', content: '删除后余额与统计会更新，且不可恢复。删除完若账户已无记录，将自动继续彻底删除账户。',
        confirmText: '删除', confirmColor: themeService.currentTokens().danger, success: resolve, fail: reject }))
      if (!choice.confirm || !isCurrent()) return
      await pendingWrites.send('api', 'transactions.deleteMany', { items }, { exact: true })
      if (!isCurrent()) return
      wx.showToast({ title: '已删除 ' + items.length + ' 笔', icon: 'success' })
      // 重新读取剩余流水；若已无可勾删的真实流水，自动重试删除账户（余额调整由后端随账户清理）。
      await this.loadRemoveRecords()
      if (!isCurrent()) return
      if (!this.data.removeRecords.some(row => row.selectable)) await tryRemoveAccount()
    } catch (error) {
      if (isCurrent()) this.setData({ removeRecordsError: (error && error.message) || '删除流水失败，请重试' })
    } finally { if (isCurrent()) this.setData({ removingRecords: false }) }
  },

  retryAccountStatus: function () {
    const packet = this.pendingAccountStatus()
    if (packet) return this.changeAccountStatus(packet.action, packet.payload)
    return this.loadAccount({ force: true })
  },

  restore: function () {
    if (!this.data.account || !this.data.account.archived) return
    if (this.data.accountStatusRefresh) return this.loadAccount({ force: true })
    if (this.pendingAccountStatus()) return this.retryAccountStatus()
    return this.changeAccountStatus('accounts.restore')
  },

  recoverMutation: async function (error, fallback, isCurrent) {
    if (!isCurrent()) return
    if (this._readLoad) await this._readLoad
    if (!isCurrent()) return
    await this.loadAccount({ force: true })
    if (!isCurrent()) return
    this.setData({ errorMessage: error.message || fallback })
  },

  // 排序贷款：time=按首次还款日/开始日倒序；amount=按剩余本金/原始本金倒序。
  _loanTime(loan) {
    const d = loan.firstPaymentDate || loan.startDate || loan.baselineDate || (loan.createdAt ? String(loan.createdAt).slice(0, 10) : '')
    return d ? String(d) : ''
  },
  _loanAmountMinor(loan) {
    // 按金额排序 = 按「借款金额（原本金）」倒序；已完成分期剩余本金为 0，用原本金才不会全部并列。
    // 兜底顺序：原本金 > 基准本金 > 剩余本金。
    const v = (loan.installmentSetup && loan.installmentSetup.originalPrincipalMinor != null) ? loan.installmentSetup.originalPrincipalMinor
      : (loan.baselinePrincipalMinor != null ? loan.baselinePrincipalMinor
        : (loan.installmentSummary && loan.installmentSummary.unpaidPrincipalMinor != null ? loan.installmentSummary.unpaidPrincipalMinor : loan.remainingPrincipalMinor))
    try { return v == null ? -1n : BigInt(v) } catch (e) { return -1n }
  },
  _splitLoans(loans, mode) {
    const done = loan => loan.statusText === '已完成' || loan.statusText === '已结清' || loan.status === 'settled'
    const cmp = mode === 'amount'
      ? (a, b) => { const x = this._loanAmountMinor(a), y = this._loanAmountMinor(b); return x === y ? 0 : (x > y ? -1 : 1) }
      : (a, b) => { const x = this._loanTime(a), y = this._loanTime(b); return x === y ? 0 : (x > y ? -1 : 1) }
    const sorted = (loans || []).slice().sort(cmp)
    return { accountLoansActive: sorted.filter(loan => !done(loan)), accountLoansDone: sorted.filter(done) }
  },
  setLoanSort(event) {
    const mode = event.currentTarget.dataset.mode
    if (mode !== 'time' && mode !== 'amount') return
    if (mode === this.data.accountLoanSort) return
    this.setData({ accountLoanSort: mode, ...this._splitLoans(this.data.accountLoans, mode) })
  },
  loadAccountLoans: function () {
    const account = this.data.account
    const token = this._accountLoansToken = {}
    if (!account || account.nature !== 'liability') return Promise.resolve()
    const current = pageReadSession.capture(this), accountId = account.accountId
    this.setData({ accountLoansLoading: true, accountLoansError: '' })
    const valid = () => current() && this._accountLoansToken === token && this.data.account && this.data.account.accountId === accountId
    // 不截断：按游标翻完该账户全部贷款再一次性展示（页面很小、量有限）；不再保留「查看全部」折叠入口。
    const items = []
    const fetchAll = (cursor) => api.callApi('loans.list', { accountId, pageSize: 40, cursor }, { force: true }).then(result => {
      if (!valid()) return null
      if (!Array.isArray(result.items) || result.items.some(loan => loan.accountId !== accountId)) throw new Error('贷款所属账户不一致，请重试')
      for (const item of result.items) items.push(item)
      if (result.nextCursor && items.length < 500) return fetchAll(result.nextCursor)
      const loans = items.map(presentLoan)
      const done = loan => loan.statusText === '已完成' || loan.statusText === '已结清' || loan.status === 'settled'
      // 所有分期合计的总利息/总费用（全期口径，取自每笔 installmentSummary.totalInterestMinor/totalFeeMinor）。
      let interestTotal = 0n, feeTotal = 0n, counted = 0
      for (const loan of loans) {
        const s = loan.installmentSummary
        if (s && s.totalInterestMinor != null) {
          interestTotal += BigInt(s.totalInterestMinor); feeTotal += BigInt(s.totalFeeMinor || '0'); counted += 1
        }
      }
      const money = require('../../utils/money')
      const totalInterestText = counted ? money.formatMinor(interestTotal.toString()) : null
      const totalFeeText = counted ? money.formatMinor(feeTotal.toString()) : null
      this.setData({ accountLoans: loans, ...this._splitLoans(loans, this.data.accountLoanSort), accountLoansLoaded: true,
        accountLoansMore: false, accountPendingCount: Number(result.pendingRepaymentCount || 0),
        accountLoansTotalInterestText: totalInterestText, accountLoansTotalFeeText: totalFeeText, accountLoansTotalCount: counted })
      return null
    })
    return fetchAll(null)
      .catch(error => { if (valid()) this.setData({ accountLoansError: error.message || '贷款暂未读取，请重试' }) })
      .finally(() => { if (valid()) this.setData({ accountLoansLoading: false }) })
  },

  // 账单里的分期（还没归到任何分期计划的来源）：按账户拉取，聚合「一笔分期一条」展示。
  loadAccountSources: function () {
    const account = this.data.account
    if (!account || account.nature !== 'liability') return Promise.resolve()
    const current = pageReadSession.capture(this), accountId = account.accountId
    this.setData({ accountSourcesLoading: true, accountSourcesError: '' })
    const valid = () => current() && this.data.account && this.data.account.accountId === accountId
    const items = [], seen = new Set()
    const fetchPage = (cursor) => api.callApi('loans.installmentSources', { accountId, pageSize: 40, cursor }, { force: true }).then(result => {
      if (!valid()) return
      for (const item of result.items || []) { if (!seen.has(item.itemId)) { seen.add(item.itemId); items.push(item) } }
      if (result.nextCursor && items.length < 300) return fetchPage(result.nextCursor)
      const groups = installmentSource.aggregate(items).map(installmentSource.presentGroup)
      this.setData({ accountSources: groups, accountSourcesLoaded: true })
    })
    return fetchPage(null)
      .catch(error => { if (valid()) this.setData({ accountSourcesError: error.message || '账单分期暂未读取，请重试' }) })
      .finally(() => { if (valid()) this.setData({ accountSourcesLoading: false }) })
  },

  // 自动补偿：把「同计划名 + 同期次」但漏归的利息/手续费补进已有计划，免去逐条手点「归入」。
  // 触发条件：本页还有未归来源、且已存在分期计划。逐个计划调用服务端 reconcile（只认与已关联来源同
  // 计划名+期次的项，绝不误并另一笔分期）。补到东西后重载一次，带 _reconcileDone 防循环。
  reconcileOrphanSources: async function (isCurrent) {
    if (this._reconciling || this.data.saving) return
    const groups = this.data.accountSources || []
    const plans = (this.data.accountLoans || []).filter(loan => loan.kind === 'installment' && loan.scheduleTerms)
    if (!groups.length || !plans.length) return
    this._reconciling = true
    let linked = 0
    try {
      for (const loan of plans) {
        if (!isCurrent()) return
        try {
          const result = await api.callApi('loans.reconcileInstallmentSources', { requestId: api.createRequestId(), loanId: loan.loanId, version: loan.version })
          linked += Number(result && result.linked || 0)
        } catch (error) { /* 单个计划补失败不打断页面；下一次进入可再补 */ }
      }
    } finally { this._reconciling = false }
    if (linked > 0 && isCurrent()) await this.loadAccount({ force: true })
  },

  // 从账单识别出的分期新建分期计划：带出已知信息到 loan-form。
  createLoanFromSource: function (event) {
    const source = this.data.accountSources.find(item => item.sourceItemId === event.currentTarget.dataset.id)
    const account = this.data.account
    if (!source || !account || account.archived) return
    wx.navigateTo({ url: '/packages/loans/pages/loan-form/index?sourceItemId=' + encodeURIComponent(source.sourceItemId) })
  },

  // 把账单识别出的分期归入已有计划：用本页已加载的分期计划做候选（不再额外请求，免偶发失败）。
  chooseLoanForSource: function (event) {
    const account = this.data.account
    const source = this.data.accountSources.find(item => item.sourceItemId === event.currentTarget.dataset.id)
    if (!source || !account || account.archived || this.data.saving) return
    const plan = String(source.name || '').trim()
    const matches = (this.data.accountLoans || [])
      .filter(loan => loan.kind === 'installment' && Number(loan.scheduleTerms || 0) >= source.latestPeriod && (!source.totalTerms || loan.scheduleTerms === source.totalTerms))
      .map(loan => Object.assign({}, loan, { samePlan: Boolean(plan) && String(loan.name || '').trim() === plan }))
      .sort((a, b) => Number(b.samePlan) - Number(a.samePlan))
    this.setData({ sourceChoosing: { source, loans: matches, loading: false, error: '' } })
  },

  closeSourceChoosing: function () { if (!this.data.saving) this.setData({ sourceChoosing: null }) },

  stopPropagation: function () {},

  confirmSourceLink: async function (event) {
    const choosing = this.data.sourceChoosing
    if (!choosing || this.data.saving) return
    const loan = choosing.loans.find(item => item.loanId === event.currentTarget.dataset.id)
    if (!loan) return
    const current = pageReadSession.capture(this), source = choosing.source
    this.setData({ saving: true })
    try {
      await pendingWrites.send('api', 'loans.linkInstallmentSource', { loanId: loan.loanId, version: loan.version, itemId: source.sourceItemId }, { exact: true })
      if (!current()) return
      this.setData({ sourceChoosing: null })
      wx.showToast({ title: '已归入分期', icon: 'success' })
      await this.loadAccount({ force: true })
    } catch (error) {
      if (!current()) return
      this.setData({ 'sourceChoosing.error': error.message || '归入失败，请重试' })
    } finally { if (current()) this.setData({ saving: false }) }
  },

  openAccountTransactions: function () {
    const account = this.data.account
    if (!account || !pageReadSession.isCurrent(this)) return
    wx.navigateTo({ url: '/pages/account-transactions/index?accountId=' + encodeURIComponent(account.accountId) })
  },

  openAccountLoans: function () {
    const account = this.data.account
    if (account && account.nature === 'liability' && pageReadSession.isCurrent(this)) wx.navigateTo({ url: '/packages/loans/pages/loans/index?accountId=' + encodeURIComponent(account.accountId) })
  },

  openAccountLoan: function (event) {
    const account = this.data.account
    const loan = this.data.accountLoans.find(item => item.loanId === event.currentTarget.dataset.id)
    if (account && loan && loan.accountId === account.accountId && pageReadSession.isCurrent(this)) wx.navigateTo({ url: '/packages/loans/pages/loan-detail/index?loanId=' + encodeURIComponent(loan.loanId) })
  },

  createAccountLoan: function () {
    const account = this.data.account
    if (account && account.nature === 'liability' && !account.archived && pageReadSession.isCurrent(this)) wx.navigateTo({ url: '/packages/loans/pages/loan-form/index?accountId=' + encodeURIComponent(account.accountId) })
  },

  startEditName: function () {
    const account = this.data.account
    if (!account || account.archived || this.data.saving) return
    this.setData({ editingName: true, nameDraft: account.name, nameError: '' })
  },

  cancelEditName: function () {
    if (this.data.saving) return
    this.setData({ editingName: false, nameDraft: '', nameError: '' })
  },

  bindNameDraft: function (event) {
    if (this.data.saving) return
    this.setData({ nameDraft: String(event && event.detail && event.detail.value || ''), nameError: '' })
  },

  saveName: function () {
    const account = this.data.account
    if (this.data.saving || !account || account.archived || !this.data.editingName) return
    const name = String(this.data.nameDraft || '').trim()
    if (!name) {
      this.setData({ nameError: '名称不能为空' })
      return
    }
    if (name === account.name) {
      this.cancelEditName()
      return
    }
    const self = this
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, nameError: '' })
    return api.callApi('accounts.update', { requestId: api.createRequestId(), accountId: account.accountId, version: account.version, name: name })
      .then(function () {
        if (!isCurrent()) return
        wx.showToast({ title: '已保存', icon: 'success' })
        self.setData({ editingName: false, nameDraft: '' })
        self.loadAccount()
      })
      .catch(function (error) { return self.recoverName(error, isCurrent) })
      .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  },

  recoverName: async function (error, isCurrent) {
    if (!isCurrent()) return
    if (this._readLoad) await this._readLoad
    if (!isCurrent()) return
    await this.loadAccount({ force: true })
    if (!isCurrent()) return
    this.setData({ nameError: error.message || '保存失败' })
  },

  openCorrection: function () {
    const account = this.data.account
    if (!account || account.archived || account.nature !== 'asset') return
    this.setData({ formOpen: true, balanceYuan: money.minorToYuan(account.displayBalanceMinor), errorMessage: '' })
  },

  closeForm: function () {
    if (!this.data.saving) this.setData({ formOpen: false, errorMessage: '' })
  },

  stopBubble: function () {},
  toggleDebtHint: function () { this.setData({ debtHintOpen: !this.data.debtHintOpen }) },
  closeDebtHint: function () { this.setData({ debtHintOpen: false }) },
  bindBalance: function (event) { this.setData({ balanceYuan: event.detail.value }) },

  saveCorrection: function () {
    if (this.data.saving || !this.data.account || this.data.account.nature !== 'asset') return
    let data
    try {
      data = { requestId: api.createRequestId(), accountId: this.data.account.accountId, displayBalanceMinor: money.yuanToMinor(this.data.balanceYuan, { allowZero: true }), occurredLocalAt: time.today() + 'T' + time.currentClock() + ':00', timezoneOffsetMinutes: new Date().getTimezoneOffset() }
    } catch (error) { this.setData({ errorMessage: error.message }); return }

    const self = this
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, errorMessage: '' })
    return api.callApi('accounts.correctBalance', data).then(function () {
      if (!isCurrent()) return
      wx.showToast({ title: '已保存', icon: 'success' })
      self.setData({ formOpen: false })
      self.loadAccount()
    }).catch(function (error) { return self.recoverMutation(error, '保存失败', isCurrent) })
      .finally(function () { if (isCurrent()) self.setData({ saving: false }) })
  },

  startEditBilling: function (event) {
    const account = this.data.account, field = event.currentTarget.dataset.field
    // 账单日/还款日/额度是固定属性；本期应还/最低/到期日/周期是每期账单快照（补录兜底）。
    const editable = ['statementDay', 'repaymentDay', 'creditLimit', 'statementDue', 'statementMinimum', 'statementDueDate', 'statementCycle']
    if (!account || account.archived || account.nature !== 'liability' || this.data.saving || !editable.includes(field)) return
    if (!this.data.billingSupported) { this.setData({ errorMessage: billing.UNAVAILABLE }); return }
    const draft = billing.draft(account)
    const value = field === 'creditLimit' ? draft.creditLimitYuan
      : field === 'statementDue' ? draft.statementDueYuan
        : field === 'statementMinimum' ? draft.statementMinimumYuan
          : field === 'statementDueDate' ? draft.statementDueDate
            : field === 'statementCycle' ? draft.statementCycle
              : (draft[field] ? String(draft[field]) : '')
    const labels = { statementDay: '账单日', repaymentDay: '还款日', creditLimit: '信用额度', statementDue: '本期应还', statementMinimum: '最低还款', statementDueDate: '到期还款日', statementCycle: '账单周期' }
    this.setData({ editingBilling: field, editingBillingLabel: labels[field], billingFieldDraft: value, billingFieldError: '', errorMessage: '' })
  },

  cancelEditBilling: function () { if (!this.data.saving) this.setData({ editingBilling: '', billingFieldError: '' }) },

  bindBillingField: function (event) { this.setData({ billingFieldDraft: event.detail.value, billingFieldError: '' }) },

  saveBillingField: function () {
    const account = this.data.account, field = this.data.editingBilling
    if (this.data.saving || !field || !account || account.archived) return
    const draft = billing.draft(account)
    const text = String(this.data.billingFieldDraft || '').trim()
    if (field === 'creditLimit') draft.creditLimitYuan = this.data.billingFieldDraft
    else if (field === 'statementDue') draft.statementDueYuan = this.data.billingFieldDraft
    else if (field === 'statementMinimum') draft.statementMinimumYuan = this.data.billingFieldDraft
    else if (field === 'statementDueDate') draft.statementDueDate = text
    else if (field === 'statementCycle') draft.statementCycle = text
    else {
      const raw = text
      if (raw && !/^\d{1,2}$/.test(raw)) { this.setData({ billingFieldError: '请选择每月 1 至 31 日，或未设置' }); return }
      draft[field] = raw ? Number(raw) : 0
    }
    let fields
    try { fields = billing.payload(draft) } catch (error) { this.setData({ billingFieldError: error.message }); return }
    const isCurrent = pageReadSession.capture(this)
    this.setData({ saving: true, billingFieldError: '' })
    return api.callApi('accounts.update', { requestId: api.createRequestId(), accountId: account.accountId, version: account.version, ...fields })
      .then(result => {
        if (!isCurrent()) return
        billing.assertSaved(result, fields)
        this.setData({ editingBilling: '' })
        wx.showToast({ title: '已保存', icon: 'success' })
        return this.loadAccount({ force: true })
      }).catch(error => { if (isCurrent()) this.setData({ billingFieldError: error.message || '保存失败，请重试' }) })
      .finally(() => { if (isCurrent()) this.setData({ saving: false }) })
  },

  archive: function () {
    const account = this.data.account
    const self = this
    const isCurrent = pageReadSession.capture(this)
    if (!account || account.archived || this.data.saving || this._archiveConfirming || !isCurrent()) return
    if (this.data.accountStatusRefresh) return this.loadAccount({ force: true })
    if (this.pendingAccountStatus()) return this.retryAccountStatus()
    const confirmation = this._archiveConfirming = {}
    return new Promise(resolve => wx.showModal({
      title: '停用“' + account.name + '”？',
      content: account.balanceLabel + ' ' + account.balanceText + ' 和历史账目会保留。停用后不能新增交易、转账或记录贷款还款，账户资料也不能修改；已有欠款及贷款本金不会清零。以后可在已停用账户详情点“恢复使用”，恢复时不补息，也不改变自动记费授权。',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (self._archiveConfirming === confirmation) self._archiveConfirming = false
        if (!result.confirm || !isCurrent()) { resolve(); return }
        resolve(self.changeAccountStatus('accounts.archive', { accountId: account.accountId, version: account.version }))
      },
      fail: function () { if (self._archiveConfirming === confirmation) self._archiveConfirming = false; resolve() }
    }))
  },

  // 彻底删除：仅允许"没有任何流水或关联记录"的账户。有记录时后端返回 ACCOUNT_HAS_RECORDS，页面提示改用停用。
  removeAccount: function () {
    const account = this.data.account
    const self = this
    const isCurrent = pageReadSession.capture(this)
    if (!account || !account.archived || this.data.saving || this._removeConfirming || !isCurrent()) return
    if (this.data.accountStatusRefresh) return this.loadAccount({ force: true })
    if (this.pendingAccountStatus()) return this.retryAccountStatus()
    const confirmation = this._removeConfirming = {}
    return new Promise(resolve => wx.showModal({
      title: '彻底删除“' + account.name + '”？',
      content: '仅当该账户没有任何流水或关联记录时才能删除，删除后无法恢复。若已有流水，请改用停用（归档）以保留历史账目。',
      confirmText: '删除',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (self._removeConfirming === confirmation) self._removeConfirming = false
        if (!result.confirm || !isCurrent()) { resolve(); return }
        resolve(self.changeAccountStatus('accounts.remove', { accountId: account.accountId, version: account.version }))
      },
      fail: function () { if (self._removeConfirming === confirmation) self._removeConfirming = false; resolve() }
    }))
  }
}))
