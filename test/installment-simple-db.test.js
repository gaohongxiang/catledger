const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab,prepareBank,postBank}=require('./helpers/loan-charges')
test('逐期简化：第6期接入、第8期补漏、原月费用防重与余额保全',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const h=await chargeLab()
 const accounts=async()=>Object.fromEntries((await h.api('accounts.list')).accounts.map(a=>{assert.match(a.bookBalanceMinor,/^-?\d+$/);return [a.accountId,a.bookBalanceMinor]}))
 const expense=async()=>{const [[r]]=await h.owner.execute("SELECT COALESCE(SUM(amount_minor),0) AS amount FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL",[h.uid]);return BigInt(r.amount)}
 let loan
 const view=()=>h.api('loans.installments',{loanId:loan.loanId})
 const confirm=async repayments=>{const current=await view();return h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:loan.loanId,version:current.loanVersion,repayments})}
 try{
  await t.test('创建时勾选1～6期，保留第3期未还；费用与进度同事务，当前账户余额不变',async()=>{
   const sixth=await prepareBank(h,{period:6,date:'2026-06-30'});await postBank(h,sixth)
   const source=(await h.api('loans.installmentSources',{})).items[0],before=await accounts()
   const repayments=Array.from({length:6},(_,i)=>({periodNumber:i+1,paid:i!==2}))
   const input={...h.plan,accountId:h.accountId,baselinePrincipalMinor:'350000',sourceItemId:source.itemId,repayments,requestId:randomUUID()}
   loan=await h.api('loans.create',input);assert.deepEqual(await h.api('loans.create',input),loan)
   assert.deepEqual(await accounts(),before);assert.equal(await expense(),10000n)
   const result=await view();assert.equal(result.summary.paidPeriods,5);assert.equal(result.items[2].complete,false);assert.equal(result.items[5].complete,true)
   const fee=(await h.state(loan)).items.find(i=>i.chargeKey==='period:1:interest')
   assert.ok(fee.balanceAdjustmentId);assert.equal(fee.outstandingMinor,'0')
   const [[row]]=await h.owner.execute('SELECT source_account_id AS accountId,occurred_local_date AS date FROM catledger_transactions WHERE uid=? AND transaction_id=?',[h.uid,fee.transactionId])
   assert.equal(row.accountId,h.accountId);assert.equal(row.date,'2026-01-31')
   for(const transactionId of [fee.transactionId,fee.balanceAdjustmentId])await assert.rejects(h.api('transactions.delete',{requestId:randomUUID(),transactionId,version:1}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
  })
  await t.test('第8期导入不会悄悄确认缺月；保存第7、8期后只补一次第7期，未还第3期保留',async()=>{
   await postBank(h,await prepareBank(h,{period:8,date:'2026-08-31'}))
   assert.equal((await view()).items[6].complete,false)
   const before=await accounts();await confirm([{periodNumber:7,paid:true},{periodNumber:8,paid:true}])
   assert.deepEqual(await accounts(),before);assert.equal(await expense(),14000n);assert.equal((await view()).items[2].complete,false)
   const request={requestId:randomUUID(),loanId:loan.loanId,version:(await view()).loanVersion,repayments:[{periodNumber:7,paid:true}]}
   const results=await Promise.all([h.api('loans.confirmInstallments',request),h.api('loans.confirmInstallments',request)])
   assert.deepEqual(results[0],results[1]);assert.equal(await expense(),14000n)
   assert.equal((await h.api('loans.dueCharges',{})).count,0)
   assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'250000')
  })
  await t.test('补传第7期只核对同一费用，金额/月份与余额不变',async()=>{
   const before=await accounts(),amount=await expense()
   await postBank(h,await prepareBank(h,{period:7,date:'2026-07-31'}))
   assert.deepEqual(await accounts(),before);assert.equal(await expense(),amount)
   const fees=(await h.state(loan)).items.filter(i=>i.chargeKey==='period:7:interest')
   assert.equal(fees.length,1);assert.equal(fees[0].basis,'actual')
  })
  await t.test('改回未还同步撤回本次历史补息，费用与余额成对恢复；已有关联账单不能直接删除',async()=>{
   const before=await accounts();await confirm([{periodNumber:2,paid:false}]);assert.equal(await expense(),12000n);assert.deepEqual(await accounts(),before)
   await confirm([{periodNumber:2,paid:true}]);assert.equal(await expense(),14000n);assert.deepEqual(await accounts(),before)
   await assert.rejects(confirm([{periodNumber:7,paid:false}]),{publicCode:'LOAN_TRANSACTION_LOCKED'})
  })
  await t.test('事务中途失败、过期版本和非法期次不能留下一半费用或进度',async()=>{
   const before=await accounts(),amount=await expense(),current=await view()
   await assert.rejects(h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:loan.loanId,version:current.loanVersion-1,repayments:[{periodNumber:9,paid:true}]}),{publicCode:'CONFLICT'})
   await assert.rejects(confirm([{periodNumber:9,paid:true},{periodNumber:601,paid:true}]),{publicCode:'VALIDATION_ERROR'})
   await h.owner.query("CREATE TRIGGER fail_history_adjustment BEFORE INSERT ON catledger_transactions FOR EACH ROW BEGIN IF NEW.type='balance_adjustment' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic rollback'; END IF; END")
   try{await assert.rejects(confirm([{periodNumber:9,paid:true}]))}finally{await h.owner.query('DROP TRIGGER fail_history_adjustment')}
   assert.equal(await expense(),amount);assert.deepEqual(await accounts(),before);assert.equal((await view()).items[8].complete,false)
  })
  await t.test('第9期直接记还款：银行卡只扣总额，费用同账户记一次；后传账单不重复',async()=>{
   const before=await accounts(),current=await h.api('loans.installment',{loanId:loan.loanId,periodNumber:9}),row=current.period
   const request={requestId:randomUUID(),simplePeriod:true,mode:'new',kind:'repayment',assetAccountId:h.assetAccountId,totalMinor:'52000',occurredLocalAt:'2026-09-30T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
    allocations:[{loanId:loan.loanId,version:current.loanVersion,principalMinor:'50000',interestMinor:'2000',feeMinor:'0',interestTreatment:'accrued',feeTreatment:'accrued',interestCategoryId:null,feeCategoryId:null,period:{periodNumber:9,periodId:row.periodId,version:row.version}}]}
   const paid=await h.api('loans.record',request);assert.deepEqual(await h.api('loans.record',request),paid)
   const after=await accounts();assert.equal(BigInt(after[h.assetAccountId])-BigInt(before[h.assetAccountId]),-52000n);assert.equal(BigInt(after[h.accountId])-BigInt(before[h.accountId]),50000n)
   assert.equal(await expense(),16000n);assert.equal((await view()).items[8].paymentConfirmed,true);assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'200000')
   assert.equal((await h.api('loans.installment',{loanId:loan.loanId,periodNumber:10})).repaymentAccountId,h.assetAccountId)
   await postBank(h,await prepareBank(h,{period:9,date:'2026-09-30'}));assert.deepEqual(await accounts(),after);assert.equal(await expense(),16000n)
  })
  await t.test('实际已还重复选择不添费用；部分实付不可被历史选择覆盖；跨用户拒绝',async()=>{
   const before=await accounts(),amount=await expense();await confirm([{periodNumber:9,paid:true}]);assert.equal(await expense(),amount);assert.deepEqual(await accounts(),before)
   const current=await h.api('loans.installment',{loanId:loan.loanId,periodNumber:10})
   await h.api('loans.record',{requestId:randomUUID(),simplePeriod:true,mode:'new',kind:'repayment',assetAccountId:h.assetAccountId,totalMinor:'10000',occurredLocalAt:'2026-10-31T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
    allocations:[{loanId:loan.loanId,version:current.loanVersion,principalMinor:'10000',interestMinor:'0',feeMinor:'0',interestTreatment:'accrued',feeTreatment:'accrued',period:{periodNumber:10,version:current.period.version}}]})
   const partial=await accounts();for(const paid of [true,false])await assert.rejects(confirm([{periodNumber:10,paid}]),{publicCode:'LOAN_TRANSACTION_LOCKED'});assert.deepEqual(await accounts(),partial)
   const {localServices,call}=require('./helpers/local-services'),other=localServices({apiPool:h.apiPool,importPool:h.importPool,subject:'synthetic-other-'+randomUUID()});await call(other.api,'bootstrap')
   const foreign={requestId:randomUUID(),loanId:loan.loanId,version:(await view()).loanVersion,repayments:[{periodNumber:11,paid:true}]}
   await assert.rejects(call(other.api,'loans.confirmInstallments',{...foreign,uid:h.uid}),{publicCode:'INVALID_REQUEST'})
   await assert.rejects(call(other.api,'loans.confirmInstallments',foreign),{publicCode:'NOT_FOUND'})
   assert.deepEqual(await accounts(),partial);assert.equal((await view()).items[10].complete,false)
  })
  await t.test('首期历史选择只补逐期费用，不推定计划的一次性手续费；现金新建仍可到账',async()=>{
   const before=await accounts(),amount=await expense(),history=await h.api('loans.create',{...h.plan,requestId:randomUUID(),accountId:h.accountId,feeUpfrontMinor:'10000',baselinePrincipalMinor:'500000',repayments:[{periodNumber:1,paid:true},{periodNumber:2,paid:true}]})
   assert.equal(await expense()-amount,4000n);assert.deepEqual(await accounts(),before)
   assert.equal((await h.state(history)).items.filter(i=>i.chargeKey==='upfront:fee').length,0)
   await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:history.loanId,version:1,repayments:[{periodNumber:1,paid:false}]});assert.equal(await expense()-amount,2000n);assert.deepEqual(await accounts(),before)
   const cash=await h.api('loans.create',{...h.plan,requestId:randomUUID(),accountId:h.accountId,originKind:'cash_borrowing',baselinePrincipalMinor:'0',repayments:[]})
   assert.equal((await h.state(cash)).contract.originKind,'cash_borrowing')
   await h.api('loans.record',{requestId:randomUUID(),mode:'new',kind:'drawdown',assetAccountId:h.assetAccountId,totalMinor:'600000',occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,allocations:[{loanId:cash.loanId,version:1,principalMinor:'600000',interestMinor:'0',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense'}]})
   assert.equal((await h.api('loans.get',{loanId:cash.loanId})).loan.remainingPrincipalMinor,'600000')
  })
  await t.test('旧历史一次费和回执保留，取消首期成对撤回，重新勾选不再推定一次费',async()=>{
   const before=await accounts(),amount=await expense()
   const input={...h.plan,requestId:randomUUID(),accountId:h.accountId,feeUpfrontMinor:'10000',baselinePrincipalMinor:'550000',repayments:[{periodNumber:1,paid:true}]}
   const history=await h.api('loans.create',input),contract=(await h.state(history)).contract
   // 合成旧版已保存事实：首期一次费、余额保全及历史结清金额同时存在。
   const transactionId=randomUUID(),adjustmentId=randomUUID(),chargeId=randomUUID(),provenance=JSON.stringify({kind:'loan',loanIds:[history.loanId]})
   await h.owner.execute(`INSERT INTO catledger_transactions(uid,transaction_id,type,source_account_id,amount_minor,category_id,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin,creation_provenance_json)
    VALUES(?,?,'expense',?,10000,?,'2026-01-31','2026-01-31 12:00:00',-480,'2026-01-31 04:00:00','合成旧历史一次费','loan_plan',?)`,[h.uid,transactionId,h.accountId,h.categoryId,provenance])
   await h.owner.execute(`INSERT INTO catledger_transactions(uid,transaction_id,type,destination_account_id,amount_minor,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin,creation_provenance_json)
    VALUES(?,?,'balance_adjustment',?,10000,'2026-01-31','2026-01-31 12:00:00',-480,'2026-01-31 04:00:00','合成旧历史余额保全','system',?)`,[h.uid,adjustmentId,h.accountId,provenance])
   await h.owner.execute(`INSERT INTO catledger_loan_charges(uid,charge_id,contract_id,charge_key,component,charge_date,amount_minor,category_id,state,basis,transaction_id,balance_adjustment_id,historical_settled_minor)
    VALUES(?,?,?,'upfront:fee','fee','2026-01-31',10000,?,'recorded','manual',?,?,10000)`,[h.uid,chargeId,contract.contractId,h.categoryId,transactionId,adjustmentId])
   assert.equal(await expense()-amount,12000n);assert.deepEqual(await accounts(),before)
   const saved=(await h.state(history)).items.find(i=>i.chargeId===chargeId)
   assert.deepEqual(await h.api('loans.create',input),history)
   assert.deepEqual((await h.state(history)).items.find(i=>i.chargeId===chargeId),saved)
   const unmark={requestId:randomUUID(),loanId:history.loanId,version:1,repayments:[{periodNumber:1,paid:false}]}
   const undone=await h.api('loans.confirmInstallments',unmark)
   assert.deepEqual(await h.api('loans.confirmInstallments',unmark),undone)
   assert.equal(await expense()-amount,0n);assert.deepEqual(await accounts(),before)
   const [removed]=await h.owner.execute('SELECT transaction_id,deleted_at FROM catledger_transactions WHERE uid=? AND transaction_id IN (?,?)',[h.uid,transactionId,adjustmentId])
   assert.equal(removed.length,2);assert.ok(removed.every(row=>row.deleted_at!=null))
   const current=await h.api('loans.installments',{loanId:history.loanId})
   await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:history.loanId,version:current.loanVersion,repayments:[{periodNumber:1,paid:true}]})
   const fee=(await h.state(history)).items.find(i=>i.chargeId===chargeId)
   assert.equal(fee.state,'planned');assert.equal(fee.transactionId,null);assert.equal(fee.balanceAdjustmentId,null);assert.equal(fee.historicalSettledMinor,'0')
   assert.equal(await expense()-amount,2000n);assert.deepEqual(await accounts(),before)
   assert.deepEqual(await h.api('loans.create',input),history)
   assert.equal(await expense()-amount,2000n)
  })
  await t.test('旧方案的费用分类停用后，逐期保存拒绝写入并保留进度和余额',async()=>{
   const previous=await h.create();await h.configure(previous)
   const current=await h.api('loans.installments',{loanId:previous.loanId}),before=await accounts(),amount=await expense()
   await h.owner.execute('UPDATE catledger_categories SET archived_at=CURRENT_TIMESTAMP(3) WHERE uid=? AND category_id=?',[h.uid,h.categoryId])
   try{
    await assert.rejects(h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:previous.loanId,version:current.loanVersion,repayments:[{periodNumber:1,paid:true}]}),{publicCode:'NOT_FOUND'})
    assert.deepEqual(await accounts(),before);assert.equal(await expense(),amount)
    assert.equal((await h.api('loans.installments',{loanId:previous.loanId})).summary.paidPeriods,0)
   }finally{await h.owner.execute('UPDATE catledger_categories SET archived_at=NULL WHERE uid=? AND category_id=?',[h.uid,h.categoryId])}
  })
  await t.test('旧36期全部展示且一次保存，第21期可取消；息费只补所选35期，余额与重试幂等',async()=>{
   const historical=await h.create({scheduleTerms:36,baselinePrincipalMinor:'0',installmentSetup:{...h.plan.installmentSetup,originalPrincipalMinor:'1800000',historicalPaidTerms:36}})
   const first=await h.api('loans.installments',{loanId:historical.loanId,pageSize:20})
   assert.equal(first.items.length,20);assert.equal(first.summary.repaymentPrompts.length,36)
   const next=await h.api('loans.installments',{loanId:historical.loanId,pageSize:20,cursor:first.nextCursor})
   assert.equal(next.items[0].periodNumber,21);assert.equal(next.summary.repaymentPrompts.length,36)
   const before=await accounts(),amount=await expense(),repayments=first.summary.repaymentPrompts.map(r=>({periodNumber:r.periodNumber,paid:r.periodNumber!==21}))
   const input={requestId:randomUUID(),loanId:historical.loanId,version:first.loanVersion,repayments}
   const result=await h.api('loans.confirmInstallments',input);assert.deepEqual(await h.api('loans.confirmInstallments',input),result)
   assert.deepEqual(await accounts(),before);assert.equal(await expense()-amount,70000n)
   const saved=await h.api('loans.installments',{loanId:historical.loanId,pageSize:40})
   assert.equal(saved.items.length,36);assert.equal(saved.summary.paidPeriods,35);assert.equal(saved.items[20].complete,false)
   assert.equal(saved.items[35].complete,true);assert.equal(saved.summary.repaymentPrompts.length,0)
   assert.equal((await h.api('loans.get',{loanId:historical.loanId})).loan.remainingPrincipalMinor,'50000')
  })
 }finally{await h.close()}
})
