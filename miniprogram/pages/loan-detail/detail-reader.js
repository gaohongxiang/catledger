const session = require('../../services/page-read-session')
const model = require('./detail-model')
const PAGE_SIZE = 20
const snapshot = require('./installment-snapshot')

function create(api) {
  return {
    applyDetailLoan(loan) {
      const key = loan.loanId + ':' + loan.version
      if (this._detailKey !== key) {
        const draft=this._detailKey&&this._detailKey.startsWith(loan.loanId+':')?(this.data.repaymentRows||[]).filter(row=>this._repaymentInitial&&this._repaymentInitial.has(row.periodNumber)&&this._repaymentInitial.get(row.periodNumber)!==row.paid):[]
        this._detailKey = key
        this._detailReady = false
        this._detailGeneration = (this._detailGeneration || 0) + 1
        this._detailPreview = null
        this._detailView = null
        this._detailHistory = []
        this._detailNext = null
        this._repaymentInitial = null
        this.setData({ repaymentRows: draft, repaymentChoiceCount: 0, repaymentSelectedCount: 0, repaymentDirtyCount: 0, periodRows: [], scheduleMore: false, detailError: '' })
        this.syncRepaymentAlert()
      }
      if (this._periodAction === 'loans.installments' && this._detailReady && api.isFresh && !api.isFresh(this._periodAction, { loanId: loan.loanId, pageSize: PAGE_SIZE, detailSnapshot:true })) this._detailReady = false
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
      const tracked=this._periodAction==='loans.installments'
      const results = await Promise.allSettled([api.callApi(this._periodAction, { loanId: loan.loanId, pageSize: PAGE_SIZE, ...tracked?{detailSnapshot:true}:{} }, options)])
      if (!valid()) return
      const periods = results[0]
      let preview
      if(periods.status==='fulfilled'&&periods.value.snapshot){
        try{const value=snapshot.unpack(periods.value,loan);periods.value=value.view;preview={status:'fulfilled',value:value.preview}}
        catch(error){periods.status='rejected';periods.reason=error;preview={status:'rejected',reason:error}}
      }else{
        // 兼容旧服务响应与普通贷款；失败保持独立成本展示，不接纳半份历史选择。
        ;[preview]=await Promise.allSettled([input?api.callApi('loans.previewPlan',input,options):Promise.resolve(null)])
      }
      if (!valid()) return
      // 分页只限制读取大小；需要选择的历史期次一起展示，不能在第20期截断。
      if (periods.status === 'fulfilled' && this._periodAction === 'loans.installments') {
        try {
          let view = periods.value
          const lastChoice = Math.max(0, ...(view.summary.repaymentPrompts || []).map(row => row.periodNumber))
          let through = (view.items[view.items.length - 1] || {}).periodNumber || 0
          while (view.nextCursor && through < lastChoice) {
            const page = await api.callApi(this._periodAction, { loanId: loan.loanId, pageSize: 40, cursor: view.nextCursor }, options)
            if (!valid()) return
            const nextThrough = (page.items[page.items.length - 1] || {}).periodNumber || 0
            if (Number(page.loanVersion) !== Number(loan.version) || nextThrough <= through) throw new Error('期次读取未完成')
            view = { ...view, items: view.items.concat(page.items), nextCursor: page.nextCursor }
            through = nextThrough
          }
          if (through < lastChoice) throw new Error('期次读取未完成')
          periods.value = view
        } catch (error) { periods.status = 'rejected'; periods.reason = error }
      }
      if (!valid()) return
      const matching = periods.status === 'fulfilled' && Number(periods.value.loanVersion) === Number(loan.version)
      this._detailView = matching ? Object.assign({}, periods.value, { tracking: this._periodAction === 'loans.installments' }) : null
      this._detailPreview = preview.status === 'fulfilled' ? preview.value : null
      this._detailHistory = this._periodAction === 'loans.installments' ? [] : model.historicalRows(loan, this._detailPreview)
      this._detailReady = matching && preview.status === 'fulfilled'
      const error = !matching ? '还款计划未能更新，请重新读取。' : preview.status === 'rejected' ? '成本和历史期次暂未加载，请重试。' : ''
      if (matching) this._repaymentInitial = new Map((periods.value.summary.repaymentPrompts || []).map(row => [row.periodNumber, row.paid === true]))
      this.setData({ detail: model.build(loan, this._detailView, this._detailPreview), detailLoading: false, detailError: error, repaymentRows: matching ? (periods.value.summary.repaymentPrompts || []).map(r=>{const draft=this.data.repaymentRows.find(d=>d.periodNumber===r.periodNumber);return draft?{...r,paid:draft.paid}:r}) : this.data.repaymentRows })
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
      this.setData({ ...this.repaymentSelection(append ? this.data.periodRows.concat(visible) : visible), scheduleMore: !!this._detailNext,
        scheduleHistorical: inHistory || !!(append && this.data.scheduleHistorical) })
      this.syncRepaymentAlert()
    },
    repaymentSelection(rows = this.data.periodRows) {
      const choices = new Map((this.data.repaymentRows || []).map(row => [row.periodNumber, row.paid]))
      const initial = this._repaymentInitial || new Map()
      const periodRows = rows.map(row => ({ ...row, repaymentChoice: choices.has(row.term) && !row.cancelled,
        repaymentPaid: choices.get(row.term) === true,
        repaymentDirty: choices.has(row.term) && initial.has(row.term) && choices.get(row.term) !== initial.get(row.term) }))
      return { periodRows, repaymentChoiceCount: periodRows.filter(row => row.repaymentChoice).length,
        repaymentSelectedCount: periodRows.filter(row => row.repaymentChoice && row.repaymentPaid).length,
        repaymentDirtyCount: periodRows.filter(row => row.repaymentDirty).length }
    },
    syncRepaymentAlert() {
      const dirty = (this.data.repaymentDirtyCount || 0) > 0
      if (dirty === !!this._repaymentAlert) return
      this._repaymentAlert = dirty
      if (dirty) { if (typeof wx.enableAlertBeforeUnload === 'function') wx.enableAlertBeforeUnload({ message: '还款选择尚未保存' }) }
      else if (typeof wx.disableAlertBeforeUnload === 'function') wx.disableAlertBeforeUnload()
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
