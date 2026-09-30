const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab,prepareBank,postBank}=require('./helpers/loan-charges')
const {localServices,call,prepareSyntheticUpdate}=require('./helpers/local-services')
const version=async(h,l)=>(await h.api('loans.get',{loanId:l.loanId})).loan.version
const balances=async h=>Object.fromEntries((await h.api('accounts.list')).accounts.map(a=>[a.accountId,a.bookBalanceMinor]))
const snapshot=async h=>{const out={};for(const table of ['loans','transactions','loan_payments','loan_payment_transactions','loan_period_allocations','loan_charges','loan_charge_contracts','installment_items','installment_bindings','mutation_receipts'])out[table]=(await h.owner.query('SELECT * FROM catledger_'+table+' WHERE uid=?',[h.uid]))[0];return out}
async function removal(h,l){const input={loanId:l.loanId,version:await version(h,l)},impact=await h.api('loans.deleteImpact',input);return {impact,input:{...input,previewToken:impact.previewToken,confirmed:true,requestId:randomUUID()}}}
async function confirm(h,l,paid=true){return h.api('loans.confirmInstallments',{loanId:l.loanId,version:await version(h,l),repayments:[{periodNumber:1,paid}],requestId:randomUUID()})}
async function transfer(h,amountMinor='50000'){return h.api('transactions.create',{requestId:randomUUID(),type:'transfer',sourceAccountId:h.assetAccountId,destinationAccountId:h.accountId,amountMinor,occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480})}
async function payment(h,l,{mode='new',source,principal='50000',interest='0',fee='0',period=false,charges=[],expenseCharges=false,kind='repayment',other=[]}={}){
 const v=await h.api('loans.installment',{loanId:l.loanId,periodNumber:1})
 return h.api('loans.record',{requestId:randomUUID(),confirmed:true,kind,mode,source,assetAccountId:h.assetAccountId,totalMinor:String(BigInt(principal)+BigInt(interest)+BigInt(fee)+other.reduce((n,a)=>n+BigInt(a.principalMinor),0n)),occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480,
 allocations:[{loanId:l.loanId,version:v.loanVersion,principalMinor:principal,interestMinor:interest,feeMinor:fee,interestTreatment:charges.length&&!expenseCharges?'accrued':'expense',feeTreatment:'expense',interestCategoryId:h.categoryId,feeCategoryId:h.categoryId,...(period?{period:{periodNumber:1,version:v.period.version}}:{}),chargeAllocations:charges},...other]})
}
test('贷款整组删除：真实接口、来源认领、重建、幂等及事务隔离',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:240000},async t=>{
 async function scenario(name,fn){await t.test(name,async()=>{const h=await chargeLab();try{await fn(h)}finally{await h.close()}})}
 await scenario('纯计划新增放款、还款、息费完整撤销，余额与统计回到原值',async h=>{
  const before=await balances(h),summary=(await h.api('statistics.get',{month:'2026-01'})).summary,[initial]=await h.owner.execute('SELECT transaction_id FROM catledger_transactions WHERE uid=? AND deleted_at IS NULL ORDER BY transaction_id',[h.uid]),l=await h.create({baselinePrincipalMinor:'0',originKind:'cash_borrowing',repayments:[]})
  await payment(h,l,{kind:'drawdown',principal:'600000'})
  await payment(h,l,{interest:'2000',fee:'1000'})
  const {impact,input}=await removal(h,l)
  assert.equal(impact.canDelete,true);assert.deepEqual(impact.counts,{drawdowns:1,repayments:1,fees:2,balanceAdjustments:0,retained:0})
  const result=await h.api('loans.delete',input)
  assert.equal(result.deleted,true);assert.deepEqual(await balances(h),before)
  assert.equal((await h.api('loans.list')).items.length,0)
  assert.deepEqual((await h.api('statistics.get',{month:'2026-01'})).summary,summary)
  const [remaining]=await h.owner.execute('SELECT transaction_id FROM catledger_transactions WHERE uid=? AND deleted_at IS NULL ORDER BY transaction_id',[h.uid]);assert.deepEqual(remaining,initial)
 })
 await scenario('历史费用与余额保全成对撤销；一次删除不会保留孤立本金进度',async h=>{
  const before=await balances(h),l=await h.create();await confirm(h,l)
  const {impact,input}=await removal(h,l);assert.equal(impact.counts.fees,1);assert.equal(impact.counts.balanceAdjustments,1)
  await h.api('loans.delete',input);assert.deepEqual(await balances(h),before)
  const old=(await h.api('loans.get',{loanId:l.loanId})).loan;assert.equal(old.deleted,true);assert.equal(old.remainingPrincipalMinor,'0')
  const [[saved]]=await h.owner.execute('SELECT deletion_snapshot_json AS snapshot FROM catledger_loans WHERE uid=? AND loan_id=?',[h.uid,l.loanId]);const history=typeof saved.snapshot==='string'?JSON.parse(saved.snapshot):saved.snapshot
  assert.equal((typeof history.progress==='string'?JSON.parse(history.progress):history.progress).historyFacts['1'].principalMinor,'50000')
 })
 await scenario('独立手工付款保留身份且可重新关联；新计划不能冒领原始归属',async h=>{
  const l=await h.create({repaymentMinor:'50000'}),txn=await transfer(h),source=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source
  await payment(h,l,{mode:'associate',source,period:true});const before=await balances(h)
  const {impact,input}=await removal(h,l);assert.equal(impact.retain[0].transactionId,txn.transactionId);assert.equal(impact.revoke.length,0)
  await h.api('loans.delete',input);assert.deepEqual(await balances(h),before)
  const next=await h.create({repaymentMinor:'50000'}),again=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source
  await payment(h,next,{mode:'associate',source:again,period:true});assert.deepEqual(await balances(h),before)
  assert.equal((await h.api('loans.get',{loanId:next.loanId})).loan.remainingPrincipalMinor,'550000')
  const second=await removal(h,next);assert.equal(second.impact.revoke.length,0)
 })
 await scenario('原导入费用保留，释放来源后新ID重建复用，不产生新交易',async h=>{
  await postBank(h,await prepareBank(h,{period:1,date:'2026-01-31'}))
  const item=(await h.api('loans.installmentSources')).items[0],l=await h.create({sourceItemId:item.itemId});await confirm(h,l)
  const before=await balances(h),fee=(await h.state(l)).items[0],{input,impact}=await removal(h,l)
  assert.equal(impact.revoke.length,0);await h.api('loans.delete',input)
  assert.equal((await h.api('loans.installmentSources',{itemId:item.itemId})).items[0].transactionId,item.transactionId)
  assert.equal((await h.api('loans.transaction',{transactionId:item.transactionId})).state,'retained_charge')
  assert.equal((await h.api('loans.retainedCharge',{chargeId:fee.chargeId})).charge.transactionId,item.transactionId)
  const next=await h.create({sourceItemId:item.itemId});await confirm(h,next)
  assert.notEqual(next.loanId,l.loanId);assert.equal((await h.state(next)).items[0].transactionId,item.transactionId);assert.deepEqual(await balances(h),before)
 })
 await scenario('计划费用后来被银行认领，交易和余额保全都保留且可维护实际退费',async h=>{
  const l=await h.create();await h.configure(l,{referenceLabel:'SYNTHETIC-CLAIM',mode:'once'});await confirm(h,l)
  const fee=(await h.state(l)).items[0]
  await postBank(h,await prepareBank(h,{period:1,date:'2026-01-31',reference:'SYNTHETIC-CLAIM'}))
  // 旧创建凭据缺失，但有效银行认领与成对外键已能证明必须保留整对。
  await h.owner.execute('UPDATE catledger_transactions SET creation_provenance_json=NULL WHERE uid=? AND transaction_id IN (?,?)',[h.uid,fee.transactionId,fee.balanceAdjustmentId])
  await h.owner.execute("DELETE FROM catledger_loan_charge_audit WHERE uid=? AND charge_id=? AND action='confirm_historical_paid'",[h.uid,fee.chargeId])
  const priorRefund={loanId:l.loanId,chargeId:fee.chargeId,operation:'refund',amountMinor:'100',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-02-01T12:00:00',timezoneOffsetMinutes:-480}
  const refundImpact=await h.api('loans.chargeImpact',priorRefund)
  await h.api('loans.changeCharge',{...priorRefund,previewToken:refundImpact.previewToken,confirmed:true,requestId:randomUUID()})
  const before=await balances(h),{impact,input}=await removal(h,l)
  assert.equal(impact.canDelete,true);assert(impact.retain.some(t=>t.transactionId===fee.transactionId));assert(impact.retain.some(t=>t.transactionId===fee.balanceAdjustmentId))
  await h.api('loans.delete',input);assert.deepEqual(await balances(h),before)
  const data={chargeId:fee.chargeId,detached:true,operation:'refund',amountMinor:'100',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-02-01T12:00:00',timezoneOffsetMinutes:-480}
  const preview=await h.api('loans.chargeImpact',data);assert.equal(preview.canChange,true)
  await h.api('loans.changeCharge',{...data,previewToken:preview.previewToken,confirmed:true,requestId:randomUUID()})
  assert.equal((await h.api('loans.retainedCharge',{chargeId:fee.chargeId})).charge.refundMinor,'200')
 })
 await scenario('共享付款阻止整次删除；预览给出付款入口，所有表和回执不变',async h=>{
  const a=await h.create({repaymentMinor:'50000'}),b=await h.create({repaymentMinor:'50000'})
  await payment(h,a,{other:[{loanId:b.loanId,version:1,principalMinor:'50000',interestMinor:'0',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense'}]})
  const {impact,input}=await removal(h,a);assert.equal(impact.canDelete,false);assert(impact.blockers.some(b=>b.code==='SHARED_PAYMENT'&&b.entry.url.includes('paymentId=')))
  const before=await snapshot(h);await assert.rejects(h.api('loans.delete',input),{publicCode:'LOAN_DELETE_BLOCKED'});assert.deepEqual(await snapshot(h),before)
 })
 await scenario('待撤销独立退款阻止整次删除；保留费用的独立退款不误删',async h=>{
  const l=await h.create();await confirm(h,l);const fee=(await h.state(l)).items[0]
  const data={loanId:l.loanId,chargeId:fee.chargeId,operation:'refund',amountMinor:'100',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-02-01T12:00:00',timezoneOffsetMinutes:-480}
  const preview=await h.api('loans.chargeImpact',data);await h.api('loans.changeCharge',{...data,previewToken:preview.previewToken,confirmed:true,requestId:randomUUID()})
  const {input,impact}=await removal(h,l),before=await snapshot(h)
  assert(impact.blockers.some(b=>b.code==='EXTERNAL_REFUND'));await assert.rejects(h.api('loans.delete',input),{publicCode:'LOAN_DELETE_BLOCKED'});assert.deepEqual(await snapshot(h),before)
 })
 await scenario('更正独立手工原账后删除保留当前正确本息费，绝不恢复错误原账',async h=>{
  const l=await h.create(),txn=await h.expense('2026-01-31','52000',{sourceAccountId:h.assetAccountId})
  const source=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source,paid=await payment(h,l,{mode:'correctExisting',source,interest:'2000'})
  const current=(await h.api('loans.payment',{paymentId:paid.paymentId})).transactions.map(t=>t.transactionId),before=await balances(h)
  const {impact,input}=await removal(h,l);assert.equal(impact.canDelete,true);assert.equal(impact.revoke.length,0)
  await h.api('loans.delete',input);assert.deepEqual(await balances(h),before)
  const [rows]=await h.owner.execute('SELECT transaction_id AS id,deleted_at AS deletedAt FROM catledger_transactions WHERE uid=? AND transaction_id IN (?,?,?)',[h.uid,txn.transactionId,...current])
  assert(rows.find(r=>r.id===txn.transactionId).deletedAt);assert(current.every(id=>rows.find(r=>r.id===id).deletedAt===null))
  assert.deepEqual((await h.api('loans.source',{transactionIds:current})).source.transactionIds,current.sort())
 })
 await scenario('一次性费用覆盖12期仅撤销一次；重新记录用新交易ID',async h=>{
  const l=await h.create({repaymentMinor:'50000',feePerTermMinor:'1000',feeUpfrontMinor:'12000'}),before=await balances(h)
  const fee=await h.api('loans.recordUpfrontFee',{requestId:randomUUID(),loanId:l.loanId,version:1,mode:'new',confirmed:true,amountMinor:'12000',accountId:h.assetAccountId,categoryId:h.categoryId,occurredLocalAt:'2026-01-02T12:00:00',timezoneOffsetMinutes:-480,covers:Array.from({length:12},(_,i)=>i+1)})
  const state=await h.state(l),{impact,input}=await removal(h,l);assert.equal(impact.counts.fees,1)
  await h.api('loans.delete',input);assert.deepEqual(await balances(h),before)
  const next=await h.create({repaymentMinor:'50000',feePerTermMinor:'1000',feeUpfrontMinor:'12000',chargeContractId:state.contract.contractId})
  const fresh=await h.api('loans.recordUpfrontFee',{requestId:randomUUID(),loanId:next.loanId,version:1,mode:'new',confirmed:true,amountMinor:'12000',accountId:h.assetAccountId,categoryId:h.categoryId,occurredLocalAt:'2026-01-02T12:00:00',timezoneOffsetMinutes:-480,covers:Array.from({length:12},(_,i)=>i+1)})
  assert.notEqual(fresh.transactionId,fee.transactionId)
  assert.equal((await removal(h,next)).impact.counts.fees,1)
 })
 await scenario('导入原账更正后保留正确分项与来源；解除旧占用后新计划原位关联',async h=>{
  const l=await h.create(),update=await prepareSyntheticUpdate(h.services,1,'SYNTHETIC-DELETE-IMPORT')
  const issue=(await h.imp('reviewIssues.list',{updateId:update.updateId,group:'accounts'})).items[0]
  const mapped=await h.imp('reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,decisions:[{issueId:issue.issueId,issueVersion:issue.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:h.assetAccountId}}]})
  await h.imp('financeUpdates.post',{requestId:randomUUID(),updateId:update.updateId,version:mapped.appliedVersion})
  const [[root]]=await h.owner.execute('SELECT transaction_id AS id FROM catledger_economic_event_transactions WHERE uid=? AND update_id=?',[h.uid,update.updateId])
  const source=(await h.api('loans.source',{transactionIds:[root.id]})).source
  const data={requestId:randomUUID(),mode:'correctExisting',source,kind:'repayment',assetAccountId:h.assetAccountId,totalMinor:'100',occurredLocalAt:'2026-09-01T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,allocations:[{loanId:l.loanId,version:1,principalMinor:'80',interestMinor:'20',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:h.categoryId}]}
  const p=await h.api('loans.record',data),txns=(await h.api('loans.payment',{paymentId:p.paymentId})).transactions,before=await balances(h)
  await h.api('loans.delete',(await removal(h,l)).input)
  const next=await h.create(),again=await h.api('loans.source',{transactionIds:[txns[0].transactionId]})
  await h.api('loans.record',{...data,requestId:randomUUID(),mode:'associate',source:again.source,allocations:[{...data.allocations[0],loanId:next.loanId}]})
  assert.deepEqual(await balances(h),before);assert.equal(again.transactions.length,2)
  assert((await h.owner.execute('SELECT deleted_at AS deletedAt FROM catledger_transactions WHERE uid=? AND transaction_id=?',[h.uid,root.id]))[0][0].deletedAt)
 })
 await scenario('用户单独抑制费用不复活；整组撤销费用可在新计划重新记录',async h=>{
  const l=await h.create();await h.configure(l,{referenceLabel:'SYNTHETIC-REBUILD'});await h.sync(l)
  const state=await h.state(l),f=state.items.find(i=>i.chargeKey==='period:1:interest'),d={loanId:l.loanId,chargeId:f.chargeId,operation:'suppress'},p=await h.api('loans.chargeImpact',d)
  await h.api('loans.changeCharge',{...d,previewToken:p.previewToken,confirmed:true,requestId:randomUUID()})
  await h.api('loans.delete',(await removal(h,l)).input)
  const next=await h.create({chargeContractId:state.contract.contractId});await h.configure(next,{referenceLabel:'SYNTHETIC-REBUILD'})
  await h.sync(next)
  const after=await h.state(next);assert.equal(after.items.find(i=>i.chargeId===f.chargeId).state,'suppressed');assert.equal(after.items.filter(i=>i.state==='recorded').length,3)
 })
 await scenario('历史本金被实际凭证替换，删除重建后复用同付款与费用不重复扣减',async h=>{
  const l=await h.create();await confirm(h,l);const fee=(await h.state(l)).items[0],contract=(await h.state(l)).contract
  const txn=await transfer(h,'52000'),source=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source
  await payment(h,l,{mode:'associate',source,interest:'2000',period:true,charges:[{chargeId:fee.chargeId,component:'interest',amountMinor:'2000'}]})
  const before=await balances(h),{impact,input}=await removal(h,l);assert.equal(impact.canDelete,true);assert.equal(impact.revoke.length,0)
  await h.api('loans.delete',input)
  const next=await h.create({chargeContractId:contract.contractId});await confirm(h,next)
  const again=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source
  await payment(h,next,{mode:'associate',source:again,interest:'2000',period:true,charges:[{chargeId:fee.chargeId,component:'interest',amountMinor:'2000'}]})
  assert.deepEqual(await balances(h),before);assert.equal((await h.api('loans.get',{loanId:next.loanId})).loan.remainingPrincipalMinor,'550000')
  const retained=(await h.state(next)).items[0];assert.equal(retained.outstandingMinor,'0');assert.equal(retained.settledMinor,'2000');assert.equal(retained.historicalCoveredMinor,'0')
 })
 await scenario('旧数据依据创建记录判断；证据缺失则待核对，不按manual或当前关联猜删',async h=>{
  const l=await h.create(),paid=await payment(h,l,{interest:'2000'})
  await h.owner.execute('UPDATE catledger_transactions SET creation_provenance_json=NULL WHERE uid=?',[h.uid])
  const proven=await removal(h,l);assert.equal(proven.impact.canDelete,true);assert.equal(proven.impact.revoke.length,2)
  const [rows]=await h.owner.execute('SELECT transaction_id AS id FROM catledger_loan_payment_transactions WHERE uid=? AND payment_id=?',[h.uid,paid.paymentId])
  await h.owner.execute('UPDATE catledger_loan_payment_transactions SET created_by_payment=0 WHERE uid=? AND payment_id=?',[h.uid,paid.paymentId])
  const unknown=await removal(h,l);assert.equal(unknown.impact.canDelete,false);assert(unknown.impact.blockers.some(b=>b.code==='OWNERSHIP_REVIEW'))
  await h.owner.execute('UPDATE catledger_transactions SET creation_provenance_json=? WHERE uid=? AND transaction_id=?',[JSON.stringify({kind:'loan',loanIds:[null]}),h.uid,rows[0].id])
  assert.equal((await removal(h,l)).impact.canDelete,false)
  for(const r of rows)assert(!(await h.owner.execute('SELECT deleted_at AS d FROM catledger_transactions WHERE uid=? AND transaction_id=?',[h.uid,r.id]))[0][0].d)
 })
 await scenario('600期费用及余额保全完整撤销，分块检查和写入不逐期往返',async h=>{
  const before=await balances(h),l=await h.create({scheduleTerms:600,baselinePrincipalMinor:'30000000',installmentSetup:{...h.plan.installmentSetup,originalPrincipalMinor:'30000000'}})
  await h.api('loans.confirmInstallments',{loanId:l.loanId,version:1,repayments:Array.from({length:600},(_,i)=>({periodNumber:i+1,paid:true})),requestId:randomUUID()})
  const start=Date.now(),queries=h.measure(),{impact,input}=await removal(h,l)
  assert.equal(impact.canDelete,true);assert.equal(impact.counts.fees,600);assert.equal(impact.counts.balanceAdjustments,600)
  await h.api('loans.delete',input)
  const measured={name:'delete-600-periods',queries:h.measure()-queries,ms:Date.now()-start}
  assert(measured.queries<200,JSON.stringify(measured));t.diagnostic(JSON.stringify(measured))
  assert.deepEqual(await balances(h),before)
  assert.equal((await h.state(l)).items.filter(f=>f.state==='recorded').length,0)
 })
 await scenario('更正后的完整本息付款带费用分项保留，重建选择其中一笔会展开全组并复用',async h=>{
  const l=await h.create();await h.configure(l,{mode:'once'})
  const state=await h.state(l),f=state.items.find(f=>f.chargeKey==='period:1:interest'),txn=await h.expense('2026-01-31','52000',{sourceAccountId:h.assetAccountId})
  const source=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source
  const paid=await payment(h,l,{mode:'correctExisting',source,interest:'2000',expenseCharges:true,charges:[{chargeId:f.chargeId,component:'interest',amountMinor:'2000'}]})
  const current=(await h.api('loans.payment',{paymentId:paid.paymentId})).transactions,before=await balances(h)
  await h.api('loans.delete',(await removal(h,l)).input)
  assert.equal((await h.api('loans.retainedCharge',{chargeId:f.chargeId})).charge.historicalSettledMinor,'0')
  const next=await h.create({chargeContractId:state.contract.contractId}),reusable=await h.api('loans.source',{transactionIds:[current[0].transactionId]})
  assert.equal(reusable.transactions.length,2);assert.equal(reusable.retainedCharges[0].chargeId,f.chargeId)
  await payment(h,next,{mode:'associate',source:reusable.source,interest:'2000',expenseCharges:true,charges:[{chargeId:f.chargeId,component:'interest',amountMinor:'2000'}]})
  assert.deepEqual(await balances(h),before);assert.equal((await h.api('loans.get',{loanId:next.loanId})).loan.remainingPrincipalMinor,'550000')
  assert.equal((await removal(h,next)).impact.revoke.length,0)
  await h.api('loans.delete',(await removal(h,next)).input)
  const retained=(await h.api('loans.retainedCharge',{chargeId:f.chargeId})).charge
  assert.equal(retained.directlyPaidMinor,'2000');assert.equal(retained.historicalSettledMinor,'0');assert.equal(retained.outstandingMinor,'0')
 })
 await scenario('无新历史确认时复用原清偿付款，也不再次抵扣已保留费用',async h=>{
  const l=await h.create();await confirm(h,l);const state=await h.state(l),f=state.items[0],txn=await transfer(h,'52000')
  await payment(h,l,{mode:'associate',source:(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source,interest:'2000',period:true,charges:[{chargeId:f.chargeId,component:'interest',amountMinor:'2000'}]})
  const before=await balances(h);await h.api('loans.delete',(await removal(h,l)).input)
  const next=await h.create({chargeContractId:state.contract.contractId})
  await payment(h,next,{mode:'associate',source:(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source,interest:'2000',period:true,charges:[{chargeId:f.chargeId,component:'interest',amountMinor:'2000'}]})
  assert.deepEqual(await balances(h),before);assert.equal((await h.api('loans.get',{loanId:next.loanId})).loan.remainingPrincipalMinor,'550000')
  assert.equal((await h.state(next)).items[0].settledMinor,'2000')
 })
 await scenario('已撤销费用可重新导入；有效来源与新计划复用同笔账，旧失效关系不卡住',async h=>{
  const l=await h.create();await h.configure(l,{referenceLabel:'SYNTHETIC-REIMPORT'});await h.sync(l)
  const original=(await h.state(l)).items.find(f=>f.chargeKey==='period:1:interest').transactionId
  await h.api('loans.delete',(await removal(h,l)).input)
  const update=await prepareBank(h,{period:1,date:'2026-01-31',reference:'SYNTHETIC-REIMPORT'});await postBank(h,update)
  const item=(await h.api('loans.installmentSources')).items[0];assert.notEqual(item.transactionId,original)
  const next=await h.create({sourceItemId:item.itemId});await confirm(h,next)
  assert.equal((await h.state(next)).items[0].transactionId,item.transactionId)
  const before=await snapshot(h),balance=await balances(h);await postBank(h,update)
  const after=await snapshot(h);assert.deepEqual(after.transactions,before.transactions);assert.deepEqual(after.loan_charges,before.loan_charges);assert.deepEqual(await balances(h),balance)
 })
 await scenario('预览后新增依赖/版本过期拒绝；事务末尾故障所有写入及回执回滚',async h=>{
  const l=await h.create();await confirm(h,l);const {input}=await removal(h,l),before=await snapshot(h)
  await h.owner.query("CREATE TRIGGER fail_loan_delete BEFORE UPDATE ON catledger_loans FOR EACH ROW BEGIN IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic delete rollback'; END IF; END")
  try{await assert.rejects(h.api('loans.delete',input),{publicCode:'INTERNAL_ERROR'})}finally{await h.owner.query('DROP TRIGGER fail_loan_delete')}
  assert.deepEqual(await snapshot(h),before)
  await confirm(h,l)
  await assert.rejects(h.api('loans.delete',input),{publicCode:'CONFLICT'})
 })
 await scenario('并发删除、响应丢失、跨用户与旧请求重放；旧计划不能写入或复活自动记费',async h=>{
  const l=await h.create();await h.configure(l);await h.sync(l);const {input}=await removal(h,l)
  const other=localServices({apiPool:h.apiPool,importPool:h.importPool,subject:'synthetic-delete-other'});await call(other.api,'bootstrap')
  await assert.rejects(call(other.api,'loans.delete',input),{publicCode:'NOT_FOUND'})
  const results=await Promise.all([h.api('loans.delete',input),h.api('loans.delete',input)]);assert.deepEqual(results[0],results[1])
  const receipt=await h.api('transactions.commandResult',{requestId:input.requestId,commandAction:'loans.delete'});assert.deepEqual(receipt.result,results[0])
  const newTxn=await transfer(h),before=await snapshot(h);assert.deepEqual(await h.api('loans.delete',input),results[0]);assert.deepEqual(await snapshot(h),before)
  assert.equal((await h.api('loans.source',{transactionIds:[newTxn.transactionId]})).source.transactionIds[0],newTxn.transactionId)
  await assert.rejects(h.api('loans.archiveInstallment',{loanId:l.loanId,version:results[0].version,archived:false,requestId:randomUUID()}),{publicCode:'NOT_FOUND'})
  await assert.rejects(confirm(h,l),{publicCode:'NOT_FOUND'})
  await assert.rejects(h.configure({loanId:l.loanId,version:results[0].version}),{publicCode:'NOT_FOUND'})
  assert.equal((await h.sync(l)).createdCount,0)
  const fee=(await h.state(l)).items[0]
  await assert.rejects(h.api('loans.chargeImpact',{loanId:l.loanId,chargeId:fee.chargeId,operation:'restore'}),{publicCode:'NOT_FOUND'})
 })
 await scenario('旧客户端仅归档依然只释放关系，绝不撤销交易',async h=>{
  const l=await h.create();await confirm(h,l);const before=await balances(h),state=await h.state(l)
  await h.api('loans.archiveInstallment',{loanId:l.loanId,version:await version(h,l),archived:true,requestId:randomUUID()})
  assert.deepEqual(await balances(h),before);assert.equal((await h.state(l)).recordedMinor,state.recordedMinor)
  assert.equal((await h.api('loans.get',{loanId:l.loanId})).loan.deleted,false)
 })
})
