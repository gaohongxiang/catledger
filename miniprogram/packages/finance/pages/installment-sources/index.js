const api=require('../../../../services/catledger-api')
const pending=require('../../../../services/pending-ledger-write')
const session=require('../../../../services/page-read-session')
const login=require('../../../../services/login-guard')
const theme=require('../../../../theme/service')
const money=require('../../../../utils/money')
const labels={principal:'本金',interest:'利息',fee:'手续费'}
// 计划名优先用来源上持久化的账单计划（本金摘要去掉期次后缀），其次才是合同编号标签。
// 旧来源两者都没有时保留原占位，不拿利息摘要里的“分期付款利息”泛称冒充计划名。
function sourceName(item){return String(item.planLabel||item.referenceLabel||'').trim()||'待确认所属分期'}
const businessInitialData = {items:[],nextCursor:null,loading:false,saving:false,errorMessage:'',hasLoaded:false,selected:null,loans:[],loanCursor:null,choosing:false,scopedLabel:''}

Page(theme.page({
  data:businessInitialData,
  onLoad(query){const q=query||{};this._accountId=q.accountId||'';this._updateId=q.updateId||'';},
  onShow(){return login.run(this,()=>this.load())},
  onUnload(){session.end(this)},
  async load(event){
    if(this.data.loading||this.data.saving)return
    const current=session.begin(this,Object.keys(businessInitialData),[]),cursor=event&&event.currentTarget&&event.currentTarget.dataset.next?this.data.nextCursor:null
    this.setData({loading:true,errorMessage:''})
    try {
      const catalog=await api.callApi('catalog.get');if(!current())return;getApp().globalData.uid=catalog.uid
      if(pending.pending())await pending.verify()
      const result=await api.callApi('loans.installmentSources',{...(this._accountId?{accountId:this._accountId}:{}),...(this._updateId?{updateId:this._updateId}:{}),pageSize:20,cursor},{force:true})
      if(current())this.setData({items:result.items.map(item=>({...item,name:sourceName(item),label:labels[item.component],amount:money.formatMinor(item.amountMinor),accountName:(catalog.accounts.find(a=>a.accountId===item.accountId)||{}).name||'信用卡'})),scopedLabel:this._updateId?'本次导入':'' ,nextCursor:result.nextCursor,hasLoaded:true})
    }catch(error){if(current())this.setData({errorMessage:error.message})}
    finally{if(current())this.setData({loading:false})}
  },
  create(event){const item=this.data.items.find(i=>i.itemId===event.currentTarget.dataset.id);if(item)wx.navigateTo({url:'/packages/finance/pages/loan-form/index?sourceItemId='+encodeURIComponent(item.itemId)})},
  async choose(event){
    const item=this.data.items.find(i=>i.itemId===event.currentTarget.dataset.id)
    if(!item||this.data.loading||this.data.saving)return
    this.setData({selected:item,choosing:true,loans:[],loanCursor:null});return this.loadLoans()
  },
  async loadLoans(event){
    if(!this.data.selected||this.data.loading)return
    const current=session.capture(this),selected=this.data.selected
    this.setData({loading:true,errorMessage:''})
    try{
      const result=await api.callApi('loans.list',{accountId:selected.accountId,pageSize:20,cursor:event&&event.currentTarget&&event.currentTarget.dataset.next?this.data.loanCursor:null},{force:true})
      // 期数相符才可归入；计划名与账单计划相同时排在最前，避免在多个同期数的分期里挑错。
      const plan=String(selected.planLabel||'').trim()
      const matches=result.items.filter(l=>l.kind==='installment'&&l.scheduleTerms>=selected.periodNumber&&(!selected.totalTerms||l.scheduleTerms===selected.totalTerms))
        .map(l=>({...l,samePlan:Boolean(plan)&&String(l.name||'').trim()===plan}))
        .sort((a,b)=>Number(b.samePlan)-Number(a.samePlan))
      if(current())this.setData({loans:matches,loanCursor:result.nextCursor})
    }catch(error){if(current())this.setData({errorMessage:error.message})}
    finally{if(current())this.setData({loading:false})}
  },
  close(){if(!this.data.saving)this.setData({choosing:false,selected:null})},
  stop(){},
  async link(event){
    const loan=this.data.loans.find(l=>l.loanId===event.currentTarget.dataset.id),item=this.data.selected
    if(!loan||!item||this.data.saving||this.data.loading)return
    const current=session.capture(this);this.setData({saving:true,errorMessage:''})
    try{
      const outcome=await pending.send('api','loans.linkInstallmentSource',{loanId:loan.loanId,version:loan.version,itemId:item.itemId},{exact:true})
      if(current())wx.redirectTo({url:'/packages/finance/pages/loan-detail/index?loanId='+encodeURIComponent(outcome.result.loanId)})
    }catch(error){if(current())this.setData({errorMessage:error.message})}
    finally{if(current())this.setData({saving:false})}
  },
  openSource(event){const item=this.data.items.find(i=>i.itemId===event.currentTarget.dataset.id);if(item&&item.updateId)wx.navigateTo({url:'/packages/finance/pages/import-workbench/index?updateId='+encodeURIComponent(item.updateId)+'&evidenceEventId='+encodeURIComponent(item.eventId)})}
}))
