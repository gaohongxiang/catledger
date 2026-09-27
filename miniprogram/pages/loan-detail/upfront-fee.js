const api=require('../../services/catledger-api'),pending=require('../../services/pending-ledger-write'),session=require('../../services/page-read-session'),money=require('../../utils/money')
const initial={upfrontForm:null,upfrontExisting:[],upfrontExistingIndex:-1,upfrontNext:null,upfrontLoading:false,upfrontCanRecord:false}
const methods={
 openUpfrontFee(){
  if(this.data.saving||this.data.loading||!session.isCurrent(this)||!this.data.loan||this.data.loan.archived)return
  if(this.data.periodCharges.some(c=>c.chargeKey==='upfront:fee'&&c.state!=='planned')){this.setData({chargeError:'已有一次性费用，请从该记录核对或退费'});return}
  this.setData({chargeError:'',upfrontExisting:[],upfrontExistingIndex:-1,upfrontNext:null,upfrontForm:{modeIndex:0,amountYuan:money.minorToYuan(this.data.loan.feeUpfrontMinor),date:'',
   accountIndex:-1,categoryIndex:this.data.chargeCategories.findIndex(c=>c.systemKey==='finance__service'),month:'',covers:false,from:'1',through:String(this.data.loan.scheduleTerms)}})
 },
 upfrontInput(event){
  const key=event.currentTarget.dataset.field
  if(this.data.saving||!this.data.upfrontForm||!Object.hasOwn(this.data.upfrontForm,key))return
  this._upfrontRead=null
  this.setData({['upfrontForm.'+key]:key.endsWith('Index')?Number(event.detail.value):key==='covers'?event.detail.value:event.detail.value,upfrontLoading:false,chargeError:''})
  if(['modeIndex','month','accountIndex'].includes(key))this.setData({upfrontExisting:[],upfrontExistingIndex:-1,upfrontNext:null})
 },
 async loadUpfrontEvidence(event){
  if(this.data.saving||this.data.upfrontLoading||!this.data.upfrontForm)return
  const current=session.capture(this),token=this._upfrontRead={},form=this.data.upfrontForm,account=this.data.chargeRefundAccounts[form.accountIndex]
  const cursor=event&&event.currentTarget&&event.currentTarget.dataset.next?this.data.upfrontNext:null
  this.setData({upfrontLoading:true,chargeError:''})
  try{
   if(!form.month)throw new Error('请选择已有费用的月份')
   const result=await api.callApi('transactions.refundable',{month:form.month,accountId:account&&account.accountId||null,pageSize:20,...cursor?{cursor}:{}},{force:true})
   if(current()&&this._upfrontRead===token)this.setData({upfrontExisting:result.transactions.filter(t=>this.data.chargeRefundAccounts.some(a=>a.accountId===t.sourceAccount.accountId)).map(t=>({...t,label:t.occurredLocalAt.slice(0,10)+' · '+t.sourceAccount.name+' · '+money.formatMinor(t.amountMinor)+' · '+(t.note||'支出')})),upfrontExistingIndex:-1,upfrontNext:result.nextCursor})
  }catch(error){if(current()&&this._upfrontRead===token)this.setData({chargeError:error.message})}
  finally{if(current()&&this._upfrontRead===token)this.setData({upfrontLoading:false})}
 },
 chooseUpfrontEvidence(event){if(!this.data.saving)this.setData({upfrontExistingIndex:Number(event.detail.value)})},
 closeUpfrontFee(){if(!this.data.saving){this._upfrontRead=null;this.setData({upfrontForm:null,upfrontLoading:false})}},
 async saveUpfrontFee(){
  if(this.data.saving||this.data.upfrontLoading||!this.data.upfrontForm||!session.isCurrent(this))return
  const current=session.capture(this),form=this.data.upfrontForm
  this.setData({saving:true,chargeError:''})
  try{
   const data={loanId:this._loanId,version:this.data.loan.version,confirmed:true,mode:form.modeIndex===1?'existing':'new'}
   if(data.mode==='existing'){
    const t=this.data.upfrontExisting[this.data.upfrontExistingIndex];if(!t)throw new Error('请选择已有的实际手续费支出')
    Object.assign(data,{transactionId:t.transactionId,transactionVersion:t.version})
   }else{
    const account=this.data.chargeRefundAccounts[form.accountIndex],category=this.data.chargeCategories[form.categoryIndex]
    if(!account||!category||!form.date)throw new Error('请确认实际收费日期、付款或记费账户和分类')
    Object.assign(data,{accountId:account.accountId,categoryId:category.id,amountMinor:money.yuanToMinor(form.amountYuan),occurredLocalAt:form.date+'T12:00:00',timezoneOffsetMinutes:-480})
   }
   if(form.covers){const from=Number(form.from),through=Number(form.through);if(!Number.isInteger(from)||!Number.isInteger(through)||from<1||through<from||through>this.data.loan.scheduleTerms)throw new Error('请填写有效覆盖期次');data.covers=Array.from({length:through-from+1},(_,i)=>from+i)}
   await pending.send('api','loans.recordUpfrontFee',data)
   if(current()){this.setData({upfrontForm:null,hasPending:false});this._forceLoanRead=true;this._detailReady=false;this._detailForce=true;await this.load();if(current())await this.openOneOffCharges()}
  }catch(error){if(current())this.setData({chargeError:error.message,hasPending:!!pending.pending()})}
  finally{if(current())this.setData({saving:false})}
 }
}
module.exports={initial,methods}
