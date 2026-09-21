const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const model = require('../miniprogram/pages/loan-link/model')
const paymentModel = require('../miniprogram/pages/loan-payment/model')
const { createLoanContext } = require('../miniprogram/pages/transaction-editor/loan-context')
const { READ_POLICIES, mutationTags } = require('../miniprogram/services/read-policy')
const transaction = { transactionId: 'synthetic-tx', type: 'transfer', amountMinor: '1000', version: 1, origin: 'import',
  occurredLocalAt: '2026-08-02T18:15:15.123', timezoneOffsetMinutes: -480,
  sourceAccount: { accountId: 'wallet', name: '合成余额' }, destinationAccount: { accountId: 'debt', name: '合成借款账户' } }
const context = { state: 'candidate', transaction, targetAccount: { accountId: 'debt', type: 'other_liability', name: '合成借款账户', inactive: false }, payment: { paymentId:'pending-payment',totalMinor:'1000',version:1 },repayment:{ principalMinor:'800',interestMinor:'200',feeMinor:'0' },allocations: [], evidence: { items: [], hasMore: false } }
const creditTransaction = { ...transaction, destinationAccount: { accountId: 'credit', name: '合成信用账户' } }
const ordinaryContext = { ...context, state: 'none', transaction: creditTransaction, targetAccount: null }
const loan = { loanId: 'loan', name: '合成分期', kind: 'installment', accountId: 'debt', accountName: '合成借款账户', baselinePrincipalMinor: '10000', remainingPrincipalMinor: '10000', baselineDate: '2026-08-01', version: 1, status: 'active' }
const catalog = { uid: '1234567890', accounts: [{ accountId: 'wallet', name: '合成余额', type: 'wallet' }, { accountId: 'credit', name: '合成信用账户', type: 'credit' }, { accountId: 'debt', name: '合成借款账户', type: 'other_liability' }], categories: [] }
const sourceResult = { source: { transactionIds: [transaction.transactionId], fingerprint: 'synthetic-fingerprint', event: null }, transactions: [transaction], evidence: { items: [{ fields: [{ label: '期次', value: '2/12' }], description: '合成来源' }], hasMore: false } }
const copy = value => JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))
function runtime(route, responder) {
  const filename = path.join(__dirname, '../miniprogram/pages', route, 'index.js'), req = createRequire(filename)
  const calls = [], routes = [], storage = new Map()
  let definition, request = 0
  const app = { hasLoginApproval: () => true, globalData: { uid: '1234567890', categories: [] } }
  const api = { isFresh: () => true, peek: () => null, cacheToken: () => '', createRequestId: () => 'synthetic-request-' + ++request,
    callApi(name, data, options) { calls.push({ name, data, options }); return Promise.resolve().then(() => responder(name, data)) } }
  const chrome = { redirectTo:options=>routes.push(options.url),switchTab:options=>routes.push(options.url),navigateTo: options => routes.push(options.url), navigateBack() {}, showToast() {}, stopPullDownRefresh() {}, showModal() {} }
  function deps(name) {
    if (name.includes('/services/catledger-api')) return api
    if (name.includes('/services/catledger-import')) return { readPage:(name,data)=>api.callApi(name,data) }
    if (name.includes('/services/login-guard')) return { run: (_, fn) => app.hasLoginApproval() ? fn() : undefined }
    if (name.includes('/theme/service')) return { bindPage() {} }
    if (name.includes('/services/pending-ledger-write')) return req(name).createPendingWrite({ scope: () => app.globalData.uid,
      read: key => storage.get(key), write: (key, v) => storage.set(key, v), remove: key => storage.delete(key), requestId: api.createRequestId,
      call: (_, action, data) => api.callApi(action, data) })
    if (name === './source' && route === 'loan-payment') {
      const module = { exports: {} }
      vm.runInNewContext(fs.readFileSync(req.resolve(name), 'utf8'), { module, require: deps, wx: chrome })
      return module.exports
    }
    return req(name)
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: deps, Page: p => { definition = p }, getApp: () => app, wx: chrome, console }, { filename })
  const page = { ...definition, data: copy(definition.data), setData(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let dst = this.data
      for (const name of keys.slice(0, -1)) dst = dst[name] || (dst[name] = {})
      dst[keys.at(-1)] = value
    }
  } }
  return { page, calls, routes, app, api }
}
function linkedContext() {
  return { ...context, state: 'linked', transaction: creditTransaction, targetAccount: null,
    payment: { paymentId: 'payment', kind: 'repayment', totalMinor: '1000', version: 1, status: 'active' },
    allocations: [{ loanId: 'loan', loanName: '合成分期', kind: 'installment', principalMinor: '800', interestMinor: '200', feeMinor: '0',
      interestTreatment: 'accrued', feeTreatment: 'expense', periodCount: 4,
      periods: [1,2,3].map(n => ({ periodNumber: n, dueDate: '2026-08-03' })),
      unallocated: { principalMinor: '100', interestMinor: '0', feeMinor: '0' } }] }
}

