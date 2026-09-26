const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab,prepareBank,postBank}=require('./helpers/loan-charges')
test('A3 费用核对与导入事务：实际先、方案先、差异与独立收费',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const h=await chargeLab()
 try {
  const loan=await h.create();await h.configure(loan,{referenceLabel:'SYNTHETIC-CHARGE'});await h.sync(loan)
  await t.test('L05 方案20遇实单20仅复用，原费用和银行卡不多记',async()=>{
   const update=await prepareBank(h),post=await postBank(h,update)
   const view=await h.state(loan),fee=view.items.find(i=>i.chargeKey==='period:2:interest')
   assert.equal(view.recordedMinor,'8000');assert.equal(fee.basis,'actual')
   const [[count]]=await h.owner.execute("SELECT COUNT(*) n FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL",[h.uid]);assert.equal(Number(count.n),4)
   const impact=await h.imp('financeUpdates.undoImpact',{updateId:update.updateId})
   await h.imp('financeUpdates.undo',{requestId:randomUUID(),updateId:update.updateId,version:post.appliedVersion,previewToken:impact.previewToken})
   assert.equal((await h.state(loan)).recordedMinor,'8000');assert.equal((await h.state(loan)).items.find(i=>i.chargeId===fee.chargeId).basis,'plan')
  })
  await t.test('L05 实单18拒绝额外记账；预览净差-2，确认后原费用变18并补来源',async()=>{
   const update=await prepareBank(h,{period:3,amount:'18.00',date:'2026-03-01'}),before=await h.state(loan),fee=before.items.find(i=>i.chargeKey==='period:3:interest')
   const otherPeriod=await prepareBank(h,{period:5,amount:'17.00',date:'2026-05-01'})
   const selected=await h.api('loans.chargePlan',{loanId:loan.loanId,periodNumber:3})
   assert.deepEqual(selected.issues.map(i=>i.eventId),[update.event.eventId])
   assert.ok((await h.state(loan)).issues.some(i=>i.eventId===otherPeriod.event.eventId))
   await assert.rejects(postBank(h,update),{publicCode:'LOAN_CHARGE_DIFFERENCE'})
   assert.equal((await h.state(loan)).recordedMinor,'8000')
   const request={loanId:loan.loanId,chargeId:fee.chargeId,operation:'adjust',eventId:update.event.eventId}
   const impact=await h.api('loans.chargeImpact',request);assert.equal(impact.deltaMinor,'-200');assert.equal(impact.canChange,true)
   const changed=await h.api('loans.changeCharge',{...request,requestId:randomUUID(),confirmed:true,previewToken:impact.previewToken})
   await postBank(h,{...update,appliedVersion:changed.updateVersion})
   const after=await h.state(loan),next=after.items.find(i=>i.chargeId===fee.chargeId)
   assert.equal(next.transactionId,fee.transactionId);assert.equal(next.amountMinor,'1800');assert.equal(next.basis,'actual');assert.equal(after.recordedMinor,'7800')
  })
  await t.test('L07 同一期另一笔银行费用必须明确确认为追加，不能按同额吞掉',async()=>{
   const update=await prepareBank(h,{period:3,amount:'18.00',date:'2026-03-01',suffix:'-EXTRA'})
   const reviews=(await h.imp('reviewIssues.list',{updateId:update.updateId,status:'open'})).items
   assert.equal(reviews.filter(i=>i.primaryReasonCode==='historical_duplicate_candidate').length,0)
   await assert.rejects(postBank(h,update),{publicCode:'LOAN_SOURCE_MISMATCH'})
   const fee=(await h.state(loan)).items.find(i=>i.chargeKey==='period:3:interest')
   const request={loanId:loan.loanId,chargeId:fee.chargeId,operation:'distinct',eventId:update.event.eventId}
   const impact=await h.api('loans.chargeImpact',request)
   const changed=await h.api('loans.changeCharge',{...request,requestId:randomUUID(),confirmed:true,previewToken:impact.previewToken})
   await postBank(h,{...update,appliedVersion:changed.updateVersion})
   assert.equal((await h.state(loan)).recordedMinor,'9600')
  })
  await t.test('L06 实际先导入无贷款归属，后开方案按明确编号认领；补缺不重记',async()=>{
   const update=await prepareBank(h,{period:4,date:'2026-04-01',reference:'SYNTHETIC-ACTUAL-FIRST'})
   await postBank(h,await require('./helpers/local-services').confirmSyntheticHistoryDistinct(h.services,update))
   const other=await h.create();await h.configure(other,{referenceLabel:'SYNTHETIC-ACTUAL-FIRST'})
   assert.equal((await h.state(other)).recordedMinor,'2000')
   const result=await h.sync(other);assert.equal(result.createdCount,3);assert.equal((await h.state(other)).recordedMinor,'8000')
  })
  await t.test('L08 同步与实单并发处理同费，用户锁裁决为一笔；跨来源关系不重复',async()=>{
   const other=await h.create();await h.configure(other,{referenceLabel:'SYNTHETIC-RACE',fromDate:'2026-02-01',throughDate:'2026-02-28'})
   const update=await prepareBank(h,{reference:'SYNTHETIC-RACE',suffix:'-RACE'})
   // 有同额的其他合同历史候选时，明确确认不同合同，仍不放宽金额防重。
   const issues=(await h.imp('reviewIssues.list',{updateId:update.updateId,status:'open'})).items
   let latest=update
   for(const i of issues.filter(i=>i.primaryReasonCode==='historical_duplicate_candidate'))latest=await h.imp('reviewIssues.resolve',{requestId:randomUUID(),updateId:update.updateId,updateVersion:latest.appliedVersion,issueId:i.issueId,issueVersion:i.version,decision:'confirm_distinct'})
   await Promise.all([h.sync(other),postBank(h,latest)])
   const view=await h.state(other);assert.equal(view.recordedMinor,'2000');assert.equal(view.items.filter(i=>i.state==='recorded').length,1)
  })
 }finally{await h.close()}
})
