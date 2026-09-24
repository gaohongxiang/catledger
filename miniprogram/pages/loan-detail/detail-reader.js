const session = require('../../services/page-read-session')
const model = require('./detail-model')
const PAGE_SIZE = 20

function create(api) {
  return {
    applyDetailLoan(loan) {
      const key = loan.loanId + ':' + loan.version
      if (this._detailKey !== key) {
        this._detailKey = key
        this._detailReady = false
        this._detailGeneration = (this._detailGeneration || 0) + 1
        this._detailPreview = null
        this._detailView = null
        this._detailHistory = []
        this._detailNext = null
        this.setData({ periodRows: [], scheduleMore: false, detailError: '' })
      }
      if (this._periodAction === 'loans.installments' && this._detailReady && api.isFresh && !api.isFresh(this._periodAction || 'loans.periods', { loanId: loan.loanId, pageSize: PAGE_SIZE })) this._detailReady = false
      this.setData({ detail: model.build(loan, this._detailView, this._detailPreview) })
    },
    async loadDetail() {
      if (!this.data.loan || this._detailReady || !session.isCurrent(this)) return
      const current = session.capture(this), generation = this._detailGeneration
      const valid = () => current() && generation === this._detailGeneration
      const loan = this.data.loan, input = model.previewInput(loan)
      this._periodAction = loan.kind === 'installment' && input ? 'loans.installments' : 'loans.periods'
      const options = { force: !!this._detailForce }; this._detailForce = false
      this.setData({ detailLoading: true, detailError: '' })
      const results = await Promise.allSettled([
        api.callApi(this._periodAction, { loanId: loan.loanId, pageSize: PAGE_SIZE }, options),
        input ? api.callApi('loans.previewPlan', input, options) : Promise.resolve(null)
      ])
      if (!valid()) return
      const periods = results[0], preview = results[1]
      const matching = periods.status === 'fulfilled' && Number(periods.value.loanVersion) === Number(loan.version)
      this._detailView = matching ? Object.assign({}, periods.value, { tracking: this._periodAction === 'loans.installments' }) : null
      this._detailPreview = preview.status === 'fulfilled' ? preview.value : null
      this._detailHistory = this._periodAction === 'loans.installments' ? [] : model.historicalRows(loan, this._detailPreview)
      this._detailReady = matching && preview.status === 'fulfilled'
      const error = !matching ? '还款计划未能更新，请重新读取。' : preview.status === 'rejected' ? '成本和历史期次暂未加载，请重试。' : ''
      this.setData({ detail: model.build(loan, this._detailView, this._detailPreview), detailLoading: false, detailError: error })
      this.showScheduleWindow({ historyOffset: 0, cursor: null }, this._detailView)
    },
    showScheduleWindow(window, view, append) {
      const history = this._detailHistory || [], inHistory = window.historyOffset < history.length
      const rows = inHistory ? history.slice(window.historyOffset, window.historyOffset + PAGE_SIZE) : view ? view.items : []
      this._detailNext = inHistory
        ? window.historyOffset + PAGE_SIZE < history.length
          ? { historyOffset: window.historyOffset + PAGE_SIZE, cursor: null }
          : this._detailView && this._detailView.items.length ? { historyOffset: history.length, cursor: null } : null
        : view && view.nextCursor ? { historyOffset: history.length, cursor: view.nextCursor } : null
      const visible = rows.map(row => model.rowView(row, model.today()))
      this.setData({ periodRows: append ? this.data.periodRows.concat(visible) : visible, scheduleMore: !!this._detailNext,
        scheduleHistorical: inHistory || !!(append && this.data.scheduleHistorical) })
    },
    async showMoreSchedule() {
      if (this.data.detailLoading || !session.isCurrent(this)) return
      const window = this._detailNext
      if (!window) return
      const current = session.capture(this), generation = this._detailGeneration
      const valid = () => current() && generation === this._detailGeneration
      this.setData({ detailLoading: true, detailError: '' })
      try {
        const view = window.cursor ? await api.callApi(this._periodAction, { loanId: this._loanId, pageSize: PAGE_SIZE, cursor: window.cursor }) : this._detailView
        if (!valid()) return
        if (window.historyOffset >= this._detailHistory.length && (!view || Number(view.loanVersion) !== Number(this.data.loan.version))) throw new Error('贷款已更新，请重新读取后查看期次。')
        this.showScheduleWindow(window, view, true)
      } catch (error) {
        if (valid()) this.setData({ detailError: error.message || '后续期次暂未加载，请重试。' })
      } finally { if (valid()) this.setData({ detailLoading: false }) }
    },
    refreshDetail() { this._detailGeneration = (this._detailGeneration || 0) + 1; this._forceLoanRead = true; this._detailForce = true; this._detailReady = false; return this.load() },
    openCalculationGuide() { this.setData({ guideOpen: true }) },
    closeCalculationGuide() { this.setData({ guideOpen: false }) },
    stopGuideTap() {}
  }
}
module.exports = { create }
