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
function canGenerate(loan){
 if(!loan||loan.scheduleMethod==null||loan.scheduleTerms==null||loan.measurementKind==null)return false
 if(loan.measurementKind==='rate')return loan.quoteType!=null&&loan.ratePpm!=null
 return loan.measurementKind==='repayment'&&loan.repaymentMinor!=null
}
function previewView(result){
 const rows=result.periods.map(p=>({periodNumber:p.periodNumber,dueDate:p.dueDate,
  totalText:money.formatMinor(fields.reduce((s,f)=>addMinor(s,p[f+'Minor']),'0'))}))
 return {periodCount:result.periods.length,rows:rows.slice(0,24),truncated:result.periods.length>24,
  summaryText:'合计应还 '+money.formatMinor(result.summary.totalPaymentMinor)+'（利息 '+money.formatMinor(result.summary.totalInterestMinor)+'、费用 '+money.formatMinor(result.summary.totalFeeMinor)+'）'}
}
function generatePayload(data){
 if(!data.preview||!data.generateConfirmed)throw new Error('请先试算并核对预览，勾选确认后再生成')
 return {loanId:data.loanId,version:data.loanVersion,confirmed:true}
}
module.exports={fields,period,summary,draft,blank,periodPayload,allocationPayload,allocationReview,canGenerate,previewView,generatePayload}
