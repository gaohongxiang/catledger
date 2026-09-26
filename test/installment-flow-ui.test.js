const test=require('node:test'),assert=require('node:assert/strict')
const {runtime}=require('./helpers/read-runtime')
const event=value=>({currentTarget:{dataset:value}})
const loan={loanId:'synthetic-loan',accountId:'credit',kind:'installment',version:2,name:'合成分期',scheduleMethod:'flat',scheduleTerms:12,measurementKind:'repayment',repaymentMinor:'203909',firstPaymentDate:'2025-10-31',remainingPrincipalMinor:'2400000',baselinePrincipalMinor:'2400000',installmentSetup:{schema:1,originalPrincipalMinor:'2400000',historicalPaidTerms:0}}
test('单期已还提交合并记息命令，保存后重新读取；不弹二次确认或跳转',async()=>{
  const h=runtime(),p=h.page('loan-detail');h.accounts=[{accountId:'credit',type:'credit',name:'合成卡',archived:false}]
  h.respond=(action,data)=>{
    if(action==='loans.get')return {ok:true,data:{loan}}
    if(action==='loans.previewPlan')return {ok:true,data:{periods:[]}}
    if(action==='loans.installments')return {ok:true,data:{loanVersion:2,items:[],summary:{paidPeriods:10,completedThrough:10,unpaidPrincipalMinor:'400000',unpaidInterestMinor:'7818',unpaidFeeMinor:'0'},nextCursor:null}}
    if(action==='loans.installment')return {ok:true,data:{loanVersion:2,period:{periodNumber:11,dueDate:'2026-08-31',principalMinor:'200000',interestMinor:'3909',feeMinor:'0',status:'missing',stateText:'缺少账单，待补充'},sources:[],legacyPayments:[]}}
    if(action==='loans.confirmInstallments')return {ok:true,data:{loanId:loan.loanId,version:3}}
  }
  p.onLoad({loanId:loan.loanId});await p.load();await p.openInstallment(event({term:11}))
  assert.equal(p.data.selectedPeriod.term,11);assert.equal(p.data.periodCanBook,true)
  await p.setPeriodStatus(event({status:'completed'}))
  const writes=h.calls.filter(c=>c.action==='loans.confirmInstallments');assert.equal(writes.length,1)
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].data.repayments)),[{periodNumber:11,paid:true}]);assert.equal(h.modals.length,0)
  assert.equal(p.data.periodOpen,false);assert.equal(h.navigation.length,0)
  assert.deepEqual(h.toasts,['已更新']);assert.equal(p.data.savedMessage,'')
  assert.ok(h.calls.filter(c=>c.action==='loans.installments').length>=2)
})
test('账单所在期次预选为接入范围；未保存不写账，不推算未知总本金',async()=>{
  const h=runtime(),p=h.page('loan-form');h.accounts=[{accountId:'credit',type:'credit',name:'合成卡',archived:false}]
  h.respond=action=>action==='loans.installmentSources'?{ok:true,data:{items:[{itemId:'source',accountId:'credit',periodNumber:10,totalTerms:12,component:'principal',amountMinor:'200000',occurredDate:'2026-07-31',referenceLabel:'合成分期'}],nextCursor:null}}:undefined
  p.onLoad({sourceItemId:'source'});await p.load()
  assert.equal(p.data.sourceLocked,true);assert.equal(p.data.sourceReady,true);assert.equal(p.data.paidTerms,'10');assert.equal(h.calls.some(c=>c.action==='loans.create'),false);assert.equal(p.data.schedule.terms,'12')
  assert.equal(p.data.principalYuan,'');assert.equal(p.data.schedule.firstPaymentDate,'')
  assert.equal(p.data.accounts[p.data.accountIndex].accountId,'credit')
})
test('来源读取迟到时不能回填已关闭的期次弹层',async()=>{
  const h=runtime(),p=h.page('loan-detail');p._loanId='synthetic-loan';p._readSession=h.cache.getSession();p.data.detail={tracking:true}
  let release;h.respond=action=>action==='loans.installment'?new Promise(r=>release=r):undefined
  const task=p.openInstallment(event({term:11}));await new Promise(r=>setImmediate(r));p.closeInstallment()
  release({ok:true,data:{loanVersion:1,period:{periodNumber:11},sources:[],legacyPayments:[]}});await task
  assert.equal(p.data.periodOpen,false);assert.equal(p.data.selectedPeriod,null)
})
test('删除说明保留账单和金额；取消无写入，确认只发分期解除请求并返回',async()=>{
  const h=runtime(),p=h.page('loan-detail');p._loanId=loan.loanId;p._readSession=h.cache.getSession();p.data.loan=loan
  h.respond=action=>action==='loans.archiveInstallment'?{ok:true,data:{loanId:loan.loanId,version:3,archived:true}}:undefined
  const cancelled=p.archiveInstallment();h.modals.at(-1).success({confirm:false});await cancelled
  assert.equal(h.calls.length,0)
  const saved=p.archiveInstallment(),modal=h.modals.at(-1)
  assert.match(modal.content,/解除关联/);assert.match(modal.content,/账单和已入账金额保留/)
  modal.success({confirm:true});await saved
  assert.equal(h.calls.filter(row=>row.action==='loans.archiveInstallment').length,1)
  assert.ok(h.calls.every(row=>!row.action.startsWith('transactions.')||row.action==='transactions.commandResult'))
  assert.deepEqual(h.navigation,['back']);assert.deepEqual(h.toasts,['已删除'])
})
