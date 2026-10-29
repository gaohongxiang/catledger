const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { themeRuntime } = require('./helpers/theme-runtime')

const root = path.join(__dirname, '..', 'miniprogram')

function pageRuntime() {
  const runtime = themeRuntime({ themeId: 'warm-ledger' })
  const modules = new Map()
  runtime.session = 0
  runtime.approved = true
  runtime.toasts = []
  runtime.requests = []
  runtime.app.hasLoginApproval = () => runtime.approved
  const wx = { showToast: options => runtime.toasts.push(options.title), stopPullDownRefresh() {} }
  // 页面、统计模型和读会话执行真实源码；仅网络和身份边界由测试控制。
  const overrides = {
    'theme/service.js': runtime.service,
    'theme/registry.js': runtime.registry,
    'services/read-cache.js': { getSession: () => runtime.session },
    'services/catledger-api.js': {
      isFresh: () => true,
      createRequestId: () => 'synthetic-category-save',
      async callApi(action, data) {
        runtime.requests.push(action)
        if (runtime.respond && action !== 'statistics.get') return runtime.respond(action, data)
        assert.equal(action, 'statistics.get')
        return runtime.statistics
      }
    },
    'services/loan-charge-sync.js': { beforePage: () => Promise.resolve() }
  }
  function load(filename) {
    const relative = path.relative(root, filename)
    if (Object.hasOwn(overrides, relative)) return overrides[relative]
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }
    modules.set(filename, module)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, wx,
      getApp: () => runtime.app,
      getCurrentPages: () => runtime.currentPages,
      Page: definition => { module.exports = definition },
      Component: definition => { module.exports = definition },
      require: name => load(path.resolve(path.dirname(filename), name + (path.extname(name) ? '' : '.js'))),
      console
    }, { filename })
    return module.exports
  }
  runtime.loadPage = route => runtime.page(load(path.join(root, route + '.js')))
  runtime.loadPanel = (route, host = { getTabBar: () => null }) => {
    const component = runtime.component(load(path.join(root, route + '.js')))
    component.triggerEvent = () => {}
    runtime.componentHook(component, 'attached')
    component.connectHost(host)
    return component
  }
  return runtime
}

function statisticsResult(month) {
  return {
    month,
    summary: { incomeMinor: '20000', expenseMinor: '5000', netIncomeMinor: '15000' },
    cashFlowTrend: [{ month, incomeMinor: '20000', expenseMinor: '5000' }],
    daily: [{ date: month + '-01', incomeMinor: '20000', expenseMinor: '5000' }],
    expenseCategories: [{ name: '合成支出分类', amountMinor: '5000' }],
    incomeCategories: [{ name: '合成收入分类', amountMinor: '20000' }]
  }
}

async function loadedStatistics(runtime, host) {
  const page = runtime.loadPanel('pages/statistics/panel', host)
  runtime.statistics = statisticsResult(page.data.month)
  page.activate()
  await page.loadStatistics()
  assert.equal(page.data.hasLoaded, true)
  assert.ok(page.data.charts.monthlyChart.src)
  return page
}

test('真实统计页隐藏后跟随主题重绘 SVG 与图例，保留金额且不请求业务数据', async function () {
  const runtime = pageRuntime()
  const page = await loadedStatistics(runtime)
  const previousChart = page.data.charts.monthlyChart.src
  const previousIncome = page.data.incomeText
  const previousExpense = page.data.expenseText
  const requestCount = runtime.requests.length
  page.deactivate()
  assert.equal(page._readClosed, true)
  runtime.currentPages = []
  runtime.nativeCalls.length = 0

  runtime.service.selectTheme('ticket-proof')

  const tokens = runtime.service.currentTokens()
  const svg = decodeURIComponent(page.data.charts.monthlyChart.src)
  assert.equal(page.data.themeId, 'ticket-proof')
  assert.notEqual(page.data.charts.monthlyChart.src, previousChart)
  for (const color of [tokens.line, tokens.textMuted, tokens.income, tokens.expense]) {
    assert.ok(svg.includes('"' + color + '"'), 'SVG 未使用有效主题色 ' + color)
  }
  assert.equal(page.data.expenseCategories[0].color, tokens.expense)
  assert.equal(page.data.incomeCategories[0].color, tokens.income)
  assert.equal(page.data.incomeText, previousIncome)
  assert.equal(page.data.expenseText, previousExpense)
  assert.equal(runtime.requests.length, requestCount)
  assert.equal(runtime.nativeCalls.length, 0, '隐藏统计页不得改写当前系统栏')
  const chartPatchCount = page.patches.filter(patch => Object.hasOwn(patch, 'charts')).length
  runtime.service.selectTheme('ticket-proof')
  assert.equal(page.patches.filter(patch => Object.hasOwn(patch, 'charts')).length, chartPatchCount)
})

