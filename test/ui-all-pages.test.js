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
  const api = { createRequestId: () => 'synthetic-request', bootstrap: () => Promise.resolve({ categories: [] }), callApi: (name, data) => {
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
  return { page, app, calls }
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

test('全部11个现有路由都有交付记录，不改路由、不创建虚构功能页', () => {
  assert.equal(routes.length, 11)
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
    assert.match(read('miniprogram/pages/' + name + '/index.wxml'), /loggedIn && hasLoaded \? accountCount : '—'/)
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
  assert.equal(page.data.cashFlowTrend[0].incomeBarHeight, 0)
  assert.equal(page.data.cashFlowTrend[0].expenseBarHeight, 120)
  assert.equal(page.data.expenseCategories[0].barWidth, '0%')
  page.selectTrend({ currentTarget: { dataset: { index: 0 } } })
  page.selectDay({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(page.data.selectedTrend.expenseText, '¥200.00')
  assert.equal(page.data.selectedDay.incomeText, '¥0.00')
  assert.equal(calls.length, 1)
})
test('统计读取中不能改月份，下一月读取失败不在新标题下显示上月图表', async () => {
  const { page } = runtime('pages/statistics/index', () => Promise.reject(new Error('合成错误')))
  page.data.month = '2026-08'; page.data.loading = true
  page.nextMonth(); assert.equal(page.data.month, '2026-08')
  page.data.loading = false; page.data.hasLoaded = true
  page.nextMonth(); assert.equal(page.data.hasLoaded, false)
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

test('整合PR8：只保留record-summary展开权威及最新账户同行选择，不回退纵向表单', () => {
  const code = read('miniprogram/pages/import-workbench/index.js')
  const markup = read('miniprogram/pages/import-workbench/index.wxml')
  assert.doesNotMatch(code, /toggleRecordSummary:|recordSummaryExpanded:/)
  assert.match(markup, /<record-summary/)
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

test('记账编辑读取失败有重试，不显示可编辑空表单；准备成功才呈现原功能', async () => {
  let fail = true
  const { page } = runtime('pages/transaction-editor/index', name => fail ? Promise.reject(new Error('合成失败')) : Promise.resolve(name === 'accounts.list' ? { accounts: [{ accountId: 'a', name: '测试账户' }] } : { transactions: [] }))
  await page.prepareForm()
  assert.equal(page.data.preparing, false); assert.equal(page.data.formReady, false); assert.ok(page.data.errorMessage)
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


test('编辑已停用账户的账目，不把被拒绝的表单标为准备完成', async () => {
  const { page, app } = runtime('pages/transaction-editor/index', name => Promise.resolve(name === 'accounts.list' ? { accounts: [{ accountId: 'active', name: '可用测试账户' }] } : { transactions: [] }))
  page.data.mode = 'edit'
  app.globalData.editingTransaction = { type: 'expense', transactionId: 'old', sourceAccount: { accountId: 'archived' } }
  await page.prepareForm()
  assert.equal(page.data.preparing, false)
  assert.equal(page.data.formReady, false)
  assert.match(page.data.errorMessage, /停用/)
})
