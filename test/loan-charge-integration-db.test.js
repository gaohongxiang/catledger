const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab,prepareBank,postBank}=require('./helpers/loan-charges')
const {localServices,call}=require('./helpers/local-services')
const {createLoanChargeSync}=require('../cloudfunctions/catledger-api/src/loan-charge-sync')
test('A5 集成闭环：历史、范围、暂停、撤销重放、原子依赖与回退开关',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const h=await chargeLab()
 const live=async loan=>(await h.api('loans.get',{loanId:loan.loanId})).loan
 const change=async(loan,item,operation,extra={})=>{
  const input={loanId:loan.loanId,chargeId:item.chargeId,operation,...extra},impact=await h.api('loans.chargeImpact',input)
  return h.api('loans.changeCharge',{...input,requestId:randomUUID(),confirmed:true,previewToken:impact.previewToken})
 }
 try{
  await t.test('L14 期初已含费用遇后到同费，只登记账单证据；不增加历史欠款或已还',async()=>{
   const loan=await h.create();await h.configure(loan,{referenceLabel:'SYNTHETIC-BASELINE',fromDate:'2026-04-01',baselineCoveredThrough:'2026-03-31',historyChoice:'continue'})
   const update=await prepareBank(h,{reference:'SYNTHETIC-BASELINE'}),post=await postBank(h,update)
   const view=await h.state(loan),fee=view.items.find(i=>i.chargeKey==='period:2:interest')
   assert.equal(fee.state,'baseline');assert.equal(fee.transactionId,null);assert.equal(view.recordedMinor,'0')
   const source=await h.api('loans.installment',{loanId:loan.loanId,periodNumber:2})
   assert.equal(source.sources.length,1);assert.equal(source.sources[0].active,true);assert.equal(source.period.complete,false)
   const [[total]]=await h.owner.execute("SELECT COUNT(*) n FROM catledger_transactions WHERE uid=? AND type='expense'",[h.uid]);assert.equal(Number(total.n),0)
   await assert.rejects(change(loan,fee,'suppress'),{publicCode:'LOAN_TRANSACTION_LOCKED'})
   const impact=await h.imp('financeUpdates.undoImpact',{updateId:update.updateId})
   await h.imp('financeUpdates.undo',{requestId:randomUUID(),updateId:update.updateId,version:post.appliedVersion,previewToken:impact.previewToken})
   assert.equal((await h.state(loan)).items.find(i=>i.chargeId===fee.chargeId).state,'baseline')
   assert.equal((await h.sync(loan)).createdCount,1)
  })
  await t.test('L07 合同一次性手续费独立确认计费日，只记一次；后续版本不复记',async()=>{
   const loan=await h.create({feeUpfrontMinor:'24000'})
   await assert.rejects(h.configure(loan),{publicCode:'VALIDATION_ERROR'})
   const config=await h.configure(loan,{upfrontChargeDate:'2026-01-15'})
   const result=await h.sync(loan);assert.equal(result.createdCount,5);assert.equal(result.amountMinor,'32000')
   let view=await h.state(loan);const upfront=view.items.find(c=>c.chargeKey==='upfront:fee');assert.equal(upfront.chargeDate,'2026-01-15');assert.equal(upfront.amountMinor,'24000')
   await h.configure(await live(loan),{upfrontChargeDate:'2026-01-15'})
   assert.equal((await h.sync(loan)).createdCount,0);view=await h.state(loan);assert.equal(view.items.find(c=>c.chargeKey==='upfront:fee').chargeId,upfront.chargeId);assert.equal(view.contract.contractId,config.contractId)
  })
  await t.test('L03/L17 一次确认只同步指定合同；跨用户贷款/合同与伪造截止日被拒绝',async()=>{
   const auto=await h.create();await h.configure(auto)
   const once=await h.create(),configured=await h.configure(once,{mode:'once',throughDate:'2026-04-30'})
   const result=await h.api('loans.syncCharges',{requestId:randomUUID(),confirmed:true,contractId:configured.contractId})
   assert.equal(result.createdCount,4);assert.equal((await h.state(auto)).recordedMinor,'0')
   const other=localServices({apiPool:h.apiPool,importPool:h.importPool,subject:'synthetic-foreign-'+randomUUID()});await call(other.api,'bootstrap')
   for(const action of ['loans.dueCharges','loans.syncCharges'])for(const scope of [{loanId:once.loanId},{contractId:configured.contractId,confirmed:true}])
    await assert.rejects(call(other.api,action,{...scope,...(action==='loans.syncCharges'?{requestId:randomUUID()}:{})}),{publicCode:'NOT_FOUND'})
   await assert.rejects(h.sync(once,{uid:h.uid}),{publicCode:'INVALID_REQUEST'})
  })
  await t.test('L12 期次调整先暂停；重新授权采用已确认分项，不覆盖已记历史',async()=>{
   let loan=await h.create();await h.configure(loan);await h.sync(loan);loan=await live(loan)
   const plan=await h.api('loans.periods',{loanId:loan.loanId}),period=plan.items.find(p=>p.periodNumber===5)
   await h.api('loans.savePeriod',{requestId:randomUUID(),loanId:loan.loanId,loanVersion:loan.version,periodId:period.periodId,version:period.version,periodNumber:5,dueDate:period.dueDate,principalMinor:period.principalMinor,interestMinor:'1800',feeMinor:'0',cancelled:false})
   assert.equal((await h.state(loan)).items.find(c=>c.periodNumber===5).state,'paused')
   await h.configure(await live(loan));h.setNow('2026-05-31T12:00:00Z')
   const synced=await h.sync(loan);assert.equal(synced.createdCount,1);assert.equal(synced.amountMinor,'1800')
   const view=await h.state(loan);assert.equal(view.items.find(c=>c.periodNumber===1).amountMinor,'2000')
   h.setNow('2026-04-30T12:00:00Z')
  })
  await t.test('L13 删除抑制、明确恢复和旧请求重放：旧请求不能再删除新费用',async()=>{
   const loan=await h.create();await h.configure(loan,{throughDate:'2026-01-31'});await h.sync(loan)
   let fee=(await h.state(loan)).items[0],input={loanId:loan.loanId,chargeId:fee.chargeId,operation:'suppress'}
   const impact=await h.api('loans.chargeImpact',input),request={...input,requestId:randomUUID(),confirmed:true,previewToken:impact.previewToken}
   const deleted=await h.api('loans.changeCharge',request);assert.equal((await h.sync(loan)).createdCount,0)
   await change(loan,fee,'restore');assert.equal((await h.sync(loan)).createdCount,1)
   const replacement=(await h.state(loan)).items[0];assert.notEqual(replacement.transactionId,fee.transactionId)
   assert.deepEqual(await h.api('loans.changeCharge',request),deleted)
   assert.equal((await h.state(loan)).items[0].state,'recorded');assert.equal((await h.state(loan)).recordedMinor,'2000')
  })
  await t.test('L18 批量删除混有自动费用时全批拒绝，其他支出保持；商品退款不改变贷款本金/费用',async()=>{
   const loan=await h.create();await h.configure(loan);await h.sync(loan);const fee=(await h.state(loan)).items[0],manual=await h.expense('2026-04-01','1000')
   await assert.rejects(h.api('transactions.deleteMany',{requestId:randomUUID(),items:[{transactionId:manual.transactionId,version:1},{transactionId:fee.transactionId,version:fee.transactionVersion}]}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
   const [[row]]=await h.owner.execute('SELECT deleted_at FROM catledger_transactions WHERE uid=? AND transaction_id=?',[h.uid,manual.transactionId]);assert.equal(row.deleted_at,null)
   const before=await live(loan),fees=await h.state(loan)
   await h.api('transactions.create',{requestId:randomUUID(),type:'refund',originalTransactionId:manual.transactionId,destinationAccountId:h.accountId,amountMinor:'1000',occurredLocalAt:'2026-04-30T12:00:00',timezoneOffsetMinutes:-480})
   assert.equal((await live(loan)).remainingPrincipalMinor,before.remainingPrincipalMinor);assert.equal((await h.state(loan)).recordedMinor,fees.recordedMinor)
  })
  await t.test('L12/L18 利率变化/减免/终止不伪造退款，原费用与本金保持',async()=>{
   for(const reason of ['rate_changed','waiver','contract_cancelled']){
    let loan=await h.create();await h.configure(loan);await h.sync(loan);loan=await live(loan)
    const prior=await h.state(loan)
    await h.api('loans.endCharges',{requestId:randomUUID(),loanId:loan.loanId,version:loan.version,confirmed:true,reason})
    const stopped=await h.state(loan);assert.equal(stopped.recordedMinor,prior.recordedMinor)
    assert.equal(stopped.items.filter(c=>c.state===(reason==='rate_changed'?'paused':'cancelled')).length,8)
    assert.equal((await h.sync(loan)).createdCount,0)
   }
  })
  await t.test('回退开关停止新费用，但原成功回执仍可核实，历史/保护继续有效',async()=>{
   const loan=await h.create();await h.configure(loan);const request={requestId:randomUUID(),loanId:loan.loanId};const result=await h.api('loans.syncCharges',request)
   const original=h.services.apiServices['loans.syncCharges']
   h.services.apiServices['loans.syncCharges']=createLoanChargeSync({getPool:()=>h.apiPool,enabled:()=>false}).syncCharges
   assert.deepEqual(await h.api('loans.syncCharges',request),result)
   await assert.rejects(h.sync(loan),{publicCode:'LOAN_CHARGE_PAUSED'})
   assert.equal((await h.state(loan)).recordedMinor,'8000')
   h.services.apiServices['loans.syncCharges']=original
  })
 }finally{await h.close()}
})
