const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab,prepareBank,postBank}=require('./helpers/loan-charges')
const {localServices,call}=require('./helpers/local-services')
const {realPage}=require('./helpers/real-page')
const version=async(h,loan)=>(await h.api('loans.get',{loanId:loan.loanId})).loan.version
const cover=(transaction,periodNumber=2)=>({chargeKey:'period:'+periodNumber+':interest',transactionId:transaction.transactionId,transactionVersion:transaction.version})
const confirm=async(h,loan,extra={})=>h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:loan.loanId,version:await version(h,loan),repayments:[{periodNumber:2,paid:true}],...extra})
const event=dataset=>({currentTarget:{dataset}})
const total=async h=>{const [[r]]=await h.owner.execute("SELECT COUNT(*) AS n,COALESCE(SUM(amount_minor),0) AS amount FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL",[h.uid]);return {n:Number(r.n),amount:String(r.amount)}}
const original=async(h,id)=>(await h.owner.execute('SELECT * FROM catledger_transactions WHERE uid=? AND transaction_id=?',[h.uid,id]))[0][0]
async function remove(h,loan){const input={loanId:loan.loanId,version:await version(h,loan)},impact=await h.api('loans.deleteImpact',input);assert.equal(impact.canDelete,true);return h.api('loans.delete',{...input,requestId:randomUUID(),confirmed:true,previewToken:impact.previewToken})}

