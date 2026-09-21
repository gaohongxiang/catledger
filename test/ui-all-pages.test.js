const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const root = path.join(__dirname, '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')
const routes = JSON.parse(read('miniprogram/app.json')).pages

function runtime(route, callApi) {
  const filename = path.join(root, 'miniprogram', route + '.js')
  const req = createRequire(filename)
  let definition
  const calls = [], storage = new Map()
  const app = { hasLoginApproval: () => true, globalData: { categories: [], profile: {}, ledgerRevision: 0, uid: '1234567890' } }
  const api = { peek: () => null, isFresh: () => false, cacheToken: () => null, createRequestId: () => 'synthetic-request', bootstrap: () => Promise.resolve({ categories: [] }), callApi: (name, data) => {
    calls.push({ name, data });
    if (name === 'transactions.commandResult') return Promise.reject(Object.assign(new Error('未确认'), { code: 'OPERATION_UNCONFIRMED' }))
    return callApi ? callApi(name, data) : Promise.resolve({ accounts: [], categories: [] })
  }, callImport: () => { throw new Error('预览测试禁止真实导入写入') } }
  const chrome = { getWindowInfo: () => ({ windowWidth: 375 }), showModal() {}, showToast() {}, navigateTo() {}, redirectTo() {}, navigateBack() {}, nextTick: cb => cb(), stopPullDownRefresh() {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: p => { definition = p }, getApp: () => app, wx: chrome,
    getCurrentPages: () => [], console,
    require: name => {
      if (name.includes('/services/catledger-api') || name.includes('/services/catledger-import')) return api
      if (name.includes('/services/pending-ledger-write')) return req(name).createPendingWrite({ scope: () => app.globalData.uid,
        read: key => storage.get(key), write: (key, value) => storage.set(key, value), remove: key => storage.delete(key),
        requestId: api.createRequestId, call: (_, action, data) => api.callApi(action, data) })
      if (name.includes('/services/login-guard')) return { run: (p, cb) => { if (app.hasLoginApproval()) return cb() } }
      if (name.includes('/theme/service')) return { bindPage() {}, currentTokens: () => ({ accent: '#BE5B24' }) }
      if (name === './source' && route === 'pages/loan-payment/index') {
        const source = { exports: {} }
        vm.runInNewContext(req('node:fs').readFileSync(req.resolve('./source'), 'utf8'), { module: source,
          require: dep => dep.includes('/services/catledger-api') ? api : req(dep) })
        return source.exports
      }
      return req(name)
    }
  }, { filename })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), getTabBar: () => null,
    setData(patch) { for (const [key, value] of Object.entries(patch)) {
      const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.data
      for (const k of keys.slice(0, -1)) target = target[k] || (target[k] = {})
      target[keys.at(-1)] = value
    } } }
  return { page, app, calls, api, chrome }
}

test('分期资料与计划响应丢失后修改表单仍恢复原请求，保存后进入权威资料', async () => {
  const account = { accountId: 'debt', name: '合成负债', type: 'credit', archived: false }
  let stored = null, attempts = 0
  const { page, calls, chrome } = runtime('pages/loan-form/index', (action, data) => {
    if (action === 'catalog.get') return Promise.resolve({ uid: '1234567890', accounts: [account] })
    if (action === 'loans.create') {
      attempts++
      if (!stored) stored = { ...data, loanId: 'loan', accountName: account.name, version: 1, status: 'active', remainingPrincipalMinor: data.baselinePrincipalMinor }
      return attempts === 1 ? Promise.reject(Object.assign(new Error('合成响应丢失'), { code: 'CLOUD_CALL_FAILED' })) : Promise.resolve({ loanId: 'loan', version: 1 })
    }
    if (action === 'loans.get') return Promise.resolve({ loan: stored })
    if (action === 'loans.previewPlan') return Promise.resolve(require('../cloudfunctions/catledger-api/src/loan-installment').remainingSchedule(data))
    throw new Error('unexpected action')
  })
  page.onLoad({}); await page.load()
  Object.assign(page.data, { name: '合成借款',accountIndex:0, principalYuan: '12000', baselineDate: '2026-09-01',paidTerms:'3',schedule:{...page.data.schedule,terms:'12',repaymentYuan:'1100',firstPaymentDate:'2026-01-31'} })
  let target;chrome.redirectTo=options=>{target=options.url}
  await page.save();assert.equal(calls.filter(x=>x.name==='loans.create').length,0)
  page.confirm({detail:{value:['confirmed']}})
  await page.save(); assert.equal(page.data.hasPending, true)
  page.data.principalYuan = '999.00'
  await page.save()
  const writes = calls.filter(x => x.name === 'loans.create')
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].data, writes[0].data)
  assert.equal(stored.baselinePrincipalMinor, '900000');assert.equal(stored.installmentSetup.originalPrincipalMinor,'1200000')
  assert.equal(stored.generatePlan,true);assert.match(target,/loan-detail\/index\?loanId=loan$/)
  assert.equal(page.data.hasPending, false)
  assert.match(page.data.savedMessage, /已保存/)
})

