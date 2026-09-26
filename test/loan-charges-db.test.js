const test=require('node:test')
const assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {isolatedMysql}=require('../scripts/isolated-mysql')
const grants=require('../scripts/runtime-role-grants')
const {localServices,call}=require('./helpers/local-services')
const plan={name:'合成收费合同',kind:'installment',baselinePrincipalMinor:'600000',baselineDate:'2026-01-01',scheduleMethod:'flat',scheduleTerms:12,
 measurementKind:'repayment',repaymentMinor:'52000',firstPaymentDate:'2026-01-31',generatePlan:true,confirmed:true,
 installmentSetup:{schema:1,originalPrincipalMinor:'600000',historicalPaidTerms:0,recordType:'credit_card',discountKind:null,discountValue:null}}
const auth={confirmed:true,originKind:'recorded_consumption',mode:'auto',historyChoice:'catch_up',fromDate:'2026-01-01',throughDate:'2026-12-31',
 firstChargeDate:'2026-01-01',fixedConfirmed:true,dateConfirmed:true,coverageConfirmed:true}

test('A1 收费身份、授权与历史覆盖：真实 MySQL / 最小权限',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const lab=await isolatedMysql()
 try {
  const apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',grants.importer)
  const services=localServices({apiPool,importPool,subject:'synthetic-loan-charge'}),api=(a,d)=>call(services.api,a,d)
  const {uid}=await api('bootstrap'),catalog=await api('catalog.get')
  const categoryId=catalog.categories.find(c=>c.kind==='expense').id
  const {accountId}=await api('accounts.create',{requestId:randomUUID(),type:'credit',name:'合成收费信用卡',openingDisplayBalanceMinor:'600000',occurredLocalAt:'2026-01-01T00:00:00',timezoneOffsetMinutes:-480})
  const create=(extra={})=>api('loans.create',{...plan,accountId,...extra,requestId:randomUUID()})
  const config=(loan,extra={})=>api('loans.configureCharges',{...auth,loanId:loan.loanId,version:loan.version,interestCategoryId:categoryId,feeCategoryId:categoryId,...extra,requestId:randomUUID()})
  const totals=async()=>{const [[r]]=await lab.owner.execute("SELECT COUNT(*) AS n,COALESCE(SUM(amount_minor),0) AS total FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL",[uid]);return [Number(r.n),String(r.total)]}
  const first=await create()
  await t.test('L01/L03 建资料与费用预览均不产生本金、未来费用或付款；旧贷款默认无授权',async()=>{
   const view=await api('loans.chargePlan',{loanId:first.loanId,configuration:{...auth,interestCategoryId:categoryId}})
   assert.equal(view.contract,null);assert.equal(view.preview.length,12);assert.deepEqual(await totals(),[0,'0'])
   assert.equal(view.preview[1].amountMinor,'2000');assert.equal(view.preview[1].chargeDate,'2026-02-01')
   await assert.rejects(config(first,{coverageConfirmed:false}),{publicCode:'VALIDATION_ERROR'})
   assert.equal((await api('loans.chargePlan',{loanId:first.loanId})).contract,null)
  })
  let configured
  await t.test('L06 先有无 loanId 费用，明确认领后只登记覆盖；账户或金额错误原子拒绝',async()=>{
   const tx=await api('transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:accountId,categoryId,amountMinor:'2000',occurredLocalAt:'2026-01-01T12:00:00',timezoneOffsetMinutes:-480,note:'合成已记利息'})
   await assert.rejects(config(first,{coverage:[{chargeKey:'period:2:interest',transactionId:randomUUID()}]}),{publicCode:'LOAN_SOURCE_MISMATCH'})
   configured=await config(first,{coverage:[{chargeKey:'period:1:interest',transactionId:tx.transactionId}]})
   const view=await api('loans.chargePlan',{loanId:first.loanId})
   assert.equal(view.items[0].state,'recorded');assert.equal(view.items[0].transactionId,tx.transactionId);assert.equal(view.items[0].basis,'actual')
   assert.deepEqual(await totals(),[1,'2000'])
  })
  await t.test('L13 修订版本/换请求号不改变费用键，不覆盖已记历史，不生成费用',async()=>{
   const before=await api('loans.chargePlan',{loanId:first.loanId})
   configured=await config(configured)
   const after=await api('loans.chargePlan',{loanId:first.loanId})
   assert.deepEqual(after.items.map(i=>i.chargeId),before.items.map(i=>i.chargeId))
   assert.equal(after.contract.planVersion,2);assert.deepEqual(await totals(),[1,'2000'])
   await assert.rejects(lab.owner.execute(`INSERT INTO catledger_loan_charges(uid,charge_id,contract_id,charge_key,component,charge_date,amount_minor)
    VALUES(?,?,?,'period:1:interest','interest','2026-01-01',2000)`,[uid,randomUUID(),configured.contractId]),{code:'ER_DUP_ENTRY'})
  })
  await t.test('L04/L14 起算与本金基准分开，历史期初费用有覆盖且不增加负债',async()=>{
   const second=await create({name:'合成不补历史'})
   await config(second,{fromDate:'2026-04-01',historyChoice:'continue',baselineCoveredThrough:'2026-03-31'})
   const view=await api('loans.chargePlan',{loanId:second.loanId})
   assert.equal(view.items.filter(i=>i.state==='baseline').length,3)
   assert.equal(view.items[3].state,'planned');assert.deepEqual(await totals(),[1,'2000'])
  })
  await t.test('L07 一次实收覆盖12个分摊，同一交易不能再认领第二个收费',async()=>{
   const third=await create({name:'合成一次费用'}),tx=await api('transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:accountId,categoryId,amountMinor:'24000',occurredLocalAt:'2026-01-01T12:00:00',timezoneOffsetMinutes:-480})
   await config(third,{oneOffCharges:[{key:'full-interest',component:'interest',chargeDate:'2026-01-01',amountMinor:'24000',transactionId:tx.transactionId,covers:Array.from({length:12},(_,i)=>'period:'+(i+1)+':interest')}]})
   const view=await api('loans.chargePlan',{loanId:third.loanId})
   assert.equal(view.items.filter(i=>i.state==='covered').length,12);assert.equal(view.recordedMinor,'24000')
   assert.equal(view.items.filter(i=>i.transactionId===tx.transactionId).length,1)
  })
  await t.test('L17 身份取可信会话，跨用户及新表越权写被拒绝，审计只追加',async()=>{
   const other=localServices({apiPool,importPool,subject:'synthetic-loan-charge-other'});await call(other.api,'bootstrap')
   await assert.rejects(call(other.api,'loans.chargePlan',{loanId:first.loanId}),{publicCode:'NOT_FOUND'})
   await assert.rejects(apiPool.execute('DELETE FROM catledger_loan_charge_audit WHERE uid=?',[uid]),{code:'ER_TABLEACCESS_DENIED_ERROR'})
   const [[audit]]=await lab.owner.execute('SELECT COUNT(*) n FROM catledger_loan_charge_audit WHERE uid=?',[uid]);assert.ok(Number(audit.n)>=4)
  })
  await t.test('L13/L18 归档暂停授权、重建必须认领原合同；普通删除不能拆掉收费关系',async()=>{
   const before=await api('loans.chargePlan',{loanId:first.loanId}),recorded=before.items.find(i=>i.transactionId)
   await assert.rejects(api('transactions.delete',{requestId:randomUUID(),transactionId:recorded.transactionId,version:recorded.transactionVersion}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
   await api('loans.archiveInstallment',{requestId:randomUUID(),loanId:first.loanId,version:before.loanVersion,archived:true})
   assert.equal((await api('loans.chargePlan',{loanId:first.loanId})).contract.authorization.mode,'paused')
   const replacement=await create({name:'合成重建合同'})
   await assert.rejects(config(replacement),{publicCode:'LOAN_COVERAGE_REQUIRED'})
   const claimed=await config(replacement,{contractId:before.contract.contractId})
   assert.equal(claimed.contractId,before.contract.contractId)
   const after=await api('loans.chargePlan',{loanId:replacement.loanId})
   assert.deepEqual(after.items.map(i=>i.chargeId),before.items.map(i=>i.chargeId));assert.equal(after.items[0].transactionId,recorded.transactionId)
  })
 }finally{await lab.close()}
})
