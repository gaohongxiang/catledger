const test = require('node:test'), assert = require('node:assert/strict')
const {buildView,updateProgress}=require('../cloudfunctions/catledger-api/src/installment-view')
const {installmentEvidence}=require('../cloudfunctions/catledger-import/src/profiles/bank-installment')
const loan={kind:'installment',scheduleMethod:'flat',scheduleTerms:12,measurementKind:'repayment',repaymentMinor:'203909',feePerTermMinor:null,feeUpfrontMinor:null,firstPaymentDate:'2025-10-31',remainingPrincipalMinor:'2400000',installmentSetup:{schema:1,originalPrincipalMinor:'2400000',historicalPaidTerms:0,recordType:'credit_card',discountKind:null,discountValue:null}}
test('L09 第12期账单只证明出账；单期确认10不扩散，缺11不定逾期',()=>{
 const items=[{periodNumber:12,component:'principal',active:true}]
 const before=buildView(loan,[],items,'2026-09-23');assert.equal(before.summary.paidPeriods,0);assert.equal(before.rows[11].billed,true)
 const progress=updateProgress(loan,{periodNumber:10,status:'completed'}),after=buildView({...loan,progress},[],items,'2026-09-23')
 assert.equal(after.summary.paidPeriods,1);assert.equal(after.rows[9].complete,true);assert.equal(after.summary.completedThrough,0)
 assert.equal(after.rows[10].complete,false);assert.equal(after.rows[11].complete,false)
 assert.deepEqual(before.summary.repaymentPrompts.map(r=>r.periodNumber),Array.from({length:12},(_,i)=>i+1))
 assert.ok(before.summary.repaymentPrompts.every(r=>r.paid))
 assert.equal(after.summary.remainingPrincipalMinor,'2400000');assert.equal(after.summary.estimatedPrincipalMinor,'2200000')
})
test('L09 批量范围需明确确认；保留未还/部分及范围外的单期确认，实付12不扩散',()=>{
 let progress=updateProgress(loan,{periodNumber:9,status:'unpaid'});progress=updateProgress({...loan,progress},{periodNumber:12,status:'completed'})
 assert.throws(()=>updateProgress({...loan,progress},{completedThrough:10}),{publicCode:'VALIDATION_ERROR'})
 progress=updateProgress({...loan,progress},{completedThrough:10,confirmedBatch:true})
 const view=buildView({...loan,progress},[],[],'2026-09-23')
 assert.equal(view.summary.paidPeriods,10);assert.equal(view.rows[8].stateText,'已逾期');assert.equal(view.rows[10].complete,false);assert.equal(view.rows[11].complete,true)
 const actual=buildView(loan,[{periodNumber:12,status:'paid'}],[]);assert.equal(actual.summary.paidPeriods,1);assert.equal(actual.summary.actualPaidPeriods,1)
})
test('L14 模糊旧through保留待核对；明确单期、历史确认和异常均不清零',()=>{
 const legacy={through:12,exceptions:{'10':'completed','9':'partial'}}
 const progress=updateProgress({...loan,progress:legacy},{periodNumber:11,status:'unpaid'})
 assert.deepEqual(progress.legacy,legacy);assert.equal(progress.legacyNeedsReview,true)
 const view=buildView({...loan,progress},[],[]);assert.equal(view.summary.paidPeriods,1);assert.equal(view.rows[8].unpaidPrincipalMinor,'200000')
 const historical=buildView({...loan,installmentSetup:{...loan.installmentSetup,historicalPaidTerms:4}},[],[])
 assert.equal(historical.summary.paidPeriods,4);assert.equal(historical.summary.actualPaidPeriods,0)
 const confirmed=updateProgress({...loan,progress},{completedThrough:10,confirmedBatch:true});assert.equal(confirmed.legacyNeedsReview,false);assert.deepEqual(confirmed.legacy,legacy)
})
test('费用差异与取消状态不改变还款事实',()=>{
 const view=buildView(loan,[{periodNumber:11,cancelled:true}],[{periodNumber:10,component:'interest',amountMinor:'3000',active:true}],'2026-09-23')
 assert.deepEqual(view.rows[9].differences,['interest']);assert.equal(view.rows[9].complete,false);assert.equal(view.rows[9].interestMinor,'3909')
 assert.equal(view.rows[10].stateText,'已取消');assert.equal(view.rows[10].unpaidInterestMinor,'0')
})
test('本期真实清偿优先于旧人工标记；部分付款不伪装全额，撤销后原标记仍可追溯',()=>{
 const progress={schema:2,through:0,exceptions:{'2':'unpaid','3':'completed'}}
 const saved=[{periodNumber:2,status:'paid'},{periodNumber:3,status:'partial',unpaidPrincipalMinor:'100000',unpaidInterestMinor:'3909',unpaidFeeMinor:'0'}]
 const view=buildView({...loan,progress},saved,[])
 assert.equal(view.rows[1].paymentConfirmed,true);assert.equal(view.rows[1].complete,true);assert.equal(view.rows[1].completedByProgress,false)
 assert.equal(view.rows[2].status,'partial');assert.equal(view.rows[2].complete,false);assert.equal(view.rows[2].unpaidPrincipalMinor,'100000')
 const reversed=buildView({...loan,progress},[],[])
 assert.equal(reversed.rows[1].complete,false);assert.equal(reversed.rows[2].completedByProgress,true)
 assert.deepEqual(progress.exceptions,{'2':'unpaid','3':'completed'})
})
test('L01 真实放款和扣款不误套分期应还本金例外',()=>{
 const raw={rawTransactionType:'分期本金',item:'分期编号 SYNTHETIC-A 第10期 共12期'}
 assert.equal(installmentEvidence(raw),null)
 const found=installmentEvidence({...raw,bankStatementKind:'credit'});assert.equal(found.periodNumber,10);assert.equal(found.component,'principal');assert.equal(found.totalTerms,12)
 assert.equal(installmentEvidence({...raw,bankStatementKind:'standard'}),null)
 for(const type of ['现金分期放款到账','贷款实际扣款'])assert.equal(installmentEvidence({...raw,bankStatementKind:'credit',rawTransactionType:type}),null)
 const interest=installmentEvidence({...raw,bankStatementKind:'credit',rawTransactionType:'分期利息'});assert.equal(interest.referenceKey,found.referenceKey);assert.equal(interest.component,'interest')
 assert.equal(installmentEvidence({bankStatementKind:'credit',item:'分期本金及利息 第10期'}),null)
})

test('历史选择分20期继续，已保存和明确未还/部分期不反复询问',()=>{
 const base={...loan,scheduleTerms:36,installmentSetup:{...loan.installmentSetup,historicalPaidTerms:36},progress:{schema:2,through:36,exceptions:{'3':'unpaid','9':'partial'},reviewedPeriods:Object.fromEntries(Array.from({length:20},(_,i)=>[i+1,true])),simpleRepayment:true}}
 const result=buildView(base,[],[]);assert.deepEqual(result.summary.repaymentPrompts.map(r=>r.periodNumber),Array.from({length:16},(_,i)=>i+21));assert.equal(result.rows[2].complete,false);assert.equal(result.rows[8].complete,false)
})
