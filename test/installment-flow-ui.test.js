const test=require('node:test'),assert=require('node:assert/strict')
const {runtime}=require('./helpers/read-runtime')
const event=value=>({currentTarget:{dataset:value}})
const loan={loanId:'synthetic-loan',accountId:'credit',kind:'installment',version:2,name:'合成分期',scheduleMethod:'flat',scheduleTerms:12,measurementKind:'repayment',repaymentMinor:'203909',firstPaymentDate:'2025-10-31',remainingPrincipalMinor:'2400000',baselinePrincipalMinor:'2400000',installmentSetup:{schema:1,originalPrincipalMinor:'2400000',historicalPaidTerms:0}}
test('账单来源带出已还期数与总期数（借款金额留空待填），首期还款日按第N期反推；未保存不写账',async()=>{
  const h=runtime(),p=h.page('loan-form');h.accounts=[{accountId:'credit',type:'credit',name:'合成卡',archived:false}]
  h.respond=action=>action==='loans.installmentSources'?{ok:true,data:{items:[{itemId:'source',accountId:'credit',periodNumber:10,totalTerms:12,component:'principal',amountMinor:'200000',occurredDate:'2026-07-31',referenceLabel:'合成分期'}],nextCursor:null}}:undefined
  p.onLoad({sourceItemId:'source'});await p.load()
  assert.equal(p.data.sourceLocked,true);assert.equal(p.data.sourceReady,true)
  // 账单锚点：出现第 10 期 → 第 1~10 期已还（可改）。
  assert.equal(p.data.paidTerms,'10');assert.equal(h.calls.some(c=>c.action==='loans.create'),false);assert.equal(p.data.schedule.terms,'12')
  // 借款金额不预填估算（账单只给某一期本金，×期数只对等本等息近似），留空由用户按合同填写；首期还款日 = 第10期(2026-07)=2025-10。
  assert.equal(p.data.principalYuan,'');assert.equal(p.data.schedule.firstPaymentDate,'2025-10-31')
  // 首期还款日在所有场景都显示、可改（含账单来源），只是初值按第 N 期反推。
  assert.equal(p.data.showFirstPaymentDate,true)
  assert.equal(p.data.accounts[p.data.accountIndex].accountId,'credit')
})
test('手动创建分期：无账单来源时显示首期还款日，按已还期数一次保存并预填',async()=>{
  const {fullScheduleWithPaid}=require('../cloudfunctions/catledger-api/src/loan-installment')
  const h=runtime(),p=h.page('loan-form');h.accounts=[{accountId:'credit',type:'credit',name:'合成卡',archived:false}]
  h.respond=(action,data)=>action==='loans.previewPlan'?{ok:true,data:fullScheduleWithPaid(data,{})}:action==='loans.create'?{ok:true,data:{loanId:'new-synthetic-loan'}}:undefined
  p.onLoad({accountId:'credit'});await p.load()
  assert.equal(p.data.showFirstPaymentDate,true)
  p.setData({name:'合成分期',principalYuan:'36000',paidTerms:'36','schedule.terms':'36','schedule.repaymentYuan':'1100','schedule.firstPaymentDate':'2023-01-31'})
  await p.preview()
  // 全期口径（不按已还切掉）：表单预览最多展示前 24 期（超出有截断提示），且全部标已还；剩余本金 0。
  assert.equal(p.data.preview.rows.length,24);assert.ok(p.data.preview.rows.every(r=>r.paid));assert.equal(p.data.remainingText,'¥0.00')
  await p.save()
  const writes=h.calls.filter(c=>c.action==='loans.create');assert.equal(writes.length,1)
  // 不再传逐期 repayments；本金基点 = 借款金额，已还期数写进 setup。
  assert.equal(writes[0].data.repayments,undefined)
  assert.equal(writes[0].data.baselinePrincipalMinor,'3600000');assert.equal(writes[0].data.installmentSetup.historicalPaidTerms,36)
  assert.equal(h.modals.length,0)
})
test('来源读取迟到时不能回填已关闭的期次弹层',async()=>{
  const h=runtime(),p=h.page('loan-detail');p._loanId='synthetic-loan';p._readSession=h.cache.getSession();p.data.detail={tracking:true}
  let release;h.respond=action=>action==='loans.installment'?new Promise(r=>release=r):undefined
  const task=p.openInstallment(event({term:11}));await new Promise(r=>setImmediate(r));p.closeInstallment()
  release({ok:true,data:{loanVersion:1,period:{periodNumber:11},sources:[],legacyPayments:[]}});await task
  assert.equal(p.data.periodOpen,false);assert.equal(p.data.selectedPeriod,null)
})
test('删除一次确认展示实际影响；取消无写入，成功后读取列表并返回',async()=>{
  const h=runtime(),p=h.page('loan-detail');p._loanId=loan.loanId;p._readSession=h.cache.getSession();p.data.loan=loan
  h.respond=action=>action==='loans.deleteImpact'?{ok:true,data:{loanId:loan.loanId,version:2,canDelete:true,counts:{repayments:3,fees:2},previewToken:'synthetic-preview'}}:action==='loans.delete'?{ok:true,data:{loanId:loan.loanId,version:3,deleted:true}}:undefined
  const cancelled=p.archiveInstallment();await new Promise(r=>setImmediate(r));h.modals.at(-1).success({confirm:false});await cancelled
  assert.equal(h.calls.filter(c=>c.action==='loans.delete').length,0)
  const saved=p.archiveInstallment();await new Promise(r=>setImmediate(r));const modal=h.modals.at(-1)
  assert.match(modal.content,/3笔还款和2笔费用/);assert.match(modal.content,/已核实的导入记录保留/)
  modal.success({confirm:true});await saved
  assert.equal(h.calls.filter(row=>row.action==='loans.delete').length,1)
  assert.ok(h.calls.every(row=>!row.action.startsWith('transactions.')||row.action==='transactions.commandResult'))
  assert.deepEqual(h.navigation,['back']);assert.deepEqual(h.toasts,['已删除'])
})

