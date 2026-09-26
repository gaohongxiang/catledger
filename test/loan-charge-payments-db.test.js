const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab}=require('./helpers/loan-charges')
test('A3 付款守恒及费用维护',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const h=await chargeLab()
 const get=async loan=>(await h.api('loans.get',{loanId:loan.loanId})).loan
 const selection=(loan,fee,principal='50000',interest='2000')=>({loanId:loan.loanId,version:loan.version,principalMinor:principal,interestMinor:interest,feeMinor:'0',interestTreatment:'accrued',feeTreatment:'expense',chargeAllocations:fee?[{chargeId:fee.chargeId,component:'interest',amountMinor:interest}]:[]})
 const pay=(allocations,extra={})=>h.api('loans.record',{requestId:randomUUID(),mode:'new',kind:'repayment',assetAccountId:h.assetAccountId,occurredLocalAt:'2026-04-30T12:00:00',timezoneOffsetMinutes:-480,totalMinor:'52000',confirmed:true,allocations,...extra})
 async function amounts(){const [[r]]=await h.owner.execute("SELECT COALESCE(SUM(IF(type='expense',amount_minor,IF(type='refund',-CAST(amount_minor AS SIGNED),0))),0) expenses,COALESCE(SUM(IF(source_account_id=?,-CAST(amount_minor AS SIGNED),0)+IF(destination_account_id=?,amount_minor,0)),0) asset FROM catledger_transactions WHERE uid=? AND deleted_at IS NULL",[h.assetAccountId,h.assetAccountId,h.uid]);return {expenses:BigInt(r.expenses),asset:BigInt(r.asset)}}
 try{
  await t.test('L01 已记消费只建方案；现金分期明确从零本金接入，实际到账转账一次',async()=>{
   const before=await amounts()
   const consumption=await h.create();await h.configure(consumption)
   assert.deepEqual(await amounts(),before)
   let cash=await h.create({baselinePrincipalMinor:'0',originKind:'cash_borrowing'})
   await h.configure(cash,{originKind:'cash_borrowing'});cash=await get(cash)
   const payload={requestId:randomUUID(),mode:'new',kind:'drawdown',assetAccountId:h.assetAccountId,occurredLocalAt:'2026-01-01T12:00:00',timezoneOffsetMinutes:-480,totalMinor:'600000',confirmed:true,allocations:[selection(cash,null,'600000','0')]}
   const result=await h.api('loans.record',payload);assert.deepEqual(await h.api('loans.record',payload),result)
   const view=await h.api('loans.payment',{paymentId:result.paymentId});assert.equal(view.transactions[0].type,'transfer');assert.equal((await get(cash)).remainingPrincipalMinor,'600000')
   const after=await amounts();assert.equal(after.asset-before.asset,600000n);assert.equal(after.expenses,before.expenses)
   await assert.rejects(pay([selection(await get(consumption),null,'600000','0')],{kind:'drawdown',totalMinor:'600000'}),{publicCode:'VALIDATION_ERROR'})
  })
  let loan=await h.create();await h.configure(loan);await h.sync(loan);loan=await get(loan)
  const fee=(await h.state(loan)).items.find(c=>c.chargeKey==='period:1:interest')
  let paid
  await t.test('L10 已记20：只转账520，本金减500；无费用依据和再次清偿都拒绝',async()=>{
   const before=await amounts()
   await assert.rejects(pay([selection(loan,null)]),{publicCode:'LOAN_CHARGE_COVERAGE'})
   paid=await pay([selection(loan,fee)])
   const after=await amounts(),view=await h.api('loans.payment',{paymentId:paid.paymentId})
   assert.equal(after.asset-before.asset,-52000n);assert.equal(after.expenses,before.expenses)
   assert.equal(view.transactions.length,1);assert.equal(view.transactions[0].type,'transfer');assert.equal(view.transactions[0].amountMinor,'52000')
   loan=await get(loan);assert.equal(loan.remainingPrincipalMinor,'550000')
   await assert.rejects(pay([selection(loan,fee)]),{publicCode:'LOAN_CHARGE_COVERAGE'})
   const fakeExpense={...selection(loan,null),interestTreatment:'expense',interestCategoryId:h.categoryId}
   await assert.rejects(pay([fakeExpense]),{publicCode:'LOAN_CHARGE_COVERAGE'})
  })
  await t.test('L10 未记20：本金转账500与资产费用20，收费登记阻止后续同步重复',async()=>{
   let other=await h.create();await h.configure(other,{mode:'once',fromDate:'2026-04-01'});other=await get(other)
   const item=(await h.state(other)).items.find(c=>c.chargeKey==='period:4:interest'),before=await amounts()
   const payment=await pay([{...selection(other,item),interestTreatment:'expense',interestCategoryId:h.categoryId}])
   const view=await h.api('loans.payment',{paymentId:payment.paymentId}),after=await amounts()
   assert.deepEqual(view.transactions.map(t=>[t.type,t.amountMinor]).sort(),[['expense','2000'],['transfer','50000']])
   assert.equal(after.asset-before.asset,-52000n);assert.equal(after.expenses-before.expenses,2000n)
   const state=await h.state(other);assert.equal(state.items.find(c=>c.chargeId===item.chargeId).settledMinor,'2000')
   assert.equal((await h.sync(other,{contractId:state.contract.contractId,confirmed:true})).createdCount,0)
   const latest=await get(other)
   await h.api('loans.reverse',{requestId:randomUUID(),paymentId:payment.paymentId,version:1,loans:[{loanId:other.loanId,version:latest.version}],confirmed:true})
   assert.equal((await h.state(other)).items.find(c=>c.chargeId===item.chargeId).state,'suppressed')
   assert.equal((await h.sync(other,{contractId:state.contract.contractId,confirmed:true})).createdCount,0)
  })
  await t.test('L11 整张信用卡付款1200关联两笔分期和普通消费，不新增扣款；一费可分两次清偿',async()=>{
   let second=await h.create();await h.configure(second);await h.sync(second);second=await get(second)
   const charge=(await h.state(second)).items.find(c=>c.chargeKey==='period:1:interest'),before=await amounts()
   const txn=await h.api('transactions.create',{requestId:randomUUID(),type:'transfer',sourceAccountId:h.assetAccountId,destinationAccountId:h.accountId,amountMinor:'120000',occurredLocalAt:'2026-04-30T12:00:00',timezoneOffsetMinutes:-480})
   const source=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source
   const f2=(await h.state(loan)).items.find(c=>c.chargeKey==='period:2:interest')
   const result=await pay([selection(loan,f2),selection(second,charge,'40000','1000')],{mode:'associate',source,totalMinor:'120000',unallocatedMinor:'27000'})
   const view=await h.api('loans.payment',{paymentId:result.paymentId}),after=await amounts()
   assert.equal(view.transactions.length,1);assert.equal(view.transactions[0].transactionId,txn.transactionId);assert.equal(view.unallocatedMinor,'27000')
   assert.equal(after.asset-before.asset,-120000n);assert.equal(after.expenses,before.expenses)
   await assert.rejects(pay([selection(await get(second),charge,'0','1000')],{mode:'associate',source,totalMinor:'120000',unallocatedMinor:'119000'}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
   await pay([selection(await get(second),charge,'0','1000')],{totalMinor:'1000'})
   assert.equal((await h.state(second)).items.find(c=>c.chargeId===charge.chargeId).settledMinor,'2000')
  })
  await t.test('L12/L18 已付费用禁止直接调减/删；实际退款单独冲回，结清仅取消未来',async()=>{
   loan=await get(loan)
   for(const operation of ['adjust','suppress']){
    const input={loanId:loan.loanId,chargeId:fee.chargeId,operation,amountMinor:'1800'}
    const impact=await h.api('loans.chargeImpact',input);assert.equal(impact.canChange,false)
    await assert.rejects(h.api('loans.changeCharge',{...input,requestId:randomUUID(),confirmed:true,previewToken:impact.previewToken}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
   }
   const before=await amounts(),input={loanId:loan.loanId,chargeId:fee.chargeId,operation:'refund',amountMinor:'200',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-04-30T14:00:00',timezoneOffsetMinutes:-480}
   const impact=await h.api('loans.chargeImpact',input);assert.equal(impact.deltaMinor,'-200')
   await h.api('loans.changeCharge',{...input,requestId:randomUUID(),confirmed:true,previewToken:impact.previewToken})
   const after=await amounts();assert.equal(after.asset-before.asset,200n);assert.equal(after.expenses-before.expenses,-200n)
   loan=await get(loan)
   await h.api('loans.endCharges',{requestId:randomUUID(),loanId:loan.loanId,version:loan.version,reason:'settled',confirmed:true})
   const state=await h.state(loan);assert.equal(state.items.filter(c=>c.state==='cancelled').length,8)
   assert.deepEqual(await amounts(),after);assert.equal((await h.sync(loan)).createdCount,0)
  })
 }finally{await h.close()}
})
