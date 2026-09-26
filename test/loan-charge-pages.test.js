const test=require('node:test'),assert=require('node:assert/strict')
const {runtime}=require('./helpers/read-runtime')
const tick=()=>new Promise(resolve=>setImmediate(resolve)),ok=data=>({ok:true,data})
function ledger(h,count=81) {
 const receipts=new Map(),requests=[],dates=[];let remaining=count,failAt=0,loseAt=0,attempt=0
 h.respond=async(action,data)=>{
  if(action==='loans.dueCharges')return ok({count:remaining,cutoff:'2026-09-26'})
  if(action==='transactions.commandResult')return receipts.has(data.requestId)?ok({action:'loans.syncCharges',result:receipts.get(data.requestId)}):{ok:false,error:{code:'OPERATION_UNCONFIRMED'}}
  if(action==='loans.syncCharges'){
   requests.push(data.requestId);attempt++
   if(receipts.has(data.requestId))return ok(receipts.get(data.requestId))
   if(attempt===failAt)throw new Error('synthetic network failure')
   const n=Math.min(remaining,40);remaining-=n;dates.push(n)
   const result={createdCount:n,hasMore:remaining>0};receipts.set(data.requestId,result)
   if(attempt===loseAt)throw new Error('synthetic response lost')
   return ok(result)
  }
 }
 return {requests,dates,receipts,remaining:()=>remaining,fail:value=>{failAt=value},lose:value=>{loseAt=value}}
}
test('L16 真实首页：第二批失败可见，下一次同一原键重试；已完成40项不重做',async()=>{
 const h=runtime(),state=ledger(h),p=h.page('index');state.fail(2);p.onLoad();await p.loadDashboard()
 assert.equal(state.remaining(),41);assert.match(p.data.chargeSyncMessage,/未完成/);assert.equal(p.data.hasDashboard,true)
 const packet=h.load('services/pending-ledger-write').pending();assert.equal(packet.payload.requestId,state.requests[1])
 await p.loadDashboard()
 assert.equal(state.remaining(),0);assert.deepEqual(state.dates,[40,40,1]);assert.equal(state.requests[1],state.requests[2]);assert.equal(p.data.chargeSyncComplete,true)
 assert.equal(h.load('services/pending-ledger-write').pending(),null)
})
test('L16 写入成功响应丢失，页面重启先查回执，不重发已完成批次',async()=>{
 const h=runtime(),state=ledger(h,2),p=h.page('index');state.lose(1);p.onLoad();await p.loadDashboard()
 assert.equal(state.remaining(),0);assert.match(p.data.chargeSyncMessage,/未完成/)
 p.onHide();await p.loadDashboard();assert.equal(state.requests.length,1);assert.equal(p.data.chargeSyncComplete,true)
 assert.ok(h.calls.some(c=>c.action==='transactions.commandResult'))
})
test('L16 多入口共享同步；三批上限可见，摘要失败不回滚费用或清除未完成提示',async()=>{
 const h=runtime(),state=ledger(h,150),original=h.respond
 h.respond=(action,data)=>action==='dashboard.get'?{ok:false,error:{code:'INTERNAL_ERROR',message:'synthetic summary failure'}}:original(action,data)
 const home=h.page('index'),stats=h.page('statistics');home.onLoad();stats.onLoad()
 await Promise.all([home.loadDashboard(),stats.loadStatistics()])
 assert.deepEqual(state.dates,[40,40,40]);assert.equal(state.remaining(),30)
 assert.match(home.data.chargeSyncMessage,/未完成/);assert.match(stats.data.chargeSyncMessage,/未完成/);assert.equal(home.data.hasDashboard,false)
 assert.equal(h.load('services/pending-ledger-write').pending(),null)
})
test('L16 隐藏/换用户的迟到读取不能开始新费用写入，旧finally不能清除新用户请求',async()=>{
 const h=runtime(),p=h.page('index');p.onLoad();let releaseOld,releaseNew,reads=0
 h.respond=action=>action==='loans.dueCharges'?new Promise(resolve=>{if(++reads===1)releaseOld=resolve;else releaseNew=resolve}):undefined
 const old=p.loadDashboard();await tick();p.onHide();h.cache.reset();h.app.globalData.uid=h.uid='1234567891';const next=p.loadDashboard();await tick()
 const newFlight=p._dashboardLoad;releaseOld(ok({count:2,cutoff:'2026-09-26'}));await old
 assert.equal(h.calls.filter(c=>c.action==='loans.syncCharges').length,0);assert.equal(p._dashboardLoad,newFlight)
 releaseNew(ok({count:0,cutoff:'2026-09-26'}));await next;assert.equal(p.data.hasDashboard,true)
})
test('L16 后台停止下一批；保留成功回执后前台继续',async()=>{
 const h=runtime(),state=ledger(h,45),original=h.respond
 h.respond=async(action,data)=>{const result=await original(action,data);if(action==='loans.syncCharges')h.app.globalData.chargeSyncForeground=false;return result}
 const sync=h.load('services/loan-charge-sync');const first=await sync.run()
 assert.equal(first.complete,false);assert.deepEqual(state.dates,[40]);assert.equal(state.remaining(),5)
 h.app.globalData.chargeSyncForeground=true;h.respond=original;assert.equal((await sync.run()).complete,true);assert.deepEqual(state.dates,[40,5])
})
test('L16 一次确认与全局同步范围串行，不被正在执行的全局无缺项覆盖',async()=>{
 const h=runtime(),sync=h.load('services/loan-charge-sync');let resolve,read=0
 h.respond=(action,data)=>{
  if(action==='loans.dueCharges'){read++;if(read===1)return new Promise(r=>resolve=r);return ok({count:0,cutoff:'2026-09-26'})}
 }
 const global=sync.run(),once=sync.run({contractId:'one-synthetic-contract'});await tick();resolve(ok({count:0,cutoff:'2026-09-26'}));await Promise.all([global,once])
 assert.equal(h.calls.filter(c=>c.action==='loans.dueCharges').length,2)
 assert.equal(h.calls.at(-1).data.contractId,'one-synthetic-contract');assert.equal(h.calls.at(-1).data.confirmed,true)
})
test('L16 普通读取与导出不触发同步，不消费其他页面的未决账务请求',async()=>{
 const h=runtime(),state=ledger(h,4)
 await h.api.callApi('dashboard.get',{month:'2026-09'});assert.equal(state.requests.length,0);assert.equal(h.calls.some(c=>c.action==='loans.dueCharges'),false)
 const pending=h.load('services/pending-ledger-write'),original=h.respond
 h.respond=(action,data)=>{if(action==='transactions.create')throw new Error('synthetic lost');return original(action,data)}
 await assert.rejects(pending.send('api','transactions.create',{type:'expense',amountMinor:'2000'}))
 const prior=pending.pending();const result=await h.load('services/loan-charge-sync').run()
 assert.equal(result.complete,false);assert.match(result.message,/上次账务/);assert.deepEqual(pending.pending(),prior);assert.equal(state.requests.length,0)
})
const loan={loanId:'synthetic-loan',accountId:'credit',kind:'installment',version:2,name:'合成分期',scheduleMethod:'flat',scheduleTerms:12,measurementKind:'repayment',repaymentMinor:'52000',firstPaymentDate:'2026-01-31',remainingPrincipalMinor:'600000',baselinePrincipalMinor:'600000',installmentSetup:{schema:1,originalPrincipalMinor:'600000',historicalPaidTerms:0}}
function detail(){
 const h=runtime(),p=h.page('loan-detail');h.accounts=[{accountId:'credit',type:'credit',name:'合成卡',archived:false}]
 h.respond=(action,data)=>{
  if(action==='loans.get')return ok({loan})
  if(action==='loans.previewPlan')return ok({periods:[{dueDate:'2026-12-31'}]})
  if(action==='loans.installments')return ok({loanVersion:2,items:[],summary:{paidPeriods:0,manualThrough:0,completedThrough:0,unpaidPrincipalMinor:'600000',unpaidInterestMinor:'24000',unpaidFeeMinor:'0'},nextCursor:null})
  if(action==='loans.chargePlan'&&data.configuration)return ok({preview:[],previewAmountMinor:'24000',previewCount:12,duePreviewCount:6,duePreviewMinor:'12000'})
  if(action==='loans.configureCharges')return ok({contractId:'synthetic-contract',version:3})
 }
 p.onLoad({loanId:loan.loanId});return {h,p}
}
test('还款记录按需读取与有界翻页；记录和跨期还款可直接打开，返回刷新仍不写账',async()=>{
 const {h,p}=detail(),base=h.respond
 let version=1
 h.respond=(action,data)=>action==='loans.payments'?ok({items:[{paymentId:data.cursor?'older':'latest-'+version,kind:'repayment',totalMinor:'52000',occurredLocalAt:'2026-09-01T12:00:00'}],nextCursor:data.cursor?null:'older-page'}):base(action,data)
 await p.load();assert.equal(p.data.detailTab,'schedule');assert.equal(h.calls.some(c=>c.action==='loans.payments'),false)
 await p.showPaymentHistory();assert.equal(p.data.detailTab,'history');assert.equal(p.data.history[0].paymentId,'latest-1')
 p.openPayment({currentTarget:{dataset:{id:'latest-1'}}});assert.match(h.navigation.at(-1),/paymentId=latest-1$/)
 p.recordPayment();assert.match(h.navigation.at(-1),/loan-payment\/index\?loanId=synthetic-loan$/)
 await p.loadHistory({currentTarget:{dataset:{next:true}}});assert.equal(p.data.history.length,1);assert.equal(p.data.history[0].paymentId,'older');assert.equal(p.data.historyCursor,'older-page')
 version=2;p.onHide();p.onShow();await p._load;assert.equal(p.data.detailTab,'history');assert.equal(p.data.history[0].paymentId,'latest-2');assert.equal(p.data.historyCursor,null)
 p.showPeriodTable();assert.equal(p.data.detailTab,'schedule')
 assert.equal(h.calls.some(c=>['loans.record','loans.configureCharges','loans.setInstallmentProgress'].includes(c.action)),false)
})
test('还款记录读取中离开再返回可重新读取；旧响应和换用户不能回填原记录',async()=>{
 const {h,p}=detail(),base=h.respond;await p.load()
 let release
 h.respond=(action,data)=>action==='loans.payments'?(data.cursor?new Promise(resolve=>release=resolve):ok({items:[],nextCursor:'older-page'})):base(action,data)
 await p.showPaymentHistory();const old=p.loadHistory({currentTarget:{dataset:{next:true}}});await tick();p.onHide()
 h.respond=(action,data)=>action==='loans.payments'?ok({items:[{paymentId:'new',kind:'repayment',totalMinor:'100',occurredLocalAt:'2026-09-02'}],nextCursor:null}):base(action,data)
 p.onShow();await p._load;assert.equal(p.data.historyLoading,false);assert.equal(p.data.history[0].paymentId,'new')
 release(ok({items:[{paymentId:'old',totalMinor:'100'}],nextCursor:'old-next'}));await old
 assert.equal(p.data.history[0].paymentId,'new');assert.equal(p.data.historyNext,null)
 h.cache.reset();h.uid='9876543210';h.app.globalData.uid=h.uid;await p.load()
 assert.equal(p.data.detailTab,'schedule');assert.equal(p.data.history.length,0);assert.equal(p.data.historyLoaded,false)
})
test('从第十期调整中批量确认带入1至10期，取消不写，保存仍须确认范围',async()=>{
 const {h,p}=detail();await p.load();p.setData({periodOpen:true})
 p.openProgress({currentTarget:{dataset:{term:10}}});assert.equal(p.data.periodOpen,false);assert.equal(p.data.progressOpen,true);assert.equal(p.data.progressThrough,'10')
 assert.equal(h.calls.some(c=>c.action==='loans.setInstallmentProgress'),false)
 const cancelled=p.saveProgress();assert.match(h.modals.at(-1).content,/第1至10期/);h.modals.at(-1).success({confirm:false});await cancelled
 assert.equal(h.calls.some(c=>c.action==='loans.setInstallmentProgress'),false)
 const saved=p.saveProgress();h.modals.at(-1).success({confirm:true});await saved
 const command=h.calls.find(c=>c.action==='loans.setInstallmentProgress');assert.equal(command.data.completedThrough,10);assert.equal(command.data.confirmedBatch,true)
})
test('记费设置内选择暂停/结清/利率变化仍先确认，取消和已关闭设置的迟到选择不写',async()=>{
 const {h,p}=detail();await p.load();let sheet
 h.wx.showActionSheet=options=>{sheet=options}
 const open=()=>{p.openChargeForm();p.setData({chargeSummary:{hasContract:true,authorized:true}});p.chooseChargeStop()}
 open();assert.equal(sheet.itemList.length,3);const stale=sheet;await p.closeChargeForm();open();stale.success({tapIndex:0});assert.equal(h.modals.length,0)
 const paused=sheet.success({tapIndex:0});assert.match(h.modals.at(-1).title,/暂停/);h.modals.at(-1).success({confirm:false});await paused
 open();const settled=sheet.success({tapIndex:1});h.modals.at(-1).success({confirm:false});await settled
 open();const changed=sheet.success({tapIndex:2});assert.match(h.modals.at(-1).title,/利率变化/);h.modals.at(-1).success({confirm:true});await changed
 assert.equal(h.calls.some(c=>c.action==='loans.pauseCharges'),false)
 const writes=h.calls.filter(c=>c.action==='loans.endCharges');assert.equal(writes.length,1);assert.equal(writes[0].data.reason,'rate_changed');assert.equal(writes[0].data.confirmed,true)
})
test('编辑贷款内打开期次计划保留未保存资料，待核实写入时不可跳转',async()=>{
 const {h,p}=detail();await p.load();await p.manageLoan({currentTarget:{dataset:{action:'edit'}}})
 assert.match(h.navigation.at(-1),/loan-form\/index\?loanId=synthetic-loan$/)
 const form=h.page('loan-form');form.onLoad({loanId:loan.loanId});await form.load();form.setData({name:'尚未保存的名称'})
 form.openPlan();assert.match(h.navigation.at(-1),/loan-plan\/index\?loanId=synthetic-loan$/)
 await form.load();assert.equal(form.data.name,'尚未保存的名称')
 const before=h.navigation.length;form.setData({hasPending:true});form.openPlan();assert.equal(h.navigation.length,before)
 assert.equal(h.calls.some(c=>['loans.update','loans.replacePlan','loans.create'].includes(c.action)),false)
})
test('A4 真实详情页无文件授权：明确来源、从四月继续、覆盖与计费日；取消预览不写',async()=>{
 const {h,p}=detail();await p.load();p.openChargeForm();await p.authorizeCharges();assert.match(p.data.chargeError,/来源/)
 p.setData({'chargeDraft.originIndex':0,'chargeDraft.coverageIndex':0,'chargeDraft.fixed':true,'chargeDraft.fromDate':'2026-04-01','chargeDraft.throughDate':'2026-12-31','chargeDraft.firstChargeDate':'2026-01-01','chargeDraft.interestCategoryIndex':0})
 const preview=p.authorizeCharges();await tick();h.modals.at(-1).success({confirm:false});await preview
 assert.equal(h.calls.some(c=>c.action==='loans.configureCharges'),false)
 const save=p.authorizeCharges();await tick();h.modals.at(-1).success({confirm:true});await save
 const write=h.calls.find(c=>c.action==='loans.configureCharges');assert.ok(write);assert.equal(write.data.fromDate,'2026-04-01');assert.equal(write.data.historyChoice,'continue');assert.equal(write.data.originKind,'recorded_consumption');assert.equal(write.data.fixedConfirmed,true)
 assert.equal(h.calls.some(c=>c.action==='loans.bookInstallmentCosts'||c.action==='loans.record'),false)
})
test('A4 显式批量确认可取消；单期保持单期，保存失败保留费用更正表单',async()=>{
 const {h,p}=detail();await p.load();p.openProgress();p.progressInput({detail:{value:'10'}})
 const cancelled=p.saveProgress();h.modals.at(-1).success({confirm:false});await cancelled
 assert.equal(h.calls.some(c=>c.action==='loans.setInstallmentProgress'),false)
 const saved=p.saveProgress();h.modals.at(-1).success({confirm:true});await saved
 const command=h.calls.find(c=>c.action==='loans.setInstallmentProgress');assert.equal(command.data.confirmedBatch,true);assert.equal(command.data.completedThrough,10)
 p.setData({chargeEdit:{chargeId:'fee',amountYuan:'18'},chargeImpact:{canChange:true,deltaText:'-2.00',previewToken:'signed'}});p._chargeChange={loanId:loan.loanId,chargeId:'fee',operation:'adjust',amountMinor:'1800'}
 const original=h.respond;h.respond=(action,data)=>action==='loans.changeCharge'?{ok:false,error:{code:'LOAN_TRANSACTION_LOCKED',message:'已有付款'}}:original(action,data)
 const failed=p.confirmChargeChange();h.modals.at(-1).success({confirm:true});await failed;assert.equal(p.data.chargeEdit.amountYuan,'18');assert.match(p.data.errorMessage,/付款/)
})

