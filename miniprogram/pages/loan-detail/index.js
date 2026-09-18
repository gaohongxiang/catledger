const api = require('../../services/catledger-api')
const pending = require('../../services/pending-ledger-write')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const money = require('../../utils/money')
const { present, form } = require('../loans/model')
Page({
  data: { sourceTransactionId: '', sourceContext: null, history: [], historyNext: null, historyLoaded: false, historyLoading: false, historyError: '', loan: null, loading: false, saving: false, errorMessage: '', savedMessage: '', formOpen: false, hasPending: false,
    accounts: [], accountIndex: -1, kinds: ['普通借款','消费分期'], kindIndex: 0, name: '', institution: '',
    principalYuan: '', baselineDate: '', startDate: '', endDate: '', repaymentMethod: '' },
  onLoad(query) { this._loanId = query && query.loanId || null; this._sourceTransactionId = query && query.sourceTransactionId || ''; theme.bindPage(this); this.setData({ formOpen: !this._loanId, sourceTransactionId: this._sourceTransactionId, kindIndex: !this._loanId && query && query.kind === 'installment' ? 1 : 0 }) },
  onShow() { theme.bindPage(this); return loginGuard.run(this, () => this.load()) },
  onUnload() { pageReadSession.end(this) },
  load() {
    const current = pageReadSession.begin(this, ['sourceContext','history','historyNext','historyLoaded','historyLoading','historyError','loan','loading','saving','errorMessage','savedMessage','formOpen','hasPending','accounts','accountIndex','name','institution','principalYuan','baselineDate','startDate','endDate','repaymentMethod','kindIndex'], ['_load','_sourceInitialized'])
    if (this._load) return this._load
    this.setData({ loading: true, errorMessage: '', sourceContext: null })
    this._load = Promise.all([api.callApi('catalog.get'), this._loanId ? api.callApi('loans.get', { loanId: this._loanId }, { force: true }) : Promise.resolve(null), this._sourceTransactionId ? api.callApi('loans.transaction', { transactionId: this._sourceTransactionId }, { force: true }) : Promise.resolve(null)])
      .then(async ([catalog, result, sourceContext]) => {
        if (!current()) return
        getApp().globalData.uid = catalog.uid
        const accounts = catalog.accounts.filter(a => ['credit','other_liability'].includes(a.type) && !a.archived)
        const selected = this.data.accounts[this.data.accountIndex]
        this.setData({ accounts, sourceContext, accountIndex: selected ? accounts.findIndex(a => a.accountId === selected.accountId) : -1 })
        if (result) {
          this.setData({ loan: present(result.loan) })
          if (!this.data.formOpen) this.fillForm(result.loan)
        } else if (this.data.accountIndex < 0 && accounts.length && !this._sourceTransactionId) this.setData({ accountIndex: 0 })
        if (sourceContext && !this._sourceInitialized) {
          this._sourceInitialized = true
          if (sourceContext.state === 'candidate') {
            if (!this._loanId) this.setData({ accountIndex: accounts.findIndex(a => a.accountId === sourceContext.targetAccount.accountId) })
            else if (result && (result.loan.baselinePrincipalMinor == null || result.loan.baselineDate > sourceContext.transaction.occurredLocalAt.slice(0,10))) this.setData({ formOpen: true })
          }
        }
        this.setData({ hasPending: Boolean(pending.pending()) })
        if (this.data.hasPending) {
          try {
            const recovered = await pending.verify()
            if (current() && recovered) {
              this.showSaved(recovered)
              if (/^loans\.(create|update)$/.test(recovered.action)) {
                const fresh = await api.callApi('loans.get', { loanId: this._loanId }, { force: true })
                if (current()) { this.setData({ loan: present(fresh.loan) }); this.fillForm(fresh.loan) }
              }
            }
          }
          catch (error) { if (current()) this.setData({ errorMessage: error.message || '上次操作仍待核实', hasPending: Boolean(pending.pending()) }) }
        }
      })
      .catch(error => { if (current()) this.setData({ errorMessage: error.message || '贷款资料暂未加载' }) })
      .finally(() => { if (current()) { this._load = null; this.setData({ loading: false }) } })
    return this._load
  },
  recordPayment() {
    if (this.data.loading || this.data.saving || !this._loanId) return
    const source = this.data.sourceContext
    if (this._sourceTransactionId && (!source || source.state !== 'candidate' || source.targetAccount.inactive || !this.data.loan || this.data.loan.accountId !== source.targetAccount.accountId)) { this.setData({ errorMessage: '原还款状态已改变，请返回重新核对' }); return }
    if (this._sourceTransactionId && (!this.data.loan || this.data.loan.baselinePrincipalMinor == null || this.data.loan.baselineDate > source.transaction.occurredLocalAt.slice(0,10))) {
      this.edit(); this.setData({ errorMessage: '请先确认还款日期日初或更早的本金基准，不能把本次扣款当贷款本金' }); return
    }
    wx.navigateTo({ url: '/pages/loan-payment/index?loanId=' + encodeURIComponent(this._loanId) + (this._sourceTransactionId ? '&sourceTransactionId=' + encodeURIComponent(this._sourceTransactionId) : '') })
  },
  openPlan() { wx.navigateTo({ url: '/pages/loan-plan/index?loanId=' + encodeURIComponent(this._loanId) }) },
  openPayment(event) { wx.navigateTo({ url: '/pages/loan-payment/index?paymentId=' + encodeURIComponent(event.currentTarget.dataset.id) }) },
  async loadHistory(event) {
    if (this.data.historyLoading || !this._loanId) return
    const current = pageReadSession.capture(this)
    const cursor = event && event.currentTarget && event.currentTarget.dataset.next ? this.data.historyNext : null
    this.setData({ historyLoading: true, historyError: '' })
    try {
      const result = await api.callApi('loans.payments', { loanId: this._loanId, pageSize: 20, cursor }, { force: true })
      if (current()) this.setData({ history: result.items.map(p => Object.assign({}, p, { totalText: money.formatMinor(p.totalMinor), kindText: p.kind === 'drawdown' ? '放款' : '还款' })), historyNext: result.nextCursor, historyLoaded: true })
    } catch (error) { if (current()) this.setData({ historyError: error.message }) }
    finally { if (current()) this.setData({ historyLoading: false }) }
  },
  clearDate(event) { const field = event.currentTarget.dataset.field; if (['startDate','endDate'].includes(field)) this.setData({ [field]: '' }) },
  fillForm(loan) { this.setData(Object.assign(form(loan), { accountIndex: this.data.accounts.findIndex(a => a.accountId === loan.accountId) })) },
  edit() { if (!this.data.loan || this.data.saving) return; this.fillForm(this.data.loan); this.setData({ formOpen: true, savedMessage: '' }) },
  cancelEdit() { if (this.data.saving) return; if (this._loanId) this.setData({ formOpen: false }); else wx.navigateBack() },
  input(event) { const field = event.currentTarget.dataset.field; if (['name','institution','principalYuan','baselineDate','startDate','endDate','repaymentMethod'].includes(field)) this.setData({ [field]: event.detail.value }) },
  selectAccount(event) { this.setData({ accountIndex: Number(event.detail.value) }) },
  selectKind(event) { this.setData({ kindIndex: Number(event.detail.value) }) },
  openAccounts() { wx.navigateTo({ url: '/pages/accounts/index' }) },
  showSaved(outcome) {
    this.setData({ hasPending: false, savedMessage: outcome.recovered ? '上次操作已确认成功' : '贷款资料已保存' })
    if (/^loans\.(create|update)$/.test(outcome.action)) {
      this._loanId = outcome.result.loanId
      this.setData({ formOpen: false })
    }
  },
  async save() {
    if (this.data.saving || this.data.loading) return
    const current = pageReadSession.capture(this)
    this.setData({ saving: true, errorMessage: '', savedMessage: '' })
    try {
      let data = {}
      if (!pending.pending()) {
        if (this._sourceTransactionId && (!this.data.sourceContext || this.data.sourceContext.state !== 'candidate')) throw new Error('原还款已关联或不可用，请返回重新核对')
        const account = this.data.accounts[this.data.accountIndex]
        if (!account) throw new Error('请选择负债账户')
        if (this._sourceTransactionId && (this.data.sourceContext.targetAccount.inactive || account.accountId !== this.data.sourceContext.targetAccount.accountId)) throw new Error('请选择原还款对应的有效负债账户')
        const known = this.data.principalYuan.trim() !== ''
        data = { name: this.data.name, institution: this.data.institution, kind: this.data.kindIndex === 1 ? 'installment' : 'borrowing',
          accountId: account.accountId, baselinePrincipalMinor: known ? money.yuanToMinor(this.data.principalYuan, { allowZero: true }) : null,
          baselineDate: known ? this.data.baselineDate : null, startDate: this.data.startDate || null, endDate: this.data.endDate || null,
          repaymentMethod: this.data.repaymentMethod || null }
        if (this._loanId) Object.assign(data, { loanId: this._loanId, version: this.data.loan.version })
      }
      const outcome = await pending.send('api', this._loanId ? 'loans.update' : 'loans.create', data)
      if (!current()) return
      this.showSaved(outcome)
    } catch (error) { if (current()) this.setData({ errorMessage: error.message, hasPending: Boolean(pending.pending()) }) }
    finally { if (current()) this.setData({ saving: false }) }
    if (current() && this.data.savedMessage) return this.load()
  }
})
