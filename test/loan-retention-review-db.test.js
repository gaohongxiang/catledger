const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab,prepareBank,postBank}=require('./helpers/loan-charges')
const {realPage}=require('./helpers/real-page')
const version=async(h,l)=>(await h.api('loans.get',{loanId:l.loanId})).loan.version
async function remove(h,l){const data={loanId:l.loanId,version:await version(h,l)},impact=await h.api('loans.deleteImpact',data);assert.equal(impact.canDelete,true);return h.api('loans.delete',{...data,previewToken:impact.previewToken,confirmed:true,requestId:randomUUID()})}
async function imported(h){await postBank(h,await prepareBank(h,{period:1,date:'2026-01-31'}));const item=(await h.api('loans.installmentSources')).items[0],loan=await h.create({sourceItemId:item.itemId});await h.configure(loan,{mode:'once'});return {loan,charge:(await h.state(loan)).items.find(f=>f.chargeKey==='period:1:interest')}}
async function pay(h,l,charge,amountMinor,{retained=false,principalMinor='0'}={}){
 const totalMinor=String(BigInt(principalMinor)+BigInt(amountMinor));let source
 if(retained){const txn=await h.api('transactions.create',{requestId:randomUUID(),type:'transfer',sourceAccountId:h.assetAccountId,destinationAccountId:h.accountId,amountMinor:totalMinor,occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480});source=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source}
 return h.api('loans.record',{requestId:randomUUID(),confirmed:true,mode:retained?'associate':'new',kind:'repayment',source,assetAccountId:h.assetAccountId,totalMinor,occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480,allocations:[{loanId:l.loanId,version:await version(h,l),principalMinor,interestMinor:amountMinor,feeMinor:'0',interestTreatment:'accrued',feeTreatment:'expense',chargeAllocations:[{chargeId:charge.chargeId,component:'interest',amountMinor}]}]})
}
test('F02 删除后保留费用与付款必须有真实依据和可继续的页面入口',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:150000},async t=>{
 async function scenario(name,fn){await t.test(name,async()=>{const h=await chargeLab();try{await fn(h)}finally{await h.close()}})}
 await scenario('导入20利息后新增520还款；撤销付款后保留费用仍待清偿，真实详情显示未付',async h=>{
  const {loan,charge}=await imported(h);await pay(h,loan,charge,'2000',{principalMinor:'50000'});assert.equal((await h.state(loan)).items[0].outstandingMinor,'0')
  await remove(h,loan);const after=await h.api('loans.retainedCharge',{chargeId:charge.chargeId})
  assert.equal(after.charge.historicalSettledMinor,'0');assert.equal(after.charge.outstandingMinor,'2000')
  const ui=realPage(h),page=ui.page('loan-detail');page.onLoad({chargeId:charge.chargeId});await page.load();assert.equal(page.data.retainedCharge.outstandingMinor,'2000')
 })
 await scenario('同费部分付款只保留外部原付款的1000，撤销的1000不伪造已还',async h=>{
  const {loan,charge}=await imported(h);await pay(h,loan,charge,'1000',{retained:true});await pay(h,loan,charge,'1000')
  await remove(h,loan);const after=(await h.api('loans.retainedCharge',{chargeId:charge.chargeId})).charge
  assert.equal(after.historicalSettledMinor,'1000');assert.equal(after.outstandingMinor,'1000')
 })
 await scenario('人工确认及原付款仍保留清偿；退款仅冲减一次，原费用不丢失',async h=>{
  const {loan,charge}=await imported(h)
  await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:loan.loanId,version:await version(h,loan),repayments:[{periodNumber:1,paid:true}]})
  const input={loanId:loan.loanId,chargeId:charge.chargeId,operation:'refund',amountMinor:'200',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-02-01T12:00:00',timezoneOffsetMinutes:-480}
  const impact=await h.api('loans.chargeImpact',input);await h.api('loans.changeCharge',{...input,previewToken:impact.previewToken,confirmed:true,requestId:randomUUID()})
  await remove(h,loan);const after=(await h.api('loans.retainedCharge',{chargeId:charge.chargeId})).charge
  assert.equal(after.historicalCoveredMinor,'1800');assert.equal(after.netAmountMinor,'1800');assert.equal(after.outstandingMinor,'0')
 })
 await scenario('独立普通借款还款→关联→删计划→从真实账目页面关联新计划，账务不重复',async h=>{
  const {accountId}=await h.api('accounts.create',{requestId:randomUUID(),name:'合成普通贷款',type:'other_liability',openingDisplayBalanceMinor:'600000',occurredLocalAt:'2020-01-01T00:00:00',timezoneOffsetMinutes:-480})
  const paid=await h.api('loans.bookRepayment',{requestId:randomUUID(),totalMinor:'52000',occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480,repayment:{confirmed:true,mode:'defer',assetAccountId:h.assetAccountId,liabilityAccountId:accountId,principalMinor:'50000',interestMinor:'2000',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:h.categoryId}})
  const loan=await h.create({accountId});await h.api('loans.assignRepayment',{requestId:randomUUID(),paymentId:paid.paymentId,version:1,loanId:loan.loanId,loanVersion:1,confirmed:true})
  const payment=await h.api('loans.payment',{paymentId:paid.paymentId}),txn=payment.transactions.find(t=>t.type==='transfer'),before=(await h.api('accounts.list')).accounts
  await remove(h,loan);assert.deepEqual((await h.api('accounts.list')).accounts,before)
  const context=await h.api('loans.transaction',{transactionId:txn.transactionId});assert.equal(context.state,'candidate');assert.equal(context.retained,true);assert.equal(context.repayment.principalMinor,'50000')
  const next=await h.create({accountId}),ui=realPage(h),link=ui.page('loan-link');link.onLoad({transactionId:txn.transactionId});await link.firstPage();link.selectLoan({currentTarget:{dataset:{id:next.loanId}}})
  assert.match(ui.navigation.at(-1),/loan-payment\/index\?loanId=.*&sourceTransactionId=/)
  const page=ui.page('loan-payment');page.onLoad({loanId:next.loanId,sourceTransactionId:txn.transactionId});await page.load()
  assert.equal(page.data.allocations[0].principalYuan,'500.00');assert.equal(page.data.allocations[0].interestYuan,'20.00');page.setData({confirmed:true});await page.save()
  assert.equal(page.data.errorMessage,'');assert.equal(ui.calls.filter(c=>c.action==='loans.record').length,1)
  assert.deepEqual((await h.api('accounts.list')).accounts,before)
  assert.equal((await h.api('loans.get',{loanId:next.loanId})).loan.remainingPrincipalMinor,'550000')
  const arbitrary=await h.api('transactions.create',{requestId:randomUUID(),type:'transfer',sourceAccountId:h.assetAccountId,destinationAccountId:accountId,amountMinor:'50000',occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480})
  assert.equal((await h.api('loans.transaction',{transactionId:arbitrary.transactionId})).state,'none')
 })
 await scenario('保留费用在现有贷款列表可见并能进入原详情；其他账户不可串页',async h=>{
  const {loan,charge}=await imported(h);await remove(h,loan)
  const ui=realPage(h),page=ui.page('loans');page.onLoad({accountId:h.accountId});await page.loadLoans()
  assert.equal(page.data.errorMessage,'');assert.equal(page.data.retainedCharges.length,1);assert.equal(page.data.retainedCharges[0].chargeId,charge.chargeId)
  page.openRetainedCharge({currentTarget:{dataset:{id:charge.chargeId}}});assert.match(ui.navigation.at(-1),new RegExp('loan-detail/index\\?chargeId='+charge.chargeId))
  const detail=ui.page('loan-detail');detail.onLoad({chargeId:charge.chargeId});await detail.load();detail.rebuildFromCharge()
  assert.match(ui.navigation.at(-1),/loan-form\/index\?chargeContractId=/)
  const other=await h.api('accounts.create',{requestId:randomUUID(),name:'合成另卡',type:'credit'})
  assert.equal((await h.api('loans.retainedCharges',{accountId:other.accountId})).items.length,0)
 })
 await scenario('保留还款重新关联已有历史本金的计划，必须明确期次并且只替换历史覆盖',async h=>{
  const {accountId}=await h.api('accounts.create',{requestId:randomUUID(),name:'合成历史贷款',type:'other_liability'})
  const paid=await h.api('loans.bookRepayment',{requestId:randomUUID(),totalMinor:'50000',occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480,repayment:{confirmed:true,mode:'defer',assetAccountId:h.assetAccountId,liabilityAccountId:accountId,principalMinor:'50000',interestMinor:'0',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense'}})
  const loan=await h.create({accountId,repaymentMinor:'50000'});await h.api('loans.assignRepayment',{requestId:randomUUID(),paymentId:paid.paymentId,version:1,loanId:loan.loanId,loanVersion:1,confirmed:true})
  const txn=(await h.api('loans.payment',{paymentId:paid.paymentId})).transactions[0];await remove(h,loan)
  const next=await h.create({accountId,repaymentMinor:'50000'});await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:next.loanId,version:1,repayments:[{periodNumber:1,paid:true}]})
  const source=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source
  await assert.rejects(h.api('loans.record',{requestId:randomUUID(),confirmed:true,kind:'repayment',mode:'associate',source,assetAccountId:h.assetAccountId,totalMinor:'50000',occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480,allocations:[{loanId:next.loanId,version:await version(h,next),principalMinor:'50000',interestMinor:'0',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense'}]}),{publicCode:'LOAN_PERIOD_REQUIRED'})
  const before=(await h.api('accounts.list')).accounts,ui=realPage(h),page=ui.page('loan-payment');page.onLoad({loanId:next.loanId,sourceTransactionId:txn.transactionId});await page.load()
  page.periodInput({currentTarget:{dataset:{index:0}},detail:{value:'1'}});await page.selectAllocationPeriod({currentTarget:{dataset:{index:0}}})
  page.setData({confirmed:true});await page.save();assert.equal(page.data.errorMessage,'')
  assert.equal((await h.api('loans.get',{loanId:next.loanId})).loan.remainingPrincipalMinor,'550000');assert.deepEqual((await h.api('accounts.list')).accounts,before)
 })
 await scenario('删除阻断的账目直达读取指定记录，忽略全局旧对象并保留费用保护',async h=>{
  const {loan,charge}=await imported(h);await remove(h,loan)
  const ui=realPage(h);ui.app.globalData.editingTransaction={transactionId:randomUUID(),type:'expense',amountMinor:'999'}
  const page=ui.page('transaction-editor');page.onLoad({transactionId:charge.transactionId});await page.prepareForm()
  assert.equal(page.data.transactionId,charge.transactionId);assert.equal(page.data.loanManaged,true);assert.equal(page.data.formReady,true)
  const missing=realPage(h).page('transaction-editor');missing.onLoad({transactionId:randomUUID()});await missing.prepareForm()
  assert.equal(missing.data.formReady,false);assert(missing.data.errorMessage);assert.equal(missing.data.transactionId,'')
 })
})
