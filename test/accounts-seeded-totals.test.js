const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

// 回归：从首页进账户总览页时，accounts.list 会命中 dashboard.get seed 下来的缓存。
// 该缓存曾漏掉 totals，导致账户页合计全部显示 ¥0.00（并缺少「其中利息」）。这里锁死 seed 必须带上合计。
const dashTotals = { assetsMinor: '5144024', liabilitiesMinor: '14190399', netWorthMinor: '-9046375', liabilitiesInterestMinor: '7669969' }
const dashAccounts = [
  { accountId: 'a1', name: '储蓄卡', type: 'bank', nature: 'asset', archived: false, bookBalanceMinor: '5144024', displayBalanceMinor: '5144024' },
  { accountId: 'l1', name: '信用卡', type: 'credit', nature: 'liability', archived: false, bookBalanceMinor: '-14190399', debtMinor: '14190399', installmentTotalInterestMinor: '7669969' }
]

test('dashboard seed 后账户页合计不归零，且带出「其中利息」', async () => {
  const h = runtime()
  h.respond = action => action === 'dashboard.get'
    ? { ok: true, data: { accounts: dashAccounts, totals: dashTotals, summary: { incomeMinor: '0', expenseMinor: '0' }, summaryScope: 'all', cashFlowTrend: [], recentTransactions: [] } }
    : undefined
  const home = h.page('index'); home.onLoad()
  await home.loadDashboard({ force: true })
  h.respond = undefined // accounts.list 不单独给数据，只能靠 seed 缓存
  const accounts = h.page('accounts')
  await accounts.loadAccounts()
  assert.equal(accounts.data.totals.assetsText, '¥51,440.24')
  assert.equal(accounts.data.totals.liabilitiesText, '¥141,903.99')
  assert.equal(accounts.data.totals.netWorthText, '-¥90,463.75')
  assert.equal(accounts.data.totals.liabilitiesInterestText, '¥76,699.69')
})

test('账户页自身 accounts.list 携带 totals 时同样正确渲染，且与首页同口径', async () => {
  const h = runtime()
  h.respond = action => action === 'accounts.list'
    ? { ok: true, data: { accounts: dashAccounts, liabilitySettingsVersion: 1, totals: dashTotals } }
    : undefined
  const accounts = h.page('accounts')
  await accounts.loadAccounts({ force: true })
  assert.equal(accounts.data.totals.netWorthText, '-¥90,463.75')
  assert.equal(accounts.data.totals.liabilitiesInterestText, '¥76,699.69')
})

test('总利息是独立一格：为 0 时显示 ¥0.00（不作为待还负债的子行省略）', async () => {
  const h = runtime()
  h.respond = action => action === 'accounts.list'
    ? { ok: true, data: { accounts: [{ accountId: 'a1', name: '储蓄卡', type: 'bank', nature: 'asset', archived: false, bookBalanceMinor: '100', displayBalanceMinor: '100' }], liabilitySettingsVersion: 1, totals: { assetsMinor: '100', liabilitiesMinor: '0', netWorthMinor: '100', liabilitiesInterestMinor: '0' } } }
    : undefined
  const accounts = h.page('accounts')
  await accounts.loadAccounts({ force: true })
  assert.equal(accounts.data.totals.liabilitiesText, '¥0.00')
  assert.equal(accounts.data.totals.liabilitiesInterestText, '¥0.00')
})
