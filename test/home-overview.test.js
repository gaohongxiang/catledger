const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')
const tick = () => new Promise(resolve => setImmediate(resolve))
const result = summaryScope => ({ ok: true, data: { summaryScope, accounts: [], netWorthMinor: '45000',
  summary: summaryScope === 'all' ? { incomeMinor: '123400', expenseMinor: '129000', netIncomeMinor: '-5600' }
    : { incomeMinor: '100', expenseMinor: '20', netIncomeMinor: '80' },
  cashFlowTrend: [{ month: '2026-10', incomeMinor: '100', expenseMinor: '20' }], recentTransactions: [] } })

test('首页累计收支独立于本月趋势；收支差为负时净资产仍取账户余额', async () => {
  const h = runtime(), page = h.page('index')
  h.respond = (action, data) => action === 'dashboard.get' ? result(data.summaryScope) : undefined
  await page.loadDashboard()
  assert.equal(h.calls.find(call => call.action === 'dashboard.get').data.summaryScope, 'all')
  assert.equal(page.data.incomeText, '¥1,234.00')
  assert.equal(page.data.expenseText, '¥1,290.00')
  assert.equal(page.data.netWorthText, '¥450.00')
  assert.equal(page.data.cashFlowTrend[0].incomeMinor, '100')
})

test('已有本月快照不能作为累计展示，累计读取返回前保留未读取状态', async () => {
  const h = runtime(), page = h.page('index'); page.onLoad()
  h.respond = (action, data) => action === 'dashboard.get' ? result(data.summaryScope || 'month') : undefined
  await h.api.callApi('dashboard.get', { month: page.data.month })
  let release
  h.intercept = (action, data) => action === 'dashboard.get' && data.summaryScope === 'all'
    ? new Promise(resolve => { release = resolve }) : undefined
  const loading = page.loadDashboard(); await tick()
  assert.equal(page.data.hasDashboard, false)
  assert.equal(page.data.incomeText, '—')
  release(); await loading
  assert.equal(page.data.incomeText, '¥1,234.00')
  assert.equal(page.data.dashboardFresh, true)
})

test('净值卡按账户性质拆成资产与负债两侧，本月收支不再进首页数据', async () => {
  const h = runtime(), page = h.page('index')
  h.respond = action => action === 'dashboard.get' ? { ok: true, data: { summaryScope: 'all', netWorthMinor: '-324335',
    month: '2026-10',
    accounts: [
      { nature: 'asset', bookBalanceMinor: '1737920' },
      { nature: 'liability', bookBalanceMinor: '-2062255' }
    ],
    summary: { incomeMinor: '123400', expenseMinor: '129000', netIncomeMinor: '-5600' },
    cashFlowTrend: [{ month: '2026-10', incomeMinor: '0', expenseMinor: '42881' }], recentTransactions: [] } } : undefined
  await page.loadDashboard()
  assert.equal(page.data.netWorthText, '-¥3,243.35')
  assert.equal(page.data.assetsText, '¥17,379.20')
  assert.equal(page.data.liabilitiesText, '¥20,622.55')
  // 构成条只认账户性质与余额，负债取绝对值，占比各自归一。
  assert.equal(page.data.assetShares.items.length, 1)
  assert.equal(page.data.assetShares.items[0].percentText, '100%')
  assert.equal(page.data.assetShares.items[0].tone, 'mix-tone-1')
  assert.equal(page.data.liabilityShares.items.length, 1)
  assert.equal(page.data.liabilityShares.items[0].percentText, '100%')
  assert.equal(page.data.asOfText, '')
  assert.equal(page.data.incomeText, '¥1,234.00')
  assert.equal('monthExpenseText' in page.data, false)
  assert.equal('monthNetText' in page.data, false)
})

test('「最后一笔」取账面最后一笔交易的发生日，不用当月月份糊弄', async () => {
  const h = runtime(), page = h.page('index')
  h.respond = action => action === 'dashboard.get' ? { ok: true, data: { summaryScope: 'all', netWorthMinor: '45000', month: '2026-10',
    accounts: [{ nature: 'asset', bookBalanceMinor: '45000' }], summary: { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' },
    cashFlowTrend: [], recentTransactions: [{ transactionId: 't-1', type: 'expense', amountMinor: '100', occurredLocalAt: '2026-09-30T21:15:00+08:00' }] } } : undefined
  await page.loadDashboard()
  assert.equal(page.data.asOfText, '9月30日')
})

test('旧服务端漏回累计范围时拒绝展示和缓存，重试可取得正确累计', async () => {
  const h = runtime(), page = h.page('index'); page.onLoad()
  h.respond = action => action === 'dashboard.get' ? result('month') : undefined
  await page.loadDashboard()
  assert.equal(page.data.hasDashboard, false)
  assert.equal(page.data.incomeText, '—')
  assert.ok(page.data.errorMessage)
  assert.equal(h.api.isFresh('dashboard.get', { month: page.data.month, summaryScope: 'all' }), false)
  h.respond = action => action === 'dashboard.get' ? result('all') : undefined
  await page.loadDashboard()
  assert.equal(page.data.incomeText, '¥1,234.00')
  assert.equal(page.data.errorMessage, '')
})