test('F03 历史确认明确认领原费用',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 async function scenario(name,fn){await t.test(name,async()=>{const h=await chargeLab();try{await fn(h)}finally{await h.close()}})}
 await scenario('先记2月利息再创建计划，明确选用原账目不重复支出或生成余额保全',async h=>{
  const old=await h.expense('2026-02-03'),before=await h.api('transactions.list',{month:'2026-02'})
  const loan=await h.create({baselinePrincipalMinor:'550000',repayments:[{periodNumber:2,paid:true}],coverage:[cover(old)]})
  const after=await h.api('transactions.list',{month:'2026-02'}),state=await h.state(loan)
  assert.equal(after.summary.expenseMinor,'2000');assert.deepEqual(after.transactions,before.transactions)
  assert.equal(state.items[0].transactionId,old.transactionId);assert.equal(state.items[0].balanceAdjustmentId,null)
  assert.equal(state.contract.authorization.mode,'paused');assert.equal(state.items[0].historicalSettledMinor,'2000')
 })
 await scenario('真实创建页选原费用，服务端已提交却丢响应时原请求恢复且只保存一次',async h=>{
  const old=await h.expense('2026-02-03'),before=await original(h,old.transactionId),ui=realPage(h),page=ui.page('loan-form')
  page.onLoad({accountId:h.accountId});await page.load()
  page.setData({name:'合成历史认领',principalYuan:'6000',paidTerms:'2',baselineDate:'2026-01-01','schedule.terms':'12','schedule.repaymentYuan':'520','schedule.firstPaymentDate':'2026-01-31'})
  await page.preview();page.selectRepayments({detail:{value:['2']}})
  await page.openHistoricalCoverage(event({key:'period:2:interest'}))
  assert.equal(page.data.historyCoverageCandidates.length,1)
  page.chooseHistoricalCandidate(event({id:old.transactionId}))
  const respond=ui.respond;let lost=true
  ui.respond=async(action,data)=>{const result=await respond(action,data);if(action==='loans.create'&&lost){lost=false;throw new Error('合成响应丢失')}return result}
  await page.save();assert.equal(page.data.hasPending,true)
  const first=ui.calls.find(c=>c.action==='loans.create')
  await page.save();assert.equal(page.data.hasPending,false)
  assert.deepEqual(ui.calls.filter(c=>c.action==='loans.create').map(c=>c.data.requestId),[first.data.requestId])
  assert(ui.calls.some(c=>c.action==='transactions.commandResult'&&c.data.requestId===first.data.requestId))
  const loans=await h.api('loans.list');assert.equal(loans.items.length,1)
  assert.equal((await h.state(loans.items[0])).items[0].transactionId,old.transactionId)
  assert.deepEqual(await original(h,old.transactionId),before);assert.deepEqual(await total(h),{n:1,amount:'2000'})
 })
 await scenario('真实详情页跨月定位原利息，单期历史确认后撤回及删除都保留原账目',async h=>{
  const old=await h.expense('2026-01-30'),before=await original(h,old.transactionId),loan=await h.create(),ui=realPage(h),page=ui.page('loan-detail')
  page.onLoad({loanId:loan.loanId});await page.load();await page.openInstallment(event({term:2}))
  await page.openHistoricalCoverage(event({key:'period:2:interest'}));assert.equal(page.data.historyCoverageCandidates.length,0)
  page.historicalCoverageInput({currentTarget:{dataset:{field:'allDates'}},detail:{value:true}});await page.loadHistoricalCandidates()
  assert.equal(page.data.historyCoverageCandidates[0].transactionId,old.transactionId)
  page.chooseHistoricalCandidate(event({id:old.transactionId}));await page.setPeriodStatus(event({status:'completed'}))
  assert.equal(page.data.errorMessage,'');assert.deepEqual(await total(h),{n:1,amount:'2000'})
  await page.openInstallment(event({term:2}));await page.setPeriodStatus(event({status:'unpaid'}))
  assert.equal((await h.state(loan)).items[0].historicalSettledMinor,'0')
  await remove(h,loan);assert.deepEqual(await original(h,old.transactionId),before)
 })
 await scenario('同月同额只推荐，未选就独立记费，选定其中一笔不吞并其他账目',async h=>{
  const a=await h.expense('2026-02-02'),b=await h.expense('2026-02-03')
  const recommended=await h.api('transactions.refundable',{accountId:h.accountId,feeCandidate:true,chargeCandidates:[{month:'2026-02',amountMinor:'2000'}]})
  assert.deepEqual(new Set(recommended.transactions.map(t=>t.transactionId)),new Set([a.transactionId,b.transactionId]))
  const standalone=await h.create();await confirm(h,standalone);assert.deepEqual(await total(h),{n:3,amount:'6000'})
  const linked=await h.create();await confirm(h,linked,{coverage:[cover(b)]})
  assert.deepEqual(await total(h),{n:3,amount:'6000'});assert.equal((await h.state(linked)).items[0].transactionId,b.transactionId)
  assert.equal((await original(h,a.transactionId)).deleted_at,null)
 })
 await scenario('两计划并发认领只允许一方；同请求重放返回原结果，失败方无半份历史',async h=>{
  const old=await h.expense('2026-02-02'),a=await h.create(),b=await h.create()
  const input=loan=>({requestId:randomUUID(),loanId:loan.loanId,version:1,repayments:[{periodNumber:2,paid:true}],coverage:[cover(old)]})
  const requests=[input(a),input(b)],results=await Promise.allSettled(requests.map(data=>h.api('loans.confirmInstallments',data)))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.publicCode,'LOAN_SOURCE_MISMATCH')
  const winner=results.findIndex(r=>r.status==='fulfilled'),loser=1-winner
  assert.deepEqual(await h.api('loans.confirmInstallments',requests[winner]),results[winner].value)
  assert.equal((await h.state([a,b][loser])).contract,null);assert.equal(await version(h,[a,b][loser]),1)
  assert.deepEqual(await total(h),{n:1,amount:'2000'})
 })
 await scenario('版本、金额、账户、跨用户和部分/全部退款逐项拒绝；同交易重复认领整批回滚',async h=>{
  const loan=await h.create(),old=await h.expense('2026-02-02')
  await h.api('transactions.update',{requestId:randomUUID(),transactionId:old.transactionId,version:old.version,type:'expense',sourceAccountId:h.accountId,categoryId:h.categoryId,amountMinor:'2000',occurredLocalAt:'2026-02-02T12:00:00',timezoneOffsetMinutes:-480,note:'合成已修改'})
  await assert.rejects(confirm(h,loan,{coverage:[cover(old)]}),{publicCode:'CONFLICT'})
  const wrongAmount=await h.expense('2026-02-02','1800'),wrongAccount=await h.expense('2026-02-02','2000',{sourceAccountId:h.assetAccountId})
  for(const t of [wrongAmount,wrongAccount])await assert.rejects(confirm(h,loan,{coverage:[cover(t)]}),{publicCode:'LOAN_SOURCE_MISMATCH'})
  const foreign=localServices({apiPool:h.apiPool,importPool:h.importPool,subject:'synthetic-f03-other'}),identity=await call(foreign.api,'bootstrap')
  const account=await call(foreign.api,'accounts.create',{requestId:randomUUID(),name:'合成其他用户',type:'credit'})
  const other=await call(foreign.api,'transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:account.accountId,categoryId:identity.categories.find(c=>c.kind==='expense').id,amountMinor:'2000',occurredLocalAt:'2026-02-02T12:00:00',timezoneOffsetMinutes:-480})
  await assert.rejects(confirm(h,loan,{coverage:[cover(other)]}),{publicCode:'LOAN_SOURCE_MISMATCH'})
  for(const amountMinor of ['100','2000']){
   const expense=await h.expense('2026-02-02')
   await h.api('transactions.create',{requestId:randomUUID(),type:'refund',originalTransactionId:expense.transactionId,destinationAccountId:h.assetAccountId,amountMinor,occurredLocalAt:'2026-02-03T12:00:00',timezoneOffsetMinutes:-480})
   await assert.rejects(confirm(h,loan,{coverage:[cover(expense)]}),{publicCode:'LOAN_SOURCE_MISMATCH'})
   assert.equal((await h.api('transactions.refundable',{feeCandidate:true,originalTransactionId:expense.transactionId})).transactions.length,0)
  }
  const duplicate=await h.expense('2026-02-02')
  await assert.rejects(confirm(h,loan,{repayments:[{periodNumber:2,paid:true},{periodNumber:3,paid:true}],coverage:[cover(duplicate,2),cover(duplicate,3)]}),{publicCode:'LOAN_SOURCE_MISMATCH'})
  assert.equal((await h.state(loan)).contract,null);assert.equal(await version(h,loan),1)
 })
 await scenario('一次性原利息明确覆盖多期；不生成逐期支出，撤回部分历史只释放相应清偿',async h=>{
  const old=await h.expense('2026-01-10','4000'),before=await original(h,old.transactionId),loan=await h.create()
  const data={repayments:[{periodNumber:2,paid:true},{periodNumber:3,paid:true}],oneOffCharges:[{key:'existing-interest',component:'interest',amountMinor:'4000',chargeDate:'2026-01-10',transactionId:old.transactionId,transactionVersion:old.version,covers:['period:2:interest','period:3:interest']}]}
  await confirm(h,loan,data)
  const state=await h.state(loan),parent=state.items.find(i=>i.periodNumber===null)
  assert.equal(parent.transactionId,old.transactionId);assert.equal(parent.outstandingMinor,'0');assert.equal(state.items.filter(i=>i.state==='covered').length,2)
  assert.deepEqual(await total(h),{n:1,amount:'4000'})
  await confirm(h,loan,{repayments:[{periodNumber:2,paid:false}]})
  assert.equal((await h.state(loan)).items.find(i=>i.chargeId===parent.chargeId).outstandingMinor,'2000')
  await remove(h,loan);assert.deepEqual(await original(h,old.transactionId),before)
 })
 await scenario('先补费后有稳定身份的银行证据到达仍复用原费用，不重复支出或生成实际付款',async h=>{
  const old=await h.expense('2026-02-03'),reference='SYNTHETIC-F03-LATE'
  await postBank(h,await prepareBank(h,{period:1,component:'principal',amount:'500.00',reference,date:'2026-01-31'}))
  const source=(await h.api('loans.installmentSources')).items[0],loan=await h.create({sourceItemId:source.itemId})
  await confirm(h,loan,{coverage:[cover(old)]})
  let update=await prepareBank(h,{period:2,reference,date:'2026-02-03'})
  const issues=(await h.imp('reviewIssues.list',{updateId:update.updateId,status:'open'})).items
  for(const issue of issues.filter(i=>i.primaryReasonCode==='historical_duplicate_candidate'))update=await h.imp('reviewIssues.resolve',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,issueId:issue.issueId,issueVersion:issue.version,decision:'link_existing_transaction',transactionId:old.transactionId})
  await postBank(h,update)
  assert.deepEqual(await total(h),{n:1,amount:'2000'});assert.equal((await h.state(loan)).items.find(i=>i.chargeKey==='period:2:interest').transactionId,old.transactionId)
  const [[payments]]=await h.owner.execute('SELECT COUNT(*) AS n FROM catledger_loan_payments WHERE uid=?',[h.uid]);assert.equal(Number(payments.n),0)
 })
})