test('分期首次日期不推断历史已还；旧试算响应和退出后的响应不得覆盖新输入',async()=>{
  let resolve
  const {page}=runtime('pages/loan-form/index',action=>action==='catalog.get'?Promise.resolve({uid:'1234567890',accounts:[]}):new Promise(done=>{resolve=done}))
  page.onLoad({});await page.load()
  Object.assign(page.data,{principalYuan:'12000',schedule:{...page.data.schedule,terms:'12',repaymentYuan:'1100'}})
  page.scheduleInput({currentTarget:{dataset:{field:'firstPaymentDate'}},detail:{value:'2020-01-31'}})
  assert.equal(page.data.paidTerms,'0')
  const waiting=page.preview()
  page.input({currentTarget:{dataset:{field:'paidTerms'}},detail:{value:'3'}})
  resolve({summary:{remainingPrincipalMinor:'1200000'}});await waiting
  assert.equal(page.data.preview,null);assert.equal(page._preview,null)
  const closing=page.preview();page.onUnload();resolve({summary:{remainingPrincipalMinor:'900000'}});await closing
  assert.equal(page.data.preview,null)
})

test('新分期编辑固定原本金与历史参数；读取失败不能误建新贷款',async()=>{
  const data={name:'合成',principalYuan:'12000',paidTerms:'3',typeIndex:0,discountIndex:0,discountValue:'',schedule:{terms:'12',methodIndex:0,measurementIndex:1,repaymentYuan:'1100',firstPaymentDate:'2026-01-31'}}
  const value=require('../miniprogram/pages/loan-form/model').previewInput(data)
  const loan={...value,loanId:'loan',name:'合成',kind:'installment',baselinePrincipalMinor:'900000',baselineDate:'2026-04-01',version:1,accountId:'debt'}
  const {page}=runtime('pages/loan-form/index',action=>Promise.resolve(action==='catalog.get'?{uid:'1234567890',accounts:[{accountId:'debt',type:'credit'}]}:{loan}))
  page.onLoad({loanId:'loan',sourceTransactionId:'synthetic-linked'});await page.load()
  assert.equal(page.data.loan.loanId,'loan');assert.equal(page.data.sourceReady,true)
  page.input({currentTarget:{dataset:{field:'paidTerms'}},detail:{value:'12'}})
  page.scheduleInput({currentTarget:{dataset:{field:'terms'}},detail:{value:'36'}})
  assert.equal(page.data.paidTerms,'3');assert.equal(page.data.schedule.terms,'12')
  const failed=runtime('pages/loan-form/index',()=>Promise.reject(new Error('合成读取失败')))
  failed.page.onLoad({loanId:'loan'});await failed.page.load();await failed.page.save()
  assert.equal(failed.calls.some(c=>c.name==='loans.create'||c.name==='loans.previewPlan'),false)
})

test('贷款分页只保留当前页和五个返回游标，退出后迟到响应不回填', async () => {
  const { page } = runtime('pages/loans/index', (_, data) => Promise.resolve({
    items: [{ loanId: data.cursor || 'first', remainingPrincipalMinor: null, status: 'unknown' }], nextCursor: 'next-' + (data.cursor || 'first')
  }))
  page.onLoad(); await page.loadLoans()
  assert.equal(page.data.items[0].principalText, '待补充')
  for (let i = 0; i < 10; i++) await page.nextPage()
  assert.equal(page.data.items.length, 1); assert.equal(page._previous.length, 5)
  let resolve
  const late = runtime('pages/loans/index', () => new Promise(done => { resolve = done }))
  late.page.onLoad(); const loading = late.page.loadLoans(); late.page.onUnload()
  resolve({ items: [{ loanId: 'private-old', remainingPrincipalMinor: '0', status: 'settled' }], nextCursor: null })
  await loading; assert.equal(late.page.data.items.length, 0)
  const { present } = require('../miniprogram/pages/loans/model')
  assert.equal(present({ remainingPrincipalMinor: '0', status: 'settled' }).principalText, '¥0.00')
})

test('贷款实际借还丢失响应后保留原金额；成功后刷新失败不重复写入', async () => {
  const loan = { loanId: 'loan', name: '合成贷款', kind: 'borrowing', version: 1 }
  let attempts = 0, created = null
  const { page, calls } = runtime('pages/loan-payment/index', (action, data) => {
    if (action === 'catalog.get') return Promise.resolve({ uid: '1234567890', accounts: [{ accountId: 'bank', name: '合成银行', type: 'bank' }], categories: [] })
    if (action === 'loans.get') return Promise.resolve({ loan })
    if (action === 'loans.record') {
      attempts++; created = created || data
      return attempts === 1 ? Promise.reject(Object.assign(new Error('合成丢失'), { code: 'CLOUD_CALL_FAILED' })) : Promise.resolve({ paymentId: 'payment', version: 1 })
    }
    if (action === 'loans.payment') return Promise.reject(new Error('合成读取失败'))
    throw new Error('unexpected action')
  })
  page.onLoad({ loanId: 'loan' }); await page.load()
  Object.assign(page.data, { accountIndex: 0, totalYuan: '10', date: '2026-09-02', confirmed: true })
  Object.assign(page.data.allocations[0], { principalYuan: '10', interestYuan: '0', feeYuan: '0' })
  await page.save(); assert.equal(page.data.hasPending, true)
  page.data.totalYuan = '99'; await page.save()
  const writes = calls.filter(x => x.name === 'loans.record')
  assert.equal(writes.length, 2); assert.deepEqual(writes[0].data, writes[1].data)
  assert.equal(created.totalMinor, '1000'); assert.equal(page.data.hasPending, false)
  assert.equal(page._paymentId, 'payment'); assert.match(page.data.savedMessage, /完成/)
  assert.match(page.data.errorMessage, /读取失败/)
  await page.save(); assert.equal(calls.filter(x => x.name === 'loans.record').length, 2)
})