test('A5 授权预览迟到或确认期间改范围，不得把旧授权提交；翻页不能复活已清预览',async()=>{
 const {h,p}=detail();await p.load();p.openChargeForm()
 p.setData({'chargeDraft.originIndex':0,'chargeDraft.coverageIndex':0,'chargeDraft.fixed':true,'chargeDraft.interestCategoryIndex':0})
 const base=h.respond;let release
 h.respond=(action,data)=>action==='loans.chargePlan'&&data.configuration?new Promise(resolve=>release=resolve):base(action,data)
 const old=p.authorizeCharges();await tick();p.chargeInput({currentTarget:{dataset:{field:'fromDate'}},detail:{value:'2026-04-01'}})
 release(ok({preview:[],duePreviewCount:3,duePreviewMinor:'6000',previewAmountMinor:'24000'}));await old
 assert.equal(h.modals.length,0);assert.equal(p.data.chargePreview,null)
 h.respond=base;const confirmation=p.authorizeCharges();await tick()
 p.chargeInput({currentTarget:{dataset:{field:'fromDate'}},detail:{value:'2026-05-01'}});h.modals.at(-1).success({confirm:true});await confirmation
 assert.equal(h.calls.some(c=>c.action==='loans.configureCharges'),false)
 p._chargePreviewInput={loanId:loan.loanId};p.setData({chargePreview:{next:'synthetic-cursor',items:[]}})
 h.respond=(action,data)=>action==='loans.chargePlan'&&data.cursor?new Promise(resolve=>release=resolve):base(action,data)
 const page=p.moreChargePreview();await tick();p.closeChargeForm();release(ok({preview:[],nextCursor:null}));await page
 assert.equal(p.data.chargePreview,null);assert.equal(p.data.chargeFormOpen,false)
})