test('展示区分借款候选、信用卡普通转账与已有分期关联，未知本金和期次截断明确告知', () => {
  const candidate = model.contextView(context)
  assert.equal(candidate.linked, false); assert.match(candidate.businessText, /借款还款 · 尚未关联贷款/)
  assert.equal(candidate.allocations.length, 0)
  const ordinary = model.contextView(ordinaryContext)
  assert.equal(ordinary.state, 'none'); assert.equal(ordinary.linked, false); assert.equal(ordinary.businessText, '普通账目')
  const linked = model.contextView(linkedContext())
  assert.equal(linked.businessText, '已关联分期还款'); assert.equal(linked.totalText, '¥10.00')
  assert.match(linked.allocations[0].periodText, /共4期/); assert.match(linked.allocations[0].unallocatedText, /¥1.00/)
  assert.equal(model.choiceView({ ...loan, baselinePrincipalMinor: null }, '2026-08-02').canLink, false)
  assert.equal(model.choiceView({ ...loan, baselineDate: '2026-09-01' }, '2026-08-02').canLink, false)
  assert.equal(model.choiceView(loan, '2026-08-02').canLink, true)
  assert.throws(() => model.contextView({ ...context, targetAccount: null }), /目标账户/)
})

test('待关联页默认全部月份，切换筛选绑定最新意图并限制返回游标数量', async () => {
  let late
  const h = runtime('loan-link', (name, data) => {
    if (name === 'catalog.get') return catalog
    if (data.month === '2026-07') return new Promise(resolve => { late = resolve })
    return { month: data.month, accountId: data.accountId, items: [{ ...transaction, targetType: 'other_liability' }], nextCursor: 'next-' + (data.cursor || 'first') }
  })
  h.page.onLoad({}); await h.page.firstPage()
  assert.equal(h.calls.find(c => c.name === 'loans.unassigned').data.month, null)
  assert.deepEqual(Array.from(h.page.data.accounts, account => account.accountId), [null, 'debt'])
  const old = h.page.changeMonth({ detail: { value: '2026-07' } }); await flush()
  await h.page.changeMonth({ detail: { value: '2026-08' } })
  late({ month: '2026-07', accountId: null, items: [], nextCursor: null }); await old
  assert.equal(h.page.data.month, '2026-08'); assert.equal(h.page.data.items.length, 1)
  for (let i = 0; i < 7; i++) await h.page.nextPage()
  assert.equal(h.page._previous.length, 5); assert.equal(h.page.data.items.length, 1)
  await h.page.changeAccount({ detail: { value: 1 } })
  assert.equal(h.calls.filter(c => c.name === 'loans.unassigned').at(-1).data.accountId, 'debt')
  assert.equal(h.page.data.canPrevious, false)
})

