// 详情专用、单次一致性快照；固定列避免600期重复字段名超过页面响应预算。
const FIELDS=['periodNumber','dueDate','periodId','principalMinor','interestMinor','feeMinor','unpaidPrincipalMinor','unpaidInterestMinor','unpaidFeeMinor','status','cancelled','current','paymentConfirmed','completedByProgress','stateText','differences','version']
function pack(view){
 return {schema:1,totalRows:view.rows.length,rows:view.rows.map(row=>FIELDS.map(key=>row[key]??null)),
  original:view.original.map(row=>[row.periodNumber,row.dueDate,row.principalMinor,row.interestMinor,row.feeMinor])}
}
module.exports={FIELDS,pack}