test('统一逐期入口：按当前期读取费用/差异，选择更正不写账，返回本期；管理入口不触发费用写入',async()=>{
 const {h,p}=detail(),original=h.respond,fee={chargeId:'charge-11',chargeKey:'period:11:interest',periodNumber:11,component:'interest',amountMinor:'2000',settledMinor:'0',state:'recorded',basis:'plan',chargeDate:'2026-11-01'}
 h.respond=(action,data)=>{
  if(action==='loans.installment')return ok({loanVersion:2,period:{periodNumber:data.periodNumber,dueDate:'2026-11-30',principalMinor:'50000',interestMinor:'2000',feeMinor:'0'},sources:[],legacyPayments:[]})
  if(action==='loans.chargePlan'&&data.periodNumber!==undefined)return ok({items:[{...fee,periodNumber:data.periodNumber||null}],issues:[{eventId:'same-period',periodNumber:11,amountMinor:'1800'},{eventId:'other-period',periodNumber:12,amountMinor:'2000'}],nextCursor:null})
  return original(action,data)
 }
 p.onLoad({loanId:loan.loanId});await p.load();await p.openInstallment({currentTarget:{dataset:{term:11}}})
 assert.equal(p.data.periodCharges[0].chargeId,'charge-11');assert.deepEqual(p.data.periodChargeIssues.map(i=>i.eventId),['same-period'])
 assert.equal(h.calls.filter(c=>c.action==='loans.chargePlan').at(-1).data.periodNumber,11)
 await p.openChargeEdit({currentTarget:{dataset:{id:fee.chargeId}}})
 assert.equal(p.data.periodOpen,false);assert.equal(p.data.chargeEdit.options[0].operation,'adjust')
 p.chooseChargeOperation({detail:{value:1}});assert.equal(p.data.chargeEdit.operation,'refund')
 await p.closeChargeForm();assert.equal(p.data.periodOpen,true);assert.equal(p.data.selectedPeriod.term,11)
 p.closeInstallment();p.openLoanManagement();assert.equal(p.data.loanManagementOpen,true)
 p.manageLoan({currentTarget:{dataset:{action:'charges'}}});assert.equal(p.data.loanManagementOpen,false);assert.equal(p.data.chargeFormOpen,true)
 assert.equal(h.calls.some(c=>['loans.changeCharge','loans.configureCharges','loans.record'].includes(c.action)),false)
 await p.closeChargeForm();await p.openOneOffCharges();assert.equal(h.calls.at(-1).data.periodNumber,0);assert.equal(p.data.oneOffOpen,true)
})