test('从账单关联按目标借款账户查贷款，缺基准先补资料并保留原交易ID', async () => {
  const h = runtime('loan-link', (name, data) => name === 'loans.transaction' ? context : { items: [loan, { ...loan, loanId: 'unknown', baselinePrincipalMinor: null }], nextCursor: null })
  h.page.onLoad({ transactionId: transaction.transactionId }); await h.page.firstPage()
  assert.equal(h.calls.find(c => c.name === 'loans.list').data.accountId, 'debt')
  h.page.selectLoan({ currentTarget: { dataset: { id: 'loan' } } })
  assert.equal(h.routes[0], '/pages/repayment-entry/index?loanId=loan&paymentId=pending-payment')
  h.page.selectLoan({ currentTarget: { dataset: { id: 'unknown' } } })
  assert.match(h.routes[1], /loan-detail\/index\?loanId=unknown&sourceTransactionId=synthetic-tx/)
  h.page.createLoan(); assert.match(h.routes[2], /loan-form\/index\?sourceTransactionId=synthetic-tx&accountId=debt/)
  assert.equal(h.calls.some(c => /record|create/.test(c.name)), false)
})

test('信用卡普通转账打开旧关联链接也不查询贷款、不允许新建或选择贷款', async () => {
  const h = runtime('loan-link', name => {
    assert.equal(name, 'loans.transaction')
    return ordinaryContext
  })
  h.page.onLoad({ transactionId: transaction.transactionId }); await h.page.firstPage()
  assert.equal(h.page.data.context.state, 'none'); assert.equal(h.page.data.loans.length, 0)
  h.page.createLoan(); h.page.selectLoan({ currentTarget: { dataset: { id: 'loan' } } }); h.page.openPayment()
  assert.equal(h.routes.length, 0); assert.equal(h.calls.length, 1)
})

test('再次打开信用账户已关联/更正原账直接查看当前付款，读取失败不能开放新建入口', async () => {
  let fail = false
  const h = runtime('loan-link', () => { if (fail) throw new Error('合成读取失败'); return { ...linkedContext(), state: 'replaced' } })
  h.page.onLoad({ transactionId: transaction.transactionId }); await h.page.firstPage(); h.page.openPayment()
  assert.equal(h.routes[0], '/pages/loan-payment/index?paymentId=payment')
  assert.equal(h.calls.filter(c => c.name === 'loans.list').length, 0)
  fail = true; await h.page.firstPage(); h.page.createLoan()
  assert.match(h.page.data.errorMessage, /读取失败/); assert.equal(h.routes.length, 1)
})

test('新建分期资料预选原借款账户，目录重排不串账户，保存资料不生成付款且可接续原账', async () => {
  let stored, reorder = false, fail = false
  const h = runtime('loan-form', (name, data) => {
    if (name === 'catalog.get') return { ...catalog, accounts: reorder ? catalog.accounts.slice().reverse() : catalog.accounts }
    if (name === 'loans.transaction') { if (fail) throw new Error('合成来源读取失败'); return context }
    if (name === 'loans.previewPlan') return {periods:[],summary:{totalPaymentMinor:'10000',totalInterestMinor:'0',totalFeeMinor:'0',remainingPrincipalMinor:'10000'}}
    if (name === 'loans.create') { stored = { ...loan, ...data }; return { loanId: loan.loanId, version: 1 } }
    if (name === 'loans.get') return { loan: stored }
    throw new Error('unexpected ' + name)
  })
  h.page.onLoad({ sourceTransactionId: transaction.transactionId }); await h.page.load()
  assert.equal(h.page.data.accounts[h.page.data.accountIndex].accountId, 'debt'); assert.equal(h.page.data.principalYuan, '')
  reorder = true; await h.page.load(); assert.equal(h.page.data.accounts[h.page.data.accountIndex].accountId, 'debt')
  Object.assign(h.page.data, { name: '合成分期', principalYuan: '100', baselineDate: '2026-08-01' })
  Object.assign(h.page.data.schedule,{terms:'1',repaymentYuan:'100',firstPaymentDate:'2026-08-02'})
  await h.page.preview();h.page.data.confirmed=true
  await h.page.save(); assert.equal(stored.kind, 'installment'); assert.equal(stored.baselinePrincipalMinor, '10000')
  assert.equal(stored.generatePlan,true)
  assert.equal(h.calls.filter(c => c.name === 'loans.record').length, 0)
  assert.match(h.routes[0], /loan-detail\/index\?loanId=loan&sourceTransactionId=synthetic-tx/)
  fail = true; await h.page.load(); await h.page.save()
  assert.equal(h.page.data.sourceReady, false); assert.equal(h.routes.length, 1)
})

