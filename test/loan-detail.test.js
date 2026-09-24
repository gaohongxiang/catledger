const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../miniprogram/pages/loan-detail/detail-model')
const cost = require('../miniprogram/pages/loan-detail/cost')
const { remainingSchedule } = require('../cloudfunctions/catledger-api/src/loan-installment')
const { present } = require('../miniprogram/pages/loans/model')
const session = require('../miniprogram/services/page-read-session')
const cache = require('../miniprogram/services/read-cache')

test('页面读取缓存仅接入服务端支持版本元数据的接口', () => {
  const policies = require('../miniprogram/services/read-policy').READ_POLICIES
  const supported = require('../cloudfunctions/catledger-api/src/read-contract').READ_ACTIONS
  // bootstrap 在 handler 的身份初始化分支单独附加元数据。
  for (const action of Object.keys(policies)) assert.ok(action === 'bootstrap' || supported.has(action), action + ' 尚未支持缓存版本协议')
})

function loan(overrides) {
  return present(Object.assign({ loanId: 'synthetic-loan', version: 1, name: '合成分期', accountName: '合成负债', status: 'active', remainingPrincipalMinor: '900000',
    kind: 'installment', scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'repayment', repaymentMinor: '110000',
    firstPaymentDate: '2026-01-15', feeUpfrontMinor: '0', feePerTermMinor: '0', baselinePrincipalMinor: '900000',
    installmentSetup: { schema: 1, originalPrincipalMinor: '1200000', historicalPaidTerms: 3, recordType: 'bank_loan', customRecordType: '', discountKind: null, discountValue: null }
  }, overrides))
}
function period(number, status = 'unpaid') {
  const paid = status === 'paid', partial = status === 'partial'
  return { periodId: 'synthetic-period-' + number, periodNumber: number, dueDate: '2026-' + String(number).padStart(2, '0') + '-15',
    principalMinor: '100000', interestMinor: '10000', feeMinor: '0',
    unpaidPrincipalMinor: paid ? '0' : partial ? '50000' : '100000', unpaidInterestMinor: paid ? '0' : '10000', unpaidFeeMinor: '0', status }
}
function periodView(overrides) {
  return Object.assign({ loanVersion: 1, summary: { paidPeriods: 0, nextDueDate: '2026-04-15', unpaidPrincipalMinor: '900000', unpaidInterestMinor: '90000', unpaidFeeMinor: '0', principalGapMinor: '0' },
    items: Array.from({ length: 9 }, (_, i) => period(i + 4)), nextCursor: null }, overrides)
}
function preview(value) { return remainingSchedule(model.previewInput(value)) }

test('结清分期仍展示原借款、全期成本及历史表；历史恢复不改变保存的进度', () => {
  const value = loan({ status: 'settled', remainingPrincipalMinor: '0', installmentSetup: { ...loan().installmentSetup, historicalPaidTerms: 12 } })
  const view = periodView({ items: [], summary: { paidPeriods: 0, nextDueDate: null, unpaidPrincipalMinor: '0', unpaidInterestMinor: '0', unpaidFeeMinor: '0', principalGapMinor: '0' } })
  const full = preview(value), result = model.build(value, view, full)
  assert.equal(result.principal, '12,000.00'); assert.equal(result.progress, 100); assert.equal(result.remaining, '0.00')
  assert.equal(result.cost.cost, '1,200.00'); assert.equal(result.cost.total, '13,200.00')
  assert.equal(model.historicalRows(value, full).length, 12)
  assert.equal(value.installmentSetup.historicalPaidTerms, 12)
  assert.equal(result.complete, true)
})

test('到期、部分还款和本金结清均不能冒充全部已还', () => {
  const value = loan(), view = periodView({ items: [period(4, 'partial')] })
  const result = model.build(value, view, preview(value), '2030-01-01')
  assert.equal(result.paid, 3); assert.equal(result.progress, 25); assert.equal(result.overdue, true)
  assert.equal(result.duePayment, '600.00'); assert.equal(result.duePrincipal, '500.00'); assert.equal(result.dueCost, '100.00')
  assert.equal(model.rowView(view.items[0], '2030-01-01').paid, false)
  const principalSettled = model.build(loan({ status: 'settled', remainingPrincipalMinor: '0' }), view, null)
  assert.equal(principalSettled.complete, false); assert.equal(principalSettled.status, '本金已结清')
})

