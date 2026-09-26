const { randomUUID } = require('node:crypto')
const store = require('./loan-charge-store')
const { amount } = require('./loan-charge-domain')
const fail = code => { throw Object.assign(new Error(code),{publicCode:code}) }
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
async function claimExisting(c,uid,loan,input) {
  const [[transaction]]=await c.execute(`SELECT transaction_id AS transactionId,type,source_account_id AS accountId,
    amount_minor AS amountMinor,category_id AS categoryId,occurred_local_date AS localDate,deleted_at AS deletedAt
    FROM catledger_transactions WHERE uid=? AND transaction_id=?`,[uid,input.transactionId])
  if(!transaction||transaction.type!=='expense'||transaction.deletedAt!=null||transaction.accountId!==loan.accountId)fail('LOAN_CHARGE_COVERAGE')
  const [[existing]]=await c.execute('SELECT charge_id AS chargeId FROM catledger_loan_charges WHERE uid=? AND transaction_id=?',[uid,input.transactionId])
  if(existing)return store.charge(c,uid,existing.chargeId)
  let contract=await store.contract(c,uid,loan.loanId)
  if(!contract) {
    contract={contractId:randomUUID(),loanId:loan.loanId,accountId:loan.accountId}
    await c.execute(`INSERT INTO catledger_loan_charge_contracts(uid,contract_id,loan_id,account_id,origin_kind,authorization_json)
      VALUES(?,?,?,?,'historical',?)`,[uid,contract.contractId,loan.loanId,loan.accountId,JSON.stringify({schema:1,mode:'paused',coverageOnly:true})])
  }
  const chargeId=randomUUID()
  await c.execute(`INSERT INTO catledger_loan_charges(uid,charge_id,contract_id,charge_key,component,charge_date,amount_minor,category_id,state,basis,transaction_id)
    VALUES(?,?,?,?,?,?,?,?,'recorded','actual',?)`,[uid,chargeId,contract.contractId,'actual:'+input.transactionId,input.component,transaction.localDate,String(transaction.amountMinor),transaction.categoryId,input.transactionId])
  await store.audit(c,uid,contract.contractId,chargeId,'claim_payment_coverage',{transactionId:input.transactionId,component:input.component})
  return store.charge(c,uid,chargeId)
}
async function validate(c,uid,loan,input,{excludePaymentId=null,paymentDate=null}={}) {
  const selection=normalizeCoverage(input.chargeAllocations),items=[],seen=new Set(),sums={interest:0n,fee:0n}
  let contract=await store.contract(c,uid,loan.loanId)
  for(const entry of selection) {
    const item=entry.chargeId?await store.charge(c,uid,entry.chargeId):await claimExisting(c,uid,loan,entry)
    contract=contract||await store.contract(c,uid,loan.loanId)
    const treatment=input[item.component+'Treatment']
    if(!contract||contract.contractId!==item.contractId||item.component!==entry.component||seen.has(item.chargeId))fail('LOAN_CHARGE_COVERAGE')
    seen.add(item.chargeId)
    if(paymentDate&&item.chargeDate>paymentDate)fail('LOAN_CHARGE_COVERAGE')
    if(treatment==='accrued' && (!['recorded','baseline'].includes(item.state)||item.state==='recorded'&&(item.deletedAt!=null||item.transactionAmount!=item.amountMinor)))fail('LOAN_CHARGE_COVERAGE')
    if(treatment==='expense' && (item.state!=='planned'||entry.amountMinor!==item.amountMinor||input[item.component+'CategoryId']!==item.categoryId))fail('LOAN_CHARGE_COVERAGE')
    let used=BigInt(item.settledMinor)
    if(excludePaymentId) {
      const [[prior]]=await c.execute('SELECT amount_minor AS amountMinor FROM catledger_loan_charge_allocations WHERE uid=? AND payment_id=? AND charge_id=?',[uid,excludePaymentId,item.chargeId])
      if(prior)used-=BigInt(prior.amountMinor)
    }
    const [[refund]]=await c.execute('SELECT COALESCE(SUM(amount_minor),0) AS amount FROM catledger_transactions WHERE uid=? AND original_transaction_id=? AND deleted_at IS NULL',[uid,item.transactionId])
    if(used+BigInt(entry.amountMinor)+BigInt(refund.amount)>BigInt(item.amountMinor))fail('LOAN_CHARGE_COVERAGE')
    sums[item.component]+=BigInt(entry.amountMinor);items.push({chargeId:item.chargeId,contractId:item.contractId,loanId:loan.loanId,component:item.component,treatment,amountMinor:entry.amountMinor})
  }
  for(const component of ['interest','fee']) {
    const required=input[component+'Treatment']==='accrued'||contract&&!contract.authorization.coverageOnly||sums[component]>0n
    if(required && sums[component]!==BigInt(input[component+'Minor']))fail('LOAN_CHARGE_COVERAGE')
  }
  return items
}
async function persist(c,uid,paymentId,items,transactions=[]) {
  for(const item of items) {
    if(item.treatment==='expense') {
      const transaction=transactions.find(t=>t.chargeId===item.chargeId)
      if(!transaction)fail('LOAN_CHARGE_COVERAGE')
      await c.execute("UPDATE catledger_loan_charges SET state='recorded',basis='actual',transaction_id=?,version=version+1 WHERE uid=? AND charge_id=? AND state='planned'",[transaction.transactionId,uid,item.chargeId])
      await store.audit(c,uid,item.contractId,item.chargeId,'paid_expense',{paymentId,transactionId:transaction.transactionId})
    }
    await c.execute('INSERT INTO catledger_loan_charge_allocations(uid,payment_id,charge_id,amount_minor) VALUES(?,?,?,?)',[uid,paymentId,item.chargeId,item.amountMinor])
    await store.audit(c,uid,item.contractId,item.chargeId,'settle',{paymentId,amountMinor:item.amountMinor})
  }
}
module.exports={normalizeCoverage,validate,persist}