test('新分期的编辑跳转保留正在关联的还款；从手动/导入还款新增沿用实际日期',()=>{
  const detail=runtime('loan-detail',()=>{throw Error('不应读取')})
  detail.page.onLoad({loanId:'loan',sourceTransactionId:'synthetic-tx'})
  detail.page.setData({loan:{...loan,installmentSetup:{historicalPaidTerms:3}}});detail.page.edit()
  assert.equal(detail.routes[0],'/pages/loan-form/index?loanId=loan&sourceTransactionId=synthetic-tx')
  const entry=runtime('repayment-entry',()=>{throw Error('不应读取')})
  entry.page.onLoad({});entry.page.setData({debts:[{accountId:'debt'}],debtIndex:0,date:'2026-04-02'})
  entry.page.createLoan();assert.match(entry.routes[0],/accountId=debt&baselineDate=2026-04-02$/)
  entry.page.setData({event:{occurredLocalAt:'2026-03-03T12:00:00'}});entry.page.createLoan()
  assert.match(entry.routes[1],/accountId=debt&baselineDate=2026-03-03$/)
})

test('原还款已有账目模式锁定，完整来源总额/秒毫秒和原时区保留，不默认本金', async () => {
  const group = { ...sourceResult, transactions: [{ ...transaction, amountMinor: '800' }, { ...transaction, transactionId: 'fee', type: 'expense', destinationAccount: null, amountMinor: '200' }] }
  const h = runtime('loan-payment', name => name === 'catalog.get' ? catalog : name === 'loans.get' ? { loan } : group)
  h.page.onLoad({ loanId: 'loan', sourceTransactionId: transaction.transactionId }); await h.page.load()
  assert.equal(h.page.data.modeIndex, 1); assert.equal(h.page.data.sourceLocked, true)
  assert.equal(h.page.data.totalYuan, '10.00'); assert.equal(h.page.data.allocations[0].principalYuan, '')
  assert.equal(h.page.data.sourceTransactions.length, 2); assert.equal(h.page.data.sourceEvidence.items[0].fields[0].value, '2/12')
  assert.equal(h.page.data.sourceTiming.occurredLocalAt, '2026-08-02T18:15:15.123'); assert.equal(h.page.data.sourceTiming.timezoneOffsetMinutes, -480)
  h.page.chooseMode({ detail: { value: 0 } }); assert.equal(h.page.data.modeIndex, 1)
  h.page.chooseEntryMode({ detail: { value: 1 } }); assert.equal(h.page.data.modeIndex, 2); assert.ok(h.page.data.source)
  assert.equal(h.calls.filter(c => c.name === 'loans.record').length, 0)
  Object.assign(h.page.data, { confirmed: true }); Object.assign(h.page.data.allocations[0], { principalYuan: '10', interestYuan: '0', feeYuan: '0' })
  assert.throws(() => paymentModel.payload({ ...h.page.data, modeIndex: 0 }), /不能重复/)
  const payload = paymentModel.payload(h.page.data)
  assert.equal(payload.mode, 'correctExisting'); assert.equal(payload.totalMinor, '1000'); assert.equal(payload.source.fingerprint, 'synthetic-fingerprint')
  assert.equal(payload.occurredLocalAt, transaction.occurredLocalAt); assert.equal(payload.timezoneOffsetMinutes, -480)
})