test('借还表单刷新目录按身份保留选项，关闭后晚到响应不回填', async () => {
  let reversed = false
  const catalog = { uid: '1234567890', accounts: [{ accountId: 'a', type: 'bank' }, { accountId: 'b', type: 'bank' }], categories: [{ id: 'c', kind: 'expense' }, { id: 'd', kind: 'expense' }] }
  const { page } = runtime('pages/loan-payment/index', action => {
    if (action === 'catalog.get') return Promise.resolve({ ...catalog, accounts: reversed ? catalog.accounts.slice().reverse() : catalog.accounts, categories: reversed ? catalog.categories.slice().reverse() : catalog.categories })
    return Promise.resolve({ loan: { loanId: 'loan', name: '合成贷款', kind: 'borrowing', version: 1 } })
  })
  page.onLoad({ loanId: 'loan' }); await page.load()
  page.data.accountIndex = 1; page.data.allocations[0].interestCategoryIndex = 1
  page.data.allocations[0].principalYuan = '800'; page.data.confirmed = true
  reversed = true; await page.load()
  assert.equal(page.data.accounts[page.data.accountIndex].accountId, 'b')
  assert.equal(page.data.categories[page.data.allocations[0].interestCategoryIndex].id, 'd')
  assert.equal(page.data.allocations[0].principalYuan, '800'); assert.equal(page.data.confirmed, false)
  let resolve
  const late = runtime('pages/loan-payment/index', () => new Promise(done => { resolve = done }))
  late.page.onLoad({ loanId: 'loan' }); const loading = late.page.load(); late.page.onUnload()
  resolve(catalog); await loading; assert.equal(late.page.data.accounts.length, 0)
})

test('实际借还表单必须明确零和构成，整数守恒支持大额而不经过浮点', () => {
  assert.ok(routes.includes('pages/loan-payment/index'))
  const model = require('../miniprogram/pages/loan-payment/model')
  const data = { accountIndex: 0, accounts: [{ accountId: 'bank' }], categories: [{ id: 'expense' }], confirmed: true, kindIndex: 0,
    totalYuan: '1000', date: '2026-09-02', time: '10:00', allocations: [{ loanId: 'loan', version: 1, principalYuan: '800', interestYuan: '180', feeYuan: '20', interestIndex: 0, feeIndex: 0, interestCategoryIndex: 0, feeCategoryIndex: 0 }] }
  assert.equal(model.payload(data).totalMinor, '100000')
  assert.match(model.review(data), /¥200.00/)
  assert.throws(() => model.payload({ ...data, allocations: [{ ...data.allocations[0], feeYuan: '' }] }), /金额/)
  assert.throws(() => model.payload({ ...data, totalYuan: '999' }), /之和/)
  assert.throws(() => model.payload({ ...data, confirmed: false }), /核对/)
  assert.equal(model.payload({ ...data, totalYuan: '90071992547409.93', allocations: [{ ...data.allocations[0], principalYuan: '90071992547409.91', interestYuan: '0.01', feeYuan: '0.01' }] }).totalMinor, '9007199254740993')
})

