const { amount } = require('./loan-charge-domain')
const fail = code => { throw Object.assign(new Error(code), { publicCode: code }) }
function normalizeCoverage(value) {
  if(value==null)return []
  if(!Array.isArray(value)||value.length>80)fail('VALIDATION_ERROR')
  return value.map(row=>{
    if(!row||!['interest','fee'].includes(row.component)||Boolean(row.chargeId)===Boolean(row.transactionId))fail('VALIDATION_ERROR')
    const id=row.chargeId||row.transactionId
    if(typeof id!=='string'||id.length>64)fail('VALIDATION_ERROR')
    return {...(row.chargeId?{chargeId:id}:{transactionId:id}),component:row.component,amountMinor:amount(row.amountMinor)}
  })
}
module.exports = { normalizeCoverage }