test('期次弹层打开即带出可编辑草稿与合计，直接改数值保存走 savePeriod',async()=>{
  const h=runtime(),p=h.page('loan-detail');h.accounts=[{accountId:'credit',type:'credit',name:'合成卡',archived:false}]
  h.respond=(action,data)=>{
    if(action==='loans.get')return {ok:true,data:{loan}}
    if(action==='loans.installments')return {ok:true,data:{loanVersion:2,items:[],summary:{paidPeriods:0,completedThrough:0,unpaidPrincipalMinor:'0',unpaidInterestMinor:'0',unpaidFeeMinor:'0'},nextCursor:null}}
    if(action==='loans.installment')return {ok:true,data:{loanVersion:2,period:{periodNumber:3,dueDate:'2026-06-25',principalMinor:'175000',interestMinor:'19740',feeMinor:'0'},sources:[],legacyPayments:[]}}
    if(action==='loans.savePeriod')return {ok:true,data:{loanId:loan.loanId,version:3}}
  }
  p.onLoad({loanId:loan.loanId});await p.load();await p.openInstallment(event({term:3}))
  // 打开即带出草稿（不用再点“修改”）
  assert.equal(p.data.periodDraft.principal,'1750.00');assert.equal(p.data.periodDraft.interest,'197.40')
  assert.equal(p.data.periodDraftTotal,'¥1,947.40')
  // 直接改本金，合计实时更新
  p.periodDraftInput({currentTarget:{dataset:{field:'principal'}},detail:{value:'1800.00'}})
  assert.equal(p.data.periodDraftTotal,'¥1,997.40')
  await p.saveInstallmentPeriod()
  const write=h.calls.find(c=>c.action==='loans.savePeriod')
  assert.ok(write);assert.equal(write.data.principalMinor,'180000');assert.equal(write.data.periodNumber,3)
})
