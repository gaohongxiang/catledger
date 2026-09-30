// 历史勾选只补充明确选择的费用关联；沿用收费合同、费用键和一次性覆盖。
const {ledgerError}=require('./ledger-errors')
const domain=require('./loan-charge-domain'),store=require('./loan-charge-store')
const {adoptTransaction,insertCharge}=require('./loan-charge-service')

async function apply(c,uid,loan,state,rows,input={}){
 const coverage=input.coverage||[],oneOff=input.oneOffCharges||[]
 if(!Array.isArray(coverage)||coverage.length>1200||!Array.isArray(oneOff)||oneOff.length>12)throw ledgerError('VALIDATION_ERROR')
 if(!coverage.length&&!oneOff.length)return
 const targets=new Map()
 for(const row of rows){
  const costs=[row,...row.periodNumber===1&&BigInt(loan.feeUpfrontMinor||'0')>0n?[{periodNumber:null,interestMinor:'0',feeMinor:loan.feeUpfrontMinor,dueDate:row.dueDate}]:[]]
  for(const cost of costs)for(const component of ['interest','fee']){
   const source=state.sources.find(i=>i.periodNumber===cost.periodNumber&&i.component===component)
   const amountMinor=String(source?source.amountMinor:cost[component+'Minor'])
   if(amountMinor==='0')continue
   const chargeKey=cost.periodNumber==null?'upfront:fee':'period:'+cost.periodNumber+':'+component
   targets.set(chargeKey,{chargeKey,periodNumber:cost.periodNumber,component,amountMinor,chargeDate:source?source.occurredDate:cost.dueDate,source,
    categoryId:(state.categories.find(i=>i.systemKey===(component==='interest'?'finance__interest':'finance__service'))||{}).categoryId||null})
  }
 }
 const usedKeys=new Set(),usedTransactions=new Set()
 function take(keys,transactionId){
  if(!Array.isArray(keys)||!keys.length||keys.some(key=>usedKeys.has(key)||!targets.has(key))||new Set(keys).size!==keys.length||usedTransactions.has(transactionId))throw ledgerError('LOAN_SOURCE_MISMATCH')
  keys.forEach(key=>usedKeys.add(key));usedTransactions.add(transactionId)
  return keys.map(key=>targets.get(key))
 }
 async function itemFor(target){
  let item=state.charges.find(i=>i.chargeKey===target.chargeKey)
  if(item&&item.amountMinor!==target.amountMinor)throw ledgerError('LOAN_CHARGE_DIFFERENCE')
  if(!item){item={...target,chargeId:await insertCharge(c,uid,state.contract.contractId,target,state.contract.planVersion),state:'planned'};state.charges.push(item)}
  return item
 }
 for(const cover of coverage){
  if(!cover||typeof cover!=='object')throw ledgerError('VALIDATION_ERROR')
  const [target]=take([cover.chargeKey],cover.transactionId),item=await itemFor(target)
  if(target.source&&target.source.transactionId!==cover.transactionId)throw ledgerError('LOAN_SOURCE_MISMATCH')
  await adoptTransaction(c,uid,state.contract.contractId,item,cover.transactionId,target.source&&target.source.itemId,{explicit:true,transactionVersion:cover.transactionVersion})
  await store.audit(c,uid,state.contract.contractId,item.chargeId,'adopt_historical_fee',{transactionId:cover.transactionId,transactionVersion:cover.transactionVersion,chargeKey:cover.chargeKey})
 }
 for(const one of oneOff){
  if(!one||!/^[a-zA-Z0-9_-]{1,60}$/.test(one.key)||!['interest','fee'].includes(one.component))throw ledgerError('VALIDATION_ERROR')
  const targetsForOne=take(one.covers,one.transactionId)
  if(targetsForOne.some(i=>i.component!==one.component||i.source)||targetsForOne.reduce((n,i)=>n+BigInt(i.amountMinor),0n)!==BigInt(domain.amount(one.amountMinor)))throw ledgerError('LOAN_SOURCE_MISMATCH')
  const target={chargeKey:'once:'+one.key,periodNumber:null,component:one.component,amountMinor:one.amountMinor,chargeDate:domain.date(one.chargeDate),categoryId:targetsForOne[0].categoryId}
  const item=await itemFor(target)
  await adoptTransaction(c,uid,state.contract.contractId,item,one.transactionId,null,{explicit:true,transactionVersion:one.transactionVersion})
  for(const coveredTarget of targetsForOne){
   const covered=await itemFor(coveredTarget)
   if(!['planned','covered'].includes(covered.state)||covered.coveredByChargeId&&covered.coveredByChargeId!==item.chargeId)throw ledgerError('LOAN_SOURCE_MISMATCH')
   await c.execute("UPDATE catledger_loan_charges SET state='covered',covered_by_charge_id=?,version=version+1 WHERE uid=? AND charge_id=?",[item.chargeId,uid,covered.chargeId])
   Object.assign(covered,{state:'covered',coveredByChargeId:item.chargeId})
  }
  await store.audit(c,uid,state.contract.contractId,item.chargeId,'adopt_historical_coverage',{transactionId:one.transactionId,transactionVersion:one.transactionVersion,covers:one.covers})
 }
}
module.exports={apply}
