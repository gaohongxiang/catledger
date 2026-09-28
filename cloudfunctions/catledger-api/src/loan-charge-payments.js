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
  const items=require('./installment-items')
  const [raw]=await c.execute(items.ITEM_SELECT+' WHERE i.uid=? AND i.loan_id=? AND i.transaction_id=? AND i.component=? AND i.active=1 AND i.canonical=1 LIMIT 2',[uid,loan.loanId,input.transactionId,input.component])
  const evidence=raw.map(items.publicItem).filter(i=>i.active)
  if(evidence.length>1)fail('LOAN_CHARGE_COVERAGE')
  const source=evidence[0]
  let contract=await store.contract(c,uid,loan.loanId)
  if(!contract) {
    contract={contractId:randomUUID(),loanId:loan.loanId,accountId:loan.accountId}
    await c.execute(`INSERT INTO catledger_loan_charge_contracts(uid,contract_id,loan_id,account_id,reference_key,origin_kind,authorization_json)
      VALUES(?,?,?,?,?,'historical',?)`,[uid,contract.contractId,loan.loanId,loan.accountId,source&&source.referenceKey||null,JSON.stringify({schema:1,mode:'paused',coverageOnly:true})])
  }
  const key=source?'period:'+source.periodNumber+':'+input.component:'actual:'+input.transactionId
  const [[planned]]=await c.execute('SELECT charge_id AS chargeId,state,amount_minor AS amountMinor FROM catledger_loan_charges WHERE uid=? AND contract_id=? AND charge_key=?',[uid,contract.contractId,key])
  if(planned){
    if(planned.state!=='planned'||String(planned.amountMinor)!==String(transaction.amountMinor))fail('LOAN_CHARGE_COVERAGE')
    await c.execute("UPDATE catledger_loan_charges SET state='recorded',basis='actual',transaction_id=?,version=version+1 WHERE uid=? AND charge_id=?",[input.transactionId,uid,planned.chargeId])
    if(source)await c.execute('INSERT INTO catledger_loan_charge_sources(uid,charge_id,item_id) VALUES(?,?,?)',[uid,planned.chargeId,source.itemId])
    await store.audit(c,uid,contract.contractId,planned.chargeId,'claim_payment_coverage',{transactionId:input.transactionId,component:input.component})
    return store.charge(c,uid,planned.chargeId)
  }
  const chargeId=randomUUID()
  await c.execute(`INSERT INTO catledger_loan_charges(uid,charge_id,contract_id,charge_key,component,period_number,charge_date,amount_minor,category_id,state,basis,transaction_id)
    VALUES(?,?,?,?,?,?,?,?,?,'recorded','actual',?)`,[uid,chargeId,contract.contractId,key,input.component,source?source.periodNumber:null,transaction.localDate,String(transaction.amountMinor),transaction.categoryId,input.transactionId])
  if(source)await c.execute('INSERT INTO catledger_loan_charge_sources(uid,charge_id,item_id) VALUES(?,?,?)',[uid,chargeId,source.itemId])
  await store.audit(c,uid,contract.contractId,chargeId,'claim_payment_coverage',{transactionId:input.transactionId,component:input.component})
  return store.charge(c,uid,chargeId)
}
async function validate(c,uid,loan,input,{excludePaymentId=null,paymentDate=null,replaceHistorical=false,retainedCoverage={},retainedExpenses={}}={}) {
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
    const reusedExpense=treatment==='expense'&&item.state==='recorded'&&item.deletedAt==null&&retainedExpenses[item.chargeId]===item.transactionId
    if(treatment==='expense' && (item.state!=='planned'&&!reusedExpense||entry.amountMinor!==item.amountMinor||input[item.component+'CategoryId']!==item.categoryId))fail('LOAN_CHARGE_COVERAGE')
    let used=BigInt(item.settledMinor), historical=BigInt(item.historicalCoveredMinor)
    if(reusedExpense){
      const [[other]]=await c.execute("SELECT a.payment_id FROM catledger_loan_charge_allocations a JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id AND p.status='active' WHERE a.uid=? AND a.charge_id=? LIMIT 1",[uid,item.chargeId])
      if(other||item.directlyPaidMinor!==entry.amountMinor)fail('LOAN_CHARGE_COVERAGE')
      used=0n
    }
    if(excludePaymentId) {
      const [[prior]]=await c.execute('SELECT amount_minor AS amountMinor,historical_replaced_minor AS historicalReplacedMinor FROM catledger_loan_charge_allocations WHERE uid=? AND payment_id=? AND charge_id=?',[uid,excludePaymentId,item.chargeId])
      if(prior){used-=BigInt(prior.amountMinor);historical+=BigInt(prior.historicalReplacedMinor)}
    }
    const [[refund]]=await c.execute('SELECT COALESCE(SUM(amount_minor),0) AS amount FROM catledger_transactions WHERE uid=? AND original_transaction_id=? AND deleted_at IS NULL',[uid,item.transactionId])
    const available=BigInt(item.amountMinor)-BigInt(refund.amount)-used
    historical=historical>available?available:historical
    const limit=replaceHistorical?historical:BigInt(retainedCoverage[item.chargeId]||'0')
    const replaced=[historical,BigInt(entry.amountMinor),limit].reduce((a,b)=>a<b?a:b)
    if(used+BigInt(entry.amountMinor)+BigInt(refund.amount)+historical-replaced>BigInt(item.amountMinor))fail('LOAN_CHARGE_COVERAGE')
    sums[item.component]+=BigInt(entry.amountMinor);items.push({chargeId:item.chargeId,contractId:item.contractId,loanId:loan.loanId,component:item.component,treatment,reusedExpense,amountMinor:entry.amountMinor,historicalReplacedMinor:String(replaced)})
  }
  for(const component of ['interest','fee']) {
    const required=input[component+'Treatment']==='accrued'||contract&&!contract.authorization.coverageOnly||sums[component]>0n
    if(required && sums[component]!==BigInt(input[component+'Minor']))fail('LOAN_CHARGE_COVERAGE')
  }
  return items
}
async function persist(c,uid,paymentId,items,transactions=[]) {
  for(const item of items) {
    if(item.treatment==='expense'&&!item.reusedExpense) {
      const transaction=transactions.find(t=>t.chargeId===item.chargeId)
      if(!transaction)fail('LOAN_CHARGE_COVERAGE')
      await c.execute("UPDATE catledger_loan_charges SET state='recorded',basis='actual',transaction_id=?,version=version+1 WHERE uid=? AND charge_id=? AND state='planned'",[transaction.transactionId,uid,item.chargeId])
      await store.audit(c,uid,item.contractId,item.chargeId,'paid_expense',{paymentId,transactionId:transaction.transactionId})
    }
    await c.execute('INSERT INTO catledger_loan_charge_allocations(uid,payment_id,charge_id,amount_minor,historical_replaced_minor) VALUES(?,?,?,?,?)',[uid,paymentId,item.chargeId,item.amountMinor,item.historicalReplacedMinor||'0'])
    await store.audit(c,uid,item.contractId,item.chargeId,'settle',{paymentId,amountMinor:item.amountMinor,historicalReplacedMinor:item.historicalReplacedMinor||'0'})
  }
}
module.exports={normalizeCoverage,validate,persist}
