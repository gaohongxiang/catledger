const test=require('node:test'),assert=require('node:assert/strict')
const {runtime}=require('./helpers/read-runtime')
const period={periodNumber:1,dueDate:'2026-02-28',principalMinor:'50000',interestMinor:'2000',feeMinor:'0'}
const transaction={transactionId:'original-interest',version:3,type:'expense',amountMinor:'2000',occurredLocalAt:'2026-02-02T12:00:00',note:'已记利息',sourceAccount:{accountId:'credit-a',name:'信用卡'}}
const event=dataset=>({currentTarget:{dataset}})
const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function form(h){
 h.accounts=[{accountId:'credit-a',name:'信用卡',type:'credit',archived:false}]
 h.respond=(action,data)=>{
  if(action==='loans.previewPlan')return {ok:true,data:{periods:[period],summary:{remainingPrincipalMinor:'50000',totalPaymentMinor:'52000',totalInterestMinor:'2000',totalFeeMinor:'0',totalTerms:1}}}
  if(action==='transactions.refundable')return {ok:true,data:{transactions:[transaction],nextCursor:null}}
  if(action==='loans.create')return {ok:true,data:{loanId:'new-loan',version:1}}
 }
 const page=h.page('loan-form');page.onLoad({accountId:'credit-a'});await page.load()
 page.setData({name:'合成分期',principalYuan:'500',paidTerms:'1',schedule:{...page.data.schedule,terms:'1',methodIndex:0,measurementIndex:1,repaymentYuan:'520',firstPaymentDate:'2026-02-28'}})
 await page.preview();return page
}
test('真实创建页在逐期预览明确选用原利息，金额和版本随原请求一次提交',async()=>{
 const h=runtime(),page=await form(h)
 await page.openHistoricalCoverage({currentTarget:{dataset:{key:'period:1:interest'}}})
 page.chooseHistoricalCandidate({currentTarget:{dataset:{id:transaction.transactionId}}})
 await page.save()
 const saved=h.calls.find(c=>c.action==='loans.create')
 assert.deepEqual(JSON.parse(JSON.stringify(saved.data.coverage)),[{chargeKey:'period:1:interest',transactionId:'original-interest',transactionVersion:3}])
 assert.equal(h.modals.length,0);assert.equal(saved.data.baselinePrincipalMinor,'0')
})
test('候选只作推荐，没有明确选择时不传认领；无候选仍一次保存且不弹窗',async()=>{
 const h=runtime(),page=await form(h)
 assert.equal(page.data.historyCoverageSuggested,1);assert.equal(page.data.historyCoverageSelections.length,0)
 assert.equal(page.data.historyCoverageEditor,null)
 assert.equal(page.data.historyCoverageByPeriod[1].label,'选已记')
 h.respond=(action,data)=>action==='transactions.refundable'?{ok:true,data:{transactions:[],nextCursor:null}}:action==='loans.create'?{ok:true,data:{loanId:'new-loan',version:1}}:undefined
 await page.prepareFormCoverage();await page.save()
 const saved=h.calls.find(c=>c.action==='loans.create');assert.equal(saved.data.coverage,undefined);assert.equal(saved.data.oneOffCharges,undefined);assert.equal(h.modals.length,0)
})
test('逐期行按需打开精简选择，返回保留已选草稿，跨月和高级条件按需查找',async()=>{
 const h=runtime(),page=await form(h)
 await page.openHistoricalCoverage(event({term:1}))
 assert.equal(page.data.historyCoverageEditor.advanced,false)
 assert.equal(page.data.historyCoverageEditor.multiple,false)
 page.chooseHistoricalCandidate(event({id:transaction.transactionId}))
 assert.equal(page.data.historyCoverageByPeriod[1].label,'已选账目')
 await page.openHistoricalCoverage(event({term:1}))
 page.closeHistoricalCoverage()
 assert.equal(page.data.historyCoverageSelections[0].transactionId,transaction.transactionId)
 await page.openHistoricalCoverage(event({term:1}))
 await page.toggleHistoricalFilter(event({field:'allDates'}))
 assert.equal(h.calls.at(-1).data.month,undefined)
 page.toggleHistoricalFilter(event({field:'advanced'}))
 assert.equal(page.data.historyCoverageEditor.advanced,true)
})
test('按同账户同月同额推荐，明确跨月后保留金额过滤及分页',async()=>{
 const h=runtime(),page=await form(h)
 h.respond=(action,data)=>action==='transactions.refundable'?{ok:true,data:{transactions:[{...transaction,occurredLocalAt:'2026-01-31T12:00:00'}],nextCursor:data.cursor?null:'page-next'}}:undefined
 await page.openHistoricalCoverage(event({key:'period:1:interest'}))
 let lookup=h.calls.at(-1).data;assert.equal(lookup.month,'2026-02');assert.equal(lookup.amountMinor,'2000');assert.equal(lookup.accountId,'credit-a')
 page.historicalCoverageInput({currentTarget:{dataset:{field:'allDates'}},detail:{value:true}});await page.loadHistoricalCandidates()
 lookup=h.calls.at(-1).data;assert.equal(lookup.month,undefined);assert.equal(lookup.amountMinor,'2000');assert.equal(lookup.feeCandidate,true)
 await page.loadHistoricalCandidates(event({next:true}));assert.equal(h.calls.at(-1).data.cursor,'page-next')
 page.chooseHistoricalCandidate(event({id:transaction.transactionId}));assert.equal(page.data.historyCoverageSelections[0].chargeDate,'2026-01-31')
})
test('同一原费用不能独立选给两期；一次性覆盖按合计查找并沿用 oneOffCharges',async()=>{
 const h=runtime(),page=await form(h)
 const second={...period,periodNumber:2,dueDate:'2026-03-28'}
 await page.prepareHistoricalCoverage([period,second],'credit-a')
 await page.openHistoricalCoverage(event({key:'period:1:interest'}));page.chooseHistoricalCandidate(event({id:transaction.transactionId}))
 await page.openHistoricalCoverage(event({key:'period:2:interest'}));page.chooseHistoricalCandidate(event({id:transaction.transactionId}))
 assert.match(page.data.historyCoverageError,/其他期次/);assert.equal(page.data.historyCoverageSelections.length,1)
 await page.openHistoricalCoverage(event({key:'period:1:interest'}))
 page.historicalCoverageInput({currentTarget:{dataset:{field:'multiple'}},detail:{value:true}})
 page.historicalCoverageInput({currentTarget:{dataset:{field:'through'}},detail:{value:'2'}})
 h.respond=action=>action==='transactions.refundable'?{ok:true,data:{transactions:[{...transaction,transactionId:'one-off-interest',amountMinor:'4000'}]}}:undefined
 await page.loadHistoricalCandidates();assert.equal(h.calls.at(-1).data.amountMinor,'4000')
 page.chooseHistoricalCandidate(event({id:'one-off-interest'}))
 const payload=page.historicalCoveragePayload([1,2]);assert.equal(payload.coverage,undefined);assert.equal(payload.oneOffCharges[0].amountMinor,'4000');assert.equal(payload.oneOffCharges[0].covers.length,2)
 assert.throws(()=>page.historicalCoveragePayload([1]),/一起勾选/)
})
test('关闭、隐藏、修改查询和切换用户后，迟到候选不能回填或覆盖选择草稿',async()=>{
 for(const leave of ['close','hide','edit','session']){
  const h=runtime(),page=await form(h);let release
  h.respond=action=>action==='transactions.refundable'?new Promise(resolve=>{release=resolve}):undefined
  const loading=page.openHistoricalCoverage(event({key:'period:1:interest'}));await tick()
  if(leave==='close')page.closeHistoricalCoverage()
  if(leave==='hide')page.onHide()
  if(leave==='edit')page.historicalCoverageInput({currentTarget:{dataset:{field:'search'}},detail:{value:'新搜索'}})
  if(leave==='session'){h.cache.reset();h.uid=h.app.globalData.uid='new-user'}
  release({ok:true,data:{transactions:[transaction]}});await loading
  assert.equal(page.data.historyCoverageCandidates.length,0)
 }
})
test('晚到推荐不能覆盖清空的已还选择，选择草稿也不会被推荐自动替换',async()=>{
 const h=runtime(),page=await form(h);let release
 await page.openHistoricalCoverage(event({key:'period:1:interest'}));page.chooseHistoricalCandidate(event({id:transaction.transactionId}))
 h.respond=action=>action==='transactions.refundable'?new Promise(resolve=>{release=resolve}):undefined
 const recommending=page.prepareFormCoverage();await tick()
 await page.prepareHistoricalCoverage([],'credit-a')
 release({ok:true,data:{transactions:[transaction]}});await recommending
 assert.equal(page.data.historyCoverageRows.length,0);assert.equal(page.data.historyCoverageSuggested,0);assert.equal(page.data.historyCoverageSelections[0].transactionId,transaction.transactionId)
})
