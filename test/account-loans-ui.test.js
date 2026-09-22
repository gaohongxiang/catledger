const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')
const flush = () => new Promise(resolve => setImmediate(resolve))
const event = id => ({ currentTarget: { dataset: { id } } })
const account = (id, type = 'other_liability', archived = false) => ({ accountId: id, name: '合成账户' + id, type, archived,
  nature: type === 'wallet' ? 'asset' : 'liability', displayBalanceMinor: '10000', bookBalanceMinor: type === 'wallet' ? '10000' : '-10000', version: 1, currency: 'CNY' })
const loan = (accountId, id = accountId) => ({ loanId: id, accountId, name: '合成贷款' + id, kind: 'borrowing', status: 'active', remainingPrincipalMinor: '10000' })
function setup() {
  const h = runtime()
  h.accounts = [account('debt-a'), account('debt-b'), account('credit', 'credit'), account('asset', 'wallet')]
  h.respond = (action, data) => action === 'loans.list' ? { ok: true, data: { items: [loan(data.accountId || 'debt-a')], nextCursor: null, pendingRepaymentCount: data.accountId === 'debt-a' ? 2 : 0 } } : undefined
  return h
}

test('账户详情只加载当前负债的贷款；切换账户或关闭时拒绝迟到结果', async () => {
  const h = setup(), page = h.page('accounts')
  await page.loadAccounts()
  let release
  h.intercept = (action, data) => action === 'loans.list' && data.accountId === 'debt-a' ? new Promise(resolve => { release = resolve }) : undefined
  const first = page.openAccountDetail(event('debt-a'))
  await flush()
  await page.openAccountDetail(event('debt-b'))
  assert.equal(page.data.accountLoans[0].accountId, 'debt-b')
  release(); await first
  assert.equal(page.data.accountLoans[0].accountId, 'debt-b')
  assert.equal(page.data.accountPendingCount, 0)
  assert.deepEqual(h.calls.filter(c => c.action === 'loans.list').map(c => [c.data.accountId, c.data.pageSize]), [['debt-a', 3], ['debt-b', 3]])
  page.openAccountLoan(event('debt-a'))
  assert.equal(h.navigation.length, 0)
  page.openAccountLoan(event('debt-b'))
  page.createAccountLoan()
  page.openAccountLoans()
  assert.deepEqual(h.navigation, ['/pages/loan-detail/index?loanId=debt-b', '/pages/loan-form/index?accountId=debt-b', '/pages/loans/index?accountId=debt-b'])
  await page.openAccountDetail(event('asset'))
  assert.equal(h.calls.filter(c => c.action === 'loans.list').length, 2)
  page.createAccountLoan()
  assert.equal(h.navigation.length, 3)
  h.cache.invalidate(['loans'])
  const closed = page.openAccountDetail(event('debt-a')); await flush()
  page.closeAccountDetail(); release(); await closed
  assert.equal(page.data.accountDetail, null)
  assert.equal(page.data.accountLoans.length, 0)
})

test('写后返回更新账户贷款；读取失败保留快照，换用户清除原账户和贷款', async () => {
  const h = setup(), page = h.page('accounts')
  await page.loadAccounts(); await page.openAccountDetail(event('debt-a'))
  await h.api.callApi('loans.create', { requestId: 'synthetic-create' })
  h.respond = (action, data) => action === 'loans.list' ? { ok: true, data: { items: [loan(data.accountId), loan(data.accountId, 'new-loan')], nextCursor: null, pendingRepaymentCount: 2 } } : undefined
  await page.loadAccounts()
  assert.equal(page.data.accountLoans.length, 2)
  h.cache.invalidate(['loans'])
  h.intercept = action => { if (action === 'loans.list') throw new Error('合成断网') }
  await page.loadAccountLoans()
  assert.equal(page.data.accountLoans.length, 2)
  assert.ok(page.data.accountLoansError)
  assert.equal(page.data.accountLoansLoading, false)
  h.cache.reset(); h.uid = h.app.globalData.uid = '9876543210'; h.accounts = []; h.intercept = null
  await page.loadAccounts()
  assert.equal(page.data.accountDetail, null)
  assert.equal(page.data.accountLoans.length, 0)
  assert.equal(page.data.accountPendingCount, 0)
})

test('贷款列表全程绑定账户，失效返回首屏，非法账户不降级成全量查询', async () => {
  const h = setup(), page = h.page('loans')
  h.respond = (action, data) => action === 'loans.list' ? { ok: true, data: { items: [loan(data.accountId, data.cursor || 'first')], nextCursor: data.cursor ? null : 'second', pendingRepaymentCount: 2 } } : undefined
  page.onLoad({ accountId: 'debt-a' }); page.onShow(); await page.loadLoans(); await page.nextPage()
  assert.equal(page.data.items[0].loanId, 'second')
  assert.equal(page.data.canPrevious, true)
  await h.api.callApi('loans.create', { requestId: 'synthetic-create' }); page.onShow(); await page.loadLoans()
  assert.equal(page.data.items[0].loanId, 'first')
  assert.equal(page.data.canPrevious, false)
  page.openUnassigned(); page.createLoan()
  assert.deepEqual(h.navigation, ['/pages/loan-link/index?accountId=debt-a', '/pages/loan-form/index?accountId=debt-a'])
  assert.ok(h.calls.filter(c => c.action === 'loans.list').every(c => c.data.accountId === 'debt-a'))
  const invalid = setup(), invalidPage = invalid.page('loans')
  invalidPage.onLoad({ accountId: 'unknown-or-foreign' }); invalidPage.onShow(); await invalidPage.loadLoans()
  assert.equal(invalid.calls.some(c => c.action === 'loans.list'), false)
  assert.ok(invalidPage.data.errorMessage)
  invalidPage.createLoan(); assert.equal(invalid.navigation.length, 0)
})