test('本期费用/费用更正预览迟到，不跨期回填也不恢复旧选择',async()=>{
 const {h,p}=detail();await p.load();p.setData({detail:{tracking:true}})
 let release;const original=h.respond
 h.respond=(action,data)=>action==='loans.installment'?ok({loanVersion:2,period:{periodNumber:data.periodNumber,dueDate:'2026-02-28',principalMinor:'50000',interestMinor:'2000',feeMinor:'0'},sources:[],legacyPayments:[]}):action==='loans.chargePlan'&&data.periodNumber?new Promise(r=>release=r):original(action,data)
 const first=p.openInstallment({currentTarget:{dataset:{term:2}}});await tick();p.closeInstallment();release(ok({items:[{chargeId:'old'}],issues:[]}));await first
 assert.equal(p.data.periodCharges.length,0);assert.equal(p.data.periodOpen,false)
 p.setData({chargeEdit:{chargeId:'charge',amountYuan:'20',operation:'adjust',options:[{operation:'adjust'},{operation:'refund'}]}})
 h.respond=(action,data)=>action==='loans.chargeImpact'?new Promise(r=>release=r):original(action,data)
 const preview=p.previewChargeChange({currentTarget:{dataset:{}}});await tick();p.chooseChargeOperation({detail:{value:1}});release(ok({canChange:true,deltaMinor:'-200',nextPostingMinor:'0'}));await preview
 assert.equal(p.data.chargeImpact,null);assert.equal(p.data.chargeEdit.operation,'refund')
})

