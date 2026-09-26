const { randomUUID } = require('node:crypto')
const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { ledgerError } = require('./ledger-errors')
const { encodeCursor } = require('./cursor')
const { digestRequest } = require('./request-digest')
const { parse,amount,today } = require('./loan-charge-domain')
const store = require('./loan-charge-store')
function createLoanChargeMaintenance({getPool,selectLoan,now=Date.now}) {
  async function prepare(c,uid,data,secret) {
    const loan=await selectLoan(c,uid,data.loanId),contract=await store.contract(c,uid,loan.loanId),item=await store.charge(c,uid,data.chargeId)
    if(!contract||item.contractId!==contract.contractId)throw ledgerError('NOT_FOUND')
    if(!['adjust','suppress','restore','pause','cancel','distinct','refund'].includes(data.operation))throw ledgerError('VALIDATION_ERROR')
    let event=null
    if(data.eventId) {
      const [[row]]=await c.execute(`SELECT e.event_id AS eventId,e.update_id AS updateId,e.version,e.field_sources_json AS fields,
        e.ledger_account_id AS accountId,e.amount_minor AS amountMinor,e.event_local_date AS localDate,u.version AS updateVersion,u.status AS updateStatus
        FROM catledger_economic_events e JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id
        WHERE e.uid=? AND e.event_id=?`,[uid,data.eventId])
      if(!row||['posted','undone','abandoned'].includes(row.updateStatus))throw ledgerError('CONFLICT')
      const evidence=(parse(row.fields)||{}).installment
      if(!evidence||row.accountId!==contract.accountId||evidence.referenceKey!==contract.referenceKey||evidence.component!==item.component||evidence.periodNumber!==item.periodNumber)throw ledgerError('LOAN_SOURCE_MISMATCH')
      event={...row,fields:parse(row.fields),amountMinor:String(row.amountMinor),version:Number(row.version),updateVersion:Number(row.updateVersion)}
    }
    const target=['adjust','distinct','refund'].includes(data.operation)?amount(event?event.amountMinor:data.amountMinor):item.amountMinor
    const dependencies=await store.dependencies(c,uid,item)
    let blocked=dependencies.settledMinor!=='0'||dependencies.refundCount>0||dependencies.paymentCount>0||dependencies.sourceCount>0
    if(data.operation==='distinct')blocked=!event
    if(data.operation==='refund')blocked=item.state!=='recorded'||!item.transactionId||item.deletedAt!=null
    if(data.operation==='restore')blocked=blocked||item.state!=='suppressed'
    if(data.operation==='pause')blocked=blocked||item.state!=='planned'
    if(data.operation==='cancel')blocked=blocked||!['planned','paused'].includes(item.state)||item.chargeDate<=today(now())
    if(data.operation==='adjust')blocked=blocked||!['planned','paused','recorded'].includes(item.state)
    let refund=null
    if(data.operation==='refund') {
      const {buildManualTransaction}=require('./transaction-domain')
      refund=buildManualTransaction({type:'refund',amountMinor:target,originalTransactionId:item.transactionId,destinationAccountId:data.destinationAccountId,occurredLocalAt:data.occurredLocalAt,timezoneOffsetMinutes:data.timezoneOffsetMinutes,note:'贷款费用实际退还'})
      refund.categoryId=item.categoryId
      if(refund.localDate<item.chargeDate||refund.localDate>today(now()))throw ledgerError('VALIDATION_ERROR')
      const [[total]]=await c.execute('SELECT COALESCE(SUM(amount_minor),0) AS amount FROM catledger_transactions WHERE uid=? AND original_transaction_id=? AND deleted_at IS NULL',[uid,item.transactionId])
      if(BigInt(total.amount)+BigInt(target)>BigInt(item.amountMinor))blocked=true
    }
    const payload={refund,loanId:loan.loanId,version:Number(loan.version),contractVersion:contract.version,chargeId:item.chargeId,chargeVersion:item.version,
      transactionVersion:item.transactionVersion,operation:data.operation,target,event,dependencies}
    const previewToken=encodeCursor(secret,{action:'loans.changeCharge',uid,digest:digestRequest('charge-impact',payload)})
    return {loan,contract,item,event,target,refund,impact:{chargeId:item.chargeId,operation:data.operation,loanVersion:Number(loan.version),chargeVersion:item.version,
      oldAmountMinor:item.amountMinor,amountMinor:target,deltaMinor:data.operation==='refund'?'-'+target:data.operation==='suppress'&&item.state==='recorded'?'-'+item.amountMinor:
        data.operation==='adjust'&&item.state==='recorded'?String(BigInt(target)-BigInt(item.amountMinor)):'0',
      nextPostingMinor:data.operation==='distinct'?target:'0',
      chargeDate:item.chargeDate,dependencies,canChange:!blocked,previewToken}}
  }
  async function chargeImpact(context) {
    return executeLedgerRead({getPool,...context,consistentSnapshot:true,operation:async(c,uid)=>(await prepare(c,uid,context.data,context.subjectHash)).impact})
  }
  async function changeCharge(context) {
    return executeIdempotentMutation({getPool,...context,action:'loans.changeCharge',operation:async(c,uid,data)=>{
      const {loan,contract,item,event,target,refund,impact}=await prepare(c,uid,data,context.subjectHash)
      if(data.confirmed!==true||data.previewToken!==impact.previewToken)throw ledgerError('CONFLICT')
      if(!impact.canChange)throw ledgerError('LOAN_TRANSACTION_LOCKED')
      const operation=data.operation
      let chargeId=item.chargeId,refundId=null
      if(operation==='refund') {
        const {lockAccounts,insertManualTransaction}=require('./transaction-command-service')
        const accounts=await lockAccounts(c,uid,[refund.destinationAccountId])
        const account=accounts.get(refund.destinationAccountId)
        if(!account||!['cash','bank','wallet','other_asset'].includes(account.type)&&refund.destinationAccountId!==contract.accountId)throw ledgerError('VALIDATION_ERROR')
        refundId=randomUUID();await insertManualTransaction(c,uid,refundId,refund)
      } else if(operation==='distinct') {
        chargeId=randomUUID()
        await c.execute(`INSERT INTO catledger_loan_charges(uid,charge_id,contract_id,charge_key,component,period_number,charge_date,amount_minor,category_id,plan_version)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,[uid,chargeId,contract.contractId,'additional:'+event.eventId,item.component,item.periodNumber,event.localDate,target,item.categoryId,contract.planVersion])
      } else if(operation==='adjust') {
        if(item.transactionId)await c.execute('UPDATE catledger_transactions SET amount_minor=?,version=version+1 WHERE uid=? AND transaction_id=? AND deleted_at IS NULL',[target,uid,item.transactionId])
        await c.execute("UPDATE catledger_loan_charges SET amount_minor=?,basis='manual',version=version+1 WHERE uid=? AND charge_id=?",[target,uid,item.chargeId])
      } else {
        const state={suppress:'suppressed',restore:'planned',pause:'paused',cancel:'cancelled'}[operation]
        if(operation==='suppress'&&item.transactionId)await c.execute('UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3),version=version+1 WHERE uid=? AND transaction_id=?',[uid,item.transactionId])
        await c.execute('UPDATE catledger_loan_charges SET state=?,version=version+1'+(operation==='restore'?',transaction_id=NULL':'')+' WHERE uid=? AND charge_id=?',[state,uid,item.chargeId])
      }
      if(event) {
        await c.execute('UPDATE catledger_economic_events SET field_sources_json=?,version=version+1 WHERE uid=? AND event_id=?',[
          JSON.stringify({...event.fields,loanCharge:{chargeId,confirmed:true}}),uid,event.eventId])
        await c.execute('UPDATE catledger_finance_updates SET version=version+1 WHERE uid=? AND update_id=?',[uid,event.updateId])
      }
      await store.audit(c,uid,contract.contractId,chargeId,operation,{before:item,afterAmountMinor:target,eventId:event&&event.eventId,refundId,dependencies:impact.dependencies})
      await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1,chargeId,refundId,deltaMinor:impact.deltaMinor,eventId:event&&event.eventId,updateVersion:event?event.updateVersion+1:null}
    }})
  }
  async function endCharges(context) {
    return executeIdempotentMutation({getPool,...context,action:'loans.endCharges',operation:async(c,uid,data)=>{
      const loan=await selectLoan(c,uid,data.loanId),contract=await store.contract(c,uid,loan.loanId)
      if(!contract||Number(loan.version)!==data.version||data.confirmed!==true)throw ledgerError('CONFLICT')
      if(!['settled','rate_changed','waiver','contract_cancelled'].includes(data.reason))throw ledgerError('VALIDATION_ERROR')
      await c.execute("UPDATE catledger_loan_charges SET state=?,version=version+1 WHERE uid=? AND contract_id=? AND state IN ('planned','paused') AND charge_date>?",
        [data.reason==='rate_changed'?'paused':'cancelled',uid,contract.contractId,today(now())])
      await c.execute('UPDATE catledger_loan_charge_contracts SET authorization_json=?,version=version+1 WHERE uid=? AND contract_id=?',[
        JSON.stringify({...contract.authorization,mode:'paused',stopReason:data.reason}),uid,contract.contractId])
      await store.audit(c,uid,contract.contractId,null,'end',{reason:data.reason,authorization:contract.authorization,cutoff:today(now())})
      await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1}
    }})
  }
  return {chargeImpact,changeCharge,endCharges}
}
module.exports={createLoanChargeMaintenance}