test('已停用负债仍能查历史，禁止从该账户新增；空贷款信用卡正常显示', async () => {
  const h = setup(), page = h.page('loans')
  h.accounts[0].archived = true
  page.onLoad({ accountId: 'debt-a' }); page.onShow(); await page.loadLoans()
  assert.equal(page.data.items.length, 1)
  page.createLoan(); assert.equal(h.navigation.length, 0)
  const credit = setup(), creditPage = credit.page('accounts')
  credit.respond = action => action === 'loans.list' ? { ok: true, data: { items: [], nextCursor: null, pendingRepaymentCount: 0 } } : undefined
  await creditPage.loadAccounts(); await creditPage.openAccountDetail(event('credit'))
  assert.equal(creditPage.data.accountLoansLoaded, true)
  assert.equal(creditPage.data.accountLoansError, '')
  assert.equal(credit.calls.some(c => c.action === 'loans.create'), false)
})

test('账户待关联还款首个请求即带筛选，不能切到其他账户', async () => {
  const h = setup(), page = h.page('loan-link')
  h.respond = (action, data) => action === 'loans.unassigned' ? { ok: true, data: { accountId: data.accountId, month: data.month, items: [], nextCursor: null } } : undefined
  page.onLoad({ accountId: 'debt-b' }); await page.load()
  assert.equal(h.calls.find(c => c.action === 'loans.unassigned').data.accountId, 'debt-b')
  assert.equal(page.data.accounts.length, 1)
  assert.equal(page.data.accounts[0].accountId, 'debt-b')
  page.changeAccount({ detail: { value: 1 } })
  assert.equal(page.data.accountIndex, 0)
})

test('从账户新建锁定已确认账户；账户停用或目录失败时不允许保存', async () => {
  const h = setup(), page = h.page('loan-form')
  page.onLoad({ accountId: 'debt-b' }); await page.load()
  assert.equal(page.data.accounts[page.data.accountIndex].accountId, 'debt-b')
  page.selectAccount({ detail: { value: 0 } })
  assert.equal(page.data.accounts[page.data.accountIndex].accountId, 'debt-b')
  h.cache.invalidate(['accountDirectory'])
  h.intercept = action => { if (action === 'catalog.get') throw new Error('合成断网') }
  await page.load(); await page.save()
  assert.equal(page.data.sourceReady, false)
  assert.equal(h.calls.some(c => c.action === 'loans.create'), false)
  h.intercept = null; h.accounts[1].archived = true; h.revision = '2'
  await page.load(); await page.save()
  assert.equal(page.data.sourceReady, false)
  assert.ok(page.data.errorMessage)
  assert.equal(h.calls.some(c => c.action === 'loans.create'), false)
})

test('账户流水入口使用本月及当前账户；目录缺失或停用不放宽筛选', async () => {
  for (const mode of ['missing', 'archived', 'failure']) {
    const h = setup(), accounts = h.page('accounts'), page = h.page('transactions')
    await accounts.loadAccounts(); await accounts.openAccountDetail(event('debt-a'))
    accounts.openAccountTransactions()
    page.setData({ month: '2020-01', appliedSearch: '旧查询', sourceFilterIndex: 2 })
    if (mode === 'missing') h.accounts = []
    if (mode === 'archived') h.accounts[0].archived = true
    if (mode === 'failure') h.intercept = action => { if (action === 'catalog.get') throw new Error('合成断网') }
    page.onShow(); await page.prepareAndLoad()
    const queries = h.calls.filter(c => c.action === 'transactions.list')
    assert.ok(queries.length)
    assert.ok(queries.every(c => c.data.accountId === 'debt-a' && c.data.month === h.load('utils/time').currentMonth() && !c.data.source && !c.data.search))
    assert.equal(page.data.accountFilters[page.data.accountFilterIndex].accountId, 'debt-a')
    assert.equal(h.app.globalData.transactionsAccountFilter, null)
  }
})

test('账户流水入口拒绝旧全量响应；换用户不恢复原账户名称或导航意图', async () => {
  const h = setup(), page = h.page('transactions')
  let release
  h.intercept = (action, data) => action === 'transactions.list' && !data.accountId ? new Promise(resolve => { release = resolve }) : undefined
  const old = page.prepareAndLoad(); await flush()
  h.app.globalData.transactionsAccountFilter = { accountId: 'debt-b', name: '合成旧会话专属账户', session: h.cache.getSession() }
  page.onShow(); await page.prepareAndLoad()
  assert.equal(page.data.transactions[0].transactionId, 'debt-b')
  release(); await old
  assert.equal(page.data.transactions[0].transactionId, 'debt-b')
  h.app.globalData.transactionsAccountFilter = { accountId: 'debt-b', name: '合成旧会话专属账户', session: h.cache.getSession() }
  h.cache.reset(); h.uid = h.app.globalData.uid = '9876543210'; h.accounts = []; h.intercept = null
  page.onShow(); await page.prepareAndLoad()
  assert.equal(page.data.accountFilterIndex, 0)
  assert.equal(page.data.accountFilters.length, 1)
  assert.equal(JSON.stringify(page.data).includes('合成旧会话专属账户'), false)
  assert.equal(h.app.globalData.transactionsAccountFilter, null)
})
