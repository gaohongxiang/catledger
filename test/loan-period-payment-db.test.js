const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab}=require('./helpers/loan-charges')
test('逐期还款一次提交：资金、费用清偿和真实期次关联原子一致',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const h=await chargeLab()
 const balance=async()=>Object.fromEntries((await h.api('accounts.list')).accounts.map(a=>[a.accountId,a.bookBalanceMinor]))
 try{
  const loan=await h.create();await h.configure(loan);await h.sync(loan)
  async function input(term,principal='50000',interest='2000'){
   const view=await h.api('loans.installment',{loanId:loan.loanId,periodNumber:term})
   const fee=(await h.state(loan)).items.find(c=>c.chargeKey==='period:'+term+':interest')
   return {requestId:randomUUID(),mode:'new',kind:'repayment',assetAccountId:h.assetAccountId,totalMinor:String(BigInt(principal)+BigInt(interest)),occurredLocalAt:'2026-04-30T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
    allocations:[{loanId:loan.loanId,version:view.loanVersion,period:{periodNumber:term,version:view.period.periodId?view.period.version:0},principalMinor:principal,interestMinor:interest,feeMinor:'0',interestTreatment:'accrued',feeTreatment:'expense',chargeAllocations:interest==='0'?[]:[{chargeId:fee.chargeId,component:'interest',amountMinor:interest}]}]}
  }
  await t.test('L09/L10 还第二期520只扣一次、费用不重记、只第二期实际已还；原键重放不再次分配',async()=>{
   const before=await balance(),payload=await input(2),result=await h.api('loans.record',payload)
   assert.deepEqual(await h.api('loans.record',payload),result)
   const after=await balance(),view=await h.api('loans.installments',{loanId:loan.loanId})
   assert.equal(BigInt(after[h.assetAccountId])-BigInt(before[h.assetAccountId]),-52000n)
   assert.equal((await h.state(loan)).recordedMinor,'8000')
   assert.equal(view.summary.actualPaidPeriods,1);assert.equal(view.summary.manualPaidPeriods,0);assert.equal(view.summary.completedThrough,0)
   assert.deepEqual(view.items.filter(p=>p.paymentConfirmed).map(p=>p.periodNumber),[2])
   const allocation=await h.api('loans.planAllocation',{loanId:loan.loanId,paymentId:result.paymentId})
   assert.equal(allocation.items.length,1);assert.equal(allocation.unallocated.principalMinor,'0');assert.equal(allocation.unallocated.interestMinor,'0')
  })
  await t.test('L08/L11 部分还款保留剩余；两请求并发仅一笔，其他期费用不能冒充本期',async()=>{
   const payload=await input(3,'25000','1000'),before=await balance()
   const wrong=structuredClone(payload);wrong.allocations[0].period.periodNumber=4
   await assert.rejects(h.api('loans.record',wrong),{publicCode:'LOAN_CHARGE_COVERAGE'})
   assert.deepEqual(await balance(),before)
   const results=await Promise.allSettled([h.api('loans.record',payload),h.api('loans.record',{...payload,requestId:randomUUID()})])
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
   const view=await h.api('loans.installment',{loanId:loan.loanId,periodNumber:3})
   assert.equal(view.period.paidPrincipalMinor,'25000');assert.equal(view.period.paidInterestMinor,'1000');assert.equal(view.period.paymentConfirmed,false)
   await assert.rejects(h.api('loans.record',await input(3,'25001','1000')),{publicCode:'LOAN_PLAN_OVERALLOCATED'})
  })
  await t.test('L08 期次关联写失败回滚已生成交易/清偿/版本；同一原键重试后可整组撤销',async()=>{
   const payload=await input(4),before=await balance(),fees=await h.state(loan),original=h.apiPool.getConnection.bind(h.apiPool)
   let failed=false
   h.apiPool.getConnection=async()=>{const c=await original();return new Proxy(c,{get(target,key){if(key==='execute')return async(sql,args)=>{if(sql.includes('INSERT INTO catledger_loan_period_allocations')){failed=true;throw new Error('synthetic period link failure')};return target.execute(sql,args)};const value=target[key];return typeof value==='function'?value.bind(target):value}})}
   try{await assert.rejects(h.api('loans.record',payload),{publicCode:'INTERNAL_ERROR'})}finally{h.apiPool.getConnection=original}
   assert.equal(failed,true);assert.deepEqual(await balance(),before);assert.deepEqual((await h.state(loan)).items,fees.items)
   assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.version,payload.allocations[0].version)
   const result=await h.api('loans.record',payload)
   assert.equal((await h.api('loans.installment',{loanId:loan.loanId,periodNumber:4})).period.paymentConfirmed,true)
   await h.api('loans.reverse',{requestId:randomUUID(),paymentId:result.paymentId,version:1,loans:result.loans,confirmed:true})
   assert.deepEqual(await balance(),before);assert.equal((await h.api('loans.installment',{loanId:loan.loanId,periodNumber:4})).period.paymentConfirmed,false)
  })
  await t.test('派生期次只在确认付款时保存快照；不预先生成付款或修改别期',async()=>{
   const other=await h.create({generatePlan:undefined,installmentSetup:undefined})
   const period=await h.api('loans.installment',{loanId:other.loanId,periodNumber:8})
   assert.equal(period.period.periodId,undefined)
   const payload={requestId:randomUUID(),mode:'new',kind:'repayment',assetAccountId:h.assetAccountId,totalMinor:'25000',occurredLocalAt:'2026-04-30T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
    allocations:[{loanId:other.loanId,version:other.version,period:{periodNumber:8,version:0},principalMinor:'25000',interestMinor:'0',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense'}]}
   await h.api('loans.record',payload)
   const view=await h.api('loans.periods',{loanId:other.loanId});assert.equal(view.items.length,1);assert.equal(view.items[0].periodNumber,8);assert.equal(view.items[0].paidPrincipalMinor,'25000')
  })
  await t.test('L10/L11 本期关联已有520转账只绑定期次，不再扣款；完整本息费仍须一致',async()=>{
   const transaction=await h.api('transactions.create',{requestId:randomUUID(),type:'transfer',sourceAccountId:h.assetAccountId,destinationAccountId:h.accountId,amountMinor:'52000',occurredLocalAt:'2026-04-30T12:00:00',timezoneOffsetMinutes:-480})
   const source=(await h.api('loans.source',{transactionIds:[transaction.transactionId]})).source,before=await balance(),payload=await input(1)
   const result=await h.api('loans.record',{...payload,mode:'associate',source})
   assert.deepEqual(await balance(),before)
   const payment=await h.api('loans.payment',{paymentId:result.paymentId})
   assert.equal(payment.transactions.length,1);assert.equal(payment.transactions[0].transactionId,transaction.transactionId)
   assert.equal((await h.api('loans.installment',{loanId:loan.loanId,periodNumber:1})).period.paymentConfirmed,true)
  })
 }finally{await h.close()}
})