test('换用户会话后切主题不会重绘上一用户的缓存，返回页时清理旧图表', async function () {
  const runtime = pageRuntime()
  const page = await loadedStatistics(runtime)
  page.deactivate()
  const oldChart = page.data.charts.monthlyChart.src
  const chartPatchCount = page.patches.filter(patch => Object.hasOwn(patch, 'charts')).length
  runtime.session += 1
  runtime.approved = false

  runtime.service.selectTheme('ticket-proof')

  assert.equal(page.data.themeId, 'ticket-proof')
  assert.equal(page.data.charts.monthlyChart.src, oldChart)
  assert.equal(page.patches.filter(patch => Object.hasOwn(patch, 'charts')).length, chartPatchCount)
  page.activate()
  assert.equal(page.data.charts, null)
  assert.equal(page.data.hasLoaded, false)
  assert.equal(page._statisticsResult, null)
  assert.equal(page.data.themeId, 'ticket-proof', '业务会话重置不能回滚当前主题')
})

test('真实主题页保存失败提示重试并保持原选择，恢复存储后可再次切换', function () {
  const runtime = pageRuntime()
  const page = runtime.loadPage('pages/theme/index')
  page.onLoad({})
  runtime.writeError = true
  const event = { currentTarget: { dataset: { id: 'ticket-proof' } } }

  assert.doesNotThrow(() => page.chooseTheme(event))

  assert.equal(page.data.themeId, 'warm-ledger')
  assert.equal(page.data.themes.find(theme => theme.selected).id, 'warm-ledger')
  assert.equal(runtime.storage.get(runtime.service.THEME_STORAGE_KEY), 'warm-ledger')
  assert.equal(runtime.toasts.length, 1)
  assert.match(runtime.toasts[0], /保存|重试/)
  assert.doesNotMatch(runtime.toasts[0], /已切换/)
  runtime.writeError = false
  page.chooseTheme(event)
  assert.equal(page.data.themeId, 'ticket-proof')
  assert.equal(page.data.themes.find(theme => theme.selected).id, 'ticket-proof')
  assert.equal(runtime.storage.get(runtime.service.THEME_STORAGE_KEY), 'ticket-proof')
  assert.match(runtime.toasts.at(-1), /已切换/)
})

test('统计补全入口等待结束时页面已隐藏，不重新激活原生外壳或重开业务会话', async function () {
  const runtime = pageRuntime()
  const statistics = await loadedStatistics(runtime)
  let finishPreviousLoad
  statistics._statisticsLoad = new Promise(resolve => { finishPreviousLoad = resolve })
  runtime.app.globalData.openStatisticsCompletion = true
  const waiting = statistics.onShow()
  statistics.deactivate()
  const active = runtime.page(runtime.service.page({ data: {} }))
  active.onLoad({})
  runtime.currentPages = [active]
  runtime.service.selectTheme('ticket-proof')
  runtime.nativeCalls.length = 0
  const requestCount = runtime.requests.length

  finishPreviousLoad()
  await waiting

  assert.equal(runtime.nativeCalls.length, 0, '隐藏统计页的迟到回调不得接管当前原生外壳')
  assert.equal(statistics._readClosed, true, '迟到回调不得重开隐藏页业务会话')
  assert.equal(runtime.requests.length, requestCount)
  assert.equal(runtime.app.globalData.openStatisticsCompletion, true, '入口意图留到下一次真实显示再消费')
})

