const test=require('node:test')
const assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {chargeLab}=require('./helpers/loan-charges')
const {realPage}=require('./helpers/real-page')
const field=(field,value)=>({currentTarget:{dataset:{field}},detail:{value}})
test('无历史期次的新分期，一次性费用从真实详情明确发生并复用原账', {skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const h=await chargeLab()
 try{
  const loan=await h.create({feeUpfrontMinor:'10000',repaymentMinor:'50000'}),before=(await h.api('accounts.list')).accounts
  const ui=realPage(h),p=ui.page('loan-detail');p.onLoad({loanId:loan.loanId});await p.load()
  assert.equal(p.data.chargeHasOneOff,true,'有计划的一次性手续费必须可从详情处理')
  assert.equal((await h.state(loan)).items.length,0)
  assert.deepEqual((await h.api('accounts.list')).accounts,before)
  await p.openOneOffCharges();p.openUpfrontFee()
  p.upfrontInput(field('date','2026-01-05'))
  p.upfrontInput(field('accountIndex',p.data.chargeRefundAccounts.findIndex(a=>a.accountId===h.accountId)))
  await p.saveUpfrontFee();assert.equal(p.data.chargeError,'')
  const fee=(await h.state(loan)).items.find(c=>c.chargeKey==='upfront:fee')
  assert.equal(fee.chargeDate,'2026-01-05');assert.equal(fee.balanceAdjustmentId,null);assert.equal(fee.outstandingMinor,'10000')
  const after=(await h.api('accounts.list')).accounts
  assert.equal(after.find(a=>a.accountId===h.assetAccountId).bookBalanceMinor,before.find(a=>a.accountId===h.assetAccountId).bookBalanceMinor)
  assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'600000')
  const request=ui.calls.find(c=>c.action==='loans.recordUpfrontFee').data,result=await h.api('loans.recordUpfrontFee',request)
  assert.equal(result.chargeId,fee.chargeId)
  assert.deepEqual((await h.api('accounts.list')).accounts,after)
  const current=(await h.api('loans.installments',{loanId:loan.loanId})),row=current.items[0]
  await h.api('loans.record',{requestId:randomUUID(),simplePeriod:true,mode:'new',kind:'repayment',assetAccountId:h.assetAccountId,totalMinor:'50000',occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
   allocations:[{loanId:loan.loanId,version:current.loanVersion,period:{periodNumber:1,version:row.version},principalMinor:'50000',interestMinor:'0',feeMinor:'0',interestTreatment:'accrued',feeTreatment:'accrued'}]})
  assert.equal((await h.state(loan)).items.filter(c=>c.chargeKey==='upfront:fee').length,1)
  await t.test('已有一次性实费由页面认领，首期历史确认不新增费用或余额调整',async()=>{
   const expense=await h.api('transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:h.assetAccountId,categoryId:h.categoryId,amountMinor:'10000',occurredLocalAt:'2026-01-04T10:00:00',timezoneOffsetMinutes:-480})
   const other=await h.create({feeUpfrontMinor:'10000',repaymentMinor:'50000'}),ui=realPage(h),p=ui.page('loan-detail');p.onLoad({loanId:other.loanId});await p.load();await p.openOneOffCharges();p.openUpfrontFee()
   p.upfrontInput(field('modeIndex',1));p.upfrontInput(field('month','2026-01'));p.upfrontInput(field('accountIndex',p.data.chargeRefundAccounts.findIndex(a=>a.accountId===h.assetAccountId)))
   await p.loadUpfrontEvidence();p.chooseUpfrontEvidence({detail:{value:p.data.upfrontExisting.findIndex(t=>t.transactionId===expense.transactionId)}})
   const balances=(await h.api('accounts.list')).accounts
   await p.saveUpfrontFee();assert.equal(p.data.chargeError,'')
   let fee=(await h.state(other)).items[0];assert.equal(fee.transactionId,expense.transactionId);assert.equal(fee.chargeDate,'2026-01-04');assert.equal(fee.outstandingMinor,'0')
   assert.deepEqual((await h.api('accounts.list')).accounts,balances)
   await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:other.loanId,version:p.data.loan.version,repayments:[{periodNumber:1,paid:true}]})
   fee=(await h.state(other)).items[0];assert.equal(fee.transactionId,expense.transactionId);assert.equal(fee.balanceAdjustmentId,null);assert.equal(fee.historicalSettledMinor,'0')
   assert.deepEqual((await h.api('accounts.list')).accounts,balances)
   const refund={loanId:other.loanId,chargeId:fee.chargeId,operation:'refund',amountMinor:'1000',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-02-01T12:00:00',timezoneOffsetMinutes:-480}
   const impact=await h.api('loans.chargeImpact',refund)
   await h.api('loans.changeCharge',{...refund,requestId:randomUUID(),previewToken:impact.previewToken,confirmed:true})
   fee=(await h.state(other)).items[0];assert.equal(fee.netAmountMinor,'9000');assert.equal(fee.outstandingMinor,'0')
   await assert.rejects(h.api('transactions.delete',{requestId:randomUUID(),transactionId:expense.transactionId,version:1}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
  })
  await t.test('实付一次性手续费覆盖12期，实际还款只付本金，终止不伪造退款',async()=>{
   const covered=await h.create({repaymentMinor:'50000',feePerTermMinor:'1000',feeUpfrontMinor:'12000'})
   const paid=await h.api('loans.recordUpfrontFee',{requestId:randomUUID(),loanId:covered.loanId,version:1,mode:'new',confirmed:true,amountMinor:'12000',accountId:h.assetAccountId,categoryId:h.categoryId,occurredLocalAt:'2026-01-02T12:00:00',timezoneOffsetMinutes:-480,covers:Array.from({length:12},(_,i)=>i+1)})
   const before=(await h.api('accounts.list')).accounts,view=await h.api('loans.installment',{loanId:covered.loanId,periodNumber:1})
   assert.equal(view.period.feeMinor,'1000');assert.equal(view.period.unpaidFeeMinor,'0')
   const ui=realPage(h),p=ui.page('loan-payment');p.onLoad({loanId:covered.loanId,periodNumber:'1'});await p.load()
   assert.equal(p.data.allocations[0].feeYuan,'0.00');assert.equal(p.data.totalYuan,'500.00')
   p.chooseAccount({detail:{value:p.data.accounts.findIndex(a=>a.accountId===h.assetAccountId)}});p.input({currentTarget:{dataset:{field:'date'}},detail:{value:'2026-01-31'}})
   await p.save();assert.equal(p.data.errorMessage,'')
   assert.equal((await h.api('loans.installment',{loanId:covered.loanId,periodNumber:1})).period.complete,true)
   const after=(await h.api('accounts.list')).accounts
   assert.equal(BigInt(before.find(a=>a.accountId===h.assetAccountId).bookBalanceMinor)-BigInt(after.find(a=>a.accountId===h.assetAccountId).bookBalanceMinor),50000n)
   const version=(await h.api('loans.get',{loanId:covered.loanId})).loan.version
   await h.api('loans.endCharges',{requestId:randomUUID(),loanId:covered.loanId,version,reason:'settled',confirmed:true})
   const fees=(await h.state(covered)).items
   assert.equal(fees.filter(f=>f.state==='recorded').length,1);assert.equal(fees.filter(f=>f.state==='covered').length,12)
   assert.equal(fees.find(f=>f.chargeId===paid.chargeId).refundMinor,'0')
  })
  await t.test('一次性费用并发、来源版本、跨用户与失败回滚均保留原账',async()=>{
   const source=await h.expense('2026-01-02','10000'),sourceLoan=await h.create({feeUpfrontMinor:'10000',repaymentMinor:'50000'})
   await h.owner.execute('UPDATE catledger_transactions SET version=version+1 WHERE uid=? AND transaction_id=?',[h.uid,source.transactionId])
   await assert.rejects(h.api('loans.recordUpfrontFee',{requestId:randomUUID(),loanId:sourceLoan.loanId,version:1,mode:'existing',confirmed:true,transactionId:source.transactionId,transactionVersion:1}),{publicCode:'CONFLICT'})
   assert.equal((await h.state(sourceLoan)).items.length,0)
   const another=await h.create({feeUpfrontMinor:'10000',repaymentMinor:'50000'})
   const input={requestId:randomUUID(),loanId:another.loanId,version:1,mode:'new',confirmed:true,amountMinor:'10000',accountId:h.assetAccountId,categoryId:h.categoryId,occurredLocalAt:'2026-01-02T12:00:00',timezoneOffsetMinutes:-480}
   const before=(await h.api('accounts.list')).accounts
   await h.owner.query("CREATE TRIGGER fail_upfront_fee BEFORE INSERT ON catledger_loan_charge_audit FOR EACH ROW BEGIN IF NEW.action='record_upfront_fee' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic upfront rollback'; END IF; END")
   try{await assert.rejects(h.api('loans.recordUpfrontFee',input),{publicCode:'INTERNAL_ERROR'})}finally{await h.owner.query('DROP TRIGGER fail_upfront_fee')}
   assert.deepEqual((await h.api('accounts.list')).accounts,before);assert.equal((await h.state(another)).items.length,0)
   const outcomes=await Promise.allSettled([h.api('loans.recordUpfrontFee',input),h.api('loans.recordUpfrontFee',{...input,requestId:randomUUID()})])
   assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
   await assert.rejects(h.api('loans.recordUpfrontFee',{...input,requestId:randomUUID()}),{publicCode:'CONFLICT'})
   const {localServices,call}=require('./helpers/local-services'),other=localServices({apiPool:h.apiPool,importPool:h.importPool,subject:'synthetic-other-upfront'})
   await call(other.api,'bootstrap');await assert.rejects(call(other.api,'loans.recordUpfrontFee',{...input,requestId:randomUUID()}),{publicCode:'NOT_FOUND'})
  })
 }finally{await h.close()}
})