for (const route of routes) {
  test(route + '：页面、主题和全部声明事件完整，WXML 标签配对', () => {
    const markup = read('miniprogram/' + route + '.wxml')
    const style = read('miniprogram/' + route + '.wxss')
    const { page } = runtime(route)
    assert.ok(style.trim().length > 100)
    assert.match(markup, /themeClass/)
    assert.match(markup, /themeStyle/)
    for (const event of markup.matchAll(/(?:bind|catch)(?:\:)?[\w-]+="([A-Za-z][\w]*)"/g)) {
      assert.equal(typeof page[event[1]], 'function', route + ' 丢失事件 ' + event[1])
    }
    const stack = []
    const tags = markup.replace(/<!--[\s\S]*?-->/g, '').match(/<\/?[\w-]+\b(?:[^>"']|"[^"]*"|'[^']*')*\/?>/g) || []
    for (const tag of tags) {
      const name = tag.match(/^<\/?([\w-]+)/)[1]
      if (tag.startsWith('</')) assert.equal(stack.pop(), name, route + ' 标签不配对')
      else if (!tag.endsWith('/>')) stack.push(name)
      assert.doesNotMatch(tag, /disabled="\{[^{}]/, '动态布尔值必须使用双大括号')
    }
    assert.equal(stack.length, 0)
  })
}

test('现有路由有交付记录，单笔编辑不再注册整批维护页', () => {
  assert.equal(routes.includes('pages/import-maintenance/index'), false)
  const inventory = read('specs/mini-1906ui-all-pages/README.md')
  for (const route of routes) assert.ok(inventory.includes(route.split('/')[1]), route)
})

test('账本与个人页：初次读取失败不冒充成功零值，成功后更新，刷新失败保留原数量', async () => {
  for (const name of ['ledger', 'profile']) {
    let fail = true
    const { page } = runtime('pages/' + name + '/index', () => fail ? Promise.reject(new Error('合成离线')) : Promise.resolve({ accounts: [{ nature: 'asset' }] }))
    page.data.loggedIn = true
    const load = name === 'ledger' ? 'loadLedger' : 'loadProfile'
    await page[load]()
    assert.equal(page.data.hasLoaded, false)
    assert.ok(page.data.errorMessage)
    fail = false; await page[load]()
    assert.equal(page.data.hasLoaded, true)
    assert.equal(page.data.accountCount, 1)
    fail = true; await page[load]()
    assert.equal(page.data.accountCount, 1)
    assert.equal(page.data.hasLoaded, true)
    assert.ok(page.data.errorMessage)
    const countPresentation = name === 'ledger'
      ? /loggedIn && hasLoaded \? accountCount : '—'/
      : /loggedIn && hasLoaded \? accountCount \+ ' 个活动账户' : '管理资产与负债账户'/
    assert.match(read('miniprogram/pages/' + name + '/index.wxml'), countPresentation)
  }
})

function statisticsResult() {
  return { summary: { incomeMinor: '0', expenseMinor: '20000', netIncomeMinor: '-20000' }, metrics: {}, uncategorized: {},
    cashFlowTrend: [{ month: '2026-08', incomeMinor: '0', expenseMinor: '20000', incomeHeightPermille: 0, expenseHeightPermille: 1000 }],
    daily: [{ date: '2026-08-01', incomeMinor: '0', expenseMinor: '20000', incomeHeightPermille: 0, expenseHeightPermille: 1000 }],
    expenseCategories: [{ categoryId: 'test', name: '合成分类', amountMinor: '0', shareBasisPoints: 0 }], incomeCategories: [] }
}
test('统计展示保留金额、比例与零值，点击仅选择已有读模型', async () => {
  const { page, calls } = runtime('pages/statistics/index', () => Promise.resolve(statisticsResult()))
  await page.loadStatistics()
  assert.equal(page.data.hasLoaded, true)
  const monthlySvg = decodeURIComponent(page.data.charts.monthlyChart.src.split(',').slice(1).join(','))
  assert.equal((monthlySvg.match(/<rect /g) || []).length, 1)
  assert.equal(page.data.charts.monthlyChart.maxText, '¥200.00')
  assert.equal(page.data.charts.monthlyChart.minText, '¥0.00')
  assert.equal(page.data.expenseCategories[0].barWidth, '0%')
  page.selectTrend({ currentTarget: { dataset: { index: 0 } } })
  page.selectDay({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(page.data.selectedTrend.expenseText, '¥200.00')
  assert.equal(page.data.selectedDay.incomeText, '¥0.00')
  assert.equal(page.data.categoryKind, '')
  page.selectCategoryKind({ currentTarget: { dataset: { kind: 'income' } } })
  assert.equal(page.data.categoryKind, 'income')
  page.selectCategoryKind({ currentTarget: { dataset: { kind: 'invalid' } } })
  assert.equal(page.data.categoryKind, 'income')
  page.selectCategoryKind({ currentTarget: { dataset: { kind: 'income' } } })
  assert.equal(page.data.categoryKind, '')
  assert.equal(calls.length, 1)
})
test('统计读取中不能改月份，下一月读取失败不在新标题下显示上月图表', async () => {
  const { page } = runtime('pages/statistics/index', () => Promise.reject(new Error('合成错误')))
  page.data.month = '2026-08'; page.data.loading = true
  page.chooseMonth({ detail: { value: '2026-09' } }); assert.equal(page.data.month, '2026-08')
  page.data.loading = false; page.data.hasLoaded = true
  page.chooseMonth({ detail: { value: '2026-09' } }); assert.equal(page.data.hasLoaded, false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.data.month, '2026-09'); assert.equal(page.data.hasLoaded, false)
})

test('整合PR7：移除最后一个待解析文件后，selected状态仍可继续成功文件', () => {
  const markup = read('miniprogram/pages/import-workbench/index.wxml')
  const expr = markup.match(/data-ui="parse-result" wx:if="{{(.*?)}}"/)[1]
  assert.equal(vm.runInNewContext(expr, { phase: 'selected', files: [{ state: 'ready' }], uploadSummary: { queued: 0 } }), true)
  assert.equal(vm.runInNewContext(expr, { phase: 'selected', files: [{ state: 'queued' }], uploadSummary: { queued: 1 } }), false)
})

test('整合PR7：付款账户提示和来源展开不改变模型校验或保存结果', () => {
  const { page, calls } = runtime('pages/import-workbench/index')
  page.data.currentIssue = { paymentAccountsOnly: true }
  page.data.paymentRows = [{ componentIndex: 0, accountId: 'a' }, { componentIndex: 1, accountId: 'a' }]
  assert.equal(page.refreshPaymentDraft().valid, false)
  assert.ok(page.data.paymentValidationHint)
  page.toggleIssueSource(); assert.equal(page.data.issueSourceExpanded, true)
  assert.equal(page.data.paymentCanSave, false)
  page.data.paymentRows[1].accountId = 'b'
  assert.equal(page.refreshPaymentDraft().valid, true)
  assert.equal(page.data.paymentValidationHint, '')
  assert.equal(calls.length, 0)
})

test('整理数量公式常驻，保留最新账户同行选择', () => {
  const code = read('miniprogram/pages/import-workbench/index.js')
  const markup = read('miniprogram/pages/import-workbench/index.wxml')
  assert.doesNotMatch(code, /toggleRecordSummary:|recordSummaryExpanded:/)
  assert.match(markup, /final-count-formulas/)
  assert.match(markup, /account-decision-create/)
  assert.doesNotMatch(markup, /account-create-fields/)
  assert.match(markup, /issueFieldsReason/)
  assert.match(markup, /paymentValidationHint/)
  assert.match(markup, /!currentIssue.paymentNeedsReview \|\| issueSourceExpanded/)
})

test('分类拖拽命中行高与最终布局相同，排序限定同级', () => {
  const { page } = runtime('pages/categories/index')
  page.applyCategories([{id:'a',kind:'expense',name:'合成大类',archived:false,sortOrder:10}, {id:'b',kind:'expense',name:'合成子类',parentId:'a',archived:false,sortOrder:10}])
  page.startCategoryDrag({ currentTarget: { dataset: { index: 0, id: 'a' } }, touches: [{ clientY: 20 }] })
  assert.equal(page.categoryDrag.rowHeight, 58)
  assert.deepEqual(page.categoryDrag.siblings.map(row => row.id), ['a'])
  assert.match(read('miniprogram/pages/categories/index.wxss'), /height:\s*116rpx;\s*min-height:\s*116rpx/)
  assert.match(read('miniprogram/pages/categories/index.js'), /categoryModel.reorder\(drag.siblings, drag.index, drag.target\)/)
})

test('记账目录失败仍能编辑本地草稿，重试成功后允许选择账户', async () => {
  let fail = true
  const { page } = runtime('pages/transaction-editor/index', name => fail ? Promise.reject(new Error('合成失败')) : Promise.resolve(name === 'catalog.get' ? { accounts: [{ accountId: 'a', name: '测试账户' }] } : { transactions: [] }))
  await page.prepareForm()
  assert.equal(page.data.preparing, false); assert.equal(page.data.formReady, true); assert.equal(page.data.catalogReady, false); assert.ok(page.data.catalogError)
  fail = false; await page.prepareForm()
  assert.equal(page.data.formReady, true); assert.equal(page.data.preparing, false)
  assert.equal(page.data.accounts.length, 1)
})

test('各编辑弹层错误可见，金额/名称拥有标签，保存继续保留禁用门禁', () => {
  for (const route of ['accounts', 'categories', 'statistics']) {
    const markup = read('miniprogram/pages/' + route + '/index.wxml')
    assert.match(markup, /class="sheet-error"/)
  }
  for (const route of ['accounts', 'transaction-editor']) {
    const markup = read('miniprogram/pages/' + route + '/index.wxml')
    assert.match(markup, /aria-label=/)
    assert.match(markup, /cursor-spacing=/)
    assert.match(markup, /disabled="{{(?:busy|saving)/)
  }
})


test('编辑已停用账户的账目可见原值，但提交保持阻断', async () => {
  const { page, app } = runtime('pages/transaction-editor/index', name => Promise.resolve(name === 'catalog.get' ? { accounts: [{ accountId: 'active', name: '可用测试账户' }] } : { transactions: [] }))
  page.data.mode = 'edit'
  app.globalData.editingTransaction = { type: 'expense', transactionId: 'old', sourceAccount: { accountId: 'archived' } }
  await page.prepareForm()
  assert.equal(page.data.preparing, false)
  assert.equal(page.data.formReady, true)
  assert.equal(page.data.editingBlocked, true)
  assert.match(page.data.errorMessage, /停用/)
})

 test('统计补全弹层覆盖底栏，关闭及离开恢复导航', () => {
  const { page } = runtime('pages/statistics/index')
  let hidden = false
  page.getTabBar = () => ({ setData: patch => { hidden = patch.hidden } })
  page.openCategoryCompletion()
  assert.equal(hidden, true)
  page.closeCategoryCompletion()
  assert.equal(hidden, false)
  page.setTabHidden(true)
  page.onHide()
  assert.equal(hidden, false)
  assert.equal(page.data.categorySheetOpen, false)
})

 test('明细精确打开被点击账目，导入进入分类编辑，手动进入完整编辑', () => {
  const { page, app, chrome } = runtime('pages/transactions/index')
  const paths = []
  chrome.navigateTo = options => paths.push(options.url)
  page.data.transactions = [
    { transactionId: 'manual-a', origin: 'manual', editable: true },
    { transactionId: 'import-b', origin: 'import', editable: false, importContext: { updateId: 'batch-b', eventId: 'event-b' } }
  ]
  page.editTransaction({ currentTarget: { dataset: { index: 1 } } })
  assert.equal(app.globalData.editingTransaction.transactionId, 'import-b')
  assert.equal(paths[0], '/pages/transaction-editor/index?mode=import')
  page.editTransaction({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(app.globalData.editingTransaction.transactionId, 'manual-a')
  assert.equal(paths[1], '/pages/transaction-editor/index?mode=edit')
})

 test('导入账目不依赖可用账户读取，只提交所选交易的分类并保持失败重试请求号', async () => {
  let fail = true
  const { page, app, api, calls } = runtime('pages/transaction-editor/index', name => name === 'catalog.get' ? Promise.resolve({ categories: [{ id: 'new-category', name: '餐饮', kind: 'expense' }] }) : fail ? Promise.reject(new Error('合成网络错误')) : Promise.resolve({ version: 3 }))
  api.bootstrap = () => Promise.resolve({ categories: [{ id: 'new-category', name: '餐饮', kind: 'expense' }] })
  app.globalData.editingTransaction = { transactionId: 'clicked-entry', version: 2, origin: 'import', type: 'expense', amountMinor: '1596', occurredLocalAt: '2026-07-18T12:00:00', sourceAccount: { accountId: 'archived-a', name: '原账户' }, category: null, note: '合成说明' }
  page.setData({ mode: 'import', readonlyDetail: true })
  await page.prepareForm()
  assert.equal(page.data.formReady, true)
  assert.equal(page.data.transactionId, 'clicked-entry')
  assert.equal(page.data.detail.amountText, '¥15.96')
  assert.deepEqual(calls.map(call => call.name), ['loans.transaction', 'catalog.get'])
  calls.length = 0
  page.changeDetailCategory({ detail: { value: 1 } })
  await page.saveDetailCategory()
  assert.ok(page.data.errorMessage)
  const first = calls[0]
  assert.equal(first.name, 'transactions.setCategory')
  assert.deepEqual(Object.keys(first.data).sort(), ['categoryId', 'requestId', 'transactionId', 'version'])
  assert.equal(first.data.transactionId, 'clicked-entry')
  fail = false
  await page.saveDetailCategory()
  assert.equal(calls[1].data.requestId, first.data.requestId)
})

 test('未分类紧跟全部分类，服务器筛选请求不会伪装成分类ID', async () => {
  const { page } = runtime('pages/transactions/index')
  assert.equal(page.data.categoryFilters[0].name, '全部分类')
  assert.equal(page.data.categoryFilters[1].name, '未分类')
  page.setData({ categoryFilterIndex: 1 })
  const request = page.requestData(null)
  assert.equal(request.uncategorized, true)
  assert.equal(request.categoryId, undefined)
})

test('分类维护采用服务器实体和版本更新，冲突回读保留用户草稿', async () => {
  let reads = 0, conflict = false
  const base = { id: 'category-a', kind: 'expense', name: '原分类', archived: false, sortOrder: 10, version: 1 }
  let stored = { ...base }
  const { page } = runtime('pages/categories/index', (action, data) => {
    if (action === 'categories.list') { reads++; return Promise.resolve({ categories: [stored] }) }
    assert.equal(data.version, page.data.selectedCategory.version)
    if (conflict) { stored = { ...stored, name: '服务端更名', version: 3 }; return Promise.reject(new Error('版本冲突')) }
    stored = { ...stored, name: data.name, version: stored.version + 1 }
    return Promise.resolve(stored)
  })
  await page.loadCategories()
  page.openEdit({ currentTarget: { dataset: { id: base.id } } })
  page.bindCategoryName({ detail: { value: '新的分类' } })
  await page.saveForm()
  assert.equal(reads, 1)
  assert.equal(page.data.allCategories[0].version, 2)
  assert.equal(page.data.visibleCategories[0].name, '新的分类')
  page.openEdit({ currentTarget: { dataset: { id: base.id } } })
  page.bindCategoryName({ detail: { value: '保留草稿' } })
  conflict = true
  await page.saveForm()
  assert.equal(reads, 2)
  assert.equal(page.data.selectedCategory.version, 3)
  assert.equal(page.data.categoryName, '保留草稿')
  assert.equal(page.data.visibleCategories[0].name, '服务端更名')
  assert.match(page.data.errorMessage, /冲突/)
})

test('分类排序采用整组服务器版本，失败强制回读权威顺序', async () => {
  let reads = 0, fail = false
  const rows = ['a', 'b'].map((id, index) => ({ id, kind: 'expense', name: '合成' + id, archived: false, sortOrder: (index + 1) * 10, version: 1 }))
  const { page } = runtime('pages/categories/index', action => {
    if (action === 'categories.list') { reads++; return Promise.resolve({ categories: rows }) }
    return fail ? Promise.reject(new Error('合成排序冲突')) : Promise.resolve({ categories: rows.slice().reverse().map((row, index) => ({ ...row, sortOrder: (index + 1) * 10, version: 2 })) })
  })
  await page.loadCategories()
  page.categoryDrag = { index: 0, target: 1 }
  await page.endCategoryDrag()
  assert.equal(reads, 1)
  assert.deepEqual(Array.from(page.data.visibleCategories, row => row.id), ['b', 'a'])
  assert.ok(page.data.visibleCategories.every(row => row.version === 2))
  fail = true; page.categoryDrag = { index: 0, target: 1 }
  await page.endCategoryDrag()
  assert.equal(reads, 2)
  assert.deepEqual(Array.from(page.data.visibleCategories, row => row.id), ['a', 'b'])
  assert.equal(page.data.saving, false)
})

test('贷款来源选择保留秒与时区、整组展开和有界分页，关闭后不回填', async () => {
  const account={accountId:'asset',name:'合成付款',type:'bank'},category={id:'cat',kind:'expense'}
  const tx=id=>({transactionId:id,type:'expense',amountMinor:'50',sourceAccount:account,occurredLocalAt:'2026-09-02T12:30:45.123',timezoneOffsetMinutes:-480})
  let resolveLate
  const {page,calls}=runtime('pages/loan-payment/index',(action,data)=>{
    if(action==='catalog.get') return Promise.resolve({uid:'1234567890',accounts:[account],categories:[category]})
    if(action==='transactions.list') return Promise.resolve({transactions:[tx(data.cursor||'first')],nextCursor:'next'})
    if(action==='loans.source') return resolveLate ? new Promise(done=>{resolveLate=done}) : Promise.resolve({source:{transactionIds:['first','second'],fingerprint:'signed'},transactions:[tx('first'),tx('second')]})
    throw new Error(action)
  })
  page.onLoad({});await page.load();page.chooseMode({detail:{value:'2'}})
  await page.loadSources();page.selectSources({detail:{value:['first']}});await page.loadSources({currentTarget:{dataset:{next:true}}})
  assert.equal(page.data.sourceRows.length,1);assert.equal(page.data.sourceSelectedCount,1)
  await page.inspectSource();assert.equal(page.data.sourceTransactions.length,2);assert.equal(page.data.accountIndex,0)
  Object.assign(page.data,{confirmed:true,allocations:[{loanId:'loan',version:1,principalYuan:'0.80',interestYuan:'0.18',feeYuan:'0.02',interestIndex:0,feeIndex:0,interestCategoryIndex:0,feeCategoryIndex:0}]})
  const payload=require('../miniprogram/pages/loan-payment/model').payload(page.data)
  assert.equal(payload.occurredLocalAt,'2026-09-02T12:30:45.123');assert.equal(payload.timezoneOffsetMinutes,-480)
  assert.equal(payload.source.fingerprint,'signed');assert.equal(calls.filter(c=>c.name==='transactions.list').at(-1).data.pageSize,40)
  resolveLate=true;const late=page.inspectSource();await new Promise(done=>setImmediate(done));page.onUnload()
  resolveLate({source:{fingerprint:'late'},transactions:[tx('late')]});await late
  assert.equal(page.data.source.fingerprint,'signed')
})

test('贷款更正明确进入编辑后才能提交，读取失败不重复更正', async () => {
  const account={accountId:'asset',name:'合成付款',type:'bank'},category={id:'cat',kind:'expense'}
  const existing={payment:{paymentId:'old',version:1,status:'active',kind:'repayment',mode:'new',assetAccountId:'asset',totalMinor:'100',occurredLocalAt:'2026-09-02 12:30:45',timezoneOffsetMinutes:-480},
    allocations:[{loanId:'loan',loanName:'合成贷款',version:2,principalMinor:'80',interestMinor:'18',feeMinor:'2',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:'cat',feeCategoryId:'cat'}],transactions:[]}
  const {page,calls}=runtime('pages/loan-payment/index',(action,data)=>{
    if(action==='catalog.get') return Promise.resolve({uid:'1234567890',accounts:[account],categories:[category]})
    if(action==='loans.payment') return data.paymentId==='old'?Promise.resolve(existing):Promise.reject(new Error('合成读取失败'))
    if(action==='loans.correct') return Promise.resolve({paymentId:'new',version:1})
    throw new Error(action)
  })
  page.onLoad({paymentId:'old'});await page.load();await page.save();assert.equal(calls.filter(c=>c.name==='loans.correct').length,0)
  page.editPayment();assert.equal(page.data.editingPayment.paymentId,'old');page.data.confirmed=true
  await page.save();assert.equal(page.data.hasPayment,true);assert.equal(page.data.editingPayment,null)
  await page.save();assert.equal(calls.filter(c=>c.name==='loans.correct').length,1)
  assert.equal(calls.find(c=>c.name==='loans.correct').data.loans[0].version,2)
})

test('期次计划保存响应丢失后沿用原请求，已确认后读取失败不会再次新增',async()=>{
 const summary={unpaidPrincipalMinor:'100',unpaidInterestMinor:'0',unpaidFeeMinor:'0',remainingPrincipalMinor:'100',principalGapMinor:'0',nextDueDate:'2026-09-20'}
 let attempts=0
 const {page,calls}=runtime('pages/loan-plan/index',(action)=>{
  if(action==='loans.periods')return attempts>=2?Promise.reject(new Error('合成读取失败')):Promise.resolve({loanName:'合成贷款',loanVersion:1,items:[],nextCursor:null,summary})
  if(action==='loans.get')return Promise.resolve({loan:{loanId:'loan',version:1}})
  if(action==='loans.savePeriod'){attempts++;return attempts===1?Promise.reject(Object.assign(new Error('合成响应丢失'),{code:'CLOUD_CALL_FAILED'})):Promise.resolve({periodId:'period',version:1})}
  throw new Error(action)
 })
 page.onLoad({loanId:'loan'});await page.load();page.newPeriod()
 Object.assign(page.data.form,{periodNumber:'1',dueDate:'2026-09-20',principalYuan:'1.00',interestYuan:'0',feeYuan:'0'})
 await page.savePeriod();assert.equal(page.data.hasPending,true);page.data.form.principalYuan='999'
 await page.retry();const writes=calls.filter(c=>c.name==='loans.savePeriod');assert.equal(writes.length,2);assert.deepEqual(writes[0].data,writes[1].data)
 assert.equal(page.data.formOpen,false);assert.equal(page.data.savedMessage,'操作已完成');await page.savePeriod();assert.equal(calls.filter(c=>c.name==='loans.savePeriod').length,2)
})

test('空计划且参数齐备时可试算并生成计划，试算失败可重试，生成后入口隐去',async()=>{
 const summary={unpaidPrincipalMinor:'0',unpaidInterestMinor:'0',unpaidFeeMinor:'0',remainingPrincipalMinor:'0',principalGapMinor:'0',nextDueDate:null}
 const loan={loanId:'loan',version:3,scheduleMethod:'flat',scheduleTerms:2,measurementKind:'rate',quoteType:'annual',ratePpm:'120000'}
 const preview={periods:[{periodNumber:1,dueDate:'2026-10-01',principalMinor:'5000',interestMinor:'500',feeMinor:'0'},{periodNumber:2,dueDate:'2026-11-01',principalMinor:'5000',interestMinor:'500',feeMinor:'0'}],summary:{totalPaymentMinor:'11000',totalInterestMinor:'1000',totalFeeMinor:'0'}}
 const generatedPeriod={periodId:'p1',version:1,periodNumber:1,dueDate:'2026-10-01',status:'unpaid',principalMinor:'5000',interestMinor:'500',feeMinor:'0',unpaidPrincipalMinor:'5000',unpaidInterestMinor:'500',unpaidFeeMinor:'0'}
 let previewFails=true,generated=false
 const {page,calls}=runtime('pages/loan-plan/index',(action)=>{
  if(action==='loans.periods')return Promise.resolve({loanName:'合成贷款',loanVersion:3,items:generated?[generatedPeriod]:[],nextCursor:null,summary})
  if(action==='loans.get')return Promise.resolve({loan})
  if(action==='loans.previewPlan')return previewFails?Promise.reject(new Error('合成试算失败')):Promise.resolve(preview)
  if(action==='loans.generatePlan'){generated=true;return Promise.resolve({loanId:'loan',loanVersion:4,generated:2})}
  throw new Error(action)
 })
 page.onLoad({loanId:'loan'});await page.load()
 assert.equal(page.data.canGeneratePlan,true)
 await page.openPreview();assert.match(page.data.previewError,/试算失败/);assert.equal(page.data.preview,null)
 previewFails=false;await page.openPreview()
 assert.equal(page.data.preview.periodCount,2);assert.equal(page.data.preview.rows.length,2)
 assert.throws(()=>require('../miniprogram/pages/loan-plan/model').generatePayload(page.data),/确认/)
 page.confirmGenerate({detail:{value:['confirmed']}})
 await page.generatePlan()
 const writes=calls.filter(c=>c.name==='loans.generatePlan')
 assert.equal(writes.length,1);assert.deepEqual(writes[0].data,{loanId:'loan',version:3,confirmed:true,requestId:'synthetic-request'})
 assert.equal(page.data.savedMessage,'操作已完成')
 assert.equal(page.data.items.length,1);assert.equal(page.data.canGeneratePlan,false)
})

test('期次选择保持当前页和 40 项上限，费用分项不足不能借用本金补齐',()=>{
 const {page}=runtime('pages/loan-plan/index');page.onLoad({loanId:'loan',paymentId:'payment'})
 page.data.items=Array.from({length:41},(_,n)=>({periodId:'p'+n,version:1,periodNumber:n+1}))
 for(const item of page.data.items)page.addPeriod({currentTarget:{dataset:{id:item.periodId}}})
 assert.equal(page.data.allocationItems.length,40);assert.match(page.data.errorMessage,/40/)
 const model=require('../miniprogram/pages/loan-plan/model')
 const data={loanId:'loan',loanVersion:1,paymentId:'payment',paymentVersion:1,confirmed:true,paymentShare:{principalMinor:'100',interestMinor:'0',feeMinor:'0'},allocationItems:[{periodId:'p',version:1,principalYuan:'0.99',interestYuan:'0.01',feeYuan:'0'}]}
 assert.throws(()=>model.allocationPayload(data),/超过/)
 data.allocationItems[0].interestYuan='0';assert.match(model.allocationReview(data),/本金未分配 ¥0.01/)
})
