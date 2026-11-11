const api = require('../../../../services/catledger-api')
const pending = require('../../../../services/pending-ledger-write')
const session = require('../../../../services/page-read-session')
const money = require('../../../../utils/money')
const model = require('./detail-model')
const LABELS = { principal: '本金', interest: '利息', fee: '手续费' }
const confirm = options => new Promise(resolve => wx.showModal({ ...options, success: r => resolve(r.confirm), fail: () => resolve(false) }))

module.exports = {
  async openInstallment(event) {
    if (!session.isCurrent(this) || !this.data.detail || this.data.saving || !this.data.detail.tracking && !(this.data.loan && this.data.loan.scheduleTerms)) return
    const term = Number(event.currentTarget.dataset.term), current = session.capture(this), token = this._periodToken = {}
    this.setData({ periodOpen: true, periodLoading: true, periodError: '', selectedPeriod: null, periodEvidenceOpen:false,periodCharges:[],periodChargeIssues:[],periodChargeNext:null,periodFeesError:'' })
    try {
      const result = await api.callApi('loans.installment', { loanId: this._loanId, periodNumber: term }, { force: true })
      if (!current() || token !== this._periodToken) return
      this._selectedInstallment = result
      const account = this.data.accounts.find(a => a.accountId === this.data.loan.accountId)
      const p0 = result.period
      const draft0 = { dueDate: p0.dueDate, principal: money.minorToYuan(p0.principalMinor), interest: money.minorToYuan(p0.interestMinor), fee: money.minorToYuan(p0.feeMinor), cancelled: !!p0.cancelled }
      this.setData({ selectedPeriod: Object.assign({}, p0, model.rowView(p0, model.today())),
        periodDraft: draft0, periodDraftTotal: this._draftTotal(draft0),
        periodCanBook: !!(account && account.type === 'credit' && ['interest','fee'].some(key=>p0[key+'Minor']!=='0' && !(p0.recordedComponents||[]).includes(key))),
        periodSources: result.sources.map(item => Object.assign({}, item, { label: LABELS[item.component], amount: money.formatMinor(item.amountMinor) })),
        periodLegacy: result.legacyPayments.map(payment => ({ ...payment, totalText: money.formatMinor(payment.totalMinor), occurredText: String(payment.occurredLocalAt || '').slice(0, 10) })), periodMoreSources: result.moreSources })
      await this.loadPeriodCharges(term,token)
    } catch (error) { if (current() && token === this._periodToken) this.setData({ periodError: error.message || '这期记录暂未读取' }) }
    finally { if (current() && token === this._periodToken) this.setData({ periodLoading: false }) }
  },
  closeInstallment() { if (!this.data.saving) { this._periodToken = {}; this.setData({ periodOpen: false }) } },
  async installmentWrite(action, data) {
    if (this.data.saving || this.data.loading || !session.isCurrent(this)) return
    const current = session.capture(this)
    this.setData({ saving: true, periodError: '', errorMessage: '' })
    try {
      const outcome = await pending.send('api', action, data, { exact: true })
      if (!current()) return
      this.setData({ periodOpen: false, progressOpen: false, hasPending: false, savedMessage: '' })
      wx.showToast({ title: outcome.action === 'loans.archiveInstallment' && outcome.result.archived ? '已删除' : '已更新', icon: 'success', duration: 1500 })
      if (outcome.action === 'loans.archiveInstallment' && outcome.result.archived) { wx.navigateBack(); return }
      this._detailReady = false; this._detailForce = true; this._forceLoanRead = true
      await this.load()
      return true
    } catch (error) {
      if (current()) this.setData({ periodError: error.message, errorMessage: error.message, hasPending: !!pending.pending() })
    } finally { if (current()) this.setData({ saving: false }) }
  },
  selectRepayments(event) {
    if (!session.isCurrent(this) || this.data.saving || this.data.loading || this.data.detailLoading) return
    const selected = new Set(event.detail.value), visible = new Set(this.data.periodRows.filter(r=>r.repaymentChoice).map(r=>r.term))
    this.setData({ repaymentRows: this.data.repaymentRows.map(r=>visible.has(r.periodNumber)?{...r,paid:selected.has(String(r.periodNumber))}:r) })
    this.setData(this.repaymentSelection())
    this.syncRepaymentAlert()
  },
  // 自定义勾选（跟随主题）：点某期翻转其“已还”勾选，等价于原 checkbox-group 的单选切换。
  toggleRepayment(event) {
    if (!session.isCurrent(this) || this.data.saving || this.data.loading || this.data.detailLoading) return
    const term = Number(event.currentTarget.dataset.term)
    const visible = new Set(this.data.periodRows.filter(r=>r.repaymentChoice).map(r=>r.term))
    if (!visible.has(term)) return
    this.setData({ repaymentRows: this.data.repaymentRows.map(r=>r.periodNumber===term?{...r,paid:!r.paid}:r) })
    this.setData(this.repaymentSelection())
    this.syncRepaymentAlert()
  },
  async saveRepayments() {
    if (!this._detailView || !this.data.repaymentRows.length || this.data.loan.archived || this.data.detailLoading) return
    const visible = new Set(this.data.periodRows.filter(r=>r.repaymentChoice).map(r=>r.term))
    const repayments = this.data.repaymentRows.filter(r=>visible.has(r.periodNumber)).map(({periodNumber,paid})=>({periodNumber,paid}))
    if (!repayments.length) return
    const saved = await this.installmentWrite('loans.confirmInstallments', { loanId:this._loanId, version:this._detailView.loanVersion,
      repayments })
    if (saved) this.syncRepaymentAlert()
    return saved
  },
  openInstallmentSource(event) {
    const source = (this.data.periodSources || []).find(item => item.itemId === event.currentTarget.dataset.id)
    if (source && source.updateId && source.eventId) wx.navigateTo({ url: '/packages/finance/pages/import-workbench/index?updateId=' + encodeURIComponent(source.updateId) + '&evidenceEventId=' + encodeURIComponent(source.eventId) })
  },
  async removeInstallmentSource(event) {
    const source = (this.data.periodSources || []).find(item => item.itemId === event.currentTarget.dataset.id), selected = this._selectedInstallment
    if (!source || source.origin !== 'manual' || !selected || this.data.saving) return
    if (!await confirm({ title: '撤销这笔补记费用', content: '撤销本次手动补记的费用支出。已导入并关联的银行费用需从原账单核对。', confirmText: '撤销费用' })) return
    if (session.isCurrent(this)) return this.installmentWrite('loans.removeInstallmentItem', { loanId: this._loanId, version: selected.loanVersion, itemId: source.itemId, itemVersion: source.version })
  },
  togglePeriodEvidence(){this.setData({periodEvidenceOpen:!this.data.periodEvidenceOpen})},
  periodDraftInput(event) {
    const key = event.currentTarget.dataset.field
    if (!['dueDate','principal','interest','fee','cancelled'].includes(key)) return
    const draft = Object.assign({}, this.data.periodDraft, { [key]: event.detail.value })
    this.setData({ periodDraft: draft, periodDraftTotal: this._draftTotal(draft) })
  },
  _draftTotal(draft) {
    try {
      const sum = BigInt(money.yuanToMinor(draft.principal, { allowZero: true }))
        + BigInt(money.yuanToMinor(draft.interest, { allowZero: true }))
        + BigInt(money.yuanToMinor(draft.fee, { allowZero: true }))
      return money.formatMinor(sum.toString())
    } catch (e) { return '—' }
  },
  saveInstallmentPeriod() {
    const selected = this._selectedInstallment, draft = this.data.periodDraft
    if (!selected || !draft) return
    try {
      const row = selected.period
      return this.installmentWrite('loans.savePeriod', { loanId: this._loanId, loanVersion: selected.loanVersion, ...(row.periodId ? { periodId: row.periodId, version: row.version } : {}),
        periodNumber: row.periodNumber, historicalRevision: true, dueDate: draft.dueDate, principalMinor: money.yuanToMinor(draft.principal, { allowZero: true }), interestMinor: money.yuanToMinor(draft.interest, { allowZero: true }), feeMinor: money.yuanToMinor(draft.fee, { allowZero: true }), cancelled: draft.cancelled })
    } catch (error) { this.setData({ periodError: error.message || '请填写有效金额' }) }
  }
}
