const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const loginGuard = require('../../services/login-guard')
const theme = require('../../theme/service')
const { present } = require('./model')
const money=require('../../utils/money')
const retainedView=items=>items.map(f=>({...f,componentText:f.component==='interest'?'利息':'手续费',amountText:money.formatMinor(f.amountMinor)}))
Page({
  data: { retainedCharges:[],retainedTotal:0,retainedOpen:false,retainedNextCursor:null,retainedCanPrevious:false,retainedLoading:false,retainedError:'',scoped: false, scopeAccount: null, pendingInstallmentCount: 0, pendingRepaymentCount: 0, items: [], loading: false, hasLoaded: false, errorMessage: '', nextCursor: null, canPrevious: false },
  onLoad(query) { this._accountId = query && query.accountId || ''; this.setData({ scoped: Boolean(this._accountId) }); theme.bindPage(this); this._previous = []; this._cursor = null },
  onShow() {
    theme.bindPage(this)
    return loginGuard.run(this, () => {
      if (this.data.hasLoaded && !api.isFresh('loans.list', this.loanQuery())) { this._cursor = null; this._previous = [] }
      return this.loadLoans()
    })
  },
  onHide(){pageReadSession.end(this)},
  onUnload() { pageReadSession.end(this) },
  onPullDownRefresh() { return this.firstPage().finally(() => wx.stopPullDownRefresh()) },
  loanQuery() { return Object.assign({ pageSize: 20, cursor: this._cursor || null }, this._accountId ? { accountId: this._accountId } : {}) },
  loadLoans(force) {
    const current = pageReadSession.begin(this, Object.keys(this.data), ['_load','_cursor','_previous','_retainedCursor','_retainedPrevious','_retainedQuery'])
    if (this._load) return this._load
    this.setData({ loading: true, errorMessage: '' })
    this._load = (async () => {
      await require('../../services/loan-charge-sync').beforePage(this,current,{force:Boolean(force)})
      if (this._accountId) {
        const catalog = await api.callApi('catalog.get', {}, { force: Boolean(force) })
        if (!current()) return
        const account = catalog.accounts.find(item => item.accountId === this._accountId && ['credit', 'other_liability'].includes(item.type))
        if (!account) { this.setData({ scopeAccount: null, items: [], hasLoaded: false, pendingRepaymentCount: 0, nextCursor: null }); throw new Error('此负债账户不可用，请返回账户管理') }
        this.setData({ scopeAccount: account })
      }
      if (!current()) return
      const [result, sources, retained] = await Promise.all([api.callApi('loans.list', this.loanQuery(), { force: Boolean(force) }), api.callApi('loans.installmentSources', { ...(this._accountId ? { accountId: this._accountId } : {}), pageSize: 20 }, { force: Boolean(force) }),api.callApi('loans.retainedCharges',{...(this._accountId?{accountId:this._accountId}:{}),pageSize:20},{force:true})])
      if (!current()) return
      if (this._accountId && result.items.some(item => item.accountId !== this._accountId)) throw new Error('贷款所属账户不一致，请重试')
      this._retainedCursor=null;this._retainedPrevious=[];this._retainedQuery=null
      this.setData({retainedCharges:retainedView(retained.items),retainedTotal:retained.total,retainedNextCursor:retained.nextCursor,retainedCanPrevious:false,retainedLoading:false,retainedError:'',pendingInstallmentCount: sources.items.length, pendingRepaymentCount: Number(result.pendingRepaymentCount || 0), items: result.items.map(present), nextCursor: result.nextCursor, hasLoaded: true, canPrevious: Boolean(this._previous && this._previous.length) })
    })().catch(error => { if (current()) this.setData({ errorMessage: error.message || '贷款暂未加载，请重试' }) })
      .finally(() => { if (current()) { this._load = null; this.setData({ loading: false }) } })
    return this._load
  },
  firstPage() { if (this.data.loading) return this._load || Promise.resolve(); this._cursor = null; this._previous = []; return this.loadLoans(true) },
  nextPage() { if (this.data.loading || !this.data.nextCursor) return; this._previous = (this._previous || []).concat([this._cursor || null]).slice(-5); this._cursor = this.data.nextCursor; return this.loadLoans() },
  previousPage() { if (this.data.loading || !this._previous || !this._previous.length) return; this._cursor = this._previous.pop(); return this.loadLoans() },
  openLoan(event) { if (this.data.items.some(item => item.loanId === event.currentTarget.dataset.id)) wx.navigateTo({ url: '/pages/loan-detail/index?loanId=' + encodeURIComponent(event.currentTarget.dataset.id) }) },
  toggleRetained(){if(!this.data.loading)this.setData({retainedOpen:!this.data.retainedOpen})},
  openRetainedCharge(event){if(pageReadSession.isCurrent(this)&&!this.data.loading&&this.data.retainedCharges.some(f=>f.chargeId===event.currentTarget.dataset.id))wx.navigateTo({url:'/pages/loan-detail/index?chargeId='+encodeURIComponent(event.currentTarget.dataset.id)})},
  async loadRetained(){
    if(this.data.loading||this.data.retainedLoading||!pageReadSession.isCurrent(this))return
    const current=pageReadSession.capture(this),token=this._retainedQuery={}
    this.setData({retainedLoading:true,retainedError:''})
    try{const result=await api.callApi('loans.retainedCharges',{...(this._accountId?{accountId:this._accountId}:{}),pageSize:20,cursor:this._retainedCursor||null},{force:true})
      if(current()&&this._retainedQuery===token)this.setData({retainedCharges:retainedView(result.items),retainedTotal:result.total,retainedNextCursor:result.nextCursor,retainedCanPrevious:!!this._retainedPrevious?.length})
    }catch(error){if(current()&&this._retainedQuery===token)this.setData({retainedError:error.message})}
    finally{if(current()&&this._retainedQuery===token)this.setData({retainedLoading:false})}
  },
  nextRetained(){if(this.data.loading||this.data.retainedLoading||!this.data.retainedNextCursor)return;this._retainedPrevious=(this._retainedPrevious||[]).concat([this._retainedCursor||null]).slice(-5);this._retainedCursor=this.data.retainedNextCursor;return this.loadRetained()},
  previousRetained(){if(this.data.loading||this.data.retainedLoading||!this._retainedPrevious?.length)return;this._retainedCursor=this._retainedPrevious.pop();return this.loadRetained()},
  openUnassigned() { return loginGuard.run(this, () => wx.navigateTo({ url: '/pages/loan-link/index' + (this._accountId ? '?accountId=' + encodeURIComponent(this._accountId) : '') })) },
  openInstallmentSources() { wx.navigateTo({ url: '/pages/installment-sources/index' + (this._accountId ? '?accountId=' + encodeURIComponent(this._accountId) : '') }) },
  createLoan() {
    if (this.data.loading || (this._accountId && (!this.data.scopeAccount || this.data.scopeAccount.archived))) return
    return loginGuard.run(this, () => wx.navigateTo({ url: '/pages/loan-form/index' + (this._accountId ? '?accountId=' + encodeURIComponent(this._accountId) : '') }))
  }
})
