const api=require('../../services/catledger-api')
const money=require('../../utils/money')
const {addMinor}=require('../../utils/minor-arithmetic')
const session=require('../../services/page-read-session')
module.exports={
 periodInput(event){
  if(this.data.loading||this.data.saving)return
  const index=Number(event.currentTarget.dataset.index)
  if(!this.data.allocations[index])return
  this._periodRead=null
  this.setData({['allocations['+index+'].periodInput']:event.detail.value,confirmed:false})
 },
 async selectAllocationPeriod(event){
  if(this.data.loading||this.data.saving||!session.isCurrent(this))return
  const index=Number(event.currentTarget.dataset.index),old=this.data.allocations[index],number=Number(old&&old.periodInput)
  if(!old||!Number.isInteger(number)||number<1||number>600){this.setData({errorMessage:'请输入 1 至 600 的期次'});return}
  const current=session.capture(this),token=this._periodRead={}
  this.setData({loading:true,errorMessage:''})
  try{
   const view=await api.callApi('loans.installment',{loanId:old.loanId,periodNumber:number},{force:true})
   if(!current()||this._periodRead!==token)return
   const row=view.period
   if(!row||row.cancelled||row.paymentConfirmed)throw new Error('本期已付或已取消，请核对原借还记录')
   if(row.complete&&!row.historicalPrincipalMinor)throw new Error('旧历史确认依据待核对，暂不能补入凭证')
   const next={...old,version:view.loanVersion,period:{periodNumber:number,version:row.periodId?row.version:0},periodChargesInitialized:false,chargeChoices:[],chargeAllocations:[]}
   for(const field of ['principal','interest','fee']){
    const base=field==='principal'&&row.historicalPrincipalMinor?row.historicalPrincipalMinor:row[field+'Minor']
    const paid=row['paid'+field[0].toUpperCase()+field.slice(1)+'Minor']||'0'
    next[field+'Yuan']=money.minorToYuan(addMinor(base,paid==='0'?'0':'-'+paid))
   }
   this.setData({['allocations['+index+']']:next,confirmed:false})
   await this.loadAllocationCharges();if(current())this.review()
  }catch(error){if(current()&&this._periodRead===token)this.setData({errorMessage:error.message})}
  finally{if(current()&&this._periodRead===token)this.setData({loading:false})}
 },
 async loadPeriodEntry(current){
  if(!this.data.periodNumber||this._paymentId||this.data.editingPayment||this.data.replacePayment)return
  const view=await api.callApi('loans.installment',{loanId:this._loanId,periodNumber:this.data.periodNumber},{force:true})
  if(!current())return
  const row=view.period,index=this.data.allocations.findIndex(a=>a.loanId===this._loanId)
  if(!row||row.cancelled||row.complete||index<0)throw new Error('本期计划已改变，请返回重新核对')
  const old=this.data.allocations[index],next={...old,version:view.loanVersion,period:{periodNumber:row.periodNumber,version:row.periodId?row.version:0}}
  if(!old.period){
   let total='0'
   for(const field of ['principal','interest','fee']){
    const paid=row['paid'+field[0].toUpperCase()+field.slice(1)+'Minor']||'0'
    const amount=addMinor(row[field+'Minor'],paid==='0'?'0':'-'+paid)
    next[field+'Yuan']=money.minorToYuan(amount);total=addMinor(total,amount)
   }
   this.setData({totalYuan:money.minorToYuan(total),date:this.data.date||new Date().toISOString().slice(0,10)})
  }
  const accountIndex=this.data.accountIndex>=0?this.data.accountIndex:this.data.accounts.findIndex(a=>a.accountId===view.repaymentAccountId)
  this.setData({['allocations['+index+']']:next,accountIndex,confirmed:false})
 }
}
