const api=require('../../services/catledger-api')
const session=require('../../services/page-read-session')
const money=require('../../utils/money')
function rows(transactions){return transactions.map(t=>({...t,pickerLabel:String(t.occurredLocalAt).slice(0,10)+' · '+(t.category&&t.category.name||'支出')+(t.note?' · '+t.note:'')+' · 可退'+money.formatMinor(t.refundableMinor)}))}
module.exports={
 loadRefundables(options={}){
  if(!session.isCurrent(this)||this.data.saving)return Promise.resolve()
  if(!options.force&&this.data.refundablesReady)return Promise.resolve()
  if(!options.force&&this._refundablesLoad)return this._refundablesLoad
  const current=session.capture(this),token=this._refundQuery={},account=this.data.refundAccounts[this.data.refundAccountIndex]
  const input={pageSize:20,month:this.data.refundMonth||null,accountId:account&&account.accountId||null,search:this.data.refundSearch,
   occurredLocalAt:this.data.date+'T'+this.data.clock+':00',timezoneOffsetMinutes:this.data.timezoneOffsetMinutes,
   ...(this.data.transactionId?{editingTransactionId:this.data.transactionId}:{}),...(this._refundDirectId?{originalTransactionId:this._refundDirectId}:{})}
  if(options.cursor)input.cursor=options.cursor
  this.setData({refundablesLoading:true,refundablesReady:false,errorMessage:''})
  const valid=()=>current()&&this._refundQuery===token
  this._refundablesLoad=api.callApi('transactions.refundable',input,{force:!!options.force}).then(result=>{
   if(!valid())return
   if(!Array.isArray(result.transactions))throw new Error('原支出列表不完整，请重新查询')
   const list=rows(result.transactions)
   this._refundCursor=options.cursor||null
   this.setData({refundableTransactions:list,refundNextCursor:result.nextCursor||null,refundCanPrevious:!!(this._refundPrevious&&this._refundPrevious.length),refundablesReady:true,
    originalIndex:list.findIndex(t=>t.transactionId===this.data.originalTransactionId)})
   if(this._refundDirectId&&!list.length)this.setData({errorMessage:'原消费已失效、已退完或属于受保护费用；贷款费用请从分期费用详情办理退费'})
  }).catch(error=>{if(valid())this.setData({errorMessage:error.message||'原支出读取失败，请重新查询',refundablesReady:false})})
   .finally(()=>{if(valid()){this._refundablesLoad=null;this.setData({refundablesLoading:false})}})
  return this._refundablesLoad
 },
 refundFilter(event){
  const field=event.currentTarget.dataset.field
  if(this.data.saving||!['refundMonth','refundSearch','refundAccountIndex'].includes(field))return
  this._refundQuery=null;this._refundablesLoad=null;this._refundDirectId=null
  this.setData({[field]:field==='refundAccountIndex'?Number(event.detail.value):event.detail.value,refundablesReady:false,refundablesLoading:false,originalIndex:-1,originalTransactionId:'',refundNextCursor:null,refundCanPrevious:false,refundableTransactions:[]})
 },
 searchRefunds(){if(this.data.saving)return;this._refundPrevious=[];return this.loadRefundables({force:true})},
 clearRefundFilters(){this.refundFilter({currentTarget:{dataset:{field:'refundSearch'}},detail:{value:''}});this.setData({refundMonth:'',refundAccountIndex:0});return this.searchRefunds()},
 nextRefundPage(){
  if(this.data.saving||this.data.refundablesLoading||!this.data.refundNextCursor)return
  this._refundPrevious=(this._refundPrevious||[]).concat([this._refundCursor||null]).slice(-30)
  return this.loadRefundables({force:true,cursor:this.data.refundNextCursor})
 },
 previousRefundPage(){if(this.data.saving||this.data.refundablesLoading||!this._refundPrevious||!this._refundPrevious.length)return;return this.loadRefundables({force:true,cursor:this._refundPrevious.pop()})},
 async startRefund(){
  if(this.data.saving||this.data.loanManaged||!session.isCurrent(this))return
  const current=session.capture(this),id=this.data.transactionId
  try{
   const result=await api.callApi('transactions.refundable',{originalTransactionId:id,pageSize:1},{force:true})
   if(!current())return
   if(!result.transactions.length)throw new Error('此支出已退完或受贷款保护；贷款费用请从分期费用详情办理退费')
   wx.navigateTo({url:'/pages/transaction-editor/index?originalTransactionId='+encodeURIComponent(id)})
  }catch(error){if(current())this.setData({errorMessage:error.message})}
 }
}
