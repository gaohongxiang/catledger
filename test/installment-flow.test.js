const test = require('node:test')
const assert = require('node:assert/strict')
const { buildView, updateProgress } = require('../cloudfunctions/catledger-api/src/installment-view')
const { installmentEvidence } = require('../cloudfunctions/catledger-import/src/profiles/bank-installment')
const loan = { kind:'installment',scheduleMethod:'flat',scheduleTerms:12,measurementKind:'repayment',repaymentMinor:'203909',
  feePerTermMinor:null,feeUpfrontMinor:null,firstPaymentDate:'2025-10-31',
  installmentSetup:{schema:1,originalPrincipalMinor:'2400000',historicalPaidTerms:0,recordType:'credit_card',discountKind:null,discountValue:null} }
test('第 10 期来源推进前十期；缺失 11 期与当前 12 期分开，不编造逾期',()=>{
  const view=buildView(loan,[],[{periodNumber:10,component:'principal',active:true}],'2026-09-23')
  assert.equal(view.summary.paidPeriods,10)
  assert.ok(view.rows.slice(0,10).every(r=>r.complete))
  assert.equal(view.rows[10].stateText,'缺少账单，待补充')
  assert.equal(view.rows[11].current,true)
  assert.equal(view.summary.remainingPrincipalMinor,'400000')
})
test('明确未还、部分未还不被更晚期号覆盖；失效来源不能推进',()=>{
  const updated={...loan,progress:updateProgress(loan,{periodNumber:9,status:'unpaid'})}
  const view=buildView(updated,[],[{periodNumber:12,active:true},{periodNumber:10,active:false}],'2026-09-23')
  assert.equal(view.rows[8].stateText,'已逾期');assert.equal(view.summary.paidPeriods,11)
  const reverted=buildView(loan,[],[{periodNumber:12,active:false}],'2026-09-23')
  assert.equal(reverted.summary.paidPeriods,0)
  const partial=buildView({...loan,progress:{through:12,exceptions:{'9':'partial'}}},[],[],'2026-09-23')
  assert.equal(partial.rows[8].unpaidPrincipalMinor,'200000')
})
test('修改连续进度可以回退手动确认，保留明确异常',()=>{
  const prior={...loan,progress:{through:12,exceptions:{'12':'completed','9':'unpaid'}}}
  const next=updateProgress(prior,{completedThrough:10})
  assert.deepEqual(next,{through:10,exceptions:{'9':'unpaid'}})
  assert.throws(()=>updateProgress(loan,{completedThrough:13}),{publicCode:'VALIDATION_ERROR'})
})
test('账单金额差异提示原位处理，取消期不误报缺账单',()=>{
  const view=buildView(loan,[{periodNumber:11,cancelled:true}], [{periodNumber:10,component:'interest',amountMinor:'3000',active:true}], '2026-09-23')
  assert.deepEqual(view.rows[9].differences,['interest']);assert.equal(view.rows[9].complete,true)
  assert.equal(view.rows[9].interestMinor,'3909')
  assert.equal(view.rows[10].stateText,'已取消');assert.equal(view.rows[10].unpaidInterestMinor,'0')
})
test('只有明确的信用卡账单解析分期本金，普通贷款现金流保持原语义',()=>{
  const raw={rawTransactionType:'分期本金',item:'分期编号 SYNTHETIC-A 第10期 共12期'}
  assert.equal(installmentEvidence(raw),null)
  const found=installmentEvidence({...raw,bankStatementKind:'credit'})
  assert.equal(found.periodNumber,10);assert.equal(found.component,'principal');assert.equal(found.totalTerms,12)
  assert.equal(installmentEvidence({...raw,bankStatementKind:'standard'}),null)
  const interest=installmentEvidence({...raw,bankStatementKind:'credit',rawTransactionType:'分期利息'})
  assert.equal(interest.referenceKey,found.referenceKey)
  assert.equal(interest.component,'interest')
  assert.equal(installmentEvidence({bankStatementKind:'credit',item:'分期本金及利息 第10期'}),null)
})