test('来源/目录重读失败清空可提交来源，卸载后迟到信息不能回填', async () => {
  let fail = false, resolve
  const h = runtime('loan-payment', name => {
    if (name === 'catalog.get') { if (fail) throw new Error('合成目录失败'); return catalog }
    if (name === 'loans.get') return { loan }
    return sourceResult
  })
  h.page.onLoad({ loanId: 'loan', sourceTransactionId: transaction.transactionId }); await h.page.load(); assert.ok(h.page.data.source)
  fail = true; await h.page.load(); assert.equal(h.page.data.source, null); assert.equal(h.page.data.confirmed, false)
  const late = runtime('loan-payment', name => name === 'catalog.get' ? catalog : name === 'loans.get' ? { loan } : new Promise(done => { resolve = done }))
  late.page.onLoad({ loanId: 'loan', sourceTransactionId: transaction.transactionId }); const pending = late.page.load(); await flush()
  late.page.onUnload(); resolve(sourceResult); await pending; assert.equal(late.page.data.source, null)
})

test('账单详情保留已有关联；普通信用卡转账不开放贷款入口，其他借款仍可关联', async () => {
  let result = linkedContext(), live = true, fail = false
  const routes = [], calls = []
  const session = { isCurrent: () => live, capture: () => () => live }
  const methods = createLoanContext({ session, navigate: o => routes.push(o.url), api: { callApi(name, data) {
    calls.push({ name, data }); if (fail) return Promise.reject(new Error('合成关联读取失败')); return Promise.resolve(result)
  } } })
  const page = { ...methods, data: { transactionId: transaction.transactionId, mode: 'import', readonlyDetail: true, categoryDirty: true, detail: { canEditCategory: true } }, setData(patch) { Object.assign(this.data, patch) } }
  await page.loadLoanContext()
  assert.equal(page.data.loanManaged, true); assert.equal(page.data.detail.canEditCategory, false)
  page.openLinkedLoan({ currentTarget: { dataset: { id: 'loan', plan: 'yes' } } })
  assert.equal(routes[0], '/pages/loan-plan/index?loanId=loan&paymentId=payment')
  result = ordinaryContext; await page.loadLoanContext()
  assert.equal(page.data.loanManaged, false); assert.equal(page.data.loanContext.state, 'none')
  page.openLoanLink(); assert.equal(routes.length, 1)
  result = context; await page.loadLoanContext(); assert.equal(page.data.loanManaged, true)
  page.openLoanLink(); assert.match(routes[1], /transactionId=synthetic-tx/)
  fail = true; await page.loadLoanContext(); assert.equal(page.data.loanContext, null); assert.match(page.data.loanContextError, /读取失败/)
  page.openLoanLink(); assert.equal(routes.length, 2)
  live = false; await page.loadLoanContext(); assert.equal(calls.length, 4)
})

test('贷款/账目/期次更改使衔接查询缓存失效，原普通记账不受来源锁影响', () => {
  for (const action of ['loans.record', 'loans.correct', 'loans.reverse', 'loans.allocatePeriods', 'loans.savePeriod', 'transactions.deleteMany', 'accounts.archive']) {
    for (const read of ['loans.transaction', 'loans.unassigned']) assert.ok(READ_POLICIES[read].tags.some(tag => mutationTags(action).includes(tag)), action)
  }
  const data = { accounts: catalog.accounts, accountIndex: 0, categories: [], confirmed: true, totalYuan: '10', date: '2026-08-02', time: '18:15', kindIndex: 0, modeIndex: 0,
    allocations: [{ ...paymentModel.allocation(loan), principalYuan: '10', interestYuan: '0', feeYuan: '0' }] }
  assert.equal(paymentModel.payload(data).mode, 'new')
  assert.throws(() => paymentModel.payload({ ...data, sourceLocked: true }), /不能重复/)
})