test('历史和接入后进度分别保留，修订后的确认期次优先显示', () => {
  const value = loan(), view = periodView()
  view.summary.paidPeriods = 2
  view.items[0].interestMinor = '6500'
  const result = model.build(value, view, preview(value))
  assert.equal(result.paid, 5); assert.equal(result.progressNote, '历史已还 3 期 · 接入后已还 2 期')
  assert.equal(model.rowView(view.items[0], '2026-01-01').interestFee, '65.00')
  assert.equal(model.historicalRows(value, preview(value)).some(row => row.periodNumber === 4), false)
})

test('未知本金、缺少计划或读取失败不展示假零值或已完成', () => {
  const unknown = loan({ installmentSetup: null, scheduleMethod: null, scheduleTerms: null, baselinePrincipalMinor: null, remainingPrincipalMinor: null, status: 'unknown' })
  const result = model.build(unknown, null, null)
  assert.equal(result.principal, '—'); assert.equal(result.remaining, '—'); assert.equal(result.cost, null); assert.equal(result.complete, false)
  const missing = model.build(loan(), periodView({ items: [], summary: { nextDueDate: null, unpaidPrincipalMinor: '0', unpaidInterestMinor: '0', unpaidFeeMinor: '0' } }), null)
  assert.equal(missing.remaining, '—'); assert.equal(missing.dueTitle, '待补充计划')
})

test('IRR 保留零付款月份，一次性费用只计一次；年化沿用本息小记月度口径', () => {
  const value = loan({ installmentSetup: { ...loan().installmentSetup, originalPrincipalMinor: '100000' }, scheduleTerms: 2, feeUpfrontMinor: '0' })
  const rows = [{ periodNumber: 2, principalMinor: '100000', interestMinor: '21000', feeMinor: '0' }]
  const annual = cost.rates(value, rows)
  assert.ok(Math.abs(annual.simple - 120) < 1e-8)
  assert.ok(Math.abs(annual.effective - (Math.pow(1.1, 12) - 1) * 100) < 1e-8)
  const charged = loan({ feeUpfrontMinor: '30000' }), full = preview(charged), result = cost.build(charged, full)
  assert.equal(result.cost, '1,500.00'); assert.equal(result.total, '13,500.00'); assert.equal(result.ratio, '12.50%')
  assert.ok(cost.rates(charged, full.periods).effective > cost.rates(loan(), preview(loan()).periods).effective)
  const zero = loan({ repaymentMinor: '100000' })
  assert.equal(cost.build(zero, preview(zero)).apr, '0.00%')
  assert.equal(cost.build(loan({ feeUpfrontMinor: '1200000' }), preview(loan())).apr, '—')
})

function pageRuntime(callApi, value = loan()) {
  const methods = require('../miniprogram/pages/loan-detail/detail-reader').create({ callApi })
  const page = { ...methods, _loanId: value.loanId, _readSession: cache.getSession(), data: { loan: value },
    setData(patch) { Object.assign(this.data, patch) } }
  page.applyDetailLoan(value)
  return page
}

test('完整逐期表一次读取，历史进度与本期期次合并且复用同版本', async () => {
  const calls = [], value = loan(), full = preview(value)
  const page = pageRuntime(async (action, data) => { calls.push({ action, data }); return action === 'loans.installments' ? periodView({items:full.periods.map(row=>({...row,status:row.periodNumber<=3?'paid':'missing'}))}) : full })
  await page.loadDetail(); await page.loadDetail()
  assert.deepEqual(calls.map(call => call.action), ['loans.installments', 'loans.previewPlan'])
  assert.equal(calls[1].data.installmentSetup.historicalPaidTerms, 0)
  assert.equal(page.data.periodRows.length, 12); assert.equal(page.data.scheduleHistorical, false)
  assert.ok(page.data.periodRows.slice(0,3).every(row=>row.paid))
  assert.equal(page.data.periodRows[3].term,4)
})

test('读取失败保留资料与可用成本，重试恢复；冲突版本不混合', async () => {
  let failed = true, version = 1
  const page = pageRuntime(async action => {
    if (action === 'loans.previewPlan') return preview(loan())
    if (failed) throw new Error('synthetic read failure')
    return periodView({ loanVersion: version })
  })
  await page.loadDetail(); assert.ok(page.data.detailError); assert.equal(page.data.detail.remaining, '—'); assert.ok(page.data.detail.cost)
  failed = false; await page.loadDetail(); assert.equal(page.data.detailError, '')
  version = 2; page._detailReady = false; await page.loadDetail()
  assert.ok(page.data.detailError); assert.equal(page.data.detail.remaining, '—')
})

