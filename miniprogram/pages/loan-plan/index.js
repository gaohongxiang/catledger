const api=require('../../services/catledger-api')
const pending=require('../../services/pending-ledger-write')
const session=require('../../services/page-read-session')
const loginGuard=require('../../services/login-guard')
const theme=require('../../theme/service')
const money=require('../../utils/money')
const model=require('./model')
Page({
 data:{loading:false,saving:false,errorMessage:'',savedMessage:'',hasPending:false,loanId:'',loanName:'',loanVersion:0,items:[],nextCursor:null,summary:null,
  formOpen:false,form:model.blank(),paymentId:null,paymentVersion:0,paymentActive:false,paymentShare:null,allocationItems:[],allocationReview:'',confirmed:false,
  history:[],historyKind:'',historyPeriodId:null,historyNext:null},
 onLoad(query){theme.bindPage(this);this.setData({loanId:query.loanId,paymentId:query.paymentId||null})},
 onShow(){return loginGuard.run(this,()=>this.load())},
 onUnload(){session.end(this)},
 async load(event){
  if(this.data.saving)return
  const current=session.begin(this,Object.keys(this.data),[])
  const cursor=event&&event.currentTarget&&event.currentTarget.dataset.next?this.data.nextCursor:null
  this.setData({loading:true,errorMessage:'',hasPending:Boolean(pending.pending())})
  try{
   if(pending.pending()){try{const outcome=await pending.verify();if(current()&&outcome)this.accept(outcome)}catch(error){if(current())this.setData({errorMessage:error.message,hasPending:Boolean(pending.pending())})}}
   const view=await api.callApi('loans.periods',{loanId:this.data.loanId,pageSize:20,...(cursor?{cursor}:{})},{force:true})
   if(!current())return
   this.setData({loanName:view.loanName,loanVersion:view.loanVersion,items:view.items.map(model.period),nextCursor:view.nextCursor,summary:model.summary(view.summary),confirmed:false})
   if(this.data.formOpen&&this.data.form.periodId){
    const fresh=await api.callApi('loans.periods',{loanId:this.data.loanId,periodIds:[this.data.form.periodId],pageSize:40},{force:true})
    if(!current())return
    this.setData({'form.version':fresh.items[0].version,loanVersion:fresh.loanVersion})
   }
   if(this.data.paymentId){
    const actual=await api.callApi('loans.planAllocation',{loanId:this.data.loanId,paymentId:this.data.paymentId},{force:true})
    if(!current())return
    this.setData({paymentVersion:actual.payment.version,paymentActive:actual.payment.status==='active',paymentShare:actual.share,loanVersion:actual.loanVersion})
    if(!this._allocationDirty)this.setData({allocationItems:actual.items.map(model.draft)})
    else if(this.data.allocationItems.length){
     const fresh=await api.callApi('loans.periods',{loanId:this.data.loanId,periodIds:this.data.allocationItems.map(a=>a.periodId),pageSize:40},{force:true})
     if(!current())return
     const rows=new Map(fresh.items.map(p=>[p.periodId,p]))
     this.setData({allocationItems:this.data.allocationItems.map(a=>Object.assign({},a,{version:rows.get(a.periodId).version,dueDate:rows.get(a.periodId).dueDate,periodNumber:rows.get(a.periodId).periodNumber})),loanVersion:fresh.loanVersion})
    }
    this.review()
   }
  }catch(error){if(current())this.setData({errorMessage:error.message||'计划暂未读取'})}
  finally{if(current())this.setData({loading:false})}
 },
 newPeriod(){if(!this.data.saving&&!this.data.hasPending)this.setData({formOpen:true,form:model.blank(),savedMessage:''})},
 editPeriod(event){const p=this.data.items.find(p=>p.periodId===event.currentTarget.dataset.id);if(p&&!this.data.saving&&!this.data.hasPending)this.setData({formOpen:true,form:model.draft(p),savedMessage:''})},
 closeForm(){if(!this.data.saving&&!this.data.hasPending)this.setData({formOpen:false})},
 input(event){const field=event.currentTarget.dataset.field;if(['periodNumber','dueDate','principalYuan','interestYuan','feeYuan'].includes(field))this.setData({['form.'+field]:event.detail.value})},
 cancelled(event){this.setData({'form.cancelled':event.detail.value.includes('cancelled')})},
 confirm(event){this.setData({confirmed:event.detail.value.includes('confirmed')})},
 addPeriod(event){
  const p=this.data.items.find(p=>p.periodId===event.currentTarget.dataset.id)
  if(!p||p.cancelled||this.data.saving||this.data.allocationItems.some(a=>a.periodId===p.periodId))return
  if(this.data.allocationItems.length>=40){this.setData({errorMessage:'一次最多分配 40 期'});return}
  this._allocationDirty=true
  this.setData({allocationItems:this.data.allocationItems.concat({periodId:p.periodId,periodNumber:p.periodNumber,dueDate:p.dueDate,version:p.version,principalYuan:'',interestYuan:'',feeYuan:''}),confirmed:false});this.review()
 },
 removePeriod(event){this._allocationDirty=true;this.setData({allocationItems:this.data.allocationItems.filter(a=>a.periodId!==event.currentTarget.dataset.id),confirmed:false});this.review()},
 allocationInput(event){const {index,field}=event.currentTarget.dataset;if(!this.data.allocationItems[index]||!['principalYuan','interestYuan','feeYuan'].includes(field))return;this._allocationDirty=true;this.setData({['allocationItems['+index+'].'+field]:event.detail.value,confirmed:false});this.review()},
 review(){this.setData({allocationReview:model.allocationReview(this.data)})},
 accept(outcome){this._allocationDirty=false;this.setData({hasPending:false,savedMessage:outcome.recovered?'上次操作已确认成功':'操作已完成',formOpen:false,confirmed:false})},
 savePeriod(){if(this.data.formOpen||pending.pending())return this.save('loans.savePeriod')},
 saveAllocation(){return this.save('loans.allocatePeriods')},
 retry(){return this.save('loans.savePeriod')},
 async save(action){
  if(this.data.saving||this.data.loading)return
  const current=session.capture(this);this.setData({saving:true,errorMessage:'',savedMessage:''})
  try{const payload=pending.pending()?{}:action==='loans.savePeriod'?model.periodPayload(this.data):model.allocationPayload(this.data);const outcome=await pending.send('api',action,payload);if(current())this.accept(outcome)}
  catch(error){if(current())this.setData({errorMessage:error.message,hasPending:Boolean(pending.pending())})}
  finally{if(current())this.setData({saving:false})}
  if(current()&&this.data.savedMessage)return this.load()
 },
 async history(event){
  if(this.data.loading||this.data.saving)return
  const current=session.capture(this),d=event.currentTarget.dataset,id=d.id||this.data.historyPeriodId,kind=d.kind||this.data.historyKind
  this.setData({loading:true,errorMessage:''})
  try{const view=await api.callApi('loans.periodHistory',{periodId:id,kind,pageSize:20,...(d.next&&this.data.historyNext?{cursor:this.data.historyNext}:{})},{force:true})
   if(current())this.setData({historyPeriodId:id,historyKind:kind,historyNext:view.nextCursor,history:view.items.map(item=>Object.assign({},item,{key:kind==='plan'?String(item.version):item.allocationId,
    text:kind==='plan'?'版本 '+item.version+' · '+item.snapshot.dueDate+' · 本金 '+money.formatMinor(item.snapshot.principalMinor)+' / 利息 '+money.formatMinor(item.snapshot.interestMinor)+' / 费用 '+money.formatMinor(item.snapshot.feeMinor)+(item.snapshot.cancelled?' · 已取消':''):
     (item.active?'当前分配':'已撤销或替换')+' · 本金 '+money.formatMinor(item.principalMinor)+' / 利息 '+money.formatMinor(item.interestMinor)+' / 费用 '+money.formatMinor(item.feeMinor)}))})
  }catch(error){if(current())this.setData({errorMessage:error.message})}finally{if(current())this.setData({loading:false})}
 }
})
