const api=require('../../services/catledger-api')
const money=require('../../utils/money')
const {addMinor}=require('../../utils/minor-arithmetic')
module.exports={
 async loadPeriodEntry(current){
  if(!this.data.periodNumber||this._paymentId||this.data.editingPayment||this.data.replacePayment)return
  const view=await api.callApi('loans.installment',{loanId:this._loanId,periodNumber:this.data.periodNumber},{force:true})
  if(!current())return
  const row=view.period,index=this.data.allocations.findIndex(a=>a.loanId===this._loanId)
  if(!row||row.cancelled||index<0)throw new Error('本期计划已改变，请返回重新核对')
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
  this.setData({['allocations['+index+']']:next,confirmed:false})
 }
}
