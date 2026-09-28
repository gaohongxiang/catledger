const {randomUUID}=require('node:crypto')
const {executeIdempotentMutation}=require('./ledger-transaction')
const {ledgerError}=require('./ledger-errors')
const {parseVersion,buildManualTransaction}=require('./transaction-domain')
const {lockAccounts,validateCategory,insertManualTransaction,selectTransaction}=require('./transaction-command-service')
const {assertNoLoanTransactions}=require('./loan-transaction-guard')
const store=require('./loan-charge-store')
const domain=require('./loan-charge-domain')

function createUpfrontFeeService({getPool,selectLoan,now=Date.now}){
 async function recordUpfrontFee(context){
  return executeIdempotentMutation({getPool,...context,currentReads:true,action:'loans.recordUpfrontFee',operation:async(c,uid,data)=>{
   const loan=await selectLoan(c,uid,data.loanId,true)
   if(Number(loan.version)!==parseVersion(data.version))throw ledgerError('CONFLICT')
   if(data.confirmed!==true||loan.archivedAt!=null||loan.kind!=='installment'||BigInt(loan.feeUpfrontMinor||'0')<=0n||!['new','existing'].includes(data.mode))throw ledgerError('VALIDATION_ERROR')
   let transaction
   if(data.mode==='existing'){
    transaction=await selectTransaction(c,uid,data.transactionId,{forUpdate:true})
    if(transaction.deletedAt!=null||transaction.type!=='expense')throw ledgerError('LOAN_SOURCE_MISMATCH')
    if(Number(transaction.version)!==parseVersion(data.transactionVersion))throw ledgerError('CONFLICT')
    await assertNoLoanTransactions(c,uid,[transaction.transactionId])
   }else{
    transaction=buildManualTransaction({type:'expense',sourceAccountId:data.accountId,amountMinor:domain.amount(data.amountMinor),categoryId:data.categoryId,
     occurredLocalAt:data.occurredLocalAt,timezoneOffsetMinutes:data.timezoneOffsetMinutes,note:loan.name+' 一次性手续费'})
    await validateCategory(c,uid,transaction.categoryId,'expense')
   }
   const date=String(transaction.localDate||transaction.occurredLocalAt).slice(0,10)
   if(date>domain.today(now()))throw ledgerError('VALIDATION_ERROR')
   const accounts=await lockAccounts(c,uid,[loan.accountId,transaction.sourceAccountId]),account=accounts.get(transaction.sourceAccountId)
   if(!account||!['cash','bank','wallet','other_asset'].includes(account.type)&&transaction.sourceAccountId!==loan.accountId)throw ledgerError('LOAN_SOURCE_MISMATCH')
   const state=await require('./installment-repayment').context(c,uid,loan),contract=state.contract
   let fee=state.charges.find(i=>i.chargeKey==='upfront:fee')
   if(fee&&!['planned'].includes(fee.state))throw ledgerError('LOAN_TRANSACTION_LOCKED')
   if(fee&&fee.amountMinor!==String(transaction.amountMinor))throw ledgerError('LOAN_CHARGE_DIFFERENCE')
   const covers=data.covers||[]
   if(!Array.isArray(covers)||covers.length>600||new Set(covers).size!==covers.length||covers.some(n=>!Number.isInteger(n)||n<1||n>Number(loan.scheduleTerms)))throw ledgerError('VALIDATION_ERROR')
   const covered=state.rows.filter(row=>covers.includes(row.periodNumber))
   if(covers.length&&(covered.length!==covers.length||covered.some(r=>r.cancelled||BigInt(r.feeMinor)<=0n)||covered.reduce((sum,r)=>sum+BigInt(r.feeMinor),0n)!==BigInt(transaction.amountMinor)))throw ledgerError('LOAN_CHARGE_COVERAGE')
   if(!fee){
    const chargeId=await require('./loan-charge-service').insertCharge(c,uid,contract.contractId,{chargeKey:'upfront:fee',component:'fee',periodNumber:null,chargeDate:date,amountMinor:String(transaction.amountMinor),categoryId:transaction.categoryId},1)
    fee={chargeId}
   }
   if(data.mode==='new'){
    await require('./cash-balance-guard').assertCashBalanceChanges(c,uid,accounts,[{transaction}])
    const transactionId=randomUUID();await insertManualTransaction(c,uid,transactionId,{...transaction,creationProvenance:{kind:'loan',loanIds:[loan.loanId]}})
    transaction={...transaction,transactionId,version:1}
   }
   await c.execute("UPDATE catledger_loan_charges SET state='recorded',basis='actual',transaction_id=?,charge_date=?,category_id=?,version=version+1 WHERE uid=? AND charge_id=?",[transaction.transactionId,date,transaction.categoryId,uid,fee.chargeId])
   for(const row of covered){
    const key='period:'+row.periodNumber+':fee'
    let child=state.charges.find(i=>i.chargeKey===key)
    if(child&&child.state!=='planned')throw ledgerError('LOAN_CHARGE_COVERAGE')
    if(child&&child.amountMinor!==String(row.feeMinor))throw ledgerError('LOAN_CHARGE_DIFFERENCE')
    if(!child)child={chargeId:await require('./loan-charge-service').insertCharge(c,uid,contract.contractId,{chargeKey:key,component:'fee',periodNumber:row.periodNumber,chargeDate:row.dueDate,amountMinor:String(row.feeMinor),categoryId:transaction.categoryId},1)}
    await c.execute("UPDATE catledger_loan_charges SET state='covered',covered_by_charge_id=?,version=version+1 WHERE uid=? AND charge_id=?",[fee.chargeId,uid,child.chargeId])
   }
   await store.audit(c,uid,contract.contractId,fee.chargeId,'record_upfront_fee',{mode:data.mode,transactionId:transaction.transactionId,transactionVersion:Number(transaction.version),accountId:transaction.sourceAccountId,date,amountMinor:String(transaction.amountMinor),covers})
   await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
   return {loanId:loan.loanId,version:Number(loan.version)+1,chargeId:fee.chargeId,transactionId:transaction.transactionId}
  }})
 }
 return {recordUpfrontFee}
}
module.exports={createUpfrontFeeService}
