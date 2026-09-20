const api = require('../../services/catledger-api')
const importer = require('../../services/catledger-import')
const pending = require('../../services/pending-ledger-write')
const session = require('../../services/page-read-session')
const login = require('../../services/login-guard')
const theme = require('../../theme/service')
const money = require('../../utils/money')
const model = require('./model')
Page({
  data: { loading:false,saving:false,errorMessage:'',savedMessage:'',mode:'new',payment:null,event:null,assets:[],debts:[],categories:[],
    assetIndex:-1,debtIndex:-1,totalYuan:'',date:'',time:'12:00',note:'',principalYuan:'',interestYuan:'',feeYuan:'',
    interestIndex:0,feeIndex:0,interestCategoryIndex:-1,feeCategoryIndex:-1,confirmed:false,
    classification:1,classificationOptions:['普通转账','借款还款'],linkIndex:0,linkOptions:['暂不关联，入账后再处理','关联已有贷款'],
    treatments:['本次计入支出','已计入负债，本次只清偿'],loans:[],loanIndex:-1,nextLoanCursor:null },
  onLoad(query) {
    query = query || {}; this._query = query; theme.bindPage(this)
    this.setData({ mode:query.updateId ? 'import' : query.paymentId ? 'pending' : 'new' })
    if (getApp().globalData.repaymentDraft) {
      this._draft = getApp().globalData.repaymentDraft
      delete getApp().globalData.repaymentDraft
    }
  },
  onShow() { return login.run(this,()=>this.load()) },
  onUnload() { session.end(this) },
  async load() {
    const current = session.begin(this,Object.keys(this.data),['_loading'])
    if (this._loading) return
    this._loading = true; this.setData({ loading:true,errorMessage:'' })
    try {
      const catalog = await api.callApi('catalog.get')
      if (!current()) return
      getApp().globalData.uid = catalog.uid
      let accounts = catalog.accounts.filter(a=>!a.archived)
      let source = null,patch = {},payment = null
      if (this.data.mode === 'import') {
        const result = await importer.readPage('economicEvents.list',{ updateId:this._query.updateId,eventId:this._query.eventId,pageSize:1 })
        if (!current()) return
        source = result.items[0]
        if (!source || result.update.status !== 'review') throw new Error('此记录已入账或已变化，请返回刷新')
        this._update = result.update
        let cursor = null
        do {
          const drafts = await importer.readPage('financeUpdates.options',{ updateId:this._query.updateId,kind:'accountDrafts',pageSize:40,...(cursor ? { cursor } : {}) })
          if (!current()) return
          accounts = accounts.concat(drafts.items); cursor = drafts.nextCursor
        } while (cursor)
        patch = { event:source,totalYuan:money.minorToYuan(source.amountMinor),...(!this._initialized ? { classification:source.loanRepayment ? 1 : 0 } : {}) }
      } else if (this.data.mode === 'pending') {
        const result = await api.callApi('loans.payment',{ paymentId:this._query.paymentId },{ force:true })
        if (!current()) return
        if (!result.repayment || result.payment.status !== 'active' || result.allocations.length) throw new Error('这笔还款已处理，请返回刷新')
        payment = result.payment; source = { loanRepayment:result.repayment }
        patch = { payment,totalYuan:money.minorToYuan(payment.totalMinor),linkIndex:1 }
      }
      const categories = catalog.categories.filter(c=>!c.archived && c.kind === 'expense')
      const assets = accounts.filter(a=>['cash','bank','wallet','other_asset'].includes(a.type)), debts = accounts.filter(a=>a.type === 'other_liability')
      const draft = this._draft || {}, prior = source && source.loanRepayment
      const assetId = prior && prior.assetAccountId || payment && payment.assetAccountId || (source ? source.sourceDirection === 'income' ? source.counterpartyLedgerAccountId : source.ledgerAccountId : draft.sourceAccountId)
      const debtId = prior && prior.liabilityAccountId || (source ? source.sourceDirection === 'income' ? source.ledgerAccountId : source.counterpartyLedgerAccountId : draft.destinationAccountId)
      if (!this._initialized || this.data.mode !== 'new') Object.assign(patch, { assetIndex:assets.findIndex(a=>a.accountId===assetId),debtIndex:debts.findIndex(a=>a.accountId===debtId) })
      if (!this._initialized && this.data.mode === 'new') Object.assign(patch,{ totalYuan:draft.amountMinor ? money.minorToYuan(draft.amountMinor) : '',
        date:(draft.occurredLocalAt || new Date().toISOString()).slice(0,10),time:(draft.occurredLocalAt || '2000-01-01T12:00').slice(11,16),note:draft.note || '' })
      if (prior && (!this._initialized || this.data.mode === 'pending')) Object.assign(patch,model.fields(prior,categories),this.data.mode === 'pending' ? { linkIndex:1 } : {})
      this.setData({ ...patch,assets,debts,categories,confirmed:false })
      this._initialized = true
      await this.loadLoans(false,prior && prior.loanId)
    } catch (error) { if (current()) this.setData({ errorMessage:error.message || '还款资料暂未读取' }) }
    finally { if (current()) { this._loading = false; this.setData({ loading:false }) } }
  },
  input(event) { const field = event.currentTarget.dataset.field; if (['totalYuan','principalYuan','interestYuan','feeYuan','date','time','note'].includes(field)) this.setData({ [field]:event.detail.value,confirmed:false }) },
  select(event) {
    const field = event.currentTarget.dataset.field
    if (!['classification','assetIndex','debtIndex','linkIndex','loanIndex','interestIndex','feeIndex','interestCategoryIndex','feeCategoryIndex'].includes(field)) return
    this.setData({ [field]:Number(event.detail.value),confirmed:false })
    if (field === 'debtIndex') return this.loadLoans()
  },
  confirm(event) { this.setData({ confirmed:event.detail.value.includes('confirmed') }) },
  async loadLoans(more = false,selectedId) {
    const debt = this.data.debts[this.data.debtIndex], current = session.capture(this)
    if (!debt) { this.setData({ loans:[],loanIndex:-1,nextLoanCursor:null }); return }
    const token = this._loansToken = {}
    try {
      const result = await api.callApi('loans.list',{ accountId:debt.accountId,pageSize:40,...(more && this.data.nextLoanCursor ? { cursor:this.data.nextLoanCursor } : {}) },{ force:true })
      if (!current() || this._loansToken !== token) return
      const loans = more ? this.data.loans.concat(result.items) : result.items
      this.setData({ loans,loanIndex:loans.findIndex(l=>l.loanId === (selectedId || this._query.loanId)),nextLoanCursor:result.nextCursor })
    } catch(error) { if (current() && this._loansToken===token) this.setData({ errorMessage:error.message }) }
  },
  moreLoans() { return this.loadLoans(true) },
  createLoan() {
    const selected = this.data.loans[this.data.loanIndex]
    const debt=this.data.debts[this.data.debtIndex]
    const occurred=(this.data.payment || this.data.event || {}).occurredLocalAt || this.data.date
    wx.navigateTo({ url:selected ? '/pages/loan-detail/index?loanId=' + encodeURIComponent(selected.loanId) : '/pages/loan-form/index' +
      (debt ? '?accountId='+encodeURIComponent(debt.accountId)+(occurred?'&baselineDate='+encodeURIComponent(occurred.slice(0,10)):'') : '') })
  },
  async submit(action, data, service) {
    if (this.data.saving) return
    const current = session.capture(this); this.setData({ saving:true,errorMessage:'',savedMessage:'' })
    try {
      const outcome = await pending.send(service || 'api',action,data)
      if (!current()) return
      this.setData({ savedMessage:outcome.result.pending ? '已入账，可在贷款管理继续关联' : this.data.mode === 'import' ? '已保存，确认整批入账后生效' : '已完成' })
      if (this.data.mode === 'new') wx.switchTab({ url:'/pages/transactions/index' })
      else wx.navigateBack({ delta:1 })
    } catch(error) { if (current()) this.setData({ errorMessage:error.message || '结果待确认，再次保存将恢复原请求' }) }
    finally { if (current()) this.setData({ saving:false }) }
  },
  save() {
    if (this.data.loading || this.data.saving) return
    try {
      if (pending.pending()) { const value = pending.pending(); return this.submit(value.action,value.payload,value.target) }
      if (this.data.mode === 'pending') {
        const loan = this.data.loans[this.data.loanIndex]
        if (!loan || !this.data.confirmed) throw new Error('请选择贷款并确认关联；不会再次记账')
        return this.submit('loans.assignRepayment',{ paymentId:this.data.payment.paymentId,version:this.data.payment.version,loanId:loan.loanId,loanVersion:loan.version,confirmed:true })
      }
      const repayment = this.data.mode === 'import' && this.data.classification === 0 ? null : model.decision(this.data)
      if (this.data.mode === 'import') return this.saveImport(repayment)
      return this.submit('loans.bookRepayment',{ repayment,totalMinor:money.yuanToMinor(this.data.totalYuan),
        occurredLocalAt:this.data.date+'T'+this.data.time+':00',timezoneOffsetMinutes:this._draft && this._draft.timezoneOffsetMinutes != null ? this._draft.timezoneOffsetMinutes : new Date().getTimezoneOffset(),note:this.data.note })
    } catch(error) { this.setData({ errorMessage:error.message }) }
  },
  saveImport(repayment) { return this.submit('financeUpdates.setRepayment',{ updateId:this._query.updateId,updateVersion:this._update.version,
    eventId:this.data.event.eventId,eventVersion:this.data.event.version,repayment },'import') },
  keepReview() { if (!this.data.loading && !this.data.saving) return this.saveImport({ mode:'review' }) },
  release() {
    if (this.data.loading || this.data.saving) return
    wx.showModal({ title:'不再关联贷款？',content:'保留已入账的本金转账、利息和费用，只移除这笔关联待办。',success:result=>{
      if (result.confirm && session.isCurrent(this)) this.submit('loans.releaseRepayment',{ paymentId:this.data.payment.paymentId,version:this.data.payment.version,confirmed:true })
    } })
  }
})