test('贷款首页真实待办数量来自服务端；零时入口隐藏',async()=>{
  let count=0
  const h=runtime('loans',()=>({ items:[],nextCursor:null,pendingRepaymentCount:count }))
  h.page.onLoad();await h.page.loadLoans();assert.equal(h.page.data.pendingRepaymentCount,0)
  count=2;await h.page.loadLoans(true);assert.equal(h.page.data.pendingRepaymentCount,2)
  assert.match(fs.readFileSync(path.join(__dirname,'../miniprogram/pages/loans/index.wxml'),'utf8'),/wx:if="{{pendingRepaymentCount > 0}}"/)
})

test('手动借款还款显式确认全部分项；成功离开旧记账表单，避免再记普通转账',async()=>{
  const h=runtime('repayment-entry',(action)=> action==='catalog.get' ? catalog : action==='loans.list' ? { items:[loan],nextCursor:null } : { paymentId:'new',pending:true })
  h.app.globalData.repaymentDraft={ type:'transfer',sourceAccountId:'wallet',destinationAccountId:'debt',amountMinor:'1000',occurredLocalAt:'2026-08-02T12:00:00',timezoneOffsetMinutes:-480 }
  h.page.onLoad({});await h.page.load()
  h.page.setData({ principalYuan:'10',interestYuan:'',feeYuan:'0',confirmed:true })
  await h.page.save();assert.match(h.page.data.errorMessage,/都需要确认/)
  assert.equal(h.calls.some(c=>c.name==='loans.bookRepayment'),false)
  h.page.setData({ interestYuan:'0',confirmed:true });await h.page.save()
  const write=h.calls.find(c=>c.name==='loans.bookRepayment')
  assert.equal(write.data.repayment.mode,'defer');assert.equal(write.data.repayment.principalMinor,'1000')
  assert.equal(h.routes[0],'/pages/transactions/index')
})

test('导入普通转账默认不关联；未知借款构成保存待核对而非全本金',async()=>{
  const row={ eventId:'event',version:3,economicNature:'repayment',ledgerAccountId:'wallet',counterpartyLedgerAccountId:'debt',amountMinor:'1000' }
  const h=runtime('repayment-entry',action=>action==='catalog.get' ? catalog : action==='economicEvents.list' ? { items:[row],update:{ updateId:'update',version:7,status:'review' } } : action==='financeUpdates.options' ? { items:[],nextCursor:null } : action==='loans.list' ? { items:[loan],nextCursor:null } : { update:{ status:'review' } })
  h.page.onLoad({ updateId:'update',eventId:'event' });await h.page.load()
  assert.equal(h.page.data.classification,0)
  h.page.setData({ classification:1 });await h.page.keepReview()
  const write=h.calls.find(c=>c.name==='financeUpdates.setRepayment')
  assert.equal(write.data.repayment.mode,'review');assert.equal(write.data.updateVersion,7);assert.equal(write.data.eventVersion,3)
  assert.equal(h.calls.some(c=>c.name==='loans.bookRepayment'),false)
})

test('延期还款关联只发送付款与贷款版本，金额分项来自已确认记录',async()=>{
  const h=runtime('repayment-entry',action=>action==='catalog.get' ? catalog : action==='loans.payment' ? { payment:{ paymentId:'pending',version:2,status:'active',assetAccountId:'wallet',totalMinor:'1000' },repayment:{ liabilityAccountId:'debt',principalMinor:'1000',interestMinor:'0',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense' },allocations:[] } : action==='loans.list' ? { items:[loan],nextCursor:null } : { paymentId:'pending' })
  h.page.onLoad({ paymentId:'pending',loanId:'loan' });await h.page.load();h.page.setData({ confirmed:true });await h.page.save()
  const write=h.calls.find(c=>c.name==='loans.assignRepayment')
  assert.equal(write.data.version,2);assert.equal(write.data.loanVersion,1);assert.equal(write.data.totalMinor,undefined)
  assert.equal(h.calls.some(c=>c.name==='transactions.create'),false)
})