test('从第二期记还款：带入实际未付分项/费用依据，保留改动草稿；未确认不提交，付款携带本期期次版本',async()=>{
 const {h,p}=detail(),base=h.respond
 h.accounts.push({accountId:'bank',type:'bank',name:'合成银行卡',archived:false})
 h.respond=(action,data)=>{
  if(action==='loans.installment')return ok({loanVersion:2,period:{periodId:'saved-period',version:7,periodNumber:2,dueDate:'2026-02-28',principalMinor:'50000',interestMinor:'2000',feeMinor:'0',paidPrincipalMinor:'10000',paidInterestMinor:'500',paidFeeMinor:'0'},sources:[],legacyPayments:[]})
  if(action==='loans.chargePlan'&&data.periodNumber===2)return ok({items:[{chargeId:'charge-2',chargeKey:'period:2:interest',periodNumber:2,component:'interest',state:'recorded',categoryId:h.categories[0].id,amountMinor:'2000',outstandingMinor:'1500'}],issues:[],nextCursor:null,contract:{originKind:'recorded_consumption'}})
  if(action==='loans.record')return {ok:false,error:{code:'VALIDATION_ERROR',message:'合成拒绝，保留草稿'}}
  return base(action,data)
 }
 await p.load();await p.openInstallment({currentTarget:{dataset:{term:2}}});p.recordPeriodPayment()
 assert.match(h.navigation.at(-1),/loan-payment\/index\?loanId=synthetic-loan&periodNumber=2$/)
 const payment=h.page('loan-payment');payment.onLoad({loanId:loan.loanId,periodNumber:'2'});await payment.load()
 assert.equal(payment.data.totalYuan,'415.00');assert.equal(payment.data.allocations[0].principalYuan,'400.00');assert.equal(payment.data.allocations[0].interestYuan,'15.00')
 assert.equal(payment.data.allocations[0].interestIndex,1);assert.equal(payment.data.allocations[0].chargeChoices[0].selected,true)
 assert.equal(payment.data.allocations[0].chargeChoices[0].paidYuan,'15.00')
 payment.chooseKind({detail:{value:1}});assert.equal(payment.data.kindIndex,0)
 payment.chooseAccount({detail:{value:0}});await payment.save();assert.equal(h.calls.some(c=>c.action==='loans.record'),false)
 payment.editAllocation({currentTarget:{dataset:{index:0,field:'principalYuan'}},detail:{value:'300.00'}})
 payment.input({currentTarget:{dataset:{field:'totalYuan'}},detail:{value:'315.00'}});await payment.load()
 assert.equal(payment.data.allocations[0].principalYuan,'300.00');assert.equal(payment.data.totalYuan,'315.00')
 payment.confirm({detail:{value:['confirmed']}});await payment.save()
 const command=h.calls.find(c=>c.action==='loans.record');assert.ok(command)
 assert.deepEqual({...command.data.allocations[0].period},{periodNumber:2,version:7});assert.equal(command.data.allocations[0].chargeAllocations[0].amountMinor,'1500')
 assert.match(payment.data.errorMessage,/保留草稿/);assert.equal(payment.data.allocations[0].principalYuan,'300.00')
})
