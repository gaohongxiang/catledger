const api = require('../../services/catledger-api')
const pending = require('../../services/pending-ledger-write')
const session = require('../../services/page-read-session')
const money = require('../../utils/money')
const model = require('./detail-model')
const LABELS = { principal: '本金', interest: '利息', fee: '手续费' }
const confirm = options => new Promise(resolve => wx.showModal({ ...options, success: r => resolve(r.confirm), fail: () => resolve(false) }))

module.exports = {
  async openInstallment(event) {
    if (!this.data.detail.tracking || this.data.saving) return
    const term = Number(event.currentTarget.dataset.term), current = session.capture(this), token = this._periodToken = {}
    this.setData({ periodOpen: true, periodLoading: true, periodError: '', selectedPeriod: null, periodEditing: false, periodAdjustOpen: false })
    try {
      const result = await api.callApi('loans.installment', { loanId: this._loanId, periodNumber: term }, { force: true })
      if (!current() || token !== this._periodToken) return
      this._selectedInstallment = result
      const account = this.data.accounts.find(a => a.accountId === this.data.loan.accountId)
      this.setData({ selectedPeriod: Object.assign({}, result.period, model.rowView(result.period, model.today())),
        periodCanBook: !!(account && account.type === 'credit' && ['interest','fee'].some(key=>result.period[key+'Minor']!=='0' && !(result.period.recordedComponents||[]).includes(key))),
        periodSources: result.sources.map(item => Object.assign({}, item, { label: LABELS[item.component], amount: money.formatMinor(item.amountMinor) })),
        periodLegacy: result.legacyPayments, periodMoreSources: result.moreSources })
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
  setPeriodStatus(event) {
    const selected = this._selectedInstallment
    if (!selected || this.data.periodLoading || selected.archived) return
    return this.installmentWrite('loans.setInstallmentProgress', { loanId: this._loanId, version: selected.loanVersion,
      periodNumber: selected.period.periodNumber, status: event.currentTarget.dataset.status })
  },
  bookPeriodCosts(){this.closeInstallment();this.openChargeForm()},
  openProgress() {
    if (!this._detailView || this.data.saving || this.data.loan.archived) return
    this.setData({ progressOpen: true, progressThrough: String(this._detailView.summary.manualThrough), periodError: '' })
  },
  closeProgress() { if (!this.data.saving) this.setData({ progressOpen: false }) },
  progressInput(event) { this.setData({ progressThrough: event.detail.value }) },
  async saveProgress() {
    const value = this.data.progressThrough
    if (!/^\d+$/.test(value) || Number(value) > this.data.loan.scheduleTerms) { this.setData({ periodError: '请输入 0 到总期数之间的整数' }); return }
    const current=session.capture(this)
    if(!await confirm({title:'批量确认已还范围',content:'将第1至'+value+'期标为人工确认。已知未还、部分未还和范围外单期确认保留；不生成付款或费用。',confirmText:'确认范围'})||!current())return
    return this.installmentWrite('loans.setInstallmentProgress',{loanId:this._loanId,version:this._detailView.loanVersion,completedThrough:Number(value),confirmedBatch:true})
  },
  openInstallmentSource(event) {
    const source = (this.data.periodSources || []).find(item => item.itemId === event.currentTarget.dataset.id)
    if (source && source.updateId && source.eventId) wx.navigateTo({ url: '/pages/import-workbench/index?updateId=' + encodeURIComponent(source.updateId) + '&evidenceEventId=' + encodeURIComponent(source.eventId) })
  },
  async removeInstallmentSource(event) {
    const source = (this.data.periodSources || []).find(item => item.itemId === event.currentTarget.dataset.id), selected = this._selectedInstallment
    if (!source || source.origin !== 'manual' || !selected || this.data.saving) return
    if (!await confirm({ title: '撤销这笔补记费用', content: '撤销本次手动补记的费用支出。已导入并关联的银行费用需从原账单核对。', confirmText: '撤销费用' })) return
    if (session.isCurrent(this)) return this.installmentWrite('loans.removeInstallmentItem', { loanId: this._loanId, version: selected.loanVersion, itemId: source.itemId, itemVersion: source.version })
  },
  async archiveInstallment() {
    if (this.data.saving || !this.data.loan) return
    if (!await confirm({ title: '删除分期记录', content: '删除分期并解除关联。账单和已入账金额保留，可重新关联或新建分期。', confirmText: '删除记录', confirmColor: '#A94B40' })) return
    if (session.isCurrent(this)) return this.installmentWrite('loans.archiveInstallment', { loanId: this._loanId, version: this.data.loan.version, archived: true })
  },
  togglePeriodAdjust() { this.setData({ periodAdjustOpen: !this.data.periodAdjustOpen }) },
  editInstallmentPeriod() {
    const row = this._selectedInstallment && this._selectedInstallment.period
    if (!row || this.data.saving) return
    this.setData({ periodEditing: true, periodDraft: { dueDate: row.dueDate, principal: money.minorToYuan(row.principalMinor), interest: money.minorToYuan(row.interestMinor), fee: money.minorToYuan(row.feeMinor), cancelled: !!row.cancelled } })
  },
  periodDraftInput(event) {
    const key = event.currentTarget.dataset.field
    if (['dueDate','principal','interest','fee','cancelled'].includes(key)) this.setData({ ['periodDraft.' + key]: event.detail.value })
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
