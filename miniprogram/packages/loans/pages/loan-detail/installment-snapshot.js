const FIELDS=['periodNumber','dueDate','periodId','principalMinor','interestMinor','feeMinor','unpaidPrincipalMinor','unpaidInterestMinor','unpaidFeeMinor','status','cancelled','current','paymentConfirmed','completedByProgress','stateText','differences','version']
function unpack(view,loan){
 const s=view.snapshot,n=Number(loan.scheduleTerms)
 if(!s||s.schema!==1||!Number.isInteger(n)||n<1||n>600||s.totalRows!==n||!Array.isArray(s.rows)||s.rows.length!==n||!Array.isArray(s.original)||s.original.length!==n||Number(view.loanVersion)!==Number(loan.version)||view.nextCursor)throw new Error('期次读取未完成')
 const amount=value=>typeof value==='string'&&/^\d+$/.test(value)
 const items=s.rows.map((row,index)=>{
  if(!Array.isArray(row)||row.length!==FIELDS.length||row[0]!==index+1||typeof row[1]!=='string'||!row.slice(3,9).every(amount))throw new Error('期次读取未完成')
  return Object.fromEntries(FIELDS.map((key,i)=>[key,row[i]]))
 })
 const periods=s.original.map((row,index)=>{
  if(!Array.isArray(row)||row.length!==5||row[0]!==index+1||typeof row[1]!=='string'||!row.slice(2).every(amount))throw new Error('期次读取未完成')
  return {periodNumber:row[0],dueDate:row[1],principalMinor:row[2],interestMinor:row[3],feeMinor:row[4]}
 })
 const prompts=view.summary&&view.summary.repaymentPrompts
 if(!Array.isArray(prompts)||new Set(prompts.map(r=>r.periodNumber)).size!==prompts.length||prompts.some(r=>!Number.isInteger(r.periodNumber)||r.periodNumber<1||r.periodNumber>n||typeof r.paid!=='boolean'))throw new Error('期次读取未完成')
 return {view:{...view,items,snapshot:undefined},preview:{periods}}
}
module.exports={FIELDS,unpack}
