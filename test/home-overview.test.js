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
    assetsMinor: '1737920', liabilitiesMinor: '2062255',
    month: '2026-10',
    accounts: [
      { nature: 'asset', bookBalanceMinor: '1737920' },
      { nature: 'liability', bookBalanceMinor: '-2062255', debtMinor: '2062255' }
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

test('首页提醒只报真有的事：待核对与待分类取本机草稿进度，本月待还扣掉已还部分', async () => {
  const h = runtime(), page = h.page('index')
  h.load('services/import-draft-session').rememberProgress('update-1', { pending: 12, categories: 39 })
  h.respond = (action, data) => {
    if (action === 'dashboard.get') return result('all')
    if (action === 'loans.dueThisMonth') return { ok: true, data: { month: data.month, periodCount: 2, dueMinor: '120000' } }
    return undefined
  }
  await page.loadDashboard()
  await page.loadAlerts()
  assert.equal(page.data.alertImportText, '待核对 12 笔 · 待分类 39 笔')
  assert.equal(page.data.alertDueText, '本月待还 ¥1,200.00 · 2 期')
  // 数字单独成段，首页只给它上色；整句染色在浅色主题读不清。
  const figures = parts => parts.filter(part => part.figure).map(part => part.text).join(',')
  assert.equal(figures(page.data.alertImportParts), '12,39')
  assert.equal(figures(page.data.alertDueParts), '¥1,200.00')
  assert.equal(page.data.alertImportParts.map(part => part.text).join(''), page.data.alertImportText)
  assert.equal(page.data.alertDueParts.map(part => part.text).join(''), page.data.alertDueText)
  const due = h.calls.find(call => call.action === 'loans.dueThisMonth')
  assert.match(due.data.month, /^\d{4}-\d{2}$/u, '按月查询，月份由客户端给出')
  assert.equal(due.name, 'catledger-api')
  // 核对决定入账前只在本地，服务端整批事件仍在等动作，不能拿它当首页数字。
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.pendingCount'), false)
})

test('没有草稿进度与待还时两条提醒都不占位；单期不写期数', async () => {
  const h = runtime(), page = h.page('index')
  h.respond = action => action === 'dashboard.get' ? result('all') : undefined
  await page.loadDashboard()
  await page.loadAlerts()
  assert.equal(page.data.alertImportText, '')
  assert.equal(page.data.alertDueText, '')
  assert.equal(page.data.alertImportParts.length, 0)
  assert.equal(page.data.alertDueParts.length, 0)

  h.load('services/import-draft-session').rememberProgress('update-1', { pending: 0, categories: 4 })
  h.respond = (action, data) => {
    if (action === 'loans.dueThisMonth') return { ok: true, data: { month: data.month, periodCount: 1, dueMinor: '99900' } }
    return undefined
  }
  // 本月待还按 loans 标签缓存，记还款等写入会让它失效。
  h.cache.invalidate(['loans'])
  await page.loadAlerts()
  assert.equal(page.data.alertImportText, '待分类 4 笔')
  assert.equal(page.data.alertDueText, '本月待还 ¥999.00')
})

test('草稿提示和待还互不牵连：一条没有或读不到不影响另一条', async () => {
  const h = runtime(), page = h.page('index')
  h.load('services/import-draft-session').rememberProgress('update-1', { pending: 2, categories: 0 })
  h.respond = action => action === 'loans.dueThisMonth'
    ? { ok: false, error: { code: 'INTERNAL_ERROR', message: '读取失败' } } : undefined
  await page.loadDashboard()
  await Promise.allSettled([page.loadAlerts()])
  assert.equal(page.data.alertImportText, '待核对 2 笔')
  assert.equal(page.data.alertDueText, '')
})

test('提醒各自进自己的工作台：待核对去导入工作台，待还去本月待还明细页', async () => {
  const h = runtime(), page = h.page('index')
  page.openImport()
  page.openLoans()
  assert.equal(h.navigation[0], '/packages/finance/pages/import-workbench/index')
  assert.equal(h.navigation[1], '/packages/loans/pages/due-this-month/index')
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

test('负债账户有账单却无分期计划时，首页账户余额标题后提示补建', async () => {
  const h = runtime(), page = h.page('index')
  h.respond = action => action === 'dashboard.get' ? { ok: true, data: { summaryScope: 'all', netWorthMinor: '0', month: '2026-10',
    accounts: [
      { nature: 'liability', bookBalanceMinor: '-813739', debtMinor: '813739', needsInstallmentPlan: true },
      { nature: 'liability', bookBalanceMinor: '-100', debtMinor: '100', needsInstallmentPlan: true },
      { nature: 'liability', bookBalanceMinor: '0', debtMinor: '0', needsInstallmentPlan: true },
      { nature: 'asset', bookBalanceMinor: '50000' }
    ],
    summary: { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' }, cashFlowTrend: [], recentTransactions: [] } } : undefined
  await page.loadDashboard()
  // 只统计有欠款且需补建的活动负债账户：第一、二个（第三个欠款为 0 不计）
  assert.equal(page.data.installmentPlanPromptText, '2 个账户需要新建分期计划')
})

test('无需补建分期计划时不出现首页提示', async () => {
  const h = runtime(), page = h.page('index')
  h.respond = action => action === 'dashboard.get' ? { ok: true, data: { summaryScope: 'all', netWorthMinor: '0', month: '2026-10',
    accounts: [{ nature: 'liability', bookBalanceMinor: '-100', debtMinor: '100', needsInstallmentPlan: false }],
    summary: { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' }, cashFlowTrend: [], recentTransactions: [] } } : undefined
  await page.loadDashboard()
  assert.equal(page.data.installmentPlanPromptText, '')
})

test('净资产 = 资产(账面余额) − 负债(账单应还+未还分期本息)，与卡片资产/负债同口径', () => {
  const { netWorthOf } = require('../cloudfunctions/catledger-api/src/reporting-service')
  // 复现实例：资产 57,129.94、负债 21,364.59（含未入账分期欠款），净资产应为 35,765.35，不是 ΣbookBalance 的虚高值。
  const accounts = [
    { nature: 'asset', bookBalanceMinor: '5712994' },
    // 负债账户账面净额只含已入账交易（可能为 -1,506,045 之类），但真实欠款（debtMinor）是 2,136,459。
    { nature: 'liability', bookBalanceMinor: '-1506045', debtMinor: '2136459' }
  ]
  assert.equal(netWorthOf(accounts).toString(), '3576535')
  // 无分期、无账单的普通负债：debtMinor 缺省按 0，净资产仍按资产账面。
  assert.equal(netWorthOf([{ nature: 'asset', bookBalanceMinor: '100' }]).toString(), '100')
})

test('首页账户余额同时展示资产与负债：各取前两条，负债显示待还/已还清', async () => {
  const h = runtime(), page = h.page('index')
  h.respond = (action, data) => action === 'dashboard.get' ? { ok: true, data: {
    summaryScope: data.summaryScope, month: '2026-10', netWorthMinor: '0', assetsMinor: '0', liabilitiesMinor: '0',
    accounts: [
      { accountId: 'a1', name: '资产甲', type: 'bank', nature: 'asset', displayBalanceMinor: '100', bookBalanceMinor: '100', archived: false },
      { accountId: 'a2', name: '资产乙', type: 'wallet', nature: 'asset', displayBalanceMinor: '200', bookBalanceMinor: '200', archived: false },
      { accountId: 'a3', name: '资产丙', type: 'bank', nature: 'asset', displayBalanceMinor: '300', bookBalanceMinor: '300', archived: false },
      { accountId: 'l1', name: '负债甲', type: 'credit', nature: 'liability', debtMinor: '500', bookBalanceMinor: '-500', archived: false },
      { accountId: 'l2', name: '负债乙', type: 'credit', nature: 'liability', debtMinor: '0', bookBalanceMinor: '0', archived: false },
      { accountId: 'l3', name: '负债丙', type: 'credit', nature: 'liability', debtMinor: '900', bookBalanceMinor: '-900', archived: false }
    ],
    summary: { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' },
    cashFlowTrend: [{ month: '2026-10', incomeMinor: '0', expenseMinor: '0' }], recentTransactions: [] } } : undefined
  await page.loadDashboard()
  const ids = page.data.accounts.map(a => a.accountId)
  // 资产取前 2（a1,a2，不取 a3），负债取前 2（l1,l2，不取 l3）
  assert.deepEqual(ids, ['a1', 'a2', 'l1', 'l2'])
  assert.equal(page.data.accounts[2].directionText, '待还')
  assert.equal(page.data.accounts[2].balanceText, '¥5.00')
  assert.equal(page.data.accounts[3].directionText, '已还清')
  assert.equal(page.data.accounts[0].directionText, '余额')
})

test('净值卡负债侧显示「其中利息」：取 dashboard.liabilitiesInterestMinor，0 或缺失时不显示', async () => {
  const { runtime } = require('./helpers/read-runtime')
  const h = runtime(), page = h.page('index'); page.onLoad()
  // 直接给 dashboard 一个带利息合计的响应（其余字段复用默认）。
  const base = { ok: true, data: { month: page.data.month, summaryScope: 'all', netWorthMinor: '-9046375',
    assetsMinor: '5144024', liabilitiesMinor: '14190399', liabilitiesInterestMinor: '669170',
    summary: { incomeMinor: '0', expenseMinor: '0' }, cashFlowTrend: [], recentTransactions: [], accounts: [] } }
  h.respond = action => action === 'loans.dueCharges' ? { ok: true, data: { count: 0, cutoff: '2026-10-01' } }
    : action === 'dashboard.get' ? base : undefined
  await page.loadDashboard({ force: true })
  assert.equal(page.data.liabilitiesInterestText, '¥6,691.70')
  // 0 利息时不显示
  h.respond = action => action === 'loans.dueCharges' ? { ok: true, data: { count: 0, cutoff: '2026-10-01' } }
    : action === 'dashboard.get' ? { ok: true, data: { ...base.data, liabilitiesInterestMinor: '0' } } : undefined
  await page.loadDashboard({ force: true })
  assert.equal(page.data.liabilitiesInterestText, '')
})
