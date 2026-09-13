const money=require('../../utils/money')
const {addMinor}=require('../../utils/minor-arithmetic')
const fields=['principal','interest','fee']
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1)
function period(row){return Object.assign({},row,{statusText:{unpaid:'未支付',partial:'部分支付',paid:'已支付',cancelled:'已取消'}[row.status],
  totalText:money.formatMinor(fields.reduce((s,f)=>addMinor(s,row[f+'Minor']),'0')),
  unpaidText:money.formatMinor(fields.reduce((s,f)=>addMinor(s,row['unpaid'+cap(f)+'Minor']),'0'))})}
function summary(row){return Object.assign({},row,{unpaidText:money.formatMinor(fields.reduce((s,f)=>addMinor(s,row['unpaid'+cap(f)+'Minor']),'0')),
  principalText:money.formatMinor(row.unpaidPrincipalMinor),gapText:row.principalGapMinor==null?'本金基准待补充':money.formatMinor(row.principalGapMinor)})}
function draft(row){return Object.assign({},row,{principalYuan:money.minorToYuan(row.principalMinor),interestYuan:money.minorToYuan(row.interestMinor),feeYuan:money.minorToYuan(row.feeMinor)})}
function blank(){return {periodNumber:'',dueDate:'',principalYuan:'',interestYuan:'',feeYuan:'',cancelled:false}}
function periodPayload(data){const form=data.form;return {loanId:data.loanId,loanVersion:data.loanVersion,
  ...(form.periodId?{periodId:form.periodId,version:form.version}:{}),periodNumber:Number(form.periodNumber),dueDate:form.dueDate,cancelled:form.cancelled,
  ...Object.fromEntries(fields.map(f=>[f+'Minor',money.yuanToMinor(form[f+'Yuan'],{allowZero:true})]))}}
function allocationPayload(data){
 if(!data.confirmed)throw new Error('请核对期次分配与未分配金额')
 const items=data.allocationItems.map(a=>({periodId:a.periodId,version:a.version,...Object.fromEntries(fields.map(f=>[f+'Minor',money.yuanToMinor(a[f+'Yuan'],{allowZero:true})]))}))
 for(const f of fields){const sum=items.reduce((s,a)=>addMinor(s,a[f+'Minor']),'0');if(addMinor(data.paymentShare[f+'Minor'],'-'+sum).charAt(0)==='-')throw new Error('期次分配超过本次贷款的本金、利息或费用')}
 return {loanId:data.loanId,loanVersion:data.loanVersion,paymentId:data.paymentId,version:data.paymentVersion,confirmed:true,items}
}
function allocationReview(data){try{const value=allocationPayload(Object.assign({},data,{confirmed:true}));return fields.map((f,i)=>['本金','利息','费用'][i]+'未分配 '+money.formatMinor(addMinor(data.paymentShare[f+'Minor'],'-'+value.items.reduce((s,a)=>addMinor(s,a[f+'Minor']),'0')))).join('；')}catch(error){return error.message}}
module.exports={fields,period,summary,draft,blank,periodPayload,allocationPayload,allocationReview}
