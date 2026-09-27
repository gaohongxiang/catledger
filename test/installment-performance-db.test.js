const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {performance}=require('node:perf_hooks')
const {chargeLab}=require('./helpers/loan-charges'),{realPage}=require('./helpers/real-page')
const bytes=value=>Buffer.byteLength(JSON.stringify(value))
test('真实Page长计划读取与600期原子保存的同环境计量',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:180000},async t=>{
 const counts={schedule:0,view:0},engine=require('../cloudfunctions/catledger-api/src/loan-schedule/schedule-engine'),schedule=engine.buildSchedule
 engine.buildSchedule=(...args)=>{counts.schedule++;return schedule(...args)}
 const view=require('../cloudfunctions/catledger-api/src/installment-view'),build=view.buildView
 view.buildView=(...args)=>{counts.view++;return build(...args)}
 const h=await chargeLab()
 const measures=[]
 function meter(ui,page){
  const before=h.metrics(),derived={...counts},start=performance.now(),calls=ui.calls.length
  let responseBytes=0,maxResponseBytes=0,setDataBytes=0,maxSetDataBytes=0,sets=0
  const respond=ui.respond,setData=page.setData
  ui.respond=async(...args)=>{const prior=h.metrics(),started=performance.now(),derivation={...counts},r=await respond(...args),n=bytes(r);responseBytes+=n;maxResponseBytes=Math.max(maxResponseBytes,n);
   if(args[0]==='loans.confirmInstallments'){const after=h.metrics();t.diagnostic(JSON.stringify({name:'save-600-transaction',...Object.fromEntries(Object.keys(prior).map(k=>[k,after[k]-prior[k]])),schedule:counts.schedule-derivation.schedule,view:counts.view-derivation.view,requestBytes:bytes(args[1]),responseBytes:n,ms:Math.round((performance.now()-started)*10)/10}))}
   return r}
  page.setData=function(patch,cb){const n=bytes(patch);sets++;setDataBytes+=n;maxSetDataBytes=Math.max(maxSetDataBytes,n);return setData.call(this,patch,cb)}
  return name=>{ui.respond=respond;page.setData=setData;const after=h.metrics(),result={name,requests:ui.calls.length-calls,...Object.fromEntries(Object.keys(before).map(k=>[k,after[k]-before[k]])),responseBytes,maxResponseBytes,schedule:counts.schedule-derived.schedule,view:counts.view-derived.view,sets,setDataBytes,maxSetDataBytes,ms:Math.round((performance.now()-start)*10)/10};measures.push(result);t.diagnostic(JSON.stringify(result));return result}
 }
 async function detail(terms,historical){
  const principal=String(terms*50000),loan=await h.create({scheduleTerms:terms,baselinePrincipalMinor:historical?'0':principal,installmentSetup:{...h.plan.installmentSetup,originalPrincipalMinor:principal,historicalPaidTerms:historical?terms:0}})
  const ui=realPage(h),p=ui.page('loan-detail'),end=meter(ui,p);p.onLoad({loanId:loan.loanId});await p.load()
  assert.equal(p.data.errorMessage,'');assert.equal(p.data.detailError,'');assert.equal(p.data.repaymentChoiceCount,historical?terms:0)
  if(historical)assert.equal(p.data.periodRows.length,terms)
  const result=end('detail-'+terms)
  assert.ok(result.maxResponseBytes<=256*1024);assert.ok(result.maxSetDataBytes<=256*1024)
  assert.equal(ui.calls.filter(c=>c.action==='loans.installments').length,1)
  assert.equal(ui.calls.filter(c=>c.action==='loans.previewPlan').length,0)
  assert.equal(result.schedule,2);assert.equal(result.view,2)
  return {ui,p,loan}
 }
 try{
  await detail(12,false)
  const middle=await detail(36,true)
  await t.test('截断快照、过期版本和隐藏期间迟到响应均不能保存半份选择',async()=>{
   for(const broken of ['truncated','version']){
    const ui=realPage(h),respond=ui.respond,p=ui.page('loan-detail')
    ui.respond=async(action,data)=>{const result=await respond(action,data);if(action==='loans.installments'&&result.ok){if(broken==='truncated')result.data.snapshot.rows.pop();else result.data.loanVersion++}return result}
    p.onLoad({loanId:middle.loan.loanId});await p.load();assert.ok(p.data.detailError);assert.equal(p._detailView,null)
    await p.saveRepayments();assert.equal(ui.calls.filter(c=>c.action==='loans.confirmInstallments').length,0)
    ui.respond=respond;await p.refreshDetail();assert.equal(p.data.periodRows.length,36);assert.equal(p.data.detailError,'')
   }
   const ui=realPage(h),respond=ui.respond,p=ui.page('loan-detail');let release,entered
   const ready=new Promise(resolve=>entered=resolve)
   ui.respond=async(action,data)=>{const result=await respond(action,data);if(action==='loans.installments'){entered();await new Promise(resolve=>release=resolve)}return result}
   p.onLoad({loanId:middle.loan.loanId});const load=p.load();await ready;p.onHide();release();await load
   assert.equal(p.data.periodRows.length,0);await p.saveRepayments();assert.equal(ui.calls.filter(c=>c.action==='loans.confirmInstallments').length,0)
   ui.respond=respond;await p.load();assert.equal(p.data.periodRows.length,36)
  })
  middle.p.selectRepayments({detail:{value:Array.from({length:36},(_,i)=>i+1).filter(n=>n!==21).map(String)}})
  await h.owner.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[h.uid,middle.loan.loanId])
  await middle.p.refreshDetail();assert.equal(middle.p.data.repaymentRows.find(r=>r.periodNumber===21).paid,false)
  assert.equal(await middle.p.saveRepayments(),true)
  const check=await h.api('loans.installments',{loanId:middle.loan.loanId,pageSize:40})
  assert.equal(check.summary.paidPeriods,35);assert.equal(check.items[20].complete,false)
  const long=await detail(600,true),before=(await h.api('accounts.list')).accounts
  await t.test('第300期故障回滚全部600期，保留草稿后原意图重试',async()=>{
   await h.owner.query("CREATE TRIGGER fail_long_history BEFORE INSERT ON catledger_loan_charge_audit FOR EACH ROW BEGIN IF NEW.action='confirm_settlement' AND JSON_EXTRACT(NEW.snapshot_json,'$.periodNumber')=300 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic long rollback'; END IF; END")
   try{assert.equal(await long.p.saveRepayments(),undefined);assert.ok(long.p.data.errorMessage)}finally{await h.owner.query('DROP TRIGGER fail_long_history')}
   assert.equal(long.p.data.repaymentRows.length,600);assert.deepEqual((await h.api('accounts.list')).accounts,before)
   assert.equal((await h.state(long.loan)).items.length,0)
   const current=await h.api('loans.get',{loanId:long.loan.loanId});assert.equal(current.loan.version,1)
   long.ui.calls.length=0
  })
  const end=meter(long.ui,long.p)
  assert.equal(await long.p.saveRepayments(),true);end('save-600-with-refresh')
  const command=long.ui.calls.find(c=>c.action==='loans.confirmInstallments').data
  assert.equal(command.repayments.length,600)
  const stable=(await h.api('accounts.list')).accounts;assert.deepEqual(stable,before)
  const [[saved]]=await h.owner.execute('SELECT progress_json AS progress FROM catledger_loans WHERE uid=? AND loan_id=?',[h.uid,long.loan.loanId])
  assert.equal(Object.keys((typeof saved.progress==='string'?JSON.parse(saved.progress):saved.progress).historyFacts).length,600)
  await h.api('loans.confirmInstallments',command);assert.deepEqual((await h.api('accounts.list')).accounts,stable)
  const {insertItem}=require('../cloudfunctions/catledger-api/src/installment-items')
  for(let index=0;index<8;index++){
   const loan=await h.create({scheduleTerms:36,baselinePrincipalMinor:'1800000',installmentSetup:{...h.plan.installmentSetup,originalPrincipalMinor:'1800000'}})
   for(let n=1;n<=36;n++){
    const expense=await h.expense('2026-01-01')
    await insertItem(h.owner,h.uid,{accountId:h.accountId,loanId:loan.loanId,periodNumber:n,totalTerms:36,component:'interest',amountMinor:'2000',occurredDate:'2026-01-01',origin:'manual',transactionId:expense.transactionId})
   }
   for(let n=1;n<=3;n++)await h.api('loans.record',{requestId:randomUUID(),simplePeriod:true,mode:'new',kind:'repayment',assetAccountId:h.assetAccountId,totalMinor:'52000',occurredLocalAt:'2026-04-01T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
    allocations:[{loanId:loan.loanId,version:n,period:{periodNumber:n,version:1},principalMinor:'50000',interestMinor:'2000',feeMinor:'0',interestTreatment:'accrued',feeTreatment:'accrued'}]})
  }
  const ui=realPage(h),p=ui.page('loans'),finish=meter(ui,p);p.onLoad({});await p.loadLoans();assert.equal(p.data.errorMessage,'');assert.equal(p.data.items.length,11);finish('list-11-with-288-sources-24-payments')
 }finally{await h.close();engine.buildSchedule=schedule;view.buildView=build}
})
