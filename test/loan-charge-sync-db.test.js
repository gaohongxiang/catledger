const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab}=require('./helpers/loan-charges')
const {createLoanChargeSync}=require('../cloudfunctions/catledger-api/src/loan-charge-sync')

test('A2 到期同步：漏月、未授权、起算、并发回滚及回执',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const h=await chargeLab()
 try {
  let loan
  await t.test('L02 一月四月已有费用，只补二三月，1～4月80元，无本金或银行卡变化',async()=>{
   loan=await h.create();const jan=await h.expense('2026-01-01'),apr=await h.expense('2026-04-01')
   const coverage=[{chargeKey:'period:1:interest',transactionId:jan.transactionId},{chargeKey:'period:4:interest',transactionId:apr.transactionId}]
   const configuration={...h.authorization,interestCategoryId:h.categoryId,coverage}
   const preview=await h.api('loans.chargePlan',{loanId:loan.loanId,configuration,pageSize:2})
   assert.equal(preview.duePreviewCount,2);assert.equal(preview.duePreviewMinor,'4000');assert.equal(preview.recordedMinor,'0')
   assert.deepEqual(preview.preview.map(p=>p.previewState),['covered','due'])
   const next=await h.api('loans.chargePlan',{loanId:loan.loanId,configuration,pageSize:2,cursor:preview.nextCursor})
   assert.deepEqual(next.preview.map(p=>p.previewState),['due','covered'])
   await assert.rejects(h.api('loans.chargePlan',{loanId:loan.loanId,configuration:{...configuration,fromDate:'2026-04-01'},cursor:preview.nextCursor}),{publicCode:'CONFLICT'})
   await h.configure(loan,{coverage})
   const q=h.measure(),start=Date.now(),result=await h.sync(loan)
   assert.equal(result.createdCount,2);assert.equal(result.amountMinor,'4000');assert.deepEqual(result.created.map(i=>i.chargeDate),['2026-02-01','2026-03-01'])
   const view=await h.state(loan);assert.equal(view.recordedMinor,'8000');assert.equal(view.unverifiedMinor,'4000')
   const [[r]]=await h.owner.execute("SELECT COUNT(*) AS n FROM catledger_transactions WHERE uid=? AND (type='transfer' OR origin='loan_plan' AND (source_account_id<>? OR destination_account_id IS NOT NULL))",[h.uid,h.accountId]);assert.equal(Number(r.n),0)
   const [[payments]]=await h.owner.execute('SELECT COUNT(*) n FROM catledger_loan_payments WHERE uid=?',[h.uid]);assert.equal(Number(payments.n),0)
   t.diagnostic(JSON.stringify({case:'L02',sql:h.measure()-q,ms:Date.now()-start,created:2,amountMinor:result.amountMinor}))
  })
  await t.test('L03 无授权只有预览；一次确认补齐且不默开后续自动记费',async()=>{
   const pending=await h.create();assert.equal((await h.sync(pending)).createdCount,0)
   const consent=await h.configure(pending,{mode:'once',throughDate:'2026-04-30'})
   assert.equal((await h.sync(pending)).createdCount,0)
   assert.equal((await h.sync(pending,{confirmed:true,contractId:consent.contractId})).createdCount,4)
   assert.equal((await h.state(pending)).contract.authorization.mode,'once')
  })
  await t.test('L04 不补历史保留一月，只有四月在授权范围内',async()=>{
   const pending=await h.create(),jan=await h.expense('2026-01-01')
   await h.configure(pending,{fromDate:'2026-04-01',historyChoice:'continue',coverage:[{chargeKey:'period:1:interest',transactionId:jan.transactionId}]})
   assert.equal((await h.sync(pending)).createdCount,1)
   const view=await h.state(pending);assert.equal(view.recordedMinor,'4000');assert.equal(view.items[1].state,'planned');assert.equal(view.items[2].state,'planned')
  })
  await t.test('L08 两设备不同请求同时补同费，响应丢失查原回执，金额只记一次',async()=>{
   const pending=await h.create();await h.configure(pending)
   const request={requestId:randomUUID(),loanId:pending.loanId}
   const results=await Promise.all([h.api('loans.syncCharges',request),h.sync(pending)])
   assert.equal(results.reduce((n,r)=>n+r.createdCount,0),4)
   assert.deepEqual(await h.api('loans.syncCharges',request),results[0])
   const receipt=await h.api('transactions.commandResult',{requestId:request.requestId,commandAction:'loans.syncCharges'})
   assert.deepEqual(receipt.result,results[0]);assert.equal((await h.state(pending)).recordedMinor,'8000')
  })
  await t.test('L08 第二项插入失败，费用/关系/回执整批回滚；原请求恢复',async()=>{
   const pending=await h.create();await h.configure(pending)
   const prior=h.services.apiServices['loans.syncCharges'];let inserts=0
   const pool={getConnection:async()=>{
    const c=await h.apiPool.getConnection();return new Proxy(c,{get(target,key){if(key==='execute')return async(sql,args)=>{
     if(sql.includes('INSERT INTO catledger_transactions')&&++inserts===2)throw new Error('synthetic second charge failure')
     return target.execute(sql,args)
    };const value=target[key];return typeof value==='function'?value.bind(target):value}})
   }}
   h.services.apiServices['loans.syncCharges']=createLoanChargeSync({getPool:()=>pool,now:()=>Date.parse('2026-04-30T12:00:00Z')}).syncCharges
   const request={requestId:randomUUID(),loanId:pending.loanId}
   await assert.rejects(h.api('loans.syncCharges',request),{publicCode:'INTERNAL_ERROR'})
   assert.equal((await h.state(pending)).recordedMinor,'0')
   await assert.rejects(h.api('transactions.commandResult',{requestId:request.requestId,commandAction:'loans.syncCharges'}),{publicCode:'OPERATION_UNCONFIRMED'})
   h.services.apiServices['loans.syncCharges']=prior
   assert.equal((await h.api('loans.syncCharges',request)).createdCount,4)
  })
  await t.test('L15 服务端截止日与起算边界；失联数年分批补原月份，未来不写',async()=>{
   const pending=await h.create({baselinePrincipalMinor:'6000000',baselineDate:'2020-01-01',scheduleTerms:120,firstPaymentDate:'2020-01-31',installmentSetup:{...h.plan.installmentSetup,originalPrincipalMinor:'6000000'}})
   await h.configure(pending,{fromDate:'2020-01-01',throughDate:'2029-12-31',firstChargeDate:'2020-01-31'})
   const first=await h.sync(pending);assert.equal(first.createdCount,40);assert.equal(first.hasMore,true)
   const second=await h.sync(pending);assert.equal(second.createdCount,36);assert.equal(second.hasMore,false)
   const view=await h.state(pending);assert.equal(view.items.length,40);assert.ok(view.nextCursor)
   let cursor=view.nextCursor,pages=1
   while(cursor){const next=await h.api('loans.chargePlan',{loanId:pending.loanId,cursor});assert.ok(next.items.length<=40);view.items.push(...next.items);cursor=next.nextCursor;pages++}
   assert.equal(pages,3);assert.equal(view.items.filter(i=>i.state==='recorded').length,76)
   assert.ok(view.items.filter(i=>i.state==='recorded').every(i=>i.chargeDate<='2026-04-30'))
   assert.equal(view.items.find(i=>i.chargeDate==='2024-02-29').state,'recorded')
   await assert.rejects(h.sync(pending,{cutoff:'2030-01-01'}),{publicCode:'VALIDATION_ERROR'})
   h.setNow('2026-05-30T15:59:59Z');assert.equal((await h.sync(pending)).createdCount,0)
   h.setNow('2026-05-30T16:00:00Z');assert.equal((await h.sync(pending)).createdCount,1)
  })
  await t.test('L17 同步修改修订使旧导出失效；暂停、停用账户不能继续记费',async()=>{
   const pending=await h.create();const configured=await h.configure(pending)
   const job=await h.api('dataExports.start',{requestId:randomUUID()})
   await h.sync(pending)
   await assert.rejects(h.api('dataExports.page',{exportId:job.exportId}),{publicCode:'EXPORT_CHANGED'})
   const view=await h.state(pending);await h.api('loans.pauseCharges',{requestId:randomUUID(),loanId:pending.loanId,version:view.loanVersion})
   h.setNow('2026-12-31T12:00:00Z');assert.equal((await h.sync(pending)).createdCount,0)
   assert.ok(configured.contractId)
  })
 }finally{await h.close()}
})