test('关闭页面及较旧贷款版本的迟到结果不回填', async () => {
  let resolve
  const page = pageRuntime(action => action === 'loans.installments' ? new Promise(done => { resolve = done }) : Promise.resolve(preview(loan())))
  const task = page.loadDetail(); session.end(page); resolve(periodView()); await task
  assert.equal(page.data.periodRows.length, 0)
  const changed = pageRuntime(action => action === 'loans.installments' ? new Promise(done => { resolve = done }) : Promise.resolve(preview(loan())))
  const old = changed.loadDetail(); changed.data.loan = loan({ version: 2 }); changed.applyDetailLoan(changed.data.loan)
  resolve(periodView()); await old
  assert.equal(changed.data.periodRows.length, 0)
})

test('显示更多逐批追加完整 600 期，保留已展开内容，末批后停止读取', async () => {
  const value = loan({ scheduleTerms: 600, repaymentMinor: '2500', installmentSetup: { ...loan().installmentSetup, historicalPaidTerms: 600 } })
  const full=preview(value),rows=full.periods,cursors=[]
  const page = pageRuntime(async (action,data) => {
    if(action!=='loans.installments')return full
    const offset=Number(data.cursor||0);cursors.push(offset)
    assert.equal(data.pageSize,20)
    return periodView({items:rows.slice(offset,offset+20),nextCursor:offset+20<rows.length?String(offset+20):null})
  },value)
  await page.loadDetail()
  assert.equal(page.data.periodRows.length,20)
  for(let i=1;i<30;i++){
    const previous=page.data.periodRows.slice();await page.showMoreSchedule()
    assert.deepEqual(page.data.periodRows.slice(0,previous.length),previous)
    assert.equal(page.data.periodRows.length,(i+1)*20)
  }
  assert.deepEqual(page.data.periodRows.map(r=>r.term),Array.from({length:600},(_,i)=>i+1))
  assert.equal(page.data.scheduleMore,false)
  await page.showMoreSchedule();assert.equal(cursors.length,30)
})

test('追加失败不丢已展示期次，连续点击不重复请求，重试补齐最后 16 期',async()=>{
  const value=loan({scheduleTerms:36}),full=preview(value),rows=full.periods
  let fail=true,release,calls=0
  const page=pageRuntime(async(action,data)=>{
    if(action!=='loans.installments')return full
    if(!data.cursor)return periodView({items:rows.slice(0,20),nextCursor:'tail'})
    calls++;await new Promise(resolve=>release=resolve)
    if(fail)throw new Error('合成后续读取失败')
    return periodView({items:rows.slice(20),nextCursor:null})
  },value)
  await page.loadDetail();const before=page.data.periodRows.slice()
  const first=page.showMoreSchedule();await page.showMoreSchedule()
  assert.equal(calls,1);release();await first
  assert.deepEqual(page.data.periodRows,before);assert.ok(page.data.detailError);assert.equal(page.data.scheduleMore,true)
  fail=false;const retry=page.showMoreSchedule();release();await retry
  assert.equal(page.data.periodRows.length,36);assert.deepEqual(page.data.periodRows.slice(0,20),before)
  assert.equal(page.data.detailError,'');assert.equal(page.data.scheduleMore,false)
})

test('追加遇到版本冲突保留原表；重新读取后的迟到追加不回填',async()=>{
  const value=loan({scheduleTerms:36}),full=preview(value),rows=full.periods
  let resolve,version=2
  const page=pageRuntime(async(action,data)=>{
    if(action!=='loans.installments')return full
    if(!data.cursor)return periodView({items:rows.slice(0,20),nextCursor:'tail'})
    await new Promise(done=>resolve=done)
    return periodView({loanVersion:version,items:rows.slice(20),nextCursor:null})
  },value)
  await page.loadDetail();const original=page.data.periodRows.slice()
  const conflict=page.showMoreSchedule();resolve();await conflict
  assert.ok(page.data.detailError);assert.deepEqual(page.data.periodRows,original)
  version=1;const delayed=page.showMoreSchedule()
  page.load=()=>page.loadDetail();await page.refreshDetail()
  resolve();await delayed
  assert.deepEqual(page.data.periodRows,original);assert.equal(page.data.detailError,'');assert.equal(page.data.detailLoading,false)
})

test('旧借款的历史行和后续期次也连续追加，不重复历史期号',async()=>{
  const value=loan({kind:'borrowing'}),full=preview(value)
  const page=pageRuntime(async action=>action==='loans.periods'?periodView():full,value)
  await page.loadDetail();assert.deepEqual(page.data.periodRows.map(r=>r.term),[1,2,3])
  await page.showMoreSchedule()
  assert.deepEqual(page.data.periodRows.map(r=>r.term),Array.from({length:12},(_,i)=>i+1))
  assert.equal(page.data.scheduleMore,false);assert.equal(page.data.scheduleHistorical,true)
})
