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
  const calls = []
  const app = { hasLoginApproval: () => true, globalData: { categories: [], profile: {}, ledgerRevision: 0 } }
  const api = { peek: () => null, isFresh: () => false, cacheToken: () => null, createRequestId: () => 'synthetic-request', bootstrap: () => Promise.resolve({ categories: [] }), callApi: (name, data) => {
    calls.push({ name, data }); return callApi ? callApi(name, data) : Promise.resolve({ accounts: [], categories: [] })
  }, callImport: () => { throw new Error('预览测试禁止真实导入写入') } }
  const chrome = { getWindowInfo: () => ({ windowWidth: 375 }), showModal() {}, showToast() {}, navigateTo() {}, redirectTo() {}, navigateBack() {}, nextTick: cb => cb(), stopPullDownRefresh() {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: p => { definition = p }, getApp: () => app, wx: chrome,
    getCurrentPages: () => [], console,
    require: name => {
      if (name.includes('/services/catledger-api') || name.includes('/services/catledger-import')) return api
      if (name.includes('/services/login-guard')) return { run: (p, cb) => { if (app.hasLoginApproval()) return cb() } }
      if (name.includes('/theme/service')) return { bindPage() {}, currentTokens: () => ({ accent: '#BE5B24' }) }
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

test('分类拖拽命中行高与最终布局相同，排序请求规则不变', () => {
  const { page } = runtime('pages/categories/index')
  page.startCategoryDrag({ currentTarget: { dataset: { index: 0, id: 'a' } }, touches: [{ clientY: 20 }] })
  assert.equal(page.categoryDrag.rowHeight, 58)
  assert.match(read('miniprogram/pages/categories/index.wxss'), /height:\s*116rpx;\s*min-height:\s*116rpx/)
  assert.match(read('miniprogram/pages/categories/index.js'), /categoryModel.reorder\(this.data.visibleCategories, drag.index, drag.target\)/)
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
  for (const route of ['accounts', 'transaction-editor', 'import-maintenance']) {
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
  assert.deepEqual(calls.map(call => call.name), ['catalog.get'])
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