test('统计页已卸载时等待中的补全回调不重新订阅页面或接管原生外壳', async function () {
  const runtime = pageRuntime()
  const statistics = await loadedStatistics(runtime)
  let finishPreviousLoad
  statistics._statisticsLoad = new Promise(resolve => { finishPreviousLoad = resolve })
  runtime.app.globalData.openStatisticsCompletion = true
  const waiting = statistics.onShow()
  runtime.componentHook(statistics, 'detached')
  const active = runtime.page(runtime.service.page({ data: {} }))
  active.onLoad({})
  runtime.currentPages = [active]
  runtime.service.selectTheme('ticket-proof')
  runtime.nativeCalls.length = 0
  const patchCount = statistics.patches.length
  // 业务请求已结束；其完成通知晚于页面卸载。
  statistics._statisticsLoad = null
  finishPreviousLoad()
  await waiting

  assert.equal(runtime.nativeCalls.length, 0)
  assert.equal(statistics._readClosed, true)
  assert.equal(statistics.patches.length, patchCount)
  runtime.service.selectTheme('emerald-list')
  assert.equal(statistics.patches.length, patchCount, '已卸载实例不得被迟到 onShow 重新订阅')
})

test('统计分类保存迟到时不改动已离开的界面或新会话，隐藏实例结束忙碌状态后可以返回', async function (t) {
  for (const state of ['hidden', 'disposed', 'new-session', 'shown-again']) {
    for (const outcome of ['success', 'failure']) await t.test(state + '/' + outcome, async function () {
      const runtime = pageRuntime(), tabUpdates = []
      const bar = { setData: patch => tabUpdates.push({ ...patch }), requestLogin: options => options.afterLogin() }
      const statistics = await loadedStatistics(runtime, { getTabBar: () => bar })
      let resolveSave, rejectSave
      const response = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject })
      runtime.respond = (action, data) => {
        assert.equal(action, 'categories.assignTransactions')
        assert.equal(data.categoryId, 'synthetic-category')
        return response
      }
      statistics.setData({
        categorySheetOpen: true, selectedCategoryId: 'synthetic-category',
        selectedCategoryGroup: { groupKey: 'synthetic-group', members: [{ transactionId: 'synthetic-transaction', version: 1 }] }
      })
      const saving = statistics.saveCategoryCompletion()
      assert.equal(statistics.data.categorySaving, true)
      if (state === 'disposed') runtime.componentHook(statistics, 'detached')
      else if (state === 'new-session') {
        runtime.session += 1
        statistics.beginReadSession()
        statistics.setData({ categorySaving: true, categorySheetOpen: true, selectedCategoryId: 'new-session-category', errorMessage: '新会话自己的错误' })
      } else {
        statistics.deactivate()
        if (state === 'shown-again') {
          await statistics.activate()
          statistics.setData({ categorySheetOpen: true, selectedCategoryId: 'new-selection', errorMessage: '返回后自己的错误' })
        }
      }
      const before = JSON.parse(JSON.stringify(statistics.data))
      const requestCount = runtime.requests.length, patchCount = statistics.patches.length
      tabUpdates.length = 0
      runtime.toasts.length = 0
      runtime.nativeCalls.length = 0

      if (outcome === 'success') resolveSave({ updatedCount: 1 })
      else rejectSave(new Error('旧会话保存失败'))
      await saving
      // 也等待宿主边界已排队的 microtasks，不能因方法未返回 Promise 而漏掉迟到回调。
      await new Promise(resolve => setImmediate(resolve))

      assert.equal(runtime.requests.length, requestCount, '迟到保存不得触发新的统计读取')
      assert.deepEqual(tabUpdates, [], '迟到保存不得改动其他入口正在使用的底栏')
      assert.deepEqual(runtime.toasts, [], '离开后的保存结果不得弹出提示')
      assert.equal(runtime.nativeCalls.length, 0)
      if (state === 'hidden' || state === 'shown-again') {
        assert.deepEqual(statistics.data, { ...before, categorySaving: false }, '同会话只结束旧保存忙碌状态，不覆盖当前选择或错误')
      } else {
        assert.deepEqual(statistics.data, before, '旧保存不能回填已销毁实例或新会话')
        assert.equal(statistics.patches.length, patchCount)
      }
      if (state === 'hidden' || state === 'disposed') assert.equal(statistics._readClosed, true, '迟到保存不能重新开启读取会话')
    })
  }
})
