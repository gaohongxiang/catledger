const api = require('../../services/catledger-api')
const pending = require('../../services/pending-ledger-write')
const session = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const model = require('./model')
Page({
  data: { loading: false, saving: false, errorMessage: '', savedMessage: '', hasPending: false, hasPayment: false, payment: null, transactions: [], allocations: [],
    accounts: [], accountIndex: -1, categories: [], choices: [], nextLoanCursor: null, kindIndex: 0, kinds: ['实际还款','新放款到账'],
    treatments: ['尚未入账，本次记支出','已计入负债，本次只清偿'], reviewText: '请填写总额与已确认本息费，未知分项不能提交。', totalYuan: '', date: '', time: '12:00', confirmed: false },
  onLoad(query) { this._loanId = query && query.loanId; this._paymentId = query && query.paymentId; theme.bindPage(this); this.setData({ hasPayment: Boolean(this._paymentId) }) },
  onShow() { return loginGuard.run(this, () => this.load()) },
  onUnload() { session.end(this) },
  load() {
    const current = session.begin(this, Object.keys(this.data), ['_load'])
    if (this._load) return this._load
    this.setData({ loading: true, errorMessage: '' })
    this._load = api.callApi('catalog.get').then(async catalog => {
      if (!current()) return
      getApp().globalData.uid = catalog.uid
      const selectedAccount = this.data.accounts[this.data.accountIndex]
      const accounts = catalog.accounts.filter(a => !a.archived && ['cash','bank','wallet','other_asset'].includes(a.type))
      const categories = catalog.categories.filter(c => c.kind === 'expense' && !c.archived)
      const allocations = this.data.allocations.map(a => {
        const next = Object.assign({}, a)
        for (const field of ['interest','fee']) {
          const selected = this.data.categories[a[field + 'CategoryIndex']]
          next[field + 'CategoryIndex'] = selected ? categories.findIndex(c => c.id === selected.id) : -1
        }
        return next
      })
      this.setData({ accounts, categories, allocations, accountIndex: selectedAccount ? accounts.findIndex(a => a.accountId === selectedAccount.accountId) : -1,
        confirmed: false, hasPending: Boolean(pending.pending()) })
      if (this.data.hasPending) {
        try { const outcome = await pending.verify(); if (current() && outcome) this.accept(outcome) }
        catch (error) { if (current()) this.setData({ errorMessage: error.message, hasPending: Boolean(pending.pending()) }) }
      }
      if (!current()) return
      if (this._paymentId) {
        const value = await api.callApi('loans.payment', { paymentId: this._paymentId }, { force: true })
        if (current()) this.setData(model.paymentView(value))
      } else if (!this.data.allocations.length && this._loanId) {
        const value = await api.callApi('loans.get', { loanId: this._loanId }, { force: true })
        if (current()) this.setData({ allocations: [model.allocation(value.loan)], confirmed: false })
      } else {
        const selected = await Promise.all(this.data.allocations.map(a => api.callApi('loans.get', { loanId: a.loanId }, { force: true })))
        if (current()) this.setData({ allocations: this.data.allocations.map((a, i) => Object.assign({}, a, { version: selected[i].loan.version, loanName: selected[i].loan.name, kind: selected[i].loan.kind })), confirmed: false })
      }
    }).catch(error => { if (current()) this.setData({ errorMessage: error.message || '借还记录暂未读取' }) })
      .finally(() => { if (current()) { this._load = null; this.setData({ loading: false }) } })
    return this._load
  },
  input(event) { const key = event.currentTarget.dataset.field; if (['totalYuan','date','time'].includes(key)) { this.setData({ [key]: event.detail.value, confirmed: false }); this.review() } },
  chooseKind(event) { this.setData({ kindIndex: Number(event.detail.value), confirmed: false }); this.review() },
  chooseAccount(event) { this.setData({ accountIndex: Number(event.detail.value), confirmed: false }); this.review() },
  editAllocation(event) {
    const { index, field } = event.currentTarget.dataset
    if (!this.data.allocations[index] || !['principalYuan','interestYuan','feeYuan','interestIndex','feeIndex','interestCategoryIndex','feeCategoryIndex'].includes(field)) return
    const value = field.endsWith('Index') ? Number(event.detail.value) : event.detail.value
    this.setData({ ['allocations[' + index + '].' + field]: value, confirmed: false }); this.review()
  },
  review() { this.setData({ reviewText: model.review(this.data) }) },
  confirm(event) { this.setData({ confirmed: event.detail.value.includes('confirmed') }) },
  async moreLoans(event) {
    if (this.data.loading || this.data.saving) return
    const current = session.capture(this)
    this.setData({ loading: true })
    try {
      const cursor = event && event.currentTarget && event.currentTarget.dataset.next ? this.data.nextLoanCursor : null
      const value = await api.callApi('loans.list', { pageSize: 40, ...(cursor ? { cursor } : {}) }, { force: true })
      if (current()) this.setData({ choices: value.items, nextLoanCursor: value.nextCursor })
    } catch (error) { if (current()) this.setData({ errorMessage: error.message }) }
    finally { if (current()) this.setData({ loading: false }) }
  },
  addLoan(event) {
    const loan = this.data.choices.find(l => l.loanId === event.currentTarget.dataset.id)
    if (!loan || this.data.allocations.some(a => a.loanId === loan.loanId)) return
    if (this.data.allocations.length >= 20) { this.setData({ errorMessage: '一次最多分配 20 笔贷款' }); return }
    this.setData({ allocations: this.data.allocations.concat(model.allocation(loan)), choices: [], nextLoanCursor: null, confirmed: false })
    this.review()
  },
  removeLoan(event) { if (this.data.allocations.length > 1) this.setData({ allocations: this.data.allocations.filter(a => a.loanId !== event.currentTarget.dataset.id), confirmed: false }); this.review() },
  accept(outcome) {
    this.setData({ hasPending: false, savedMessage: outcome.recovered ? '上次操作已确认成功' : '操作已完成' })
    if (/^loans\.(record|reverse)$/.test(outcome.action)) { this._paymentId = outcome.result.paymentId; this.setData({ hasPayment: true }) }
  },
  async save() {
    if (this.data.loading || this.data.saving || (this._paymentId && !pending.pending())) return
    const current = session.capture(this)
    this.setData({ saving: true, errorMessage: '', savedMessage: '' })
    try {
      const data = pending.pending() ? {} : model.payload(this.data)
      const outcome = await pending.send('api', 'loans.record', data)
      if (current()) this.accept(outcome)
    } catch (error) { if (current()) this.setData({ errorMessage: error.message, hasPending: Boolean(pending.pending()) }) }
    finally { if (current()) this.setData({ saving: false }) }
    if (current() && this.data.savedMessage) return this.load()
  },
  reverse() {
    if (this.data.loading || this.data.saving || !this.data.payment) return
    wx.showModal({ title: '撤销整组借还', content: '本次新增的全部账目将一起撤销，贷款本金同步恢复。请先确认没有需要保留的后续关联。',
      confirmText: '确认撤销', success: result => { if (result.confirm && session.isCurrent(this)) this.confirmReverse() } })
  },
  async confirmReverse() {
    if (this.data.saving || this.data.loading) return
    const current = session.capture(this)
    this.setData({ saving: true, errorMessage: '', savedMessage: '' })
    try {
      const outcome = await pending.send('api', 'loans.reverse', { paymentId: this.data.payment.paymentId, version: this.data.payment.version,
        loans: this.data.allocations.map(a => ({ loanId: a.loanId, version: a.version })), confirmed: true })
      if (current()) this.accept(outcome)
    } catch (error) { if (current()) this.setData({ errorMessage: error.message, hasPending: Boolean(pending.pending()) }) }
    finally { if (current()) this.setData({ saving: false }) }
    if (current() && this.data.savedMessage) return this.load()
  }
})
